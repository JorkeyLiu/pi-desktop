import type { BrowserWindow, WebContents } from "electron";
import type { BrowserState } from "@pi-desktop/shared";
import type { BrowserPane } from "./browser-view";
import { BrowserCdp } from "./browser-cdp";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const BROWSER_PLUGIN_ID = "pi.browser";
export const BROWSER_VIEW_ID = "browser";
const BROWSER_REVEAL_TIMEOUT_MS = 5_000;
const BROWSER_CDP_TIMEOUT_MS = 30_000;

/**
 * Stable layout size for pages that execute without the presentation hole.
 * Detached pages never attach to the window; they only need a sane viewport
 * so hidden snapshot/screenshot/CDP work at a predictable size. The host
 * prefers the last real guest size and falls back to this default.
 */
const BROWSER_DEFAULT_VIEWPORT: BrowserRect = { x: 0, y: 0, width: 1280, height: 800 };
const BROWSER_VIEWPORT_MIN = { width: 320, height: 240 };
const BROWSER_VIEWPORT_MAX = { width: 3840, height: 2160 };

export type BrowserRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserNavigateInput = {
  url?: string;
  path?: string;
};

/**
 * Translate a plugin-page hole into window coordinates and clamp it so the
 * guest cannot cover chat/composer outside the calling plugin view.
 */
export function clampGuestBounds(
  view: BrowserRect,
  hole: BrowserRect,
): BrowserRect | null {
  const x = Math.max(view.x, view.x + hole.x);
  const y = Math.max(view.y, view.y + hole.y);
  const right = Math.min(view.x + view.width, view.x + hole.x + hole.width);
  const bottom = Math.min(view.y + view.height, view.y + hole.y + hole.height);
  const width = Math.floor(right - x);
  const height = Math.floor(bottom - y);
  if (width < 1 || height < 1) return null;
  return {
    x: Math.floor(x),
    y: Math.floor(y),
    width,
    height,
  };
}

function asRect(value: unknown): BrowserRect | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  const width = Number(record.width);
  const height = Number(record.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  return { x, y, width, height };
}

export type BrowserHostDeps = {
  createPane: (onState: (state: BrowserState) => void, onOpenUrl: (url: string) => void) => BrowserPane;
  onOpenUrl?: (url: string, sessionId?: string) => void;
  isPluginLoaded: (pluginId: string) => boolean;
  getFileRoots: (sessionId?: string) => Promise<readonly string[]>;
  getScratchDir?: (sessionId?: string) => string | null;
  onState: (state: BrowserState) => void;
  onRevealView?: (sessionId: string, tabId?: string) => void;
};

type ChromeSurface = {
  pluginId: string;
  viewId: string;
  visible: boolean;
  bounds: BrowserRect;
};

type BrowserRevealWaiter = {
  sessionId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type BrowserPage = {
  key: string;
  sessionId: string;
  tabId: string | null;
  pane: BrowserPane;
  cdp: BrowserCdp;
  state: BrowserState | null;
  started: boolean;
  navigationVersion: number;
  navigating: boolean;
};

/**
 * Bound any CDP round trip on the guest. A page that opens a native dialog
 * or runs a busy loop never answers `debugger.sendCommand`, and neither the
 * CDP layer nor the RPC timeout table bounds it (#1611) — without this the
 * agent's browser tool call hangs forever. On timeout the whole debugger
 * session is detached as recovery, which also drops previously created
 * snapshot uids; the tool result explains the timeout so the agent can
 * re-snapshot.
 */
function withCdpDeadline<T>(
  page: BrowserPage,
  wc: WebContents,
  run: () => Promise<T>,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = Object.assign(
        new Error(`browser ${label} timed out after ${BROWSER_CDP_TIMEOUT_MS}ms`),
        { code: "TIMEOUT" },
      );
      reject(error);
      try {
        page.cdp.detach(wc);
      } catch {
        // Preserve the timeout result if the guest is already shutting down.
      }
    }, BROWSER_CDP_TIMEOUT_MS);
  });
  return Promise.race([Promise.resolve().then(run), timedOut])
    .finally(() => { if (timeout) clearTimeout(timeout); });
}

function captureScreenshotWithDeadline<T>(
  page: BrowserPage,
  capture: (wc: WebContents) => Promise<T>,
): Promise<T> {
  return page.pane.captureScreenshot((wc) =>
    withCdpDeadline(page, wc, () => capture(wc), "screenshot"),
  );
}

