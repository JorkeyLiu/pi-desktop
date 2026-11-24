import type { ReactNode } from "react";

/**
 * The shared right-hand task cluster: the target task's own title tile plus
 * the row's state, in the lifecycle group's right-edge slot.
 *
 * A delivered `TaskWait` and a targeted `TaskSteer` both name one task's own
 * title here (D268): the wait names the delivered tasks its result carried,
 * the steer names the one live delegation it queued a message into. One
 * component owns that markup so the two heads cannot drift into two copies of
 * the same classes. No new styles: the tile keeps the delivered chip shape
 * and its ellipsis, so a long title cannot push the state badge out.
 */
export function TaskTargetCluster({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <span className="tool-row-lifecycle">
      <span className="tool-row-agent is-delivered" title={title}>
        {title}
      </span>
      {children}
    </span>
  );
}
