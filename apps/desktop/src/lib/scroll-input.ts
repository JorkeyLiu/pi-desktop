import {
  chainedOwnerConsumesGesture,
  consumesVerticalScroll,
  SCROLL_OWNER_ATTRIBUTE,
  SCROLL_OWNER_CHAINED,
  wheelGestureDirection,
  type ScrollInputContext,
} from "./transcript-scroll";

/** Elements that own a press: clicking one is an ordinary click. */
const CONTROL_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "summary",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='checkbox']",
  "[role='switch']",
  "[role='radio']",
].join(", ");

const EDITABLE_SELECTOR = "input, textarea, [contenteditable='true']";

/**
 * Reads what one DOM input event means for `owner`, a marked scroll container
 * (D302 nested scrollers included).
 *
 * Input is attributed to the nearest scroll container that consumes it, so a
 * wheel inside a delegate's dock never counts as the reader scrolling the
 * transcript behind it, and a press on a row control never counts as the start
 * of a scroll at all. A bounded list inside a tool card that keeps chaining at
 * its edges is asked where it actually is: while it has room it consumes the
 * gesture, and once it is at the edge the same gesture belongs to the
 * transcript, exactly as the browser hands it over.
 */
export function readScrollInputContext(
  event: Event,
  owner: Element | null,
  content: Element | null,
): ScrollInputContext {
  const target = event.target;
  const nearestOwner =
    target instanceof Element
      ? target.closest(`[${SCROLL_OWNER_ATTRIBUTE}]`)
      : null;
  const nested =
    nearestOwner !== null && nearestOwner !== owner
      ? nearestOwner.getAttribute(SCROLL_OWNER_ATTRIBUTE) === SCROLL_OWNER_CHAINED
        ? chainedOwnerConsumesGesture(nearestOwner, wheelGestureDirection(event))
        : consumesVerticalScroll(nearestOwner)
      : false;
  const context: ScrollInputContext = { nestedOwner: nested };
  if (event instanceof KeyboardEvent) {
    context.key = event.key;
    context.editable =
      target instanceof Element &&
      target.closest(EDITABLE_SELECTOR) !== null;
    return context;
  }
  if (event.type === "pointerdown") {
    const inside =
      owner !== null &&
      (target === owner || target === content || owner.contains(target as Node));
    context.pointerOnScrollSurface =
      inside &&
      !(target instanceof Element && target.closest(CONTROL_SELECTOR) !== null);
  }
  return context;
}
