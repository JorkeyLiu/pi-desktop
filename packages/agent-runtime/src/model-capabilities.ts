import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import {
  effectiveContextWindow,
  THINKING_LEVELS,
  type ModelBinding,
  type ModelInfo,
  type ModelModality,
  type SessionThinkingLevel,
} from "@pi-desktop/shared";
import {
  clampThinkingLevel,
  type ModelConfig,
  type ThinkingCapabilitySet,
} from "./thinking-level.js";
export { transcriptConfigFromPi } from "./transcript-compat.js";

export {
  agentThinkingLevel,
  clampThinkingLevel,
  effectiveThinkingLevel,
  omitThinkingModel,
  type ModelConfig,
  type ThinkingCapabilitySet,
} from "./thinking-level.js";

/**
 * True when neither the catalog nor a binding states whether this model
 * reasons. Only a wire protocol may be configured: it states how a level
 * would be sent, not that the model is or is not reasoning-capable.
 * An `off`-only capability projection for such a model is the absence of a
 * claim, not a claim that the model is non-reasoning.
 */
export function thinkingCapabilityIsUnknown(
  model:
    | Pick<
        ModelConfig,
        | "source"
        | "reasoning"
        | "supportedThinkingLevels"
        | "thinkingLevelMap"
        | "reasoningOptions"
      >
    | null
    | undefined,
): boolean {
  return (
    model?.source === "generic" &&
    model.reasoning !== true &&
    (model.supportedThinkingLevels?.length ?? 0) === 0 &&
    model.thinkingLevelMap === undefined &&
    (model.reasoningOptions?.length ?? 0) === 0
  );
}

/**
 * Project one explicit request level onto an otherwise unclassified model.
 *
 * This is adapter intent, not a capability claim: the catalog still knows
 * nothing about the model, and only the level the user selected is enabled.
 */
function modelConfigForExplicitThinking(
  model: ModelConfig,
  level: SessionThinkingLevel,
): ModelConfig {
  if (level === "off" || level === "omit") return model;
  const thinkingLevelMap = { ...(model.thinkingLevelMap ?? {}) };
  // pi-ai only accepts xhigh/max when the adapter-facing mapping exists.
  if (
    (level === "xhigh" || level === "max") &&
    thinkingLevelMap[level] == null
  ) {
    thinkingLevelMap[level] = level;
  }
  return {
    ...model,
    reasoning: true,
    supportedThinkingLevels: [level],
    ...(Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
  };
}

export type ThinkingIntentResolution = {
  level: SessionThinkingLevel;
  /** Adapter-facing model; replaced only for an explicit level on an unknown model. */
  modelConfig: ModelConfig | undefined;
};

/**
 * Resolve a session's selected level against what the metadata actually claims.
 *
 * An unknown model defaults to `off` because the persisted default is `off`;
 * any other persisted value is a user selection and must reach the adapter
 * instead of being silently replaced by an absent capability claim. Known
 * restrictions (catalog records, explicit binding ladders, protocols) still
 * clamp through the nearest-supported-level rule.
 */
export function resolveThinkingIntent(
  source: ThinkingCapabilitySet & { modelConfig?: ModelConfig | null },
  requested: SessionThinkingLevel,
): ThinkingIntentResolution {
  const modelConfig = source.modelConfig ?? undefined;
  if (
    requested !== "off" &&
    requested !== "omit" &&
    modelConfig &&
    thinkingCapabilityIsUnknown(modelConfig)
  ) {
    return {
      level: requested,
      modelConfig: modelConfigForExplicitThinking(modelConfig, requested),
    };
  }
  return { level: clampThinkingLevel(source, requested), modelConfig };
}

/** Read-only, credential-free projection of a resolved Pi chat model. */
export function modelConfigFromPi(model: Model<Api>): ModelConfig {
  const { id: _id, provider: _provider, cost, compat, ...metadata } = model;
  return {
    ...metadata,
    ...(compat ? { compat: { ...compat } } : {}),
    source: "pi",
    transcriptBinding: { modelId: model.id, api: model.api, baseUrl: model.baseUrl },
    nativeCost: cost,
    // Desktop's historical tier schema differs; do not invent a translation.
    cost: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite },
    modalities: { input: [...model.input], output: ["text"] },
    limit: { context: model.contextWindow, output: model.maxTokens },
    catalogContextWindow: model.contextWindow,
    supportedThinkingLevels: getSupportedThinkingLevels(model),
  };
}

export type ModelCapabilities = ThinkingCapabilitySet;
/** Compatibility name used by Electron main and existing runtime callers. */
export type ThinkingCapabilities = ModelCapabilities;

/** Resolve reasoning capability from the model metadata supplied by main. */
export function capabilitiesFromModelConfig(
  model?: Pick<ModelConfig, "reasoning" | "supportedThinkingLevels"> | null,
): ModelCapabilities {
  if (!model?.reasoning) {
    return {
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    };
  }
  return {
    supportsReasoning: true,
    supportedThinkingLevels: model.supportedThinkingLevels?.length
      ? [...model.supportedThinkingLevels]
      : ["low", "medium", "high"],
  };
}

/** Resolve image transport from the full models.dev input modalities. */
export function visionFromModelConfig(
  model?: Pick<ModelConfig, "modalities" | "input"> | null,
): boolean {
  return model?.modalities?.input.includes("image") === true ||
    model?.input.includes("image") === true;
}

