import type { ServiceErrorT, ServiceNameT } from "../contract.js";

/** A sanitized upstream failure. Messages never contain URLs, headers, or keys. */
export class ArrError extends Error {
  constructor(
    readonly service: ServiceNameT,
    readonly code: ServiceErrorT["code"],
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ArrError";
  }

  toJSON(): ServiceErrorT {
    return { service: this.service, code: this.code, message: this.message.slice(0, 400) };
  }
}

export function toServiceError(service: ServiceNameT, error: unknown): ServiceErrorT {
  if (error instanceof ArrError) return error.toJSON();
  return { service, code: "upstream_error", message: `${label(service)} request failed unexpectedly.` };
}

export const label = (service: ServiceNameT) => (service === "sonarr" ? "Sonarr" : "Radarr");

export type ArrClient = {
  readonly service: ServiceNameT;
  readonly configured: boolean;
  /** Absolute link to a page in the service's web UI. */
  webUrl: (path: string) => string;
  /** GET /api/v3{path} as JSON. */
  json: <T>(path: string, options?: { timeoutMs?: number; allowStatus?: number[] }) => Promise<T>;
  /** GET an arbitrary API path and return the raw response (artwork). */
  raw: (path: string, options?: { timeoutMs?: number }) => Promise<Response>;
};

/** `getApiKey` is called per request so the key is never retained beyond the current invocation. */
export function createArrClient(service: ServiceNameT, baseUrl: string, getApiKey: () => string | undefined): ArrClient {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const name = label(service);

  const request = async (path: string, timeoutMs: number, accept: string) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new ArrError(service, "not_configured", `${name} is not configured: set plugins.entries.media-storage.config.${service}.apiKey to a SecretRef.`);
    }
    const url = new URL(path.replace(/^\//, ""), base);
    try {
      return await fetch(url, {
        headers: { "X-Api-Key": apiKey, Accept: accept },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ArrError(
        service,
        timeout ? "timeout" : "unreachable",
        timeout ? `${name} did not respond within ${Math.round(timeoutMs / 1000)} seconds.` : `${name} could not be reached at ${base.host}.`,
      );
    }
  };

  const checkStatus = (response: Response) => {
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) {
      throw new ArrError(service, "unauthorized", `${name} rejected the API key (HTTP ${response.status}).`, response.status);
    }
    if (response.status === 404) throw new ArrError(service, "not_found", `${name} has no such item.`, 404);
    throw new ArrError(service, "upstream_error", `${name} returned HTTP ${response.status}.`, response.status);
  };

  return {
    service,
    webUrl: (path: string) => new URL(path, base).toString(),
    get configured() {
      return Boolean(getApiKey());
    },
    async json<T>(path: string, options: { timeoutMs?: number } = {}) {
      const response = await request(`api/v3${path}`, options.timeoutMs ?? 20_000, "application/json");
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        checkStatus(response);
      }
      try {
        return (await response.json()) as T;
      } catch {
        throw new ArrError(service, "bad_response", `${name} returned a response that was not valid JSON.`);
      }
    },
    async raw(path: string, options: { timeoutMs?: number } = {}) {
      return request(path, options.timeoutMs ?? 15_000, "image/*");
    },
  };
}

/** Run tasks with bounded concurrency so a full-library scan never hammers the API. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Short-lived cache with in-flight de-duplication. */
export class TtlCache {
  private readonly entries = new Map<string, { expires: number; value: Promise<unknown> }>();

  constructor(private readonly maxEntries = 256) {}

  get<T>(key: string, ttlMs: number, load: () => Promise<T>, force = false): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && !force && hit.expires > now) return hit.value as Promise<T>;
    const value = load();
    this.entries.set(key, { expires: now + ttlMs, value });
    // Failures are not cached.
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return value;
  }

  peek<T>(key: string): Promise<T> | undefined {
    const hit = this.entries.get(key);
    return hit && hit.expires > Date.now() ? (hit.value as Promise<T>) : undefined;
  }

  clear(prefix?: string) {
    if (!prefix) return this.entries.clear();
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.entries.delete(key);
  }
}
