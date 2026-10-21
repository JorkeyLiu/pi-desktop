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
  openWorkPanelTabState,
  reorderWorkPanelTabsState,
  replaceWorkPanelTabState,
  sanitizeWorkPanelTabsState,
  subagentWorkPanelTab,
  switchWorkPanelContextState,
  type WorkPanelContext,
  type WorkPanelTab,
} from "../../lib/work-panel-tabs";
import {
  WORK_PANEL_COMPACT_MIN_WIDTH,
  WORK_PANEL_DEFAULT_WIDTH,
} from "../../lib/work-panel-resize";
import type { AppState } from "../app-state";
import type { StoreAccess } from "./types";

const WORK_PANEL_STORAGE_KEY = "pi.desktop.workPanel";

export function loadWorkPanelWidth(): number {
  try {
    const raw = localStorage.getItem(WORK_PANEL_STORAGE_KEY);
    if (!raw) return WORK_PANEL_DEFAULT_WIDTH;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const width = Number(parsed.width);
    return Number.isFinite(width)
      ? Math.max(
          WORK_PANEL_COMPACT_MIN_WIDTH,
          Math.round(width),
        )
      : WORK_PANEL_DEFAULT_WIDTH;
  } catch {
    return WORK_PANEL_DEFAULT_WIDTH;
  }
}

function saveWorkPanelWidth(width: number): void {
  try {
    localStorage.setItem(WORK_PANEL_STORAGE_KEY, JSON.stringify({ width }));
  } catch {
    // best-effort persistence
  }
}

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
  let workPanelFileRequestSeq = 0;
  const nextFileRequest = (tab?: WorkPanelTab): WorkPanelContext["fileRequest"] => {
    if (!tab || tab.kind !== "file" || !tab.resource) return null;
    return createWorkPanelFileRequest(tab, ++workPanelFileRequestSeq);
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
    set({
      workPanelWidth: Math.max(
        WORK_PANEL_COMPACT_MIN_WIDTH,
        committedWidth,
      ),
    });
    saveWorkPanelWidth(get().workPanelWidth);
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
