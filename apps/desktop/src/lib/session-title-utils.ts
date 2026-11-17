import i18n from "i18next";

/**
 * Every shipped `chat.untitledTask` label plus the historical `nav.newChat`
 * labels, lowercased for matching, so a placeholder written under any locale
 * is recognized after a language switch. Kept in sync with
 * `PLACEHOLDER_TITLES` in `crates/host-core/src/sessions.rs`.
 */
const LEGACY_DEFAULT_TITLES = new Set([
  "new task",
  "new chat",
  "新建任务",
  "新对话",
  "新建任務",
  "新對話",
  "새 작업",
  "새 채팅",
  "tarefa sem título",
  "nova conversa",
  "neue aufgabe",
  "nouvelle tâche",
  "nueva tarea",
  "yeni görev",
  "yeni sohbet",
]);
/** Sidebar/topbar title budget for the local first-prompt fallback. */
const PROMPT_FALLBACK_TITLE_LENGTH = 48;
/**
 * The placeholder a new session is created with. It keeps the catalog's
 * original casing because host-core persists this exact string and only
 * recognizes a placeholder whose text matches its `PLACEHOLDER_TITLES` entry
 * case-sensitively; a lowercased copy would persist as a manual title and
 * block both the prompt fallback and any automatic title.
 */
export function untitledTaskTitle(): string {
  return translatedTitle("chat.untitledTask");
}

/// A missing or not-yet-initialized catalog must never break the composer
/// path that checks whether a session still carries a placeholder title.
function translatedTitle(key: string): string {
  const value = i18n.t(key);
  return typeof value === "string" ? value.trim() : "";
}

/// Placeholder matching compares case-insensitively, so a catalog title and a
/// user-visible copy written in another case are still the same placeholder.
function normalizedTitle(value: string): string {
  return value.trim().toLowerCase();
}

export function isDefaultSessionTitle(title?: string | null): boolean {
  const trimmed = normalizedTitle(title || "");
  return (
    !trimmed ||
    LEGACY_DEFAULT_TITLES.has(trimmed) ||
    trimmed === normalizedTitle(untitledTaskTitle()) ||
    trimmed === normalizedTitle(translatedTitle("nav.newChat"))
  );
}

/**
 * Deterministic title for the first prompt of a still-untitled session.
 * The host keeps the session eligible for an automatic plugin title, so this
 * text is only the immediate, offline-readable fallback.
 */
export function promptFallbackSessionTitle(
  userPrompt: string,
  emptyTitle: string,
): string {
  return (
    userPrompt.trim().replace(/\s+/g, " ").slice(0, PROMPT_FALLBACK_TITLE_LENGTH) ||
    emptyTitle
  );
}
