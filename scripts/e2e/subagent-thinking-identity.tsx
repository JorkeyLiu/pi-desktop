import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC, type UiMessage } from "@pi-desktop/shared";
import { SubagentTranscriptTab } from "../../apps/desktop/src/components/workpanel/SubagentTranscriptTab";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

declare global {
  var subagentThinkingIdentityProbe: () => Promise<{
    ok: boolean;
    failures: string[];
    facts: Record<string, unknown>;
  }>;
}

/*
 * The child's transcript tab with one stable row identity per (kind,
 * message id). A historical assistant message carries both reasoning and
 * text, so the transcript emits a thinking row and an answer row for the same
 * message id. The pane keys each row fragment by kind and message id, so
 * repeated view rebuilds — streaming updates, appends, a turn reorder — keep
 * every thinking node on its own message: no duplicated previews, no lost
 * expansion, no swallowed content. Only the preload bridge is a stub, and the
 * durable history read it would serve fails closed while the live rows under
 * test stay rendered from the store.
 */

const SESSION = "s1";
const DELEGATION = "d1";
const CALL = "call-task";
const createdAt = "2026-10-18T00:00:00.000Z";

window.piDesktop = {
  channels: IPC,
  platform: "darwin",
  invoke: async () => ({ ok: true, data: undefined }),
  on: () => () => undefined,
} as unknown as typeof window.piDesktop;

