import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC, type UiMessage } from "@pi-desktop/shared";
import { SubagentTranscriptTab } from "../../apps/desktop/src/components/workpanel/SubagentTranscriptTab";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

declare global {
  var subagentTranscriptJumpProbe: (width: number) => Promise<{
    ok: boolean;
    failures: string[];
    facts: Record<string, unknown>;
  }>;
}

/*
 * The child's transcript tab, mounted in a real Chromium renderer with the
 * application's own built stylesheet, inside the panel shape the work panel
 * gives it (`.work-panel-body` > `.work-panel-tabpane` > tab). The panel body is
 * the tab's positioned ancestor and it also contains the composer, which is
 * exactly the coordinate space the jump control used to be placed in.
 *
 * The claim is one geometry contract: the floating jump control sits
 * horizontally centred just above the transcript viewport's own bottom edge —
 * the composer's own top — at any composer height (empty draft, multi-line
 * draft, staged image) and at any panel width; a real upward gesture shows it,
 * clicking it returns to the newest row and hides it, and following continues
 * afterwards. Only the preload bridge is a stub, and the tab only calls it when
 * the probe stages an image.
 */

const SESSION = "s1";
const DELEGATION = "d1";
const CALL = "call-task";
const createdAt = "2026-10-18T00:00:00.000Z";

window.piDesktop = {
  channels: IPC,
  platform: "darwin",
  invoke: async (channel: string) =>
    channel === IPC.invoke.composerPasteFiles
      ? {
          ok: true,
          data: {
            files: [
              { path: "/tmp/pi-jump-fixture/pasted.png", name: "pasted.png", mimeType: "image/png" },
            ],
          },
        }
      : { ok: true, data: undefined },
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

/** Enough child rows that the pane scrolls at every tested width and height. */
function childMessages(): UiMessage[] {
  const rows: UiMessage[] = [
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
          status: "completed",
          startedAt: 1_000,
          completedAt: 42_000,
        },
      },
    }),
  ];
  for (let index = 0; index < 14; index += 1) {
    rows.push(
      message(`c${index}-tool`, "tool", "", {
        toolName: "Read",
        toolCallId: `call-${index}`,
        toolStatus: "success",
        parentToolCallId: CALL,
        agentName: "explorer",
        toolArgs: { path: `src/auth/module-${index}.ts` },
        toolResult: { details: { content: `export const session${index} = createSession();` } },
      }),
      message(
        `c${index}-answer`,
        "assistant",
        `Step ${index}: the auth flow reads the session, validates the token, and continues. ` +
          `No defect found in module ${index}; the refresh path stays on the same rotation.`,
        { parentToolCallId: CALL, agentName: "explorer" },
      ),
    );
  }
  return rows;
}

let appended = 0;
function appendTailRow(): void {
  appended += 1;
  flushSync(() => {
    useAppStore.setState((state) => ({
      messages: [
        ...state.messages,
        message(`tail-${appended}`, "assistant", `Followed tail row ${appended}.`, {
          parentToolCallId: CALL,
          agentName: "explorer",
        }),
      ],
    }));
  });
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
        title: "Jump fixture",
        source: "local",
        mode: "agent",
        createdAt,
        updatedAt: createdAt,
      } as never,
    ],
    messages: childMessages(),
    isRunning: false,
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
    agentStatuses: {},
    runningSessions: {},
  } as never);
});

const host = document.createElement("div");
host.style.cssText =
  "position:fixed;inset:0;display:flex;align-items:stretch;background:var(--ds-bg-primary)";
(document.body ?? document.documentElement).append(host);

/*
 * The work panel's own shape: the header strip, the body that positions the
 * panel's overlays, and the tab pane the tab fills. The body is what the jump
 * control used to be positioned against.
 */
const panel = document.createElement("div");
panel.className = "work-panel";
panel.style.cssText = "display:flex;flex-direction:column;min-height:0;height:600px;width:340px";
const body = document.createElement("div");
body.className = "work-panel-body";
body.style.cssText =
  "position:relative;display:flex;min-height:0;flex:1;flex-direction:column;aspect-ratio:auto";
const pane = document.createElement("div");
pane.className = "work-panel-tabpane";
pane.style.cssText = "display:flex;min-height:0;flex:1;flex-direction:column";
host.append(panel);
panel.append(body);
body.append(pane);

