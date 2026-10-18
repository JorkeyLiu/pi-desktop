import { Fragment, memo, useMemo } from "react";
import type { UiMessage } from "@pi-desktop/shared";
import type { AssistantActivityItem } from "../../../lib/assistant-turns";
import { foldedWaitCheckpointGroups, isDelegationActivityItem, type DelegationActivityItem, type SubagentOutcome, type SubagentTiming } from "../../../lib/subagent-topology";
import { ReviewChangeCard } from "../../../components/ReviewChangeCard";
import { ThinkingRow } from "./shared";
import { HostedSearchRow } from "./HostedSearchRow";
import { SubagentTopology } from "./SubagentDetail";
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
  delegateItems: DelegationActivityItem[];
  delegationStatuses: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings: ReadonlyMap<string, SubagentTiming>;
  onUserInteraction: () => void;
};

type ActivityItemBlockProps = Omit<ActivityItemsProps, "items" | "delegateItems" | "delegationStatuses" | "delegationTimings"> & {
  block: RenderBlock<AssistantActivityItem>;
  lastItem?: AssistantActivityItem;
  topologyItem?: AssistantActivityItem;
  delegateItems?: DelegationActivityItem[];
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
  /** Folded wait checkpoints owned by this block's anchor row, if any. */
  foldedCheckpoints?: ReadonlyMap<string, UiMessage[]>;
};

const ActivityItemBlock = memo(function ActivityItemBlock({
  block, isActive, live, lastItem, topologyItem,
  delegateItems, delegationStatuses, delegationTimings, foldedCheckpoints, onUserInteraction,
}: ActivityItemBlockProps) {
  return <>{block.items.map((item) => {
    // The topology predicate narrows to all tools, but a false result can still
    // be an ordinary tool. Do not exclude tools from the remaining branches.
    const delegation = Boolean(isDelegationActivityItem(item));
    if (delegation) {
      if (item !== topologyItem || !delegateItems) return null;
      return <SubagentTopology
        key="subagent-topology"
        items={delegateItems}
        delegationStatuses={delegationStatuses}
        delegationTimings={delegationTimings}
        onUserInteraction={onUserInteraction}
      />;
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
      return (
        <Fragment key={item.message.id}>
          <ToolRow imagesInTurn message={item.message}
            onUserInteraction={onUserInteraction} {...(item.delegate ? { delegate: item.delegate } : {})} />
          <ReviewChangeCard message={item.message} />
        </Fragment>
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
  const topologyItem = context.delegateItems[0];
  return <>{blocks.map((block) => {
    const ownsLast = lastItem !== undefined && block.items.includes(lastItem);
    const ownsTopology = topologyItem !== undefined && block.items.includes(topologyItem);
    const ownsFolded = projection.groups.size > 0 &&
      block.items.some((item) => item.kind === "tool" && projection.groups.has(item.message.id));
    return <ActivityItemBlock
      key={block.key}
      block={block}
      isActive={context.isActive}
      live={context.live}
      lastItem={ownsLast ? lastItem : undefined}
      topologyItem={ownsTopology ? topologyItem : undefined}
      delegateItems={ownsTopology ? context.delegateItems : undefined}
      delegationStatuses={ownsTopology ? context.delegationStatuses : undefined}
      delegationTimings={ownsTopology ? context.delegationTimings : undefined}
      foldedCheckpoints={ownsFolded ? projection.groups : undefined}
      onUserInteraction={context.onUserInteraction}
    />;
  })}</>;
});
