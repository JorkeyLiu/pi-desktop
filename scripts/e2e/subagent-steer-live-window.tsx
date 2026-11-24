/**
 * Delegate tab: a running child row across a stale scoped read.
 *
 * The fixture mounts the production `SubagentTranscriptTab` in the work panel's
 * own body and stubs only the preload bridge, which answers `session.get` the
 * way a scoped backend does. The tail read is deferred until the probe releases
 * it, so this reproduces the runtime order: the child tool starts (live only,
 * no durable row yet), the steering reply is echoed, and the answer the read
 * captured before both lands afterwards.
 */
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC, type SessionDetail, type UiMessage } from "@pi-desktop/shared";
import { SubagentTranscriptTab } from "../../apps/desktop/src/components/workpanel/SubagentTranscriptTab";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { findSubagentHistoryEntry } from "../../apps/desktop/src/lib/subagent-history";

declare global {
  var subagentSteerLiveWindowProbe: () => Promise<{
    ok: boolean;
    failures: string[];
    facts: Record<string, unknown>;
  }>;
}

const SESSION = "s1";
const OTHER_SESSION = "s2";
const DELEGATION = "d1";
const CALL = "call-task";
const BASH = "bash-live";
const STEER = "steer-live";
const ROW_STEER = 2401;
const ROW_BASH = 2402;
const base = Date.UTC(2026, 0, 1, 0, 0, 0);
const createdAt = new Date(base).toISOString();
const at = (offset: number) => new Date(base + offset).toISOString();

const gate = () => {
  const record: { started: () => void; released: Promise<void>; start: Promise<void> } = {
    started: () => undefined,
    released: Promise.resolve(),
    start: Promise.resolve(),
  };
  const start = new Promise<void>((resolve) => {
    record.started = resolve;
  });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { start, released, release: () => release(), notifyStarted: () => record.started() };
};

const gates: ReturnType<typeof gate>[] = [];
const reads: { id: string; scope: unknown; messageBefore: number | undefined; messageLimit: number | undefined }[] = [];

/** Durable index list; the completed tool's row is appended by a later stage. */
const durable: number[] = [
  10,
  11,
  ...Array.from({ length: 23 }, (_, block) =>
    Array.from({ length: 100 }, (_, offset) => 100 + block * 100 + offset),
  ).flat(),
  ROW_STEER,
];

function message(id: string, role: UiMessage["role"], content: string, extra: Partial<UiMessage> = {}): UiMessage {
  return { id, role, content, createdAt, status: "complete", ...extra } as UiMessage;
}

function taskRecord(): UiMessage {
  return message("task-row", "tool", "", {
    toolName: "Task",
    toolCallId: CALL,
    toolStatus: "success",
    toolArgs: { agent: "explorer", description: "Run the suite", task: "Run the suite and report." },
    toolResult: { details: { delegationId: DELEGATION, agent: "explorer", status: "running", startedAt: 1000 } },
  });
}

function childRow(index: number): UiMessage {
  return message(`child-${index}`, "tool", "", {
    toolName: "Read",
    toolCallId: `read-${index}`,
    parentToolCallId: CALL,
    toolStatus: "success",
    toolArgs: { path: `file-${index}.ts` },
    createdAt: at(index * 1000),
  } as Partial<UiMessage>);
}

function steerRow(): UiMessage {
  return message(STEER, "user", "Keep going, re-run the suite", {
    parentToolCallId: CALL,
    createdAt: at(ROW_STEER * 1000),
  } as Partial<UiMessage>);
}

function bashLive(extra: Partial<UiMessage> = {}): UiMessage {
  return message(BASH, "tool", "", {
    toolName: "Bash",
    toolCallId: BASH,
    parentToolCallId: CALL,
    toolStatus: "running",
    toolArgs: { command: "npm test" },
    createdAt: at(2_400_500),
    ...extra,
  } as Partial<UiMessage>);
}

function durableRow(index: number): UiMessage {
  if (index === ROW_STEER) return steerRow();
  if (index === ROW_BASH) return bashLive({ toolStatus: "success", content: "suite passed", createdAt: at(ROW_BASH * 1000) });
  return childRow(index);
}

