/**
 * Bounded, conditional HTTP acquisition for the public models.dev document.
 *
 * This module performs one request and one bounded read of the decoded body.
 * Cache lifetime, single-flight, and last-known-good retention live in
 * `models-dev-acquisition.ts`; the in-memory catalog consumes the result.
 *
 * The response is evidence that may be huge, malformed, or absent. The bound
 * is enforced while the streamed body is decoded, because `Content-Length` is
 * optional and describes the transferred (possibly compressed) length.
 */

export const MODELS_DEV_SOURCE_URL = "https://models.dev/api.json";
/**
 * Named bound for one canonical metadata document. Raise it only when a
 * measured legitimate source exceeds it, never speculatively.
 */
export const MODELS_DEV_MAX_DECODED_BYTES = 16 * 1024 * 1024;
/** Timing bound for one acquisition attempt. */
export const MODELS_DEV_SOURCE_TIMEOUT_MS = 15_000;
/** Freshness window for a validated disk-cache entry. */
export const MODELS_DEV_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** HTTP validators that make a revalidation request conditional. */
export type ModelsDevSourceValidator = {
  etag?: string;
  lastModified?: string;
};

export type ModelsDevSourceResult =
  /** The source returned a new document; `body` is parsed JSON only. */
  | { kind: "document"; body: unknown; validator: ModelsDevSourceValidator }
  /** The source confirmed the conditional request is still current. */
  | { kind: "not-modified"; validator: ModelsDevSourceValidator };

export type ModelsDevSourceFailure = "aborted" | "malformed" | "network" | "oversize" | "status" | "timeout";

export class ModelsDevSourceError extends Error {
  readonly failure: ModelsDevSourceFailure;

  constructor(failure: ModelsDevSourceFailure, message: string) {
    super(message);
    this.name = "ModelsDevSourceError";
    this.failure = failure;
  }
}

export type ModelsDevSourceRequest = {
  /**
   * Fetch port. When omitted the ambient `fetch` is resolved per request so
   * the Electron main proxy patch (`net.fetch`) applies to this request.
   */
  fetchImpl?: typeof fetch;
  url?: string;
  /** Sent as `If-None-Match` / `If-Modified-Since` when cached data is usable. */
  validator?: ModelsDevSourceValidator;
  timeoutMs?: number;
  maxBytes?: number;
  /** Disposal signal; aborting it cancels the request and the body read. */
  signal?: AbortSignal;
};

function headerOrUndefined(response: Response, name: string): string | undefined {
  const value = response.headers.get(name)?.trim();
  return value ? value : undefined;
}

/** Read the body with a decoded-size cap, streaming even without a length header. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ModelsDevSourceError(
        "oversize",
        `models.dev catalog response exceeded the ${maxBytes}-byte cap`,
      );
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ModelsDevSourceError(
          "oversize",
          `models.dev catalog response exceeded the ${maxBytes}-byte cap`,
        );
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

/** One acquisition attempt against the canonical public source. */
export async function fetchModelsDevDocument(
  request: ModelsDevSourceRequest = {},
): Promise<ModelsDevSourceResult> {
  const timeoutMs = request.timeoutMs ?? MODELS_DEV_SOURCE_TIMEOUT_MS;
  const maxBytes = request.maxBytes ?? MODELS_DEV_MAX_DECODED_BYTES;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));
  const onOuterAbort = () => controller.abort();
  if (request.signal?.aborted) controller.abort();
  else request.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const validator = request.validator;
  try {
    const doFetch: typeof fetch =
      request.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    const headers: Record<string, string> = { Accept: "application/json" };
    if (validator?.etag) headers["If-None-Match"] = validator.etag;
    if (validator?.lastModified) headers["If-Modified-Since"] = validator.lastModified;
    // Public metadata is anonymous: never send cookies or stored credentials.
    const response = await doFetch(request.url ?? MODELS_DEV_SOURCE_URL, {
      headers,
      signal: controller.signal,
      credentials: "omit",
    });
    if (response.status === 304) {
      if (!validator?.etag && !validator?.lastModified) {
        throw new ModelsDevSourceError(
          "status",
          "models.dev answered 304 to an unconditional request",
        );
      }
      return {
        kind: "not-modified",
        validator: {
          etag: headerOrUndefined(response, "etag") ?? validator.etag,
          lastModified: headerOrUndefined(response, "last-modified") ?? validator.lastModified,
        },
      };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ModelsDevSourceError(
        "status",
        `models.dev catalog request failed (${response.status})`,
      );
    }
    const text = await readBoundedText(response, maxBytes);
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new ModelsDevSourceError("malformed", "models.dev catalog response was not valid JSON");
    }
    const responseEtag = headerOrUndefined(response, "etag");
    const responseLastModified = headerOrUndefined(response, "last-modified");
    return {
      kind: "document",
      body,
      validator: {
        ...(responseEtag ? { etag: responseEtag } : {}),
        ...(responseLastModified ? { lastModified: responseLastModified } : {}),
      },
    };
  } catch (error) {
    if (timedOut) {
      throw new ModelsDevSourceError(
        "timeout",
        `models.dev catalog request timed out after ${timeoutMs} ms`,
      );
    }
    if (request.signal?.aborted) {
      throw new ModelsDevSourceError("aborted", "models.dev catalog request was cancelled");
    }
    if (error instanceof ModelsDevSourceError) throw error;
    throw new ModelsDevSourceError("network", String(error));
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onOuterAbort);
  }
}
