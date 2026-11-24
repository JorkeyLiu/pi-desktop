import {
  shell,
  View,
  WebContentsView,
  type BrowserWindow,
  type InputEvent,
  type MouseInputEvent,
  type WebContents,
} from "electron";
import { realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserState } from "@pi-desktop/shared";
import { isAllowedHttpUrl, parseAllowedExternalUrl } from "./safe-open-external";

/**
 * Work panel embedded preview browser (D100, ADR 0019).
 *
 * A single WebContentsView owned by the main process, clipped by a native
 * presentation View positioned from renderer-measured bounds. The renderer is the
 * visibility authority: it hides the view whenever the browser tab is not
 * the active panel surface or a blocking overlay opens (the view always
 * composites above renderer content).
 *
 * Besides http(s) URLs, the pane renders existing local HTML files with live
 * reload: the loaded file's directory is watched so edits to the page or its
 * sibling assets refresh the preview.
 */
const PARTITION = "persist:work-browser";

const LIVE_RELOAD_DEBOUNCE_MS = 250;

/**
 * Focus keys that move keyboard focus between panes instead of producing
 * text. A real press of one of these in the focus owner just before it loses
 * focus is user-driven traversal (Tab / F6 toward the preview), never
 * programmatic theft.
 */
const TRAVERSAL_KEYS = new Set(["Tab", "F6"]);

/**
 * Watch against the native focus theft a programmatic preview navigation
 * performs.
 *
 * Runtime evidence (isolated Electron fixture, real BrowserHost +
 * BrowserPane): committing `loadURL` or a live `reloadIgnoringCache` in the
 * visible attached guest moves `webContents.isFocused()` from the shell
 * window contents to the guest after a variable delay, while the shell
 * document keeps reporting its editor as `activeElement` (stale:
 * `document.hasFocus()` is false). Hidden navigations, view attach, and
 * show/hide move no focus. The theft lands after the navigation settles,
 * so the watch reacts to the guest's own focus event instead of the commit.
 *
 * Event shapes follow the installed Electron 43 types: keyboard arrives on
 * `before-input-event`, mouse on `before-mouse-event`, touch and tap gestures
 * on `input-event`. The watch restores whoever actually owned focus when
 * armed (shell editor, preview chrome URL bar, or nothing). The native theft
 * can re-assert guest focus several times per navigation, so the watch keeps
 * restoring until a real user press into the preview hands focus back and
 * disarms, or owner traversal keys followed by owner blur mark user-driven
 * traversal and disarm without restoring; each restore is skipped once the
 * owner is focused again, so there is no yank loop and no permanent watch
 * that could shadow later user intent. Arming snapshots the focused contents
 * without consulting window activation (which flickers in headless runs);
 * the restore itself still requires an active window. No timers; all
 * listeners detach on takeover/traversal/hide/replace/action/dispose.
 */
interface PreviewFocusWatch {
  guest: WebContents;
  owner: WebContents | null;
  interacted: boolean;
  traversed: boolean;
  lastOwnerKey: string | null;
  onGuestFocus: () => void;
  onGuestMouse: (event: unknown, mouse: MouseInputEvent) => void;
  onGuestTouch: (event: unknown, inputEvent: InputEvent) => void;
  onOwnerKey: (event: unknown, input: { type: string; key: string }) => void;
  onOwnerBlur: () => void;
}

