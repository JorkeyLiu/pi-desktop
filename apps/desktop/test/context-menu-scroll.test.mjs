import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contextMenuSource = await readFile(
  new URL("../src/components/ContextMenu.tsx", import.meta.url),
  "utf8",
);
const workPanelSource = await readFile(
  new URL("../src/components/workpanel/WorkPanel.tsx", import.meta.url),
  "utf8",
);
const transcriptMenuSource = await readFile(
  new URL(
    "../src/features/chat/transcript/TranscriptMenu.tsx",
    import.meta.url,
  ),
  "utf8",
);
const transcriptScrollSource = await readFile(
  new URL(
    "../src/features/chat/transcript/hooks/useTranscriptScroll.ts",
    import.meta.url,
  ),
  "utf8",
);
const contextMenuLibSource = await readFile(
  new URL("../src/lib/context-menu.ts", import.meta.url),
  "utf8",
);

test("no window scroll listener can close the shared menu", () => {
  assert.doesNotMatch(contextMenuSource, /addEventListener\("scroll"/);
  assert.doesNotMatch(contextMenuSource, /removeEventListener\("scroll"/);
  assert.doesNotMatch(transcriptMenuSource, /addEventListener\("scroll"/);
});

test("no scroll boundary or target filtering remains", () => {
  for (const source of [
    contextMenuSource,
    contextMenuLibSource,
    workPanelSource,
  ]) {
    assert.doesNotMatch(source, /scrollBoundary/);
  }
  assert.doesNotMatch(contextMenuSource, /shouldDismissContextMenuOnScroll/);
  assert.doesNotMatch(contextMenuLibSource, /shouldDismissContextMenuOnScroll/);
});

test("the menu documents that behind-surface scrolls leave it up", () => {
  assert.match(contextMenuSource, /never\n \* on a scroll behind it/);
});

test("an outside press still closes the menu", () => {
  assert.match(
    contextMenuSource,
    /window\.addEventListener\("pointerdown", onOutside, true\)/,
  );
  assert.match(
    contextMenuSource,
    /window\.addEventListener\("contextmenu", onOutside, true\)/,
  );
});

test("Escape, Tab, resize, and blur still close the menu", () => {
  assert.match(contextMenuSource, /event\.key !== "Escape"/);
  assert.match(contextMenuSource, /if \(event\.key === "Tab"\) \{\n {6}onClose\(\);/);
  assert.match(contextMenuSource, /window\.addEventListener\("resize", onClose\)/);
  assert.match(contextMenuSource, /window\.addEventListener\("blur", onClose\)/);
});

test("item selection and unmount cleanup still close the menu", () => {
  assert.match(
    contextMenuSource,
    /onClose\(\);\n {14}item\.onSelect\(state\.selection\);/,
  );
  for (const name of [
    "pointerdown",
    "contextmenu",
    "resize",
    "blur",
    "keydown",
  ]) {
    assert.match(
      contextMenuSource,
      new RegExp(`window\\.removeEventListener\\("${name}"`),
    );
  }
});

test("the right-dock tab menu opens through the shared menu with no scroll hook", () => {
  assert.match(
    workPanelSource,
    /openContextMenu\(event, tabMenuRequest\(tab\)\)/,
  );
  assert.match(workPanelSource, /<ContextMenu state=\{contextMenu\}/);
});

test("the default transcript menu inherits the no-scroll-close behavior", () => {
  assert.match(transcriptMenuSource, /<ContextMenu state=\{contextMenu\}/);
});

test("transcript follow-scroll never clears the menu directly", () => {
  assert.doesNotMatch(transcriptScrollSource, /ContextMenu/);
  assert.doesNotMatch(transcriptScrollSource, /closeContextMenu/);
});
