/**
 * Data-only index of the settings IA, shared by the settings page nav and
 * the global search dialog. Keyword keys are the i18n keys of the rows
 * rendered inside each tab; search matches their translations, so a query
 * like "主题" or "theme" can surface the tab that owns the row.
 */

export type SettingsTabId =
  | "general"
  | "ai"
  | "shortcuts"
  | "instructions"
  | "agent"
  | "skills"
  | "mcp"
  | "subagents"
  | "projects"
  | "sync"
  | "remoteHosts"
  | "voice"
  | "about";

export type SettingsNavGroupId =
  | "preferences"
  | "agent"
  | "workspace"
  | "system";

export const SETTINGS_NAV_GROUP_LABELS: Record<SettingsNavGroupId, string> = {
  preferences: "settings.groupPreferences",
  agent: "settings.groupAgent",
  workspace: "settings.groupWorkspace",
  system: "settings.groupSystem",
};

export type SettingsSearchAlias = {
  /**
   * i18n key holding the synonyms a row's own label does not spell out —
   * "send mode" for "Message while the agent is running", "图片模型" for
   * "生图模型". Users type those phrases, so the index answers to the
   * translation instead of a hard-coded English string.
   */
  key: string;
  /**
   * Row-title key inside the same destination. A hit scrolls to a row the page
   * actually renders, so an alias never produces an anchor that matches
   * nothing.
   */
  anchorKey: string;
};

export type SettingsNavEntry = {
  id: SettingsTabId;
  /** Short label used by the rail and settings search results. */
  labelKey: string;
  /** Descriptive title used at the top of the selected settings page. */
  titleKey: string;
  /** Visual-only rail grouping; search remains a flat destination index. */
  group: SettingsNavGroupId;
  /** i18n keys of the rows inside the tab; search matches their translations. */
  keywordKeys: string[];
  /** Synonyms of the rows inside the tab; see `SettingsSearchAlias`. */
  searchAliases?: SettingsSearchAlias[];
  /**
   * Destination only exists while `AppSettings.developerMode` is on; the
   * rail, the page, and settings search drop it together.
   */
  developerOnly?: true;
  /** Surface is omitted from packaged builds; development builds retain it. */
  developmentOnly?: true;
  /** Localized Experimental badge shown beside the rail row and page title. */
  experimentalBadgeKey?: string;
};

