import {
  initialThinkingLevelForBinding,
  initialThinkingLevelForUnmatchedModel,
  isSessionThinkingLevel,
  type SessionThinkingLevel,
  type ThinkingLevel,
  type ThinkingLevelBindingSource,
} from "@pi-desktop/shared";

/**
 * Thinking effort the user last chose for one exact provider/model.
 *
 * This is renderer-wide state, not session state: a new task or an explicit
 * model switch starts at the remembered level, while an existing session keeps
 * the level it already stored for itself.
 */
export const MODEL_THINKING_PREFERENCES_KEY = "pi.desktop.modelThinkingLevels";

export type ModelThinkingPreferences = Readonly<
  Record<string, SessionThinkingLevel>
>;

export type ModelThinkingRef = {
  providerId?: string;
  modelId?: string;
};

/**
 * Model identity is provider plus wire id, so the same id configured under two
 * providers keeps two independent preferences.
 */
export function modelThinkingPreferenceKey({
  providerId,
  modelId,
}: ModelThinkingRef): string | null {
  const provider = providerId?.trim();
  const model = modelId?.trim();
  if (!provider || !model) return null;
  return `${provider}\u0000${model.toLowerCase()}`;
}

function storage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

function parsePreferences(raw: string | null): ModelThinkingPreferences {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const preferences: Record<string, SessionThinkingLevel> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isSessionThinkingLevel(value)) preferences[key] = value;
    }
    return preferences;
  } catch {
    return {};
  }
}

// The Composer reads this on every paint; re-parse only when the raw value
// changed. Writes below keep the cache and the stored string in lockstep.
let cachedRaw: string | null | undefined;
let cachedPreferences: ModelThinkingPreferences = {};

export function loadModelThinkingPreferences(): ModelThinkingPreferences {
  const store = storage();
  if (!store) return {};
  let raw: string | null = null;
  try {
    raw = store.getItem(MODEL_THINKING_PREFERENCES_KEY);
  } catch {
    return {};
  }
  if (raw === cachedRaw) return cachedPreferences;
  cachedPreferences = parsePreferences(raw);
  cachedRaw = raw;
  return cachedPreferences;
}

export function rememberedModelThinkingLevel(
  ref: ModelThinkingRef,
  preferences: ModelThinkingPreferences = loadModelThinkingPreferences(),
): SessionThinkingLevel | null {
  const key = modelThinkingPreferenceKey(ref);
  return key ? (preferences[key] ?? null) : null;
}

/** Persist one explicit adjustment; a blocked store must not break the menu. */
export function rememberModelThinkingLevel(
  ref: ModelThinkingRef,
  level: SessionThinkingLevel,
): void {
  const key = modelThinkingPreferenceKey(ref);
  const store = storage();
  if (!key || !store) return;
  const preferences = { ...loadModelThinkingPreferences(), [key]: level };
  const raw = JSON.stringify(preferences);
  try {
    store.setItem(MODEL_THINKING_PREFERENCES_KEY, raw);
  } catch {
    return;
  }
  cachedPreferences = preferences;
  cachedRaw = raw;
}

/**
 * Level a context starts at for one model: the user's remembered effort for
 * that exact provider/model when the map has one, clamped onto the ladder the
 * model exposes now, else the existing catalog/binding default.
 *
 * A remembered level is a request, not a capability: the same nearest-supported
 * rule that clamps a binding default keeps it inside what the model accepts.
 */
export function resolveModelThinkingLevel({
  providerId,
  modelId,
  binding,
  catalogMatched,
  fallbackLevels,
  preferences,
}: {
  providerId?: string;
  modelId?: string;
  binding: ThinkingLevelBindingSource | null | undefined;
  /** True when the exact model is a models.dev catalog record. */
  catalogMatched: boolean;
  fallbackLevels?: readonly ThinkingLevel[];
  preferences?: ModelThinkingPreferences;
}): SessionThinkingLevel {
  const remembered = rememberedModelThinkingLevel(
    { providerId, modelId },
    preferences ?? loadModelThinkingPreferences(),
  );
  const source =
    remembered === null ? binding : { ...binding, defaultThinkingLevel: remembered };
  return catalogMatched
    ? initialThinkingLevelForBinding(source, fallbackLevels)
    : initialThinkingLevelForUnmatchedModel(source, fallbackLevels);
}
