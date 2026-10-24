import {
  readStoreModule,
  readStoreSource,
  readTranscriptSource,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const transcriptSource = await readTranscriptSource();
const runtimeSource = await readFile(
  new URL("../../../packages/agent-runtime/src/runtime.ts", import.meta.url),
  "utf8",
);
const progressSource = await readFile(
  new URL("../../../packages/agent-runtime/src/subagent-progress.ts", import.meta.url),
  "utf8",
);
const toolPresentationSource = await readFile(
  new URL("../src/lib/tool-presentation.ts", import.meta.url),
  "utf8",
);
const followScrollSource = await readFile(
  new URL("../src/hooks/use-follow-scroll.ts", import.meta.url),
  "utf8",
);
const storeSource = await readStoreSource();
const eventsSource = await readStoreModule("slices/events-slice.ts");
const sessionRuntimeSource = await readStoreModule("runtime/session-runtime.ts");
const messagesCss = await readFile(
  new URL("../src/styles/messages.css", import.meta.url),
  "utf8",
);
const topologySource = await readFile(
  new URL("../src/lib/subagent-topology.ts", import.meta.url),
  "utf8",
);
const activityItemsSource = await readFile(
  new URL("../src/features/chat/transcript/ActivityItems.tsx", import.meta.url),
  "utf8",
);
const taskCardSource = await readFile(
  new URL("../src/features/chat/transcript/SubagentTaskCard.tsx", import.meta.url),
  "utf8",
);
const toolDisplaySource = await readFile(
  new URL("../src/lib/tool-display.ts", import.meta.url),
  "utf8",
);
const englishCatalogSource = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);
const chineseCatalogSource = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);
const turkishCatalogSource = await readFile(
  new URL("../../../packages/i18n/src/locales/tr/index.ts", import.meta.url),
  "utf8",
);

