import {
  lazy,
  type KeyboardEvent as ReactKeyboardEvent,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { OverlayBackdrop } from "../../components/OverlayBackdrop";
import {
  SecondaryWindow,
  type SecondaryWindowKind,
} from "../../components/SecondaryWindow";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { PortalVisibilityProvider } from "../../lib/portal-visibility";
import { escapeClaimed, SecondaryWindowActiveContext } from "../../lib/secondary-window-context";
import { secondaryWindowPageLoaders } from "../../lib/secondary-window-pages";
import type { AppState } from "../../stores/app-state";
import { RoutePending } from "./chrome";

const SettingsPage = lazy(() =>
  secondaryWindowPageLoaders.settings().then((module) => ({
    default: module.SettingsPage,
  })),
);
const ScheduledPage = lazy(() =>
  secondaryWindowPageLoaders.scheduled().then((module) => ({
    default: module.ScheduledPage,
  })),
);
const PluginsPage = lazy(() =>
  secondaryWindowPageLoaders.plugins().then((module) => ({
    default: module.PluginsPage,
  })),
);

const CLOSED: unique symbol = Symbol("closed");

/**
* Document listeners of retained window content must not answer for a surface
* the user cannot see.
*/
function visibleNestedDialog(): HTMLElement | null {
  const dialogs = document.querySelectorAll<HTMLElement>(
    '[role="dialog"][aria-modal="true"]',
  );
  for (const dialog of dialogs) {
    // The window plates themselves are the layer, not a nested surface.
    if (dialog.hasAttribute("data-secondary-window-root")) continue;
    // A retained but hidden plate keeps its React tree; its nested surfaces
    // are invisible and inert, so they cannot own Escape.
    if (dialog.closest('[aria-hidden="true"]')) continue;
    const visible = dialog.checkVisibility
      ? dialog.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })
      : dialog.getClientRects().length > 0;
    if (visible) return dialog;
  }
  return null;
}

/**
* The body-portaled menu or listbox the current Tab press came from, if any.
*
* Anchored menus and pickers portal to `document.body`, so they sit outside
* the plate's DOM subtree while belonging to its React tree. They own their
* own keys (arrow travel, typeahead, Escape-to-trigger) and move focus into
* themselves on open. Yielding only for the surface that actually contains
* the event target keeps the concession bounded: anything else still traps
* inside the presented plate, and the chat behind the scrim is inert, so
* sequential focus from a portaled menu wraps back into the modal instead
* of escaping it.
*/
function nestedMenuOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const menu = target.closest('[role="menu"], [role="listbox"]');
  if (!menu || !(menu instanceof HTMLElement)) return null;
  // An in-plate surface is already inside the trap scope.
  if (menu.closest("[data-secondary-window-root]")) return null;
  // A retained but hidden plate keeps its React tree; its surfaces are
  // invisible and inert, so they cannot own Tab.
  if (menu.closest('[aria-hidden="true"]')) return null;
  const visible = menu.checkVisibility
    ? menu.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })
    : menu.getClientRects().length > 0;
  if (!visible) return null;
  return menu;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((node) =>
    node.checkVisibility
      ? node.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })
      : node.getClientRects().length > 0,
  );
}

function focusComposer() {
  document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
}

function NativeSurfaceBlocker() {
  // Native plugin views composite above the renderer, so a scrim alone cannot
  // hide them; the shared overlay counter detaches them while a window is up.
  useBlockingOverlay();
  return null;
}

