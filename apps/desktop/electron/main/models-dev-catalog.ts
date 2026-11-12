import {
  createModels,
  InMemoryModelsStore,
  type Model as PiModel,
  type MutableModels,
  type ModelType,
  type ModelTypeMap,
  type Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { PI_VENDOR_ALIASES, settingsOperationMetadata } from "./pi-model-metadata.ts";
import {
  ModelResolver,
  type ModelResolution,
} from "./model-metadata/model-resolver.ts";
import type {
  ModelCost,
  ModelCostTier,
  ModelExperimentalMetadata,
  ModelInfo,
  ModelInterleaved,
  ModelLimit,
  ModelModalities,
  ModelModality,
  ModelProviderMetadata,
  ModelReasoningOption,
  ThinkingLevel,
  ThinkingProtocol,
  ModelBinding,
} from "@pi-desktop/shared";
import { genericModelConfig, modelConfigWithBinding, transcriptConfigFromPi, type ModelConfig } from "@pi-desktop/agent-runtime";
import { resolveBindingLimits } from "@pi-desktop/shared";
import {
  ModelsDevAcquisition,
  type ModelsDevProvenance,
} from "./model-metadata/models-dev-acquisition.ts";
import {
  MODELS_DEV_SOURCE_TIMEOUT_MS,
  MODELS_DEV_SOURCE_URL,
} from "./model-metadata/models-dev-source.ts";

/** Canonical public source; the acquisition service owns the request policy. */
export const MODELS_DEV_API_URL = MODELS_DEV_SOURCE_URL;
/** Bound for one acquisition attempt (see models-dev-source). */
export const MODELS_DEV_TIMEOUT_MS = MODELS_DEV_SOURCE_TIMEOUT_MS;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;
const DEFAULT_THINKING_LEVELS: ThinkingLevel[] = ["low", "medium", "high"];
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const MODEL_MODALITIES: readonly ModelModality[] = [
  "text",
  "image",
  "audio",
  "video",
  "pdf",
];

type JsonRecord = Record<string, unknown>;

export type ModelsDevProvider = {
  providerKey: string;
  name: string;
  api?: string;
  /** Published adapter package, the most reliable wire-API signal. */
  npm?: string;
  /** Published environment variable names that carry this provider's key. */
  env: string[];
  /** Provider documentation URL, when published. */
  doc?: string;
  models: ModelsDevModel[];
};

export type ModelsDevModel = {
  providerKey: string;
  providerName: string;
  providerApi?: string;
  /**
   * Wire API published for this model (e.g. "openai-responses").
   * models.dev omits it; modelFromRaw fills known ids from RESPONSES_ONLY_MODEL_IDS.
   */
  modelApi?: string;
  modelId: string;
  displayName: string;
  description?: string;
  family?: string;
  attachment?: boolean;
  reasoning: boolean;
  reasoningPublished: boolean;
  reasoningOptions?: ModelReasoningOption[];
  thinkingProtocol?: ThinkingProtocol;
  thinkingLevels: ThinkingLevel[];
  modalities: ModelModalities;
  modalitiesPublished: boolean;
  inputPublished: boolean;
  outputPublished: boolean;
  toolCall?: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  knowledge?: string;
  releaseDate?: string;
  lastUpdated?: string;
  openWeights?: boolean;
  limit: ModelLimit;
  cost?: ModelCost;
  interleaved?: ModelInterleaved;
  status?: string;
  /**
   * The catalog's internal name for this model's current generation
   * (models.dev `canonical_model_id`, e.g. `deepseek/deepseek-v4.1-flash`).
   * A relay may serve this canonical name directly; only the owner's own
   * records answer it.
   */
  canonicalModelId?: string;
  experimental?: ModelExperimentalMetadata;
  provider?: ModelProviderMetadata;
};

export type ModelsDevCatalogStatus = {
  loaded: boolean;
  source: "bundled" | "remote" | "empty";
  catalogPath: string;
  fetchedAt?: string;
  providerCount: number;
  modelCount: number;
  lastError?: string;
};

export type ModelsDevCatalogOptions = {
  /** Checked-in/release-packaged api.json; never a user-data path. */
  catalogPath: string;
  /**
   * Versioned disk cache file under the desktop data directory. Omitted in
   * tests and consumers that must stay network/persistence-free.
   */
  cachePath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /** Optional Pi providers used only for executable non-chat operations. */
  providers?: readonly Provider[];
};

export type CatalogAccount = {
  id: string;
  vendorKey?: string;
  baseUrl?: string;
  apiStyle?: string;
  models?: ModelBinding[];
};

type CatalogTarget = {
  providerId?: string;
  vendorKey?: string;
  baseUrl?: string;
  apiStyle?: string;
  modelId: string;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((entry) => nonEmptyString(entry))
        .filter((entry): entry is string => entry !== undefined),
    ),
  ];
}

function publishedMetadata(value: unknown): ModelProviderMetadata | undefined {
  if (typeof value === "string") return nonEmptyString(value);
  return asRecord(value) ?? undefined;
}

