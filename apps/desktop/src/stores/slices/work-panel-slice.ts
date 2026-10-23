import { api } from "../../lib/api";
import { isRemoteSession } from "../../lib/remote-session-safety";
import {
  activateWorkPanelTabState,
  browserPluginTab,
  browserTabLabel,
  closeWorkPanelTabState,
  closeWorkPanelTabsState,
  createWorkPanelFileRequest,
  emptyWorkPanelContext,
  fileWorkPanelTab,
  newWorkPanelTab,
  nextWorkPanelFileRequestSeq,
  openWorkPanelTabState,
  reorderWorkPanelTabsState,
  replaceWorkPanelTabState,
  sanitizeWorkPanelTabsState,
  subagentWorkPanelTab,
  switchWorkPanelContextState,
  type WorkPanelContext,
  type WorkPanelTab,
} from "../../lib/work-panel-tabs";
import { WORK_PANEL_COMPACT_MIN_WIDTH } from "../../lib/work-panel-resize";
import { restoreWorkPanelTabs } from "../../lib/work-panel-persistence";
import type { AppState } from "../app-state";
import type { StoreAccess } from "./types";

export function currentWorkPanelContext(state: AppState): WorkPanelContext {
  const tabs = sanitizeWorkPanelTabsState({
    tabs: state.workPanelTabs,
    activeTabId: state.activeWorkPanelTabId,
  });
  return {
    tabs: tabs.tabs,
    activeTabId: tabs.activeTabId,
    fileRequest: state.workPanelFileRequest,
  };
}

/**
 * Follow the active conversation with its retained panel content.
 *
 * Visibility is intentionally not returned: `workPanelOpen` is shell state the
 * user owns, so selecting, creating, forking into, or resetting a conversation
 * changes which resources the panel shows and never whether the panel is on
 * screen. A closed panel therefore stays closed when the destination's retained
 * context used to be open, and an open panel survives the transitional
 * no-conversation phases those transitions pass through.
 */
export function switchWorkPanelSession(
  state: AppState,
  nextSessionId?: string,
): Pick<
  AppState,
  | "workPanelContexts"
  | "workPanelTabs"
  | "activeWorkPanelTabId"
  | "workPanelFileRequest"
> {
  const switched = switchWorkPanelContextState(
    state.workPanelContexts,
    state.activeSessionId,
    currentWorkPanelContext(state),
    nextSessionId,
  );
  return {
    workPanelContexts: switched.contexts,
    workPanelTabs: switched.visible.tabs,
    activeWorkPanelTabId: switched.visible.activeTabId,
    workPanelFileRequest: switched.visible.fileRequest,
  };
}

/**
 * One conversation's durable resource state, validated for rendering.
 *
 * The same sanitizer the live panel uses repairs the active id and drops
 * unknown kinds, so a record written by an older version can never hand a
 * component a tab it cannot render.
 */
function restoredContext(context: WorkPanelContext): WorkPanelContext {
  const tabs = restoreWorkPanelTabs(context.tabs, context.activeTabId);
  return { tabs: tabs.tabs, activeTabId: tabs.activeTabId, fileRequest: null };
}

/**
 * Project the persisted panel preference onto the sessions that still exist.
 *
 * This runs once, after the host snapshot has selected the startup
 * conversation. The panel opens only while that conversation is a supported
 * existing session, so an empty home never shows a standalone dock. Contexts
 * for deleted, remote, or empty sessions are dropped instead of carried
 * forward, and the restored active file tab receives a fresh request sequence
 * so the file view reloads instead of treating the request as already handled.
 */
export function restoreWorkPanelState(
  state: AppState,
  sessionIds: ReadonlySet<string>,
  persistedOpen: boolean,
): Pick<
  AppState,
  | "workPanelContexts"
  | "workPanelTabs"
  | "activeWorkPanelTabId"
  | "workPanelFileRequest"
  | "workPanelOpen"
