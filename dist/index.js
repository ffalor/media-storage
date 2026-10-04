import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { getToolPluginMetadata, toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";
import { contract, LIBRARY_PAGE } from "./contract.js";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { CONFIG_JSON_SCHEMA, resolveServiceUrl } from "./config.js";
import { createArrClient } from "./backend/arr.js";
import { ART_ROUTE, Artwork } from "./backend/artwork.js";
import { createMediaService } from "./backend/service.js";
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
        const art = new Artwork({ sonarr, radarr });
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