test("a delegation card reads its outcome from the lifecycle rows", () => {
  // `Task` returns as soon as the delegate starts, so its own payload says
  // `running` forever. Treating that as "no status" made every card claim
  // `completed` the moment the fan-out began.
  assert.match(topologySource, /const DELEGATION_STATUSES = new Set<SubagentOutcome>\(\[\s*\n\s*"running",/);
  assert.match(topologySource, /export function collectDelegationStatuses\(/);
  // TaskWait/TaskList report `details.delegations[]`; TaskStop reports
  // `details.stopped[]`. Later rows settle what earlier ones reported as running.
  assert.match(topologySource, /payload\.delegations/);
  assert.match(topologySource, /payload\.stopped/);
  assert.match(topologySource, /statuses\.set\(id, status\)/);
  assert.match(topologySource, /turnLive/);
  assert.match(
    topologySource,
    /const settled = statuses\?\.get\(delegationId\);\s*\n\s*if \(settled\) return settled;/,
  );
  // The lifecycle rows are still excluded from the topology's node count.
  assert.match(topologySource, /if \(isDelegationActivityItem\(item\)\) continue;/);
  assert.match(
    transcriptSource,
    /const delegationStatuses = useMemo\(\(\) => turnDelegationStatuses \?\? collectDelegationStatuses\(delegationItems\)/,
  );
  // Delegates remain live across replies split by steering in the same runtime turn.
  assert.match(
    transcriptSource,
    /collectDelegationStatuses\(delegationItems, \{ turnLive: isActive \|\| delegationsLive === true \}\)/,
  );
  assert.match(transcriptSource, /const tools = reuseReferences\(toolsRef\.current, summary\.tools\)/);
  assert.match(transcriptSource, /delegationItems = useMemo\(\(\) => tools\.map/);
});

test("a lifecycle row summarizes by agent name, never by delegation id", () => {
  // Superseded the `delegationIds` summary (D268): the ids a lifecycle row is
  // called with are bare UUIDs, so the row reads the roster the runtime
  // returned and names the subagents instead.
  assert.match(toolDisplaySource, /delegate: \["description", "agent"\]/);
  assert.doesNotMatch(toolDisplaySource, /"delegationIds"/);
  assert.doesNotMatch(toolDisplaySource, /"delegationids"/);
  assert.match(toolDisplaySource, /function summaryText\(value: unknown\): string/);
  assert.match(toolDisplaySource, /Array\.isArray\(value\) && value\.every\(/);
  assert.doesNotMatch(toolDisplaySource, /record\[key\] as string/);
  // The roster is read from both payload shapes the lifecycle tools return.
  assert.match(topologySource, /export function delegationRoster\(/);
  assert.match(topologySource, /Array\.isArray\(payload\.stopped\)/);
  // A repeated definition is counted rather than listed twice.
  assert.match(topologySource, /count > 1 \? `\$\{name\} ×\$\{count\}` : name/);
  // The row's status carries the roster's rollup tint: a failed or denied
  // delegate colours the state dot even when the wait itself settled.
  assert.match(transcriptSource, /rosterOutcome === "failed"/);
  assert.match(transcriptSource, /rosterOutcome === "denied"/);
  // A lifecycle row keeps its fixed tool identity and states its own wait on
  // the right, not as a "Delegated" label. A settled TaskWait, or an active
  // TaskList that blocked on the coordinator, names its backend-owned wait
  // outcome (results arrived vs interim progress vs timeout/interrupted); a
  // cheap TaskList snapshot and TaskStop keep their own settled labels.
  assert.match(transcriptSource, /waitLabelKey/);
  assert.match(transcriptSource, /WAIT_SETTLED_LABEL_KEYS/);
  assert.match(transcriptSource, /WAIT_PROGRESS_LABEL_KEYS/);
  assert.match(transcriptSource, /taskWaitLifecycle\(message\)/);
  // The wait lifecycle is read for both program-wait tools, never only wait.
  assert.match(transcriptSource, /lifecycle === "wait" \|\| lifecycle === "list"/);
  // A folded checkpoint's tooltip still names what that row did, so repeated
  // waits on one live delegation read as one ongoing state without losing
  // inspectable history.
  assert.match(transcriptSource, /waitTitle/);
  assert.match(topologySource, /export function taskWaitLifecycle\(/);
  assert.match(topologySource, /export function collapsedWaitCheckpoints\(/);
  assert.match(topologySource, /export function foldedWaitCheckpointGroups\(/);
  assert.match(topologySource, /export function isLiveWaitCheckpoint\(/);
  // Folded checkpoints are not deleted: their earlier rows render in a small
  // disclosure, so every wait stays reachable from the transcript.
  assert.match(transcriptSource, /export const FoldedWaitCheckpoints/);
  assert.match(transcriptSource, /messages\.map\(\(message\) => \(/);
  // It never falls back to its own arguments, so a pending wait shows no ids.
  assert.match(transcriptSource, /const summary = lifecycle \? rosterSummary : argSummary;/);
  // ...and it is still not a topology node.
  assert.match(topologySource, /if \(isDelegationActivityItem\(item\)\) continue;/);
});

test("a TaskWait row states its wait outcome on the right and keeps it in the tooltip", () => {
  // SSR contract: the row resolves its backend-owned wait outcome key, prints
  // it in the right-hand status and keeps the roster in the tooltip. Key
  // resolution itself is covered by the tab SSR fixtures; here the source
  // contract proves the outcome reaches the status while the row's name stays
  // the fixed tool identity.
  assert.match(transcriptSource, /t\(waitLabelKey \?\? LIFECYCLE_LABEL_KEYS\[lifecycle\]\)/);
  assert.match(transcriptSource, /const waitTitle = waitLabelKey\s*\n?\s*\? \[t\(waitLabelKey\), rosterSummary\]/);
  assert.match(transcriptSource, /WAIT_SETTLED_LABEL_KEYS\.completed/);
  assert.match(transcriptSource, /WAIT_PROGRESS_LABEL_KEYS\[waitLifecycle\.reason\]/);
  assert.match(transcriptSource, /taskWaitLifecycle\(message\)/);
  assert.match(transcriptSource, /title=\{waitTitle\}/);
  assert.doesNotMatch(transcriptSource, /\{\s*lifecycle\s*\n?\s*\?\s*t\(\s*\(status === "running"/);
});

test("folded wait checkpoints suppress the top-level row without deleting history", () => {
  // The projection keeps every folded row: the group anchor stays visible (it
  // is the disclosure's slot), only the remaining redundant rows are hidden,
  // and the earlier rows are handed to the disclosure rather than dropped.
  assert.match(activityItemsSource, /foldedWaitCheckpointGroups\(items\)/);
  assert.match(activityItemsSource, /projection\.groups\.has\(item\.message\.id\)/);
  assert.match(activityItemsSource, /foldedCheckpoints\?\.get\(item\.message\.id\)/);
  assert.match(activityItemsSource, /<FoldedWaitCheckpoints/);
  assert.match(activityItemsSource, /messages=\{folded\}/);
});

test("a live delegate row keeps the attribution its stream carried", () => {
  // Without these the row would render as a top-level tool call until the
  // session was reloaded from host-core.
  assert.match(
    storeSource,
    /envelope\.parentToolCallId\n\s+\? \{ parentToolCallId: envelope\.parentToolCallId \}/,
  );
  assert.match(storeSource, /envelope\.agentName \? \{ agentName: envelope\.agentName \}/);
});

test("a terminal tool event repairs a row lost during renderer reload", () => {
  assert.match(sessionRuntimeSource, /const toolStartsByCallId = new Map/);
  assert.match(eventsSource, /const existing = state\.messages\.some\(/);
  assert.match(
    eventsSource,
    /messages: existing\s*\? state\.messages\.map\([\s\S]*?: \[\.\.\.state\.messages, completed\]/,
  );
  assert.match(eventsSource, /toolDurationMs: toolStart\s*\n\s*\? Math\.max/);
  assert.match(eventsSource, /toolName: message\.toolName \?\? completed\.toolName/);
});

test("inline delegate runs keep the live conversation process", () => {
  assert.match(transcriptSource, /delegate\?: SubagentRun/);
  assert.match(transcriptSource, /<SubagentRunRows/);
  assert.match(transcriptSource, /open && hasDetails && disclosure\.parentVisible/);
  assert.match(transcriptSource, /className=\{`subagent-run-rows\$\{scrollable \? "" : " is-panel-flow"\}`\}/);
  assert.match(transcriptSource, /onScroll=\{scrollable \? handleScroll : undefined\}/);
  assert.match(transcriptSource, /\{scrollable && showJump \?/);
});

test("a Task row names the delegate it used and opens its transcript", () => {
  assert.match(
    transcriptSource,
    /hasToolDetails\(message\) \|\| Boolean\(delegate\)/,
  );
  assert.match(transcriptSource, /TOOL_ACTION_KEYS.*delegate: "chat\.toolDelegated"/s);
  assert.match(transcriptSource, /TOOL_RUNNING_KEYS.*delegate: "chat\.toolDelegating"/s);
  assert.match(transcriptSource, /className="tool-row-agent"/);
  assert.match(transcriptSource, /case "delegate":\n\s+return <IconBot/);
  // The card names the role that ran the child, and only a running delegation
  // offers the stop handle for it.
  assert.match(taskCardSource, /const agentName = delegateAgentName\(message, delegate\)/);
  // One running flag drives both the inline mark and the stop handle: a call
  // that is still spawning has neither.
  assert.match(
    taskCardSource,
    /const running = outcome === "running" && !creating;/,
  );
  assert.match(taskCardSource, /running=\{running\}/);
});
test("a Task card is titled by its task and named by its role", () => {
  // The effective model and reasoning level are still recorded by the runtime
  // (the child's transcript tab states them), but the card names the work: the
  // title is the chain's original `description`, resolved over the whole resume
  // chain (lib/subagent-title).
  assert.match(
    runtimeSource,
    /startedAt,\s*\n\s*modelId: provider\.modelId,/,
  );
  assert.match(
    taskCardSource,
    /const chainTitle =\s*\n?\s*conversationTitles\?\.get\(delegationIdForMessage\(message\)\) \|\|\s*\n?\s*delegateTaskTitle\(message\)/,
  );
  assert.match(
    taskCardSource,
    /import \{ delegateTaskTitle \} from "\.\.\/\.\.\/\.\.\/lib\/subagent-title";/,
  );
  assert.match(
    taskCardSource,
    /const title = chainTitle \|\| agentName \|\| t\("chat\.subagentUnnamed"\)/,
  );
  // The title row holds the title and the child's inline state (which a
  // preparing call omits entirely); the role that ran it reads on its own line
  // beneath, before the child's own figures.
  assert.match(
    taskCardSource,
    /<span className="subagent-task-title" title=\{title\}>[\s\S]*?className="subagent-task-state"[\s\S]*?<\/span>[\s\S]*?<\/span>[\s\S]*?className="subagent-task-role"[\s\S]*?className="subagent-task-metrics"/,
  );
  assert.match(taskCardSource, /const role = chainTitle \? agentName : ""/);
  // Nothing on the card states the model or the reasoning level: they describe
  // the child's own runtime, which its transcript tab states once.
  assert.doesNotMatch(taskCardSource, /modelId/);
  assert.doesNotMatch(taskCardSource, /thinkingLevel/);
  assert.doesNotMatch(transcriptSource, /delegateModelId\(message\)/);
  assert.doesNotMatch(transcriptSource, /const modelLabel =/);
  assert.match(messagesCss, /\.subagent-task-role \{[^}]*font-family: var\(--font-mono\)/);
  // The expanded body never repeated the resolved pair either.
  assert.match(
    toolPresentationSource,
    /key !== "agent" &&[\s\S]*?key !== "error" &&[\s\S]*?key !== "modelId" &&[\s\S]*?key !== "thinkingLevel"/,
  );
});
test("the description is the title, so the card never prints it twice", () => {
  // The card has one headline: no summary line, no second description, and the
  // brief is never a title (the child's transcript holds it).
  assert.doesNotMatch(taskCardSource, /subagent-task-summary/);
  // Its own preparation flag is not an argument read: the card never touches
  // the call's raw arguments.
  assert.doesNotMatch(taskCardSource, /message\.toolArgs\b/);
  // A long title clamps in the card and keeps the whole value in its hover.
  assert.match(messagesCss, /\.subagent-task-title \{[^}]*-webkit-line-clamp: 2/);
  // The title is the only headline: the unnamed label is what an older log
  // without any description falls back to, never the task brief.
  assert.match(
    taskCardSource,
    /const title = chainTitle \|\| agentName \|\| t\("chat\.subagentUnnamed"\)/,
  );
});
test("the delegate's effective thinking level still reaches the tab", () => {
  // The Task start snapshot still carries the resolved pair inline.
  assert.match(
    runtimeSource,
    /modelId: provider\.modelId,\s*\n\s*thinkingLevel,/,
  );
  // Lifecycle snapshots moved out of runtime.ts into the extracted
  // subagent-progress owner: both the TaskWait/TaskList roster summary and
  // the wait-result snapshot carry the record's pair, so a settled delegate
  // keeps its effective level after polling replaces the Task row.
  assert.match(
    progressSource,
    /export function delegationSummary\(record: DelegationRecord\)/,
  );
  assert.match(
    progressSource,
    /modelId: record\.modelId,\s*\n\s*thinkingLevel: record\.thinkingLevel,/,
  );
  assert.match(
    progressSource,
    /export function snapshotWaitRecord\(record: DelegationRecord\)/,
  );
  assert.match(transcriptSource, /function delegateThinkingLevel\(message: UiMessage\)/);
  assert.match(transcriptSource, /value === "off"/);
  assert.doesNotMatch(transcriptSource, /thinkingLevel\./);
});

test("the report is printed once: in the body, or as the nested answer", () => {
  assert.match(
    transcriptSource,
    /const nestedReport = delegate\?\.items\.some\(\(item\) => item\.kind === "answer"\)/,
  );
  assert.match(
    transcriptSource,
    /\.\.\.\(nestedReport \? \{ hideDelegateReport: true \} : \{\}\)/,
  );
});

test("memoized activity rows compare delegate runs by their rows", () => {
  // Runs are rebuilt on every message change, so an identity check would
  // freeze a streaming delegate's rows.
  assert.match(
    transcriptSource,
    /function activityItemsEqual\([\s\S]*?subagentRunsEqual\(previous\.delegate, next\.delegate\)/,
  );
  assert.equal(transcriptSource.match(/activityItemsEqual\(/g)?.length, 3);
});

test("the nested run is visibly one level inside the call", () => {
  // D297: the run is a soft tile; the collapse rail draws nothing at rest and
  // only shows its bar as a hover/focus affordance.
  assert.match(messagesCss, /\.subagent-run \{[^}]*background: var\(--ds-tile\)/);
  assert.match(
    messagesCss,
    /\.disclosure-collapse-rail::before \{[^}]*background: transparent/,
  );
  assert.doesNotMatch(messagesCss, /\.subagent-run > \.disclosure-collapse-rail::before/);
  assert.match(messagesCss, /\.subagent-run \{[^}]*margin: 2px 0 8px 24px/);
  assert.match(messagesCss, /\.subagent-run-count \{[^}]*margin-inline-start: auto/);
  assert.match(messagesCss, /\.tool-row-agent \{/);
});

test("every Task call renders as one accessible card", () => {
  // One delegation gets the same card as a fan-out: the compact row hid the
  // outcome, runtime and progress the card states outright.
  // The transcript hands each delegation start its own card…
  assert.match(activityItemsSource, /variant="task"/);
  assert.match(
    activityItemsSource,
    /\.\.\.\(delegationStatuses \? \{ delegationStatuses \} : \{\}\)/,
  );
  // …and the row becomes that card instead of a disclosure.
  assert.match(
    transcriptSource,
    /if \(variant === "task"\) return <SubagentTaskCard \{\.\.\.props\} \/>;/,
  );
  assert.match(
    taskCardSource,
    /className=\{`tool-row subagent-task\$\{panelOpen \? " is-panel-open" : ""\}/,
  );
  // One button per card, and the stop handle is its sibling: no nested button,
  // and no expanded state on a card that opens a tab rather than a body.
  assert.match(taskCardSource, /<button\s+type="button"\s+className="subagent-task-card"/);
  assert.match(taskCardSource, /\{delegationId \? \(\s*<SubagentStopButton/);
  assert.doesNotMatch(taskCardSource, /aria-expanded/);
  assert.doesNotMatch(taskCardSource, /tool-row-caret/);
  assert.doesNotMatch(taskCardSource, /tool-row-body/);
  // The card opens the child's transcript, and reports the tab it has open.
  assert.match(taskCardSource, /openSubagentTab\(panelSelectionId, title\)/);
  assert.match(
    taskCardSource,
    /const panelOpen = activeWorkPanelTabId === `subagent:\$\{panelSelectionId\}`/,
  );
  assert.match(storeSource, /openWorkPanelTab\(subagentWorkPanelTab\(id, title \|\| undefined\)\)/);
});
test("a card states its own delegation status, with no aggregate count", () => {
  // The group no longer summarizes delegations: each `Task` call states its own
  // outcome in the delegation vocabulary, so a lone child is never described by
  // a count that only makes sense for a fan-out.
  assert.match(
    taskCardSource,
    /const statusLabel = creating\s*\n\s*\? t\("chat\.subagentCreating"\)\s*\n\s*: t\(`chat\.subagentStatus\.\$\{outcome\}`\)/,
  );
  assert.doesNotMatch(transcriptSource, /subagentSummary/);
  assert.doesNotMatch(transcriptSource, /chat\.subagentsFinished/);
  for (const [locale, source] of [
    ["en", englishCatalogSource],
    ["zh-CN", chineseCatalogSource],
    ["tr", turkishCatalogSource],
  ]) {
    for (const status of [
      "running",
      "completed",
      "failed",
      "timed_out",
      "aborted",
      "denied",
    ]) {
      assert.match(source, new RegExp(`\\n\\s*${status}: "`), `${locale} ${status}`);
    }
  }
});
test("a delegation card is a low-noise raised tile in the ordinary group", () => {
  // D297: the card is a raised tile; it carries no border, no connectors and no
  // dotted canvas, and its status icon is the only colour-bearing mark.
  assert.match(messagesCss, /\.subagent-task-card \{[^}]*background: var\(--ds-raised\)/);
  assert.doesNotMatch(messagesCss, /\.subagent-task-card \{[^}]*border:/);
  assert.doesNotMatch(messagesCss, /subagent-topology/);
  assert.doesNotMatch(messagesCss, /\.tool-activity-group\.has-subagents/);
  assert.match(
    messagesCss,
    /\.subagent-task\[data-outcome="completed"\] \.subagent-task-status-icon \{[^}]*background: var\(--ds-success\)/,
  );
  assert.match(
    messagesCss,
    /\.subagent-task\[data-outcome="failed"\] \.subagent-task-status-icon \{[^}]*background: var\(--ds-error\)/,
  );
  assert.match(messagesCss, /\.subagent-task\[data-outcome="timed_out"\]/);
  assert.match(messagesCss, /\.subagent-task-card:focus-visible/);
});
test("a delegate's rows scroll in place instead of growing the page (D271)", () => {
  // The rows live in their own scroll container, not on `.subagent-run`: the
  // collapse rail is absolutely positioned outside that element's padding box,
  // so an overflow there would clip the rail away.
  assert.match(transcriptSource, /subagent-run-rows/);
  // The scroll area is named by the run heading beside it rather than by a
  // duplicated label string.
  assert.match(
    transcriptSource,
    /className=\{`subagent-run-rows\$\{scrollable \? "" : " is-panel-flow"\}`\}[\s\S]*?role="group"[\s\S]*?tabIndex=\{scrollable \? 0 : undefined\}[\s\S]*?aria-labelledby=\{headingId\}/,
  );
  assert.match(
    transcriptSource,
    /className=\{dock \? "subagent-run-heading is-dock" : "subagent-run-heading"\}[\s\S]*?id=\{headingId\}/,
  );
  assert.match(
    messagesCss,
    /\.subagent-run-rows \{[^}]*max-height: min\(420px, 48dvh\)/,
  );
  assert.match(messagesCss, /\.subagent-run-rows \{[^}]*overflow-y: auto/);
  assert.match(
    messagesCss,
    /\.subagent-run-rows \{[^}]*overscroll-behavior-y: contain/,
  );
  assert.match(
    messagesCss,
    /\.subagent-run-rows \{[^}]*overflow-anchor: none/,
  );
  // A keyboard user can reach the scroll area the pointer already can.
  assert.match(messagesCss, /\.subagent-run-rows:focus-visible \{/);
  // `.subagent-run` itself must stay unclipped so the rail survives.
  assert.doesNotMatch(messagesCss, /\.subagent-run \{[^}]*overflow/);
  // Every field table is bounded too, so a long roster scrolls as well.
  assert.match(messagesCss, /\.tool-fields \{[^}]*max-height: 260px/);
  assert.match(messagesCss, /\.tool-fields \{[^}]*overflow: auto/);
});

test("an expanded delegate run follows the latest output while pinned (D302)", () => {
  // Nested follow is a dedicated hook so the main transcript's history,
  // veil, and pane-visibility machinery stay out of the run scroller.
  assert.match(transcriptSource, /function SubagentRunFollow\(/);
  assert.match(transcriptSource, /const \{[^}]*scrollRef,[^}]*\} = useFollowScroll\(\)/);
  assert.match(
    transcriptSource,
    /<SubagentRunFollow[\s\S]*?headingId=\{headingId\}[\s\S]*?items=\{run\.items\}/,
  );
  assert.match(
    transcriptSource,
    /className=\{`subagent-run-rows\$\{scrollable \? "" : " is-panel-flow"\}`\}[\s\S]*?onScroll=\{scrollable \? handleScroll : undefined\}/,
  );
  assert.match(transcriptSource, /className="subagent-run-follow"/);
  assert.match(
    transcriptSource,
    /className="jump-latest-btn"[\s\S]*?onClick=\{jumpToLatest\}/,
  );

  assert.match(followScrollSource, /export function useFollowScroll\(/);
  assert.match(followScrollSource, /reduceTranscriptScroll\(/);
  assert.match(followScrollSource, /isRecentScrollGesture\(/);
  assert.match(
    followScrollSource,
    /const followScrollNow = useCallback\(\(\) => \{[\s\S]{0,400}?if \(!pinnedRef\.current\) return;\s*cancelFollowScroll\(\);\s*scrollToBottom\(\);/,
  );
  assert.match(followScrollSource, /new ResizeObserver\(followScrollNow\)/);
  assert.doesNotMatch(
    followScrollSource,
    /new ResizeObserver\(scheduleFollowScroll\)/,
  );

  // The jump control overlays the bounded scroller; overflow stays off
  // `.subagent-run` so the collapse rail is not clipped.
  assert.match(messagesCss, /\.subagent-run-follow \{[^}]*position: relative/);
  assert.match(
    messagesCss,
    /\.subagent-run-follow > \.jump-latest-btn \{[^}]*bottom: 8px/,
  );
  assert.doesNotMatch(messagesCss, /\.subagent-run \{[^}]*overflow/);
});

test("a delegation keeps its card live after the parent leaves the tail (D319)", () => {
  // Parent Read/Grep/thinking after a Task call is a later activity part, so the
  // card is not the turn's live tail while its delegate is still running: the
  // group derives its own liveness from the delegation, and draws no subagent
  // chrome of its own.
  assert.match(
    transcriptSource,
    /const delegationLive = useMemo\(\s*\(\) => delegateItems\.some\(\(item\) => subagentOutcome\(item\.message, delegationStatuses\) === "running"\),/,
  );
  assert.match(transcriptSource, /const live = isActive \|\| delegationLive/);
  // A `Task` group renders through the ordinary process group, so no group-level
  // A `Task` group renders through the ordinary process group, so no group-level
  // summary, connector or stop-all can come back, and no segment draws a fold of
  // its own any more.
  assert.match(
    transcriptSource,
    /<ProcessActivityGroup items=\{visibleItems\}>/,
  );
  assert.doesNotMatch(transcriptSource, /hasSubagentTopology|subagentSummary|summarizeSubagentActivity/);
  // The card is one raised tile inside that group, inset from the row it sits in.
  assert.match(messagesCss, /\.tool-row\.subagent-task \{[^}]*margin: 4px 0/);
  assert.match(messagesCss, /\.subagent-task-card \{[^}]*padding: 10px/);
});