const root = createRoot(pane);
flushSync(() => {
  root.render(
    <I18nextProvider i18n={i18n}>
      <SubagentTranscriptTab delegationId={DELEGATION} />
    </I18nextProvider>,
  );
});

const frames = (count = 2) =>
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

const scroller = () => document.querySelector<HTMLElement>(".subagent-transcript-scroll");
const tab = () => document.querySelector<HTMLElement>(".subagent-transcript-tab");
const composer = () => document.querySelector<HTMLElement>(".subagent-transcript-composer");
const editor = () =>
  document.querySelector<HTMLElement>(".subagent-transcript-composer .composer-input");
/**
 * The transcript viewport: the scrollport's positioned parent in the shipped
 * markup. Before the fix no such element exists, so the probe falls back to the
 * scrollport itself and reports the same numbers against the old geometry.
 */
const viewport = () =>
  document.querySelector<HTMLElement>(".subagent-transcript-viewport") ?? scroller();
const jump = () => document.querySelector<HTMLElement>(".subagent-transcript-tab .jump-latest-btn");
const strip = () => document.querySelector<HTMLElement>(".composer-attachment-strip");
const imageTile = () => document.querySelector<HTMLElement>(".composer-attachment-tile");

function setWidth(width: number) {
  // The panel's own width rules read an inline custom property, so the probe
  // states the width the work panel would state.
  panel.style.setProperty("--work-panel-width", `${width}px`);
  panel.style.setProperty("width", `${width}px`, "important");
  panel.style.setProperty("flex", "0 0 auto", "important");
}

const rect = (node: Element | null) => node?.getBoundingClientRect() ?? null;
const near = (a: number, b: number, tolerance = 1) => Math.abs(a - b) <= tolerance;
const round = (value: number) => Math.round(value * 100) / 100;

/** Everything the contract needs, read from real computed layout. */
function measure() {
  const viewportBox = rect(viewport());
  const scrollBox = rect(scroller());
  const tabBox = rect(tab());
  const composerBox = rect(composer());
  const buttonBox = rect(jump());
  const element = scroller();
  return {
    width: Math.round(tabBox?.width ?? 0),
    panelWidth: Math.round(rect(panel)?.width ?? 0),
    bodyWidth: Math.round(rect(body)?.width ?? 0),
    viewportTop: round(viewportBox?.top ?? 0),
    viewportBottom: round(viewportBox?.bottom ?? 0),
    viewportCenterX: round(((viewportBox?.left ?? 0) + (viewportBox?.right ?? 0)) / 2),
    scrollTop: round(scrollBox?.top ?? 0),
    scrollBottom: round(scrollBox?.bottom ?? 0),
    tabCenterX: round(((tabBox?.left ?? 0) + (tabBox?.right ?? 0)) / 2),
    composerTop: round(composerBox?.top ?? 0),
    composerHeight: round(composerBox?.height ?? 0),
    buttonTop: round(buttonBox?.top ?? 0),
    buttonBottom: round(buttonBox?.bottom ?? 0),
    buttonCenterX: round(((buttonBox?.left ?? 0) + (buttonBox?.right ?? 0)) / 2),
    /** Distance from the control's bottom edge up to the composer's top edge. */
    gapAboveComposer: round((composerBox?.top ?? 0) - (buttonBox?.bottom ?? 0)),
    /** Distance from the transcript viewport's bottom edge to the control. */
    gapAboveViewport: round((viewportBox?.bottom ?? 0) - (buttonBox?.bottom ?? 0)),
    centerDelta: round(
      ((buttonBox?.left ?? 0) + (buttonBox?.right ?? 0)) / 2 -
        ((viewportBox?.left ?? 0) + (viewportBox?.right ?? 0)) / 2,
    ),
    scrollHeight: element?.scrollHeight ?? 0,
    clientHeight: element?.clientHeight ?? 0,
    distanceFromBottom: element
      ? round(element.scrollHeight - element.scrollTop - element.clientHeight)
      : -1,
  };
}

async function until(check: () => boolean, label: string, timeoutMs = 4_000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (check()) return;
    await frames(1);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A real upward gesture: the input that releases follow, then the scroll. */
async function wheelUp(delta: number) {
  const element = scroller();
  if (!element) throw new Error("no scrollport");
  const before = element.scrollTop;
  element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -delta }));
  element.scrollTop = Math.max(0, element.scrollTop - delta);
  if (!(element.scrollTop < before)) throw new Error("the pane never scrolled up");
  element.dispatchEvent(new Event("scroll", { bubbles: true }));
  await frames(3);
}

