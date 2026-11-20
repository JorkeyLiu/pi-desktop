/**
 * Long-history transcript event workload: premise measurement, not a
 * correctness suite.
 *
 * The renderer receives agent events through the real store slice and renders
 * the real `ChatTranscript` and `SubagentDock`. The driver that bundles this
 * probe wraps a handful of production functions so the result states how many
 * times each one ran and how many message rows it read; the probe itself only
 * drives public surfaces, replays synthetic envelopes, and records what the
 * user would see.
 *
 * Fixtures, envelopes, and the fixed scenario list live in
 * `transcript-event-fixture.ts` so the comparison input is a single file. Every
 * input here is synthetic: no host, provider, filesystem service, or running
 * Desktop instance is involved. The numbers are a baseline to compare identical
 * replays against a changed implementation, so the fixture shape, warmup, and
 * event order are fixed and printed with the result.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";
import { SubagentDock } from "../../apps/desktop/src/components/SubagentDock";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import {
  AT_MS,
  delta,
  envelope,
  fixture,
  nextId,
  scenarios,
  toolEnd,
  toolStart,
  type Fixture,
  type Replay,
  type Scenario,
} from "./transcript-event-fixture";

type WorkCounter = { calls: number; rows: number; ms: number };

declare global {
  var __workloadCounters: Record<string, WorkCounter> | undefined;
  var transcriptEventWorkloadProbe: () => Promise<unknown>;
}

function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`Event workload: ${label}`);
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function Surface() {
  const sessionId = useAppStore((state) => state.activeSessionId);
  const messages = useAppStore((state) => state.messages);
  const running = useAppStore((state) =>
    sessionId ? state.runningSessions[sessionId] === true : false,
  );
  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <ChatTranscript
        key={sessionId}
        sessionId={sessionId}
        messages={messages}
        isRunning={running}
      />
      {/* The composer mounts the dock only for a live session; mirror that. */}
      {sessionId ? <SubagentDock sessionId={sessionId} /> : null}
    </div>
  );
}

/**
 * Message-identity commits and DOM mutations are counted, not timed: React's
 * `<Profiler>` is a pass-through in a production bundle, so the observation is
 * a store subscription plus a `MutationObserver`, both public APIs.
 */
const observed = { messageCommits: 0, mutations: 0 };
let stopObservingMessages: (() => void) | undefined;
let mutationObserver: MutationObserver | undefined;

function startObserving(host: HTMLElement) {
  stopObservingMessages?.();
  stopObservingMessages = useAppStore.subscribe((state, previous) => {
    if (state.messages !== previous.messages) observed.messageCommits += 1;
  });
  mutationObserver?.disconnect();
  mutationObserver = new MutationObserver((records) => {
    observed.mutations += records.length;
  });
  mutationObserver.observe(host, { subtree: true, childList: true, characterData: true });
}

function stopObserving() {
  stopObservingMessages?.();
  stopObservingMessages = undefined;
  mutationObserver?.disconnect();
  mutationObserver = undefined;
}

function readCounters(): Record<string, WorkCounter> {
  const counters = globalThis.__workloadCounters ?? {};
  const copy: Record<string, WorkCounter> = {};
  for (const [name, value] of Object.entries(counters)) {
    copy[name] = { calls: value.calls, rows: value.rows, ms: Math.round(value.ms * 100) / 100 };
  }
  return copy;
}

function counterDelta(before: Record<string, WorkCounter>, after: Record<string, WorkCounter>) {
  const delta: Record<string, WorkCounter> = {};
  for (const [name, value] of Object.entries(after)) {
    const start = before[name] ?? { calls: 0, rows: 0, ms: 0 };
    delta[name] = {
      calls: value.calls - start.calls,
      rows: value.rows - start.rows,
      ms: Math.round((value.ms - start.ms) * 100) / 100,
    };
  }
  return delta;
}

function percentile(samples: number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.round(fraction * (ordered.length - 1))));
  return Math.round(ordered[index]! * 100) / 100;
}

function stats(samples: number[]) {
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    events: samples.length,
    totalMs: Math.round(total * 100) / 100,
    meanMs: samples.length ? Math.round((total / samples.length) * 100) / 100 : 0,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.round(Math.max(0, ...samples) * 100) / 100,
  };
}

function phaseObservation() {
  return { messageCommits: observed.messageCommits, mutations: observed.mutations };
}

function phaseDelta(start: { messageCommits: number; mutations: number }) {
  return {
    messageCommits: observed.messageCommits - start.messageCommits,
    mutations: observed.mutations - start.mutations,
  };
}