function publishedExperimental(value: unknown): ModelExperimentalMetadata | undefined {
  if (typeof value === "boolean") return value;
  return asRecord(value) ?? undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = nonNegativeInteger(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function parseModality(value: unknown): ModelModality | undefined {
  return typeof value === "string" && MODEL_MODALITIES.includes(value as ModelModality)
    ? (value as ModelModality)
    : undefined;
}

function parseModalities(value: unknown): {
  modalities: ModelModalities;
  published: boolean;
  inputPublished: boolean;
  outputPublished: boolean;
} {
  const record = asRecord(value);
  const rawInput = Array.isArray(record?.input) ? record.input : undefined;
  const rawOutput = Array.isArray(record?.output) ? record.output : undefined;
  const input = rawInput?.map(parseModality).filter(
    (item): item is ModelModality => item !== undefined,
  ) ?? [];
  const output = rawOutput?.map(parseModality).filter(
    (item): item is ModelModality => item !== undefined,
  ) ?? [];
  return {
    modalities: {
      input: input.length > 0 ? [...new Set(input)] : ["text"],
      output: output.length > 0 ? [...new Set(output)] : ["text"],
    },
    published: rawInput !== undefined || rawOutput !== undefined,
    inputPublished: rawInput !== undefined && input.length > 0,
    outputPublished: rawOutput !== undefined && output.length > 0,
  };
}

function normalizeThinkingValue(value: unknown): ThinkingLevel | undefined {
  if (value === "none") return "off";
  return typeof value === "string" &&
    (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined;
}

function parseReasoningOptions(value: unknown): ModelReasoningOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value.flatMap((entry) => {
    const record = asRecord(entry);
    const type = nonEmptyString(record?.type);
    if (!type) return [];
    const values = Array.isArray(record?.values)
      ? record.values.filter(
          (item): item is string | null => typeof item === "string" || item === null,
        )
      : undefined;
    const min = nonNegativeNumber(record?.min);
    const max = nonNegativeNumber(record?.max);
    return [{
      type,
      ...(values ? { values } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    }];
  });
  return options;
}

/** Convert models.dev reasoning options into the canonical UI levels. */
export function thinkingLevelsFromModelsDev(
  reasoning: boolean,
  options: unknown,
): ThinkingLevel[] {
  if (!reasoning) return [];
  const levels = new Set<ThinkingLevel>();
  if (Array.isArray(options)) {
    for (const option of options) {
      const record = asRecord(option);
      const type = nonEmptyString(record?.type);
      if (type === "toggle" || type === "budget_tokens") {
        levels.add("off");
        levels.add("medium");
      }
      if (Array.isArray(record?.values)) {
        for (const value of record.values) {
          const level = normalizeThinkingValue(value);
          if (level) levels.add(level);
        }
      }
    }
  }
  return levels.size > 0
    ? THINKING_LEVELS.filter((level) => levels.has(level))
    : [...DEFAULT_THINKING_LEVELS];
}

function thinkingLevelMapFromModelsDev(
  options: ModelReasoningOption[] | undefined,
  levels: ThinkingLevel[],
): Partial<Record<ThinkingLevel, string | null>> | undefined {
  if (!options?.length) return undefined;
  const map: Partial<Record<ThinkingLevel, string | null>> = {};
  for (const option of options) {
    if (option.type === "toggle" || option.type === "budget_tokens") {
      if (levels.includes("off")) map.off = "none";
      if (levels.includes("medium")) map.medium = "medium";
    }
    for (const value of option.values ?? []) {
      const level = normalizeThinkingValue(value);
      if (level && typeof value === "string") map[level] = value;
    }
  }
  // models.dev effort ladders often omit an off/none value (e.g. grok-4.6).
  // Pin off=null so adapters omit reasoning when thinking is turned off,
  // instead of synthesizing effort: "none" which upstream rejects (#603).
  if (
    Object.keys(map).length > 0 &&
    map.off === undefined &&
    !levels.includes("off")
  ) {
    map.off = null;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

function parseLimit(value: unknown): ModelLimit {
  const record = asRecord(value);
  const context = nonNegativeInteger(record?.context);
  const input = nonNegativeInteger(record?.input);
  const output = nonNegativeInteger(record?.output);
  return {
    ...(context !== undefined ? { context } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

function parseCostTier(value: unknown): ModelCostTier | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const input = nonNegativeNumber(record.input);
  const output = nonNegativeNumber(record.output);
  const cacheRead = nonNegativeNumber(record.cache_read);
  const cacheWrite = nonNegativeNumber(record.cache_write);
  const tierRecord = asRecord(record.tier);
  const tierType = nonEmptyString(tierRecord?.type);
  const tierSize = positiveInteger(tierRecord?.size);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    !tierType &&
    tierSize === undefined
  ) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(tierType || tierSize !== undefined
      ? {
          tier: {
            ...(tierType ? { type: tierType } : {}),
            ...(tierSize !== undefined ? { size: tierSize } : {}),
          },
        }
      : {}),
  };
}

function parseCost(value: unknown): ModelCost | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const input = nonNegativeNumber(record.input);
  const output = nonNegativeNumber(record.output);
  const cacheRead = nonNegativeNumber(record.cache_read);
  const cacheWrite = nonNegativeNumber(record.cache_write);
  const reasoning = nonNegativeNumber(record.reasoning);
  const inputAudio = nonNegativeNumber(record.input_audio);
  const outputAudio = nonNegativeNumber(record.output_audio);
  const contextOver = asRecord(record.context_over_200k);
  const contextOver200k = contextOver
    ? {
        ...(nonNegativeNumber(contextOver.input) !== undefined
          ? { input: nonNegativeNumber(contextOver.input) }
          : {}),
        ...(nonNegativeNumber(contextOver.output) !== undefined
          ? { output: nonNegativeNumber(contextOver.output) }
          : {}),
        ...(nonNegativeNumber(contextOver.cache_read) !== undefined
          ? { cacheRead: nonNegativeNumber(contextOver.cache_read) }
          : {}),
        ...(nonNegativeNumber(contextOver.cache_write) !== undefined
          ? { cacheWrite: nonNegativeNumber(contextOver.cache_write) }
          : {}),
      }
    : undefined;
  const tiers = Array.isArray(record.tiers)
    ? record.tiers
        .map(parseCostTier)
        .filter((item): item is ModelCostTier => item !== undefined)
    : undefined;
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    reasoning === undefined &&
    inputAudio === undefined &&
    outputAudio === undefined &&
    !contextOver200k &&
    !tiers?.length
  ) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(inputAudio !== undefined ? { inputAudio } : {}),
    ...(outputAudio !== undefined ? { outputAudio } : {}),
    ...(contextOver200k ? { contextOver200k } : {}),
    ...(tiers?.length ? { tiers } : {}),
  };
}

function parseInterleaved(value: unknown): ModelInterleaved | undefined {
  if (typeof value === "boolean") return value;
  const record = asRecord(value);
  const field = nonEmptyString(record?.field);
  return field ? { field } : undefined;
}

/**
 * models.dev publishes no per-model wire API, yet some models only serve one.
 * Keep this list to verified responses-only ids; everything else falls back
 * to the provider-wide style (see #105).
 */
const RESPONSES_ONLY_MODEL_IDS: ReadonlySet<string> = new Set([
  "muse-spark-1.2-contributor",
  "muse-spark-1.3-contributor",
]);

function modelFromRaw(
  providerKey: string,
  provider: JsonRecord,
  modelKey: string,
  raw: JsonRecord,
): ModelsDevModel | undefined {
  const modelId = nonEmptyString(raw.id) ?? modelKey.trim();
  if (!modelId) return undefined;
  const modalityResult = parseModalities(raw.modalities);
  const reasoningPublished = typeof raw.reasoning === "boolean";
  const reasoning = raw.reasoning === true;
  const reasoningOptions = parseReasoningOptions(raw.reasoning_options);
  const thinkingProtocol: ThinkingProtocol | undefined =
    providerKey === "anthropic" && reasoning &&
    reasoningOptions?.some((option) => option.type === "effort") &&
    !reasoningOptions.some((option) => option.type === "budget_tokens")
      ? "adaptive"
      : undefined;
  const limit = parseLimit(raw.limit);
  const experimental = publishedExperimental(raw.experimental);
  const providerMetadata = publishedMetadata(raw.provider);
  // Scoped to opencode-go on purpose: the same model ids exist under other
  // providers (e.g. meta, llmgateway) where the completions path is correct
  // and must not be rerouted (see #105).
  const modelApi =
    nonEmptyString(raw.api) ??
    (providerKey === "opencode-go" && RESPONSES_ONLY_MODEL_IDS.has(modelId.toLowerCase())
      ? "openai-responses"
      : undefined);
  const displayName = nonEmptyString(raw.name) ?? modelId;
  const inputPublished = modalityResult.inputPublished;
  const outputPublished = modalityResult.outputPublished;
  return {
    providerKey,
    providerName: nonEmptyString(provider.name) ?? providerKey,
    ...(nonEmptyString(provider.api) ? { providerApi: nonEmptyString(provider.api) } : {}),
    modelId,
    displayName,
    ...(nonEmptyString(raw.description) ? { description: nonEmptyString(raw.description) } : {}),
    ...(nonEmptyString(raw.family) ? { family: nonEmptyString(raw.family) } : {}),
    ...(typeof raw.attachment === "boolean" ? { attachment: raw.attachment } : {}),
    reasoning,
    reasoningPublished,
    ...(reasoningOptions ? { reasoningOptions } : {}),
    ...(thinkingProtocol ? { thinkingProtocol } : {}),
    thinkingLevels: thinkingLevelsFromModelsDev(reasoning, raw.reasoning_options),
    modalities: modalityResult.modalities,
    modalitiesPublished: modalityResult.published,
    inputPublished,
    outputPublished,
    ...(typeof raw.tool_call === "boolean" ? { toolCall: raw.tool_call } : {}),
    ...(typeof raw.structured_output === "boolean" ? { structuredOutput: raw.structured_output } : {}),
    ...(typeof raw.temperature === "boolean" ? { temperature: raw.temperature } : {}),
    ...(nonEmptyString(raw.knowledge) ? { knowledge: nonEmptyString(raw.knowledge) } : {}),
    ...(nonEmptyString(raw.release_date) ? { releaseDate: nonEmptyString(raw.release_date) } : {}),
    ...(nonEmptyString(raw.last_updated) ? { lastUpdated: nonEmptyString(raw.last_updated) } : {}),
    ...(typeof raw.open_weights === "boolean" ? { openWeights: raw.open_weights } : {}),
    limit,
    ...(parseCost(raw.cost) ? { cost: parseCost(raw.cost) } : {}),
    ...(parseInterleaved(raw.interleaved) !== undefined
      ? { interleaved: parseInterleaved(raw.interleaved) }
      : {}),
    ...(nonEmptyString(raw.status) ? { status: nonEmptyString(raw.status) } : {}),
    ...(nonEmptyString(raw.canonical_model_id)
      ? { canonicalModelId: nonEmptyString(raw.canonical_model_id) }
      : {}),
    ...(experimental !== undefined ? { experimental } : {}),
    ...(providerMetadata !== undefined ? { provider: providerMetadata } : {}),
    ...(modelApi !== undefined ? { modelApi } : {}),
  };
}

/** Parse the public models.dev document without network access. */
export function parseModelsDevCatalog(body: unknown): ModelsDevProvider[] {
  const root = asRecord(body);
  if (!root) throw new Error("models.dev catalog must be an object");
  const providers: ModelsDevProvider[] = [];
  for (const [providerKey, value] of Object.entries(root)) {
    const provider = asRecord(value);
    const rawModels = asRecord(provider?.models);
    if (!provider || !rawModels) continue;
    const parsedModels = Object.entries(rawModels).flatMap(([modelKey, modelValue]) => {
      const model = asRecord(modelValue);
      const parsed = model ? modelFromRaw(providerKey, provider, modelKey, model) : undefined;
      return parsed ? [parsed] : [];
    });
    const models = [
      ...new Map(parsedModels.map((model) => [model.modelId.toLowerCase(), model])).values(),
    ]
      .sort((a, b) => a.modelId.localeCompare(b.modelId));
    if (models.length > 0) {
      providers.push({
        providerKey,
        name: nonEmptyString(provider.name) ?? providerKey,
        ...(nonEmptyString(provider.api) ? { api: nonEmptyString(provider.api) } : {}),
        ...(nonEmptyString(provider.npm) ? { npm: nonEmptyString(provider.npm) } : {}),
        env: stringArray(provider.env),
        ...(nonEmptyString(provider.doc) ? { doc: nonEmptyString(provider.doc) } : {}),
        models,
      });
    }
  }
  return providers;
}

function normalizedProviderKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/_/g, "-");
}

