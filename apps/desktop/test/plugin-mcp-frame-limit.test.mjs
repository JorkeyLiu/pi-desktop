import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

import { McpServerClient } from "../electron/main/plugin-mcp.ts";

const MIB = 1024 * 1024;
/** The stdio transport's per-frame budget: 4MiB of UTF-8 bytes. */
const FRAME_BUDGET_BYTES = 4 * MIB;

/**
 * A fake stdio child process. The client runs its real framing, JSON parsing,
 * close handling and process signalling; only the bytes on the wire are
 * scripted here.
 *
 * A stream the client switches to `utf8` decodes through a `StringDecoder`,
 * exactly like Node's own encoding support, so a code point split across two
 * reads stays whole instead of turning into replacement characters. That keeps
 * a run against a character-counting build faithful rather than artificially
 * broken.
 */
function fakeStdioServer(script) {
  const writes = [];
  const kills = [];
  const child = new EventEmitter();

  const makeStream = () => {
    const stream = new EventEmitter();
    let decoder;
    stream.destroyed = false;
    stream.setEncoding = (encoding) => {
      decoder = encoding === "utf8" ? new StringDecoder("utf8") : undefined;
    };
    stream.destroy = () => {
      stream.destroyed = true;
    };
    stream.pushBytes = (bytes) => {
      if (stream.destroyed) return;
      const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
      if (!decoder) {
        stream.emit("data", buffer);
        return;
      }
      const text = decoder.write(buffer);
      if (text) stream.emit("data", text);
    };
    return stream;
  };

  child.stdout = makeStream();
  child.stderr = makeStream();
  const api = {
    child,
    writes,
    kills,
    emit: (bytes) => child.stdout.pushBytes(bytes),
    frameBytes: (message) => Buffer.from(`${JSON.stringify(message)}\n`, "utf8"),
    emitJson: (message) => child.stdout.pushBytes(`${JSON.stringify(message)}\n`),
  };

  child.stdin = {
    writable: true,
    write: (chunk) => {
      const text = String(chunk);
      writes.push(text);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        script(JSON.parse(line), api);
      }
      return true;
    },
    destroy: () => {
      child.stdin.writable = false;
    },
  };
  child.pid = undefined;
  child.kill = (signal) => {
    kills.push(signal ?? "SIGTERM");
    return true;
  };

  return api;
}

/** The slice of MCP the desktop handshakes with, answered from the script. */
function answerHandshake(message, api) {
  if (message.method === "initialize") {
    api.emit(
      api.frameBytes({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "frame-limit stub", version: "1" },
        },
      }),
    );
    return true;
  }
  if (message.method === "notifications/initialized") return true;
  if (message.method === "tools/list") {
    api.emitJson({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo" }] } });
    return true;
  }
  return false;
}

function createClient(t, script) {
  const server = fakeStdioServer((message, api) => {
    // A script may claim a message (by returning true) to replace the regular
    // handshake reply, which is how an oversized `initialize` response is staged.
    if (script(message, api) === true) return;
    answerHandshake(message, api);
  });
  const client = new McpServerClient({
    rootPath: process.cwd(),
    server: { id: "frame-limit", transport: "stdio", command: "fake-mcp-stub", args: [] },
    values: {},
    connectTimeoutMs: 2_000,
    callTimeoutMs: 2_000,
    spawnImpl: () => server.child,
  });
  t.after(() => client.close());
  return { client, server };
}

test("a multibyte frame inside the byte budget is accepted", async (t) => {
  // Just under 4MiB of bytes, but a third of that in UTF-16 code units: even a
  // character-counting guard has no reason to refuse it.
  const pad = "漢".repeat(Math.floor((FRAME_BUDGET_BYTES - 4_096) / 3));
  const { client } = createClient(t, (message, api) => {
    if (message.method !== "ping") return;
    api.emitJson({ jsonrpc: "2.0", id: message.id, result: { pad } });
  });

  assert.deepEqual((await client.connect()).map((tool) => tool.name), ["echo"]);
  await client.ping(10_000);
});

test("a frame past the byte budget is refused even when its UTF-16 length fits", async (t) => {
  const pad = "漢".repeat(Math.floor((FRAME_BUDGET_BYTES + 64 * 1024) / 3));
  const frame = (id) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "frame-limit stub", version: "1" },
        pad,
      },
    });
  // The escape this regression pins: more than 4MiB of UTF-8 bytes on the
  // wire, fewer than 4Mi UTF-16 code units once decoded.
  assert.ok(Buffer.byteLength(frame(1), "utf8") > FRAME_BUDGET_BYTES);
  assert.ok(frame(1).length <= FRAME_BUDGET_BYTES);

  const { client, server } = createClient(t, (message, api) => {
    if (message.method !== "initialize") return;
    api.emit(Buffer.from(`${frame(message.id)}\n`, "utf8"));
    return true;
  });

  await assert.rejects(client.connect(), /oversized message/);
  assert.ok(server.kills.length >= 1, "the oversized server was not signalled");
  assert.equal(server.child.stdin.writable, false, "the oversized server stdin stayed open");
});

