/**
 * Deterministic reference resolution for canonical model metadata.
 *
 * Three facts stay separate and no synthetic merged record is produced:
 *
 * - Endpoint-serving facts answer only inside the publisher that explicitly
 *   owns the configured endpoint. The configured provider key identifies an
 *   upstream publisher only when it is an exact catalog key and nothing about
 *   the endpoint contradicts it; a shared endpoint needs that exact key to
 *   disambiguate, and an unnamed or conflicting endpoint stays unknown.
 * - Canonical references describe which published model entity a wire id
 *   refers to. They are reported separately and never pretend to be endpoint
 *   capacity; they are only consulted when no publisher owns the row.
 * - Availability is never answered here. A resolver result says what the
 *   catalog knows about one id, not which ids an endpoint serves.
 *
 * Matching is exact. There is no alias table, no brand/family guess, no
 * deployment/version/date suffix stripping, no cross-publisher borrowing and
 * no official-provider preference. Every result reports the state, method,
 * source and provenance the caller needs to tell "the endpoint's own publisher
 * states this" from "one canonical record is uniquely identified".
 */

export type ModelResolutionState = "matched" | "unmatched" | "ambiguous";

export type PublisherResolutionMethod =
  | "explicit-key-and-exact-endpoint"
  | "explicit-key"
  | "exact-endpoint";

export type ModelResolutionMethod =
  | "publisher-exact-id"
  | "publisher-exact-id-casefold"
  | "declared-canonical-id"
  | "global-exact-id"
  | "global-exact-id-casefold"
  | "canonical-exact-id"
  | "canonical-unique-basename";

/** Which fact domain a matched record answers for. */
export type ModelResolutionDomain = "endpoint" | "canonical";

export type ModelCandidate = {
  providerKey: string;
  modelId: string;
};

export type PublisherResolution<M extends ResolvableModel> = {
  state: ModelResolutionState;
  method?: PublisherResolutionMethod;
  provider?: ResolvableProvider<M>;
  /** Provider keys in catalog order when the identity is ambiguous. */
  candidates?: readonly string[];
};

export type ModelResolutionSource = {
  providerKey?: string;
  /** Published endpoint that anchored the match, when one was used. */
  url?: string;
  /** Published record id the match resolved to (never the wire id). */
  modelId?: string;
};

export type ModelResolution<M extends ResolvableModel> = {
  state: ModelResolutionState;
  method?: ModelResolutionMethod;
  domain?: ModelResolutionDomain;
  publisher: PublisherResolution<M>;
  source?: ModelResolutionSource;
  /** Provenance of the catalog payload the record came from. */
  fetchedAt?: string;
  /** Provenance of the endpoint answer, when the caller supplies it. */
  endpointFetchedAt?: string;
  value?: M;
  /** Competing records when the result is ambiguous. */
  candidates?: readonly ModelCandidate[];
};

export type ModelResolutionInput = {
  modelId: string;
  vendorKey?: string;
  baseUrl?: string;
  /**
   * Canonical id the endpoint source explicitly declares for this wire id.
   * Only explicit source evidence is accepted; nothing here is inferred.
   */
  declaredCanonicalModelId?: string;
  /** Timestamp of the endpoint answer, when the endpoint supplied one. */
  endpointFetchedAt?: string;
};

/** Minimal published record shape the resolver needs. */
export type ResolvableModel = {
  modelId: string;
  canonicalModelId?: string;
};

/** Minimal published provider shape the resolver needs. */
export type ResolvableProvider<M extends ResolvableModel> = {
  providerKey: string;
  api?: string;
  models: readonly M[];
};

type IndexedModel<M extends ResolvableModel> = {
  providerKey: string;
  model: M;
};

type ProviderIndex<M extends ResolvableModel> = {
  provider: ResolvableProvider<M>;
  /** Case-sensitive wire ids, trimmed. */
  exact: Map<string, IndexedModel<M>[]>;
  /** Casefolded wire ids, trimmed. */
  folded: Map<string, IndexedModel<M>[]>;
};

