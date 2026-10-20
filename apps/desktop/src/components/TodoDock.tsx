import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionTodo } from "@pi-desktop/shared";
import { Button } from "./ui";
import { IconChevronDown, IconChevronUp } from "./icons";
import { TodoStatusGlyph } from "./TodoStatusGlyph";
import { useSessionTodosRecovery } from "../features/chat/todos/useSessionTodosRecovery";
import { useAppStore } from "../stores/app-store";

export function TodoDock({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const snapshot = useAppStore((state) => state.sessionTodos[sessionId]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [sessionId]);

  useSessionTodosRecovery(sessionId);
  if (!snapshot || snapshot.todos.length === 0) return null;
  const completed = snapshot.todos.filter((todo) => todo.status === "completed").length;
  const cancelled = snapshot.todos.filter((todo) => todo.status === "cancelled").length;
  const denominator = snapshot.todos.length - cancelled;
  const current = snapshot.todos.find((todo) => todo.status === "in_progress");
  const allCancelled = cancelled === snapshot.todos.length;
  const finished = snapshot.todos.every(
    (todo) => todo.status === "completed" || todo.status === "cancelled",
  );
  const statusLabel = allCancelled
    ? t("chat.todo.status.cancelled")
    : finished
      ? t("chat.todo.completed", { completed, total: denominator })
      : current
        ? t("chat.todo.current", { completed, total: denominator, content: current.content })
        : t("chat.todo.progress", { completed, total: denominator });

  return (
    <div className={`todo-dock${expanded ? " is-expanded" : ""}`}>
      <Button
        type="button"
        variant="ghost"
        className="todo-dock-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="todo-dock-header-symbol" aria-hidden>
          {allCancelled ? "⊘" : finished ? "✓" : "◐"}
        </span>
        <span className="todo-dock-header-text">{statusLabel}</span>
        {expanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
      </Button>
      <div className="todo-dock-content" aria-hidden={!expanded}>
        <div className="todo-dock-clip">
          {/* The expanded dock lists every row (#1319): the list scrolls
              inside its own box instead of truncating to a static "N more"
              line, and a keyboard user can reach that scrollport only while
              the disclosure is open. */}
          <div
            className="todo-dock-list"
            role="list"
            tabIndex={expanded ? 0 : -1}
          >
            {snapshot.todos.map((todo, index) => (
              <TodoRow key={`${index}:${todo.content}`} todo={todo} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
function TodoRow({ todo }: { todo: SessionTodo }) {
  const { t } = useTranslation();
  const label = t(`chat.todo.status.${todo.status}`);
  return (
    <div className={`todo-dock-row todo-dock-row-${todo.status}`} role="listitem">
      <TodoStatusGlyph
        status={todo.status}
        label={label}
        className="todo-dock-row-symbol"
      />
      <span className="todo-dock-row-content" title={todo.content}>
        {todo.content}
      </span>
    </div>
  );
}
