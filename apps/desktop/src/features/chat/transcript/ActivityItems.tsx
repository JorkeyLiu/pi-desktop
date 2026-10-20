import { memo, useMemo } from "react";
import type { UiMessage } from "@pi-desktop/shared";
import type { AssistantActivityItem } from "../../../lib/assistant-turns";
import { foldedWaitCheckpointGroups, isDelegationActivityItem, type SubagentOutcome, type SubagentTiming } from "../../../lib/subagent-topology";
import { ThinkingRow } from "./shared";
import { HostedSearchRow } from "./HostedSearchRow";
import { FoldedWaitCheckpoints, ToolRow } from "./ToolRow";
import { useRenderBlocks, type RenderBlock } from "./render-blocks";

function itemKey(item: AssistantActivityItem) {
  if (item.kind === "tool") return item.message.id;
  if (item.kind === "hostedSearch") return `hosted-search-${item.message.id}-${item.round.id}`;
  return `thinking-${item.message.id}`;
}

type ActivityItemsProps = {
  items: readonly AssistantActivityItem[];
  isActive: boolean;
  live: boolean;
  delegationStatuses: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings: ReadonlyMap<string, SubagentTiming>;
  onUserInteraction: () => void;
};

type ActivityItemBlockProps = Omit<ActivityItemsProps, "items" | "delegationStatuses" | "delegationTimings"> & {
  block: RenderBlock<AssistantActivityItem>;
  lastItem?: AssistantActivityItem;
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
  /** Folded wait checkpoints owned by this block's anchor row, if any. */
  foldedCheckpoints?: ReadonlyMap<string, UiMessage[]>;
};

const ActivityItemBlock = memo(function ActivityItemBlock({
  block, isActive, live, lastItem,
  delegationStatuses, delegationTimings, foldedCheckpoints, onUserInteraction,
}: ActivityItemBlockProps) {
  return <>{block.items.map((item) => {
    // A `Task` call that starts a delegation is the child's own row: its own
    // one-line history entry, expandable in place, with its brief, report and
    // nested rows inside it. Siblings are never grouped into one presentation —
    // each call is the row for the work it started.
    // `Boolean` keeps the guard from narrowing the branches below away: a false
    // result can still be an ordinary tool call.
    const delegation = Boolean(isDelegationActivityItem(item));
    if (delegation && item.kind === "tool") {
      return (
        <ToolRow
          key={item.message.id}
          variant="task"
          message={item.message}
          onUserInteraction={onUserInteraction}
          {...(item.delegate ? { delegate: item.delegate } : {})}
          {...(delegationStatuses ? { delegationStatuses } : {})}
          {...(delegationTimings ? { delegationTimings } : {})}
        />
      );
    }
    // A tool or hosted-search row always starts collapsed: only the user opens
    // a payload, never the row's position in the turn.
    if (item.kind === "tool") {
      // Folded wait checkpoints render once, at the group's first row, as a
      // disclosure so the earlier checkpoints stay inspectable.
      const folded = foldedCheckpoints?.get(item.message.id);
      if (folded) {
        return <FoldedWaitCheckpoints
          key={item.message.id}
          messages={folded}
          onUserInteraction={onUserInteraction}
        />;
      }
      // A workspace mutation's diff lives in the tool row that made it, so no
      // second collapsed row names the same file (D192).
      return (
        <ToolRow
          key={item.message.id}
          imagesInTurn
          message={item.message}
          onUserInteraction={onUserInteraction}
          {...(item.delegate ? { delegate: item.delegate } : {})}
        />
      );
    }
    if (item.kind === "hostedSearch") return <HostedSearchRow
      key={`hosted-search-${item.message.id}-${item.round.id}`}
      messageId={item.message.id}
      round={item.round}
      streaming={isActive && item.message.status === "streaming"}
      onUserInteraction={onUserInteraction}
    />;
    return <ThinkingRow
      key={`thinking-${item.message.id}`}
      message={item.message}
      streaming={isActive && item.message.status === "streaming"}
      autoOpen={live && item === lastItem}
      onUserInteraction={onUserInteraction}
    />;
  })}</>;
});

export const ActivityItems = memo(function ActivityItems({ items, ...context }: ActivityItemsProps) {
  // Repeated progress checkpoints on the same live delegation fold into one
  // stable ongoing row. The earlier checkpoints are not deleted: they render
  // inside a small disclosure at the group's first row so history stays
  // inspectable, and every result/timeout/interruption/TaskStop row is kept
  // top-level.
  const projection = useMemo(() => foldedWaitCheckpointGroups(items), [items]);
  const foldedIds = projection.folded;
  const visibleItems = useMemo(
    () => (foldedIds.size === 0
      ? items
      : items.filter((item) =>
          item.kind !== "tool" ||
          !foldedIds.has(item.message.id) ||
          projection.groups.has(item.message.id),
        )),
    [items, foldedIds, projection.groups],
  );
  const blocks = useRenderBlocks(visibleItems, itemKey);
  const lastItem = visibleItems.at(-1);
  return <>{blocks.map((block) => {
    const ownsLast = lastItem !== undefined && block.items.includes(lastItem);
    const ownsFolded = projection.groups.size > 0 &&
      block.items.some((item) => item.kind === "tool" && projection.groups.has(item.message.id));
    return <ActivityItemBlock
      key={block.key}
      block={block}
      isActive={context.isActive}
      live={context.live}
      lastItem={ownsLast ? lastItem : undefined}
      delegationStatuses={context.delegationStatuses}
      delegationTimings={context.delegationTimings}
      foldedCheckpoints={ownsFolded ? projection.groups : undefined}
      onUserInteraction={context.onUserInteraction}
    />;
  })}</>;
});
