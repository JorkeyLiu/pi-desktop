/**
 * Versioned on-disk cache for the canonical models.dev metadata document.
 *
 * Electron main owns this file under the desktop data directory; SQLite is
 * never involved because this is regenerable public metadata, not user state.
 * Reads are validated before use, writes are atomic (`tmp` + `rename`), and an
 * unusable file is quarantined instead of silently replaced.
 *
 * The envelope is versioned separately from the payload: bumping
 * `MODELS_DEV_CACHE_VERSION` discards computed metadata only. User bindings,
 * credentials, and provider configs live elsewhere and are never touched.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Bump only to invalidate cached canonical metadata. */
export const MODELS_DEV_CACHE_VERSION = 1;
export const MODELS_DEV_CACHE_FILE_NAME = "models-dev-v1.json";

/**
 * Cache location inside the desktop data directory. The `model-metadata`
 * folder is owned by this cache alone.
 */
export function modelsDevCachePath(dataDir: string): string {
  return join(dataDir, "model-metadata", MODELS_DEV_CACHE_FILE_NAME);
}

export type ModelsDevCacheValidator = {
  etag?: string;
  lastModified?: string;
};

export type ModelsDevCacheEntry = {
  /** ISO timestamp of the source fetch that produced `payload`. */
  fetchedAt: string;
  validator?: ModelsDevCacheValidator;
  /** Raw parsed source document; re-validated on every read. */
  payload: unknown;
};

export type ModelsDevCacheRead =
  | { kind: "ok"; entry: ModelsDevCacheEntry }
  | { kind: "absent" }
  | { kind: "invalid"; reason: string };

export type ModelsDevCacheLog = (
  level: "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
) => void;

export type ModelsDevCache = {
  readonly filePath: string;
  read(): Promise<ModelsDevCacheRead>;
  /** Persist a validated entry atomically. */
  write(entry: ModelsDevCacheEntry): Promise<void>;
};

export type ModelsDevCacheOptions = {
  filePath: string;
  /** Canonical source this cache is keyed to; a mismatch invalidates it. */
  sourceUrl: string;
  /** Provider count for the parsed payload; throws or returns 0 when unusable. */
  validatePayload: (payload: unknown) => number;
  now?: () => number;
  log?: ModelsDevCacheLog;
};

type SerializedEnvelope = {
  version?: unknown;
  sourceUrl?: unknown;
  fetchedAt?: unknown;
  validator?: unknown;
  payload?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseValidator(value: unknown): ModelsDevCacheValidator | undefined {
  if (!isRecord(value)) return undefined;
  const etag = typeof value.etag === "string" && value.etag.trim() ? value.etag.trim() : undefined;
  const lastModified =
    typeof value.lastModified === "string" && value.lastModified.trim()
      ? value.lastModified.trim()
      : undefined;
  if (!etag && !lastModified) return undefined;
  return { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) };
}

function fileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

export function createModelsDevCache(options: ModelsDevCacheOptions): ModelsDevCache {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => Date.now());
  const filePath = options.filePath;
  const sourceUrl = options.sourceUrl;

  /** Preserve unusable bytes beside the cache so the failure stays diagnosable. */
  const quarantine = async (reason: string): Promise<void> => {
    const destination = `${filePath}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`;
    try {
      await rename(filePath, destination);
      log("warn", `quarantined unusable models.dev cache (${reason})`, { quarantine: destination });
    } catch (error) {
      // The cache is disposable metadata; failing to move it aside must not
      // take down the catalog, and the next successful write replaces it.
      log("warn", "models.dev cache could not be quarantined", {
        file: filePath,
        error: String(error),
      });
    }
  };

  const read = async (): Promise<ModelsDevCacheRead> => {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (fileNotFound(error)) return { kind: "absent" };
      log("error", "models.dev cache read failed", { file: filePath, error: String(error) });
      return { kind: "invalid", reason: "cache file could not be read" };
    }
    let envelope: SerializedEnvelope;
    try {
      envelope = JSON.parse(raw) as SerializedEnvelope;
    } catch {
      await quarantine("malformed JSON");
      return { kind: "invalid", reason: "cache file was not valid JSON" };
    }
    if (!isRecord(envelope)) {
      await quarantine("malformed envelope");
      return { kind: "invalid", reason: "cache envelope was not an object" };
    }
    if (envelope.version !== MODELS_DEV_CACHE_VERSION) {
      await quarantine(`cache version ${String(envelope.version)}`);
      return {
        kind: "invalid",
        reason: `cache version ${String(envelope.version)} is not ${MODELS_DEV_CACHE_VERSION}`,
      };
    }
    if (typeof envelope.sourceUrl !== "string" || envelope.sourceUrl !== sourceUrl) {
      await quarantine("source url mismatch");
      return { kind: "invalid", reason: "cache belongs to a different source url" };
    }
    const fetchedAt = typeof envelope.fetchedAt === "string" ? envelope.fetchedAt : "";
    if (!fetchedAt || Number.isNaN(Date.parse(fetchedAt))) {
      await quarantine("missing fetchedAt");
      return { kind: "invalid", reason: "cache has no usable fetchedAt" };
    }
    let providerCount: number;
    try {
      providerCount = options.validatePayload(envelope.payload);
    } catch (error) {
      await quarantine("schema rejected");
      return {
        kind: "invalid",
        reason: `cache payload failed validation: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!(providerCount > 0)) {
      await quarantine("no providers");
      return { kind: "invalid", reason: "cache payload contained no usable providers" };
    }
    const validator = parseValidator(envelope.validator);
    return {
      kind: "ok",
      entry: { fetchedAt, ...(validator ? { validator } : {}), payload: envelope.payload },
    };
  };

  const write = async (entry: ModelsDevCacheEntry): Promise<void> => {
    const envelope: SerializedEnvelope = {
      version: MODELS_DEV_CACHE_VERSION,
      sourceUrl,
      fetchedAt: entry.fetchedAt,
      ...(entry.validator ? { validator: entry.validator } : {}),
      payload: entry.payload,
    };
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
    // atomic replace: a crash leaves either the previous cache or the new one
    await rename(tmp, filePath);
  };

  return { filePath, read, write };
}