export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  // A dotted hostname or localhost followed by a numeric port is an HTTP
  // address, not a custom scheme. Keep other schemes subject to the allowlist.
  const hasHostPort =
    /^(?:localhost|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z0-9-]+):\d+(?:[/?#]|$)/i.test(trimmed);
  const withScheme = hasScheme && !hasHostPort
    ? trimmed
    : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isWithinRoot(path: string, root: string): boolean {
  try {
    const realRoot = realpathSync(resolve(root));
    const realPath = realpathSync(resolve(path));
    return realPath === realRoot || realPath.startsWith(realRoot + sep);
  } catch {
    const resolvedRoot = resolve(root);
    const resolvedPath = resolve(path);
    return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + sep);
  }
}

function resolveExistingFile(candidate: string): string | null {
  try {
    const real = realpathSync(resolve(candidate));
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function fileUrlToLocalPath(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return null;
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/**
 * Resolve a BrowserPreview input to a previewable file inside the workspace.
 * It accepts a file:// URL, absolute path, or workspace-relative path. This
 * stays workspace-scoped for the Agent BrowserPreview tool and sidecar.
 */
export function resolveLocalFile(raw: string, root: string | null): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !root) return null;
  let candidate: string | null = null;
  if (/^file:/i.test(trimmed)) {
    try {
      candidate = fileURLToPath(trimmed);
    } catch {
      return null;
    }
  } else if (isAbsolute(trimmed)) {
    candidate = trimmed;
  } else if (/^\.{1,2}\//.test(trimmed) || /\.[a-zA-Z0-9]+$/.test(trimmed)) {
    candidate = resolve(root, trimmed);
  }
  if (!candidate) return null;
  if (!isWithinRoot(candidate, root)) return null;
  const real = resolveExistingFile(candidate);
  return real && isWithinRoot(real, root) ? real : null;
}

/**
 * Resolve a file requested by the embedded browser. Explicit file URLs and
 * absolute paths may target any existing local file; relative inputs remain
 * rooted in the current workspace. BrowserPreview uses resolveLocalFile.
 */
function resolveBrowserLocalFile(raw: string, root: string | null): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^file:/i.test(trimmed)) {
    const candidate = fileUrlToLocalPath(trimmed);
    return candidate ? resolveExistingFile(candidate) : null;
  }
  if (isAbsolute(trimmed)) return resolveExistingFile(trimmed);
  return resolveLocalFile(trimmed, root);
}

export class BrowserPane {
  private view: WebContentsView | null = null;
  private surface: View | null = null;
  private window: BrowserWindow | null = null;
  private visible = false;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  private capturing = false;
  private captureTail: Promise<void> = Promise.resolve();
  private onState: (state: BrowserState) => void;
  private fileRoot: string | null = null;
  private watcher: FSWatcher | null = null;
  private watchedDir: string | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private navigationEpoch = 0;
  private stateEventsEpoch: number | null = null;
  private stateUrl: string | null = null;
  private nativeNavigationPending = false;
  private pendingTarget: string | null = null;
  private loadError: { url: string; message: string } | null = null;
  private cancelPending: (() => void) | null = null;
  private focusWatch: PreviewFocusWatch | null = null;

  private readonly onOpenUrl?: (url: string) => void;

  constructor(onState: (state: BrowserState) => void, onOpenUrl?: (url: string) => void) {
    this.onState = onState;
    this.onOpenUrl = onOpenUrl;
  }

  setWindow(window: BrowserWindow | null): void {
    if (this.window === window) return;
    this.detach();
    this.window = window;
  }

  getState(): BrowserState | null {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) {
      return this.loadError ? {
        url: this.loadError.url,
        title: "",
        isLoading: false,
        loadError: this.loadError.message,
        canGoBack: false,
        canGoForward: false,
      } : null;
    }
    return {
      url: this.loadError?.url ?? this.pendingTarget ?? wc.getURL(),
      title: wc.getTitle(),
      isLoading: !this.loadError && (this.pendingTarget !== null || wc.isLoading()),
      ...(this.loadError ? { loadError: this.loadError.message } : {}),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  }

  getWebContents() {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  }