> {
  const contexts: Record<string, WorkPanelContext> = {};
  for (const [sessionId, context] of Object.entries(state.workPanelContexts)) {
    if (!sessionIds.has(sessionId) || sessionId.startsWith("remote:")) continue;
    const restored = restoredContext(context);
    if (restored.tabs.length) contexts[sessionId] = restored;
  }
  const visibleId = state.activeSessionId;
  const visible = visibleId
    ? contexts[visibleId] ?? emptyWorkPanelContext()
    : emptyWorkPanelContext();
  const activeTab = visible.tabs.find((tab) => tab.id === visible.activeTabId);
  const fileRequest =
    activeTab && activeTab.kind === "file" && activeTab.resource
      ? createWorkPanelFileRequest(activeTab, nextWorkPanelFileRequestSeq())
      : null;
  if (visibleId && visible.tabs.length) {
    contexts[visibleId] = { ...visible, fileRequest };
  }
  return {
    workPanelContexts: contexts,
    workPanelTabs: visible.tabs,
    activeWorkPanelTabId: visible.activeTabId,
    workPanelFileRequest: fileRequest,
    workPanelOpen:
      state.workPanelOpen ||
      (persistedOpen && Boolean(visibleId && contexts[visibleId])),
  };
}

export type WorkPanelSliceDependencies = StoreAccess & {
  isSessionSelectionPending: (sessionId: string) => boolean;
};

export function createWorkPanelSlice({
  get,
  set,
  isSessionSelectionPending,
}: WorkPanelSliceDependencies): Pick<
  AppState,
  "openSubagentTab"
  | "openWorkPanel"
  | "toggleWorkPanel"
  | "openWorkPanelTab"
  | "openNewWorkPanelTab"
  | "replaceWorkPanelTab"
  | "openWorkPanelTabForSession"
  | "activateWorkPanelTab"
  | "reorderWorkPanelTabs"
  | "closeWorkPanelTab"
  | "closeWorkPanelTabs"
  | "collapseWorkPanel"
  | "resetWorkPanelContext"
  | "setWorkPanelWidth"
  | "openFileInWorkPanel"
  | "openUrlInWorkPanel"
  | "updateBrowserWorkPanelTab"