/** Host-owned pages, keyed by conversation and resource tab. */
export class BrowserHost {
  private readonly deps: BrowserHostDeps;
  private readonly pages = new Map<string, BrowserPage>();
  private readonly locations = new Map<string, string>();
  private readonly selectedTabs = new Map<string, string | null>();
  private readonly pendingSessions = new Map<string, string>();
  private readonly pendingTabs = new Set<string>();
  private readonly revealWaiters = new Set<BrowserRevealWaiter>();
  private active: BrowserPage | null = null;
  private window: BrowserWindow | null = null;
  private chrome: ChromeSurface | null = null;
  private hole: BrowserRect | null = null;
  private holePluginId: string | null = null;
  private lastViewport: BrowserRect | null = null;

  constructor(deps: BrowserHostDeps) { this.deps = deps; }

  setWindow(window: BrowserWindow | null): void {
    this.window = window;
    if (!window) { this.disposeGuest(); return; }
    for (const page of this.pages.values()) page.pane.setWindow(window);
    this.applyGuest();
  }

  setChromeSurface(surface: ChromeSurface | null): void {
    this.chrome = surface;
    this.applyGuest();
    this.resolveVisibleRevealWaiters();
  }

  async reveal(sessionId?: string): Promise<void> {
    const id = sessionId?.trim();
    if (!id) throw this.unavailableError("Browser reveal requires an active session.");
    if (!this.deps.isPluginLoaded(BROWSER_PLUGIN_ID)) {
      throw this.unavailableError("The Browser plugin is unavailable.");
    }
    if (this.isBrowserVisibleForSession(id)) return;
    const revealView = this.deps.onRevealView;
    if (!revealView) throw this.unavailableError("Browser view cannot be opened by this host.");

    let waiter: BrowserRevealWaiter | undefined;
    const visible = new Promise<void>((resolve, reject) => {
      const entry: BrowserRevealWaiter = {
        sessionId: id,
        resolve,
        reject: (error) => reject(error),
        timeout: setTimeout(() => {
          this.rejectRevealWaiter(
            entry,
            this.unavailableError(
              "Browser view did not become visible for the calling session. Switch to that session and retry.",
            ),
          );
        }, BROWSER_REVEAL_TIMEOUT_MS),
      };
      waiter = entry;
      this.revealWaiters.add(entry);
    });

    try {
      const tabId = this.active?.sessionId === id
        ? this.active.tabId ?? undefined
        : this.selectedTabs.get(id) ?? undefined;
      revealView(id, tabId);
    } catch (error) {
      if (waiter) {
        this.rejectRevealWaiter(
          waiter,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return visible;
  }

  getContext(): { sessionId?: string; tabId?: string } {
    return this.active ? this.contextFor(this.active) : {};
  }

  private contextFor(page: BrowserPage): { sessionId?: string; tabId?: string } {
    return {
      ...(page.sessionId ? { sessionId: page.sessionId } : {}),
      ...(page.tabId ? { tabId: page.tabId } : {}),
    };
  }

  private isBrowserVisibleForSession(sessionId: string): boolean {
    return this.chrome?.visible === true &&
      this.chrome.pluginId === BROWSER_PLUGIN_ID &&
      this.chrome.viewId === BROWSER_VIEW_ID &&
      this.active?.sessionId === sessionId;
  }

  private resolveVisibleRevealWaiters(): void {
    for (const waiter of [...this.revealWaiters]) {
      if (!this.isBrowserVisibleForSession(waiter.sessionId)) continue;
      this.revealWaiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  }

  private rejectRevealWaiter(waiter: BrowserRevealWaiter, error: Error): void {
    if (!this.revealWaiters.delete(waiter)) return;
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }

  private unavailableError(message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code: "UNAVAILABLE" });
  }

  private noPageError(sessionId: string): Error & { code: string } {
    const who = sessionId ? ` for session "${sessionId}"` : "";
    return Object.assign(
      new Error(
        `No browser page is available${who} yet. Navigate first, then read or drive the page.`,
      ),
      { code: "UNAVAILABLE" },
    );
  }

  /**
   * Execution target: the caller's own page, never the foreground page.
   *
   * A trimmed session id always binds that session's retained page (created
   * on demand for navigation, never for reads). Without a caller session the
   * presentation's active page answers, preserving the chrome/panel behavior;
   * with neither, the call fails instead of borrowing another session.
   * The returned page is pinned by the caller: later awaits must reuse it
   * rather than re-reading the active page.
   */
  private resolveTarget(
    sessionId?: string,
    tabId?: string | null,
    create = false,
  ): BrowserPage {
    const id = sessionId?.trim() ?? "";
    if (id) {
      const tab = tabId ?? this.selectedTabs.get(id) ?? null;
      const key = this.key(id, tab);
      const existing = this.pages.get(key);
      if (existing) {
        this.ensureDetachedViewport(existing);
        return existing;
      }
      if (!create) throw this.noPageError(id);
      const page = this.pageFor(id, tab);
      this.ensureDetachedViewport(page);
      return page;
    }
    if (this.active) return this.active;
    throw this.noPageError("");
  }

  /** A page whose document is ready to be read or driven. */
  private boundStartedPage(sessionId?: string, tabId?: string | null): BrowserPage {
    const page = this.resolveTarget(sessionId, tabId, false);
    if (!page.started) throw this.noPageError(page.sessionId);
    return page;
  }

  private stateOf(page: BrowserPage): BrowserState | null {
    return page.state ? { ...page.state, ...this.contextFor(page) } : null;
  }

  private trackViewport(rect: BrowserRect | null): void {
    if (!rect || rect.width < 1 || rect.height < 1) return;
    this.lastViewport = {
      x: 0,
      y: 0,
      width: Math.min(Math.max(Math.round(rect.width), BROWSER_VIEWPORT_MIN.width), BROWSER_VIEWPORT_MAX.width),
      height: Math.min(Math.max(Math.round(rect.height), BROWSER_VIEWPORT_MIN.height), BROWSER_VIEWPORT_MAX.height),
    };
  }

  /**
   * Give a non-presented page a stable layout size without attaching it.
   * Never touches visibility or the window: a detached page keeps no hole.
   */
  private ensureDetachedViewport(page: BrowserPage): void {
    if (page === this.active) return;
    const viewport = this.lastViewport ?? BROWSER_DEFAULT_VIEWPORT;
    page.pane.setBounds({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  }

  private key(sessionId: string, tabId: string | null): string {
    return JSON.stringify([sessionId, tabId]);
  }

  private pageFor(sessionId: string, tabId: string | null): BrowserPage {
    const key = this.key(sessionId, tabId);
    const existing = this.pages.get(key);
    if (existing) return existing;
    const page: BrowserPage = {
      key, sessionId, tabId, cdp: new BrowserCdp(), state: null,
      started: false, navigationVersion: 0, navigating: false,
      pane: this.deps.createPane(
        (state) => {
          if (this.pages.get(key) !== page) return;
          page.state = state;
          if (state.url && !page.navigating && !this.pendingTabs.has(key)) this.locations.set(key, state.url);
          if (this.active === page) this.publishCurrent();
        },
        (url) => {
          if (this.pages.get(key) === page) this.deps.onOpenUrl?.(url, sessionId || undefined);
        },
      ),
    };
    page.pane.setWindow(this.window);
    this.pages.set(key, page);
    return page;
  }

  private publishCurrent(): void {
    const state = this.getState();
    this.deps.onState(state ?? {
      url: "", title: "", isLoading: false, canGoBack: false, canGoForward: false,
      ...this.getContext(),
    });
  }

  setChromeSession(sessionId: string | undefined, tabId?: string, location?: string): boolean {
    const id = sessionId?.trim() || "";
    const tab = tabId ?? (this.active?.sessionId === id
      ? this.active.tabId : this.selectedTabs.get(id) ?? null);
    const page = this.pageFor(id, tab);
    if (this.active === page) return false;
    this.active?.pane.setVisible(false);
    this.active = page;
    this.selectedTabs.set(id, tab);
    const pending = this.pendingSessions.get(id);
    if (pending) {
      this.locations.set(page.key, pending);
      this.pendingTabs.add(page.key);
      this.pendingSessions.delete(id);
    }
    const target = this.locations.get(page.key) ?? location?.trim();
    const navigate = this.pendingTabs.delete(page.key) || (!page.started && !page.navigating);
    if (target && navigate) {
      page.started = false;
      page.state = null;
      this.publishCurrent();
      this.applyGuest();
      void this.navigatePage(page, target).catch((error) => {
        console.warn("Browser tab restore failed", error);
      });
    } else {
      this.publishCurrent();
      this.applyGuest();
    }
    return true;
  }

  setGuestHole(pluginId: string, hole: unknown): BrowserRect | null {
    this.hole = asRect(hole);
    this.holePluginId = pluginId;
    this.trackViewport(this.hole);
    this.applyGuest();
    return this.guestBounds();
  }

  setGuestVisible(pluginId: string, visible: boolean): void {
    if (!visible && this.holePluginId === pluginId) {
      this.active?.pane.setVisible(false);
    } else if (visible) {
      this.applyGuest();
    }
  }
  /**
   * Navigate the caller's own page. The presentation is never moved: when
   * another session is visible, its page is untouched and no reveal is
   * requested. The returned page is bound at entry and reused across the
   * lookup below, so a foreground switch mid-flight cannot redirect it.
   */
  async navigate(input: BrowserNavigateInput, sessionId?: string, tabId?: string | null): Promise<BrowserState | null> {
    const target = String(input.path ?? input.url ?? "").trim();
    const page = this.resolveTarget(sessionId, tabId, true);
    if (!target) return this.stateOf(page);
    return this.navigatePage(page, target);
  }

  private async navigatePage(page: BrowserPage, target: string): Promise<BrowserState | null> {
    const version = ++page.navigationVersion;
    page.navigating = true;
    this.locations.set(page.key, target);
    const current = () => this.pages.get(page.key) === page && page.navigationVersion === version;
    let roots: readonly string[];
    try {
      roots = await this.getFileRoots(page.sessionId || undefined);
    } catch (error) {
      if (!current()) return null;
      page.navigating = false;
      page.started = false;
      page.state = { url: target, title: "", isLoading: false, canGoBack: false,
        canGoForward: false, loadError: error instanceof Error ? error.message : String(error) };
      if (this.active === page) { this.publishCurrent(); this.applyGuest(); }
      return null;
    }
    if (!current()) return null;
    let state: BrowserState | null;
    try {
      state = await page.pane.navigateAndWait(target, roots[0] ?? null);
    } catch (error) {
      if (!current()) return null;
      page.navigating = false;
      page.started = false;
      page.state = { url: target, title: "", isLoading: false, canGoBack: false,
        canGoForward: false, loadError: error instanceof Error ? error.message : String(error) };
      if (this.active === page) { this.publishCurrent(); this.applyGuest(); }
      return null;
    }
    if (!current()) return null;
    page.navigating = false;
    page.started = state !== null;
    page.state = state ?? page.pane.getState();
    if (!this.pendingTabs.has(page.key)) this.locations.set(page.key, state?.url || target);
    if (!state && !page.state?.loadError) {
      page.state = { url: target, title: "", isLoading: false,
        canGoBack: false, canGoForward: false, loadError: "INVALID_URL" };
    }
    if (this.active === page) { this.publishCurrent(); this.applyGuest(); }
    return state ? { ...state, ...this.contextFor(page) } : null;
  }

  action(action: "back" | "forward" | "reload" | "stop", sessionId?: string, tabId?: string | null): void {
    this.boundStartedPage(sessionId, tabId).pane.action(action);
  }

  getState(): BrowserState | null {
    return this.active?.state ? { ...this.active.state, ...this.getContext() } : null;
  }

  getStateForPlugin(sessionId?: string, tabId?: string | null): BrowserState | null {
    const id = sessionId?.trim() ?? "";
    if (!id) return this.getState();
    const tab = tabId ?? this.selectedTabs.get(id) ?? null;
    const page = this.pages.get(this.key(id, tab));
    return page ? this.stateOf(page) : null;
  }

  openExternal(sessionId?: string, tabId?: string | null): void {
    this.boundStartedPage(sessionId, tabId).pane.openExternal();
  }

  private boundWebContents(sessionId?: string, tabId?: string | null): { page: BrowserPage; wc: WebContents } {
    const page = this.boundStartedPage(sessionId, tabId);
    const wc = page.pane.getWebContents();
    if (!wc || wc.isDestroyed()) throw Object.assign(new Error("browser guest is not available"), { code: "UNAVAILABLE" });
    return { page, wc };
  }

  async snapshot(sessionId?: string, tabId?: string | null): Promise<{ tree: string; url: string; title: string }> {
    const { page, wc } = this.boundWebContents(sessionId, tabId);
    return withCdpDeadline(page, wc, () => page.cdp.snapshot(wc), "snapshot");
  }

  async screenshot(input: { fullPage?: boolean } = {}, sessionId?: string, tabId?: string | null): Promise<{ mimeType: string; data: string; path?: string }> {
    const { page } = this.boundWebContents(sessionId, tabId);
    const shot = await captureScreenshotWithDeadline(page, (wc) => page.cdp.screenshot(wc, input));
    const scratch = this.deps.getScratchDir?.(sessionId ?? page.sessionId);
    if (!scratch) return shot;
    try {
      mkdirSync(scratch, { recursive: true });
      const path = join(scratch, `browser-screenshot-${Date.now()}.jpg`);
      writeFileSync(path, Buffer.from(shot.data, "base64"));
      return { ...shot, path };
    } catch { return shot; }
  }

  async click(uid: string, sessionId?: string, tabId?: string | null): Promise<void> {
    const { page, wc } = this.boundWebContents(sessionId, tabId);
    return withCdpDeadline(page, wc, () => page.cdp.click(wc, uid), "click");
  }
  async fill(uid: string, text: string, sessionId?: string, tabId?: string | null): Promise<void> {
    const { page, wc } = this.boundWebContents(sessionId, tabId);
    return withCdpDeadline(page, wc, () => page.cdp.fill(wc, uid, text), "fill");
  }
  async evaluate(expression: string, sessionId?: string, tabId?: string | null): Promise<unknown> {
    const { page, wc } = this.boundWebContents(sessionId, tabId);
    return withCdpDeadline(page, wc, () => page.cdp.evaluate(wc, expression), "evaluate");
  }
  console(limit?: number, sessionId?: string, tabId?: string | null): { messages: ReturnType<BrowserCdp["console"]> } {
    const page = sessionId?.trim() ? this.resolveTarget(sessionId, tabId, false) : this.active;
    if (!page) throw this.noPageError("");
    if (!page.started) return { messages: [] };
    const wc = page.pane.getWebContents();
    if (!wc || wc.isDestroyed()) throw Object.assign(new Error("browser guest is not available"), { code: "UNAVAILABLE" });
    void page.cdp.attach(wc);
    return { messages: page.cdp.console(limit) };
  }
  async cdpCommand(method: string, params?: unknown, sessionId?: string, tabId?: string | null): Promise<unknown> {
    const { page, wc } = this.boundWebContents(sessionId, tabId);
    if (method === "Page.captureScreenshot") {
      return captureScreenshotWithDeadline(page, (view) => page.cdp.send(view, method, params));
    }
    return withCdpDeadline(page, wc, () => page.cdp.send(wc, method, params), `cdp ${method}`);
  }

  /** The renderer-created resource tab is the preview's only navigation owner. */
  getFileRoots(sessionId?: string): Promise<readonly string[]> {
    return this.deps.getFileRoots(sessionId);
  }

  async previewFile(): Promise<{ ok: true } | { ok: false; content: string }> {
    if (!this.deps.isPluginLoaded(BROWSER_PLUGIN_ID)) return {
      ok: false, content: "BrowserPreview: the Browser plugin is disabled. Enable pi.browser in Plugins to preview HTML.",
    };
    return { ok: true };
  }

  closeTab(sessionId: string, tabId: string | null): void {
    const key = this.key(sessionId, tabId);
    const page = this.pages.get(key);
    if (page) {
      this.pages.delete(key);
      page.navigationVersion += 1;
      page.cdp.detach(page.pane.getWebContents() ?? undefined);
      page.pane.dispose();
      if (this.active === page) this.active = null;
    }
    this.locations.delete(key);
    this.pendingTabs.delete(key);
    if (this.selectedTabs.get(sessionId) === tabId) this.selectedTabs.delete(sessionId);
  }

  closeSession(sessionId: string): void {
    for (const page of [...this.pages.values()]) {
      if (page.sessionId !== sessionId) continue;
      this.closeTab(sessionId, page.tabId);
    }
    this.pendingSessions.delete(sessionId);
    this.selectedTabs.delete(sessionId);
    for (const key of this.locations.keys()) {
      if (JSON.parse(key)[0] === sessionId) { this.locations.delete(key); this.pendingTabs.delete(key); }
    }
  }

  dispose(): void { this.disposeGuest(); }

  disposeGuest(): void {
    for (const waiter of [...this.revealWaiters]) {
      this.rejectRevealWaiter(
        waiter,
        this.unavailableError("Browser view was closed before it became visible."),
      );
    }
    for (const page of this.pages.values()) {
      page.navigationVersion += 1;
      page.cdp.detach(page.pane.getWebContents() ?? undefined);
      page.pane.dispose();
    }
    this.pages.clear();
    this.active = null;
    this.hole = null;
    this.holePluginId = null;
  }

  private guestBounds(): BrowserRect | null {
    if (!this.chrome?.visible || !this.hole || this.holePluginId !== this.chrome.pluginId) return null;
    return clampGuestBounds(this.chrome.bounds, this.hole);
  }

  private applyGuest(): void {
    if (!this.active) return;
    const bounds = this.guestBounds();
    this.trackViewport(bounds);
    if (!bounds || !this.active.started) { this.active.pane.setVisible(false); return; }
    this.active.pane.setBounds(bounds);
    this.active.pane.setVisible(true);
  }
}
