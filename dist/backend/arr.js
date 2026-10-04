/** A sanitized upstream failure. Messages never contain URLs, headers, or keys. */
export class ArrError extends Error {
    service;
    code;
    status;
    constructor(service, code, message, status) {
        super(message);
        this.service = service;
        this.code = code;
        this.status = status;
        this.name = "ArrError";
    }
    toJSON() {
        return { service: this.service, code: this.code, message: this.message.slice(0, 400) };
    }
}
export function toServiceError(service, error) {
    if (error instanceof ArrError)
        return error.toJSON();
    return { service, code: "upstream_error", message: `${label(service)} request failed unexpectedly.` };
}
export const label = (service) => (service === "sonarr" ? "Sonarr" : "Radarr");
export function createArrClient(service, baseUrl, apiKey) {
    const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    const name = label(service);
    const request = async (path, timeoutMs, accept) => {
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
        }
        catch (error) {
            const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
            throw new ArrError(service, timeout ? "timeout" : "unreachable", timeout ? `${name} did not respond within ${Math.round(timeoutMs / 1000)} seconds.` : `${name} could not be reached at ${base.host}.`);
        }
    };
    const checkStatus = (response) => {
        if (response.ok)
            return;
        if (response.status === 401 || response.status === 403) {
            throw new ArrError(service, "unauthorized", `${name} rejected the API key (HTTP ${response.status}).`, response.status);
        }
        if (response.status === 404)
            throw new ArrError(service, "not_found", `${name} has no such item.`, 404);
        throw new ArrError(service, "upstream_error", `${name} returned HTTP ${response.status}.`, response.status);
    };
    return {
        service,
        configured: Boolean(apiKey),
        async json(path, options = {}) {
            const response = await request(`api/v3${path}`, options.timeoutMs ?? 20_000, "application/json");
            if (!response.ok) {
                await response.body?.cancel().catch(() => { });
                checkStatus(response);
            }
            try {
                return (await response.json());
            }
            catch {
                throw new ArrError(service, "bad_response", `${name} returned a response that was not valid JSON.`);
            }
        },
        async raw(path, options = {}) {
            return request(path, options.timeoutMs ?? 15_000, "image/*");
        },
    };
}
/** Run tasks with bounded concurrency so a full-library scan never hammers the API. */
export async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            out[index] = await fn(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}
/** Short-lived cache with in-flight de-duplication. */
export class TtlCache {
    maxEntries;
    entries = new Map();
    constructor(maxEntries = 256) {
        this.maxEntries = maxEntries;
    }
    get(key, ttlMs, load, force = false) {
        const now = Date.now();
        const hit = this.entries.get(key);
        if (hit && !force && hit.expires > now)
            return hit.value;
        const value = load();
        this.entries.set(key, { expires: now + ttlMs, value });
        // Failures are not cached.
        value.catch(() => {
            if (this.entries.get(key)?.value === value)
                this.entries.delete(key);
        });
        if (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined)
                this.entries.delete(oldest);
        }
        return value;
    }
    peek(key) {
        const hit = this.entries.get(key);
        return hit && hit.expires > Date.now() ? hit.value : undefined;
    }
    clear(prefix) {
        if (!prefix)
            return this.entries.clear();
        for (const key of [...this.entries.keys()])
            if (key.startsWith(prefix))
                this.entries.delete(key);
    }
}
