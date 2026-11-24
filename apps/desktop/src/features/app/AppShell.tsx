import { type CSSProperties, lazy, type ReactNode, Suspense, useCallback, useEffect } from "react";
import { ConversationTopbar } from "../../components/ConversationTopbar";
import { ExtensionPromptHost } from "../../components/ExtensionPromptDialog";
import { PluginRendererHost } from "../../plugins/renderer-host/PluginRendererHost";
import {
  IconNewSession,
  IconPanel,
  IconPanelOpen,
} from "../../components/icons";
import { ProjectCreateDialog } from "../../components/ProjectCreateDialog";
import { SearchDialog } from "../../components/SearchDialog";
import { Sidebar } from "../../components/Sidebar";
import { StartupRecovery } from "../../components/StartupRecovery";
import { ToastHost } from "../../components/Toast";
import { UpdateBanner } from "../../components/UpdateBanner";
import { cx, TooltipButton } from "../../components/ui";
import { WindowControls } from "../../components/WindowControls";
import { useCopyTex } from "../../hooks/use-copy-tex";
import { api } from "../../lib/api";
import { PortalVisibilityProvider } from "../../lib/portal-visibility";
import { workPanelLayout } from "../../lib/work-panel-resize";
import { useAppStore } from "../../stores/app-store";
import { LiveVoiceStatusHost } from "../voice/live/LiveVoiceStatusHost";
import { CollapsedTitlebarActions, RoutePending } from "./chrome";
import { SecondaryWindows } from "./SecondaryWindows";
import { useAppShellRuntime } from "./useAppShellRuntime";

const loadChatSurface = () => import("../../components/ChatSurface");
const ChatSurface = lazy(() =>
  loadChatSurface().then((module) => ({
    default: module.ChatSurface,
  })),
);
const loadWorkPanel = () => import("../../components/workpanel/WorkPanel");
const WorkPanel = lazy(() =>
  loadWorkPanel().then((module) => ({ default: module.WorkPanel })),
);

