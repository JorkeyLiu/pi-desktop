import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  AppSettings,
  GlobalPermissionMode,
  PluginScenicThemesDestinationMeta,
  ShortcutPlatform,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import {
  isSettingsDestinationHidden,
  resolveSettingsTab,
  SETTINGS_NAV_GROUP_LABELS,
  visibleSettingsNav,
  type SettingsNavGroupId,
} from "../../lib/settings-search";
import { pluginViewIcon } from "../../lib/plugin-view-icons";
import {
  IconArchive,
  IconBookOpen,
  IconBot,
  IconChat,
  IconChevronLeft,
  IconFileText,
  IconGlobe,
  IconInfo,
  IconPalette,
  IconServer,
  IconSliders,
  IconCloudDown,
} from "../../components/icons";
import { Badge, Button, cx, SegmentedControl, SettingsToggle } from "../../components/ui";
import { ModelConfigPage } from "../../components/settings/ModelConfigPage";
import { KeyboardShortcutsSection } from "../../components/settings/KeyboardShortcutsSection";
import { FontFamilyRow } from "../../components/settings/FontFamilyRow";
import { ThinkingDisplayModeRow } from "../../components/settings/ThinkingDisplayModeRow";
import { FontSizeRow } from "../../components/settings/FontSizeRow";
import { LanguageRow } from "../../components/settings/LanguageRow";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { ThemeRow } from "../../components/settings/ThemeRow";
import { NetworkProxySection } from "../../components/settings/NetworkProxySection";
import { ProjectsPage } from "../../pages/ProjectsPage";
import { AgentSkillsPage } from "../../components/settings/AgentSkillsPage";
import { AgentMcpPage } from "../../components/settings/AgentMcpPage";
import { AgentSubagentsPage } from "../../components/settings/AgentSubagentsPage";
import { RemoteHostsPage } from "../../components/settings/RemoteHostsPage";
import { VoiceSettingsSection } from "./voice/VoiceSettingsSection";
import {
  CommandShellRow,
  ContextUsageDisplayRow,
  LargePasteThresholdRow,
  LinkOpenTargetRow,
  SendWhileRunningModeRow,
  SettingsCard,
  SettingsRow,
} from "./primitives";
import { AgentInstructionsSection, UpdatesRow } from "./agent-sections";
import { CloseBehaviorSection, DeveloperSection } from "./developer-sections";
import { PluginScenicThemesDestination } from "../../components/settings/PluginScenicThemesDestination";
import { ConfigSyncPage } from "../../components/settings/ConfigSyncPage";
import { StorageSettingsSection } from "./StorageSettingsSection";

type SettingsTab = ReturnType<typeof useAppStore.getState>["settingsTab"];

type NavItem = {
  id: SettingsTab;
  labelKey: string;
  titleKey: string;
  icon: ReactNode;
  group: SettingsNavGroupId;
  experimentalBadgeKey?: string;
};

