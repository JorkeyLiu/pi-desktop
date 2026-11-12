import {
  capabilitiesFromModelConfig,
  capabilitiesFromModelInfo,
  clampThinkingLevel,
  genericModelConfig,
  modelConfigWithBinding,
  resolveThinkingIntent,
  thinkingCapabilityIsUnknown,
  visionFromModelConfig,
  type ModelCapabilities,
} from "./model-capabilities.js";
import { describe, expect, it } from "vitest";
import { THINKING_LEVELS, type ModelInfo, type ThinkingLevel } from "@pi-desktop/shared";
import type { ModelConfig } from "./thinking-level.js";

function knownModel(): ModelConfig {
  return {
    ...genericModelConfig("claude-opus-4.6", "https://api.anthropic.com"),
    source: "models.dev" as const,
    name: "Claude 4.6 Opus",
    reasoning: true,
    supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"] as ThinkingLevel[],
    modalities: {
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
  };
}

describe("main-supplied model capabilities", () => {
  it("uses models.dev modalities for visual transport", () => {
    expect(visionFromModelConfig(knownModel())).toBe(true);
    expect(
      visionFromModelConfig({
        ...genericModelConfig("text-only"),
        modalities: { input: ["text"], output: ["text"] },
      }),
    ).toBe(false);
  });

  it("uses the published reasoning levels without consulting a model catalog", () => {
    expect(capabilitiesFromModelConfig(knownModel())).toEqual({
      supportsReasoning: true,
      supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(capabilitiesFromModelConfig(genericModelConfig("unknown"))).toEqual({
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    });
  });

  it("projects a public models.dev row to the same capability shape", () => {
    const info: ModelInfo = {
      modelId: "model",
      displayName: "Model",
      providerId: "provider",
      modalities: { input: ["text"], output: ["text"] },
      reasoning: true,
      supportedThinkingLevels: ["off", "high"],
      capabilities: ["text", "reasoning"],
      source: "discovered",
      catalogSource: "models.dev",
    };
    expect(capabilitiesFromModelInfo(info)).toEqual({
      supportsReasoning: true,
      supportedThinkingLevels: ["off", "high"],
    });
  });

  it("keeps unknown models on the generic non-reasoning shape", () => {
    const config = genericModelConfig("unknown-model", "https://gateway.example/v1");
    expect(config).toMatchObject({
      source: "generic",
      name: "unknown-model",
      reasoning: false,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 128_000, input: 128_000, output: 8_192 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
  });

  it("uses the published long-context window when a binding marks its seed as catalog-owned", () => {
    const model = {
      ...knownModel(),
      contextWindow: 1_050_000,
      limit: { context: 1_050_000, input: 922_000, output: 128_000 },
    };
    const configured = modelConfigWithBinding(model, {
      contextWindow: 128_000,
      contextWindowSource: "catalog",
      maxTokens: 8_192,
      thinkingLevels: [],
    });
    expect(configured.contextWindow).toBe(1_050_000);
    expect(configured.limit?.context).toBe(1_050_000);
  });

  it("does not use a generic fallback to replace a catalog snapshot", () => {
    const configured = modelConfigWithBinding(genericModelConfig("gateway-model"), {
      contextWindow: 1_000_000,
      contextWindowSource: "catalog",
      maxTokens: 8_192,
      thinkingLevels: [],
    });
    expect(configured.contextWindow).toBe(1_000_000);
  });

  it("preserves a legacy stored context window without provenance", () => {
    const configured = modelConfigWithBinding(knownModel(), {
      contextWindow: 128_000,
      maxTokens: 8_192,
      thinkingLevels: [],
    });
    expect(configured.contextWindow).toBe(128_000);
  });

  it("applies binding limits and preserves explicit thinking levels", () => {
    const configured = modelConfigWithBinding(
      {
        ...knownModel(),
        thinkingLevelMap: { xhigh: null, max: null },
      },
      {
        contextWindow: 64_000,
        maxTokens: 4_000,
        thinkingLevels: ["off", "minimal", "low", "max"],
      },
    );
    expect(configured.contextWindow).toBe(64_000);
    expect(configured.maxTokens).toBe(4_000);
    expect(configured.reasoning).toBe(true);
    expect(configured.supportedThinkingLevels).toEqual([
      "off",
      "minimal",
      "low",
      "max",
    ]);
    expect(configured.thinkingLevelMap).toMatchObject({ max: "max" });

    const enlarged = modelConfigWithBinding(knownModel(), {
      contextWindow: 256_000,
      maxTokens: 8_192,
      thinkingLevels: [],
    });
    expect(enlarged.contextWindow).toBe(256_000);
    expect(enlarged.catalogContextWindow).toBe(128_000);

    const unknown = modelConfigWithBinding(genericModelConfig("unknown"), {
      contextWindow: 16_000,
      maxTokens: 2_000,
      thinkingLevels: ["high"],
    });
    expect(unknown.reasoning).toBe(true);
    expect(unknown.supportedThinkingLevels).toEqual(["high"]);

    const cataloguedNonReasoning = modelConfigWithBinding(
      {
        ...genericModelConfig("catalogued-chat"),
        source: "models.dev" as const,
        reasoning: false,
        supportedThinkingLevels: [],
      },
      {
        contextWindow: 16_000,
        maxTokens: 2_000,
        thinkingLevels: ["medium"],
      },
    );
    expect(cataloguedNonReasoning.reasoning).toBe(true);
    expect(cataloguedNonReasoning.supportedThinkingLevels).toEqual(["medium"]);
  });

  it("clamps sparse catalog capability lists using the nearest supported level", () => {
    const capabilities: ModelCapabilities = {
      supportsReasoning: true,
      supportedThinkingLevels: ["off", "low", "high"] as ThinkingLevel[],
    };
    expect(clampThinkingLevel(capabilities, "minimal")).toBe("low");
    expect(clampThinkingLevel(capabilities, "max")).toBe("high");
  });
});

describe("binding attachment capability overrides", () => {
  const baseBinding = {
    contextWindow: 200_000,
    maxTokens: 32_000,
    thinkingLevels: ["medium"] as ThinkingLevel[],
  };

  it("follows the published modalities when no override is stored", () => {
    const config = modelConfigWithBinding(knownModel(), {
      ...baseBinding,
      supportsImages: null,
      supportsDocuments: null,
    });
    expect(config.modalities?.input).toEqual(["text", "image", "pdf"]);
    expect(visionFromModelConfig(config)).toBe(true);
  });

  it("turns image transport off for a vision model the user opted out of", () => {
    const config = modelConfigWithBinding(knownModel(), {
      ...baseBinding,
      supportsImages: false,
    });
    expect(config.modalities?.input).not.toContain("image");
    expect(config.input).not.toContain("image");
    expect(visionFromModelConfig(config)).toBe(false);
  });

  it("grants image transport to a model the catalog calls text-only", () => {
    // A proxied endpoint routinely accepts input its catalog entry omits, so the
    // override is applied rather than narrowed to the published capability.
    const textOnly = {
      ...genericModelConfig("proxy-model", "https://proxy.test/v1"),
      modalities: { input: ["text"] as const, output: ["text"] as const },
    };
    const config = modelConfigWithBinding(textOnly, {
      ...baseBinding,
      supportsImages: true,
    });
    expect(config.modalities?.input).toContain("image");
    expect(config.input).toContain("image");
    expect(visionFromModelConfig(config)).toBe(true);
  });

  it("records a document override without adding an untransportable modality to the adapter subset", () => {
    const config = modelConfigWithBinding(knownModel(), {
      ...baseBinding,
      supportsDocuments: false,
    });
    expect(config.modalities?.input).not.toContain("pdf");
    // pi-ai has no PDF content block, so the adapter subset never carried it.
    expect(config.input).toEqual(["text", "image"]);
  });

  it("keeps text input even when every override is off", () => {
    const config = modelConfigWithBinding(knownModel(), {
      ...baseBinding,
      supportsImages: false,
      supportsDocuments: false,
    });
    expect(config.modalities?.input).toEqual(["text"]);
    expect(config.input).toEqual(["text"]);
  });

  it("leaves limits and explicit thinking levels untouched by a capability override", () => {
    const config = modelConfigWithBinding(knownModel(), {
      ...baseBinding,
      thinkingLevels: ["medium", "off"] as ThinkingLevel[],
      supportsImages: true,
    });
    expect(config.contextWindow).toBe(200_000);
    expect(config.maxTokens).toBe(32_000);
    expect(config.supportedThinkingLevels).toEqual(["off", "medium"]);
  });
});

describe("unmatched model effective thinking policy", () => {
  const generic = genericModelConfig("route/unknown");

  it("claims no reasoning without an explicit thinking configuration", () => {
    for (const binding of [undefined, { contextWindow: 128_000, maxTokens: 8_192, thinkingLevels: [] }]) {
      const effective = modelConfigWithBinding(generic, binding);
      expect(effective.reasoning).toBe(false);
      expect(effective.supportedThinkingLevels).toEqual([]);
      expect(effective.thinkingLevelMap).toBeUndefined();
      expect(effective.thinkingProtocol).toBeUndefined();
      expect(capabilitiesFromModelConfig(effective)).toEqual({
        supportsReasoning: false,
        supportedThinkingLevels: ["off"],
      });
      for (const level of THINKING_LEVELS) {
        expect(clampThinkingLevel(capabilitiesFromModelConfig(effective), level)).toBe("off");
      }
    }
    // The operational fallback row itself is never mutated into a claim.
    expect(generic.reasoning).toBe(false);
    expect(generic.supportedThinkingLevels).toEqual([]);
  });

  it("honors only explicitly selected levels and their adapter mappings", () => {
    const levels: ThinkingLevel[] = ["minimal", "high", "xhigh"];
    const effective = modelConfigWithBinding(generic, {
      contextWindow: 128_000,
      maxTokens: 8_192,
      thinkingLevels: levels,
    });
    expect(effective.reasoning).toBe(true);
    expect(effective.supportedThinkingLevels).toEqual(levels);
    // xhigh is explicitly selected but has no published mapping; it stays
    // adapter-valid. No unselected level gains a mapping.
    expect(effective.thinkingLevelMap).toEqual({ xhigh: "xhigh" });
    const capabilities = capabilitiesFromModelConfig(effective);
    expect(capabilities).toEqual({ supportsReasoning: true, supportedThinkingLevels: levels });
    for (const level of levels) expect(clampThinkingLevel(capabilities, level)).toBe(level);
  });

  it("preserves an explicit thinking protocol with the selected levels", () => {
    const effective = modelConfigWithBinding(generic, {
      contextWindow: 128_000,
      maxTokens: 8_192,
      thinkingLevels: ["medium"],
      thinkingProtocol: "adaptive",
    });
    expect(effective.thinkingProtocol).toBe("adaptive");
    expect(effective.compat?.forceAdaptiveThinking).toBe(true);
    expect(capabilitiesFromModelConfig(effective)).toEqual({
      supportsReasoning: true,
      supportedThinkingLevels: ["medium"],
    });
  });

  it("keeps published catalog reasoning levels unchanged", () => {
    const published = { ...knownModel(), supportedThinkingLevels: ["low", "high"] as ThinkingLevel[] };
    expect(capabilitiesFromModelConfig(modelConfigWithBinding(published))).toEqual({
      supportsReasoning: true,
      supportedThinkingLevels: ["low", "high"],
    });
  });

  it("preserves explicit restrictions and trusted non-reasoning records", () => {
    const binding = { contextWindow: 128_000, maxTokens: 8_192, thinkingLevels: ["off"] as ThinkingLevel[] };
    expect(capabilitiesFromModelConfig(modelConfigWithBinding(generic, binding)).supportsReasoning).toBe(false);
    const trusted = { ...generic, source: "models.dev" as const };
    expect(capabilitiesFromModelConfig(modelConfigWithBinding(trusted)).supportsReasoning).toBe(false);
    expect(capabilitiesFromModelConfig(modelConfigWithBinding(trusted, { ...binding, thinkingLevels: [] })).supportsReasoning).toBe(false);
  });

  it("keeps the operational off default when no level was selected", () => {
    const effective = modelConfigWithBinding(generic);
    const intent = resolveThinkingIntent(
      { ...capabilitiesFromModelConfig(effective), modelConfig: effective },
      "off",
    );
    expect(intent.level).toBe("off");
    expect(intent.modelConfig).toBe(effective);
    expect(capabilitiesFromModelConfig(intent.modelConfig)).toEqual({
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    });
    // `omit` asks to leave the provider default untouched, so it stays clamped.
    const omitted = resolveThinkingIntent(
      { ...capabilitiesFromModelConfig(effective), modelConfig: effective },
      "omit",
    );
    expect(omitted.level).toBe("off");
    expect(omitted.modelConfig).toBe(effective);
  });

  it("carries an explicitly selected level on an unclassified model as request intent", () => {
    const effective = modelConfigWithBinding(generic);
    expect(thinkingCapabilityIsUnknown(effective)).toBe(true);
    const intent = resolveThinkingIntent(
      { ...capabilitiesFromModelConfig(effective), modelConfig: effective },
      "high",
    );
    expect(intent.level).toBe("high");
    expect(intent.modelConfig).toEqual({
      ...effective,
      reasoning: true,
      supportedThinkingLevels: ["high"],
    });
    // The source row is untouched: this is an adapter projection, not a claim.
    expect(effective.reasoning).toBe(false);
    expect(effective.supportedThinkingLevels).toEqual([]);
  });

  it("maps an explicitly selected extended level without publishing a ladder", () => {
    const effective = modelConfigWithBinding(generic);
    const intent = resolveThinkingIntent(
      { ...capabilitiesFromModelConfig(effective), modelConfig: effective },
      "xhigh",
    );
    expect(intent.level).toBe("xhigh");
    expect(intent.modelConfig?.supportedThinkingLevels).toEqual(["xhigh"]);
    expect(intent.modelConfig?.thinkingLevelMap).toEqual({ xhigh: "xhigh" });
    expect(capabilitiesFromModelConfig(intent.modelConfig)).toEqual({
      supportsReasoning: true,
      supportedThinkingLevels: ["xhigh"],
    });
  });

  it("still clamps to a metadata claim or a configured binding ladder", () => {
    const trusted = { ...generic, source: "models.dev" as const };
    const trustedIntent = resolveThinkingIntent(
      { ...capabilitiesFromModelConfig(trusted), modelConfig: trusted },
      "high",
    );
    expect(trustedIntent.level).toBe("off");
    expect(trustedIntent.modelConfig).toBe(trusted);

    const configured = modelConfigWithBinding(generic, {
      contextWindow: 128_000,
      maxTokens: 8_192,
      thinkingLevels: ["medium"],
    });
    expect(capabilitiesFromModelConfig(configured).supportsReasoning).toBe(true);
    const configuredIntent = resolveThinkingIntent(
      { ...capabilitiesFromModelConfig(configured), modelConfig: configured },
      "high",
    );
    expect(configuredIntent.level).toBe("medium");
    expect(configuredIntent.modelConfig).toBe(configured);
  });
});

it("keeps native Pi null and absent extended mappings unavailable", () => {
  const configured = modelConfigWithBinding({ ...knownModel(), source: "pi",
    supportedThinkingLevels: ["low", "high"], thinkingLevelMap: { off: null, xhigh: null } }, {
    contextWindow: 64_000, maxTokens: 4_000, thinkingLevels: ["low", "xhigh", "max"],
  });
  expect(configured.supportedThinkingLevels).toEqual(["low"]);
  expect(configured.thinkingLevelMap?.xhigh).toBeNull();
  expect(configured.thinkingLevelMap?.max).toBeUndefined();
});