function normalizedModelId(value: string): string {
  return value.trim().toLowerCase();
}


function isTextAgentModel(model: ModelsDevModel): boolean {
  return model.modalities.input.includes("text") && model.modalities.output.includes("text");
}

function adapterInput(modalities: ModelModalities): Array<"text" | "image"> {
  const input = modalities.input.filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return input.includes("text") ? input : ["text"];
}

function capabilityList(model: ModelsDevModel): ModelInfo["capabilities"] {
  const capabilities = new Set<ModelInfo["capabilities"][number]>(["text"]);
  if (model.attachment === true) capabilities.add("attachments");
  if (model.temperature === true) capabilities.add("temperature");
  if (model.toolCall === true) capabilities.add("tools");
  if (model.reasoning) capabilities.add("reasoning");
  if (model.structuredOutput === true) capabilities.add("json");
  for (const modality of model.modalities.input) {
    if (modality === "image") capabilities.add("vision");
    if (modality === "audio") capabilities.add("audio");
    if (modality === "video") capabilities.add("video");
    if (modality === "pdf") capabilities.add("pdf");
  }
  for (const modality of model.modalities.output) {
    if (modality === "audio") capabilities.add("audio");
    if (modality === "video") capabilities.add("video");
    if (modality === "pdf") capabilities.add("pdf");
  }
  return [...capabilities];
}

