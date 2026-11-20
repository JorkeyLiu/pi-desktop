#!/usr/bin/env node
/**
 * Long-history / subagent event workload baseline.
 *
 * Bundles `scripts/e2e/transcript-event-workload.tsx` against the working
 * checkout, wraps a small set of production functions so the probe reports
 * deterministic call/row counts beside the timings, and runs it in an isolated,
 * hidden Electron window. Synthetic events only: no host, provider, profile, or
 * running Desktop instance is touched.
 *
 * Usage:
 *   node scripts/e2e-transcript-event-workload.mjs [--json <path>]
 *
 * The same fixture and replay order must be used to compare a changed
 * implementation against this baseline.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);

/** Production functions the probe's result reports on, by module. */
const INSTRUMENTED = [
  ["lib/subagent-title.ts", "subagentTaskTitles"],
  ["lib/subagent-chain-provider.tsx", "subagentChainKeysByIdentity"],
  ["lib/subagent-metrics-provider.tsx", "subagentChainMetricsByIdentity"],
  ["lib/subagent-chain.ts", "subagentChainCallIds"],
  ["lib/subagent-metrics.ts", "aggregateChainMetricsFromMessages"],
  ["lib/subagent-index.ts", "subagentTranscriptIndex"],
  ["lib/transcript-projection.ts", "getTranscriptProjection"],
  ["features/chat/composer/subagent-dock-model.ts", "collectDockSubagents"],
];

function counterWrapper(name) {
  return `
;(() => {
  const measured = ${name};
  ${name} = function (...args) {
    const slot = ((globalThis.__workloadCounters ??= {})[${JSON.stringify(name)}] ??= { calls: 0, rows: 0, ms: 0 });
    slot.calls += 1;
    const first = args[0];
    if (first != null && typeof first.length === "number") slot.rows += first.length;
    const started = performance.now();
    try {
      return measured.apply(this, args);
    } finally {
      slot.ms += performance.now() - started;
    }
  };
})();
`;
}

const instrumentation = {
  name: "instrument-workload-functions",
  setup(builder) {
    builder.onLoad(
      { filter: /(subagent-title|subagent-chain-provider|subagent-metrics-provider|subagent-metrics|subagent-chain|subagent-index|transcript-projection|subagent-dock-model)\.tsx?$/ },
      async ({ path }) => {
        const marker = "/apps/desktop/src/";
        const relative = path.slice(path.lastIndexOf(marker) + marker.length);
        const names = INSTRUMENTED.filter(([file]) => file === relative).map(([, name]) => name);
        let source = await readFile(path, "utf8");
        for (const name of names) {
          assert.match(
            source,
            new RegExp(`export function ${name}\\(`),
            `${relative} no longer declares export function ${name}; update the instrumentation`,
          );
          source += counterWrapper(name);
        }
        return { contents: source, loader: path.endsWith(".tsx") ? "tsx" : "ts" };
      },
    );
  },
};

const temp = await mkdtemp(join(tmpdir(), "pi-transcript-event-workload-"));
const jsonIndex = process.argv.indexOf("--json");
const jsonPath = jsonIndex === -1 ? undefined : process.argv[jsonIndex + 1];
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/transcript-event-workload.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"DEV":false,"MODE":"production"}',
    },
    // Styles are outside this workload contract; component and hook code is real.
    loader: { ".css": "empty" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
    plugins: [
      instrumentation,
      {
        name: "local-url-assets",
        setup(builder) {
          builder.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
            path: join(resolveDir, path.slice(0, -4)),
            namespace: "local-url-asset",
          }));
          builder.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
            contents: await readFile(path),
            loader: "file",
          }));
        },
      },
    ],
  });

  await writeFile(
    join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><title>Transcript event workload</title><style>body{margin:0;padding:16px;font-family:system-ui}</style><div id="root"></div><script src="renderer.js"></script>',
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    await window.webContents.executeJavaScript("window.addEventListener('error', event => console.error(event.error?.stack ?? event.message)); window.addEventListener('unhandledrejection', event => console.error(event.reason?.stack ?? String(event.reason)));");
    const result = await window.webContents.executeJavaScript("globalThis.transcriptEventWorkloadProbe()");
    console.log("TRANSCRIPT_EVENT_WORKLOAD " + JSON.stringify(result));
    app.quit();
  } catch (error) {
    console.error("TRANSCRIPT_EVENT_WORKLOAD " + JSON.stringify({ ok: false, error: error?.stack ?? String(error) }));
    app.exit(1);
  }
});
`,
  );

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => {
      output += data;
    });
  }
  const timeout = setTimeout(() => child.kill("SIGKILL"), 300_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith("TRANSCRIPT_EVENT_WORKLOAD "));
  assert(line, `renderer returned no workload result (exit=${code}): ${output.slice(-3000)}`);
  const result = JSON.parse(line.slice("TRANSCRIPT_EVENT_WORKLOAD ".length));
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true, `workload probe failed: ${output.slice(-3000)}`);
  const report = JSON.stringify(result);
  if (jsonPath) await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`TRANSCRIPT_EVENT_WORKLOAD ${report}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