  /** Serialize captures with native resizing on this page only. */
  captureScreenshot<T>(capture: (wc: WebContents) => Promise<T>): Promise<T> {
    // Pin the guest before queueing so a closed/recreated page cannot receive
    // a screenshot requested for its predecessor.
    const wc = this.getWebContents();
    const task = this.captureTail.then(async () => {
      if (!wc || wc.isDestroyed() || this.getWebContents() !== wc) {
        throw Object.assign(new Error("browser guest is not available"), { code: "UNAVAILABLE" });
      }
      this.capturing = true;
      try {
        return await capture(wc);
      } finally {
        this.capturing = false;
        this.applyBounds();
      }
    });
    // The caller still receives capture errors; a failure must not block the
    // next independent capture.
    this.captureTail = task.then(() => undefined, () => undefined);
    return task;
  }

  /**
   * Stop native WebContents events from publishing state for the document
   * that belonged to the previous session. The next completed managed
   * navigation establishes a new event scope.
   */
  invalidateNavigation(): void {
    this.cancelPending?.();
    this.cancelPending = null;
    this.pendingTarget = null;
    this.loadError = null;
    this.navigationEpoch += 1;
    this.stateEventsEpoch = null;
    this.stateUrl = null;
    this.nativeNavigationPending = false;
  }

  navigate(raw: string, fileRoot: string | null = null): BrowserState | null {
    void this.navigateAndWait(raw, fileRoot);
    return this.getState();
  }