/** Public store → event slice → projection → rendered DOM, one event per commit. */
async function mount(host: HTMLElement, errors: unknown[]) {
  const root = createRoot(host, { onUncaughtError: (error) => errors.push(error) });
  flushSync(() => root.render(
    <I18nextProvider i18n={i18n}>
      <Surface />
    </I18nextProvider>,
  ));
  await frame();
  await frame();
  return root;
}

function seed(item: Fixture, running: boolean) {
  flushSync(() => useAppStore.setState({
    activeSessionId: item.summary.id,
    sessions: [item.summary],
    messages: item.messages,
    page: "chat",
    runningSessions: { [item.summary.id]: running },
    isRunning: running,
    retainedTranscripts: {},
    sessionCompactions: {},
    sessionHistory: {},
    pendingPlans: {},
    pendingAsks: {},
    pendingPermissions: {},
  }));
}

const send = (replay: Replay) => {
  useAppStore.getState().handleAgentEvent({
    sessionId: replay.sessionId,
    turnId: replay.turnId,
    ts: AT_MS,
    event: replay.event,
  });
};

function timedSend(replay: Replay): number {
  const started = performance.now();
  flushSync(() => send(replay));
  return performance.now() - started;
}

async function settle() {
  await frame();
  await frame();
}

/**
 * Delta phase: the parent's answer streams while `chains` children run.
 * Lifecycle phase: one `Task` segment retires, one `TaskWait` roster row
 * reports new child figures, one child usage row updates, and one ordinary
 * tool call opens and closes — the dense per-event shape a fan-out produces.
 */
async function runScenario(
  host: HTMLElement,
  errors: unknown[],
  root: { unmount: () => void } | undefined,
  scenario: Scenario,
) {
  const item = fixture(scenario.historyRows, scenario.chains);
  seed(item, true);
  const mounted = root ?? (await mount(host, errors));
  await settle();
  // Warm the projection, the mounted rows, and the delegate cards.
  for (let index = 0; index < 3; index += 1) send(delta(item, " warm"));
  await settle();
  startObserving(host);
  let counters = readCounters();
  const deltaStart = phaseObservation();

  // Streaming arrives on frames: three deltas coalesce per frame, then the
  // batcher commits once. Waiting for that commit measures the real path.
  const deltaFrames: number[] = [];
  const frames = Math.max(1, Math.round(scenario.deltas / 3));
  let sent = 0;
  let committed = observed.messageCommits;
  const deltaStartedAt = performance.now();
  for (let index = 0; index < frames; index += 1) {
    const frameStartedAt = performance.now();
    for (let within = 0; within < 3 && sent < scenario.deltas; within += 1, sent += 1) {
      send(delta(item, ` d${sent}`));
    }
    for (let attempt = 0; attempt < 8 && observed.messageCommits === committed; attempt += 1) {
      await frame();
    }
    deltaFrames.push(performance.now() - frameStartedAt);
    committed = observed.messageCommits;
  }
  const deltaWallMs = performance.now() - deltaStartedAt;
  const deltaObservation = phaseDelta(deltaStart);
  const deltaCounters = counterDelta(counters, readCounters());
  const deltaWorkMs = Object.values(deltaCounters).reduce((total, slot) => total + slot.ms, 0);

  await settle();
  const lifecycleStart = phaseObservation();
  counters = readCounters();
  const lifecycleTimings: number[] = [];
  for (let round = 0; round < scenario.lifecycleRounds; round += 1) {
    const chain = scenario.chains ? round % scenario.chains : 0;
    const delegation = `${item.summary.id}-del-${chain}`;
    const callId = `${item.summary.id}-round-${round}`;
    const toolId = `${item.summary.id}-tool-${round}`;
    lifecycleTimings.push(timedSend(toolStart(item, callId, "Task", {
      agent: "auditor",
      description: `Round ${round} audit`,
      task: "a long brief that is never a title",
      resume: delegation,
    })));
    lifecycleTimings.push(timedSend(toolEnd(item, callId, {
      details: {
        delegationId: `${delegation}-r${round}`,
        agent: "auditor",
        status: "running",
        startedAt: AT_MS,
        turns: 1,
        toolCalls: 2,
        contextTokens: 1_000 + round,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      },
    })));
    const waitId = `${item.summary.id}-wait-round-${round}`;
    lifecycleTimings.push(timedSend(toolStart(item, waitId, "TaskWait", {})));
    lifecycleTimings.push(timedSend(toolEnd(item, waitId, {
      details: {
        delegations: [{
          delegationId: `${delegation}-r${round}`,
          turns: 3,
          toolCalls: 4,
          contextTokens: 2_000 + round,
          usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240 },
        }],
      },
    })));
    lifecycleTimings.push(timedSend(delta(item, " child", `${callId}-child`, {
      parentToolCallId: callId,
      agentName: "auditor",
      usage: { inputTokens: 150, outputTokens: 25, totalTokens: 175 },
    })));
    lifecycleTimings.push(timedSend(toolStart(item, toolId, "Read", { path: `fixture-${round}.txt` })));
    lifecycleTimings.push(timedSend(toolEnd(item, toolId, { content: `fixture ${round}` })));
  }
  const lifecycleSettledAt = performance.now();
  await settle();
  const lifecycleWallMs = performance.now() - lifecycleSettledAt;
  const lifecycleObservation = phaseDelta(lifecycleStart);
  const lifecycleCounters = counterDelta(counters, readCounters());
  stopObserving();
  const lifecycleWorkMs = Object.values(lifecycleCounters)
    .reduce((total, slot) => total + slot.ms, 0);

  assert(errors.length === 0, `${scenario.name}: render errors ${errors.map(String).join(" | ")}`);
  return {
    result: {
      ...scenario,
      fixtureMessages: item.messages.length,
      deltaPhase: {
        frames,
        envelopes: sent,
        frameLatency: stats(deltaFrames),
        wallMs: Math.round(deltaWallMs * 100) / 100,
        ...deltaObservation,
        workMsPerCommit:
          deltaObservation.messageCommits > 0
            ? Math.round((deltaWorkMs / deltaObservation.messageCommits) * 100) / 100
            : 0,
        work: deltaCounters,
      },
      lifecyclePhase: {
        ...stats(lifecycleTimings),
        wallMs: Math.round(lifecycleWallMs * 100) / 100,
        ...lifecycleObservation,
        workMsPerEvent:
          lifecycleTimings.length > 0
            ? Math.round((lifecycleWorkMs / lifecycleTimings.length) * 100) / 100
            : 0,
        work: lifecycleCounters,
      },
    },
    unmount: () => mounted.unmount(),
  };
}

