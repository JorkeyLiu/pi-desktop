import { IPC } from "@pi-desktop/shared/protocol";
import type { Result, SessionSummary, UiMessage } from "@pi-desktop/shared";
import { assert } from "./upward-anchor-sampling";

/*
  Fixture history for the upward-anchor probe, plus the fixture IPC boundary it
  is served through.

  The transcript pages older history in 100 raw messages at a time and mounts a
  trailing window over what is loaded. Both add height above the reading
  position, so the fixture is built to make that height real: prose of varying
  length, fenced code, grouped tool runs, and one assistant turn that straddles
  a page boundary.
*/
export const createdAt = "2026-09-01T00:00:00Z";

const HISTORY_TOTAL = 1000;
/** Raw messages one history read returns (the host page size). */
export const PAGE = 100;
/** First page boundary the reader reaches: the initial read starts here. */
export const FIRST_BOUNDARY = HISTORY_TOTAL - PAGE;
/**
 * One assistant turn spanning this span of raw messages, built from assistant
 * and tool rows only so the projection renders it as a single row. It straddles
 * `FIRST_BOUNDARY`, so the first older page merges its fragments into the row
 * the reader is reading.
 */
const MARATHON_START = 860;
const MARATHON_END = 920;
/**
 * The same shape placed so that the first two page boundaries (900, 800) fall
 * between turns: the ordinary case every asserted phase measures.
 */
const PLAIN_MARATHON_START = 640;

function proseContent(index: number): string {
  const paragraphs = 1 + (index % 4);
  const body = Array.from({ length: paragraphs }, (_, paragraph) =>
    `Row ${index} paragraph ${paragraph}. ` +
    "Reader content that wraps across the transcript column. ".repeat(4 + ((index + paragraph) % 5)),
  ).join("\n\n");
  // Variable-height fenced blocks: real layout cost, not a fixed row height.
  if (index % 9 !== 0) return body;
  const lines = Array.from({ length: 4 + (index % 7) }, (_, line) =>
    `const value${line} = compute(${index}, ${line});`);
  return `${body}\n\n\`\`\`ts\n${lines.join("\n")}\n\`\`\``;
}

