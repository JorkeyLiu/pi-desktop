import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useState, type ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { AppSettings, HostedSearchRound, UiMessage } from "@pi-desktop/shared";
import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { ThinkingRow } from "../../apps/desktop/src/features/chat/transcript/shared";
import { ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import { HostedSearchRow } from "../../apps/desktop/src/features/chat/transcript/HostedSearchRow";
import { SubagentTaskCard } from "../../apps/desktop/src/features/chat/transcript/SubagentTaskCard";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { TranscriptDisclosureProvider } from "../../apps/desktop/src/features/chat/transcript/disclosure";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

declare global {
  var thinkingRowProbe: () => Promise<unknown>;
  /** Collapse the wide row so the captured frame shows both widths at rest. */
  var thinkingRowCollapseWide: (() => void) | undefined;
}

/*
 * The collapsed reasoning row in a real Chromium renderer with the
 * application's own built stylesheet: the production transcript turn, its
 * process disclosure and the real thinking row inside it. The probe only drives
 * and measures what the app renders — the opening the model wrote as the one
 * line beside the localized label, the body face and spacing it uses, and what
 * happens to that line when the row opens.
 */

const createdAt = "2026-10-21T00:00:00.000Z";

function message(
  id: string,
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage {
  return { id, role: "assistant", content, createdAt, ...extra };
}

const HEADING = "Reading the transcript";
const OPENING = "The opening paragraph explains why the row previews it.";
const LATER = "The last lines of the reasoning arrive much later.";
const HEADED = `## ${HEADING}\n\n${OPENING}\n\n${LATER}`;
const LONG_OPENING =
  "The opening paragraph is long enough that a narrow transcript column has to ellipsize it instead of letting it wrap onto a second line.";

/** The completed turn a reader sees: reasoning, a tool, then the answer. */
function headedTurn(thinking: string) {
  return buildTranscriptEntries([
    message("user", "Why does the row preview the opening?", { role: "user" }),
    message("thinking", "", { thinking, status: "complete" }),
    message("tool", "", {
      role: "tool",
      toolName: "Bash",
      toolCallId: "call-1",
      toolStatus: "success",
      toolArgs: {
        command: "pnpm test --filter desktop",
        description: "Run the tests",
      },
      toolResult: { details: { exitCode: 0, stdout: "ok", stderr: "" } },
    }),
    message("answer", "Because the opening is the model's own text.", {
      status: "complete",
    }),
  ]).entries.find((entry) => entry.kind === "assistant-turn")!;
}

let liveHeadingSetter: ((thinking: string) => void) | null = null;

/** A row whose reasoning grows exactly as a stream would grow it. */
function LiveHeading({ initial }: { initial: string }) {
  const [thinking, setThinking] = useState(initial);
  liveHeadingSetter = setThinking;
  return (
    <ThinkingRow
      message={message("live", "", { thinking, status: "streaming" })}
      streaming
    />
  );
}

type Probe = {
  failures: string[];
  observed: Record<string, unknown>;
};

const settle = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

const prefersMono = (fontFamily: string) =>
  /mono|menlo|consola|liberation/i.test(fontFamily);

globalThis.thinkingRowProbe = async () => {
  const probe: Probe = { failures: [], observed: {} };
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (ok) probe.observed[name] = detail ?? true;
    else probe.failures.push(`${name}: ${JSON.stringify(detail ?? null)}`);
  };

  const renderErrors: unknown[] = [];
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });

  const previousSettings = useAppStore.getState().settings;
  const settings: AppSettings = {
    defaultMode: "agent",
    theme: "light",
    enterToSend: true,
    onboardingDismissed: true,
    thinkingDisplayMode: "detailed",
  };
  flushSync(() => useAppStore.setState({ settings }));

  const stage = document.createElement("div");
  stage.id = "stage";
  stage.style.cssText =
    "display:flex;gap:16px;align-items:flex-start;padding:12px";
  const narrow = document.createElement("div");
  narrow.style.width = "320px";
  const wide = document.createElement("div");
  wide.style.width = "860px";
  stage.append(narrow, wide);
  document.body.append(stage);

  const mount = (container: HTMLElement, node: ReactNode) => {
    const host = document.createElement("div");
    container.append(host);
    const root = createRoot(host, {
      onUncaughtError: (error: unknown) => renderErrors.push(error),
    });
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <TranscriptDisclosureProvider>{node}</TranscriptDisclosureProvider>
        </I18nextProvider>,
      ),
    );
    return host;
  };

  const processHeaderOf = (host: HTMLElement) =>
    host.querySelector<HTMLElement>(".turn-process > .tool-activity-header");
  const thinkingHeaderOf = (host: HTMLElement) =>
    host.querySelector<HTMLElement>(".tool-row.thinking > .tool-row-header");
  const previewOf = (host: HTMLElement) =>
    host.querySelector<HTMLElement>(".tool-row.thinking .thinking-preview");
  const oneLine = (element: HTMLElement) => {
    const style = getComputedStyle(element);
    const line =
      parseFloat(style.lineHeight) || element.getBoundingClientRect().height;
    return {
      style,
      line,
      height: element.getBoundingClientRect().height,
      single: element.getBoundingClientRect().height <= line + 2,
    };
  };

  /** The process a reader must open before any row inside it is reachable. */
  const openProcess = async (host: HTMLElement) => {
    const header = processHeaderOf(host);
    if (!header) throw new Error("the turn drew no process header");
    if (header.getAttribute("aria-expanded") !== "true") header.click();
    await settle();
  };

  try {
    const narrowHost = mount(
      narrow,
      <AssistantTurn entry={headedTurn(HEADED) as never} isActive={false} />,
    );
    const wideHost = mount(
      wide,
      <AssistantTurn entry={headedTurn(HEADED) as never} isActive={false} />,
    );
    const longHost = mount(
      narrow,
      <ThinkingRow
        message={message("long", "", { thinking: LONG_OPENING, status: "complete" })}
        streaming={false}
      />,
    );
    await settle();
    await openProcess(narrowHost);
    await openProcess(wideHost);

    // ── 1. The collapsed row previews the heading the model wrote ──
    const label = narrowHost.querySelector<HTMLElement>(
      ".tool-row.thinking .tool-row-name",
    )!;
    const toolSummary = narrowHost.querySelector<HTMLElement>(
      ".tool-row:not(.thinking) .tool-row-summary",
    );
    const muted = toolSummary ? getComputedStyle(toolSummary).color : "";
    const labelColor = getComputedStyle(label).color;
    for (const [name, host] of [
      ["narrow", narrowHost],
      ["wide", wideHost],
    ] as const) {
      check(`${name} row renders its preview`, Boolean(previewOf(host)));
      const header = thinkingHeaderOf(host);
      const preview = previewOf(host);
      if (!header || !preview) continue;
      check(
        `${name} preview is the heading`,
        preview.textContent === HEADING,
        preview.textContent,
      );
      check(
        `${name} header carries no Markdown markers`,
        !/[#*`[\]]/.test(header.textContent ?? ""),
        header.textContent,
      );
      check(
        `${name} preview does not repeat the body`,
        !(preview.textContent ?? "").includes(OPENING),
        preview.textContent,
      );
      const metrics = oneLine(preview);
      check(
        `${name} preview is a single ellipsized line`,
        metrics.style.whiteSpace === "nowrap" &&
          metrics.style.textOverflow === "ellipsis" &&
          metrics.single,
        {
          whiteSpace: metrics.style.whiteSpace,
          textOverflow: metrics.style.textOverflow,
          height: metrics.height,
          lineHeight: metrics.line,
        },
      );
      check(
        `${name} heading preview keeps the label's secondary colour`,
        metrics.style.color === labelColor,
        { preview: metrics.style.color, label: labelColor },
      );
    }

    // ── 2. The preview sits where a tool row puts its own summary ──
    const gapBetween = (left: HTMLElement, right: HTMLElement) => {
      const gap =
        right.getBoundingClientRect().left - left.getBoundingClientRect().right;
      return Math.round(gap * 10) / 10;
    };
    const toolLabel = narrowHost.querySelector<HTMLElement>(
      ".tool-row:not(.thinking) .tool-row-name",
    );
    check("the tool row beside it draws its own label", Boolean(toolLabel));
    const thinkingGap = gapBetween(label, previewOf(narrowHost)!);
    const toolGap =
      toolLabel && toolSummary ? gapBetween(toolLabel, toolSummary) : null;
    check(
      "the preview sits as far from its label as a tool summary does",
      toolGap !== null && toolGap > 0 && Math.abs(thinkingGap - toolGap) <= 0.5,
      { thinkingGap, toolGap },
    );

    // ── 3. One line at both widths: the long opening truncates when narrow ──
    const longPreview = previewOf(longHost)!;
    const longMetrics = oneLine(longPreview);
    check(
      "the narrow row ellipsizes a long opening instead of wrapping it",
      longPreview.scrollWidth > longPreview.clientWidth + 1 && longMetrics.single,
      {
        scrollWidth: longPreview.scrollWidth,
        clientWidth: longPreview.clientWidth,
        height: longMetrics.height,
        lineHeight: longMetrics.line,
      },
    );
    check(
      "the body preview is muted beside the label",
      muted !== "" && getComputedStyle(longPreview).color === muted,
      { preview: getComputedStyle(longPreview).color, muted },
    );
    const widePreview = previewOf(wideHost)!;
    check(
      "the wide row fits its whole opening line",
      widePreview.scrollWidth <= widePreview.clientWidth + 1,
      {
        scrollWidth: widePreview.scrollWidth,
        clientWidth: widePreview.clientWidth,
      },
    );

    // ── 4. A tool row beside it keeps its monospace summary ──
    check("the tool row renders its own summary", Boolean(toolSummary));
    check(
      "the tool summary keeps the monospace face",
      Boolean(toolSummary) && prefersMono(getComputedStyle(toolSummary!).fontFamily),
      toolSummary ? getComputedStyle(toolSummary).fontFamily : null,
    );
    check(
      "the tool summary is not the thinking preview",
      Boolean(toolSummary) && !toolSummary!.classList.contains("thinking-preview"),
      toolSummary?.className,
    );

    // ── 5. Opening the row drops the line and keeps the full Markdown body ──
    const wideHeader = thinkingHeaderOf(wideHost)!;
    const controlsTarget = wideHeader.getAttribute("aria-controls");
    wideHeader.click();
    await settle();
    check(
      "opening the row reports an expanded disclosure",
      wideHeader.getAttribute("aria-expanded") === "true",
      wideHeader.getAttribute("aria-expanded"),
    );
    check("an open row draws no preview", previewOf(wideHost) === null);
    const body = controlsTarget
      ? wideHost.querySelector<HTMLElement>(`.tool-row-body#${CSS.escape(controlsTarget)}`)
      : null;
    check("the header still controls its own body", Boolean(body));
    const prose = wideHost.querySelector<HTMLElement>(".thinking-prose");
    check("the open row renders its Markdown body", Boolean(prose));
    check(
      "the body keeps the heading and the opening paragraph",
      Boolean(prose?.querySelector("h2")) && (prose?.textContent ?? "").includes(OPENING),
      prose?.textContent?.slice(0, 80),
    );
    check(
      "the body keeps the later reasoning the preview never showed",
      (prose?.textContent ?? "").includes(LATER),
      prose?.textContent?.slice(-80),
    );
    thinkingHeaderOf(narrowHost)!.click();
    await settle();
    check(
      "opening the narrow row drops its line too",
      previewOf(narrowHost) === null,
      previewOf(narrowHost)?.textContent,
    );
    thinkingHeaderOf(narrowHost)!.click();
    await settle();
    await settle();
    check(
      "collapsing the row brings its preview back",
      previewOf(narrowHost)?.textContent === HEADING,
      previewOf(narrowHost)?.textContent,
    );

    // ── 6. Streaming keeps the opening; a corrected opening replaces it ──
    const liveHost = mount(narrow, <LiveHeading initial={HEADED} />);
    await settle();
    check(
      "the live row previews its opening",
      previewOf(liveHost)?.textContent === HEADING,
      previewOf(liveHost)?.textContent,
    );
    flushSync(() => liveHeadingSetter?.(`${HEADED}\n\nAn even later thought.`));
    await settle();
    check(
      "later reasoning never moves the preview",
      previewOf(liveHost)?.textContent === HEADING,
      previewOf(liveHost)?.textContent,
    );
    flushSync(() => liveHeadingSetter?.(`## ${HEADING} revised\n\n${OPENING}`));
    await settle();
    check(
      "a corrected opening updates the preview",
      previewOf(liveHost)?.textContent === `${HEADING} revised`,
      previewOf(liveHost)?.textContent,
    );

    // ── 7. Reasoning with nothing to show draws the label alone ──
    const emptyHost = mount(
      narrow,
      <ThinkingRow
        message={message("empty", "", { thinking: "" })}
        streaming={false}
      />,
    );
    await settle();
    check("empty reasoning draws no preview", previewOf(emptyHost) === null);
    check(
      "empty reasoning still names itself",
      emptyHost.querySelector(".tool-row.thinking .tool-row-name")?.textContent ===
        "Thinking",
      emptyHost.textContent,
    );

    // ── 8. Compact keeps its active indicator and draws no line ──
    flushSync(() =>
      useAppStore.setState({
        settings: { ...settings, thinkingDisplayMode: "compact" },
      }),
    );
    const compactHost = mount(
      narrow,
      <ThinkingRow
        message={message("compact", "", { thinking: HEADED, status: "streaming" })}
        streaming
      />,
    );
    await settle();
    check("compact mode draws no preview", previewOf(compactHost) === null);
    check(
      "compact mode keeps the active thinking indicator",
      compactHost.querySelector(".tool-row.thinking.thinking-compact .tool-row-name")
        ?.textContent === "Thinking" &&
        compactHost.querySelector(".tool-row-body") === null,
      compactHost.textContent,
    );
    flushSync(() =>
      useAppStore.setState({ settings: previousSettings ?? settings }),
    );

    // ── 9. The explicit thinking phase decides the dot, not later activity ──
    // A thought the runtime already completed stays still with nothing after
    // it: the thinking_end alone stops the indicator while the message still
    // streams. A newer thought with a streaming phase breathes again beside a
    // running tool. Same production projection and production turn as above.
    const settledTurnEntry = buildTranscriptEntries([
      message("live-user", "Keep going.", { role: "user" }),
      message("thought-1", "", {
        thinking: "First thought takes shape.",
        status: "streaming",
        thinkingStatus: "complete",
      }),
    ]).entries.find((entry) => entry.kind === "assistant-turn");
    if (!settledTurnEntry) throw new Error("the settled turn did not build");
    const settledHost = mount(narrow, <AssistantTurn entry={settledTurnEntry as never} isActive />);
    await settle();
    const settledThinking = [...settledHost.querySelectorAll<HTMLElement>(".tool-row.thinking")];
    check("the completed thought stays painted", settledThinking.length === 1, settledThinking.length);
    check(
      "a thinking_end with no later activity still stops the dot",
      settledHost.querySelector(".tool-row.thinking .tool-row-name.running") === null,
      settledHost.textContent?.slice(0, 120),
    );
    const liveTurnEntry = buildTranscriptEntries([
      message("live-user", "Keep going.", { role: "user" }),
      message("thought-1", "", {
        thinking: "First thought takes shape.",
        status: "streaming",
        thinkingStatus: "complete",
      }),
      message("live-call", "", {
        role: "tool",
        toolName: "Bash",
        toolCallId: "live-call",
        toolStatus: "running",
        status: "streaming",
        toolArgs: { command: "sleep 30" },
      }),
      message("thought-2", "", {
        thinking: "Second thought carries on.",
        status: "streaming",
        thinkingStatus: "streaming",
      }),
    ]).entries.find((entry) => entry.kind === "assistant-turn");
    if (!liveTurnEntry) throw new Error("the live turn did not build");
    const turnHost = mount(narrow, <AssistantTurn entry={liveTurnEntry as never} isActive />);
    await settle();
    const turnHeader = turnHost.querySelector<HTMLElement>(".turn-process > .tool-activity-header");
    if (turnHeader && turnHeader.getAttribute("aria-expanded") !== "true") {
      turnHeader.click();
      await settle();
    }
    const turnThinking = [...turnHost.querySelectorAll<HTMLElement>(".tool-row.thinking")];
    check("the active turn keeps both thoughts painted", turnThinking.length === 2, turnThinking.length);
    const runningNames = [...turnHost.querySelectorAll<HTMLElement>(".tool-row.thinking .tool-row-name.running")];
    check("the explicit complete beats the streaming status", runningNames.length === 1, runningNames.length);
    const openThinking = turnHost.querySelector<HTMLElement>(".tool-row.thinking.open");
    check(
      "a newer streaming phase breathes again",
      Boolean(openThinking && runningNames.length === 1 && openThinking.contains(runningNames[0])),
      openThinking?.outerHTML?.slice(0, 200),
    );
    const stillThought = turnThinking.find((row) => row !== openThinking);
    check(
      "the completed thought goes still beside the running tool",
      Boolean(stillThought) &&
        stillThought!.querySelector(".tool-row-name.running") === null &&
        stillThought!.querySelector(".thinking-preview")?.textContent === "First thought takes shape.",
      stillThought?.textContent?.slice(0, 120),
    );
    flushSync(() =>
      useAppStore.setState({
        settings: { ...settings, thinkingDisplayMode: "compact" },
      }),
    );
    await settle();
    const compactThinking = [...turnHost.querySelectorAll<HTMLElement>(".tool-row.thinking.thinking-compact")];
    check("compact keeps only the streaming phase breathing", compactThinking.length === 1, compactThinking.length);
    flushSync(() =>
      useAppStore.setState({ settings: previousSettings ?? settings }),
    );
    await settle();
     // ── 10. Left activity icons carry muted category tints ──
     // Production rows only: one completed row per built-in ToolAction value
     // (all eighteen), the delegation lifecycle rows, a hosted search, the
     // thinking rows above, and an actual Task card. Four groups tint by
     // category (read/list blue, search-family teal, write/edit/image gold,
     // run/schedule sage); thinking, skill, context, todo, mode, fork,
     // delegate, and the generic `use` action stay on the neutral muted ink.
     // Every check compares rendered ink — never source text — in the dark
     // theme first, then again under the light plate.
     const tintTool = (
       id: string,
       toolName: string,
       toolArgs: Record<string, unknown>,
       resultDetails: Record<string, unknown> = {},
     ): UiMessage =>
       message(id, "", {
         role: "tool",
         toolName,
         toolCallId: `${id}-call`,
         toolStatus: "success",
         toolArgs,
         toolResult: { details: resultDetails },
       });
     const tintHost = mount(
       wide,
       <>
         <ToolRow message={tintTool("tint-read", "Read", { path: "src/index.ts" })} />
         <ToolRow message={tintTool("tint-list", "Glob", { pattern: "src/**/*.ts" })} />
         <ToolRow message={tintTool("tint-search", "Grep", { pattern: "tool-row-icon" })} />
         <ToolRow message={tintTool("tint-toolsearch", "ToolSearch", { query: "icon tint" })} />
         <ToolRow message={tintTool("tint-fetch", "WebFetch", { url: "https://example.com" })} />
         <ToolRow message={tintTool("tint-browser", "BrowserPreview", { path: "preview.html" })} />
         <ToolRow message={tintTool("tint-write", "Write", { path: "src/notes.ts" })} />
         <ToolRow message={tintTool("tint-edit", "Edit", { path: "src/notes.ts" })} />
         <ToolRow
           message={tintTool("tint-image", "GenerateImages", { prompt: "A muted icon study" })}
         />
         <ToolRow
           message={tintTool("tint-run", "Bash", { command: "pnpm test", description: "Run tests" })}
         />
         <ToolRow
           message={tintTool("tint-schedule", "ScheduledTaskCreate", { title: "Nightly tests" })}
         />
         <ToolRow message={tintTool("tint-skill", "Skill", { name: "code-review" })} />
         <ToolRow message={tintTool("tint-context", "NewContext", {})} />
         <ToolRow message={tintTool("tint-mode", "EnterPlanMode", {})} />
         <ToolRow
           message={tintTool(
             "tint-todo",
             "TodoWrite",
             { todos: [{ content: "Tint the icons", status: "completed" }] },
             {
               text: "Checklist updated: 1/1 completed",
               summary: { completed: 1, total: 1, inProgress: 0, cancelled: 0 },
             },
           )}
         />
         <ToolRow
           message={tintTool("tint-fork", "ForkAgent", {
             description: "Explore",
             prompt: "Explore.",
           })}
         />
         <ToolRow message={tintTool("tint-use", "Frobnicator", { widget: "sprocket" })} />
         <ToolRow
           message={tintTool("tint-delegate", "Task", {
             description: "Summarize the thread",
             prompt: "Summarize.",
           })}
         />
         <ToolRow message={tintTool("tint-wait", "TaskWait", {})} />
         <ToolRow message={tintTool("tint-tasklist", "TaskList", {})} />
         <ToolRow message={tintTool("tint-stop", "TaskStop", {})} />
         <SubagentTaskCard
           message={tintTool("tint-card", "Task", {
             description: "Summarize the thread",
             prompt: "Summarize.",
           })}
         />
         <HostedSearchRow
           messageId="tint-hosted"
           round={{
             id: "tint-search-round",
             status: "completed",
             kind: "search",
             query: "icon tint contrast",
             sources: [{ url: "https://example.com/tints", title: "Tint notes" }],
           } satisfies HostedSearchRound}
           streaming={false}
         />
       </>,
     );
     await settle();
     const tokenInk = (token: string) => {
       const probe = document.createElement("span");
       probe.style.cssText = "position:absolute;left:-9999px;top:0;";
       probe.style.color = `var(${token})`;
       document.body.append(probe);
       const ink = getComputedStyle(probe).color;
       probe.remove();
       return ink;
     };
     const rowIconInk = (scope: ParentNode, rowSelector: string) => {
       const icon = scope.querySelector(`${rowSelector} .tool-row-icon`);
       return icon ? getComputedStyle(icon as HTMLElement).color : null;
     };
     const tintIconInk = (id: string) => rowIconInk(tintHost, `[data-message-id="${id}"]`);
     const mutedInk = tokenInk("--ds-text-muted");
     const darkReadInk = tokenInk("--ds-activity-read");
     const tintExpect: Record<string, string> = {
       "tint-read": "--ds-activity-read",
       "tint-list": "--ds-activity-read",
       "tint-search": "--ds-activity-search",
       "tint-toolsearch": "--ds-activity-search",
       "tint-fetch": "--ds-activity-search",
       "tint-browser": "--ds-activity-search",
       "tint-write": "--ds-activity-edit",
       "tint-edit": "--ds-activity-edit",
       "tint-image": "--ds-activity-edit",
       "tint-run": "--ds-activity-run",
       "tint-schedule": "--ds-activity-run",
     };
     const neutralIds = [
       "tint-skill",
       "tint-context",
       "tint-todo",
       "tint-mode",
       "tint-fork",
       "tint-delegate",
       "tint-wait",
       "tint-tasklist",
       "tint-stop",
       "tint-use",
     ];
     for (const [id, token] of Object.entries(tintExpect)) {
       const ink = tintIconInk(id);
       check(`the ${id} icon wears its category tint`, ink === tokenInk(token), {
         ink,
         token,
       });
       check(`the ${id} icon leaves the neutral ink`, ink !== null && ink !== mutedInk, {
         ink,
         mutedInk,
       });
     }
     for (const id of neutralIds) {
       check(`the ${id} icon stays on the neutral ink`, tintIconInk(id) === mutedInk, {
         ink: tintIconInk(id),
         mutedInk,
       });
     }
     // TaskWait rides the default HostToolRow delegate action: the neutral ink
     // comes from the removed is-subagent tint, while the lifecycle hook and
     // the bot glyph stay untouched, and the right status keeps its own style.
     const waitIcon = tintHost.querySelector('[data-message-id="tint-wait"] .tool-row-icon');
     check(
       "the TaskWait row keeps its delegate lifecycle hook",
       waitIcon !== null && waitIcon.classList.contains("is-subagent"),
       waitIcon?.outerHTML?.slice(0, 160),
     );
     const waitGlyph = tintHost.querySelector('[data-message-id="tint-wait"] [data-icon="delegate"]');
     check(
       "the TaskWait row keeps the neutral bot glyph",
       waitGlyph !== null &&
         waitGlyph.tagName.toLowerCase() === "svg" &&
         (waitGlyph.getAttribute("class") ?? "").includes("lucide-bot"),
       waitGlyph instanceof Element ? waitGlyph.outerHTML.slice(0, 160) : null,
     );
     const hostedInk = rowIconInk(tintHost, ".tool-row.hosted-search");
     check(
       "provider-hosted search wears the discovery tint",
       hostedInk === tokenInk("--ds-activity-search"),
       { hostedInk },
     );
     for (const action of ["read", "skill", "schedule", "todo", "delegate", "use"]) {
       check(`the ${action} action hook reaches the rendered glyph`, tintHost.querySelector(`[data-icon="${action}"]`) !== null);
     }
     const skillGlyph = tintHost.querySelector('[data-icon="skill"]');
     check(
       "the skill glyph itself stays on the neutral ink",
       skillGlyph !== null &&
         getComputedStyle(skillGlyph as HTMLElement).color === mutedInk,
       skillGlyph ? getComputedStyle(skillGlyph as HTMLElement).color : null,
     );
     const avatarInk = (scope: ParentNode) => {
       const avatar = scope.querySelector('[data-message-id="tint-card"] .subagent-task-avatar');
       return avatar ? getComputedStyle(avatar as HTMLElement).color : null;
     };
     check("the Task card avatar stays on the neutral ink", avatarInk(tintHost) === mutedInk, {
       ink: avatarInk(tintHost),
       mutedInk,
     });
     const cardOutcome = tintHost.querySelector('[data-message-id="tint-card"]')?.getAttribute("data-outcome");
     check("the Task card settles completed", cardOutcome === "completed", { cardOutcome });
     const badgeWash = (scope: ParentNode) => {
       const badge = scope.querySelector('[data-message-id="tint-card"] .subagent-task-status-icon');
       return badge ? getComputedStyle(badge as HTMLElement).backgroundColor : null;
     };
     check(
       "the card status badge keeps its outcome wash",
       badgeWash(tintHost) === tokenInk("--ds-success"),
       { wash: badgeWash(tintHost) },
     );
     const openThinkingIcon = wideHost.querySelector(".tool-row.thinking.open .tool-row-icon");
     check("the open thinking icon stays on the neutral ink", openThinkingIcon !== null, null);
     if (openThinkingIcon) {
       check(
         "an expanded thinking row stays neutral",
         getComputedStyle(openThinkingIcon as HTMLElement).color === mutedInk,
         getComputedStyle(openThinkingIcon as HTMLElement).color,
       );
     }
     // Compact mode was restored to the previous (detailed) preference above, so
     // re-enter it to measure the compact thinking icon, then restore again.
     flushSync(() =>
       useAppStore.setState({
         settings: { ...settings, thinkingDisplayMode: "compact" },
       }),
     );
     await settle();
     const compactIcon = compactHost.querySelector(
       ".tool-row.thinking.thinking-compact .tool-row-icon",
     );
     check(
       "compact thinking stays on the neutral ink",
       compactIcon !== null &&
         getComputedStyle(compactIcon as HTMLElement).color === mutedInk,
       compactIcon ? getComputedStyle(compactIcon as HTMLElement).color : null,
     );
     const openThinkingGlyph = openThinkingIcon?.querySelector("svg");
     check(
       "the open thinking cue renders the brain glyph",
       openThinkingGlyph !== null &&
         openThinkingGlyph !== undefined &&
         (openThinkingGlyph.getAttribute("class") ?? "").includes("lucide-brain"),
       openThinkingGlyph?.outerHTML?.slice(0, 160),
     );
     const compactGlyph = compactIcon?.querySelector("svg");
     check(
       "the compact thinking cue renders the brain glyph",
       compactGlyph !== null &&
         compactGlyph !== undefined &&
         (compactGlyph.getAttribute("class") ?? "").includes("lucide-brain"),
       compactGlyph?.outerHTML?.slice(0, 160),
     );
     flushSync(() =>
       useAppStore.setState({ settings: previousSettings ?? settings }),
     );
     await settle();
     const liveRunIcon = turnHost.querySelector(
       '[data-message-id="live-call"] .tool-row-icon',
     );
     check(
       "a running tool row keeps its category tint",
       liveRunIcon !== null &&
         getComputedStyle(liveRunIcon as HTMLElement).color === tokenInk("--ds-activity-run"),
       liveRunIcon ? getComputedStyle(liveRunIcon as HTMLElement).color : null,
     );
     const liveRunGlyph = turnHost.querySelector('[data-message-id="live-call"] [data-icon="run"]');
     check(
       "the run glyph renders the boxed terminal",
       liveRunGlyph !== null &&
         liveRunGlyph.tagName.toLowerCase() === "svg" &&
         liveRunGlyph.querySelector("rect") !== null,
       liveRunGlyph ? liveRunGlyph.outerHTML.slice(0, 200) : null,
     );
     const readName = tintHost.querySelector('[data-message-id="tint-read"] .tool-row-name');
     check("the tint stops at the icon: the name keeps its ink", readName !== null, null);
     if (readName) {
       check(
         "the row name is not icon-tinted",
         getComputedStyle(readName as HTMLElement).color !== tintIconInk("tint-read"),
         {
           name: getComputedStyle(readName as HTMLElement).color,
           icon: tintIconInk("tint-read"),
         },
       );
     }
     const readSummary = tintHost.querySelector('[data-message-id="tint-read"] .tool-row-summary');
     check("the tinted row renders its summary", readSummary !== null, null);
     if (readSummary) {
       check(
         "the row summary is not icon-tinted",
         getComputedStyle(readSummary as HTMLElement).color !== tintIconInk("tint-read"),
         {
           summary: getComputedStyle(readSummary as HTMLElement).color,
           icon: tintIconInk("tint-read"),
         },
       );
     }
     document.documentElement.setAttribute("data-theme", "light");
     await settle();
     const lightRead = tokenInk("--ds-activity-read");
     check("the read tint adapts to the light plate", lightRead !== darkReadInk, {
       lightRead,
       darkReadInk,
     });
     const lightMuted = tokenInk("--ds-text-muted");
     for (const [id, token] of Object.entries(tintExpect)) {
       const ink = tintIconInk(id);
       check(`the light ${id} icon wears its category tint`, ink === tokenInk(token), {
         ink,
         token,
       });
       check(`the light ${id} icon leaves the neutral ink`, ink !== null && ink !== lightMuted, {
         ink,
         lightMuted,
       });
     }
     for (const id of neutralIds) {
       check(`the light ${id} icon stays neutral`, tintIconInk(id) === lightMuted, {
         ink: tintIconInk(id),
         lightMuted,
       });
     }
     check(
       "light hosted search wears the discovery tint",
       rowIconInk(tintHost, ".tool-row.hosted-search") === tokenInk("--ds-activity-search"),
       { hosted: rowIconInk(tintHost, ".tool-row.hosted-search") },
     );
     check(
       "light thinking stays on the neutral ink",
       rowIconInk(wideHost, ".tool-row.thinking.open") === lightMuted,
       { lightMuted },
     );
     const lightThinkingGlyph = wideHost.querySelector(".tool-row.thinking.open .tool-row-icon svg");
     check(
       "light thinking keeps the brain cue",
       lightThinkingGlyph !== null && (lightThinkingGlyph.getAttribute("class") ?? "").includes("lucide-brain"),
       lightThinkingGlyph?.outerHTML?.slice(0, 160),
     );
     check("light card avatar stays on the neutral ink", avatarInk(tintHost) === lightMuted, {
       ink: avatarInk(tintHost),
       lightMuted,
     });
     check(
       "light badge keeps its outcome wash",
       badgeWash(tintHost) === tokenInk("--ds-success"),
       { wash: badgeWash(tintHost) },
     );
     check(
       "the light run glyph keeps its boxed terminal",
       tintHost.querySelector('[data-message-id="tint-run"] [data-icon="run"] rect') !== null,
       null,
     );
     document.documentElement.removeAttribute("data-theme");
     await settle();
     check("leaving light restores the dark read tint", tokenInk("--ds-activity-read") === darkReadInk, {
       restored: tokenInk("--ds-activity-read"),
       darkReadInk,
     });
     check(
       "the rendered components raised no errors",
       renderErrors.length === 0,
       renderErrors,
     );
  } finally {
    globalThis.thinkingRowCollapseWide = () => {
      const header = thinkingHeaderOf(wide);
      if (header?.getAttribute("aria-expanded") === "true") header.click();
    };
  }

  return probe;
};