/**
 * Correctness invariants the optimisation must preserve. Each one reads the
 * rendered DOM the reader sees; none inspects private state.
 */
async function invariants(host: HTMLElement, errors: unknown[], root: { unmount: () => void }) {
  const item = fixture(60, 2);
  seed(item, true);
  await settle();
  const text = () => host.textContent ?? "";
  const tailRow = () => {
    const row = host.querySelector<HTMLElement>(`[data-message-id="${item.tailId}"]`);
    assert(row, "streaming assistant row mounted");
    return row;
  };

  // Ordered, lossless text deltas.
  for (const chunk of [" alpha", " beta", " gamma"]) timedSend(delta(item, chunk));
  await settle();
  const tail = tailRow().textContent ?? "";
  assert(tail.includes("alpha beta gamma"), `rendered delta order: ${tail}`);
  const stored = useAppStore.getState().messages.find((message) => message.id === item.tailId);
  assert(stored?.content === " alpha beta gamma", `stored delta text: ${stored?.content}`);

  // A tool's partial update is superseded by its final result.
  const toolId = nextId(`${item.summary.id}-bash`);
  timedSend(toolStart(item, toolId, "Bash", { command: "printf final" }));
  timedSend(envelope(item, {
    type: "tool_update",
    toolCallId: toolId,
    partialResult: { stdout: "partial output" },
  }));
  timedSend(toolEnd(item, toolId, { stdout: "final output", exitCode: 0 }));
  await settle();
  const toolRow = host.querySelector<HTMLElement>(`[data-message-id="${toolId}"]`);
  assert(toolRow, "completed tool row mounted");
  // The row body is a disclosure; open it the way a reader would.
  const toolHeader = toolRow.querySelector<HTMLButtonElement>(".tool-row-header");
  if (toolHeader && toolHeader.getAttribute("aria-expanded") !== "true") {
    flushSync(() => toolHeader.click());
  }
  await settle();
  assert((toolRow.textContent ?? "").includes("final output"), `final tool result rendered: ${toolRow.outerHTML.slice(-1500)}`);
  assert(!(toolRow.textContent ?? "").includes("partial output"), "stale partial tool output rendered");
  assert(useAppStore.getState().messages.some((message) => message.id === toolId), "final tool row stored");

  // The chain's earliest description is its title; a continuation never renames it.
  assert(text().includes("Chain 0 audit"), "delegation card keeps the chain title");
  assert(!text().includes("Continuation 0.1"), "continuation description became a title");
  assert(!text().includes("a long brief"), "task brief leaked into a title");

  // The dock lists the latest running segment of each chain with the folded figures.
  const dock = () => host.querySelector<HTMLElement>(".subagent-dock");
  assert(dock(), "running children listed in the dock");
  const dockText = () => dock()?.textContent ?? "";
  assert(dockText().includes("2 subagents running"), `dock summary: ${dockText()}`);
  assert(dockText().includes("Chain 0 audit"), `dock title: ${dockText()}`);
  assert(dockText().includes("Turns 24"), `dock folds every segment's turns: ${dockText()}`);
  assert(dockText().includes("Tool calls 30"), `dock folds every segment's tool calls: ${dockText()}`);
  assert(dockText().includes("Context 51.2K"), `dock states the chain's latest occupancy: ${dockText()}`);

  // A new running segment is the live one and its report replaces the figures.
  const resumeId = nextId(`${item.summary.id}-resume`);
  timedSend(toolStart(item, resumeId, "Task", {
    agent: "auditor",
    description: "Continuation 0.3",
    task: "a long brief that is never a title",
    resume: `${item.summary.id}-del-0-2`,
  }));
  timedSend(toolEnd(item, resumeId, {
    details: {
      delegationId: `${item.summary.id}-del-0-4`,
      agent: "auditor",
      status: "running",
      startedAt: AT_MS,
      turns: 12,
      toolCalls: 13,
      contextTokens: 70_000,
      usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600 },
    },
  }));
  await settle();
  assert(dockText().includes("Turns 36"), `dock folds the new segment: ${dockText()}`);
  assert(dockText().includes("Context 70K"), `dock states the new occupancy: ${dockText()}`);
  assert(dockText().includes("Chain 0 audit"), `resumed chain keeps its title: ${dockText()}`);
  assert(!dockText().includes("Continuation 0.3"), `resumed chain was renamed: ${dockText()}`);

  // Ending the turn settles the transcript and empties the dock.
  timedSend(envelope(item, { type: "agent_end", messageIds: [] }));
  await settle();
  assert(!dock(), "dock still lists children after the turn ended");
  assert(errors.length === 0, `invariant render errors ${errors.map(String).join(" | ")}`);

  return {
    orderedDeltas: true,
    latestToolResult: true,
    chainTitleStable: true,
    latestSegmentMetrics: true,
    dockClearedOnAgentEnd: true,
    mountedRowsAfterSettle: host.querySelectorAll(".message-row").length,
  };
}