export function SettingsPage() {
  const { t } = useTranslation();
  // Retired destinations keep their stored/deep-linked ids, but their content
  // renders inside General now; resolve before anything reads the tab.
  const tab = resolveSettingsTab(useAppStore((s) => s.settingsTab));
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const settingsAnchor = useAppStore((s) => s.settingsAnchor);
  const settingsTabNonce = useAppStore((s) => s.settingsTabNonce);
  const setSettingsAnchor = useAppStore((s) => s.setSettingsAnchor);
  const setPage = useAppStore((s) => s.setPage);
  const settings = useAppStore((s) => s.settings);
  const version = useAppStore((s) => s.version);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const platform = (window.piDesktop?.platform ?? "darwin") as ShortcutPlatform;

  // Experimental feature surfaces remain available in development builds only.
  const includeDevelopmentOnly = import.meta.env.DEV;
  const developerMode = settings?.developerMode === true;
  const navEntries = useMemo(
    () => visibleSettingsNav(developerMode, includeDevelopmentOnly),
    [developerMode, includeDevelopmentOnly],
  );
  const tabHidden = isSettingsDestinationHidden(
    tab,
    developerMode,
    includeDevelopmentOnly,
  );

  const [recoveringSettings, setRecoveringSettings] = useState(!settings);
  const [settingsRecoveryFailed, setSettingsRecoveryFailed] = useState(false);
  const [extensions, setExtensions] = useState<PluginScenicThemesDestinationMeta[]>([]);
  const [activeExtension, setActiveExtension] = useState<PluginScenicThemesDestinationMeta | null>(null);
  const seenSettingsTabNonce = useRef(settingsTabNonce);
  // setSettingsTab means "show this built-in category", even when the tab id
  // does not change. Dismiss a plugin page before paint; an anchor-only deep
  // link has to do the same or the row lookup hits the plugin instead.
  if (
    seenSettingsTabNonce.current !== settingsTabNonce ||
    (activeExtension && settingsAnchor)
  ) {
    seenSettingsTabNonce.current = settingsTabNonce;
    if (activeExtension) setActiveExtension(null);
  }
  const contentRef = useRef<HTMLDivElement>(null);
  const settingsBackRef = useRef<HTMLButtonElement>(null);
  const destination = activeExtension ? `extension:${activeExtension.ref}` : `builtin:${tab}`;

  // Entering Settings moves focus to the rail's first control. The local
  // search pill that used to own that focus is gone, and the back action is
  // the rail's first stop, so keyboard users still land inside the page.
  useLayoutEffect(() => {
    settingsBackRef.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    // Reset before paint and before the search-anchor effect positions its row.
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [destination]);

  useEffect(() => {
    const refresh = () => void api.listPluginScenicThemesDestinations().then(setExtensions, () => setExtensions([]));
    refresh();
    return api.onPluginChanged(refresh);
  }, []);

  useEffect(() => {
    if (activeExtension && !extensions.some((entry) => entry.ref === activeExtension.ref)) {
      setActiveExtension(null);
      setSettingsTab("general");
    }
  }, [activeExtension, extensions, setSettingsTab]);

  // A hidden destination must not keep rendering: leave the page the rail no
  // longer offers (for example Cloud sync or Remote Hosts after developer mode
  // is switched off) and fall back to General.
  useEffect(() => {
    if (!settings || !tabHidden) return;
    setSettingsTab("general");
  }, [settings, tabHidden, setSettingsTab]);

  const recoverSettings = useCallback(async () => {
    setRecoveringSettings(true);
    setSettingsRecoveryFailed(false);
    try {
      const recovered = await api.getSettings();
      useAppStore.setState({ settings: recovered });
    } catch {
      setSettingsRecoveryFailed(true);
    } finally {
      setRecoveringSettings(false);
    }
  }, []);

  useEffect(() => {
    if (settings) return;
    void recoverSettings();
  }, [settings, recoverSettings]);

  // Arriving from the global search dialog: scroll to and flash the row
  // whose title matches the pending anchor key. This runs after the
  // destination reset and before paint, so a category change does not flash
  // the top. Rows are located by their translated title so async tab content
  // (providers, import) needs no per-row wiring; a short retry window covers
  // late mounts.
  useLayoutEffect(() => {
    if (!settingsAnchor) return;
    const target = t(settingsAnchor).trim();
    let cancelled = false;
    let timer: number | undefined;
    const tryFind = (attempt: number) => {
      if (cancelled) return;
      const titles = document.querySelectorAll<HTMLElement>(
        ".settings-content .settings-row-title, .settings-content .settings-card-heading, .settings-content .about-update-title",
      );
      const match = [...titles].find(
        (node) => node.textContent?.trim() === target,
      );
      if (match) {
        const row =
          match.closest<HTMLElement>(".settings-row") ??
          match.closest<HTMLElement>(".settings-card-block") ??
          match;
        row.scrollIntoView({ block: "center" });
        row.classList.add("settings-anchor-flash");
        window.setTimeout(
          () => row.classList.remove("settings-anchor-flash"),
          1800,
        );
        setSettingsAnchor(null);
        return;
      }
      if (attempt < 8) timer = window.setTimeout(() => tryFind(attempt + 1), 120);
      else setSettingsAnchor(null);
    };
    tryFind(0);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [settingsAnchor, tab, t, setSettingsAnchor]);

  const saveSettings = async (patch: Partial<AppSettings>) => {
    if (!settings) return;
    const nextSettings = { ...settings, ...patch };
    await api.setSettings(nextSettings);
    useAppStore.setState({ settings: nextSettings });
    await refreshProviders();
  };

  const selectPluginTheme = async (theme: string) => {
    await saveSettings({ theme: theme as AppSettings["theme"] });
  };

  // Nav structure comes from the shared settings index (lib/settings-search)
  // so the global search dialog and this page stay in sync; only the icons
  // are view-level.
  const navItems: NavItem[] = useMemo(() => {
    // Semantic Lucide glyphs for the settings destinations. Retired ids
    // (voice, shortcuts) have no rail row, so they carry no glyph.
    const iconFor: Partial<Record<SettingsTab, ReactNode>> = {
      general: <IconSliders size={14} />,
      ai: <IconChat size={14} />,
      instructions: <IconFileText size={14} />,
      agent: <IconBot size={14} />,
      skills: <IconBookOpen size={14} />,
      mcp: <IconServer size={14} />,
      subagents: <IconBot size={14} />,
      projects: <IconArchive size={14} />,
      sync: <IconCloudDown size={14} />,
      remoteHosts: <IconGlobe size={14} />,
      about: <IconInfo size={14} />,
    };
    return navEntries.map((entry) => ({
      id: entry.id,
      labelKey: entry.labelKey,
      titleKey: entry.titleKey,
      icon: iconFor[entry.id],
      group: entry.group,
      experimentalBadgeKey: entry.experimentalBadgeKey,
    }));
  }, [navEntries]);

  // The rail keeps the destination index flat for search, while giving the
  // rows titled visual clusters so they do not read as one dense block.
  const navGroups = useMemo(() => {
    const groups = new Map<SettingsNavGroupId, NavItem[]>();
    for (const item of navItems) {
      const items = groups.get(item.group) ?? [];
      items.push(item);
      groups.set(item.group, items);
    }
    return [...groups.entries()].map(([id, items]) => ({ id, items }));
  }, [navItems]);

  const activeNavItem = navItems.find((item) => item.id === tab);
  const activeTitleKey = activeNavItem?.titleKey ?? "settings.title";
  const tabNeedsSettings = ["general", "ai", "agent"].includes(tab);

  return (
    <div className="settings-shell settings-shell-full">
      <div className="settings-titlebar" aria-hidden="true" />
      <aside className="settings-nav sidebar-surface" aria-label={t("settings.title")}>
        {/* Back to app sits at the rail's top-left, in the same band that holds
            the native drag strip; the control stays explicitly non-draggable. */}
        <div className="settings-nav-top drag">
          <button
            ref={settingsBackRef}
            type="button"
            className="settings-back no-drag"
            data-nav="back-to-app"
            aria-label={t("settings.backToApp")}
            onClick={() => setPage("chat")}
          >
            <IconChevronLeft size={15} />
            <span>{t("settings.backToApp")}</span>
          </button>
        </div>

        <div className="settings-nav-scroll no-drag">
          {navGroups.map(({ id, items }) => (
            <div key={id} className="settings-nav-group">
              <div className="settings-nav-group-label">
                {t(SETTINGS_NAV_GROUP_LABELS[id])}
              </div>
              {items.map((item) => (
                <button
                  key={item.id}
                  className={cx("settings-nav-item", tab === item.id && "active")}
                  onClick={() => {
                    setActiveExtension(null);
                    setSettingsTab(item.id);
                  }}
                >
                  <span className="settings-nav-icon">{item.icon}</span>
                  <span className="settings-nav-label">{t(item.labelKey)}</span>
                  {item.experimentalBadgeKey ? (
                    <Badge tone="warning" className="settings-nav-experimental">
                      {t(item.experimentalBadgeKey)}
                    </Badge>
                  ) : null}
                </button>
              ))}
            </div>
          ))}
          {extensions.length > 0 && (
            <div className="settings-nav-group">
              <div className="settings-nav-group-label">{t("settings.groupExtensions")}</div>
              {extensions.map((entry) => {
                const ExtensionIcon = pluginViewIcon(entry.icon) ?? IconPalette;
                return (
                  <button
                    key={entry.ref}
                    className={cx("settings-nav-item", activeExtension?.ref === entry.ref && "active")}
                    onClick={() => setActiveExtension(entry)}
                  >
                    <span className="settings-nav-icon"><ExtensionIcon size={14} /></span>
                    <span className="settings-nav-label">{entry.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      <div className="settings-content" ref={contentRef}>
        <div className="settings-content-inner">
          <div className="settings-content-enter">
          <h1 className="settings-section-title">
            <span>{activeExtension?.label ?? t(activeTitleKey)}</span>
            {!activeExtension && activeNavItem?.experimentalBadgeKey ? (
              <Badge tone="warning">{t(activeNavItem.experimentalBadgeKey)}</Badge>
            ) : null}
          </h1>

          {activeExtension ? (
            <PluginScenicThemesDestination destination={activeExtension} selectTheme={selectPluginTheme} />
          ) : <>

          {tabNeedsSettings && !settings ? (
            <div className="settings-recovery" role="status" aria-live="polite">
              {recoveringSettings ? (
                <>
                  <span className="route-pending-indicator" aria-hidden />
                  <span>{t("common.loading")}</span>
                </>
              ) : settingsRecoveryFailed ? (
                <>
                  <span>{t("errors.HOST_UNAVAILABLE")}</span>
                  <Button variant="secondary" onClick={() => void recoverSettings()}>
                    {t("errors.action.retry")}
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}

          {tab === "general" && settings && (
            <div className="settings-stack">
              <SettingsCard title={t("settings.appearance")}>
                <ThemeRow settings={settings} saveSettings={saveSettings} />
                <LanguageRow settings={settings} saveSettings={saveSettings} />
                <FontFamilyRow settings={settings} saveSettings={saveSettings} />
                <FontSizeRow settings={settings} saveSettings={saveSettings} />
              </SettingsCard>

              <NetworkProxySection settings={settings} saveSettings={saveSettings} />

              <StorageSettingsSection />

              <SettingsCard title={t("settings.power")}>
                <SettingsRow
                  title={t("settings.keepAwakeWhileRunning")}
                  description={t("settings.keepAwakeWhileRunningDesc")}
                >
                  <SettingsToggle
                    checked={settings.keepAwakeWhileRunning === true}
                    label={t("settings.keepAwakeWhileRunning")}
                    onChange={() => void saveSettings({
                      keepAwakeWhileRunning: settings.keepAwakeWhileRunning !== true,
                    })}
                  />
                </SettingsRow>
                <SettingsRow
                  title={t("settings.preventScreenSleep")}
                  description={t("settings.preventScreenSleepDesc")}
                >
                  <SettingsToggle
                    checked={settings.preventScreenSleep === true}
                    label={t("settings.preventScreenSleep")}
                    onChange={() => void saveSettings({ preventScreenSleep: !settings.preventScreenSleep })}
                  />
                </SettingsRow>
              </SettingsCard>

              {platform !== "darwin" && <CloseBehaviorSection />}

              {/* Live Voice and keyboard shortcuts used to own their own rail
                  rows; both render inside General now, each under its own card
                  heading, so no setting lost its home. */}
              <VoiceSettingsSection
                t={t}
                settings={settings}
                saveSettings={saveSettings}
              />

              <KeyboardShortcutsSection
                settings={settings}
                platform={platform}
                saveSettings={saveSettings}
              />
            </div>
          )}

          {tab === "ai" && settings && (
            <div className="settings-stack">
              <SettingsCard title={t("settings.permissions")}>
                <SettingsRow
                  title={t("settings.permissionMode")}
                  description={t("settings.permissionModeDesc")}
                >
                  <SettingsMenuSelect
                    className="settings-permission-select"
                    label={t("settings.permissionMode")}
                    value={settings.defaultPermissionMode ?? "ask"}
                    onChange={(mode) =>
                      void saveSettings({
                        defaultPermissionMode: mode as GlobalPermissionMode,
                      })
                    }
                    options={[
                      { id: "ask", label: t("settings.permissionModeAsk") },
                      {
                        id: "accept-edits",
                        label: t("settings.permissionModeAcceptEdits"),
                      },
                      { id: "auto", label: t("settings.permissionModeAuto") },
                    ]}
                  />
                </SettingsRow>
              </SettingsCard>

              <SettingsCard title={t("settings.defaultsTitle")}>
                <SettingsRow title={t("settings.mode")} description={t("settings.modeDesc")}>
                  <SegmentedControl
                    value={settings.defaultMode ?? "agent"}
                    onChange={(value) => void saveSettings({ defaultMode: value })}
                    options={[
                      { value: "agent", label: t("settings.modeAgent") },
                      { value: "plan", label: t("settings.modePlan") },
                      { value: "goal", label: t("settings.modeGoal") },
                    ]}
                    label={t("settings.mode")}
                    role="group"
                  />
                </SettingsRow>
                <CommandShellRow settings={settings} saveSettings={saveSettings} />
                <LinkOpenTargetRow settings={settings} saveSettings={saveSettings} />
                <ThinkingDisplayModeRow settings={settings} saveSettings={saveSettings} />
                <ContextUsageDisplayRow
                  settings={settings}
                  saveSettings={saveSettings}
                />
                <SettingsRow
                  title={t("settings.enterToSend")}
                  description={t("settings.enterToSendDesc")}
                >
                  <SettingsToggle
                    checked={settings.enterToSend}
                    label={t("settings.enterToSend")}
                    onChange={() => void saveSettings({ enterToSend: !settings.enterToSend })}
                  />
                </SettingsRow>
                <SendWhileRunningModeRow
                  settings={settings}
                  saveSettings={saveSettings}
                />
                <SettingsRow
                  title={t("settings.infiniteProviderRetry")}
                  description={t("settings.infiniteProviderRetryDesc")}
                >
                  <SettingsToggle
                    checked={settings.infiniteProviderRetry === true}
                    label={t("settings.infiniteProviderRetry")}
                    onChange={() => void saveSettings({ infiniteProviderRetry: settings.infiniteProviderRetry !== true })}
                  />
                </SettingsRow>
                <SettingsRow
                  title={t("settings.smoothStreaming")}
                  description={t("settings.smoothStreamingDesc")}
                >
                  <SettingsToggle
                    checked={settings.smoothStreaming !== false}
                    label={t("settings.smoothStreaming")}
                    onChange={() => void saveSettings({ smoothStreaming: !(settings.smoothStreaming !== false) })}
                  />
                </SettingsRow>
                <LargePasteThresholdRow
                  settings={settings}
                  saveSettings={saveSettings}
                />
              </SettingsCard>

            </div>
          )}

          {tab === "agent" && <ModelConfigPage />}

          {tab === "skills" && <AgentSkillsPage />}

          {tab === "mcp" && <AgentMcpPage />}

          {tab === "subagents" && <AgentSubagentsPage />}

          {tab === "instructions" && <AgentInstructionsSection />}


          {tab === "projects" && <ProjectsPage />}

          {tab === "sync" && !tabHidden && <ConfigSyncPage />}

          {tab === "remoteHosts" && !tabHidden && <RemoteHostsPage />}

          {tab === "about" && (
            <div className="settings-stack">
              <div className="settings-about-hero">
                <div className="settings-about-hero-name">
                  {version?.name || "PI-Desktop"}
                </div>
                <div className="settings-about-hero-version">
                  {t("settings.aboutVersion", { version: version?.version ?? "" })}
                </div>
                <div className="settings-about-hero-meta">
                  protocol {version?.protocolVersion} · host {version?.hostVersion}
                </div>
              </div>
              <UpdatesRow
                currentVersion={version?.version}
                settings={settings ?? null}
                saveSettings={saveSettings}
              />
              <SettingsCard>
                <SettingsRow title={t("settings.logs")}>
                  <Button variant="secondary" onClick={() => void api.openLogs()}>
                    {t("settings.openLogs")}
                  </Button>
                </SettingsRow>
                <SettingsRow
                  title={t("settings.feedback")}
                  description={t("settings.feedbackDesc")}
                >
                  <Button
                    variant="secondary"
                    onClick={() => void api.openFeedback().catch(() => undefined)}
                  >
                    {t("settings.openFeedback")}
                  </Button>
                </SettingsRow>
              </SettingsCard>

              {settings && (
                <DeveloperSection settings={settings} saveSettings={saveSettings} />
              )}
            </div>
          )}
          </>}

          </div>
        </div>
      </div>
    </div>
  );
}