/** Provider keys compare exactly after whitespace/underscore normalization. */
export function normalizedProviderKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/_/g, "-");
}

/** Wire ids compare exactly after trimming; case is folded only in a named step. */
export function normalizedModelId(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Canonical form of a provider base URL: lowercase origin without a trailing
 * slash and without the trailing API version segment, so a row configured with
 * `.../v1` still matches the documented endpoint.
 */
export function normalizedApiUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname
      .replace(/\/+$/, "")
      .replace(/\/(?:v1|v1beta|v1alpha)$/i, "");
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}`;
  } catch {
    return undefined;
  }
}

/** Whether two base URLs address exactly the same normalized endpoint. */
export function apiMatches(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizedApiUrl(left);
  const normalizedRight = normalizedApiUrl(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function addToBucket<M extends ResolvableModel>(
  map: Map<string, IndexedModel<M>[]>,
  key: string,
  entry: IndexedModel<M>,
): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(entry);
  else map.set(key, [entry]);
}

function canonicalBasename(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  const slash = trimmed.lastIndexOf("/");
  const basename = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  return basename || undefined;
}

function candidatesOf<M extends ResolvableModel>(
  entries: readonly IndexedModel<M>[],
): ModelCandidate[] {
  return entries.map((entry) => ({
    providerKey: entry.providerKey,
    modelId: entry.model.modelId,
  }));
}

/**
 * Read-only resolver over one catalog generation. All indexes are built once
 * in the constructor, so repeated lookups do not scan the catalog and misses
 * cannot grow any per-query cache.
 */
export class ModelResolver<M extends ResolvableModel> {
  private readonly providers = new Map<string, ResolvableProvider<M>>();
  private readonly providerIndexes = new Map<string, ProviderIndex<M>>();
  private readonly byEndpoint = new Map<string, ResolvableProvider<M>[]>();
  private readonly byGlobalId = new Map<string, IndexedModel<M>[]>();
  private readonly byCanonicalId = new Map<string, IndexedModel<M>[]>();
  private readonly byCanonicalBasename = new Map<string, IndexedModel<M>[]>();
  private readonly fetchedAt: string | undefined;

  constructor(
    providers: readonly ResolvableProvider<M>[],
    options: { fetchedAt?: string } = {},
  ) {
    this.fetchedAt = options.fetchedAt;
    for (const provider of providers) {
      if (this.providers.has(provider.providerKey)) continue;
      this.providers.set(provider.providerKey, provider);
      const index: ProviderIndex<M> = { provider, exact: new Map(), folded: new Map() };
      this.providerIndexes.set(provider.providerKey, index);
      const endpoint = normalizedApiUrl(provider.api);
      if (endpoint) {
        const bucket = this.byEndpoint.get(endpoint);
        if (bucket) bucket.push(provider);
        else this.byEndpoint.set(endpoint, [provider]);
      }
      for (const model of provider.models) {
        const wireId = model.modelId.trim();
        if (!wireId) continue;
        const entry: IndexedModel<M> = { providerKey: provider.providerKey, model };
        addToBucket(index.exact, wireId, entry);
        addToBucket(index.folded, normalizedModelId(wireId), entry);
        addToBucket(this.byGlobalId, normalizedModelId(wireId), entry);
        const canonical = model.canonicalModelId?.trim();
        if (canonical) {
          addToBucket(this.byCanonicalId, normalizedModelId(canonical), entry);
          const basename = canonicalBasename(canonical);
          if (basename) addToBucket(this.byCanonicalBasename, basename, entry);
        }
      }
    }
  }

  /**
   * Publisher identity for a configured row.
   *
   * Exact normalized endpoint match wins. When that endpoint is shared, only
   * the exact configured key can disambiguate it. When no published endpoint
   * responds, only an exact configured key identifies a publisher, and an
   * exact endpoint naming a different publisher is never overridden by a key.
   */
  resolvePublisher(input: { vendorKey?: string; baseUrl?: string }): PublisherResolution<M> {
    const key = normalizedProviderKey(input.vendorKey);
    const keyed = key ? this.providers.get(key) : undefined;
    const endpoint = normalizedApiUrl(input.baseUrl);
    const endpointProviders = endpoint ? this.byEndpoint.get(endpoint) : undefined;
    if (endpointProviders && endpointProviders.length > 0) {
      if (endpointProviders.length === 1) {
        const provider = endpointProviders[0];
        if (keyed && keyed !== provider) {
          return {
            state: "ambiguous",
            candidates: [keyed.providerKey, provider.providerKey],
          };
        }
        return {
          state: "matched",
          method: keyed ? "explicit-key-and-exact-endpoint" : "exact-endpoint",
          provider,
        };
      }
      if (keyed && endpointProviders.includes(keyed)) {
        return {
          state: "matched",
          method: "explicit-key-and-exact-endpoint",
          provider: keyed,
        };
      }
      return {
        state: "ambiguous",
        candidates: endpointProviders.map((provider) => provider.providerKey),
      };
    }
    if (keyed) {
      // No published endpoint answered. The configured key is the only explicit
      // identity left; it is never used to contradict a published endpoint.
      return { state: "matched", method: "explicit-key", provider: keyed };
    }
    return { state: "unmatched" };
  }

  /** Deterministic resolution of one wire id for one configured row. */
  resolve(input: ModelResolutionInput): ModelResolution<M> {
    const requestedRaw = input.modelId.trim();
    const requested = normalizedModelId(requestedRaw);
    if (!requested) {
      return { state: "unmatched", publisher: { state: "unmatched" } };
    }
    const publisher = this.resolvePublisher(input);
    if (publisher.state === "ambiguous") {
      return { state: "ambiguous", publisher, ...this.provenanceFields(input) };
    }
    if (publisher.state === "matched" && publisher.provider) {
      const scoped = this.resolveInPublisher(publisher.provider, requestedRaw, requested, input);
      if (scoped) return { ...scoped, publisher, ...this.provenanceFields(input) };
      return { state: "unmatched", publisher, ...this.provenanceFields(input) };
    }
    const canonical = this.resolveCanonicalGlobal(requestedRaw, requested, input);
    if (canonical) return { ...canonical, publisher, ...this.provenanceFields(input) };
    return { state: "unmatched", publisher, ...this.provenanceFields(input) };
  }

  private provenanceFields(input: ModelResolutionInput): {
    fetchedAt?: string;
    endpointFetchedAt?: string;
  } {
    return {
      ...(this.fetchedAt ? { fetchedAt: this.fetchedAt } : {}),
      ...(input.endpointFetchedAt ? { endpointFetchedAt: input.endpointFetchedAt } : {}),
    };
  }

  /**
   * Endpoint-serving resolution inside the endpoint's own publisher. The
   * publisher's records are the only capacity facts; no other publisher is
   * consulted, so a negative answer stays a negative answer. Exact raw wire
   * id wins, then the unambiguous casefold, then a canonical id the endpoint
   * source explicitly declared. A canonical reference the catalog merely
   * publishes is not endpoint-scoped evidence and is not consulted here.
   */
  private resolveInPublisher(
    provider: ResolvableProvider<M>,
    requestedRaw: string,
    requested: string,
    input: ModelResolutionInput,
  ): ModelResolution<M> | undefined {
    const index = this.providerIndexes.get(provider.providerKey);
    if (!index) return undefined;
    const exact = index.exact.get(requestedRaw);
    if (exact?.length === 1) {
      return this.endpointMatch(provider, exact[0], "publisher-exact-id");
    }
    if (exact && exact.length > 1) {
      return this.ambiguousModel(exact, provider);
    }
    const folded = index.folded.get(requested);
    if (folded?.length === 1) {
      return this.endpointMatch(provider, folded[0], "publisher-exact-id-casefold");
    }
    if (folded && folded.length > 1) {
      return this.ambiguousModel(folded, provider);
    }
    const declared = input.declaredCanonicalModelId
      ? normalizedModelId(input.declaredCanonicalModelId)
      : undefined;
    if (!declared) return undefined;
    const declaredMatches = provider.models.filter(
      (model) => model.canonicalModelId !== undefined &&
        normalizedModelId(model.canonicalModelId) === declared,
    );
    if (declaredMatches.length === 1) {
      return this.endpointMatch(
        provider,
        { providerKey: provider.providerKey, model: declaredMatches[0] },
        "declared-canonical-id",
      );
    }
    if (declaredMatches.length > 1) {
      return this.ambiguousModel(
        declaredMatches.map((model) => ({ providerKey: provider.providerKey, model })),
        provider,
      );
    }
    return undefined;
  }

  private endpointMatch(
    provider: ResolvableProvider<M>,
    entry: IndexedModel<M>,
    method: ModelResolutionMethod,
  ): ModelResolution<M> {
    return {
      state: "matched",
      method,
      domain: "endpoint",
      publisher: { state: "matched", provider },
      value: entry.model,
      source: {
        providerKey: entry.providerKey,
        ...(provider.api ? { url: provider.api } : {}),
        modelId: entry.model.modelId,
      },
    };
  }

  private ambiguousModel(
    entries: readonly IndexedModel<M>[],
    provider?: ResolvableProvider<M>,
  ): ModelResolution<M> {
    return {
      state: "ambiguous",
      publisher: provider
        ? { state: "matched", provider }
        : { state: "unmatched" },
      candidates: candidatesOf(entries),
    };
  }

  /**
   * Canonical reference (never endpoint capacity) for a row no publisher owns.
   * Explicit declared canonical id, exact global wire id (case-sensitive
   * first), exact canonical id, then a globally unique canonical basename.
   * Case-colliding candidates are ambiguous. These results carry
   * `domain: "canonical"` and claim no publisher.
   */
  private resolveCanonicalGlobal(
    requestedRaw: string,
    requested: string,
    input: ModelResolutionInput,
  ): ModelResolution<M> | undefined {
    const declared = input.declaredCanonicalModelId
      ? this.byCanonicalId.get(normalizedModelId(input.declaredCanonicalModelId))
      : undefined;
    if (declared?.length === 1) return this.canonicalMatch(declared[0], "declared-canonical-id");
    if (declared && declared.length > 1) return this.ambiguousGlobal(declared);

    const exact = this.byGlobalId.get(requested);
    if (exact && exact.length > 0) {
      const caseSensitive = exact.filter((entry) => entry.model.modelId.trim() === requestedRaw);
      if (caseSensitive.length === 1) {
        return this.canonicalMatch(caseSensitive[0], "global-exact-id");
      }
      if (caseSensitive.length === 0 && exact.length === 1) {
        return this.canonicalMatch(exact[0], "global-exact-id-casefold");
      }
      return this.ambiguousGlobal(exact);
    }

    const canonical = this.byCanonicalId.get(requested);
    if (canonical?.length === 1) return this.canonicalMatch(canonical[0], "canonical-exact-id");
    if (canonical && canonical.length > 1) return this.ambiguousGlobal(canonical);

    const basename = canonicalBasename(requestedRaw);
    const basenameMatches = basename ? this.byCanonicalBasename.get(basename) : undefined;
    if (basenameMatches?.length === 1) {
      return this.canonicalMatch(basenameMatches[0], "canonical-unique-basename");
    }
    if (basenameMatches && basenameMatches.length > 1) {
      return this.ambiguousGlobal(basenameMatches);
    }
    return undefined;
  }

  private canonicalMatch(
    entry: IndexedModel<M>,
    method: ModelResolutionMethod,
  ): ModelResolution<M> {
    const provider = this.providers.get(entry.providerKey);
    return {
      state: "matched",
      method,
      domain: "canonical",
      // The canonical record's owner is not the configured endpoint's publisher.
      publisher: { state: "unmatched" },
      value: entry.model,
      source: {
        providerKey: entry.providerKey,
        ...(provider?.api ? { url: provider.api } : {}),
        modelId: entry.model.modelId,
      },
    };
  }

  private ambiguousGlobal(entries: readonly IndexedModel<M>[]): ModelResolution<M> {
    return this.ambiguousModel(entries);
  }
}
