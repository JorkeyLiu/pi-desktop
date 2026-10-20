import {
  bindingSupportsImages,
  effectiveContextWindow,
  isImageGenerationModel,
  type ImageGenerationBindings,
  modelMatchesFilter,
  modelWireIdsEqual,
  type ModelBinding,
  type ModelInfo,
  type ProviderPublic,
} from "@pi-desktop/shared";

type ConfiguredProvider = Pick<ProviderPublic, "id" | "models" | "defaultModelId">;

/** UI identity is the complete wire id, not a catalog alias or a route suffix. */
export function sameComposerModelId(left: string, right: string): boolean {
  return modelWireIdsEqual(left, right);
}

function configuredModelIds(provider: ConfiguredProvider): string[] {
  const ids = (provider.models ?? [])
    .map((binding) => binding.id.trim())
    .filter(Boolean);
  if (ids.length > 0) return [...new Set(ids)];

  const legacyId = provider.defaultModelId?.trim();
  return legacyId ? [legacyId] : [];
}

/**
 * Build the Composer model list from the models explicitly enabled in
 * provider settings. Discovery only enriches an exact configured id; it does
 * not grant every discovered model access to the conversation picker or lend
 * another route's capabilities to this binding.
 */
export function composerModelsForProvider(
  provider: ConfiguredProvider,
  discovered: readonly ModelInfo[] | undefined,
  imageGeneration?: ImageGenerationBindings | null,
): ModelInfo[] {
  return configuredModelIds(provider).filter((modelId) =>
    !isImageGenerationModel(imageGeneration, provider.id, modelId),
  ).map((modelId) => {
    const metadata = (discovered ?? []).find((model) =>
      sameComposerModelId(model.modelId, modelId),
    );
    const binding = composerModelBinding(provider, modelId);
    const contextWindow = effectiveContextWindow(
      metadata?.contextWindow,
      binding?.contextWindow,
      binding?.contextWindowSource,
    );
    const contextLimit = contextWindow === undefined ? {} : { contextWindow };
    const displayName = modelId;
    return metadata
      ? { ...metadata, ...contextLimit, modelId, displayName, providerId: provider.id }
      : {
          modelId,
          displayName,
          providerId: provider.id,
          ...contextLimit,
          capabilities: ["text"],
          source: "user" as const,
        };
  });
}

/** The Composer uses the configured alias when set, otherwise the complete wire id. */
export function composerModelDisplayName(
  provider: ConfiguredProvider | undefined,
  modelId: string,
): string {
  const alias = provider ? composerModelBinding(provider, modelId)?.alias?.trim() : undefined;
  return alias || modelId;
}

/** Find only the binding for this complete wire id. */
export function composerModelBinding(
  provider: ConfiguredProvider,
  modelId: string,
): ModelBinding | undefined {
  return (provider.models ?? []).find((candidate) =>
    sameComposerModelId(candidate.id, modelId),
  );
}

/** Short capability markers for one configured model. */
export type ComposerModelBadge = "reasoning" | "vision";

/**
 * Capability markers for one configured model. Vision follows the binding's
 * image-input override when set, the published capability otherwise. The
 * Composer model menu no longer renders them — its rows carry the label alone
 * — so this stays a pure projection for any surface that wants it.
 */
export function composerModelBadges(
  model: ModelInfo,
  provider?: ConfiguredProvider | null,
): ComposerModelBadge[] {
  const badges: ComposerModelBadge[] = [];
  if (modelMatchesFilter(model, "reasoning")) badges.push("reasoning");
  const binding = provider ? composerModelBinding(provider, model.modelId) : undefined;
  if (bindingSupportsImages(binding, model)) badges.push("vision");
  return badges;
}

/** Search the full id, configured alias, published name, family and provider. */
export function composerModelMatchesQuery(
  model: ModelInfo,
  providerName: string,
  query: string,
  alias?: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystacks = [
    model.modelId,
    alias ?? "",
    model.displayName ?? "",
    model.family ?? "",
    providerName,
  ];
  return haystacks.some((value) => value.toLowerCase().includes(needle));
}

/** The two parts of a Composer chip's model name, as the chip displays it. */
export type ComposerModelChipLabel = {
  /** The text the chip paints: the model name, or the alias exactly as typed. */
  label: string;
  /** The routing prefix the display dropped; empty when nothing was shortened. */
  namespace: string;
};

/**
 * Display-only shortening of a Composer model name.
 *
 * A wire id carries its routing namespace (`opencode-go/deepseek-v4.1-flash`);
 * the chip paints the model name alone so the name — not the route — owns the
 * chip's width, while the trigger's own accessible name keeps the unchanged
 * ids. A configured alias is the user's name for the model and is never
 * shortened. Nothing here touches the id that reaches the runtime.
 */
export function composerModelChipLabel(
  modelLabel: string,
  wireId: string | undefined,
): ComposerModelChipLabel {
  const label = modelLabel.trim();
  if (!wireId || label !== wireId.trim()) return { label, namespace: "" };
  const slash = label.lastIndexOf("/");
  if (slash <= 0 || slash === label.length - 1) return { label, namespace: "" };
  return { label: label.slice(slash + 1), namespace: label.slice(0, slash) };
}