> {
  const nextFileRequest = (tab?: WorkPanelTab): WorkPanelContext["fileRequest"] => {
    if (!tab || tab.kind !== "file" || !tab.resource) return null;
    return createWorkPanelFileRequest(tab, nextWorkPanelFileRequestSeq());
  };


  return {
  openSubagentTab: (delegationId, title) => {
    const id = delegationId.trim();
    if (!id) return;
    get().openWorkPanelTab(subagentWorkPanelTab(id, title || undefined));
  },

  openWorkPanel: () => {
    // Visibility is shell state, not conversation state: revealing the panel
    // never rewrites the active conversation's retained resources.
    if (!get().activeSessionId) return;
    set({ workPanelOpen: true });
  },

  toggleWorkPanel: () => {
    const state = get();
    if (state.workPanelOpen) {
      state.collapseWorkPanel();
      return;
    }
    state.openWorkPanel();
  },

  openWorkPanelTabForSession: (sessionId, tab) => {
    if (!sessionId) return;
    if (isRemoteSession(get().sessions.find((session) => session.id === sessionId)) || sessionId.startsWith("remote:")) return;
    set((state) => {
      const affectsVisibleSession =
        state.activeSessionId === sessionId &&
        (!isSessionSelectionPending(sessionId));
      const context = affectsVisibleSession
        ? currentWorkPanelContext(state)
        : state.workPanelContexts[sessionId] ?? emptyWorkPanelContext();
      const next = openWorkPanelTabState(
        {
          tabs: context.tabs,
          activeTabId: context.activeTabId,
        },
        tab,
      );
      const fileRequest = nextFileRequest(tab) ?? context.fileRequest;
      const nextContext: WorkPanelContext = {
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest,
      };
      return {
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
        ...(affectsVisibleSession
          ? {
              workPanelOpen: true,
              workPanelTabs: next.tabs,
              activeWorkPanelTabId: next.activeTabId,
              workPanelFileRequest: fileRequest,
            }
          : {}),
      };
    });
  },
  openWorkPanelTab: (tab) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    get().openWorkPanelTabForSession(sessionId, tab);
  },
  openNewWorkPanelTab: () => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    get().openWorkPanelTabForSession(sessionId, newWorkPanelTab());
  },
  replaceWorkPanelTab: (sourceTabId, tab) => {
    set((state) => {
      const sessionId = state.activeSessionId;
      if (!sessionId) return {};
      if (isRemoteSession(state.sessions.find((session) => session.id === sessionId)) || sessionId.startsWith("remote:")) return {};
      const next = replaceWorkPanelTabState(
        {
          tabs: state.workPanelTabs,
          activeTabId: state.activeWorkPanelTabId,
        },
        sourceTabId,
        tab,
      );
      const activeTab = next.tabs.find((item) => item.id === next.activeTabId);
      const fileRequest = nextFileRequest(activeTab) ?? state.workPanelFileRequest;
      const nextContext: WorkPanelContext = {
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest,
      };
      return {
        workPanelOpen: true,
        workPanelTabs: next.tabs,
        activeWorkPanelTabId: next.activeTabId,
        workPanelFileRequest: fileRequest,
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
      };
    });
  },
  activateWorkPanelTab: (tabId) => {
    set((state) => {
      const sessionId = state.activeSessionId;
      if (!sessionId) return {};
      const next = activateWorkPanelTabState(
        {
          tabs: state.workPanelTabs,
          activeTabId: state.activeWorkPanelTabId,
        },
        tabId,
      );
      const activeTab = next.tabs.find((tab) => tab.id === next.activeTabId);
      const fileRequest = nextFileRequest(activeTab) ?? state.workPanelFileRequest;
      const nextContext: WorkPanelContext = {
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest,
      };
      return {
        activeWorkPanelTabId: next.activeTabId,
        workPanelFileRequest: fileRequest,
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
      };
    });
  },
  reorderWorkPanelTabs: (sourceTabId, targetTabId, insertAfter) => {
    set((state) => {
      const sessionId = state.activeSessionId;
      if (!sessionId) return {};
      const next = reorderWorkPanelTabsState(
        {
          tabs: state.workPanelTabs,
          activeTabId: state.activeWorkPanelTabId,
        },
        sourceTabId,
        targetTabId,
        insertAfter,
      );
      if (next.tabs === state.workPanelTabs) return {};
      const nextContext: WorkPanelContext = {
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest: state.workPanelFileRequest,
      };
      return {
        workPanelTabs: next.tabs,
        activeWorkPanelTabId: next.activeTabId,
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
      };
    });
  },
  closeWorkPanelTab: (tabId) => {
    const current = get();
    if (current.activeSessionId && current.workPanelTabs.some((tab) => tab.id === tabId && tab.resource === "pi.browser/browser")) {
      void api.pluginViewClose("pi.browser", "browser", { sessionId: current.activeSessionId, tabId })
        .catch((error) => get().showToast(String(error), { variant: "error" }));
    }
    set((state) => {
      const sessionId = state.activeSessionId;
      if (!sessionId) return {};
      const next = closeWorkPanelTabState(
        {
          tabs: state.workPanelTabs,
          activeTabId: state.activeWorkPanelTabId,
        },
        tabId,
      );
      const activeTab = next.tabs.find((tab) => tab.id === next.activeTabId);
      const fileRequest = nextFileRequest(activeTab) ?? state.workPanelFileRequest;
      const nextContext: WorkPanelContext = {
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest,
      };
      return {
        workPanelTabs: next.tabs,
        activeWorkPanelTabId: next.activeTabId,
        workPanelFileRequest: fileRequest,
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
      };
    });
  },

  closeWorkPanelTabs: (tabIds) => {
    const closingTabIds = [...new Set(tabIds)];
    if (!closingTabIds.length) return;
    const current = get();
    const sessionId = current.activeSessionId;
    if (!sessionId) return;
    const closingTabs = current.workPanelTabs.filter((tab) =>
      closingTabIds.includes(tab.id),
    );
    if (!closingTabs.length) return;
    // Native views are released per tab exactly like a single close. A tab
    // close only removes the view: no runtime, turn, or delegation is stopped.
    for (const tab of closingTabs) {
      if (tab.resource !== "pi.browser/browser") continue;
      void api
        .pluginViewClose("pi.browser", "browser", { sessionId, tabId: tab.id })
        .catch((error) => get().showToast(String(error), { variant: "error" }));
    }
    set((state) => {
      const next = closeWorkPanelTabsState(
        {
          tabs: state.workPanelTabs,
          activeTabId: state.activeWorkPanelTabId,
        },
        closingTabIds,
      );
      if (next.tabs === state.workPanelTabs) return {};
      const activeTab = next.tabs.find((tab) => tab.id === next.activeTabId);
      const fileRequest =
        nextFileRequest(activeTab) ?? state.workPanelFileRequest;
      const nextContext: WorkPanelContext = {
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest,
      };
      return {
        workPanelTabs: next.tabs,
        activeWorkPanelTabId: next.activeTabId,
        workPanelFileRequest: fileRequest,
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
      };
    });
  },
  collapseWorkPanel: () => {
    // The user closes the panel, not a conversation. No active conversation is
    // not a reason to ignore the request: an open panel can outlive one during
    // the transitional phases a select/new/fork/delete passes through.
    if (!get().workPanelOpen) return;
    set({ workPanelOpen: false });
  },
  resetWorkPanelContext: () => {
    set((state) => switchWorkPanelSession(state));
  },
  setWorkPanelWidth: (width) => {
    const committedWidth = Math.round(width);
    // Width is one field of the same durable panel preference the store
    // subscriber writes; the committed value is what persists.
    set({
      workPanelWidth: Math.max(
        WORK_PANEL_COMPACT_MIN_WIDTH,
        committedWidth,
      ),
    });
  },

  openFileInWorkPanel: (path, mimeType, position) => {
    get().openWorkPanelTab(fileWorkPanelTab(path, mimeType, position));
  },
  updateBrowserWorkPanelTab: (event) => {
    const sessionId = event.sessionId;
    if (!sessionId || !event.tabId || !event.url) return;
    set((state) => {
      const visible = state.activeSessionId === sessionId && !isSessionSelectionPending(sessionId);
      const context = visible ? currentWorkPanelContext(state) : state.workPanelContexts[sessionId];
      if (!context || !context.tabs.some((tab) => tab.id === event.tabId && tab.resource === "pi.browser/browser")) return {};
      const tabs = context.tabs.map((tab) => tab.id === event.tabId
        ? { ...tab, location: event.url, label: !event.isLoading && !event.loadError && event.title ? event.title : browserTabLabel(event.url) }
        : tab);
      return { ...(visible ? { workPanelTabs: tabs } : {}),
        workPanelContexts: { ...state.workPanelContexts, [sessionId]: { ...context, tabs } } };
    });
  },
  openUrlInWorkPanel: (url) => {
    if (isRemoteSession(get().sessions.find((session) => session.id === get().activeSessionId))) return;
    const hasBrowser = get().pluginViews.some(
      (view) => view.pluginId === "pi.browser" && view.viewId === "browser",
    );
    if (!hasBrowser) {
      if (/^https?:\/\//i.test(url.trim())) {
        void api.browserOpenExternal(url.trim());
      }
      return;
    }
    get().openWorkPanelTab(browserPluginTab(url));
  },
  };
}