export function AppShell() {
  const {
    t,
    ready,
    page,
    activeSessionId,
    workPanelOpen,
    searchOpen,
    setSearchOpen,
    sidebarCollapsed,
    sidebarEntering,
    sidebarExiting,
    sidebarWidth,
    sidebarWidthMax,
    handleSidebarWidthChange,
    handleSidebarWidthCommit,
    handleSidebarResizeCollapse,
    toggleSidebar,
    autoCollapseSidebar,
    appShellRef,
    shellWidth,
    runMenuCommand,
    handleSidebarAnimationEnd,
    presentedWorkPanelOpen,
    workPanelExiting,
    workPanelExitGeneration,
    finishWorkPanelExit,
    togglePresentedWorkPanel,
    workPanelMaximized,
    toggleWorkPanelMaximize,
    backendDown,
    archMismatch,
    setArchMismatch,
    showSplash,
    splash,
    startupPhase,
    startupWaitedMs,
    retryStartup,
    startupRetrying,
    sidebarToggleShortcut,
    workPanelToggleTooltip,
    workPanelWidth,
  } = useAppShellRuntime();
  const setPage = useAppStore((state) => state.setPage);
  useCopyTex();

  useEffect(() => {
    void loadChatSurface().catch((error: unknown) => {
      console.error("Failed to preload the chat surface", error);
    });
  }, []);

  useEffect(() => {
    if (!ready || !workPanelOpen) return;
    void loadWorkPanel().catch((error: unknown) => {
      console.error("Failed to preload the work panel", error);
    });
  }, [ready, workPanelOpen]);

  // One dismissal path for the secondary-window layer: the header close
  // control, the scrim, Escape, and a sidebar destination toggle all end in
  // the same `setPage("chat")`, which also makes the store's single window
  // slot empty again.
  const closeSecondaryWindow = useCallback(() => {
    setPage("chat");
  }, [setPage]);

  const pendingWorkPanelWidth = workPanelLayout({
    containerWidth: shellWidth,
    sidebarWidth,
    sidebarCollapsed,
    requestedPanelWidth: workPanelWidth,
    maximized: workPanelMaximized,
  }).panelWidth;

  // A boot that never reaches the shell gets a surface it can act on instead of
  // a window that only knows how to wait (issue #831). Rendered as a direct child
  // of the shell so it can layer above the splash and below the window controls.
  const startupRecovery =
    startupPhase === "starting" ? null : (
      <StartupRecovery
        phase={startupPhase}
        waitedMs={startupWaitedMs}
        onRetry={retryStartup}
        retrying={startupRetrying}
        down={backendDown}
      />
    );

  let shell: ReactNode = null;
  if (ready) {
    shell = (
      <>
        {/*
          Chat is the only home. Settings, Extensions, and Scheduled open as
          in-app floating windows over this shell, so the conversation stays
          mounted — transcript scroll, composer draft, and running turn are
          never rebuilt by a destination switch. The shell is inert while a
          window is up (never `display: none`, which would discard scroll
          offsets), and its portal layers follow the same visibility.
        */}
        <PortalVisibilityProvider visible={page === "chat"}>
          <div
            className="app-chat-shell"
            inert={page === "chat" ? undefined : true}
          >
            {!sidebarCollapsed || sidebarExiting ? (
              <Sidebar
                className={cx(sidebarEntering && "is-entering", sidebarExiting && "is-exiting")}
                onAnimationEnd={handleSidebarAnimationEnd}
                onToggleSidebar={toggleSidebar}
                sidebarToggleShortcut={sidebarToggleShortcut}
                sidebarWidth={sidebarWidth}
                widthMax={sidebarWidthMax}
                onWidthChange={handleSidebarWidthChange}
                onWidthCommit={handleSidebarWidthCommit}
                onResizeCollapse={handleSidebarResizeCollapse}
              />
            ) : null}

            {workPanelMaximized && (
              /* MainChat is absent; the panel header owns dragging while this
                 pass-through row keeps the shell controls available. */
              <div
                className={cx(
                  "window-chrome-row",
                  !sidebarCollapsed && "sidebar-expanded",
                )}
              >
                {sidebarCollapsed && (
                  <CollapsedTitlebarActions
                    onToggleSidebar={toggleSidebar}
                    onNewTask={() => void runMenuCommand("newTask")}
                    sidebarToggleShortcut={sidebarToggleShortcut}
                  />
                )}
                {!sidebarCollapsed && (
                  <TooltipButton
                    type="button"
                    className="title-nav-btn"
                    tooltip={t("nav.newTask")}
                    ariaLabel={t("nav.newTask")}
                    data-nav="new-task"
                    onClick={() => void runMenuCommand("newTask")}
                  >
                    <IconNewSession size={15} />
                  </TooltipButton>
                )}
                <div className="window-chrome-drag" aria-hidden />
              </div>
            )}

            {!workPanelMaximized && (
              <section className="main-pane">
                <ConversationTopbar
                  sidebarCollapsed={sidebarCollapsed}
                  workPanelOpen={presentedWorkPanelOpen}
                  onToggleSidebar={toggleSidebar}
                  onNewTask={() => void runMenuCommand("newTask")}
                  onOpenSearch={() => setSearchOpen(true)}
                />
                <UpdateBanner />

                {backendDown && (
                  <div
                    className={`backend-banner no-drag ${backendDown.fatal ? "fatal" : "warn"}`}
                    role="status"
                  >
                    <span className="backend-dot" aria-hidden />
                    <span>
                      {backendDown.fatal
                        ? backendDown.message === "GLIBC_UNSUPPORTED"
                          ? t("status.unsupportedGlibc")
                          : backendDown.message === "DB_SCHEMA_TOO_NEW"
                            ? t("status.dbSchemaTooNew", {
                                found: backendDown.schema?.found ?? "?",
                                supported: backendDown.schema?.supported ?? "?",
                              })
                            : t("status.fatal")
                        : t("status.restarting")}
                    </span>
                    {backendDown.fatal && (
                      <button
                        type="button"
                        className="backend-action"
                        onClick={() => void api.openLogs()}
                      >
                        {t("status.openLogs")}
                      </button>
                    )}
                  </div>
                )}

                {archMismatch && (
                  <div className="backend-banner no-drag warn" role="status">
                    <span className="backend-dot" aria-hidden />
                    <span>
                      {t("status.archMismatch", {
                        buildArch: t(
                          `status.archNames.${archMismatch.platform}.${archMismatch.processArch}`,
                          { defaultValue: archMismatch.processArch },
                        ),
                        machineArch: t(
                          `status.archNames.${archMismatch.platform}.${archMismatch.machineArch}`,
                          { defaultValue: archMismatch.machineArch },
                        ),
                      })}
                    </span>
                    <button
                      type="button"
                      className="backend-action"
                      onClick={() => setArchMismatch(null)}
                    >
                      {t("status.dismissArchMismatch")}
                    </button>
                  </div>
                )}

                <Suspense fallback={<RoutePending />}>
                  <ChatSurface />
                </Suspense>
              </section>
            )}

            {(presentedWorkPanelOpen || workPanelExiting) && (
              <Suspense
                fallback={
                  <aside
                    className="work-panel work-panel-pending"
                    role="status"
                    aria-label={t("app.loadingView")}
                    style={
                      {
                        "--work-panel-width": `${pendingWorkPanelWidth}px`,
                      } as CSSProperties
                    }
                  >
                    <span className="route-pending-indicator" aria-hidden />
                  </aside>
                }
              >
                <WorkPanel
                  panelBlocked={searchOpen}
                  exiting={workPanelExiting}
                  onExitAnimationEnd={() =>
                    finishWorkPanelExit(workPanelExitGeneration.current)
                  }
                  containerWidth={shellWidth}
                  sidebarWidth={sidebarWidth}
                  sidebarCollapsed={sidebarCollapsed}
                  sidebarExiting={sidebarExiting}
                  onAutoCollapseSidebar={autoCollapseSidebar}
                  maximized={workPanelMaximized}
                  onToggleMaximize={toggleWorkPanelMaximize}
                />
              </Suspense>
            )}

            <TooltipButton
              type="button"
              className="app-work-panel-toggle no-drag"
              tooltip={workPanelToggleTooltip}
              ariaLabel={workPanelToggleTooltip}
              aria-pressed={workPanelOpen || presentedWorkPanelOpen}
              disabled={!activeSessionId && !presentedWorkPanelOpen && !workPanelExiting}
              onClick={togglePresentedWorkPanel}
            >
              <span className="app-work-panel-toggle-icon" aria-hidden>
                <IconPanel size={15} />
                <IconPanelOpen size={15} />
              </span>
            </TooltipButton>
          </div>
        </PortalVisibilityProvider>
        <SecondaryWindows page={page} onClose={closeSecondaryWindow} />
        <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
        <ToastHost />
        <LiveVoiceStatusHost />
        <PluginRendererHost />
        <ExtensionPromptHost />
      </>
    );
  }

  return (
    <div
      ref={appShellRef}
      className={cx(
        "app-shell",
        !ready && "app-shell-boot",
        sidebarCollapsed && "sidebar-collapsed",
        workPanelMaximized && "work-panel-maximized",
        showSplash && "is-booting",
      )}
      style={{ "--ds-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <div className="app-scenic-backdrop" aria-hidden />
      {shell}
      {/* Outside pane stacking; skip splash so the band cannot cover boot chrome. */}
      {/* `showSplash` stays true for as long as the shell is not ready, so a
          bare `!showSplash` test would leave the recovery surface without any
          window controls — the only ones a frameless Windows/Linux window has.
          The controls therefore follow the boot surface that is actually up. */}
      {(ready && !showSplash) || startupPhase !== "starting" ? (
        <WindowControls />
      ) : null}
      <ProjectCreateDialog />
      {splash}
      {startupRecovery}
    </div>
  );
}
