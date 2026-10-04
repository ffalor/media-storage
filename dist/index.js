import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { getToolPluginMetadata, toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";
import { contract, LIBRARY_PAGE } from "./contract.js";
import { CONFIG_JSON_SCHEMA, resolveService } from "./config.js";
import { createArrClient } from "./backend/arr.js";
import { ART_ROUTE, Artwork } from "./backend/artwork.js";
import { createMediaService } from "./backend/service.js";
const entry = defineFeaturePlugin({
    contract,
    name: "Media Storage",
    description: "Read-only storage analysis for Sonarr and Radarr libraries with a native Control UI page.",
    setup(api, events) {
        // apiKey values arrive already resolved from their SecretRefs; they never enter logs or responses.
        const sonarrConfig = resolveService(api.pluginConfig, "sonarr");
        const radarrConfig = resolveService(api.pluginConfig, "radarr");
        const sonarr = createArrClient("sonarr", sonarrConfig.url, sonarrConfig.apiKey);
        const radarr = createArrClient("radarr", radarrConfig.url, radarrConfig.apiKey);
        const art = new Artwork({ sonarr, radarr }, [sonarrConfig.apiKey, radarrConfig.apiKey]);
        const media = createMediaService({
            sonarr,
            radarr,
            art,
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
        if (!sonarrConfig.apiKey)
            api.logger.warn("media-storage: sonarr.apiKey is not configured; TV data will be unavailable.");
        if (!radarrConfig.apiKey)
            api.logger.warn("media-storage: radarr.apiKey is not configured; movie data will be unavailable.");
        // Build both library snapshots as soon as the Gateway starts so the first view is instant.
        api.registerService({
            id: "media-storage:warm",
            start() {
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