test("frames coalesced into one read are budgeted per frame, not by their sum", async (t) => {
  const noise = "x".repeat(1_600_000);
  const { client, server } = createClient(t, (message, api) => {
    if (message.method !== "ping") return;
    // One read carrying the ping result plus three unrelated but valid frames,
    // each inside the budget, whose sum is well over it.
    const chunk = Buffer.concat([
      api.frameBytes({ jsonrpc: "2.0", id: message.id, result: {} }),
      api.frameBytes({ jsonrpc: "2.0", result: { noise } }),
      api.frameBytes({ jsonrpc: "2.0", result: { noise } }),
      api.frameBytes({ jsonrpc: "2.0", result: { noise } }),
    ]);
    assert.ok(chunk.length > FRAME_BUDGET_BYTES);
    api.emit(chunk);
  });

  await client.connect();
  await client.ping(20_000);
  assert.equal(server.kills.length, 0, "a coalesced read closed a healthy session");
});

test("a code point split across two reads is framed once and decoded whole", async (t) => {
  const text = "漢字かな漢字";
  const { client } = createClient(t, (message, api) => {
    if (message.method !== "tools/call") return;
    const body = api.frameBytes({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text }] },
    });
    const cut = body.indexOf(Buffer.from("漢字", "utf8")) + 1;
    api.emit(body.subarray(0, cut));
    api.emit(body.subarray(cut));
  });

  await client.connect();
  const result = await client.callTool("echo", {});
  assert.equal(result.content[0].text, text);
});

test("ASCII frames keep the byte ceiling from both sides", async (t) => {
  const inside = "x".repeat(FRAME_BUDGET_BYTES - 4_096);
  const accepted = createClient(t, (message, api) => {
    if (message.method !== "ping") return;
    api.emitJson({ jsonrpc: "2.0", id: message.id, result: { inside } });
  });
  await accepted.client.connect();
  await accepted.client.ping(10_000);

  const outside = "x".repeat(FRAME_BUDGET_BYTES + 4_096);
  const refused = createClient(t, (message, api) => {
    if (message.method !== "initialize") return;
    api.emitJson({ jsonrpc: "2.0", id: message.id, result: { outside } });
    return true;
  });
  await assert.rejects(refused.client.connect(), /oversized message/);
});

test("an unterminated residual is not a frame", async (t) => {
  const { client } = createClient(t, (message, api) => {
    if (message.method !== "ping") return;
    // The valid reply's bytes, but the transport never sees the delimiter.
    api.emit(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
  });

  await client.connect();
  await assert.rejects(client.ping(150), { code: "TIMEOUT" });
  assert.equal(client.isConnected(), true, "a partial frame closed the session");
});

test("invalid UTF-8 bytes stay a stray line and do not close the session", async (t) => {
  const { client } = createClient(t, (message, api) => {
    if (message.method !== "ping") return;
    api.emit(Buffer.from([0xff, 0xfe, 0x80, 0xc3, 0x0a]));
    api.emitJson({ jsonrpc: "2.0", id: message.id, result: {} });
  });

  await client.connect();
  await client.ping(2_000);
  assert.equal(client.isConnected(), true);
});
