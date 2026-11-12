/**
 * Source service for canonical models.dev metadata.
 *
 * Owns the acquisition policy around one source: local-first load (versioned
 * disk cache, then the bundled release snapshot), conditional refresh with a
 * freshness window, single-flight deduplication, last-known-good retention,
 * and disposal of in-flight network work. The in-memory catalog consumes the
 * results; it does not own disk or network state.
 *
 * Provenance (`source`, `fetchedAt`, staleness) is exposed here rather than in
 * the public catalog status so consumers can be migrated deliberately.
 */

import { readFile } from "node:fs/promises";
import {
  MODELS_DEV_CACHE_TTL_MS,
  MODELS_DEV_SOURCE_TIMEOUT_MS,
  MODELS_DEV_SOURCE_URL,
  ModelsDevSourceError,
  fetchModelsDevDocument,
  type ModelsDevSourceValidator,
} from "./models-dev-source.ts";
import {
  createModelsDevCache,
  type ModelsDevCache,
  type ModelsDevCacheLog,
} from "./models-dev-cache.ts";

/** What the catalog needs from a parsed provider; nothing else is assumed. */
export type ModelsDevProviderLike = {
  readonly providerKey: string;
  readonly models: readonly unknown[];
};

export type ModelsDevLocalSnapshot<TProvider extends ModelsDevProviderLike> = {
  providers: readonly TProvider[];
  /** Disk cache or release snapshot; never a live network response. */
  source: "cache" | "bundled";
  /** Source fetch time of the payload, when the origin records one. */
  fetchedAt?: string;
};

export type ModelsDevRefreshOutcome<TProvider extends ModelsDevProviderLike> =
  | {
      status: "updated";
      providers: readonly TProvider[];
      fetchedAt: string;
      validator?: ModelsDevSourceValidator;
    }
  | { status: "not-modified"; checkedAt: number }
  | { status: "failed"; error: string };

export type ModelsDevProvenance = {
  source: "cache" | "bundled" | "remote" | "empty";
  fetchedAt?: string;
  /** Epoch ms of the last successful source confirmation. */
  checkedAt?: number;
  status: "fresh" | "stale" | "unknown";
  validator?: ModelsDevSourceValidator;
};

