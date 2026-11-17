/**
 * Automatic session titles have two layers: host-core derives a deterministic
 * title from the first prompt so a new session is readable offline, and an
 * optional title plugin may later upgrade it with a model-composed title.
 * These tests lock both halves and the boundary between them.
 */
import { readMainSource, readStoreSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import i18n from "i18next";
import { catalogs } from "@pi-desktop/i18n";
import {
  isDefaultSessionTitle,
  promptFallbackSessionTitle,
  untitledTaskTitle,
} from "../src/lib/session-title-utils.ts";

// The helper reads the app's i18n singleton, so initialize it with the real
// English catalog instead of leaving `t()` returning keys.
await i18n.init({
  lng: "en",
  resources: Object.fromEntries(
    Object.entries(catalogs).map(([locale, translation]) => [locale, { translation }]),
  ),
});
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [api, protocol, host, rpc, queueSlice, main, store] = await Promise.all([
  read("../src/lib/api.ts"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../../../crates/host-core/src/sessions.rs"),
  read("../../../crates/host-core/src/rpc/mod.rs"),
  read("../src/stores/slices/queue-slice.ts"),
  readMainSource(),
  readStoreSource(),
]);

test("the first prompt becomes an immediate title, collapsed and capped", () => {
  assert.equal(promptFallbackSessionTitle("  Fix\n the\tlogin  ", "New task"), "Fix the login");
  assert.equal(promptFallbackSessionTitle("p".repeat(60), "New task"), "p".repeat(48));
  assert.equal(promptFallbackSessionTitle("   ", "New task"), "New task");
  assert.equal(promptFallbackSessionTitle("界".repeat(60), "New task"), "界".repeat(48));
});

test("a new session is created with the catalog's canonical placeholder", async () => {
  // host-core persists this exact string and recognizes a placeholder only by
  // an exact, case-sensitive match, so the created title must keep the
  // catalog's casing instead of a normalized copy. A lowercased title was
  // stored as `title_source = manual`, which blocked both the prompt fallback
  // and every automatic title.
  assert.equal(untitledTaskTitle(), "New task");
  await i18n.changeLanguage("zh-CN");
  try {
    assert.equal(untitledTaskTitle(), "新建任务");
  } finally {
    await i18n.changeLanguage("en");
  }
  // The create path spends that canonical value, not a local lowercase copy.
  assert.match(store, /title: untitledTaskTitle\(\)/);
  // Matching itself stays case-insensitive, so a displayed or legacy
  // lowercased placeholder is still recognized.
  for (const title of ["New task", "new task", "NEW TASK", " New task ", "新建任务", "새 작업"]) {
    assert.equal(isDefaultSessionTitle(title), true, title);
  }
  assert.equal(isDefaultSessionTitle("Fix login"), false);
});

test("every shipped placeholder title is a default title in its own locale", async () => {
  const placeholderTitles = host.slice(
    host.indexOf("const PLACEHOLDER_TITLES"),
    host.indexOf("];", host.indexOf("const PLACEHOLDER_TITLES")),
  );
  assert.ok(placeholderTitles.length > 0, "host-core must keep an eligibility list");
  // A session created under a non-English locale persists that catalog label,
  // so both host-core's eligibility list and this renderer helper have to
  // recognize every shipped `chat.untitledTask` value, not just the English one.
  for (const [locale, translation] of Object.entries(catalogs)) {
    const placeholder = translation.chat.untitledTask;
    await i18n.changeLanguage(locale);
    try {
      assert.equal(untitledTaskTitle(), placeholder, `${locale} canonical title`);
      assert.equal(isDefaultSessionTitle(placeholder), true, `${locale} ${placeholder}`);
      assert.equal(
        isDefaultSessionTitle(placeholder.toLowerCase()),
        true,
        `${locale} lowercased ${placeholder}`,
      );
    } finally {
      await i18n.changeLanguage("en");
    }
    assert.ok(
      placeholderTitles.includes(`"${placeholder}"`),
      `host-core must recognize the ${locale} placeholder`,
    );
  }
  // Recognition stays a placeholder check, never a casing-insensitive wildcard.
  assert.equal(isDefaultSessionTitle("Fix login"), false);
});

test("the fallback only fires for a still-untitled session the owning host can title", () => {
  assert.equal(isDefaultSessionTitle(promptFallbackSessionTitle("Fix login", "New task")), false);
  assert.equal(isDefaultSessionTitle(untitledTaskTitle()), true);
  // A placeholder is recognized in every shipped locale, not just the active one.
  for (const placeholder of [
    "새 작업",
    "新建任務",
    "Tarefa sem título",
    "Yeni görev",
    "New chat",
  ]) {
    assert.equal(isDefaultSessionTitle(placeholder), true, placeholder);
  }
  assert.match(queueSlice, /isDefaultSessionTitle\(current\?\.title\)/);
  assert.match(queueSlice, /current\?\.source !== "pi-native"/);
  // A remote session derives on its own host through this same call — the
  // backend router forwards it to the owning `pi-host` — so the gate must not
  // exclude remote ids: doing so left every remote task unnamed.
  assert.doesNotMatch(queueSlice, /!isRemoteSession\(/);
  assert.match(
    queueSlice,
    /isDefaultSessionTitle\(current\?\.title\)[\s\S]{0,200}source !== "pi-native"/,
  );
  assert.match(queueSlice, /if \(wasUntitled && current\?\.source !== "pi-native" && !isDefaultSessionTitle\(nextTitle\)\) \{[\s\S]{0,120}api\.deriveSessionTitle\(startedIn, nextTitle\)[\s\S]{0,180}api\.generateSessionTitle\(\{ sessionId: startedIn, prompt: content, fallbackTitle: nextTitle \}\)/);
  assert.match(queueSlice, /if \(wasUntitled && current\?\.source !== "pi-native"/);
});

test("the fallback travels the existing ipc bridge into host-core", () => {
  assert.match(protocol, /sessionDeriveTitle: "pi-desktop\/session\/deriveTitle"/);
  assert.match(api, /invoke<\{ updated: boolean \}>\(IPC\.invoke\.sessionDeriveTitle, id, title\)/);
  assert.match(main, /handle\(IPC\.invoke\.sessionDeriveTitle/);
  assert.match(main, /host\.call\("session\.deriveTitle", \{ id, title \}\)/);
  assert.match(rpc, /"session\.deriveTitle" => \{/);
  assert.match(rpc, /sessions::derive_session_title\(&st\.db, id, &title\)/);
});

test("host-core keeps a derived title replaceable and never touches a named one", () => {
  const deriveStart = host.indexOf("pub fn derive_session_title");
  const deriveBody = host.slice(deriveStart, host.indexOf("pub fn auto_title_context"));
  assert.ok(deriveStart > 0, "derive_session_title must exist");
  // The derived text must stay an automatic title: a plugin may still replace
  // it, so only the title moves and the source stays `default`.
  assert.match(deriveBody, /UPDATE sessions SET title = \?1/);
  assert.doesNotMatch(deriveBody, /title_source = \?1/);
  assert.doesNotMatch(deriveBody, /TITLE_SOURCE_MANUAL/);
  assert.match(deriveBody, /AND title = \?3 AND title_source = \?4 AND deleted_at IS NULL/);
  assert.match(deriveBody, /title_source != TITLE_SOURCE_DEFAULT \|\| !is_default_title\(&current_title\)/);
  assert.match(host, /fn derived_prompt_title_stays_eligible_for_the_title_plugin/);
  assert.match(host, /fn derived_prompt_title_never_overrides_named_sessions/);
});

test("automatic AI titles stay plugin-owned", () => {
  assert.doesNotMatch(api, /summarizeSessionTitle/);
  assert.doesNotMatch(store, /triggerAutoTitleSummarization/);
  assert.doesNotMatch(main, /IPC\.invoke\.sessionSummarizeTitle/);
});
