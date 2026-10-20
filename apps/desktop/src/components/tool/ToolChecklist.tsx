import { useTranslation } from "react-i18next";
import type { ToolBlock } from "../../lib/tool-presentation";
import { TodoStatusGlyph } from "../TodoStatusGlyph";
import { MoreNote } from "./BlockHead";
import { cx } from "../ui";

/*
 * The checklist a `TodoWrite` call wrote, as rows (D192 follow-up).
 *
 * The card shows what the host counts: a progress line, one row per item with
 * the shared status glyph, and the item's priority when the call carried one.
 * Nothing here is a serialized argument — the model's own list is the content.
 */

type TodosBlock = Extract<ToolBlock, { kind: "todos" }>;

const PRIORITY_KEYS: Record<string, string> = {
  high: "chat.toolTodoPriorityHigh",
  medium: "chat.toolTodoPriorityMedium",
  low: "chat.toolTodoPriorityLow",
};

export function ToolChecklist({ block }: { block: TodosBlock }) {
  const { t } = useTranslation();
  const progress = t("chat.todo.progress", {
    completed: block.completed,
    total: block.total,
  });
  const percent =
    block.total > 0
      ? Math.min(100, Math.round((block.completed / block.total) * 100))
      : 0;
  return (
    <div className="tool-todo">
      <div className="tool-todo-progress">
        <span
          className="tool-todo-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={block.total}
          aria-valuenow={block.completed}
          aria-label={progress}
          title={progress}
        >
          <span
            className="tool-todo-bar-fill"
            style={{ width: `${percent}%` }}
            aria-hidden
          />
        </span>
        <span className="tool-todo-progress-text" role="status" aria-live="polite">
          {progress}
        </span>
      </div>
      <ul className="tool-todo-list">
        {block.items.map((item, index) => {
          const label = t(`chat.todo.status.${item.status}`);
          const priorityKey = item.priority
            ? PRIORITY_KEYS[item.priority]
            : undefined;
          return (
            <li
              className={cx("tool-todo-row", `is-${item.status}`)}
              key={`${index}:${item.content}`}
            >
              <TodoStatusGlyph
                status={item.status}
                label={label}
                className="tool-todo-symbol"
              />
              <span className="tool-todo-content" title={item.content}>
                {item.content}
              </span>
              {priorityKey ? (
                <span className="tool-todo-priority">{t(priorityKey)}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <MoreNote hidden={block.hidden} />
    </div>
  );
}
