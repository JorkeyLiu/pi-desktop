import type { ModelInfo, ModelModality } from "@pi-desktop/shared";
import operationMetadata from "./settings-operation-metadata.json" with { type: "json" };

// Desktop preset IDs predate Pi's namespaces. These aliases select a Pi provider;
// they never change the user's endpoint or on-wire model ID. Catalog matching
// does not consult them: publisher identity is resolved by the endpoint/key
// contract in model-metadata/model-resolver.ts.
export const PI_VENDOR_ALIASES: Record<string, string> = {
  zhipuai: "zai", "zhipuai-coding-plan": "zai-coding-cn",
  "zai-coding-plan": "zai-coding-plan",
};

const leaf = (id: string) => id.toLowerCase().split("/").at(-1);

/**
 * Display-only compatibility data for speech/embedding/image settings rows that
 * Pi's chat-provider records do not publish. It has no auth, prices, refresh,
 * routing or dispatch.
 * Chat selection and typed Pi operation lookups never consult this data.
 */
export function settingsOperationMetadata(providerId: string, vendor?: string, id?: string): ModelInfo[] {
  const candidates = operationMetadata.filter(row =>
    (!vendor || row.vendor === vendor) && (!id || leaf(row.id) === leaf(id.trim())));
  const unique = new Map<string, typeof candidates>();
  for (const row of candidates) {
    const key = id ? id.trim().toLowerCase() : row.id;
    unique.set(key, [...(unique.get(key) ?? []), row]);
  }
  return [...unique.values()].flatMap(rows => {
    const row = rows[0];
    if (!rows.every(other => JSON.stringify([other.modalities, other.contextWindow, other.maxTokens]) === JSON.stringify([row.modalities, row.contextWindow, row.maxTokens]))) return [];
    const modalities = { input: row.modalities.input as ModelModality[], output: row.modalities.output as ModelModality[] };
    return [{ providerId, modelId: id ?? row.id, displayName: row.name, modalities,
      contextWindow: row.contextWindow, maxTokens: row.maxTokens,
      capabilities: [...new Set([...modalities.input, ...modalities.output])].filter((mode): mode is "text" | "audio" | "video" => mode === "text" || mode === "audio" || mode === "video"),
      source: "bundled" as const }];
  });
}