export const SETTINGS_NAV: SettingsNavEntry[] = [
  {
    id: "general",
    labelKey: "settings.nav.general",
    titleKey: "settings.general",
    group: "preferences",
    keywordKeys: [
      "settings.appearance",
      "settings.storage.title",
      "settings.storage.dataPath",
      "settings.storage.cache",
      "settings.storage.clearCache",
      "settings.storage.backup",
      "settings.theme",
      "settings.language",
      "settings.languageAuto",
      "settings.font",
      "settings.fontSize",
      "settings.closeBehaviorTitle",
      "settings.closeBehaviorTray",
      "settings.closeBehaviorQuit",
      "settings.power",
      "settings.keepAwakeWhileRunning",
      "settings.keepAwakeWhileRunningDesc",
      "settings.network",
      "settings.proxy",
      "settings.proxySystem",
      "settings.proxyDirect",
      "settings.proxyCustom",
      "settings.proxyUrl",
      "settings.networkRelaxedMode",
      "settings.networkRelaxedModeDesc",
      "settings.networkRelaxedModeStrictDesc",
      "settings.preventScreenSleep",
      "settings.preventScreenSleepDesc",
      // Live Voice and keyboard shortcuts render inside General now; their
      // rows still have to surface General from a global settings search.
      "liveVoice.title",
      "liveVoice.description",
      "liveVoice.enable",
      "liveVoice.enableDetail",
      "liveVoice.provider",
      "liveVoice.model",
      "liveVoice.voice",
      "liveVoice.adapters.codex-live.title",
      "liveVoice.adapters.gemini-live.title",
      "liveVoice.adapters.openai-realtime.title",
      "settings.keyboard",
      "settings.shortcutResetAll",
      "settings.shortcutAction.openSearch",
      "settings.shortcutAction.openCommandPalette",
      "settings.shortcutAction.toggleSidebar",
      "settings.shortcutAction.openWorkPanel",
    ],
  },
  {
    id: "ai",
    labelKey: "settings.nav.chat",
    titleKey: "settings.chat",
    group: "agent",
    keywordKeys: [
      "settings.permissions",
      "settings.permissionMode",
      "settings.permissionModeAsk",
      "settings.permissionModeAcceptEdits",
      "settings.permissionModeAuto",
      "settings.defaultsTitle",
      "settings.mode",
      "settings.commandShell",
      "settings.linkOpenTarget",
      "settings.enterToSend",
      "settings.sendWhileRunningMode",
      "settings.sendWhileRunningModeDesc",
      "settings.sendWhileRunningModeImmediate",
      "settings.sendWhileRunningModeQueue",
      "settings.infiniteProviderRetry",
      "settings.infiniteProviderRetryDesc",
      "settings.smoothStreaming",
      "settings.smoothStreamingDesc",
      "settings.thinkingDisplayMode",
      "settings.thinkingDisplayDetailed",
      "settings.thinkingDisplayCompact",
      "settings.contextUsageDisplay",
      "settings.contextUsageDisplayRemaining",
      "settings.contextUsageDisplayUsed",
      "settings.largePasteThreshold",
    ],
    searchAliases: [
      {
        key: "settings.searchAliasSendMode",
        anchorKey: "settings.sendWhileRunningMode",
      },
    ],
  },
  {
    id: "agent",
    labelKey: "settings.nav.models",
    titleKey: "settings.configuration",
    group: "agent",
    keywordKeys: [
      "settings.providers",
      "settings.models",
      "settings.apiKey",
      "settings.baseUrl",
      "settings.apiStyle",
      // The image-generation default row renders on the model page.
      "settings.imageModel",
      "settings.imageModelUnset",
      "settings.imageModelUnavailable",
      // Subscription accounts share the service list (D625).
      "settings.vendorAccounts",
      "settings.vendorSubscription",
      "settings.importTitle",
      "settings.importModelsScanDesc",
      "settings.importModelsTitle",
      "settings.importSourceClaudeCode",
      "settings.importSourceOpenCode",
      "settings.importSourceCodex",
      "settings.importSourcePi",
      "settings.importSourceCcSwitch",
    ],
    searchAliases: [
      {
        key: "settings.searchAliasImageModel",
        anchorKey: "settings.imageModel",
      },
    ],
  },
  {
    id: "instructions",
    labelKey: "settings.nav.instructions",
    titleKey: "settings.instructions",
    group: "agent",
    keywordKeys: [
      "settings.instructionsGlobal",
      "settings.instructionsPath",
    ],
  },
  {
    id: "skills",
    labelKey: "settings.nav.skills",
    titleKey: "settings.skills",
    group: "agent",
    keywordKeys: [
      "settings.skillsGlobalPath",
      "settings.skillsProjectPath",
      "settings.globalScopeDescription",
      "settings.projectScopeDescription",
      "settings.importSkill",
      "settings.importSkillFromTools",
      "settings.importAgentSkillsTitle",
      "settings.importAgentSkillsDesc",
      "settings.capabilityFilterGlobal",
      "settings.capabilityFilterProject",
      "extensions.skills.add",
      "extensions.skills.edit",
      "extensions.skills.remove",
      "extensions.skills.reveal",
    ],
  },
  {
    id: "mcp",
    labelKey: "settings.nav.mcp",
    titleKey: "settings.mcp",
    group: "agent",
    keywordKeys: [
      "settings.mcpGlobalPath",
      "settings.mcpProjectPath",
      "settings.globalScopeDescription",
      "settings.projectScopeDescription",
      "settings.addMcp",
      "settings.importMcpFromTools",
      "settings.importAgentMcpTitle",
      "settings.importAgentMcpDesc",
      "settings.editMcp",
      "settings.transport",
      "settings.capabilityFilterGlobal",
      "settings.capabilityFilterProject",
      "extensions.mcp.test",
      "extensions.mcp.remove",
    ],
  },
  {
    id: "subagents",
    labelKey: "settings.nav.subagents",
    titleKey: "settings.subagents",
    group: "agent",
    keywordKeys: [
      "settings.subagentsGlobalPath",
      "settings.subagentsOnlyGlobal",
      "settings.globalScopeDescription",
      "settings.subagentWakeTitle",
      "settings.subagentWakeKind",
      "settings.subagentWakeKindDesc",
      "settings.subagentWakeKindTime",
      "settings.subagentWakeKindToolCalls",
      "settings.subagentWakeKindContextTokens",
      "settings.subagentWakeUnitTokens",
      "settings.subagentWakeKindOff",
      "settings.subagentExecutionTitle",
      "settings.subagentAvailableTitle",
      "settings.subagentSelfHandoffTitle",
      "settings.subagentSelfHandoffKind",
      "settings.subagentSelfHandoffKindContextTokens",
      "settings.subagentSelfHandoffUnitKTokens",
      "settings.subagentSelfHandoffKindToolCalls",
      "settings.subagentSelfHandoffKindRuntime",
      "settings.subagentSelfHandoffKindOff",
      "extensions.subagents.add",
      "extensions.subagents.edit",
      "extensions.subagents.remove",
      "extensions.subagents.reveal",
      "extensions.subagents.copy",
      "extensions.subagents.sourceBuiltin",
      "extensions.subagents.presetExplorerName",
      "extensions.subagents.presetReviewerName",
      "extensions.subagents.presetTestRunnerName",
      "extensions.subagents.presetFixerName",
      "extensions.subagents.presetUiDesignerName",
      "extensions.subagents.tools",
    ],
  },
  {
    id: "projects",
    labelKey: "settings.nav.projects",
    titleKey: "settings.projectArchive",
    group: "workspace",
    keywordKeys: [
      "project.title",
      "project.searchPlaceholder",
      "project.archive",
      "project.restore",
      "project.delete",
    ],
  },
  {
    id: "sync",
    labelKey: "settings.nav.sync",
    titleKey: "settings.configSync.title",
    group: "system",
    experimentalBadgeKey: "settings.configSync.experimental",
    keywordKeys: [
      "settings.configSync.experimental",
      "settings.configSync.connectionTitle",
      "settings.configSync.endpoint",
      "settings.configSync.statusTitle",
      "settings.configSync.categoriesTitle",
      "settings.configSync.approvalsTitle",
      "settings.configSync.syncNow",
    ],
  },
  {
    id: "remoteHosts",
    labelKey: "settings.nav.remoteHosts",
    titleKey: "settings.remoteHosts.title",
    group: "system",
    experimentalBadgeKey: "settings.remoteHosts.experimental",
    keywordKeys: [
      "settings.remoteHosts.title",
      "settings.remoteHosts.addTitle",
      "settings.remoteHosts.addSsh",
      "settings.remoteHosts.addPair",
      "settings.remoteHosts.pair",
      "settings.remoteHosts.fieldUrl",
      "settings.remoteHosts.fieldPairingToken",
      "settings.remoteHosts.sshHost",
      "settings.remoteHosts.sshAuthMode",
      "settings.remoteHosts.sshPassword",
      "settings.remoteHosts.statusOnline",
      "settings.remoteHosts.statusOffline",
      "settings.remoteHosts.experimental",
    ],
  },
  {
    id: "about",
    labelKey: "settings.nav.info",
    titleKey: "settings.about",
    group: "system",
    keywordKeys: [
      "settings.application",
      "settings.logs",
      "settings.feedback",
      "updates.title",
      "updates.preferenceTitle",
      "settings.developer",
      "settings.developerMode",
      "settings.devTools",
    ],
  },
];

