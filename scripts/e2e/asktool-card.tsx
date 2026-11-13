/**
 * Real React/Chromium regression for the compact AskTool card.
 *
 * The compact layout moved the skip / next / submit buttons from a bottom
 * action row into the card header, which changed DOM order and therefore the
 * keyboard Tab sequence. This probe mounts the production `AskToolCard`
 * against the real store slice with a stubbed `api.resolveAskTool` and walks
 * the user-visible paths: the new header action order, select → next →
 * submit, skip → submit, decline-all, and a custom answer.
 *
 * Scenario: E2E-ASKTOOL-compact-card-interaction. It also pins the compact
 * question block: a multi-paragraph question body stays one stacked text
 * column rather than lining its blocks up in a row.
 *
 * The second half covers the transcript history row of a completed ask: the
 * collapsed row must name the tool in the session language, state the short
 * description the model wrote for the call, and state how many questions were
 * answered; one row without a description must state no hint at all. Clicking a
 * row must reveal every question, answer and skip. It runs in English and in
 * zh-CN, including a namespaced `functions.asktool` call, and measures the
 * rendered type of the answered and skipped entries.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en, zhCN } from "@pi-desktop/i18n";
import { MAX_ASK_TOOL_QUESTION_CHARS } from "../../packages/shared/src/types/agent";
import { AskToolCard } from "../../apps/desktop/src/components/AskToolCard";
import { ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import { TranscriptDisclosureProvider } from "../../apps/desktop/src/features/chat/transcript/disclosure";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const SESSION_ID = "asktool-card";

declare global {
  var asktoolCardProbe: () => Promise<unknown>;
}
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`AskTool card: ${label}`);
}

const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(`AskTool card never settled: ${label}`);
}

type FixtureQuestion = {
  question: string;
  options: Array<{ label: string; description: string }>;
};

function askRequest(requestId: string, questions: FixtureQuestion[]) {
  return {
    sessionId: SESSION_ID,
    requestId,
    toolCallId: `tool-${requestId}`,
    questions,
  };
}

const QUESTIONS: FixtureQuestion[] = [
  {
    question: "Which upgrade path?",
    options: [
      { label: "alpha", description: "First choice" },
      { label: "beta", description: "Second choice" },
    ],
  },
  {
    question: "Allow rollback?",
    options: [{ label: "gamma", description: "Third choice" }],
  },
];

// A question body with several markdown blocks must render as stacked
// paragraphs. The compact header row once made every block a flex item, so
// the blocks lined up side by side and every sentence wrapped inside a column.
const MULTI_BLOCK_QUESTION: FixtureQuestion = {
  question:
    "The old host 124.71.12.42 is unreachable and the new database is empty, so nothing has been restored yet.\n\nThe S3 bucket still holds every page file, so a rebuild can recover the HTML body plus its title.",
  options: [{ label: "delta", description: "Fourth choice" }],
};

const LONG_QUESTIONS: FixtureQuestion[] = [
  {
    question: `First long question\n\n${Array.from(
      { length: 24 },
      (_, index) => `First prompt paragraph ${index + 1} keeps enough text in the card to require its own scroll area.`,
    ).join("\n\n")}`,
    options: [{ label: "Continue", description: "Move to the next question" }],
  },
  {
    question: `Second long question\n\n${Array.from(
      { length: 24 },
      (_, index) => `Second prompt paragraph ${index + 1} keeps enough text in the card to require its own scroll area.`,
    ).join("\n\n")}`,
    options: [{ label: "Submit", description: "Finish the request" }],
  },
];

const MAX_LENGTH_QUESTION: FixtureQuestion = {
  question: "q".repeat(MAX_ASK_TOOL_QUESTION_CHARS),
  options: [{ label: "continue", description: "Proceed with the selected choice." }],
};

// A completed ask as the transcript persists it: the questions the model
// asked, their options, and one answer per question (`null` for a skip). The
// first question carries Markdown so the expanded card's rendering can be
// checked independently of the call's plain-text display summary.
const HISTORY_QUESTIONS = [
  { question: "Which **deployment** target?", options: ["Web", "Desktop"] },
  {
    question: "Which platforms should be supported?",
    options: ["macOS", "Windows", "Linux"],
    multiSelect: true,
  },
  { question: "Should beta updates be enabled?", options: ["Yes", "No"] },
];
// One answer per question, in the order they were asked: the second question
// was multi-select, and the third was skipped.
const HISTORY_ANSWERS: Array<string[] | null> = [
  ["Desktop"],
  ["macOS", "Linux"],
  null,
];
// The display-only summary the model wrote for the call. It is the collapsed
// row's hint in every locale, because it is the model's text, not a string the
// row derives from the first question.
const HISTORY_DESCRIPTION = "Choose the deployment target";

function askHistoryMessage(
  id: string,
  toolName: string,
  description: string | null = HISTORY_DESCRIPTION,
) {
  return {
    id,
    role: "tool" as const,
    content: "",
    createdAt: "2026-10-09T00:00:00.000Z",
    status: "complete" as const,
    toolName,
    toolCallId: `tool-${id}`,
    toolStatus: "success" as const,
    // The call's own display metadata: present in the ordinary row, absent in
    // the legacy row below that proves a missing summary states no hint.
    toolArgs: description
      ? { description, questions: HISTORY_QUESTIONS }
      : { questions: HISTORY_QUESTIONS },
    toolResult: {
      content: [
        {
          type: "text",
          text: HISTORY_QUESTIONS.map(
            (entry, index) =>
              `${entry.question}：${(HISTORY_ANSWERS[index] ?? []).join("、")}`,
          ).join("\n---\n"),
        },
      ],
      details: { questions: HISTORY_QUESTIONS, answers: HISTORY_ANSWERS },
    },
  };
}

export async function asktoolCardProbe() {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const initial = useAppStore.getState();
  const originalResolve = api.resolveAskTool;
  const resolutions: Array<{ requestId: string; answers: unknown }> = [];
  api.resolveAskTool = (async (resolution: {
    requestId: string;
    answers: unknown;
  }) => {
    resolutions.push(resolution);
    return { ok: true };
  }) as typeof api.resolveAskTool;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;overflow:auto;background:#141414";
  document.body.append(host);
  const errors: unknown[] = [];
  const root = createRoot(host, {
    onUncaughtError: (error) => errors.push(error),
  });
  // The history row is a second root so the card under test above it stays
  // mounted while the transcript row renders the same persisted result.
  let historyHost: HTMLElement | null = null;
  let historyRoot: ReturnType<typeof createRoot> | null = null;
  const element = <T extends HTMLElement = HTMLElement>(
    selector: string,
  ): T => {
    const found = host.querySelector<T>(selector);
    assert(found, `missing ${selector}`);
    return found as T;
  };
  const options = () =>
    [...host.querySelectorAll<HTMLButtonElement>(".asktool-option")].filter(
      (button) => !button.classList.contains("asktool-custom-option"),
    );
  const headerButtons = () => ({
    decline: element<HTMLButtonElement>(".asktool-decline"),
    skip: element<HTMLButtonElement>(
      ".asktool-card-header-actions .btn-ghost",
    ),
    primary: element<HTMLButtonElement>(
      ".asktool-card-header-actions .btn-primary",
    ),
  });
  // Fixture question bodies (not translated strings) identify the current
  // question independent of the active locale.
  const questionText = () =>
    element(".asktool-question").textContent ?? "";
  const mount = (requestId: string, questions: FixtureQuestion[] = QUESTIONS) => {
    const request = askRequest(requestId, questions);
    useAppStore.setState({
      pendingAsks: { [SESSION_ID]: [request] },
    });
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <AskToolCard key={requestId} request={request} />
        </I18nextProvider>,
      ),
    );
    return request;
  };
  try {
    mount("ask-dom");
    await until(
      () => options().length === QUESTIONS[0]!.options.length,
      "first question options mount",
    );

    // The header carries every confirmation affordance now that the bottom
    // action row is gone, so Tab reaches them in this exact DOM order.
    assert(
      host.querySelector(".asktool-card-actions") === null,
      "the legacy bottom action row is gone",
    );
    const tabbables = [...host.querySelectorAll("button")];
    const orderOf = (selector: string) =>
      tabbables.findIndex((node) => node.matches(selector));
    const declineAt = orderOf(".asktool-decline");
    const skipAt = orderOf(
      ".asktool-card-header-actions .btn-ghost",
    );
    const primaryAt = orderOf(
      ".asktool-card-header-actions .btn-primary",
    );
    const firstOptionAt = orderOf(
      ".asktool-options .asktool-option",
    );
    assert(
      declineAt !== -1 && skipAt !== -1 && primaryAt !== -1,
      "header actions mount",
    );
    assert(
      declineAt < skipAt && skipAt < primaryAt,
      `header Tab order is decline, skip, next (saw ${declineAt}, ${skipAt}, ${primaryAt})`,
    );
    assert(
      primaryAt < firstOptionAt,
      "header actions tab before the options",
    );

    // Flow A: select → next → answer → submit.
    flushSync(() => options()[0]!.click());
    assert(
      options()[0]!.classList.contains("selected"),
      "the clicked option is selected",
    );
    assert(
      questionText().includes("Which upgrade path?"),
      "the card starts on question 1",
    );
    flushSync(() => headerButtons().primary.click());
    await until(
      () => questionText().includes("Allow rollback?"),
      "next advances to question 2",
    );
    flushSync(() => options()[0]!.click());
    flushSync(() => headerButtons().primary.click());
    await until(() => resolutions.length === 1, "submit resolves the ask");
    assert(
      resolutions[0]!.requestId === "ask-dom",
      "the resolution carries the request id",
    );
    assert(
      JSON.stringify(resolutions[0]!.answers) ===
        JSON.stringify([["alpha"], ["gamma"]]),
      `select/next/submit answers survive, saw ${JSON.stringify(resolutions[0]!.answers)}`,
    );

    // Flow B: skip the first question, answer the second, submit.
    mount("ask-skip");
    await until(() => options().length > 0, "skip flow mounts");
    flushSync(() => headerButtons().skip.click());
    await until(
      () => questionText().includes("Allow rollback?"),
      "skip advances to question 2",
    );
    flushSync(() => options()[0]!.click());
    flushSync(() => headerButtons().primary.click());
    await until(() => resolutions.length === 2, "skip flow resolves");
    assert(
      JSON.stringify(resolutions[1]!.answers) ===
        JSON.stringify([null, ["gamma"]]),
      `skip records a null answer, saw ${JSON.stringify(resolutions[1]!.answers)}`,
    );

    // Flow C: decline everything from the header.
    mount("ask-decline");
    await until(() => options().length > 0, "decline flow mounts");
    flushSync(() => headerButtons().decline.click());
    await until(() => resolutions.length === 3, "decline resolves");
    assert(
      JSON.stringify(resolutions[2]!.answers) ===
        JSON.stringify([null, null]),
      `decline-all nulls every answer, saw ${JSON.stringify(resolutions[2]!.answers)}`,
    );

    // Flow D: a custom answer still flows through the header submit.
    mount("ask-custom");
    await until(() => options().length > 0, "custom flow mounts");
    flushSync(() =>
      element(".asktool-custom-option").click(),
    );
    const input = element<HTMLInputElement>(".asktool-custom-input");
    // Bypass React's instance value tracker: a plain assignment updates the
    // tracker too, so the input event would read as unchanged and onChange
    // would never fire. The prototype setter leaves the tracker behind.
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    nativeValueSetter.call(input, "my reason");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await frame();
    flushSync(() => headerButtons().primary.click());
    await until(
      () => questionText().includes("Allow rollback?"),
      "custom answer advances to question 2",
    );
    flushSync(() => options()[0]!.click());
    flushSync(() => headerButtons().primary.click());
    await until(() => resolutions.length === 4, "custom flow resolves");
    assert(
      JSON.stringify(resolutions[3]!.answers) ===
        JSON.stringify([["my reason"], ["gamma"]]),
      `custom text survives, saw ${JSON.stringify(resolutions[3]!.answers)}`,
    );

    // Flow E: a multi-block question body keeps its blocks stacked in the
    // card's text column instead of lining them up as flex items.
    mount("ask-layout", [MULTI_BLOCK_QUESTION]);
    await until(() => options().length > 0, "layout flow mounts");
    const paragraphs = [
      ...host.querySelectorAll<HTMLElement>(
        ".asktool-question .asktool-rich-paragraph",
      ),
    ];
    assert(
      paragraphs.length === 2,
      `the multi-block question renders one paragraph per block, saw ${paragraphs.length}`,
    );
    const cardWidth = element(".asktool-card").getBoundingClientRect().width;
    const boxes = paragraphs.map((node) => node.getBoundingClientRect());
    assert(
      boxes[1]!.top >= boxes[0]!.bottom - 1,
      `question blocks stack vertically (tops ${boxes[0]!.top}, ${boxes[1]!.top})`,
    );
    assert(
      Math.abs(boxes[1]!.left - boxes[0]!.left) < 1,
      `question blocks share a left edge (${boxes[0]!.left}, ${boxes[1]!.left})`,
    );
    assert(
      boxes[0]!.width > cardWidth / 2,
      `a question block spans the text column (${boxes[0]!.width} of ${cardWidth})`,
    );
    const numberBox = element(
      ".asktool-question-number",
    ).getBoundingClientRect();
    assert(
      numberBox.right <= boxes[0]!.left + 1,
      `the question number sits left of the text column (${numberBox.right}, ${boxes[0]!.left})`,
    );
    assert(
      numberBox.top >= boxes[0]!.top - 1 &&
        numberBox.bottom <= boxes[0]!.top + 26,
      `the question number shares the first line with the question text (${numberBox.top}, ${boxes[0]!.top})`,
    );

    // Flow F: a long prompt scrolls inside the card, keeps header actions in
    // view, and resets to the top when Next replaces the current question.
    mount("ask-overflow", LONG_QUESTIONS);
    await until(() => {
      const body = host.querySelector<HTMLElement>(".asktool-question-body");
      return Boolean(body && body.clientHeight > 0 && body.scrollHeight > body.clientHeight);
    }, "long question has an internal scroll range");
    const firstBody = element<HTMLElement>(".asktool-question-body");
    assert(firstBody.tabIndex === 0, "the question scroller is keyboard reachable");
    const tabOrder = [
      ...host.querySelectorAll<HTMLElement>("button, input, [tabindex='0']"),
    ];
    const bodyTabIndex = tabOrder.indexOf(firstBody);
    assert(
      tabOrder.indexOf(headerButtons().primary) < bodyTabIndex &&
        bodyTabIndex < tabOrder.indexOf(options()[0]!),
      "Tab reaches the question scroller between header actions and answers",
    );
    assert(
      getComputedStyle(firstBody).overflowY === "auto",
      "the long question scrolls inside its own body",
    );
    const actionRects = Object.values(headerButtons()).map((button) => {
      const rect = button.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
    assert(
      actionRects.every(({ top, bottom }) => top >= 0 && bottom <= window.innerHeight),
      "header actions stay inside the visible window",
    );
    firstBody.scrollTop = firstBody.scrollHeight;
    await frame();
    assert(firstBody.scrollTop > 0, "the question body accepts scrolling");
    assert(
      Object.values(headerButtons()).every((button, index) => {
        const rect = button.getBoundingClientRect();
        return Math.abs(rect.top - actionRects[index]!.top) < 1 &&
          Math.abs(rect.bottom - actionRects[index]!.bottom) < 1;
      }),
      "scrolling the prompt does not move its header actions",
    );
    flushSync(() => headerButtons().primary.click());
    await until(
      () => questionText().includes("Second long question"),
      "Next advances from the scrolled prompt",
    );
    assert(
      element<HTMLElement>(".asktool-question-body").scrollTop === 0,
      "the next long question starts at the top",
    );

    // Flow G: the maximum permitted prompt remains visible and answerable.
    mount("ask-max-length", [MAX_LENGTH_QUESTION]);
    await until(() => options().length === 1, "maximum-length question mounts");
    const maxLengthQuestion = "q".repeat(MAX_ASK_TOOL_QUESTION_CHARS);
    assert(
      questionText().endsWith(maxLengthQuestion),
      "the card displays the complete 300-character question",
    );
    flushSync(() => options()[0]!.click());
    flushSync(() => headerButtons().primary.click());
    await until(() => resolutions.length === 5, "maximum-length question resolves");
    assert(
      JSON.stringify(resolutions[4]!.answers) === JSON.stringify([["continue"]]),
      "the maximum-length question remains answerable",
    );

    // The pending card above stays mounted while the history row is added, so
    // its own typography is recorded here: the history stylesheet must not reach
    // it.
    const liveType = {
      label: getComputedStyle(element(".asktool-question-number")).fontSize,
      option: getComputedStyle(element(".asktool-option-description")).fontSize,
    };

    // ── Flow H: the completed ask as the transcript history renders it ──
    // The row names the tool in the session language, states the display-only
    // description the call carried, and states the answered count against every
    // question asked; the questions and answers belong to the expanded body. The
    // persisted result is the only other input here.
    const zh = i18n.createInstance();
    await zh.init({
      lng: "zh-CN",
      resources: { "zh-CN": { translation: zhCN } },
      interpolation: { escapeValue: false },
    });
    historyHost = document.createElement("div");
    historyHost.id = "asktool-history";
    historyHost.style.cssText =
      "position:fixed;inset:0;overflow:auto;background:#141414";
    document.body.append(historyHost);
    historyRoot = createRoot(historyHost, {
      onUncaughtError: (error) => errors.push(error),
    });
    const historyElement = <T extends HTMLElement = HTMLElement>(
      selector: string,
    ): T => {
      const found = historyHost!.querySelector<T>(selector);
      assert(found, `history row: missing ${selector}`);
      return found as T;
    };
    const mountHistory = async (
      instance: typeof i18n,
      message: ReturnType<typeof askHistoryMessage>,
    ) => {
      flushSync(() =>
        historyRoot!.render(
          <I18nextProvider i18n={instance}>
            <TranscriptDisclosureProvider>
              <ToolRow message={message} />
            </TranscriptDisclosureProvider>
          </I18nextProvider>,
        ),
      );
      await until(
        () =>
          Boolean(
            historyHost!.querySelector(`[data-message-id="${message.id}"]`),
          ),
        "the ask history row mounts",
      );
    };
    const historyName = () => historyElement(".tool-row-name").textContent ?? "";
    const historySummary = () =>
      historyElement(".tool-row-summary").textContent ?? "";
    const historyChips = () =>
      historyElement(".tool-row-chips").textContent ?? "";
    const historyHeader = () =>
      historyElement<HTMLButtonElement>(".tool-row-header");

    await mountHistory(i18n, askHistoryMessage("asktool-history-en", "asktool"));
    // Identity is the session language, never the wire name.
    assert(
      historyName() === "Questions",
      `the row is named in the session language (${historyName()})`,
    );
    assert(
      !historyElement(".tool-row")
        .getAttribute("aria-label")!
        .toLowerCase()
        .includes("asktool"),
      "the wire tool name never reaches the row's accessible label",
    );
    // The hint is the call's own display metadata: it is not the first question,
    // it is never counted, and it is the model's text rather than something the
    // row derived from the questions.
    assert(
      historySummary() === HISTORY_DESCRIPTION,
      `the summary states the call's task (${historySummary()})`,
    );
    assert(
      !/(\+\d+)/.test(historySummary()),
      `the summary never counts the questions it did not show (${historySummary()})`,
    );
    assert(
      historyChips().includes("2/3 answered"),
      `the row states the answered count (${historyChips()})`,
    );
    assert(
      historyHeader().getAttribute("aria-expanded") === "false",
      "a completed ask starts collapsed",
    );
    assert(
      !historyHost!.querySelector(".tool-row-body") &&
        !historyHost!.querySelector(".tool-asktool-results"),
      "the collapsed row renders no answers",
    );

    // The user path: one click on the row opens its answers.
    flushSync(() => historyHeader().click());
    await until(
      () => historyHeader().getAttribute("aria-expanded") === "true",
      "the ask row expands",
    );
    const historyControls = historyHeader().getAttribute("aria-controls");
    assert(historyControls, "the expanded row names the body it controls");
    const historyBody = document.getElementById(historyControls!);
    assert(
      historyBody?.classList.contains("tool-row-body"),
      "aria-controls names the rendered body",
    );
    const results = historyElement(".tool-asktool-results");
    assert(
      results.getAttribute("aria-label") === "Questions and answers",
      `the answers keep their accessible heading (${results.getAttribute("aria-label")})`,
    );
    const questionCopies = [
      ...historyHost!.querySelectorAll<HTMLElement>(
        ".tool-asktool-question-copy",
      ),
    ];
    assert(
      questionCopies.length === 3,
      `every question renders (${questionCopies.length})`,
    );
    assert(
      questionCopies.map((node) => node.textContent).join("|") ===
        "Which deployment target?|Which platforms should be supported?|Should beta updates be enabled?",
      "the card lists the questions in the order they were asked",
    );
    assert(
      Boolean(questionCopies[0]!.querySelector("strong")),
      "the expanded question renders the Markdown in full",
    );
    const answerValues = [
      ...historyHost!.querySelectorAll<HTMLElement>(
        ".tool-asktool-answer-value",
      ),
    ];
    assert(
      answerValues.length === 3,
      `both answered questions list their answers (${answerValues.length})`,
    );
    assert(
      answerValues.map((node) => node.textContent).join("|") ===
        "Desktop|macOS|Linux",
      "the card shows the answers the request resolved with",
    );
    const historyEntries = [
      ...historyHost!.querySelectorAll<HTMLElement>(".tool-asktool-entry"),
    ];
    assert(
      historyEntries.length === 3,
      `the card keeps one entry per question (${historyEntries.length})`,
    );
    assert(
      Boolean(historyEntries[2]!.querySelector(".tool-asktool-skipped")),
      "the unanswered third question is shown as skipped",
    );
    assert(
      historyEntries[2]!.textContent!.includes("Skipped"),
      "the skipped entry says so",
    );
    assert(
      !historyBody!.textContent!.includes('"answers"') &&
        !historyBody!.textContent!.includes('"questions"'),
      "the expanded body is never the serialized result",
    );
    assert(
      !historyBody!.textContent!.includes(HISTORY_DESCRIPTION),
      "the expanded body does not repeat the head's summary",
    );
    // Runtime typography evidence: the whole question-and-answer history —
    // question, label, answers and the skipped state — reads at the tool detail
    // size from the one rule on its container.
    const historyResults = historyElement<HTMLElement>(".tool-asktool-results");
    const answersSize = getComputedStyle(historyResults).fontSize;
    assert(
      answersSize === "12px",
      `the Q&A history reads at the tool detail size (${answersSize})`,
    );
    for (const selector of [
      ".tool-asktool-question-number",
      ".tool-asktool-question-copy",
      ".tool-asktool-answer-label",
      ".tool-asktool-answer-value",
      ".tool-asktool-skipped",
    ]) {
      const size = getComputedStyle(historyElement(selector)).fontSize;
      assert(
        size === answersSize,
        `${selector} inherits the history size (${size} vs ${answersSize})`,
      );
    }
    // The pending card above keeps its own tokens: the history rule reaches only
    // `.tool-asktool-*`, and adding the second root changed nothing in the card.
    assert(
      getComputedStyle(element(".asktool-question-number")).fontSize ===
        liveType.label &&
        getComputedStyle(element(".asktool-option-description")).fontSize ===
          liveType.option &&
        liveType.label !== answersSize,
      `the pending card keeps its own typography (label ${liveType.label}, option ${liveType.option})`,
    );

    // The toggle is two-way: collapsing hides the answers, and expanding again
    // shows the same persisted ones.
    flushSync(() => historyHeader().click());
    await until(
      () => historyHeader().getAttribute("aria-expanded") === "false",
      "the ask row collapses",
    );
    assert(
      !historyHost!.querySelector(".tool-row-body"),
      "a collapsed ask hides its answers again",
    );
    flushSync(() => historyHeader().click());
    await until(
      () => historyHeader().getAttribute("aria-expanded") === "true",
      "the ask row re-expands",
    );
    assert(
      historyHost!.querySelectorAll(".tool-asktool-answer-value").length === 3,
      "re-expanding shows the same persisted answers",
    );

    // The same persisted result in a zh-CN session under a namespaced tool
    // name: identity and labels follow the session language, nothing else.
    const zhIdentity = zh.t("chat.toolIdentityAskTool");
    const zhChip = zh.t("chat.toolChipAnswered", { answered: 2, total: 3 });
    const zhTitle = zh.t("askTool.historyTitle");
    const zhSkipped = zh.t("askTool.skipped");
    assert(
      zhIdentity !== "chat.toolIdentityAskTool",
      `the zh-CN catalog defines the ask identity (${zhIdentity})`,
    );
    assert(
      zhTitle !== "askTool.historyTitle",
      `the zh-CN catalog defines the answer heading (${zhTitle})`,
    );
    await mountHistory(
      zh,
      askHistoryMessage("asktool-history-zh", "functions.asktool"),
    );
    // `useTranslation` hands a component's first render the translator it was
    // created with and swaps it in an effect once the new instance's language
    // event lands, so wait for the row to speak the session language before
    // reading the rest of its strings.
    await until(
      () => historyName() === zhIdentity,
      "the history row speaks the session language",
    );
    assert(
      historyName() === zhIdentity,
      `the namespaced ask is named in the session language (${historyName()})`,
    );
    // The hint is the model's own text, so the session language leaves it
    // alone: only the tool identity, the chip and the body are localized.
    assert(
      historySummary() === HISTORY_DESCRIPTION,
      `the namespaced ask keeps the model's summary (${historySummary()})`,
    );
    assert(
      historyChips().includes(zhChip),
      `the namespaced ask states the answered count (${historyChips()})`,
    );
    flushSync(() => historyHeader().click());
    await until(
      () => historyHeader().getAttribute("aria-expanded") === "true",
      "the zh-CN ask row expands",
    );
    assert(
      historyElement(".tool-asktool-results").getAttribute("aria-label") ===
        zhTitle,
      "the zh-CN answers keep their localized heading",
    );
    assert(
      historyHost!.querySelectorAll(".tool-asktool-question-copy").length === 3,
      "the zh-CN card lists every question",
    );
    assert(
      historyElement(".tool-asktool-skipped").textContent === zhSkipped,
      `the zh-CN skip is named (${historyElement(".tool-asktool-skipped").textContent})`,
    );
    // A row recorded without the optional summary states no hint at all: it
    // never quotes the first question and never counts the rest, while the
    // answered chip and the whole Q&A body stay reachable.
    await mountHistory(
      i18n,
      askHistoryMessage("asktool-history-no-summary", "asktool", null),
    );
    assert(
      !historyHost!.querySelector(".tool-row-summary"),
      "a row without a description states no hint",
    );
    assert(
      !/(\+\d+)/.test(historyElement(".tool-row").textContent ?? ""),
      "a row without a description never counts its questions",
    );
    // The previous mount spoke zh-CN; the translator swaps in an effect, so wait
    // for the row to speak this session's language before reading the chip.
    await until(
      () => historyName() === "Questions",
      "the row without a description speaks the session language",
    );
    assert(
      historyChips().includes("2/3 answered"),
      `the chip stays without a hint (${historyChips()})`,
    );
    flushSync(() => historyHeader().click());
    await until(
      () => historyHeader().getAttribute("aria-expanded") === "true",
      "the row without a description expands",
    );
    assert(
      historyHost!.querySelectorAll(".tool-asktool-question-copy").length === 3,
      "every question stays reachable without a hint",
    );
    assert(
      (historyHost!.querySelectorAll(".tool-asktool-answer-value").length) === 3 &&
        Boolean(historyHost!.querySelector(".tool-asktool-skipped")),
      "the answers and the skip stay reachable without a hint",
    );
    assert(errors.length === 0, `render errors: ${errors.map(String)}`);
    return {
      ok: true,
      resolutions: resolutions.length,
      history: {
        collapsedAndExpandedRows: 3,
        locales: ["en", "zh-CN"],
        questions: 3,
        answers: 2,
        skipped: 1,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  } finally {
    if (historyRoot !== null) {
      const mounted = historyRoot;
      flushSync(() => mounted.unmount());
    }
    historyHost?.remove();
    flushSync(() => root.unmount());
    host.remove();
    api.resolveAskTool = originalResolve;
    useAppStore.setState({
      pendingAsks: initial.pendingAsks,
      activeSessionId: initial.activeSessionId,
    });
  }
}

globalThis.asktoolCardProbe = asktoolCardProbe;