export async function transcriptEventWorkloadProbe() {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const initial = useAppStore.getState();
  const originalDateNow = Date.now;
  const wallTime = AT_MS;
  const originals = {
    getSession: api.getSession,
    listSessions: api.listSessions,
    pendingPlans: api.pendingPlans,
    listQueuedPrompts: api.listQueuedPrompts,
    composerCommands: api.composerCommands,
  };
  const errors: unknown[] = [];
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
  document.body.append(host);
  let root: { unmount: () => void } | undefined;
  try {
    Date.now = () => wallTime;
    api.getSession = async () => ({ session: null });
    api.listSessions = async () => ({ sessions: [] });
    api.pendingPlans = async () => ({ plans: [], state: "inactive" });
    api.listQueuedPrompts = async () => ({ entries: [] });
    api.composerCommands = async () => ({ commands: [] });
    useAppStore.setState({
      providers: [],
      providerModels: {},
      sessions: [],
      // `AppState.settings` is optional, so this inherits whatever the store
      // booted with and forces the two flags the replay depends on (the same
      // seed shape `session-reading-position.tsx` uses).
      settings: { ...initial.settings, smoothStreaming: false, thinkingDisplayMode: "detailed" },
      notifications: [],
      workspace: undefined,
      selectingSessionId: undefined,
    });

    root = await mount(host, errors);
    const results: unknown[] = [];
    for (const scenario of scenarios) {
      const { result, unmount } = await runScenario(host, errors, root, scenario);
      results.push(result);
      // A fresh mount per scenario: section cards, disclosure state, and the
      // projection cache all start from the same warmup-free state.
      flushSync(() => unmount());
      root = await mount(host, errors);
    }
    flushSync(() => root?.unmount());
    root = undefined;
    const rendered = await (async () => {
      const mounted = await mount(host, errors);
      const result = await invariants(host, errors, mounted);
      flushSync(() => mounted.unmount());
      return result;
    })();

    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return {
      ok: true,
      environment: {
        userAgent: navigator.userAgent,
        language: navigator.language,
        hardwareConcurrency: navigator.hardwareConcurrency,
        devicePixelRatio: window.devicePixelRatio,
        heapUsedBytes: memory?.usedJSHeapSize ?? null,
        eventBatching: "one flushSync commit per replayed envelope",
        warmupDeltas: 3,
        counterTiming: "inclusive: a counter's ms includes instrumented callees",
      },
      scenarioCount: results.length,
      scenarios: results,
      invariants: rendered,
      errors: errors.map(String),
    };
  } finally {
    if (root) flushSync(() => root?.unmount());
    Date.now = originalDateNow;
    host.remove();
    Object.assign(api, originals);
    useAppStore.setState(initial, true);
  }
}

globalThis.transcriptEventWorkloadProbe = transcriptEventWorkloadProbe;
