import { createContext, useContext, useEffect } from "react";

/**
 * Whether the secondary window that contains this subtree is the one currently
 * presented.
 *
 * Settings, Extensions, and Scheduled stay mounted once opened so their scroll
 * offsets, editor drafts, and in-flight reads survive a switch. A hidden slot
 * keeps its React tree, but its global document listeners (Escape, mousedown)
 * must not answer for a surface the user cannot see, so every window-scoped
 * listener checks this context first. Defaults to `true` so chat-side surfaces
 * keep their existing behavior.
 */
export const SecondaryWindowActiveContext = createContext(true);

export function useSecondaryWindowActive(): boolean {
  return useContext(SecondaryWindowActiveContext);
}

/*
 * One Escape belongs to one surface.
 *
 * A secondary window dismisses itself on Escape, so a surface open on top of it
 * — a dialog, a sheet, an anchored menu, an inline editor — has to say that it
 * is the current owner. The window layer cannot infer that from the key
 * sequence: nested listeners are registered in a different phase, and several
 * of them close by unmounting before the window's own listener runs. Owners
 * therefore announce themselves while they are open, and the layer closes
 * only when the stack is empty.
 */
const escapeOwners = new Set<symbol>();

/** Register an Escape owner; call the returned release when it closes. */
export function claimEscape(): () => void {
  const owner = Symbol("escape-owner");
  escapeOwners.add(owner);
  return () => {
    escapeOwners.delete(owner);
  };
}

/** Whether a surface above the window currently owns Escape. */
export function escapeClaimed(): boolean {
  return escapeOwners.size > 0;
}

/**
 * Keep Escape ownership while `active`. Surfaces already gate their global
 * listeners on `useSecondaryWindowActive()`; they pass that same flag here so a
 * retained-but-hidden window owns nothing.
 */
export function useEscapeOwner(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const release = claimEscape();
    return release;
  }, [active]);
}