/** Map a public catalog row to the capability shape used by settings helpers. */
export function capabilitiesFromModelInfo(model?: ModelInfo | null): ModelCapabilities {
  if (!model?.reasoning) {
    return {
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    };
  }
  return {
    supportsReasoning: true,
    supportedThinkingLevels: model.supportedThinkingLevels?.length
      ? [...model.supportedThinkingLevels]
      : ["low", "medium", "high"],
  };
}

/**
 * Apply explicit per-provider model settings. Thinking levels and output limits
 * come from the user's binding. Only a context window explicitly marked as
 * catalog-sourced follows a published correction; an unmarked legacy value is
 * preserved because it may be the user's exact 128k override.
 */
export function modelConfigWithBinding(
  model: ModelConfig,
  binding?:
    | Pick<
        ModelBinding,
        | "contextWindow"
        | "contextWindowSource"
        | "maxTokens"
        | "thinkingLevels"
        | "thinkingProtocol"
        | "supportsImages"
        | "supportsDocuments"
        | "nativeWebSearch"
      >
    | null,
): ModelConfig {
  // A live-only account model may already carry explicit sibling capabilities.
  // Preserve those; an unclassified row carries no capability claim of its own.
  if (!binding && (model.supportedThinkingLevels?.length || model.thinkingLevelMap)) {
    return model;
  }
  if (!binding) return model;
  // Only levels the user stored stay selectable. An unknown model's empty list
  // is an explicit no-reasoning answer, not a prompt to enable a default ladder.
  const requestedLevels = THINKING_LEVELS.filter((level) =>
    binding.thinkingLevels.includes(level),
  );
  // Known native models cannot gain unsupported effort mappings from saved settings.
  const enabledThinkingLevels = model.source === "pi"
    ? requestedLevels.filter(level => model.supportedThinkingLevels?.includes(level))
    : requestedLevels;
  const thinkingLevelMap = { ...(model.thinkingLevelMap ?? {}) };
  const compat = binding.thinkingProtocol
    ? {
        ...(model.compat ?? {}),
        forceAdaptiveThinking: binding.thinkingProtocol === "adaptive",
      }
    : model.compat;
  // pi-ai treats xhigh/max as unsupported when their adapter-facing mapping
  // is absent or null. The explicit binding is authoritative, so an enabled
  // extended level without a catalog translation must pass through as-is.
  for (const level of ["xhigh", "max"] as const) {
    if (
      model.source !== "pi" && enabledThinkingLevels.includes(level) &&
      thinkingLevelMap[level] == null
    ) {
      thinkingLevelMap[level] = level;
    }
  }
  const publishedContextWindow = model.source === "generic"
    ? undefined
    : model.contextWindow;
  const contextWindow =
    effectiveContextWindow(
      publishedContextWindow,
      binding.contextWindow,
      binding.contextWindowSource,
    ) ?? model.contextWindow;
  const catalogContextWindow =
    model.catalogContextWindow ??
    (model.source === "models.dev" && model.contextWindow > 0
      ? model.contextWindow
      : undefined);
  return {
    ...model,
    ...(catalogContextWindow !== undefined ? { catalogContextWindow } : {}),
    contextWindow,
    limit: {
      ...(model.limit ?? {}),
      context: contextWindow,
    },
    maxTokens: binding.maxTokens,
    reasoning: model.source === "pi"
      ? model.reasoning || enabledThinkingLevels.some((level) => level !== "off")
      : enabledThinkingLevels.some((level) => level !== "off"),
    supportedThinkingLevels: enabledThinkingLevels,
    ...(binding.thinkingProtocol
      ? { thinkingProtocol: binding.thinkingProtocol }
      : {}),
    ...(compat ? { compat } : {}),
    ...(Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
    ...modalityOverride(model, binding),
    ...(binding.nativeWebSearch === true ? { webSearch: true } : {}),
  };
}

/**
 * Apply the binding's attachment overrides to the adapter-facing modality
 * arrays. Unlike thinking levels these are not narrowed to what models.dev
 * published: a self-hosted or proxied endpoint routinely accepts images the
 * catalog entry does not mention, and refusing the override would leave the user
 * with a switch that does nothing. `null`/absent still follows the catalog.
 */
function modalityOverride(
  model: ModelConfig,
  binding: Pick<ModelBinding, "supportsImages" | "supportsDocuments">,
): Partial<ModelConfig> {
  const images = binding.supportsImages;
  const documents = binding.supportsDocuments;
  if (typeof images !== "boolean" && typeof documents !== "boolean") return {};
  const publishedInput = model.modalities?.input ?? [];
  const nextInput = new Set<ModelModality>(publishedInput);
  if (typeof images === "boolean") {
    if (images) nextInput.add("image");
    else nextInput.delete("image");
  }
  if (typeof documents === "boolean") {
    if (documents) nextInput.add("pdf");
    else nextInput.delete("pdf");
  }
  nextInput.add("text");
  const input = [...nextInput];
  return {
    modalities: {
      input,
      output: model.modalities?.output ?? ["text"],
    },
    // The adapter subset carries only what pi-ai can encode as a content block.
    input: input.filter(
      (modality): modality is "text" | "image" =>
        modality === "text" || modality === "image",
    ),
  };
}

/**
 * Unknown IDs remain runnable without invented catalog semantics. This is a
 * transport-safe generic shape, not a second model catalog.
 */
export function genericModelConfig(
  modelId: string,
  baseUrl = "",
): ModelConfig {
  return {
    source: "generic",
    name: modelId,
    baseUrl,
    reasoning: false,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 128_000, input: 128_000, output: 8_192 },
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 8_192,
    supportedThinkingLevels: [],
  };
}
