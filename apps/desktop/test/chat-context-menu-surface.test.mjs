import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const styles = await loadStyles();
const menuSource = await readFile(
  new URL("../src/components/ContextMenu.tsx", import.meta.url),
  "utf8",
);
const transcriptSource = await readFile(
  new URL("../src/features/chat/transcript/ChatTranscript.tsx", import.meta.url),
  "utf8",
);
const messageRowSource = await readFile(
  new URL("../src/features/chat/transcript/MessageRow.tsx", import.meta.url),
  "utf8",
);
const assistantTurnSource = await readFile(
  new URL("../src/features/chat/transcript/AssistantTurn.tsx", import.meta.url),
  "utf8",
);
const transcriptMenuSource = await readFile(
  new URL("../src/features/chat/transcript/TranscriptMenu.tsx", import.meta.url),
  "utf8",
);

test("the pointer-anchored menu portals, measures, and closes without trapping focus", () => {
  assert.match(menuSource, /portalToBody\(/);
  assert.match(menuSource, /placeContextMenu\(/);
  assert.match(menuSource, /className=\{`context-menu\$\{placement \? " is-open" : ""\}`\}/);
  assert.match(menuSource, /window\.addEventListener\("pointerdown", onOutside, true\)/);
  assert.match(menuSource, /window\.addEventListener\("keydown", onKeyDown, true\)/);
  assert.match(menuSource, /if \(event\.key === "Tab"\)/);
  assert.match(menuSource, /onContextMenu=\{/);
  assert.match(menuSource, /export function readContextMenuSelection\(root: EventTarget\): string/);
  assert.match(menuSource, /live\.isCollapsed/);
  assert.match(menuSource, /root\.contains\(anchorNode\)/);
  assert.match(menuSource, /root\.contains\(focusNode\)/);
  assert.match(menuSource, /item\.onSelect\(state\.selection\)/);
  assert.match(menuSource, /if \(!request\.items\.length\) return;/);
});

test("the transcript owns one selected-text menu and each surface opens it gated", () => {
  assert.match(transcriptSource, /<TranscriptMenuProvider>/);
  assert.match(transcriptSource, /onContextMenu=\{onContextMenu\}/);
  assert.match(transcriptSource, /openSelectedTextMenu\(event\)/);
  assert.match(messageRowSource, /onContextMenu=\{onContextMenu\}/);
  assert.match(messageRowSource, /openSelectedTextMenu\(event\)/);
  assert.match(assistantTurnSource, /onContextMenu=\{onContextMenu\}/);
  assert.match(assistantTurnSource, /openSelectedTextMenu\(event\)/);
});

test("the transcript gate opens nothing without a selection", () => {
  assert.match(transcriptMenuSource, /readContextMenuSelection\(event\.currentTarget\)/);
  assert.match(transcriptMenuSource, /if \(!readContextMenuSelection\(event\.currentTarget\)\) return;/);
  assert.match(transcriptMenuSource, /selectedTextMenuItems\(/);
  assert.doesNotMatch(transcriptSource, /conversationMenuItems/);
  assert.doesNotMatch(transcriptSource, /copyConversation/);
  assert.doesNotMatch(messageRowSource, /userMessageMenuItems/);
  assert.doesNotMatch(assistantTurnSource, /assistantTurnMenuItems/);
  assert.doesNotMatch(messageRowSource, /select-text/);
  assert.doesNotMatch(assistantTurnSource, /select-text/);
});

test("the transcript gate requires the pointer to hit the selected text", () => {
  assert.match(menuSource, /export function contextMenuClickHitsSelection\(/);
  assert.match(menuSource, /export function clearChatSelection\(/);
  assert.match(menuSource, /getClientRects\(\)/);
  assert.match(transcriptMenuSource, /contextMenuClickHitsSelection\(event\.currentTarget, point\)/);
  assert.match(transcriptMenuSource, /clearChatSelection\(event\.currentTarget\)/);
});
test("the context-menu surface is a measured fixed layer", () => {
  const rule = styles.match(/\.context-menu\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(rule, /position:\s*fixed/);
  assert.match(rule, /z-index:\s*60/);
  assert.match(rule, /visibility:\s*hidden/);
  assert.match(styles, /\.context-menu\.is-open\s*\{[\s\S]*?visibility:\s*visible/);
});