const initialWindow = [10, 11];
let initialServed = false;

function detail(sessionId: string, messages: UiMessage[], options: {
  messageStart: number;
  messageEnd: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}): SessionDetail {
  return {
    id: sessionId,
    title: sessionId === SESSION ? "Live row fixture" : "Other session",
    source: "local",
    mode: "agent",
    createdAt,
    updatedAt: createdAt,
    historyScope: { kind: "delegation", id: DELEGATION },
    historyContext: sessionId === SESSION ? [taskRecord()] : [],
    messages,
    messageStart: options.messageStart,
    messageEnd: options.messageEnd,
    messageCount: 3614,
    hasMoreBefore: options.hasMoreBefore,
    hasMoreAfter: options.hasMoreAfter,
  } as unknown as SessionDetail;
}

window.piDesktop = {
  channels: IPC,
  platform: "darwin",
  invoke: async (channel: string, payload?: unknown) => {
    if (channel !== IPC.invoke.sessionGet) return { ok: true, data: undefined };
    const request = (payload ?? {}) as {
      id?: string;
      historyScope?: { kind?: string; id?: string };
      messageBefore?: number;
      messageLimit?: number;
      contentLimit?: number;
    };
    const id = request.id ?? "";
    reads.push({ id, scope: request.historyScope, messageBefore: request.messageBefore, messageLimit: request.messageLimit });
    if (id === OTHER_SESSION) {
      return { ok: true, data: { session: detail(id, [], { messageStart: 0, messageEnd: 0, hasMoreBefore: false, hasMoreAfter: false }) } };
    }
    if (request.messageBefore !== undefined) {
      const eligible = durable.filter((index) => index < request.messageBefore!);
      const slice = eligible.slice(-100);
      return {
        ok: true,
        data: {
          session: detail(id, slice.map(durableRow), {
            messageStart: slice[0],
            messageEnd: slice[slice.length - 1] + 1,
            hasMoreBefore: durable.some((index) => index < slice[0]),
            hasMoreAfter: true,
          }),
        },
      };
    }
    if (!initialServed) {
      initialServed = true;
      return {
        ok: true,
        data: {
          session: detail(id, initialWindow.map(durableRow), {
            messageStart: initialWindow[0],
            messageEnd: initialWindow[1] + 1,
            hasMoreBefore: true,
            hasMoreAfter: true,
          }),
        },
      };
    }
    // The tail read: answer with the read state as it is when the probe releases it.
    const pending = gate();
    gates.push(pending);
    pending.notifyStarted();
    await pending.released;
    const slice = durable.slice(-100);
    return {
      ok: true,
      data: {
        session: detail(id, slice.map(durableRow), {
          messageStart: slice[0],
          messageEnd: slice[slice.length - 1] + 1,
          hasMoreBefore: durable.some((index) => index < slice[0]),
          hasMoreAfter: false,
        }),
      },
    };
  },
  on: () => () => undefined,
} as unknown as typeof window.piDesktop;

const i18n = createInstance();
void i18n.init({
  lng: "en",
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});

function mainWindow(): UiMessage[] {
  return [message("u-1", "user", "Run the suite"), message("a-1", "assistant", "Starting the delegate."), taskRecord()];
}

flushSync(() => {
  useAppStore.setState({
    activeSessionId: SESSION,
    sessions: [
      { id: SESSION, title: "Live row fixture", source: "local", mode: "agent", createdAt, updatedAt: createdAt },
      { id: OTHER_SESSION, title: "Other session", source: "local", mode: "agent", createdAt, updatedAt: createdAt },
    ],
    messages: mainWindow(),
    isRunning: true,
    settings: { enterToSend: true },
    providers: [],
    providerModels: {},
    plugins: [],
    recentModels: [],
    retainedTranscripts: {},
    retainedSessionIds: [],
    sessionHistory: {},
    transcriptViews: {},
    sessionCompactions: {},
    sessionTodos: {},
    subagentHistory: {},
    pendingPermissions: {},
    pendingAsks: {},
    queuedPrompts: {},
    planCheckpoints: {},
    agentStatuses: {},
    runningSessions: {},
  } as never);
});

