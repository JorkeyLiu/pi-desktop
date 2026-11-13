/**
 * Developer-only settings destinations are retained in development builds
 * but omitted from packaged builds. Cloud sync and Remote Hosts are
 * Experimental destinations available in every build. Navigation, search,
 * and stale-page handling must honor the same visibility rules.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SETTINGS_NAV,
  isSettingsDestinationHidden,
  resolveSettingsTab,
  searchSettings,
  visibleSettingsNav,
} from "../src/lib/settings-search.ts";

const settingsPage = readFileSync(
  new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const searchDialog = readFileSync(
  new URL("../src/components/SearchDialog.tsx", import.meta.url),
  "utf8",
);
const composer = readFileSync(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const composerToolbar = readFileSync(
  new URL("../src/features/chat/composer/ComposerToolbar.tsx", import.meta.url),
  "utf8",
);

const liveVoiceSettings = readFileSync(
  new URL(
    "../src/features/settings/voice/LiveVoiceSettings.tsx",
    import.meta.url,
  ),
  "utf8",
);
const settingsPrimitives = readFileSync(
  new URL("../src/features/settings/primitives.tsx", import.meta.url),
  "utf8",
);

const identity = (key) => key;
const developerOnlyIds = SETTINGS_NAV.filter(entry => entry.developerOnly === true).map(entry => entry.id);

test("Live Voice and keyboard shortcuts stay reachable inside General", () => {
  for (const developerMode of [false, true]) {
    for (const includeDevelopmentOnly of [false, true]) {
      // Retired rail ids keep working: deep links and plugin navigation that
      // still name voice/shortcuts resolve to the page that renders them.
      assert.equal(resolveSettingsTab("voice"), "general");
      assert.equal(resolveSettingsTab("shortcuts"), "general");
      assert.equal(resolveSettingsTab("general"), "general");
      for (const legacyId of ["voice", "shortcuts"]) {
        assert.equal(
          isSettingsDestinationHidden(legacyId, developerMode, includeDevelopmentOnly),
          false,
        );
      }
      // Neither retired id owns a rail row any more.
      assert.equal(
        visibleSettingsNav(developerMode, includeDevelopmentOnly)
          .some((entry) => entry.id === "voice"),
        false,
      );
      for (const query of [
        "liveVoice.title",
        "liveVoice.enable",
        "liveVoice.provider",
        "liveVoice.adapters.codex-live.title",
        "liveVoice.adapters.gemini-live.title",
        "liveVoice.adapters.openai-realtime.title",
      ]) {
        assert.ok(searchSettings(query, identity, { developerMode, includeDevelopmentOnly })
          .some((hit) => hit.tab === "general"));
      }
    }
  }
  // General has no Experimental badge of its own; the merged rows live there.
  assert.equal(
    SETTINGS_NAV.find((entry) => entry.id === "general")?.experimentalBadgeKey,
    undefined,
  );
});
test("Live Voice navigation enters General and anchors its merged card", () => {
  const navigation = readFileSync(
    new URL("../src/features/voice/live/live-voice-navigation.ts", import.meta.url),
    "utf8",
  );
  // Voice is a retired id: the merged page renders General, so navigation
  // resolves the id instead of storing one the rail no longer offers.
  assert.match(navigation, /resolveSettingsTab\("voice"\)/);
  assert.doesNotMatch(navigation, /setSettingsTab\("voice"\)/);
  assert.match(navigation, /setSettingsTab\(hidden \? "agent" : destination\)/);
  // The card sits below Appearance, storage, network, and power, so the entry
  // also seeds the heading anchor the settings page scrolls to and flashes.
  assert.match(navigation, /setSettingsAnchor\(hidden \? null : "liveVoice\.title"\)/);
  assert.match(navigation, /setPage\("settings"\)/);
  // The anchor key is the card's own heading, which is what the page matches
  // against when it positions the row.
  assert.match(settingsPage, /"\.settings-content \.settings-row-title, \.settings-content \.settings-card-heading/);
  assert.match(liveVoiceSettings, /title={t\("liveVoice\.title"\)}/);
});

test("global settings search lands on the page that renders the row", () => {
  const cases = [
    // Chat owns permissions and default behavior, including the
    // send-while-running mode row.
    ["settings.sendWhileRunningMode", "ai"],
    ["settings.defaultsTitle", "ai"],
    // Live Voice and keyboard shortcuts render inside General.
    ["liveVoice.enable", "general"],
    ["settings.keyboard", "general"],
    ["settings.shortcutResetAll", "general"],
    // The image-generation default row renders on the model page.
    ["settings.imageModel", "agent"],
  ];
  for (const [query, tab] of cases) {
    assert.ok(
      searchSettings(query, identity).some((hit) => hit.tab === tab),
      `${query} must resolve to the ${tab} destination`,
    );
  }
});

test("Cloud sync is Experimental and available in every build", () => {
  for (const developerMode of [false, true]) {
    for (const includeDevelopmentOnly of [false, true]) {
      assert.ok(visibleSettingsNav(developerMode, includeDevelopmentOnly)
        .some((entry) => entry.id === "sync"));
      assert.equal(isSettingsDestinationHidden("sync", developerMode, includeDevelopmentOnly), false);
      for (const query of [
        "configSync.experimental",
        "configSync.connectionTitle",
        "configSync.endpoint",
        "configSync.syncNow",
      ]) {
        assert.ok(searchSettings(query, identity, {
          developerMode,
          includeDevelopmentOnly,
        }).some((hit) => hit.tab === "sync"));
      }
    }
  }
  const sync = SETTINGS_NAV.find((entry) => entry.id === "sync");
  assert.equal(sync?.developerOnly, undefined);
  assert.equal(sync?.developmentOnly, undefined);
  assert.equal(sync?.experimentalBadgeKey, "settings.configSync.experimental");
});

test("Remote Hosts is Experimental and available in every build", () => {
  for (const developerMode of [false, true]) {
    for (const includeDevelopmentOnly of [false, true]) {
      assert.ok(visibleSettingsNav(developerMode, includeDevelopmentOnly)
        .some((entry) => entry.id === "remoteHosts"));
      assert.equal(isSettingsDestinationHidden("remoteHosts", developerMode, includeDevelopmentOnly), false);
    }
  }
  assert.equal(
    SETTINGS_NAV.find((entry) => entry.id === "remoteHosts")?.experimentalBadgeKey,
    "settings.remoteHosts.experimental",
  );
});

test("developer mode retains the developer-only destinations in development", () => {
  const off = visibleSettingsNav(false).map((entry) => entry.id);
  const on = visibleSettingsNav(true).map((entry) => entry.id);

  for (const id of developerOnlyIds) {
    assert.equal(off.includes(id), false);
    assert.equal(on.includes(id), true);
  }
  assert.deepEqual(off, on.filter((id) => !developerOnlyIds.includes(id)));
  assert.deepEqual(
    SETTINGS_NAV.filter((entry) => entry.developerOnly === true).map((entry) => entry.id),
    developerOnlyIds,
  );
  assert.ok(
    SETTINGS_NAV.filter((entry) => entry.developerOnly === true)
      .every((entry) => entry.experimentalBadgeKey),
  );
  // Cloud sync remains available in development builds.
  assert.equal(off.includes("sync"), true);
});

test("packaged builds hide developer-only destinations and retain Experimental surfaces", () => {
  const packaged = visibleSettingsNav(true, false).map((entry) => entry.id);
  for (const id of developerOnlyIds) {
    assert.equal(packaged.includes(id), false);
    assert.equal(isSettingsDestinationHidden(id, true, false), true);
  }
  for (const id of ["sync", "remoteHosts"]) {
    assert.equal(packaged.includes(id), true);
    assert.equal(isSettingsDestinationHidden(id, true, false), false);
    assert.equal(isSettingsDestinationHidden(id, false, false), false);
  }
  assert.equal(isSettingsDestinationHidden("general", true, false), false);
});

test("settings search mirrors developer and packaged visibility", () => {
  for (const options of [{ developerMode: false }, { developerMode: true }]) {
    assert.ok(
      searchSettings("configSync.connectionTitle", identity, options)
        .some((hit) => hit.tab === "sync"),
    );
  }

  for (const options of [
    { developerMode: false, includeDevelopmentOnly: false },
    { developerMode: true, includeDevelopmentOnly: false },
  ]) {
    assert.ok(
      searchSettings("configSync.connectionTitle", identity, options)
        .some((hit) => hit.tab === "sync"),
    );
  }

  for (const developerMode of [false, true]) {
    for (const includeDevelopmentOnly of [false, true]) {
      assert.ok(searchSettings("remotehosts", identity, { developerMode, includeDevelopmentOnly })
        .some(hit => hit.tab === "remoteHosts"));
    }
  }
  assert.equal(searchSettings("settings", identity, { limit: 2 }).length, 2);
});

test("settings routes, global search, and composer use build visibility", () => {
  assert.match(settingsPage, /const includeDevelopmentOnly = import\.meta\.env\.DEV/);
  assert.match(settingsPage, /visibleSettingsNav\(developerMode, includeDevelopmentOnly\)/);
  assert.match(settingsPage, /isSettingsDestinationHidden\([\s\S]*includeDevelopmentOnly/);
  assert.match(settingsPage, /setSettingsTab\("general"\)/);
  assert.match(settingsPage, /tab === "sync" && !tabHidden && <ConfigSyncPage \/>/);
  assert.match(settingsPage, /tab === "remoteHosts" && !tabHidden && <RemoteHostsPage \/>/);
  assert.match(searchDialog, /includeDevelopmentOnly: import\.meta\.env\.DEV/);
  assert.match(composer, /useVoiceInput/);
  assert.doesNotMatch(composer, /VoiceOverlay|voiceEnabled/);
  assert.match(composerToolbar, /<LiveVoiceControls\b/);
  assert.doesNotMatch(composerToolbar, /VoiceMicButton|voicePhase|onVoiceToggle|onVoiceCancel/);
});

test("Live Voice keeps its Model configuration link on the card heading", () => {
  // The link belongs to the enable card's heading line, not to a floating
  // control inside the row stack.
  assert.match(settingsPrimitives, /settings-card-heading-with-action/);
  assert.match(settingsPrimitives, /action\?: ReactNode/);
  assert.match(
    liveVoiceSettings,
    /action=\{[\s\S]*className="settings-text-action"[\s\S]*settings\.configuration/,
  );
  assert.doesNotMatch(liveVoiceSettings, /live-voice-actions/);
});
