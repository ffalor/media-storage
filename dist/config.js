/**
 * Plugin config (`plugins.entries.media-storage.config`).
 *
 * `apiKey` fields are declared as `configContracts.secretInputs` in the manifest, so they
 * should hold a SecretRef (for example `{ source: "store", provider: "default", id: "SONARR_API_KEY" }`).
 * The Gateway resolves the ref at runtime and redacts it in Settings; the plugin only ever
 * receives the resolved string in `api.pluginConfig`.
 */
const secretRef = {
    type: "object",
    required: ["source", "id"],
    additionalProperties: false,
    properties: {
        source: { type: "string", enum: ["env", "file", "exec", "store"] },
        provider: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
        id: { type: "string", minLength: 1, maxLength: 256 },
    },
};
const service = (name, defaultUrl) => ({
    type: "object",
    additionalProperties: false,
    properties: {
        url: { type: "string", default: defaultUrl, description: `${name} base URL.` },
        apiKey: {
            description: `${name} API key as a SecretRef (recommended: a protected entry in Settings → Secrets).`,
            anyOf: [{ type: "string", minLength: 1, maxLength: 512 }, secretRef],
        },
    },
});
export const DEFAULT_SONARR_URL = "http://localhost:8989/";
export const DEFAULT_RADARR_URL = "http://localhost:7878/";
export const CONFIG_JSON_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        sonarr: service("Sonarr", DEFAULT_SONARR_URL),
        radarr: service("Radarr", DEFAULT_RADARR_URL),
    },
};
function httpUrl(value, fallback) {
    if (typeof value !== "string" || !value.trim())
        return fallback;
    try {
        const url = new URL(value.trim());
        return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : fallback;
    }
    catch {
        return fallback;
    }
}
/** Read resolved config. Unresolved SecretRef objects are treated as missing, never as keys. */
export function resolveService(config, name) {
    const section = config?.[name];
    const record = section && typeof section === "object" ? section : {};
    const apiKey = typeof record.apiKey === "string" && record.apiKey.trim() ? record.apiKey.trim() : undefined;
    return { url: httpUrl(record.url, name === "sonarr" ? DEFAULT_SONARR_URL : DEFAULT_RADARR_URL), apiKey };
}