const host = document.createElement("div");
host.style.cssText = "position:fixed;inset:0;display:flex;align-items:stretch;background:var(--ds-bg-primary)";
(document.body ?? document.documentElement).append(host);

const panel = document.createElement("div");
panel.className = "work-panel";
panel.style.cssText = "display:flex;flex-direction:column;min-height:0;height:700px;width:420px";
const body = document.createElement("div");
body.className = "work-panel-body";
body.style.cssText = "position:relative;display:flex;min-height:0;flex:1;flex-direction:column;aspect-ratio:auto";
const pane = document.createElement("div");
pane.className = "work-panel-tabpane";
pane.style.cssText = "display:flex;min-height:0;flex:1;flex-direction:column";
host.append(panel);
panel.append(body);
body.append(pane);

let root: Root | null = null;
root = createRoot(pane);
flushSync(() => {
  root!.render(
    <I18nextProvider i18n={i18n}>
      <SubagentTranscriptTab delegationId={DELEGATION} />
    </I18nextProvider>,
  );
});

const frames = (count = 3) =>
  new Promise<void>((resolve) => {
    const tick = (left: number) => {
      if (left <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => tick(left - 1));
    };
    tick(count);
  });

const painted = () =>
  [...document.querySelectorAll<HTMLElement>("[data-message-id]")]
    .map((element) => element.dataset.messageId ?? "");
const instances = (id: string) => painted().filter((value) => value === id).length;
/** The lifecycle the painted tool row states, from its own status class token. */
const rowStatus = (id: string) => {
  const element = document.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  const token = element?.className.match(/status-(\w+)/);
  return token ? token[1] : "";
};
const rowSpinning = (id: string) =>
  document.querySelector<HTMLElement>(`[data-message-id="${id}"] .tool-spinner`) !== null;
const entryNow = () => findSubagentHistoryEntry(useAppStore.getState().subagentHistory, SESSION, DELEGATION);
const pendingIds = () => ((entryNow()?.livePending ?? []) as { id: string }[]).map((row) => row.id);