  async navigateAndWait(
    raw: string,
    fileRoot: string | null = null,
    timeoutMs = 15_000,
  ): Promise<BrowserState | null> {
    if (fileRoot) this.fileRoot = fileRoot;
    const localPath = resolveBrowserLocalFile(raw, this.fileRoot);
    const trimmed = raw.trim();
    const localInput = /^file:/i.test(trimmed) || isAbsolute(trimmed) || /^\.{1,2}\//.test(trimmed);
    const target = localPath
      ? pathToFileURL(localPath).toString()
      : localInput ? null : normalizeUrl(raw);
    if (!target) {
      this.beginManagedNavigation();
      this.loadError = { url: raw, message: localInput ? "LOCAL_FILE_NOT_ALLOWED" : "INVALID_URL" };
      const state = this.getState();
      if (state) this.onState(state);
      return null;
    }
    const epoch = this.beginManagedNavigation();
    this.pendingTarget = target;
    this.loadError = null;
    if (localPath) this.watchDirForReload(dirname(localPath));
    else this.clearLiveReload();
    const view = this.ensureView();
    const wc = view.webContents;
    this.watchPreviewFocus(wc);
    const loading = this.getState();
    if (loading) this.onState(loading);
    if (this.visible) this.attach();
    return new Promise<BrowserState | null>((resolve) => {
      let settled = false;
      let started = false;
      const destinations = new Set([target]);
      const finish = (committed: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        wc.removeListener("did-start-navigation", onStart);
        wc.removeListener("did-navigate", onCommit);
        wc.removeListener("did-redirect-navigation", onRedirect);
        wc.removeListener("did-fail-load", onFailure);
        if (epoch !== this.navigationEpoch) { resolve(null); return; }
        this.cancelPending = null;
        this.pendingTarget = null;
        if (error) this.loadError = { url: target, message: error };
        const state = this.getState();
        if (committed && state) this.enableStateEvents(epoch, state.url);
        if (error && state) this.onState(state);
        resolve(committed ? state : null);
      };
      const onStart = (_event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => {
        if (mainFrame && !inPlace && url === target) started = true;
      };
      const onRedirect = (_event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => {
        if (started && mainFrame && !inPlace && epoch === this.navigationEpoch) destinations.add(url);
      };
      const onFailure = (_event: unknown, code: number, description: string, url: string, mainFrame: boolean) => {
        if (mainFrame !== false && code !== -3 && destinations.has(url)) finish(false, description);
      };
      const onCommit = (_event: unknown, url: string) => {
        // A current main-frame commit is ready to display even if images or
        // subframes are still loading. Old-session events cannot satisfy it.
        if (started && epoch === this.navigationEpoch && destinations.has(url) && url === wc.getURL()) finish(true);
      };
      const timer = setTimeout(() => finish(false, "ERR_TIMED_OUT"), Math.max(1, timeoutMs));
      this.cancelPending = () => finish(false);
      wc.on("did-start-navigation", onStart);
      wc.on("did-navigate", onCommit);
      wc.on("did-redirect-navigation", onRedirect);
      wc.on("did-fail-load", onFailure);
      void wc.loadURL(target).then(
        () => { if (destinations.has(wc.getURL())) finish(true); },
        (error: unknown) => finish(false, error instanceof Error ? error.message : String(error)),
      );
    });
  }
  /**
   * Arm the theft watch on the navigation's guest: snapshot whoever actually
   * holds keyboard focus right now (shell editor, preview chrome URL bar, or
   * nothing when the user already works inside the
   * preview), and listen for the guest's own focus event plus real input
   * reaching it. Re-arming replaces the previous watch, so at most one
   * listener pair is ever attached per pane.
   */
  private watchPreviewFocus(wc: WebContents): void {
    this.unwatchPreviewFocus();
    if (this.isGone(wc)) return;
    const watch: PreviewFocusWatch = {
      guest: wc,
      owner: null,
      interacted: false,
      traversed: false,
      lastOwnerKey: null,
      onGuestFocus: () => {},
      onGuestMouse: () => {},
      onGuestTouch: () => {},
      onOwnerKey: () => {},
      onOwnerBlur: () => {},
    };
    watch.owner = this.focusedPreviewOwner(wc);
    watch.onGuestFocus = () => this.onPreviewGuestFocus(watch);
    watch.onGuestMouse = (_event: unknown, mouse: MouseInputEvent) => this.onPreviewGuestMouse(watch, mouse);
    watch.onGuestTouch = (_event: unknown, inputEvent: InputEvent) => this.onPreviewGuestTouch(watch, inputEvent);
    wc.on("focus", watch.onGuestFocus);
    wc.on("before-mouse-event", watch.onGuestMouse);
    wc.on("input-event", watch.onGuestTouch);
    const owner = watch.owner;
    if (owner && !this.isGone(owner)) {
      watch.onOwnerKey = (_event: unknown, input: { type: string; key: string }) =>
        this.onPreviewOwnerKey(watch, input);
      watch.onOwnerBlur = () => this.onPreviewOwnerBlur(watch);
      owner.on("before-input-event", watch.onOwnerKey);
      owner.on("blur", watch.onOwnerBlur);
    }
    this.focusWatch = watch;
  }

  /**
   * Remove the theft watch's listeners. Called on hide, view replacement,
   * window changes, disposal, and once the user takes the preview over.
   */
  private unwatchPreviewFocus(): void {
    const watch = this.focusWatch;
    this.focusWatch = null;
    if (!watch) return;
    // Literal event names keep Electron 43's typed removeListener overloads;
    // isGone guards swallow the known destroy/teardown races, and anything
    // else stays diagnosable below.
    const guestGone = this.isGone(watch.guest);
    const owner = watch.owner;
    const ownerGone = !owner || this.isGone(owner);
    try {
      if (!guestGone) {
        watch.guest.removeListener("focus", watch.onGuestFocus);
        watch.guest.removeListener("before-mouse-event", watch.onGuestMouse);
        watch.guest.removeListener("input-event", watch.onGuestTouch);
      }
      if (!ownerGone) {
        owner.removeListener("before-input-event", watch.onOwnerKey);
        owner.removeListener("blur", watch.onOwnerBlur);
      }
    } catch (error) {
      if (!this.isGone(watch.guest) || (watch.owner && !this.isGone(watch.owner))) {
        console.error("[browser] preview focus detach failed", error);
      }
    }
  }

  /** Destroyed-or-neutered contents: never touch, whatever the caller holds. */
  private isGone(wc: WebContents): boolean {
    try {
      return wc.isDestroyed();
    } catch {
      // Neutered mid-teardown throws on access: treat as gone (known race).
      return true;
    }
  }

  /** A window torn down mid-check throws on access: treat as gone. */
  private windowGone(): boolean {
    try {
      const win = this.window;
      return !win || win.isDestroyed();
    } catch {
      return true;
    }
  }

  /**
   * Whoever holds keyboard focus now, excluding the given guest: the shell
   * window contents or any other attached plugin view (e.g. the preview
   * chrome's URL bar). Null when the window is gone or the user is already
   * inside this guest. Window activation is not consulted (see body).
   */
  private focusedPreviewOwner(guest: WebContents): WebContents | null {
    // Best-effort snapshot: focus preservation must never break the
    // navigation it protects, whatever partial window shape a caller passes.
    // Window activation is deliberately NOT consulted here: in headless and
    // CI runs the window can report inactive at arm time while the shell
    // editor genuinely owns keyboard focus, and arming ownerless would leave
    // the coming theft unrestored. The restore itself still requires an
    // active window, so a backgrounded app is never yanked forward.
    try {
      const win = this.window;
      if (!win || win.isDestroyed()) return null;
      const shell = win.webContents;
      if (shell && !shell.isDestroyed() && shell.isFocused()) return shell;
      const visit = (views: readonly View[]): WebContents | null => {
        for (const child of views) {
          if (child instanceof WebContentsView) {
            const contents = child.webContents;
            if (contents && !contents.isDestroyed() && contents !== guest && contents.isFocused()) {
              return contents;
            }
          }
          const nested = visit(child.children);
          if (nested) return nested;
        }
        return null;
      };
      return visit(win.contentView.children);
    } catch (error) {
      // A window torn down mid-snapshot is a known race: stay unarmed.
      // Anything else is unexpected and must stay diagnosable.
      if (!this.windowGone()) console.error("[browser] preview focus snapshot failed", error);
      return null;
    }
  }

  /**
   * The guest took keyboard focus. Restore the recorded owner whenever the
   * watch is still current, the window is active, the owner is intact and
   * unfocused, the guest is really focused, and no real user action reached
   * the guest first: that combination is the programmatic theft, not the
   * user. The native theft can re-assert focus several times after one
   * navigation (measured seconds apart), so the focus listener stays
   * attached across restores; each restore is a no-op once the owner is
   * focused again, so there is no yank loop. User takeover (press into the
   * preview) or user traversal (traversal key in the owner before it lost
   * focus) disarms without restoring. An inactive window skips the restore
   * but stays armed, so a backgrounded app is never yanked forward.
   */
  private onPreviewGuestFocus(watch: PreviewFocusWatch): void {
    if (watch !== this.focusWatch) return;
    if (watch.interacted || watch.traversed || !watch.owner || this.isGone(watch.owner)) {
      this.unwatchPreviewFocus();
      return;
    }
    let win: BrowserWindow | null = null;
    try {
      win = this.window;
      if (!win || win.isDestroyed() || !win.isFocused()) return;
    } catch (error) {
      if (!this.windowGone()) console.error("[browser] preview focus guard failed", error);
      return;
    }
    if (watch.owner.isFocused()) return;
    if (this.isGone(watch.guest) || !watch.guest.isFocused()) return;
    watch.owner.focus();
    // No detach here: a later theft wave re-fires this same listener and is
    // restored the same way, while a racing real click still hands focus
    // back through before-mouse-event/input-event and detaches everything.
    // Every listener detaches on takeover, traversal, replacement, hide,
    // action, window change, or dispose — never a permanent lock.
  }

  /**
   * A real mouse press reached the guest. The native focus transfer lands
   * ahead of the input event, so an eager restore may have run first: hand
   * focus back to the user's press and detach. Hover, scroll, movement, and
   * releases alone never take ownership, so the watch stays armed for a
   * later programmatic navigation.
   */
  private onPreviewGuestMouse(watch: PreviewFocusWatch, mouse: MouseInputEvent): void {
    if (watch !== this.focusWatch) return;
    if (mouse.type !== "mouseDown") return;
    watch.interacted = true;
    const guest = watch.guest;
    this.unwatchPreviewFocus();
    // Unconditional: the eager restore above may have run a tick earlier, so
    // the guest can report either state here. Focusing an already-focused
    // guest is a harmless no-op; the watch is already detached, so no focus
    // event it emits can restore again.
    if (!this.isGone(guest)) guest.focus();
  }

  /**
   * A real touch press or tap gesture reached the guest: same ownership
   * transfer as a mouse press. Touch comes through `input-event`, whose
   * union carries these types; other gestures (scroll, pinch, fling) and
   * pointer hover never take ownership.
   */
  private onPreviewGuestTouch(watch: PreviewFocusWatch, inputEvent: InputEvent): void {
    if (watch !== this.focusWatch) return;
    if (inputEvent.type !== "touchStart" && inputEvent.type !== "gestureTapDown") return;
    watch.interacted = true;
    const guest = watch.guest;
    this.unwatchPreviewFocus();
    if (!this.isGone(guest)) guest.focus();
  }

  /** Record the owner's latest key press while the watch is armed. */
  private onPreviewOwnerKey(watch: PreviewFocusWatch, input: { type: string; key: string }): void {
    if (watch !== this.focusWatch) return;
    if (input.type !== "keyDown") return;
    watch.lastOwnerKey = typeof input.key === "string" ? input.key : null;
  }

  /**
   * The owner lost focus. When its latest key press was a traversal key, the
   * user is moving focus between panes (Tab / F6 toward the preview): mark
   * the traversal so the following guest focus disarms instead of restoring.
   * Any other key (typing, Enter, shortcuts) leaves the watch armed.
   */
  private onPreviewOwnerBlur(watch: PreviewFocusWatch): void {
    if (watch !== this.focusWatch) return;
    if (watch.lastOwnerKey && TRAVERSAL_KEYS.has(watch.lastOwnerKey)) watch.traversed = true;
  }
  action(action: "back" | "forward" | "reload" | "stop"): void {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    // Back/forward/reload/stop only run from the preview chrome UI: the user
    // is driving the preview, so focus ownership transfers to them.
    this.unwatchPreviewFocus();
    if (action === "stop" && this.pendingTarget) {
      const url = this.pendingTarget;
      this.cancelPending?.();
      this.loadError = { url, message: "ERR_ABORTED" };
      wc.stop();
      const state = this.getState();
      if (state) this.onState(state);
      return;
    }
    if (action === "back" && wc.navigationHistory.canGoBack()) {
      this.nativeNavigationPending = this.hasCurrentStateEventScope();
      wc.navigationHistory.goBack();
    } else if (action === "forward" && wc.navigationHistory.canGoForward()) {
      this.nativeNavigationPending = this.hasCurrentStateEventScope();
      wc.navigationHistory.goForward();
    } else if (action === "reload") {
      this.nativeNavigationPending = this.hasCurrentStateEventScope();
      wc.reload();
    } else if (action === "stop") {
      wc.stop();
    }
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    const safe = {
      x: Math.max(0, Math.round(Number(bounds.x) || 0)),
      y: Math.max(0, Math.round(Number(bounds.y) || 0)),
      width: Math.max(0, Math.round(Number(bounds.width) || 0)),
      height: Math.max(0, Math.round(Number(bounds.height) || 0)),
    };
    this.bounds = safe;
    this.applyBounds();
  }

  private applyBounds(): void {
    // Move and clip the presentation surface immediately, even while Chromium
    // pins its capture-time viewport. A pending screenshot must not leave the
    // guest over the conversation when the window or work panel moves.
    this.surface?.setBounds(this.bounds);
    // A detached background page is never attached to the window, but it still
    // needs a stable layout viewport: snapshot geometry and CDP input
    // coordinates are meaningless while the view keeps its zero-size default.
    // Visibility only controls attachment, never the view's own size.
    if (this.view && !this.capturing && this.getWebContents()) {
      this.view.setBounds({ x: 0, y: 0, width: this.bounds.width, height: this.bounds.height });
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!this.view) return;
    this.surface?.setVisible(visible);
    this.view.setVisible?.(visible);
    if (visible) {
      this.attach();
      // A show without a new navigation (tab switch back, overlay lifted)
      // re-arms the theft watch with whoever owns focus now — but never
      // replaces an armed watch, so a user's takeover is never cleared.
      if (!this.focusWatch) {
        const current = this.getWebContents();
        if (current) this.watchPreviewFocus(current);
      }
    } else this.detach();
  }

  openExternal(): void {
    const url = this.getWebContents()?.getURL();
    if (!url) return;
    const allowed = parseAllowedExternalUrl(url);
    if (allowed) {
      void shell.openExternal(allowed);
      return;
    }
    if (this.isAllowedFileUrl(url)) {
      try {
        void shell.openPath(fileURLToPath(url));
      } catch {
        // Invalid file URL — leave the preview in place.
      }
    }
  }

  dispose(): void {
    this.invalidateNavigation();
    this.clearLiveReload();
    this.detach();
    if (this.view) {
      const wc = this.getWebContents();
      this.surface?.removeChildView(this.view);
      this.view = null;
      this.surface = null;
      wc?.close();
    }
  }

  private attach(): void {
    if (!this.window || this.window.isDestroyed() || !this.surface) return;
    const children = this.window.contentView.children;
    // The guest hole sits on top of plugin chrome. Re-adding a plugin view
    // after this pane is attached would cover the guest unless we keep it last.
    if (children.includes(this.surface) && children[children.length - 1] !== this.surface) {
      this.window.contentView.removeChildView(this.surface);
    }
    if (!this.window.contentView.children.includes(this.surface)) {
      this.window.contentView.addChildView(this.surface);
    }
    this.applyBounds();
  }

  private detach(): void {
    this.unwatchPreviewFocus();
    if (!this.window || this.window.isDestroyed() || !this.surface) return;
    const children = this.window.contentView.children;
    if (children.includes(this.surface)) {
      this.window.contentView.removeChildView(this.surface);
    }
  }

  /** Watch the previewed file's directory so page + asset edits re-render. */
  private watchDirForReload(dir: string): void {
    if (this.watcher && this.watchedDir === dir) return;
    this.clearLiveReload();
    try {
      this.watcher = watch(dir, { persistent: false }, () => this.scheduleReload());
      this.watchedDir = dir;
    } catch {
      this.watcher = null;
      this.watchedDir = null;
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      const wc = this.view?.webContents;
      if (wc && !wc.isDestroyed() && wc.getURL().startsWith("file:")) {
        // The user may have moved into the preview chrome since the last
        // navigation armed the watch: re-snapshot whoever owns focus now so
        // a reload theft restores them, not a stale earlier owner.
        this.watchPreviewFocus(wc);
        wc.reloadIgnoringCache();
      }
    }, LIVE_RELOAD_DEBOUNCE_MS);
  }

  private clearLiveReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
    this.watchedDir = null;
  }