/**
 * Retired destinations that older builds, deep links, and plugin surfaces can
 * still name. Their content now renders inside General, so the id keeps
 * working instead of dead-ending on an empty page.
 */
export const SETTINGS_LEGACY_TAB_ALIASES: Partial<Record<SettingsTabId, SettingsTabId>> = {
  voice: "general",
  shortcuts: "general",
};

/** The destination actually rendered for a stored or deep-linked tab id. */
export function resolveSettingsTab(tab: SettingsTabId): SettingsTabId {
  return SETTINGS_LEGACY_TAB_ALIASES[tab] ?? tab;
}

/**
 * Destinations the current mode offers. Unavailable destinations are omitted
 * from navigation and search rather than disabled.
 */
export function visibleSettingsNav(
  developerMode: boolean,
  includeDevelopmentOnly = true,
): SettingsNavEntry[] {
  return SETTINGS_NAV.filter(
    (entry) =>
      (entry.developerOnly !== true || developerMode) &&
      (entry.developmentOnly !== true || includeDevelopmentOnly),
  );
}

/** True when a stale selection points to a destination the current mode hides. */
export function isSettingsDestinationHidden(
  tab: SettingsTabId,
  developerMode: boolean,
  includeDevelopmentOnly = true,
): boolean {
  const destination = resolveSettingsTab(tab);
  return !visibleSettingsNav(developerMode, includeDevelopmentOnly).some(
    (entry) => entry.id === destination,
  );
}

export type SettingsSearchHit = {
  tab: SettingsTabId;
  tabLabelKey: string;
  /** Matched row key; null when the tab label itself matched. */
  rowKey: string | null;
};

export type SettingsSearchOptions = {
  limit?: number;
  /** Search mirrors the rail, so developer-only tabs stay out of results. */
  developerMode?: boolean;
  /** Packaged builds omit experimental surfaces, even with developer mode on. */
  includeDevelopmentOnly?: boolean;
};

export function searchSettings(
  query: string,
  t: (key: string) => string,
  {
    limit = 8,
    developerMode = false,
    includeDevelopmentOnly = true,
  }: SettingsSearchOptions = {},
): SettingsSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SettingsSearchHit[] = [];
  for (const entry of visibleSettingsNav(developerMode, includeDevelopmentOnly)) {
    if (t(entry.labelKey).toLowerCase().includes(q)) {
      hits.push({ tab: entry.id, tabLabelKey: entry.labelKey, rowKey: null });
    }
    for (const key of entry.keywordKeys) {
      if (t(key).toLowerCase().includes(q)) {
        hits.push({ tab: entry.id, tabLabelKey: entry.labelKey, rowKey: key });
      }
    }
    for (const alias of entry.searchAliases ?? []) {
      // The hit carries the row's own title key, never the alias key: the
      // settings page scrolls by translated row title, so an alias-only anchor
      // would point at text no row renders.
      if (t(alias.key).toLowerCase().includes(q)) {
        hits.push({ tab: entry.id, tabLabelKey: entry.labelKey, rowKey: alias.anchorKey });
      }
    }
  }
  return hits.slice(0, limit);
}