async function probe() {
  document.documentElement.dataset.theme = "dark";
  const failures: string[] = [];
  const facts: Record<string, unknown> = {};
  const check = (ok: boolean, label: string) => {
    if (!ok) failures.push(label);
  };

  await frames(4);
  check(
    painted().includes("child-10") && painted().includes("child-11"),
    "the tab paints the durable window it read",
  );
  facts.initial = { rows: painted(), reads: reads.length };

  // The read starts on the durable window. The child tool then starts while the
  // read is still in flight, so the answer cannot know about it.
  const read = useAppStore.getState().loadLatestSubagentHistory({ sessionId: SESSION, tabKey: DELEGATION });
  while (!gates.length) await frames(1);
  await gates[0].start;
  check(entryNow()?.refreshing === true, "the in-flight tail read owns the refreshing state");
  flushSync(() => {
    useAppStore.setState({ messages: [taskRecord(), bashLive()] } as never);
  });
  await frames(2);
  facts.liveDuringRead = {
    rows: painted(),
    instances: instances(BASH),
    refreshing: entryNow()?.refreshing,
    pending: pendingIds(),
  };
  check(instances(BASH) === 1, "a started tool is painted from the live publication");
  check(
    entryNow()?.refreshing === true,
    "a live publication does not end the read that is still running",
  );

  // The child keeps streaming: every event republishes the same running tool.
  // The tab holds one unconfirmed version of the call, not one per event.
  for (let round = 0; round < 12; round += 1) {
    flushSync(() => {
      useAppStore.setState({ messages: [taskRecord(), bashLive()] } as never);
    });
  }
  await frames(2);
  facts.repeatedLive = {
    instances: instances(BASH),
    pending: pendingIds(),
    status: rowStatus(BASH),
  };
  check(instances(BASH) === 1, "repeated publications paint the row once");
  check(pendingIds().length === 1, "repeated publications hold one unconfirmed row");

  gates[0].release();
  await read;
  await frames(4);
  facts.afterStaleRead = {
    rows: painted(),
    instances: instances(BASH),
    steer: instances(STEER),
    pending: pendingIds(),
    finalized: entryNow()?.finalized,
    refreshing: entryNow()?.refreshing,
  };
  check(instances(BASH) === 1, "the running row survives a stale scoped read exactly once");
  check(instances(STEER) === 1, "the durable steering row stays");
  check(entryNow()?.finalized === false, "a read that predates a live row does not finalize");

  // The parent window is replaced with nothing: the tab renders its own entry
  // alone, with no live array to fall back on.
  flushSync(() => {
    useAppStore.setState({ messages: [] } as never);
  });
  await frames(3);
  facts.entryOnly = { rows: painted(), instances: instances(BASH) };
  check(instances(BASH) === 1, "the running row paints from the entry alone");

  // The tool ends while the backend still has no durable row for it, and the
  // earlier running frame is replayed afterwards. A read whose pages cannot
  // name the call must keep the settled row, not resurrect the running state.
  flushSync(() => {
    useAppStore.setState({
      messages: [taskRecord(), bashLive({ toolStatus: "success", content: "suite passed", createdAt: at(ROW_BASH * 1000) })],
    } as never);
  });
  flushSync(() => {
    useAppStore.setState({ messages: [taskRecord(), bashLive()] } as never);
  });
  await frames(2);
  const terminalRead = useAppStore.getState().loadLatestSubagentHistory({ sessionId: SESSION, tabKey: DELEGATION });
  while (gates.length < 2) await frames(1);
  await gates[1].start;
  gates[1].release();
  await terminalRead;
  await frames(4);
  const entryBash = ((entryNow()?.messages ?? []) as { id: string; toolStatus?: string }[])
    .filter((row) => row.id === BASH)
    .map((row) => row.toolStatus);
  facts.afterTerminalWindow = {
    instances: instances(BASH),
    pending: pendingIds(),
    final: (entryNow()?.livePending ?? []).map((row) => (row as { toolStatus?: string }).toolStatus),
    entryBash,
  };
  check(instances(BASH) === 1, "the settled row survives the window exactly once");
  check(entryBash.length === 1 && entryBash[0] === "success", "the completed row is not regressed to running by the window");
  check(
    ((entryNow()?.livePending ?? []) as { toolStatus?: string }[]).every((row) => row.toolStatus === "success"),
    "no unsettled version returns to the unconfirmed set",
  );

  // Entry-only: no live array to fall back on, so the tab states what its own
  // entry holds. The settled row paints, and it paints as completed.
  flushSync(() => {
    useAppStore.setState({ messages: [] } as never);
  });
  await frames(3);
  facts.terminalEntryOnly = {
    instances: instances(BASH),
    status: rowStatus(BASH),
    spinning: rowSpinning(BASH),
  };
  check(instances(BASH) === 1, "the settled row paints from the entry alone");
  check(rowStatus(BASH) === "success", "the entry alone states the completed state");
  check(rowSpinning(BASH) === false, "a settled row shows no running spinner");

  // The tool's durable row arrives through the tab's own read.
  durable.push(ROW_BASH);
  const complete = useAppStore.getState().loadLatestSubagentHistory({ sessionId: SESSION, tabKey: DELEGATION });
  while (gates.length < 3) await frames(1);
  await gates[2].start;
  gates[2].release();
  await complete;
  await frames(4);
  facts.afterCompletion = {
    rows: painted(),
    instances: instances(BASH),
    pending: pendingIds(),
    finalized: entryNow()?.finalized,
  };
  check(instances(BASH) === 1, "the completed durable row replaces the live one exactly once");
  check(pendingIds().length === 0, "the confirmed live row retired");
  check(entryNow()?.finalized === true, "a read that confirmed every live row finalizes");

  // The live completion echoed afterwards adds nothing.
  flushSync(() => {
    useAppStore.setState({
      messages: [
        taskRecord(),
        bashLive({ toolStatus: "success", content: "suite passed", createdAt: at(ROW_BASH * 1000) }),
      ],
    } as never);
  });
  await frames(2);
  facts.afterReplay = { rows: painted(), instances: instances(BASH) };
  check(instances(BASH) === 1, "a replayed completion does not duplicate the row");
  facts.reads = reads;
  return { ok: failures.length === 0, failures, facts };
}

globalThis.subagentSteerLiveWindowProbe = probe;