/**
* The single in-app secondary-window layer.
*
* Chat is the only home: Settings, Extensions, and Scheduled are centered
* floating windows over an inert chat shell instead of pages that replace the
* main pane. Exactly one plate is presented at a time — selecting another
* destination switches the content rather than stacking another root window —
* and every plate stays mounted after its first open so scroll offsets,
* unsaved editor drafts, and in-flight reads survive a switch.
*
* Dismissal is one path: the header close control, the scrim, and Escape all
* call `requestClose`. An open nested dialog or menu owns Escape first; the
* layer closes only when nothing above it claimed the key.
*/
export function SecondaryWindows({
  page,
  onClose,
}: {
  page: AppState["page"];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const requested: SecondaryWindowKind | null = page === "chat" ? null : page;
  const open = requested !== null;
  const [mountedKinds, setMountedKinds] = useState<SecondaryWindowKind[]>([]);
  const layerRef = useRef<HTMLDivElement>(null);
  const windowRefs = useRef(new Map<SecondaryWindowKind, HTMLElement>());
  const closeRefs = useRef(new Map<SecondaryWindowKind, HTMLButtonElement | null>());
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const explicitCloseRef = useRef(false);
  const previousRequested = useRef<SecondaryWindowKind | null | typeof CLOSED>(CLOSED);

  const requestClose = useCallback(() => {
    explicitCloseRef.current = true;
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!requested) return;
    setMountedKinds((current) =>
      current.includes(requested) ? current : [...current, requested],
    );
  }, [requested]);

  // Focus: entering a window (or switching to another one) saves the control
  // that opened it and lands on the plate container itself — never on the
  // close control, whose hover tooltip would otherwise paint uninvited with
  // the pointer elsewhere. The first Tab reaches the close control through
  // the normal trap order. Leaving returns to the opener when it still
  // exists; an external close (a scheduled run opened in chat, a session
  // selection) belongs to chat, so focus follows the conversation instead of
  // a button the user did not press.
  useLayoutEffect(() => {
    const before = previousRequested.current;
    previousRequested.current = requested;
    if (before === CLOSED) {
      if (!requested) return;
    }
    if (requested === before) return;
    if (requested) {
      const active = document.activeElement;
      // A control inside a window is not the opener: keep the trigger that
      // brought the user here so closing restores something they can use.
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        !active.closest("[data-secondary-window-root]")
      ) {
        previousFocusRef.current = active;
      }
      if (before === null || before === CLOSED) explicitCloseRef.current = false;
      const kind = requested;
      const frame = requestAnimationFrame(() => {
        const root = windowRefs.current.get(kind);
        if (root?.isConnected) root.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
    const wasExplicit = explicitCloseRef.current;
    explicitCloseRef.current = false;
    if (wasExplicit) {
      const previous = previousFocusRef.current;
      if (previous?.isConnected) {
        previous.focus({ preventScroll: true });
        return;
      }
    }
    const frame = requestAnimationFrame(focusComposer);
    return () => cancelAnimationFrame(frame);
  }, [requested]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // One Escape closes one surface: a dialog, sheet, menu, or inline editor
      // open over this window owns the key first.
      if (escapeClaimed() || visibleNestedDialog()) return;
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, requestClose]);

  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !requested) return;
    if (visibleNestedDialog()) return;
    // A body-portaled menu above the presented plate owns the Tab press that
    // started inside it; forcing focus back into the plate would break its
    // travel and its Escape-to-trigger restoration.
    if (nestedMenuOf(event.target)) return;
    const root = windowRefs.current.get(requested);
    if (!root) return;
    const focusable = focusableWithin(root);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const current = document.activeElement;
    if (!(current instanceof HTMLElement) || !root.contains(current)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && current === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (mountedKinds.length === 0) return null;

  const title: Record<SecondaryWindowKind, string> = {
    settings: t("nav.settings"),
    plugins: t("nav.plugins"),
    scheduled: t("nav.backToScheduled"),
  };
  const closeLabel = t("nav.closeSecondaryWindow");

  return (
    <div
      ref={layerRef}
      className={`secondary-window-layer${open ? " is-open" : ""}`}
      onKeyDown={trapTab}
    >
      <OverlayBackdrop
        className="secondary-window-scrim"
        onClick={() => requestClose()}
      />
      {mountedKinds.map((kind) => {
        const active = requested === kind;
        return (
          <SecondaryWindowActiveContext.Provider key={kind} value={active}>
            <PortalVisibilityProvider visible={active}>
              <SecondaryWindow
                kind={kind}
                label={title[kind]}
                closeLabel={closeLabel}
                active={active}
                onRequestClose={requestClose}
                closeRef={(node) => {
                  closeRefs.current.set(kind, node);
                }}
                ref={(node) => {
                  if (node) windowRefs.current.set(kind, node);
                  else windowRefs.current.delete(kind);
                }}
              >
                {kind === "settings" ? (
                  <Suspense fallback={<RoutePending />}>
                    <SettingsPage />
                  </Suspense>
                ) : kind === "plugins" ? (
                  <Suspense fallback={<RoutePending />}>
                    <PluginsPage />
                  </Suspense>
                ) : (
                  <Suspense fallback={<RoutePending />}>
                    <ScheduledPage />
                  </Suspense>
                )}
              </SecondaryWindow>
            </PortalVisibilityProvider>
          </SecondaryWindowActiveContext.Provider>
        );
      })}
      {open ? <NativeSurfaceBlocker /> : null}
    </div>
  );
}
