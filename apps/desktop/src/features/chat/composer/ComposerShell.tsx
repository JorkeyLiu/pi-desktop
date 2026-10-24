import type { ComponentPropsWithRef, ReactNode } from "react";

export type ComposerShellProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  /** Input is gated by the surface's own policy (read-only, blocked send, …). */
  gated?: boolean;
  /** A native file drop is hovering the box. */
  dropTarget?: boolean;
  children: ReactNode;
};

/**
 * The composer box: one rounded, elevated surface that holds the editable and
 * its toolbar. Layout only — draft state, submission, attachments, and the
 * toolbar contents belong to whichever composer renders it, so the main chat
 * composer and the subagent panel share the same box without sharing policy.
 */
export function ComposerShell({
  gated = false,
  dropTarget = false,
  className,
  children,
  ...rest
}: ComposerShellProps) {
  const shellClass = [
    "composer-shell",
    gated ? "is-gated" : "",
    dropTarget ? "is-drop-target" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div {...rest} className={shellClass}>
      {children}
    </div>
  );
}
