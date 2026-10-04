import { ArrError, TtlCache } from "./arr.js";
/**
 * Optional Seerr (Overseerr/Jellyseerr) integration: who requested what. Requests are matched to
 * Sonarr/Radarr items by TVDB/TMDB id. Pending and declined requests are ignored.
 */
const INDEX_TTL = 10 * 60_000;
const PAGE = 100;
/** Seerr MediaRequestStatus values that never led to files. */
const PENDING = 1;
const DECLINED = 3;
/** `getApiKey` is called per request so the key is never retained. */
export function createSeerrClient(baseUrl, getApiKey) {
    const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    return {
        webUrl: (path) => new URL(path, base).toString(),
        get configured() {
            return Boolean(getApiKey());
        },
        async json(path, options = {}) {
            const apiKey = getApiKey();
            if (!apiKey)
                throw new ArrError("seerr", "not_configured", "Seerr is not configured.");
            const timeoutMs = options.timeoutMs ?? 15_000;
            let response;
            try {
                response = await fetch(new URL(`api/v1${path}`, base), {
                    headers: { "X-Api-Key": apiKey, Accept: "application/json" },
                    redirect: "error",
                    signal: AbortSignal.timeout(timeoutMs),
                });
            }
            catch (error) {
                const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
                throw new ArrError("seerr", timeout ? "timeout" : "unreachable", timeout ? `Seerr did not respond within ${Math.round(timeoutMs / 1000)} seconds.` : `Seerr could not be reached at ${base.host}.`);
            }
            if (!response.ok) {
                await response.body?.cancel().catch(() => { });
                if (response.status === 401 || response.status === 403) {
                    throw new ArrError("seerr", "unauthorized", `Seerr rejected the API key (HTTP ${response.status}).`, response.status);
                }
                throw new ArrError("seerr", "upstream_error", `Seerr returned HTTP ${response.status}.`, response.status);
            }
            try {
                return (await response.json());
            }
            catch {
                throw new ArrError("seerr", "bad_response", "Seerr returned a response that was not valid JSON.");
            }
        },
    };
}
const positive = (value) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0);
const userName = (user) => [user?.displayName, user?.plexUsername, user?.username].find((name) => typeof name === "string" && name.trim() !== "")?.trim().slice(0, 128) ?? "Unknown";
export function createRequestService(seerr) {
    const cache = new TtlCache(16);
    let lastError = null;
    async function loadIndex() {
        // Short timeout first: an unreachable Seerr should not hold up the overview.
        const status = await seerr.json("/status", { timeoutMs: 6_000 });
        const index = { version: typeof status.version === "string" ? status.version.slice(0, 64) : null, tvByTvdb: new Map(), tvByTmdb: new Map(), movies: new Map() };
        const add = (map, id, request) => {
            if (id)
                map.set(id, [...(map.get(id) ?? []), request]);
        };
        for (let skip = 0; skip < 100_000; skip += PAGE) {
            const page = await seerr.json(`/request?take=${PAGE}&skip=${skip}&filter=all&sort=added`, { timeoutMs: 30_000 });
            const rows = page.results ?? [];
            for (const row of rows) {
                if (row.status === PENDING || row.status === DECLINED)
                    continue;
                const request = {
                    user: userName(row.requestedBy),
                    at: typeof row.createdAt === "string" ? row.createdAt.slice(0, 40) : new Date(0).toISOString(),
                    tmdbId: positive(row.media?.tmdbId),
                    seasons: (row.seasons ?? []).map((season) => season.seasonNumber).filter((n) => typeof n === "number" && n >= 0),
                };
                if (row.type === "tv") {
                    add(index.tvByTvdb, positive(row.media?.tvdbId), request);
                    if (!positive(row.media?.tvdbId))
                        add(index.tvByTmdb, request.tmdbId, request);
                }
                else if (row.type === "movie")
                    add(index.movies, request.tmdbId, request);
            }
            if (rows.length < PAGE || skip + PAGE >= (page.pageInfo?.results ?? 0))
                break;
        }
        // Oldest first: the first requester of a title or season is the one it is attributed to.
        for (const map of [index.tvByTvdb, index.tvByTmdb, index.movies])
            for (const list of map.values())
                list.sort((a, b) => a.at.localeCompare(b.at));
        return index;
    }
    /** The cached index, or null when unconfigured or failing (see `error`). */
    const index = (force = false) => seerr.configured
        ? cache.get("index", INDEX_TTL, loadIndex, force).then((value) => {
            lastError = null;
            return value;
        }, (error) => {
            lastError = error;
            return null;
        })
        : Promise.resolve(null);
    return {
        configured: () => seerr.configured,
        index,
        error: () => lastError,
        seriesRequests: (idx, ids) => (ids.tvdbId ? idx.tvByTvdb.get(ids.tvdbId) : undefined) ?? (ids.tmdbId ? idx.tvByTmdb.get(ids.tmdbId) : undefined) ?? [],
        movieRequests: (idx, tmdbId) => (tmdbId ? (idx.movies.get(tmdbId) ?? []) : []),
        webUrl: (kind, tmdbId) => (tmdbId ? seerr.webUrl(`${kind}/${tmdbId}`) : null),
    };
}
/** Distinct requester names, oldest request first. */
export const requesters = (requests) => [...new Set(requests.map((request) => request.user))];
/**
 * First request that names a season. Seasons no request names (added later by Sonarr monitoring)
 * belong to the series' first requester. Null when the series has no accepted request.
 */
export const seasonRequester = (requests, seasonNumber) => requests.find((request) => request.seasons.includes(seasonNumber)) ?? requests[0] ?? null;
