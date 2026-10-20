import { readAppSource, readStoreSource, readTranscriptSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const tabSource = await readFile(
  new URL("../src/components/workpanel/SubagentTranscriptTab.tsx", import.meta.url),
  "utf8",
);
const workPanelSource = await readFile(
  new URL("../src/components/workpanel/WorkPanel.tsx", import.meta.url),
  "utf8",
);
const tabsSource = await readFile(
  new URL("../src/lib/work-panel-tabs.ts", import.meta.url),
  "utf8",
);
const appSource = await readAppSource();
const transcriptSource = await readTranscriptSource();
const storeSource = await readStoreSource();
const workPanelCss = await readFile(
  new URL("../src/styles/work-panel.css", import.meta.url),
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


test("a Task card opens a real subagent tab in the work panel", () => {
  assert.match(transcriptSource, /const openSubagentTab = useAppStore\(\(state\) => state\.openSubagentTab\)/);
  assert.match(transcriptSource, /const panelSelectionId = delegationId \|\| message\.toolCallId \|\| message\.id;/);
  assert.match(transcriptSource, /openSubagentTab\(panelSelectionId, title\)/);
  assert.match(
    transcriptSource,
    /activeWorkPanelTabId === `subagent:\$\{panelSelectionId\}`/,
  );
  // Nothing to read until the call reports its delegation, so an empty card
  // stays disabled rather than opening a tab with no transcript behind it.
  assert.match(
    transcriptSource,
    /const canOpen =\s*localToolsAllowed &&\s*\(Boolean\(delegationId\) \|\| \(delegate\?\.items\.length \?\? 0\) > 0\);/,
  );
  assert.match(transcriptSource, /disabled=\{!canOpen\}/);
  assert.match(storeSource, /openSubagentTab: \(delegationId, title\) => \{/);
  assert.match(
    storeSource,
    /openWorkPanelTab\(subagentWorkPanelTab\(id, title \|\| undefined\)\)/,
  );
  // The overlay state and its actions are gone: closing happens per tab.
  assert.doesNotMatch(storeSource, /subagentPanel/);
  assert.doesNotMatch(storeSource, /toggleSubagentPanel|closeSubagentPanel/);
  assert.match(tabsSource, /\| "plugin"\s*\|\s*"subagent";/);
  assert.match(
    tabsSource,
    /export function subagentWorkPanelTab\(\s*delegationId: string,\s*title\?: string,\s*\): WorkPanelTab \{/,
  );
  assert.match(tabsSource, /id: `subagent:\$\{delegationId\}`/);
  assert.match(tabsSource, /tab\.kind === "subagent"\)/);
  // Retained runtime state must survive the session-switch sanitizer.
  assert.match(tabsSource, /export function subagentTabDisplayLabels\(/);
  assert.match(tabsSource, /tab\.kind === "subagent"\)/);
  // Retained runtime state must survive the session-switch sanitizer.
  assert.match(tabsSource, /export function subagentTabDisplayLabels\(/);
});

test("the work panel renders the delegation tab like every other resource", () => {
  assert.match(workPanelSource, /subagent: IconBot/);
  assert.match(workPanelSource, /if \(tab\.kind === "subagent"\) return tab\.label \?\? t\("panel\.tabs\.subagent"\);/);
  assert.match(workPanelSource, /const subagentTabsInOrder = tabs\.filter\(\(tab\) => tab\.kind === "subagent"\)/);
  assert.match(workPanelSource, /subagentTabDisplayLabels\(/);
  assert.match(workPanelSource, /\{activeTab\?\.kind === "subagent" && \(/);
  assert.match(
    workPanelSource,
    /<SubagentTranscriptTab delegationId=\{activeTab\.resource \?\? ""\} \/>/,
  );
  // The tab strip is never replaced by a dock heading or a back control.
  assert.doesNotMatch(workPanelSource, /work-panel-subagent-heading|work-panel-subagent-back/);
  assert.doesNotMatch(workPanelSource, /subagentPanel\?: SubagentPanelSelection/);
  assert.doesNotMatch(workPanelSource, /!subagentPanel &&/);
  // The shell no longer overrides visibility for a dock-only surface.
  assert.match(appSource, /const workPanelVisible = workPanelOpen;/);
  assert.doesNotMatch(appSource, /subagentPanelOpen/);
});

test("the delegation tab renders a message list with a child composer", () => {
  assert.match(tabSource, /data-testid="subagent-transcript-tab"/);
  // Chain-latest owns the view (F5): after d1 -> d2 the old tab follows the
  // same chain, so transcript, status, send, stop and resume all resolve
  // through the latest id — a stale tab never duplicates the action.
  assert.match(tabSource, /subagentChainLatestDelegationId\(messages, delegationId\)/);
  assert.match(tabSource, /isStaleSubagentTab\(messages, delegationId\)/);
  assert.match(tabSource, /buildSubagentTranscript\(messages, activeDelegationId\)/);
  assert.match(tabSource, /className="message-row user"/);
  assert.match(tabSource, /className="message-user-text selectable"/);
  assert.match(tabSource, /className="message-row assistant"/);
  assert.match(tabSource, /data-message-id=\{row\.message\.id\}/);
  assert.match(tabSource, /<Textarea/);
  assert.match(tabSource, /disabled/);
  assert.match(tabSource, /rows=\{2\}/);
  assert.match(tabSource, /readonlyReason \?\? t\("panel\.subagentReadOnly"\)/);
  assert.match(tabSource, /className="subagent-transcript-composer-controls"/);
  assert.match(tabSource, /subagent-transcript-model-static/);
  assert.doesNotMatch(tabSource, /subagent-transcript-model-picker/);
  assert.match(tabSource, /delegateModelId\(result\)/);
  assert.match(tabSource, /delegateThinkingLevel\(result\)/);
  assert.match(tabSource, /<SubagentStopButton delegationId=\{activeDelegationId\} running compact \/>/);
  assert.doesNotMatch(tabSource, /subagent-transcript-actions/);
  assert.match(workPanelCss, /\.subagent-transcript-composer-controls \{/);
  assert.match(workPanelCss, /\.subagent-transcript-model-static \{/);
  // Live send paths: a running delegate steers the child channel directly;
  // a settled instantiated delegate continues directly through the backend —
  // never a parent `Task(resume)` text prompt, never into the parent context.
  assert.match(tabSource, /await api\.steerSubagent\(\{/);
  assert.match(tabSource, /captureSteerIdentity\(\{/);
  assert.match(tabSource, /shouldShowSubagentContinue\(\{/);
  assert.match(tabSource, /captureContinueIdentity\(\{/);
  assert.match(tabSource, /await api\.continueSubagent\(\{/);
  assert.match(tabSource, /shouldClearSteerDraft\(\{/);
  assert.doesNotMatch(tabSource, /shouldShowSubagentResume\(\{/);
  assert.doesNotMatch(tabSource, /buildSubagentResumePrompt/);
  assert.doesNotMatch(tabSource, /askParentToResume/);
  assert.doesNotMatch(tabSource, /sendPrompt\(/);
  // Display-only where no action exists: the blocked composer names its own
  // capability reason (stale/no-instance/remote), while an instantiated
  // settled child always continues regardless of its outcome. The model
  // picker never opens.
  assert.match(tabSource, /aria-label=\{readonlyReason \?\? t\("panel\.subagentReadOnly"\)\}/);
  assert.match(tabSource, /panel\.subagentStale/);
  assert.match(tabSource, /panel\.subagentNoInstance/);
  assert.match(tabSource, /subagentChainInstantiated\(/);
});

test("the tab owns one scroll surface and pins to the latest output", () => {
  assert.match(workPanelCss, /\.subagent-transcript-tab \{[^}]*flex-direction: column/);
  assert.match(workPanelCss, /\.subagent-transcript-scroll \{[^}]*overflow-y: auto/);
  // The only scroll surface reserves its gutter whether or not the rows
  // overflow: an opened command detail never narrows the content beside it.
  assert.match(
    workPanelCss,
    /\.subagent-transcript-scroll \{[^}]*scrollbar-gutter: stable;/,
  );
  assert.match(tabSource, /useFollowScroll\(\)/);
  assert.match(tabSource, /ref=\{scrollRef\}/);
  assert.match(tabSource, /onScroll=\{handleScroll\}/);
  assert.match(tabSource, /onClick=\{jumpToLatest\}/);
  assert.match(tabSource, /role="log"/);
  assert.match(tabSource, /aria-live="polite"/);
  assert.match(tabSource, /tabIndex=\{0\}/);
  assert.match(tabSource, /useTranscriptSearchFocus\(\{/);
});

test("composer copy names the driver and lives in the field, per locale", () => {
  for (const [locale, source] of [
    ["en", englishCatalogSource],
    ["zh-CN", chineseCatalogSource],
  ]) {
    assert.match(source, /subagentReadOnly: "/);
    assert.match(source, /tabs: \{[^}]*subagent: "/s);
    assert.doesNotMatch(source, /subagentClose/);
  }
});
