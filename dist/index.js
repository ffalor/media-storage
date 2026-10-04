import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { getToolPluginMetadata, toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";
import { contract, LIBRARY_PAGE } from "./contract.js";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { CONFIG_JSON_SCHEMA, DEFAULT_KEY_REFS, resolveServiceUrl } from "./config.js";
import { createArrClient } from "./backend/arr.js";
import { ART_ROUTE, Artwork } from "./backend/artwork.js";
import { createMediaService } from "./backend/service.js";
import { createTautulliClient, createWatchService } from "./backend/tautulli.js";
import { createRequestService, createSeerrClient } from "./backend/seerr.js";
const PLUGIN_ID = "media-storage";
const entry = defineFeaturePlugin({
    contract,
    name: "Media Storage",
    description: "Read-only storage analysis for Sonarr and Radarr libraries with a native Control UI page.",
    setup(api, events) {
        // API keys are read from the prepared secrets snapshot on every request and never retained,
        // so a reload or failed secret makes them unavailable immediately. They never enter logs or responses.
        const apiKey = (service) => () => getPreparedPluginSecretInput(PLUGIN_ID, `${service}.apiKey`).value;
        const sonarr = createArrClient("sonarr", resolveServiceUrl(api.pluginConfig, "sonarr"), apiKey("sonarr"));
        const radarr = createArrClient("radarr", resolveServiceUrl(api.pluginConfig, "radarr"), apiKey("radarr"));
        const tautulli = createTautulliClient(resolveServiceUrl(api.pluginConfig, "tautulli"), apiKey("tautulli"));
        const art = new Artwork({ sonarr, radarr });
        const media = createMediaService({
            sonarr,
            radarr,
            art,
            watch: createWatchService(tautulli),
            requests: createRequestService(createSeerrClient(resolveServiceUrl(api.pluginConfig, "seerr"), apiKey("seerr"))),
            logger: api.logger,
            onLibraryUpdated: (update) => {
                try {
                    events.emit("library-updated", update);
                }
                catch {
                    // Event transport not started yet; clients pick up the snapshot on their next read.
                }
            },
        });
        // Schema defaults are display-only and the Gateway resolves only SecretRefs saved in config, so
        // write the default references once when none are set. Users then only create the secrets.
        const missingKeyRefs = ["sonarr", "radarr", "tautulli", "seerr"].filter((service) => {
            const section = api.pluginConfig?.[service];
            return !(section && typeof section === "object" && "apiKey" in section);
        });
        const seedKeyRefs = () => api.runtime.config.mutateConfigFile({
            afterWrite: { mode: "auto" },
            mutate(draft) {
                const entries = ((draft.plugins ??= {}).entries ??= {});
                const config = ((entries[PLUGIN_ID] ??= {}).config ??= {});
                for (const service of missingKeyRefs) {
                    const section = (config[service] ??= {});
                    section.apiKey ??= { ...DEFAULT_KEY_REFS[service] };
                }
            },
        });
        // Build both library snapshots as soon as the Gateway starts so the first view is instant.
        api.registerService({
            id: "media-storage:warm",
            start() {
                if (missingKeyRefs.length > 0) {
                    seedKeyRefs().then(() => api.logger.info(`media-storage: set default API key references for ${missingKeyRefs.join(", ")}.`), (error) => api.logger.warn(`media-storage: could not set default API key references: ${String(error)}`));
                    return; // The config write reloads the plugin; the next instance warms up.
                }
                void media.warm();
            },
        });
        api.registerHttpRoute({ path: ART_ROUTE, match: "prefix", auth: "plugin", handler: art.handle });
        const clampLimit = (limit) => Math.min(limit, LIBRARY_PAGE);
        return {
            overview: ({ refresh }) => media.overview(Boolean(refresh)),
            series: (input) => media.seriesPage({ ...input, limit: clampLimit(input.limit) }),
            "series-detail": ({ seriesId }) => media.seriesDetail(seriesId),
            "season-files": ({ seriesId, seasonNumber, offset }) => media.seasonFiles(seriesId, seasonNumber, offset ?? 0),
            movies: (input) => media.moviesPage({ ...input, limit: clampLimit(input.limit) }),
            "movie-detail": ({ movieId }) => media.movieDetail(movieId),
            "watch-detail": ({ kind, id }) => media.watchDetail(kind, id),
            "request-detail": ({ kind, id }) => media.requestDetail(kind, id),
        };
    },
});
// defineFeaturePlugin takes no config option; publish the plugin's config schema so both the
// runtime and `openclaw plugins build` (which generates the manifest's configSchema) use it.
const metadata = getToolPluginMetadata(entry);
const plugin = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    register: entry.register,
    configSchema: buildJsonPluginConfigSchema(CONFIG_JSON_SCHEMA),
};
if (metadata) {
    Object.defineProperty(plugin, toolPluginMetadataSymbol, { value: { ...metadata, configSchema: CONFIG_JSON_SCHEMA }, enumerable: false });
}
export default plugin;
