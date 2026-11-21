import { forwardRef, type ReactNode, type Ref } from "react";
import { IconClose } from "./icons";
import { TooltipButton, cx } from "./ui";

export type SecondaryWindowKind = "settings" | "plugins" | "scheduled";

/**
* One in-app floating window: a quiet integrated plate over the chat it
* belongs to, not a separate page or an OS-style titled window. There is no
* title band: the plate shares the Settings content background, the single
* visible title is the destination's own header (rail + section title for
* Settings), and the accessible name stays on the dialog itself. The close
* control floats top-right over reserved content space.
*
* Only the presented plate is exposed to assistive technology. Hidden plates
* stay in the layout (`visibility`/`content-visibility`, never `display: none`)
* so their scroll offsets and drafts survive a switch, and they are both
* `inert` and `aria-hidden` so nothing behind the scrim can take focus.
*
* Initial focus lands on the plate container (not the close control), so no
* hover tooltip paints uninvited with the pointer elsewhere; the first Tab
* reaches the close control through the layer's normal trap order.
*/
export const SecondaryWindow = forwardRef(function SecondaryWindow(
  {
    kind,
    label,
    closeLabel,
    closeRef,
    active,
    onRequestClose,
    children,
  }: {
    kind: SecondaryWindowKind;
    label: string;
    closeLabel: string;
    closeRef?: Ref<HTMLButtonElement>;
    active: boolean;
    onRequestClose: () => void;
    children: ReactNode;
  },
  ref: Ref<HTMLElement>,
) {
  return (
    <section
      ref={ref}
      className={cx(
        "secondary-window",
        `secondary-window-${kind}`,
        active ? "is-active" : "is-inactive",
      )}
      role="dialog"
      aria-modal={active ? true : undefined}
      aria-label={label}
      aria-hidden={active ? undefined : true}
      inert={active ? undefined : true}
      data-secondary-window-root={kind}
      // Programmatic initial-focus target: excluded from Tab order, and the
      // plate style suppresses its outline (it is never a Tab stop).
      tabIndex={-1}
    >
      <TooltipButton
        type="button"
        className="secondary-window-close"
        data-nav="close-secondary"
        tooltip={closeLabel}
        ariaLabel={closeLabel}
        ref={closeRef}
        onClick={onRequestClose}
      >
        <IconClose size={14} aria-hidden />
      </TooltipButton>
      <div className="secondary-window-body">{children}</div>
    </section>
  );
});