function message(
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage {
  return { id, role, content, createdAt, status: "complete", ...extra };
}

function seedMessages(): UiMessage[] {
  return [
    message("t1", "tool", "", {
      toolName: "Task",
      toolCallId: CALL,
      toolStatus: "success",
      toolArgs: {
        agent: "explorer",
        description: "Review auth flow",
        task: "Review the auth flow end to end and report what you find.",
      },
      toolResult: {
        details: {
          delegationId: DELEGATION,
          agent: "explorer",
          status: "running",
          startedAt: 1_000,
        },
      },
    }),
    // The historical row: one assistant message with both reasoning and text.
    message("hist-1", "assistant", "Historical answer: the session rotation is sound.", {
      thinking: "Historical reasoning trace: check the rotation first.",
      parentToolCallId: CALL,
      agentName: "explorer",
    }),
  ];
}

const i18n = createInstance();
void i18n.init({
  lng: "en",
  resources: { en: { translation: catalogs.en } },
  interpolation: { escapeValue: false },
});

flushSync(() => {
  useAppStore.setState({
    activeSessionId: SESSION,
    sessions: [
      {
        id: SESSION,
        title: "Thinking identity fixture",
        source: "local",
        mode: "agent",
        createdAt,
        updatedAt: createdAt,
      } as never,
    ],
    messages: seedMessages(),
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
    pendingPermissions: {},
    pendingAsks: {},
    queuedPrompts: {},
    planCheckpoints: {},
    agentStatuses: { [SESSION]: { currentTurnId: "turn-live" } },
    runningSessions: { [SESSION]: true },
    workPanelOpen: true,
    workPanelTabs: [],
    activeWorkPanelTabId: null,
    workPanelContexts: {},
    workPanelFileRequest: null,
    subagentHistory: {},
  } as never);
});

const host = document.createElement("div");
host.style.cssText = "position:fixed;inset:0;display:flex;align-items:stretch;";
(document.body ?? document.documentElement).append(host);
const pane = document.createElement("div");
pane.style.cssText = "display:flex;min-height:0;flex:1;flex-direction:column;width:640px;height:600px";
host.append(pane);

const root = createRoot(pane);
flushSync(() => {
  root.render(
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

const thinkingRows = () => [...document.querySelectorAll(".tool-row.thinking")];
const answerFor = (id: string) =>
  document.querySelectorAll(`.message-row.assistant[data-message-id="${id}"]`);
const previews = () => [...document.querySelectorAll(".thinking-preview")];

function appendMessage(row: UiMessage): void {
  flushSync(() => {
    useAppStore.setState((state) => ({ messages: [...state.messages, row] }));
  });
}

function updateMessage(id: string, patch: Partial<UiMessage>): void {
  flushSync(() => {
    useAppStore.setState((state) => ({
      messages: state.messages.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  });
}

const failuresOf = (checks: Array<[boolean, string]>) =>
  checks.filter(([pass]) => !pass).map(([, label]) => label);

globalThis.subagentThinkingIdentityProbe = async () => {
  const failures: string[] = [];
  const facts: Record<string, unknown> = {};
  await frames();

  // The historical message renders exactly one thinking row and one answer.
  failures.push(
    ...failuresOf([
      [thinkingRows().length === 1, `one thinking row for the historical message (${thinkingRows().length})`],
      [answerFor("hist-1").length === 1, `one answer row for the historical message (${answerFor("hist-1").length})`],
      [previews().length === 1, `one thinking preview before expansion (${previews().length})`],
    ]),
  );
  facts.initial = {
    thinkingRows: thinkingRows().length,
    answers: answerFor("hist-1").length,
    previews: previews().length,
  };

  // Only the historical thinking row expands.
  thinkingRows()[0]?.querySelector<HTMLElement>(".tool-row-header")?.click();
  await frames();
  const expanded =
    thinkingRows()[0]?.querySelector(".tool-row-header")?.getAttribute("aria-expanded") ===
    "true";
  const bodies = thinkingRows()[0]?.querySelectorAll(".tool-row-body").length ?? 0;
  failures.push(
    ...failuresOf([[expanded && bodies === 1, "the historical thinking row expands and shows its body"]]),
  );
  facts.expansion = { expanded, bodies };

  // A later streaming row arrives thinking-only, then gains its answer: the
  // same thinking+answer dual-row transition on a second message id.
  appendMessage(
    message("live-1", "assistant", "", {
      thinking: "Live reasoning trace: reading the next module.",
      parentToolCallId: CALL,
      agentName: "explorer",
      status: "streaming",
    }),
  );
  await frames();
  updateMessage("live-1", { content: "Live answer: the next module is sound.", status: "streaming" });
  await frames();
  updateMessage("live-1", { status: "complete" });
  appendMessage(
    message("live-2", "tool", "", {
      toolName: "Read",
      toolCallId: "call-read-1",
      toolStatus: "success",
      parentToolCallId: CALL,
      agentName: "explorer",
      toolArgs: { path: "src/auth/session.ts" },
      toolResult: { details: { content: "export const x = 1;" } },
    }),
  );
  appendMessage(
    message("live-3", "assistant", "Tail answer: rotation confirmed.", {
      parentToolCallId: CALL,
      agentName: "explorer",
    }),
  );
  await frames();
  const stillExpanded =
    thinkingRows()[0]?.querySelector(".tool-row-header")?.getAttribute("aria-expanded") ===
    "true";
  const stillBody = (thinkingRows()[0]?.querySelectorAll(".tool-row-body").length ?? 0) === 1;
  failures.push(
    ...failuresOf([
      [thinkingRows().length === 2, `history keeps one thinking row per message (${thinkingRows().length})`],
      [previews().length === 1, `only the collapsed row keeps a preview (${previews().length})`],
      [stillExpanded && stillBody, "the historical expansion survives later updates"],
      [answerFor("live-3").length === 1, "later tail content is intact"],
      [
        (answerFor("hist-1")[0]?.textContent ?? "").includes("Historical answer"),
        "the historical answer keeps its text",
      ],
    ]),
  );
  facts.streaming = {
    thinkingRows: thinkingRows().length,
    previews: previews().map((node) => node.textContent?.slice(0, 60)),
    stillExpanded,
    stillBody,
  };

  // A turn reorder moves the later message ahead of the historical one. Every
  // row must follow its own message exactly once, with texts and the
  // historical expansion intact.
  flushSync(() => {
    useAppStore.setState((state) => {
      const live = state.messages.find((row) => row.id === "live-1");
      const rest = state.messages.filter((row) => row.id !== "live-1");
      return { messages: live ? [...rest.slice(0, 1), live, ...rest.slice(1)] : rest };
    });
  });
  await frames();
  const thinkingTexts = thinkingRows().map((row) => row.textContent ?? "");
  const histThinking = thinkingRows().find((row) =>
    (row.textContent ?? "").includes("Historical reasoning"),
  );
  const histExpanded =
    histThinking?.querySelector(".tool-row-header")?.getAttribute("aria-expanded") === "true";
  const histBody = (histThinking?.querySelectorAll(".tool-row-body").length ?? 0) === 1;
  const answerOrder = [...document.querySelectorAll(".message-row.assistant")].map((node) =>
    node.getAttribute("data-message-id"),
  );
  failures.push(
    ...failuresOf([
      [thinkingRows().length === 2, `reorder keeps one thinking row per message (${thinkingRows().length})`],
      [
        thinkingTexts.filter((text) => text.includes("Historical reasoning")).length === 1 &&
          thinkingTexts.filter((text) => text.includes("Live reasoning")).length === 1,
        "reorder keeps each thinking text on its own row",
      ],
      [histExpanded && histBody, "reorder keeps the historical expansion on the historical row"],
      [answerOrder.join(",") === "live-1,hist-1,live-3", `reorder moves answers with their messages (${answerOrder.join(",")})`],
    ]),
  );
  facts.reorder = {
    thinkingRows: thinkingRows().length,
    thinkingTexts: thinkingTexts.map((text) => text.slice(0, 52)),
    histExpanded,
    answerOrder,
  };

  return { ok: failures.length === 0, failures, facts };
};