function row(
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage {
  return { id, role, content, createdAt, status: "complete", ...extra };
}
export function toolRow(id: string, index: number): UiMessage {
  return row(id, "tool", `Synthetic result ${index}`, {
    toolName: "Bash", toolCallId: id, toolStatus: "success",
    toolArgs: { command: `printf row-${index}` },
    toolResult: { details: { stdout: `row-${index}-result`, exitCode: 0 } },
  });
}

/**
 * Prose of varying length, fenced code, and grouped tool runs.
 *
 * Outside the marathon turn a prompt and its answer alternate one message at a
 * time, so one page of 100 raw messages is ~100 transcript rows: more than the
 * mounted window, which is what makes window growth part of this path.
 */
function mixedHistory(id: string, marathonStart: number): UiMessage[] {
  const messages: UiMessage[] = [];
  for (let index = 0; index < HISTORY_TOTAL; index++) {
    const messageId = `${id}-m${index}`;
    if (index >= marathonStart && index <= marathonStart + (MARATHON_END - MARATHON_START)) {
      messages.push(index % 3 === 0
        ? row(messageId, "assistant", proseContent(index))
        : toolRow(messageId, index));
      continue;
    }
    if (index % 2 === 0) {
      messages.push(row(messageId, "user", `Prompt ${index}. ` +
        "What changed in this part of the work? ".repeat(2 + (index % 3))));
    } else {
      messages.push(row(messageId, "assistant", proseContent(index)));
    }
  }
  return messages;
}

export type Fixture = {
  summary: SessionSummary;
  messages: UiMessage[];
  /** Artificial IPC latency for older-page reads, in milliseconds. */
  latencyMs: number;
  /** Withholds this conversation's older-page answers until the probe releases them. */
  gate?: PageGate;
};

function fixture(
  id: string,
  title: string,
  latencyMs: number,
  marathonStart = MARATHON_START,
  gate?: PageGate,
): Fixture {
  const messages = mixedHistory(id, marathonStart);
  return {
    latencyMs,
    ...(gate ? { gate } : {}),
    messages,
    summary: {
      id, title, mode: "agent", permissionMode: "ask", thinkingLevel: "off",
      providerId: "fixture", modelId: "fixture", createdAt, updatedAt: createdAt,
      messageCount: messages.length,
    },
  };
}

/**
 * One older-page answer the fixture boundary withholds.
 *
 * The exact-top phase has to know that the page it asked for is genuinely in
 * flight while the reader's offset is still exactly 0 - before anything is
 * rendered from it. Holding the answer at the external boundary makes that
 * observable without waiting on a clock. `arm` re-withholds a later read, and
 * once released a read is answered immediately so a re-request is counted by
 * the phase instead of hanging the harness.
 */
export type PageGate = {
  /** Older-page reads the boundary is holding right now. */
  readonly held: number;
  /** Withhold (or re-withhold) older-page answers. */
  arm: () => void;
  /** Answer every withheld read and stop withholding. */
  release: () => void;
  /** Called by the fixture boundary for one older-page read. */
  hold: () => Promise<void>;
};

export function createPageGate(): PageGate {
  let withholding = true;
  let held = 0;
  let waiting: Array<() => void> = [];
  return {
    get held() { return held; },
    arm() { withholding = true; },
    release() {
      withholding = false;
      const pending = waiting;
      waiting = [];
      held = 0;
      for (const resolve of pending) resolve();
    },
    hold() {
      if (!withholding) return Promise.resolve();
      held += 1;
      return new Promise<void>((resolve) => { waiting.push(resolve); });
    },
  };
}

/** The conversation whose older pages the exact-top phase controls. */
export const EXACT_TOP_SESSION = "up-top";

/** The gate the exact-top fixture holds its older pages behind. */
export function exactTopGate(fixtures: Map<string, Fixture>): PageGate {
  const gate = fixtures.get(EXACT_TOP_SESSION)?.gate;
  assert(gate, "the exact-top fixture has no page gate");
  return gate;
}
/** Fixture conversations plus the exact-top one whose older pages are held. */
export function createFixtures(): Map<string, Fixture> {
  return new Map<string, Fixture>([
    ["up-fast", fixture("up-fast", "Fast older pages", 0, PLAIN_MARATHON_START)],
    ["up-slow", fixture("up-slow", "Slow older pages", 180, PLAIN_MARATHON_START)],
    // One page boundary deliberately cuts inside an assistant turn: measured,
    // not asserted (see the merge phase).
    ["up-merge", fixture("up-merge", "Page cut inside a turn", 0)],
    // The exact-top phase gets a conversation no earlier phase has read, and
    // its older pages are answered only when the phase releases them, so
    // reaching offset 0 cannot consume the history being measured.
    [EXACT_TOP_SESSION, fixture(EXACT_TOP_SESSION, "Held older page at the top",
      0, PLAIN_MARATHON_START, createPageGate())],
    ["up-other", fixture("up-other", "Second conversation", 0, PLAIN_MARATHON_START)],
  ]);
}

export type ReadRecord = { session: string; before?: number; limit: number };

type FixtureBridge = {
  channels: typeof IPC;
  platform: string;
  on: () => () => void;
  invoke: <T>(channel: string, ...args: unknown[]) => Promise<Result<T>>;
};

/**
 * Serve the fixture sessions over the preload bridge. The caller keeps the real
 * bridge and restores it once the probe is done.
 */
export function installFixtureIpc(options: {
  fixtures: Map<string, Fixture>;
  reads: ReadRecord[];
  unexpected: string[];
}): void {
  const { fixtures, reads, unexpected } = options;
  const bridge: FixtureBridge = {
    channels: IPC, platform: "win32", on: () => () => {},
    invoke: async <T,>(channel: string, ...args: unknown[]): Promise<Result<T>> => {
      let data: unknown;
      if (channel === IPC.invoke.sessionGet) {
        const input = args[0] as {
          id: string; messageAround?: string; messageBefore?: number; messageLimit?: number;
        };
        assert(input && typeof input === "object", "invalid history request");
        const target = fixtures.get(input.id);
        assert(target, `unexpected session ${input.id}`);
        const all = target.messages;
        const limit = Math.min(input.messageLimit ?? all.length, 1000);
        let start: number;
        let end: number;
        if (input.messageAround) {
          const index = all.findIndex((candidate) => candidate.id === input.messageAround);
          assert(index >= 0, "missing history anchor");
          end = Math.min(all.length, index + Math.ceil(limit / 2));
          start = Math.max(0, end - limit);
          reads.push({ session: input.id, limit });
        } else if (input.messageBefore !== undefined) {
          end = Math.min(Math.max(0, input.messageBefore), all.length);
          start = Math.max(0, end - limit);
          reads.push({ session: input.id, before: input.messageBefore, limit });
          if (target.gate) await target.gate.hold();
          if (target.latencyMs > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, target.latencyMs));
          }
        } else {
          end = all.length;
          start = Math.max(0, end - limit);
          reads.push({ session: input.id, limit });
        }
        data = { session: { ...target.summary, messages: all.slice(start, end), messageStart: start,
          messageEnd: end, hasMoreBefore: start > 0, hasMoreAfter: end < all.length } };
      } else if (channel === IPC.invoke.sessionList) {
        data = { sessions: [...fixtures.values()].map((item) => item.summary) };
      } else if (channel === IPC.invoke.plansPending) data = { plans: [], state: "inactive" };
      else if (channel === IPC.invoke.pendingInteractive) data = { permissions: [], asks: [] };
      else if (channel === IPC.invoke.agentQueueList) data = { entries: [] };
      else if (channel === IPC.invoke.notificationMarkRead || channel === IPC.invoke.notificationSetViewingSession) data = { ok: true };
      else {
        unexpected.push(channel);
        return { ok: false, error: { code: "FIXTURE_UNEXPECTED", message: `Unexpected IPC ${channel}` } };
      }
      return { ok: true, data: data as T };
    },
  };
  (window as unknown as { piDesktop: FixtureBridge }).piDesktop = bridge;
}