export type ModelsDevAcquisitionOptions<TProvider extends ModelsDevProviderLike> = {
  /** Checked-in/release-packaged api.json; bootstrap fallback only. */
  catalogPath: string;
  /** Versioned disk cache path; omitted disables disk persistence entirely. */
  cachePath?: string;
  /** Fetch port; the ambient (proxy-aware) fetch is used when omitted. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => number;
  parse: (raw: unknown) => TProvider[];
  log?: ModelsDevCacheLog;
};

export class ModelsDevAcquisition<TProvider extends ModelsDevProviderLike> {
  private readonly cache: ModelsDevCache | undefined;
  private readonly parse: (raw: unknown) => TProvider[];
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly timeoutMs: number;
  private readonly maxBytes: number | undefined;
  private readonly now: () => number;
  private readonly catalogPath: string;
  private readonly log: ModelsDevCacheLog | undefined;
  private localAttempted = false;
  private localPromise: Promise<ModelsDevLocalSnapshot<TProvider> | undefined> | undefined;
  private localSnapshot: ModelsDevLocalSnapshot<TProvider> | undefined;
  private refreshPromise: Promise<ModelsDevRefreshOutcome<TProvider>> | undefined;
  private controller: AbortController | undefined;
  private validator: ModelsDevSourceValidator | undefined;
  /** Epoch ms when the current payload was last confirmed against the source. */
  private checkedAt = 0;
  private origin: ModelsDevProvenance["source"] = "empty";
  private disposed = false;

  constructor(options: ModelsDevAcquisitionOptions<TProvider>) {
    const cacheOptions = options.cachePath
      ? {
          filePath: options.cachePath,
          sourceUrl: MODELS_DEV_SOURCE_URL,
          validatePayload: (payload: unknown) => options.parse(payload).length,
          ...(options.now ? { now: options.now } : {}),
          ...(options.log ? { log: options.log } : {}),
        }
      : undefined;
    this.cache = cacheOptions ? createModelsDevCache(cacheOptions) : undefined;
    this.parse = options.parse;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? MODELS_DEV_SOURCE_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.catalogPath = options.catalogPath;
    this.log = options.log;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Load the best already-local payload: a schema-valid disk cache wins, the
   * bundled release snapshot is the bootstrap fallback. Never performs network
   * I/O and is attempted once per process.
   */
  async loadLocal(): Promise<ModelsDevLocalSnapshot<TProvider> | undefined> {
    if (this.localPromise) return this.localPromise;
    if (this.localAttempted) return this.localSnapshot;
    this.localAttempted = true;
    this.localPromise = (async () => {
      const cached = await this.loadCached();
      const snapshot = cached ?? (await this.loadBundled());
      this.localSnapshot = snapshot;
      this.origin = snapshot.source;
      this.checkedAt = snapshot.source === "cache" ? Date.parse(snapshot.fetchedAt ?? "") || 0 : 0;
      return snapshot;
    })();
    try {
      return await this.localPromise;
    } finally {
      this.localPromise = undefined;
    }
  }

  /** True when the current payload is outside the freshness window or unconfirmed. */
  shouldRevalidate(): boolean {
    if (!this.cache || this.disposed) return false;
    return this.checkedAt === 0 || this.now() - this.checkedAt >= MODELS_DEV_CACHE_TTL_MS;
  }

  /**
   * One conditional refresh, deduplicated across concurrent callers. Failure
   * leaves the current payload untouched; a `304` is only honored when a
   * usable payload and validator are already present.
   */
  async refresh(): Promise<ModelsDevRefreshOutcome<TProvider>> {
    if (this.refreshPromise) return this.refreshPromise;
    if (this.disposed) {
      return { status: "failed", error: "models.dev metadata service is disposed" };
    }
    const controller = new AbortController();
    this.controller = controller;
    this.refreshPromise = (async (): Promise<ModelsDevRefreshOutcome<TProvider>> => {
      const usable = this.localSnapshot !== undefined;
      try {
        const result = await fetchModelsDevDocument({
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
          ...(usable && this.validator ? { validator: this.validator } : {}),
          timeoutMs: this.timeoutMs,
          ...(this.maxBytes ? { maxBytes: this.maxBytes } : {}),
          signal: controller.signal,
        });
        if (result.kind === "not-modified") {
          if (!usable) {
            throw new ModelsDevSourceError(
              "status",
              "models.dev reported an unchanged document with no usable cached payload",
            );
          }
          this.validator = result.validator.etag || result.validator.lastModified
            ? result.validator
            : this.validator;
          this.checkedAt = this.now();
          return { status: "not-modified", checkedAt: this.checkedAt };
        }
        // Validate at the boundary before anything is published or persisted.
        const providers = this.parse(result.body);
        if (providers.length === 0) {
          throw new Error("models.dev catalog contained no usable providers");
        }
        const fetchedAt = new Date(this.now()).toISOString();
        const validator = result.validator;
        await this.persist({ fetchedAt, ...(validator ? { validator } : {}), payload: result.body });
        this.localSnapshot = {
          providers,
          source: "cache",
          fetchedAt,
        };
        this.validator = validator;
        this.checkedAt = this.now();
        this.origin = "remote";
        return {
          status: "updated",
          providers,
          fetchedAt,
          ...(validator ? { validator } : {}),
        };
      } catch (error) {
        return { status: "failed", error: error instanceof Error ? error.message : String(error) };
      } finally {
        this.controller = undefined;
      }
    })();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  /** Internal provenance for later resolver/consumer work; not a public contract yet. */
  provenance(): ModelsDevProvenance {
    const status: ModelsDevProvenance["status"] =
      this.checkedAt === 0
        ? "unknown"
        : this.now() - this.checkedAt >= MODELS_DEV_CACHE_TTL_MS
          ? "stale"
          : "fresh";
    return {
      source: this.origin,
      ...(this.localSnapshot?.fetchedAt ? { fetchedAt: this.localSnapshot.fetchedAt } : {}),
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      status,
      ...(this.validator ? { validator: this.validator } : {}),
    };
  }

  /** Abort in-flight work; the service is terminal after this call. */
  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    this.controller = undefined;
  }

  private async loadCached(): Promise<ModelsDevLocalSnapshot<TProvider> | undefined> {
    if (!this.cache) return undefined;
    const read = await this.cache.read();
    if (read.kind !== "ok") return undefined;
    let providers: TProvider[];
    try {
      providers = this.parse(read.entry.payload);
    } catch {
      return undefined;
    }
    if (providers.length === 0) return undefined;
    this.validator = read.entry.validator;
    return {
      providers,
      source: "cache",
      fetchedAt: read.entry.fetchedAt,
    };
  }

  private async loadBundled(): Promise<ModelsDevLocalSnapshot<TProvider>> {
    const raw = JSON.parse(await readFile(this.catalogPath, "utf8")) as unknown;
    const providers = this.parse(raw);
    if (providers.length === 0) throw new Error("models.dev snapshot contained no providers");
    return { providers, source: "bundled" };
  }

  private async persist(entry: {
    fetchedAt: string;
    validator?: ModelsDevSourceValidator;
    payload: unknown;
  }): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.write(entry);
    } catch (error) {
      // The refreshed payload is already valid in memory; a disk failure must
      // not degrade this process to the bundled snapshot.
      this.log?.("warn", "models.dev cache write failed", { error: String(error) });
    }
  }
}
