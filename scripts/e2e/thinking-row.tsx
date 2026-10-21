import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useState, type ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { AppSettings, UiMessage } from "@pi-desktop/shared";
import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { ThinkingRow } from "../../apps/desktop/src/features/chat/transcript/shared";
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
