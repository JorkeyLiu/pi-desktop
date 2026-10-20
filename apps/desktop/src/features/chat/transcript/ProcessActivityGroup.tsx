import type { ReactNode } from "react";
import type { AssistantActivityItem } from "../../../lib/assistant-turns";

/**
 * The container that keeps one activity segment's rows together.
 *
 * It draws no fold of its own. The turn's process header is the only disclosure
 * above a row, so every tool, search and reasoning row inside is visible the
 * moment that header is open; each row still owns its own disclosure, and no
 * row is expanded by a parent. The container stays because chronology is what
 * it states: a segment of work is one block, and a thought that produced the
 * prose beneath it is its own sibling block rather than a row inside the
 * operation above it.
 */
export function ProcessActivityGroup({
  items,
  children,
}: {
  items: readonly AssistantActivityItem[];
  children: ReactNode;
}) {
  if (items.length === 0) return null;
  return <div className="process-activity-group">{children}</div>;
}