export function modelInfoFromModelsDev(
  model: ModelsDevModel,
  providerId: string,
): ModelInfo {
  const contextWindow = positiveInteger(model.limit.context);
  const maxTokens = positiveInteger(model.limit.output);
  const thinkingLevelMap = thinkingLevelMapFromModelsDev(
    model.reasoningOptions,
    model.thinkingLevels,
  );
  return {
    modelId: model.modelId,
    displayName: model.displayName,
    providerId,
    ...(model.description !== undefined ? { description: model.description } : {}),
    ...(model.family !== undefined ? { family: model.family } : {}),
    ...(model.attachment !== undefined ? { attachment: model.attachment } : {}),
    reasoning: model.reasoning,
    ...(model.reasoningOptions !== undefined ? { reasoningOptions: model.reasoningOptions } : {}),
    ...(model.thinkingProtocol !== undefined ? { thinkingProtocol: model.thinkingProtocol } : {}),
    ...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
    ...(model.toolCall !== undefined ? { toolCall: model.toolCall } : {}),
    ...(model.structuredOutput !== undefined ? { structuredOutput: model.structuredOutput } : {}),
    ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
    ...(model.knowledge !== undefined ? { knowledge: model.knowledge } : {}),
    ...(model.releaseDate !== undefined ? { releaseDate: model.releaseDate } : {}),
    ...(model.lastUpdated !== undefined ? { lastUpdated: model.lastUpdated } : {}),
    modalities: model.modalities,
    ...(model.openWeights !== undefined ? { openWeights: model.openWeights } : {}),
    ...(Object.keys(model.limit).length > 0 ? { limit: model.limit } : {}),
    ...(model.cost !== undefined ? { cost: model.cost } : {}),
    ...(model.interleaved !== undefined ? { interleaved: model.interleaved } : {}),
    ...(model.status !== undefined ? { status: model.status } : {}),
    ...(model.experimental !== undefined ? { experimental: model.experimental } : {}),
    ...(model.provider !== undefined ? { provider: model.provider } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    capabilities: capabilityList(model),
    supportedThinkingLevels: [...model.thinkingLevels],
    source: "discovered",
    catalogSource: "models.dev",
  };
}

/** Convert one complete models.dev record into the sidecar model config. */
export function modelConfigFromModelsDev(
  model: ModelsDevModel,
  baseUrl?: string,
): ModelConfig {
  const contextWindow = positiveInteger(model.limit.context) ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = positiveInteger(model.limit.output) ?? DEFAULT_MAX_TOKENS;
  const reasoning = model.reasoningPublished ? model.reasoning : false;
  const thinkingLevels = reasoning ? [...model.thinkingLevels] : [];
  const cost: NonNullable<ModelConfig["cost"]> = {
    input: model.cost?.input ?? 0,
    output: model.cost?.output ?? 0,
    cacheRead: model.cost?.cacheRead ?? 0,
    cacheWrite: model.cost?.cacheWrite ?? 0,
    ...(model.cost?.reasoning !== undefined ? { reasoning: model.cost.reasoning } : {}),
    ...(model.cost?.inputAudio !== undefined ? { inputAudio: model.cost.inputAudio } : {}),
    ...(model.cost?.outputAudio !== undefined ? { outputAudio: model.cost.outputAudio } : {}),
    ...(model.cost?.contextOver200k ? { contextOver200k: model.cost.contextOver200k } : {}),
    ...(model.cost?.tiers ? { tiers: model.cost.tiers } : {}),
  };
  const config: ModelConfig = {
    source: "models.dev",
    name: model.displayName,
    baseUrl: baseUrl ?? model.providerApi ?? "",
    reasoning,
    supportedThinkingLevels: thinkingLevels,
    modalities: model.modalities,
    limit: {
      ...model.limit,
      context: model.limit.context ?? contextWindow,
      input: model.limit.input ?? contextWindow,
      output: model.limit.output ?? maxTokens,
    },
    cost,
    input: adapterInput(model.modalities),
    contextWindow,
    maxTokens,
  };
  if (model.description !== undefined) config.description = model.description;
  if (model.family !== undefined) config.family = model.family;
  if (model.attachment !== undefined) config.attachment = model.attachment;
  if (model.reasoningOptions !== undefined) config.reasoningOptions = model.reasoningOptions;
  if (model.thinkingProtocol !== undefined) config.thinkingProtocol = model.thinkingProtocol;
  const thinkingLevelMap = thinkingLevelMapFromModelsDev(model.reasoningOptions, thinkingLevels);
  if (thinkingLevelMap) config.thinkingLevelMap = thinkingLevelMap;
  if (model.toolCall !== undefined) config.toolCall = model.toolCall;
  if (model.structuredOutput !== undefined) config.structuredOutput = model.structuredOutput;
  if (model.temperature !== undefined) config.temperature = model.temperature;
  if (model.knowledge !== undefined) config.knowledge = model.knowledge;
  if (model.releaseDate !== undefined) config.releaseDate = model.releaseDate;
  if (model.lastUpdated !== undefined) config.lastUpdated = model.lastUpdated;
  if (model.openWeights !== undefined) config.openWeights = model.openWeights;
  if (model.interleaved !== undefined) config.interleaved = model.interleaved;
  if (model.status !== undefined) config.status = model.status;
  if (model.experimental !== undefined) config.experimental = model.experimental;
  if (model.provider !== undefined) {
    config.provider = model.provider;
    config.catalogProvider = model.provider;
  }
  if (model.modelApi !== undefined) config.api = model.modelApi;
  return config;
}

/**
 * Sidecar model config for one provider row: the catalog record when the
 * lookup resolves one, otherwise the generic shape.
 *
 * An Anthropic Messages row the catalog cannot identify (a custom gateway URL
 * serving an id several publishers list) still needs the right thinking wire
 * shape: Opus 4.7+ and the Claude 5 family reject budget thinking with a 400.
 * Whether a Claude id takes adaptive or budget thinking is a property of the
 * model, which Anthropic's own record states, not of the deployment. So only
 * the exact Anthropic id's reasoning options transfer; limits and modalities
 * stay generic because they describe the deployment (#990).
 */
export function catalogModelConfigFor(
  catalog: Pick<ModelsDevCatalog, "findModel"> & Partial<Pick<ModelsDevCatalog, "anthropicThinkingFor" | "modelConfigFor">>,
  input: CatalogTarget,
): ModelConfig {
  if (catalog.modelConfigFor) return catalog.modelConfigFor(input);
  const model = catalog.findModel(input);
  if (!model) {
    const generic = genericModelConfig(input.modelId, input.baseUrl ?? "");
    const thinking = input.apiStyle === "anthropic_messages"
      ? catalog.anthropicThinkingFor?.(input.modelId)
      : undefined;
    return thinking ? { ...generic, ...thinking } : generic;
  }
  const config = modelConfigFromModelsDev(model, input.baseUrl);
  /*
    A record that states no reasoning shape cannot speak for an Anthropic
    Messages row: a record borrowed from another publisher has its own options
    dropped, and a reseller's record describes the reseller's API. Anthropic's
    own record is what says whether this id takes adaptive or budget thinking,
    and losing that would put a rejected shape on the wire (#990).
  */
  const thinking = input.apiStyle === "anthropic_messages" && !config.reasoningOptions?.length
    ? catalog.anthropicThinkingFor?.(input.modelId)
    : undefined;
  return thinking ? { ...config, ...thinking } : config;
}


export class ModelsDevCatalog {
  private providers = new Map<string, ModelsDevProvider>();
  /** One immutable index over the current catalog generation. */
  private resolver: ModelResolver<ModelsDevModel> | undefined;
  private loadPromise: Promise<boolean> | undefined;
  private loaded = false;
  private source: ModelsDevCatalogStatus["source"] = "empty";
  private fetchedAt: string | undefined;
  private lastError: string | undefined;
  private readonly acquisition: ModelsDevAcquisition<ModelsDevProvider>;
  private readonly now: () => number;
  private readonly catalogPath: string;
  private localLoadAttempted = false;
  private localLoadPromise: Promise<boolean> | undefined;
  /** One automatic revalidation per process; automatic failures are not retried. */
  private autoRefreshAttempted = false;
  private disposed = false;
  private readonly operationModels: MutableModels;
  private readonly accountModels = new Map<string, MutableModels>();
  private readonly accountRows = new Map<string, CatalogAccount>();
  private readonly removedAccounts = new Set<string>();

  constructor(options: ModelsDevCatalogOptions) {
    this.now = options.now ?? (() => Date.now());
    this.catalogPath = options.catalogPath;
    this.acquisition = new ModelsDevAcquisition<ModelsDevProvider>({
      catalogPath: options.catalogPath,
      ...(options.cachePath ? { cachePath: options.cachePath } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      now: this.now,
      parse: parseModelsDevCatalog,
    });
    this.operationModels = createModels({
      modelsStore: new InMemoryModelsStore(),
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    for (const provider of options.providers ?? builtinProviders()) {
      this.operationModels.setProvider(provider);
    }
  }

  /** Pi Models are retained only to execute typed non-chat provider operations. */
  setAccountModels(providerId: string, models: MutableModels): void {
    if (!this.removedAccounts.has(providerId)) this.accountModels.set(providerId, models);
  }

  deleteAccount(providerId: string): void {
    this.removedAccounts.add(providerId);
    this.accountModels.delete(providerId);
    this.accountRows.delete(providerId);
  }

  /** Persisted per-model limits remain user-owned overrides over catalog data. */
  configureAccount(row: CatalogAccount): void {
    if (this.removedAccounts.has(row.id)) return;
    this.accountRows.set(row.id, structuredClone(row));
  }

  /**
   * Load the best already-local payload: a schema-valid disk cache wins, the
   * bundled release snapshot is the bootstrap fallback. Never network I/O.
   */
  async loadLocal(): Promise<boolean> {
    if (this.localLoadPromise) return this.localLoadPromise;
    if (this.localLoadAttempted) return this.loaded;
    this.localLoadAttempted = true;
    this.localLoadPromise = (async () => {
      try {
        const snapshot = await this.acquisition.loadLocal();
        if (!snapshot) throw new Error("models.dev metadata is unavailable");
        this.applyProviders(
          snapshot.providers,
          snapshot.source === "cache" ? "remote" : "bundled",
          snapshot.fetchedAt,
        );
      } catch (error) {
        this.loaded = false;
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      return this.loaded;
    })();
    try {
      return await this.localLoadPromise;
    } finally {
      this.localLoadPromise = undefined;
    }
  }

  /**
   * Local-first load plus, when the payload is outside its freshness window,
   * one non-blocking background revalidation. Callers never wait on the
   * network to get a usable catalog.
   */
  async ensureLoaded(): Promise<boolean> {
    const loaded = await this.loadLocal();
    this.revalidateInBackground();
    return loaded;
  }

  /**
   * Refresh canonical metadata. Conditional when cached data is usable, then
   * persisted for the next process. A failure keeps the current payload and
   * manual refresh always contacts the source.
   */
  async refresh(): Promise<boolean> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        const outcome = await this.acquisition.refresh();
        if (outcome.status === "failed") {
          this.lastError = outcome.error;
          return false;
        }
        this.lastError = undefined;
        if (outcome.status === "updated") {
          this.applyProviders(outcome.providers, "remote", outcome.fetchedAt);
        }
        return true;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        return false;
      } finally {
        this.loadPromise = undefined;
      }
    })();
    return this.loadPromise;
  }

  /** Internal provenance of the loaded payload for later consumer migration. */
  getProvenance(): ModelsDevProvenance {
    return this.acquisition.provenance();
  }

  /** Abort in-flight acquisition; later results are ignored. Terminal. */
  dispose(): void {
    this.disposed = true;
    this.acquisition.dispose();
  }

  private applyProviders(
    providers: readonly ModelsDevProvider[],
    source: ModelsDevCatalogStatus["source"],
    fetchedAt?: string,
  ): void {
    this.providers = new Map(providers.map((provider) => [provider.providerKey, provider]));
    // Replacing the provider map invalidates the derived resolver indexes.
    this.resolver = undefined;
    this.loaded = true;
    this.source = source;
    this.fetchedAt = fetchedAt;
    this.lastError = undefined;
  }

  /** At most one automatic revalidation per process; automatic failures are not retried. */
  private revalidateInBackground(): void {
    if (this.autoRefreshAttempted || this.disposed) return;
    if (!this.acquisition.shouldRevalidate()) return;
    this.autoRefreshAttempted = true;
    void this.refresh();
  }

  getStatus(): ModelsDevCatalogStatus {
    return {
      loaded: this.loaded,
      source: this.source,
      catalogPath: this.catalogPath,
      ...(this.fetchedAt ? { fetchedAt: this.fetchedAt } : {}),
      providerCount: this.providers.size,
      modelCount: [...this.providers.values()].reduce(
        (count, provider) => count + provider.models.length,
        0,
      ),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  modelConfigFor(input: CatalogTarget, unpublishedConfig?: ModelConfig): ModelConfig {
    const model = this.findModel(input);
    const binding = input.providerId
      ? this.accountRows.get(input.providerId)?.models?.find(
          (entry) => entry.id.trim().toLowerCase() === input.modelId.trim().toLowerCase(),
        )
      : undefined;
    let baseline = model
      ? modelConfigFromModelsDev(model, input.baseUrl)
      : unpublishedConfig ?? genericModelConfig(input.modelId, input.baseUrl ?? "");
    if (!model && !unpublishedConfig && input.apiStyle === "anthropic_messages") {
      const thinking = this.anthropicThinkingFor(input.modelId);
      if (thinking) baseline = { ...baseline, ...thinking };
    }
    // Pi owns wire capabilities, independently of models.dev's limits/prices.
    // Use the original published record, never an account/relay projection.
    const key = input.vendorKey?.trim().toLowerCase();
    const vendor = (key ? PI_VENDOR_ALIASES[key] ?? key : undefined) ?? this.providerKeyForRow(input);
    const transport = vendor ? this.operationModels.getModel(vendor, input.modelId) : undefined;
    if (transport) {
      const transcript = transcriptConfigFromPi(transport);
      baseline = { ...baseline, transcriptBinding: transcript.transcriptBinding,
        compat: { ...baseline.compat, ...transcript.compat } };
    }
    if (!binding) return baseline;
    const limits = resolveBindingLimits(baseline, binding);
    return modelConfigWithBinding(limits.catalogConfig, limits.binding);
  }

  /** Endpoint-owned published record for a configured row; never a borrow. */
  findModel(input: CatalogTarget): ModelsDevModel | undefined {
    if (input.providerId && this.removedAccounts.has(input.providerId)) return undefined;
    const resolution = this.resolveModelReference(input);
    return resolution.state === "matched" && resolution.domain === "endpoint"
      ? resolution.value
      : undefined;
  }

  /**
   * Full deterministic resolution: endpoint-serving facts scoped to the row's
   * publisher, canonical reference only when no publisher owns the row. Raw
   * wire ids are never rewritten; callers decide which domain they may use.
   */
  resolveModelReference(
    input: CatalogTarget & { declaredCanonicalModelId?: string; endpointFetchedAt?: string },
  ): ModelResolution<ModelsDevModel> {
    return this.modelResolver().resolve({
      modelId: input.modelId,
      ...(input.vendorKey ? { vendorKey: input.vendorKey } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.declaredCanonicalModelId
        ? { declaredCanonicalModelId: input.declaredCanonicalModelId }
        : {}),
      ...(input.endpointFetchedAt ? { endpointFetchedAt: input.endpointFetchedAt } : {}),
    });
  }

  private modelResolver(): ModelResolver<ModelsDevModel> {
    if (!this.resolver) {
      this.resolver = new ModelResolver(
        [...this.providers.values()],
        this.fetchedAt ? { fetchedAt: this.fetchedAt } : {},
      );
    }
    return this.resolver;
  }




  publishedModelFor(input: CatalogTarget): ModelsDevModel | undefined {
    return this.findModel(input);
  }

  /**
   * The models.dev snapshot owns published chat metadata. Pi is consulted here
   * only to obtain a typed executable operation model such as image generation.
   */
  findModelOfType<T extends ModelType>(type: T, input: CatalogTarget): ModelTypeMap[T] | undefined {
    if (type === "chat") return undefined;
    if (input.providerId && this.removedAccounts.has(input.providerId)) return undefined;
    const collection = (input.providerId && this.accountModels.get(input.providerId)) || this.operationModels;
    const key = input.vendorKey?.trim().toLowerCase();
    const alias = key ? PI_VENDOR_ALIASES[key] ?? key : undefined;
    const providerId = alias && collection.getProvider(alias)
      ? alias
      : this.providerKeyForRow(input);
    if (!providerId || !collection.getProvider(providerId)) return undefined;
    return collection.getModelOfType(type, providerId, input.modelId);
  }

  settingsMetadataFor(input: CatalogTarget): ModelInfo | undefined {
    const vendor = this.providerKeyForRow(input);
    return settingsOperationMetadata(input.providerId ?? "", vendor, input.modelId)[0];
  }

  /**
   * Thinking wire metadata Anthropic publishes for exactly this id, or nothing.
   * Aliases and other publishers' copies never answer: only Anthropic's own
   * record states which thinking shape a Claude model accepts.
   */
  anthropicThinkingFor(
    modelId: string,
  ): Pick<ModelConfig, "reasoningOptions" | "thinkingLevelMap"> | undefined {
    const requested = normalizedModelId(modelId);
    const model = this.providers.get("anthropic")?.models.find(
      (candidate) => normalizedModelId(candidate.modelId) === requested,
    );
    if (!model?.reasoning || !model.reasoningOptions?.length) return undefined;
    const thinkingLevelMap = thinkingLevelMapFromModelsDev(
      model.reasoningOptions,
      model.thinkingLevels,
    );
    return {
      reasoningOptions: model.reasoningOptions,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    };
  }

  modelsForProvider(input: {
    vendorKey?: string;
    baseUrl?: string;
    providerId: string;
    /**
     * Include the models this provider publishes next to its chat models —
     * embedding, speech, image and reranking endpoints. The settings picker
     * asks for them because it renders the service's own catalog of what the
     * credential can call; session and agent paths keep the default, which is
     * the text models they can actually run.
     */
    includeNonChat?: boolean;
  }): ModelInfo[] {
    const publisher = this.modelResolver().resolvePublisher(input);
    const preferredProvider = publisher.state === "matched" ? publisher.provider : undefined;
    // Publisher-owned only: an unknown or conflicting endpoint contributes no
    // catalog models, and no model id may select a publisher on its behalf.
    const providers = preferredProvider ? [preferredProvider] : [];
    const seen = new Set<string>();
    const chatAndPublished = providers.flatMap((provider) =>
      provider.models
        .filter((model) => {
          const key = normalizedModelId(model.modelId);
          if (seen.has(key)) return false;
          if (!input.includeNonChat && !isTextAgentModel(model)) return false;
          seen.add(key);
          return true;
        })
        .map((model) => modelInfoFromModelsDev(model, input.providerId)),
    );
    if (!input.includeNonChat) return chatAndPublished;
    const seenIds = new Set(chatAndPublished.map((model) => normalizedModelId(model.modelId)));
    const operationRows = settingsOperationMetadata(input.providerId, preferredProvider?.providerKey)
      .filter((model) => {
        const key = normalizedModelId(model.modelId);
        if (seenIds.has(key)) return false;
        seenIds.add(key);
        return true;
      });
    return [...chatAndPublished, ...operationRows];
  }

  /** models.dev provider key for a configured row, when ownership is unambiguous. */
  providerKeyForRow(input: { vendorKey?: string; baseUrl?: string }): string | undefined {
    const publisher = this.modelResolver().resolvePublisher(input);
    return publisher.state === "matched" ? publisher.provider?.providerKey : undefined;
  }
}
