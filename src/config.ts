/**
 * Plugin config (`plugins.entries.media-storage.config`).
 *
 * `apiKey` fields are declared as `configContracts.secretInputs` in the manifest and must hold a
 * SecretRef (for example `{ source: "store", provider: "default", id: "SONARR_API_KEY" }`). The
 * plugin reads the resolved key per request with `getPreparedPluginSecretInput` and never keeps it.
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
} as const;

const service = (name: string, defaultUrl: string) =>
  ({
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", default: defaultUrl, description: `${name} base URL.` },
      apiKey: {
        description: `${name} API key as a SecretRef (for example a protected entry in Settings → Secrets).`,
        ...secretRef,
      },
    },
  }) as const;

export const DEFAULT_SONARR_URL = "http://localhost:8989/";
export const DEFAULT_RADARR_URL = "http://localhost:7878/";
export const DEFAULT_TAUTULLI_URL = "http://localhost:8181/";
export const DEFAULT_SEERR_URL = "http://localhost:5055/";

/** References written into config on first start when no `apiKey` is set. */
export const DEFAULT_KEY_REFS = {
  sonarr: { source: "store", provider: "default", id: "SONARR_API_KEY" },
  radarr: { source: "store", provider: "default", id: "RADARR_API_KEY" },
  tautulli: { source: "store", provider: "default", id: "TAUTULLI_API_KEY" },
  seerr: { source: "store", provider: "default", id: "SEERR_API_KEY" },
} as const;

export const CONFIG_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sonarr: service("Sonarr", DEFAULT_SONARR_URL),
    radarr: service("Radarr", DEFAULT_RADARR_URL),
    // Optional: watch stats are shown only when tautulli.apiKey resolves to a value.
    tautulli: service("Tautulli", DEFAULT_TAUTULLI_URL),
    // Optional: request info is shown only when seerr.apiKey resolves to a value.
    seerr: service("Seerr", DEFAULT_SEERR_URL),
  },
};

function httpUrl(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

/** Read the service URL from plugin config. API keys are not read here; see `getPreparedPluginSecretInput`. */
export function resolveServiceUrl(config: Record<string, unknown> | undefined, name: "sonarr" | "radarr" | "tautulli" | "seerr"): string {
  const section = config?.[name];
  const record = section && typeof section === "object" ? (section as Record<string, unknown>) : {};
  const fallback = { sonarr: DEFAULT_SONARR_URL, radarr: DEFAULT_RADARR_URL, tautulli: DEFAULT_TAUTULLI_URL, seerr: DEFAULT_SEERR_URL }[name];
  return httpUrl(record.url, fallback);
}
