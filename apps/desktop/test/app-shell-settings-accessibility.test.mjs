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

test("settings hides and inerts chat without aria-hiding a focused descendant", () => {
  const chatShell = appShell.match(
    /<div\s+className="app-chat-shell"[\s\S]*?>/,
  )?.[0];

  assert.ok(chatShell, "chat shell must exist");
  assert.match(chatShell, /hidden=\{page === "settings"\}/);
  assert.match(chatShell, /inert=\{page === "settings" \? true : undefined\}/);
  assert.doesNotMatch(chatShell, /aria-hidden/);
});

test("entering Settings moves focus to the rail's first control", () => {
  // The in-page search pill is gone, so the back action at the rail's top-left
  // is the first focus stop and must receive focus on entry.
  assert.match(
    settingsPage,
    /const settingsBackRef = useRef<HTMLButtonElement>\(null\)/,
  );
  assert.match(
    settingsPage,
    /settingsBackRef\.current\?\.focus\(\{ preventScroll: true \}\)/,
  );
  assert.match(settingsPage, /ref=\{settingsBackRef\}/);
  assert.doesNotMatch(settingsPage, /settingsSearchRef/);
  assert.doesNotMatch(settingsPage, /settings-search-wrap/);
  assert.doesNotMatch(settingsPage, /<input\s+ref=/);
});

test("chat code loads inside the existing route boundary and stays mounted in Settings", () => {
  assert.match(
    appShell,
    /const loadChatSurface = \(\) => import\("\.\.\/\.\.\/components\/ChatSurface"\)/,
  );
  assert.match(appShell, /const ChatSurface = lazy\(\(\) =>\s*loadChatSurface\(\)/);
  assert.match(appShell, /useEffect\(\(\) => \{\s*void loadChatSurface\(\)\.catch/);
  assert.doesNotMatch(appShell, /import \{ ChatSurface \} from/);
  assert.match(
    appShell,
    /<Suspense fallback=\{<RoutePending \/>\}>[\s\S]*?<ChatSurface visible=\{page === "chat"\} \/>[\s\S]*?<\/Suspense>/,
  );
  assert.match(
    appShell,
    /className="app-chat-shell"[\s\S]*?hidden=\{page === "settings"\}[\s\S]*?<ChatSurface visible=\{page === "chat"\} \/>/,
  );
});
