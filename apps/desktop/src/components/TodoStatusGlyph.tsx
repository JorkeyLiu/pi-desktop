import { IconCheck } from "./icons";

/*
 * One checklist item's state, shared by the Composer's todo dock and the tool
 * card's checklist so both read the same glyph. The translated state name is
 * passed in by the caller, which already knows the item's own vocabulary.
 */

export function checklistStatusSymbol(status: string): string {
  switch (status) {
    case "in_progress":
      return "◐";
    case "cancelled":
      return "⊘";
    default:
      return "○";
  }
}

export function TodoStatusGlyph({
  status,
  label,
  size = 13,
  className,
}: {
  status: string;
  /** Localized state name; the glyph is decorative without it. */
  label: string;
  size?: number;
  className?: string;
}) {
  return (
    <span className={className} role="img" aria-label={label} title={label}>
      {status === "completed" ? (
        <IconCheck size={size} aria-hidden />
      ) : (
        checklistStatusSymbol(status)
      )}
    </span>
  );
}