/** Grows the composer the way a multi-line draft does. */
async function typeDraft(lines: number) {
  const element = editor();
  if (!element) throw new Error("no composer editor");
  element.focus();
  element.textContent = Array.from({ length: lines }, (_, index) => `draft line ${index}`).join("\n");
  element.dispatchEvent(new Event("input", { bubbles: true }));
  await frames(4);
}

/** Stages one image through the production paste path. */
async function pasteImage() {
  const element = editor();
  if (!element) throw new Error("no composer editor");
  const data = new DataTransfer();
  data.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "pasted.png", {
    type: "image/png",
  }));
  element.dispatchEvent(
    new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
  );
  await until(() => strip() !== null, "the staged image strip", 4_000);
  await frames(4);
}

async function clickJump() {
  const button = jump();
  if (!button) throw new Error("the jump control is not on screen");
  button.click();
  await frames(2);
}

const failuresOf = (checks: Array<[boolean, string]>) =>
  checks.filter(([pass]) => !pass).map(([, label]) => label);

globalThis.subagentTranscriptJumpProbe = async (width: number) => {
  await frames(3);
  const failures: string[] = [];
  const facts: Record<string, unknown> = {};
  setWidth(width);
  await frames(4);

  const element = scroller();
  failures.push(
    ...failuresOf([
      [tab() !== null && element !== null, `${width}px: the delegation tab and its scrollport mount`],
      [
        element !== null && element.scrollHeight > element.clientHeight + 100,
        `${width}px: the fixture transcript overflows its scrollport`,
      ],
      [
        editor() !== null && editor()!.getAttribute("contenteditable") === "true",
        `${width}px: the settled delegate keeps an editable composer`,
      ],
      [jump() === null, `${width}px: the control is absent while follow is pinned to the bottom`],
      [
        element !== null && element.scrollHeight - element.scrollTop - element.clientHeight <= 2,
        `${width}px: a mounted tab starts pinned at the newest row`,
      ],
    ]),
  );
  if (!element) return { ok: false, failures, facts };

  // Single scroll owner: one follow scroller, no second nested transcript
  // scrollbar, and the control itself never scrolls with the content.
  const owners = document.querySelectorAll(".subagent-transcript-tab [data-scroll-owner]");
  failures.push(
    ...failuresOf([
      [
        owners.length === 1 && owners[0] === element,
        `${width}px: the tab keeps exactly one follow scroll owner`,
      ],
      [
        document.querySelector(".subagent-transcript-tab .subagent-run-rows") === null,
        `${width}px: the pane mounts no nested workflow scrollbar`,
      ],
      [
        element.querySelector(".jump-latest-btn") === null,
        `${width}px: the control is not inside the scrollport`,
      ],
    ]),
  );

  // 1. A real upward gesture shows the control; measure where it lands.
  await wheelUp(240);
  await until(() => jump() !== null, "the jump control to appear");
  // Its entry animation scales the control, so measure once it has landed.
  await until(
    () => (jump()?.getAnimations().every((animation) => animation.playState === "finished") ?? false),
    "the jump control's entry animation",
  );
  const shortComposer = measure();
  facts.shortComposer = shortComposer;
  failures.push(
    ...failuresOf([
      [
        shortComposer.gapAboveComposer >= 4,
        `${width}px: the control sits above the composer (gap ${shortComposer.gapAboveComposer}px)`,
      ],
      [
        near(shortComposer.gapAboveViewport, 8),
        `${width}px: the control is anchored to the transcript viewport (gap ${shortComposer.gapAboveViewport}px)`,
      ],
      [
        near(shortComposer.centerDelta, 0) && near(shortComposer.buttonCenterX, shortComposer.tabCenterX),
        `${width}px: the control is horizontally centred (delta ${shortComposer.centerDelta}px)`,
      ],
      [
        shortComposer.buttonTop >= shortComposer.viewportTop &&
          shortComposer.buttonBottom <= shortComposer.viewportBottom + 0.5,
        `${width}px: the control stays inside the transcript viewport`,
      ],
    ]),
  );

  // 2. The composer grows with a multi-line draft: the control must not move.
  await typeDraft(7);
  const tallComposer = measure();
  facts.tallComposer = tallComposer;
  failures.push(
    ...failuresOf([
      [
        tallComposer.composerHeight > shortComposer.composerHeight + 20,
        `${width}px: the multi-line draft grows the composer (${shortComposer.composerHeight} -> ${tallComposer.composerHeight})`,
      ],
      [jump() !== null, `${width}px: the control stays visible while the draft grows`],
      [
        tallComposer.gapAboveComposer >= 4,
        `${width}px: the grown composer keeps the control above it (gap ${tallComposer.gapAboveComposer}px)`,
      ],
      [
        near(tallComposer.gapAboveViewport, 8),
        `${width}px: the control still anchors to the viewport (gap ${tallComposer.gapAboveViewport}px)`,
      ],
      [
        near(tallComposer.centerDelta, 0),
        `${width}px: centring holds with the grown composer (delta ${tallComposer.centerDelta}px)`,
      ],
      [
        near(tallComposer.gapAboveComposer, shortComposer.gapAboveComposer),
        `${width}px: the gap is the same as with the short composer (${shortComposer.gapAboveComposer} / ${tallComposer.gapAboveComposer})`,
      ],
      [
        tallComposer.distanceFromBottom > 2,
        `${width}px: growing the composer does not drag the reader back to the bottom`,
      ],
    ]),
  );

  // 3. A staged image grows the composer again, from another cause.
  await pasteImage();
  const withImage = measure();
  facts.withImage = withImage;
  facts.imageTile = imageTile() !== null;
  failures.push(
    ...failuresOf([
      [imageTile() !== null, `${width}px: the pasted image renders its production tile`],
      [
        withImage.composerHeight > tallComposer.composerHeight + 20,
        `${width}px: the image strip grows the composer (${tallComposer.composerHeight} -> ${withImage.composerHeight})`,
      ],
      [
        near(withImage.gapAboveComposer, shortComposer.gapAboveComposer),
        `${width}px: the gap is unchanged by the image strip (${shortComposer.gapAboveComposer} / ${withImage.gapAboveComposer})`,
      ],
      [
        withImage.gapAboveComposer >= 4,
        `${width}px: the image strip keeps the control above the composer (gap ${withImage.gapAboveComposer}px)`,
      ],
      [
        near(withImage.gapAboveViewport, 8) && near(withImage.centerDelta, 0),
        `${width}px: the control keeps its viewport anchor and centre (gap ${withImage.gapAboveViewport}px, delta ${withImage.centerDelta}px)`,
      ],
    ]),
  );

  // 4. A different panel width keeps the same contract.
  const otherWidth = width === 340 ? 620 : 340;
  setWidth(otherWidth);
  await frames(4);
  const resized = measure();
  facts.resized = resized;
  failures.push(
    ...failuresOf([
      [
        Math.round(resized.width) === otherWidth,
        `${width}px: the pane takes the new width (${resized.width}px)`,
      ],
      [
        near(resized.centerDelta, 0) && near(resized.buttonCenterX, resized.tabCenterX),
        `${width}px: centring survives the width change (delta ${resized.centerDelta}px)`,
      ],
      [
        resized.gapAboveComposer >= 4 && near(resized.gapAboveViewport, 8),
        `${width}px: the anchor survives the width change (gap ${resized.gapAboveComposer}px / ${resized.gapAboveViewport}px)`,
      ],
    ]),
  );
  setWidth(width);
  await frames(4);

  // 5. Clicking the control reaches the newest row and hides itself.
  await clickJump();
  await until(
    () => jump() === null && scroller() !== null &&
      scroller()!.scrollHeight - scroller()!.scrollTop - scroller()!.clientHeight <= 2,
    "the control to reach the newest row and hide",
  );
  const afterJump = measure();
  facts.afterJump = afterJump;
  failures.push(
    ...failuresOf([
      [jump() === null, `${width}px: clicking the control hides it`],
      [
        afterJump.distanceFromBottom <= 2,
        `${width}px: clicking the control reaches the newest row (${afterJump.distanceFromBottom}px away)`,
      ],
    ]),
  );

  // 6. Following is back in force: a new row keeps the view at the bottom.
  appendTailRow();
  await frames(6);
  const following = measure();
  facts.following = following;
  failures.push(
    ...failuresOf([
      [
        following.distanceFromBottom <= 2,
        `${width}px: follow re-pins after the control (${following.distanceFromBottom}px away)`,
      ],
      [jump() === null, `${width}px: the control stays hidden while following`],
    ]),
  );

  return { ok: failures.length === 0, failures, facts };
};

(globalThis as unknown as { subagentTranscriptJumpReady: true }).subagentTranscriptJumpReady = true;