  private isAllowedFileUrl(url: string): boolean {
    const localPath = resolveBrowserLocalFile(url, this.fileRoot);
    if (!localPath) return false;
    if (this.fileRoot && isWithinRoot(localPath, this.fileRoot)) return true;
    // Preserve workspace-file links from web pages, but only let a local
    // document navigate to files outside that workspace.
    return this.view?.webContents.getURL().startsWith("file:") === true;
  }

  private ensureView(): WebContentsView {
    if (this.view && this.getWebContents()) return this.view;
    this.detach();
    if (this.view) this.surface?.removeChildView(this.view);
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: true,
        partition: PARTITION,
      },
    });
    const surface = new View();
    surface.addChildView(view);
    surface.setVisible(this.visible);
    surface.setBounds(this.bounds);
    this.surface = surface;
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      const allowed = parseAllowedExternalUrl(url);
      if (allowed) {
        if (this.onOpenUrl) this.onOpenUrl(allowed);
        else void shell.openExternal(allowed);
      }
      return { action: "deny" };
    });
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });
    wc.on("will-navigate", (event, url) => {
      if (isAllowedHttpUrl(url)) {
        this.nativeNavigationPending = this.hasCurrentStateEventScope();
        return;
      }
      // Keep web pages inside the existing workspace-file allowance. A local
      // file page may follow links to any other existing local file.
      if (/^file:/i.test(url) && this.isAllowedFileUrl(url)) {
        this.nativeNavigationPending = this.hasCurrentStateEventScope();
        return;
      }
      event.preventDefault();
    });
    wc.on("did-navigate", (_event, url) => {
      if (!this.acceptNativeNavigation(url)) return;
      if (!/^file:/i.test(url)) return;
      try {
        this.watchDirForReload(dirname(fileURLToPath(url)));
      } catch {
        // Non-path file URL — keep the previous watcher.
      }
    });
    const push = () => {
      if (!this.hasCurrentStateEventScope()) return;
      const url = wc.getURL();
      if (this.stateUrl !== url) return;
      const state = this.getState();
      if (state) this.onState(state);
    };
    wc.on("did-start-loading", push);
    wc.on("did-stop-loading", push);
    wc.on("did-navigate", (_event, url) => {
      if (this.acceptNativeNavigation(url)) push();
    });
    wc.on("did-navigate-in-page", (_event, url, isMainFrame, processId, routingId) => {
      // Same-document navigation has no will-navigate event. Accept only the
      // active main frame's current URL, without reopening invalidated sessions.
      if (
        !isMainFrame ||
        !this.hasCurrentStateEventScope() ||
        url !== wc.getURL() ||
        processId !== wc.mainFrame.processId ||
        routingId !== wc.mainFrame.routingId
      ) return;
      this.enableStateEvents(this.navigationEpoch, url);
      push();
    });
    wc.on("page-title-updated", push);
    wc.on(
      "did-fail-load",
      (_event, _errorCode, _errorDescription, validatedUrl, isMainFrame) => {
        // Replacing a still-loading document aborts its old request. That
        // event must not consume the pending navigation to the new document.
        if (isMainFrame === false || _errorCode === -3) return;
        if (this.acceptNativeNavigation(validatedUrl)) push();
      },
    );
    this.view = view;
    // A view created for a background page never passes through attach():
    // size it from the stored bounds (the detached viewport) immediately so
    // layout and CDP input coordinates are sane before first paint.
    this.applyBounds();
    return view;
  }

  private beginManagedNavigation(): number {
    this.cancelPending?.();
    this.cancelPending = null;
    this.pendingTarget = null;
    this.loadError = null;
    const epoch = ++this.navigationEpoch;
    this.stateEventsEpoch = null;
    this.stateUrl = null;
    this.nativeNavigationPending = false;
    return epoch;
  }

  private enableStateEvents(epoch: number, url: string): void {
    if (epoch !== this.navigationEpoch) return;
    this.stateEventsEpoch = epoch;
    this.stateUrl = url;
    this.nativeNavigationPending = false;
  }

  private hasCurrentStateEventScope(): boolean {
    return this.stateEventsEpoch === this.navigationEpoch && this.stateUrl !== null;
  }

  private acceptNativeNavigation(url: string): boolean {
    if (!this.hasCurrentStateEventScope()) return false;
    if (url === this.stateUrl) {
      this.nativeNavigationPending = false;
      return true;
    }
    if (!this.nativeNavigationPending) return false;
    this.stateUrl = url;
    this.nativeNavigationPending = false;
    return true;
  }
}
