import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShell = await readFile(
  new URL("../src/features/app/AppShell.tsx", import.meta.url),
  "utf8",
);
const settingsPage = await readFile(
  new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const secondaryWindows = await readFile(
  new URL("../src/features/app/SecondaryWindows.tsx", import.meta.url),
  "utf8",
);

test("chat shell stays mounted and inert instead of hidden while a window is open", () => {
  const chatShell = appShell.match(
    /<div\s+className="app-chat-shell"[\s\S]*?>/,
  )?.[0];

  assert.ok(chatShell, "chat shell must exist");
  // `hidden`/`display: none` would drop the transcript scroll offset, so the
  // shell is only inert. `aria-hidden` on it would hide the focused descendant
  // the inert subtree still contains.
  assert.doesNotMatch(chatShell, /hidden=/);
  assert.match(chatShell, /inert=\{page === "chat" \? undefined : true\}/);
  assert.doesNotMatch(chatShell, /aria-hidden/);
  assert.match(appShell, /<PortalVisibilityProvider visible=\{page === "chat"\}>/);
});

test("opening a window lands focus on the plate container and closing restores the opener", () => {
  assert.match(secondaryWindows, /previousFocusRef\.current = active/);
  // Initial focus goes to the plate container, never the close control: the
  // close control's tooltip would otherwise paint uninvited with the pointer
  // elsewhere. Tab from the container reaches that control first.
  assert.match(secondaryWindows, /const root = windowRefs\.current\.get\(kind\);/);
  assert.match(secondaryWindows, /root\?\.isConnected\) root\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(secondaryWindows, /closeRefs\.current\.get\(kind\)\?\.focus/);
  assert.match(secondaryWindows, /previous\.focus\(\{ preventScroll: true \}\)/);
  // Settings no longer owns a back-to-app action: the plate's control row is
  // the exit, so the page itself carries no focus bootstrap of its own.
  assert.doesNotMatch(settingsPage, /settingsBackRef/);
  assert.doesNotMatch(settingsPage, /data-nav="back-to-app"/);
  assert.doesNotMatch(settingsPage, /settingsSearchRef/);
  assert.doesNotMatch(settingsPage, /settings-search-wrap/);
});

test("chat code loads inside the existing route boundary and stays mounted under a window", () => {
  assert.match(
    appShell,
    /const loadChatSurface = \(\) => import\("\.\.\/\.\.\/components\/ChatSurface"\)/,
  );
  assert.match(appShell, /const ChatSurface = lazy\(\(\) =>\s*loadChatSurface\(\)/);
  assert.match(appShell, /useEffect\(\(\) => \{\s*void loadChatSurface\(\)\.catch/);
  assert.doesNotMatch(appShell, /import \{ ChatSurface \} from/);
  assert.match(
    appShell,
    /<Suspense fallback=\{<RoutePending \/>\}>\s*<ChatSurface \/>\s*<\/Suspense>/,
  );
  assert.doesNotMatch(appShell, /ChatSurface visible=/);
  assert.match(appShell, /<SecondaryWindows page=\{page\} onClose=\{closeSecondaryWindow\} \/>/);
});
