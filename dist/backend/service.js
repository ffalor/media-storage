import { SEASON_FILES_PAGE, TOP_MAX } from "../contract.js";
import { ArrError, mapLimit, toServiceError, TtlCache } from "./arr.js";
import { toWatch } from "./tautulli.js";
// ---- Helpers -----------------------------------------------------------------------------
/** Library snapshots older than this are served immediately and rebuilt in the background. */
export const STALE_AFTER = 10 * 60_000;
const DETAIL_TTL = 5 * 60_000;
const STATUS_TTL = 60_000;
const str = (value, max = 512) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const int = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
const image = (images, type) => images?.find((entry) => entry.coverType === type);
const fileName = (path) => (path ? (path.split(/[\\/]/).pop() ?? null) : null);
const seasonLabel = (n) => (n === 0 ? "Specials" : `Season ${n}`);
const nowIso = () => new Date().toISOString();
function runtimeSeconds(value) {
    if (!value)
        return 0;
    const parts = value.split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part)))
        return 0;
    return Math.round(parts.reduce((total, part) => total * 60 + part, 0));
}
function channels(value) {
    if (!value)
        return "";
    return Number.isInteger(value) ? `${value}.0` : String(value);
}
export function mediaSpec(quality, info) {
    const audio = [str(info?.audioCodec, 48), channels(info?.audioChannels)].filter(Boolean).join(" ");
    return {
        quality: str(quality?.quality?.name, 64),
        resolution: str(info?.resolution, 32),
        resolutionClass: int(quality?.quality?.resolution),
        videoCodec: str(info?.videoCodec, 64),
        dynamicRange: str(info?.videoDynamicRangeType, 64) ?? str(info?.videoDynamicRange, 64),
        bitDepth: int(info?.videoBitDepth),
        videoBitrate: int(info?.videoBitrate),
        audio: audio || null,
        audioLanguages: str(info?.audioLanguages, 256),
        subtitles: str(info?.subtitles, 256),
        runtime: str(info?.runTime, 32),
        runtimeSeconds: runtimeSeconds(info?.runTime),
    };
}
const fail = (service, error) => ({ ok: false, error: toServiceError(service, error) });
/**
 * Stale-while-revalidate holder for a library snapshot. The first load (or a forced one) is
 * awaited; afterwards callers get the last snapshot instantly, and a stale snapshot triggers a
 * single background rebuild whose completion is announced through onRefreshed.
 */
class Snapshot {
    load;
    onRefreshed;
    value;
    at = 0;
    pending;
    constructor(load, onRefreshed) {
        this.load = load;
        this.onRefreshed = onRefreshed;
    }
    run() {
        this.pending ??= this.load()
            .then((value) => {
            this.value = value;
            this.at = Date.now();
            return value;
        })
            .finally(() => {
            this.pending = undefined;
        });
        return this.pending;
    }
    get(force = false) {
        if (force || this.value === undefined)
            return this.run();
        if (!this.pending && Date.now() - this.at > STALE_AFTER) {
            this.run().then(this.onRefreshed, () => { });
        }
        return Promise.resolve(this.value);
    }
    /** Build in the background; failures are left for the next request to report. */
    warm() {
        return this.run().then(() => { }, () => { });
    }
}
export function createMediaService(deps) {
    const { sonarr, radarr, art } = deps;
    const cache = new TtlCache(512);
    let generationCounter = 0;
    const nextGeneration = () => `${Date.now().toString(36)}-${(++generationCounter).toString(36)}`;
    /** Unique episode files for a series, isolating corrupt Sonarr records instead of failing the series. */
    async function seriesFiles(seriesId, episodes) {
        try {
            return { files: await sonarr.json(`/episodefile?seriesId=${seriesId}`), unreadable: [] };
        }
        catch (error) {
            if (!(error instanceof ArrError) || error.code !== "upstream_error")
                throw error;
            // Sonarr returns HTTP 500 for the whole series when one stored file record is corrupt.
            // Fetch the referenced files individually so only the broken record is affected.
            const eps = episodes ?? (await sonarr.json(`/episode?seriesId=${seriesId}`));
            const ids = [...new Set(eps.map((episode) => episode.episodeFileId).filter((id) => int(id) > 0))];
            const unreadable = [];
            const files = (await mapLimit(ids, 4, async (id) => {
                try {
                    return await sonarr.json(`/episodefile/${id}`);
                }
                catch (inner) {
                    if (inner instanceof ArrError && (inner.code === "upstream_error" || inner.code === "not_found")) {
                        unreadable.push(id);
                        return null;
                    }
                    throw inner;
                }
            })).filter((file) => file !== null);
            if (unreadable.length)
                deps.logger?.warn(`media-storage: Sonarr series ${seriesId} has ${unreadable.length} unreadable episode-file record(s).`);
            return { files, unreadable };
        }
    }
    async function loadTvLibrary() {
        {
            const series = await sonarr.json("/series", { timeoutMs: 30_000 });
            // Count unique files per series. Sonarr's statistics.episodeFileCount counts episodes
            // with files, which double-counts multi-episode files, so it is not used for counts.
            const scans = await mapLimit(series, 6, async (entry) => {
                if (!int(entry.statistics?.episodeFileCount) && !int(entry.statistics?.sizeOnDisk))
                    return { fileCount: 0, sizeBytes: 0 };
                const { files, unreadable } = await seriesFiles(entry.id);
                const readable = files.reduce((total, file) => total + int(file.size), 0);
                return {
                    fileCount: files.length + unreadable.length,
                    // With unreadable records the exact byte total comes from Sonarr's per-series
                    // statistics, which Sonarr computes from the same unique file rows.
                    sizeBytes: unreadable.length ? Math.max(int(entry.statistics?.sizeOnDisk), readable) : readable,
                };
            });
            const backdrops = new Map();
            const items = series.map((entry, index) => {
                backdrops.set(entry.id, art.cover("sonarr", image(entry.images, "fanart"), "fanart"));
                return {
                    id: entry.id,
                    title: str(entry.title) ?? `Series ${entry.id}`,
                    year: int(entry.year),
                    sizeBytes: scans[index].sizeBytes,
                    seasonCount: int(entry.statistics?.seasonCount),
                    fileCount: scans[index].fileCount,
                    status: str(entry.status, 32) ?? "unknown",
                    network: str(entry.network, 128),
                    poster: art.cover("sonarr", image(entry.images, "poster"), "poster-500"),
                    watch: null,
                };
            });
            items.sort((a, b) => b.sizeBytes - a.sizeBytes || a.title.localeCompare(b.title));
            return {
                generation: nextGeneration(),
                retrievedAt: nowIso(),
                items,
                backdrops,
                sizeBytes: items.reduce((total, item) => total + item.sizeBytes, 0),
                fileCount: items.reduce((total, item) => total + item.fileCount, 0),
            };
        }
    }
    async function loadMovieLibrary() {
        {
            const movies = await radarr.json("/movie", { timeoutMs: 30_000 });
            const backdrops = new Map();
            const items = movies.map((movie) => {
                backdrops.set(movie.id, art.cover("radarr", image(movie.images, "fanart"), "fanart"));
                const file = movie.movieFile;
                return {
                    id: movie.id,
                    title: str(movie.title) ?? `Movie ${movie.id}`,
                    year: int(movie.year),
                    sizeBytes: file ? int(file.size) : 0,
                    hasFile: Boolean(file),
                    quality: str(file?.quality?.quality?.name, 64),
                    resolution: int(file?.quality?.quality?.resolution),
                    videoCodec: str(file?.mediaInfo?.videoCodec, 64),
                    poster: art.cover("radarr", image(movie.images, "poster"), "poster-500"),
                    watch: null,
                };
            });
            items.sort((a, b) => b.sizeBytes - a.sizeBytes || a.title.localeCompare(b.title));
            return {
                generation: nextGeneration(),
                retrievedAt: nowIso(),
                items,
                backdrops,
                sizeBytes: items.reduce((total, item) => total + item.sizeBytes, 0),
                fileCount: items.filter((item) => item.hasFile).length,
            };
        }
    }
    const tvSnapshot = new Snapshot(loadTvLibrary, () => deps.onLibraryUpdated?.({ library: "tv", retrievedAt: nowIso() }));
    const movieSnapshot = new Snapshot(loadMovieLibrary, () => deps.onLibraryUpdated?.({ library: "movies", retrievedAt: nowIso() }));
    const tvLibrary = (force = false) => tvSnapshot.get(force);
    const movieLibrary = (force = false) => movieSnapshot.get(force);
    /** Attach Tautulli play counts to library items. Watch data is looked up per read so it refreshes independently. */
    async function withWatch(kind, items) {
        const index = await deps.watch?.index();
        if (!index)
            return items;
        const lookup = index[kind];
        return items.map((item) => ({ ...item, watch: toWatch(lookup(item.title, item.year)) }));
    }
    function status(client, force) {
        return cache.get(`status:${client.service}`, STATUS_TTL, async () => {
            try {
                const [system, health] = await Promise.all([
                    client.json("/system/status", { timeoutMs: 10_000 }),
                    client.json("/health", { timeoutMs: 10_000 }).catch(() => []),
                ]);
                const expected = client.service === "sonarr" ? "Sonarr" : "Radarr";
                if (system.appName !== expected) {
                    throw new ArrError(client.service, "bad_response", `The configured ${expected} URL answered as ${str(system.appName, 32) ?? "an unknown service"}.`);
                }
                return { service: client.service, state: "ok", version: str(system.version, 64), healthIssues: Array.isArray(health) ? health.length : 0, error: null };
            }
            catch (error) {
                return { service: client.service, state: "error", version: null, healthIssues: 0, error: toServiceError(client.service, error) };
            }
        }, force);
    }
    // Sonarr and Radarr route their web pages by titleSlug (Radarr's slug is the TMDB id).
    const seriesWebUrl = (series) => series.titleSlug ? sonarr.webUrl(`series/${encodeURIComponent(series.titleSlug)}`) : null;
    function seriesBundle(seriesId) {
        return cache.get(`tv:series:${seriesId}`, DETAIL_TTL, async () => {
            const [series, episodes] = await Promise.all([
                sonarr.json(`/series/${seriesId}`),
                sonarr.json(`/episode?seriesId=${seriesId}&includeImages=true`, { timeoutMs: 30_000 }),
            ]);
            const { files, unreadable } = await seriesFiles(seriesId, episodes);
            return { retrievedAt: nowIso(), series, files, episodes, unreadable };
        });
    }
    /** Per-season unique file accounting. Unreadable files get bytes derived from season statistics. */
    function seasonAccounting(bundle, seasonNumber) {
        const season = bundle.series.seasons?.find((entry) => entry.seasonNumber === seasonNumber);
        const files = bundle.files.filter((file) => file.seasonNumber === seasonNumber);
        const readableBytes = files.reduce((total, file) => total + int(file.size), 0);
        const episodesByFile = new Map();
        for (const episode of bundle.episodes) {
            const id = int(episode.episodeFileId);
            if (id)
                episodesByFile.set(id, [...(episodesByFile.get(id) ?? []), episode]);
        }
        const unreadable = bundle.unreadable.filter((id) => (episodesByFile.get(id) ?? []).some((episode) => episode.seasonNumber === seasonNumber));
        const statBytes = int(season?.statistics?.sizeOnDisk);
        const sizeBytes = unreadable.length ? Math.max(statBytes, readableBytes) : readableBytes;
        const missing = sizeBytes - readableBytes;
        const derived = new Map();
        unreadable.forEach((id, index) => {
            const share = Math.floor(missing / unreadable.length);
            derived.set(id, index === 0 ? missing - share * (unreadable.length - 1) : share);
        });
        return { season, files, unreadable, derived, sizeBytes, episodesByFile };
    }
    function still(episodes) {
        for (const episode of episodes) {
            const url = art.remote(image(episode.images, "screenshot")?.remoteUrl);
            if (url)
                return url;
        }
        return null;
    }
    return {
        /** Build both library snapshots (Gateway startup). */
        warm() {
            return Promise.all([tvSnapshot.warm(), movieSnapshot.warm(), status(sonarr, false), status(radarr, false)]);
        },
        async overview(refresh) {
            if (refresh)
                cache.clear();
            const [sonarrStatus, radarrStatus, tv, movies, index] = await Promise.all([
                status(sonarr, refresh),
                status(radarr, refresh),
                tvLibrary(refresh).then((value) => ({ ok: true, value }), (error) => fail("sonarr", error)),
                movieLibrary(refresh).then((value) => ({ ok: true, value }), (error) => fail("radarr", error)),
                // Load the Tautulli index alongside the libraries; failures resolve to null.
                deps.watch?.index(refresh) ?? Promise.resolve(null),
            ]);
            const totals = (state, lib, countFiles, kind) => {
                const library = lib.ok ? lib.value : null;
                const effective = lib.ok || state.state === "error" ? state : { ...state, state: "error", error: lib.error };
                const top = (library?.items ?? [])
                    .filter((item) => item.sizeBytes > 0)
                    .slice(0, TOP_MAX)
                    .map((item) => ({
                    id: item.id,
                    title: item.title,
                    year: item.year,
                    sizeBytes: item.sizeBytes,
                    poster: item.poster,
                    backdrop: library?.backdrops.get(item.id) ?? null,
                    watch: index ? toWatch(index[kind](item.title, item.year)) : null,
                }));
                return {
                    status: effective,
                    sizeBytes: library?.sizeBytes ?? 0,
                    itemCount: library?.items.length ?? 0,
                    fileCount: countFiles ? (library?.fileCount ?? 0) : 0,
                    largest: top[0] ?? null,
                    top,
                };
            };
            const tvTotals = totals(sonarrStatus, tv, true, "tv");
            const movieTotals = totals(radarrStatus, movies, true, "movies");
            // Reuses the index loaded above; reports Tautulli's own failure without affecting storage data.
            const watch = deps.watch
                ? await deps.watch.overview({ tv: tv.ok ? tv.value.items : null, movies: movies.ok ? movies.value.items : null })
                : null;
            // Report the age of the oldest snapshot shown, not the time of this request.
            const stamps = [tv, movies].flatMap((lib) => (lib.ok ? [lib.value.retrievedAt] : []));
            return {
                ok: true,
                retrievedAt: stamps.sort()[0] ?? nowIso(),
                tv: tvTotals,
                movies: movieTotals,
                combinedBytes: tvTotals.sizeBytes + movieTotals.sizeBytes,
                complete: tv.ok && movies.ok,
                watch,
            };
        },
        async seriesPage(input) {
            try {
                const library = await tvLibrary();
                if (input.generation && input.generation !== library.generation) {
                    return { ok: false, error: { service: "sonarr", code: "stale", message: "The TV library changed; reload from the first page." } };
                }
                return {
                    ok: true,
                    generation: library.generation,
                    retrievedAt: library.retrievedAt,
                    total: library.items.length,
                    offset: input.offset,
                    items: await withWatch("tv", library.items.slice(input.offset, input.offset + input.limit)),
                };
            }
            catch (error) {
                return fail("sonarr", error);
            }
        },
        async moviesPage(input) {
            try {
                const library = await movieLibrary();
                if (input.generation && input.generation !== library.generation) {
                    return { ok: false, error: { service: "radarr", code: "stale", message: "The movie library changed; reload from the first page." } };
                }
                return {
                    ok: true,
                    generation: library.generation,
                    retrievedAt: library.retrievedAt,
                    total: library.items.length,
                    offset: input.offset,
                    items: await withWatch("movies", library.items.slice(input.offset, input.offset + input.limit)),
                };
            }
            catch (error) {
                return fail("radarr", error);
            }
        },
        async seriesDetail(seriesId) {
            try {
                const bundle = await seriesBundle(seriesId);
                const { series } = bundle;
                const seasons = (series.seasons ?? [])
                    .map((season) => {
                    const account = seasonAccounting(bundle, season.seasonNumber);
                    const episodes = bundle.episodes
                        .filter((episode) => episode.seasonNumber === season.seasonNumber)
                        .sort((a, b) => a.episodeNumber - b.episodeNumber);
                    return {
                        seasonNumber: season.seasonNumber,
                        label: seasonLabel(season.seasonNumber),
                        sizeBytes: account.sizeBytes,
                        fileCount: account.files.length + account.unreadable.length,
                        episodeFileCount: episodes.filter((episode) => int(episode.episodeFileId) > 0).length,
                        totalEpisodes: episodes.length,
                        monitored: Boolean(season.monitored),
                        artwork: still(episodes.filter((episode) => episode.hasFile)) ?? still(episodes),
                        unreadableFiles: account.unreadable.length,
                    };
                })
                    // Seasons that exist but have nothing on disk still render; Specials last.
                    .sort((a, b) => (a.seasonNumber === 0 ? 1 : b.seasonNumber === 0 ? -1 : a.seasonNumber - b.seasonNumber));
                return {
                    ok: true,
                    retrievedAt: bundle.retrievedAt,
                    id: series.id,
                    title: str(series.title) ?? `Series ${series.id}`,
                    year: int(series.year),
                    overview: str(series.overview, 4000),
                    network: str(series.network, 128),
                    status: str(series.status, 32) ?? "unknown",
                    genres: (series.genres ?? []).slice(0, 8).map((genre) => genre.slice(0, 64)),
                    runtime: int(series.runtime),
                    certification: str(series.certification, 32),
                    path: str(series.path, 1024),
                    sizeBytes: seasons.reduce((total, season) => total + season.sizeBytes, 0),
                    fileCount: seasons.reduce((total, season) => total + season.fileCount, 0),
                    seasonCount: seasons.filter((season) => season.seasonNumber > 0).length,
                    poster: art.cover("sonarr", image(series.images, "poster"), "poster-500"),
                    backdrop: art.cover("sonarr", image(series.images, "fanart"), "fanart"),
                    webUrl: seriesWebUrl(series),
                    seasons,
                };
            }
            catch (error) {
                return fail("sonarr", error);
            }
        },
        async seasonFiles(seriesId, seasonNumber, offset = 0) {
            try {
                const bundle = await seriesBundle(seriesId);
                const account = seasonAccounting(bundle, seasonNumber);
                if (!account.season && account.files.length === 0) {
                    throw new ArrError("sonarr", "not_found", `This series has no ${seasonLabel(seasonNumber).toLowerCase()}.`, 404);
                }
                const episodesOf = (id) => (account.episodesByFile.get(id) ?? []).slice().sort((a, b) => a.episodeNumber - b.episodeNumber);
                const toEpisodes = (episodes) => episodes.slice(0, 50).map((episode) => ({
                    number: episode.episodeNumber,
                    title: str(episode.title) ?? "TBA",
                    airDate: str(episode.airDate, 32),
                }));
                const files = [
                    ...account.files.map((file) => {
                        const episodes = episodesOf(file.id);
                        return {
                            id: file.id,
                            episodes: toEpisodes(episodes),
                            still: still(episodes),
                            fileName: fileName(file.relativePath ?? file.path),
                            path: str(file.path, 2048),
                            sizeBytes: int(file.size),
                            sizeDerived: false,
                            releaseGroup: str(file.releaseGroup, 128),
                            dateAdded: str(file.dateAdded, 40),
                            spec: mediaSpec(file.quality, file.mediaInfo),
                        };
                    }),
                    ...account.unreadable.map((id) => {
                        const episodes = episodesOf(id);
                        return {
                            id,
                            episodes: toEpisodes(episodes),
                            still: still(episodes),
                            fileName: null,
                            path: null,
                            sizeBytes: account.derived.get(id) ?? 0,
                            sizeDerived: true,
                            releaseGroup: null,
                            dateAdded: null,
                            spec: mediaSpec(undefined, undefined),
                        };
                    }),
                ].sort((a, b) => b.sizeBytes - a.sizeBytes || (a.episodes[0]?.number ?? 0) - (b.episodes[0]?.number ?? 0));
                return {
                    ok: true,
                    retrievedAt: bundle.retrievedAt,
                    seriesId,
                    seriesTitle: str(bundle.series.title) ?? `Series ${seriesId}`,
                    seasonNumber,
                    label: seasonLabel(seasonNumber),
                    sizeBytes: account.sizeBytes,
                    total: files.length,
                    offset,
                    files: files.slice(offset, offset + SEASON_FILES_PAGE),
                    backdrop: art.cover("sonarr", image(bundle.series.images, "fanart"), "fanart"),
                    webUrl: seriesWebUrl(bundle.series),
                };
            }
            catch (error) {
                return fail("sonarr", error);
            }
        },
        async watchDetail(kind, id) {
            try {
                if (!deps.watch?.configured())
                    return notConfigured();
                // Match on the Sonarr/Radarr title: from the snapshot when present, otherwise the item itself.
                const library = kind === "series" ? await tvLibrary() : await movieLibrary();
                let item = library.items.find((entry) => entry.id === id);
                if (!item) {
                    const raw = kind === "series" ? await sonarr.json(`/series/${id}`) : await radarr.json(`/movie/${id}`);
                    item = { title: str(raw.title) ?? "", year: int(raw.year) };
                }
                return await deps.watch.detail(kind, item);
            }
            catch (error) {
                return fail(error instanceof ArrError ? error.service : "tautulli", error);
            }
        },
        async movieDetail(movieId) {
            try {
                const movie = await cache.get(`movies:movie:${movieId}`, DETAIL_TTL, () => radarr.json(`/movie/${movieId}`));
                const file = movie.movieFile;
                return {
                    ok: true,
                    retrievedAt: nowIso(),
                    id: movie.id,
                    title: str(movie.title) ?? `Movie ${movie.id}`,
                    year: int(movie.year),
                    overview: str(movie.overview, 4000),
                    studio: str(movie.studio, 128),
                    genres: (movie.genres ?? []).slice(0, 8).map((genre) => genre.slice(0, 64)),
                    certification: str(movie.certification, 32),
                    runtimeMinutes: int(movie.runtime),
                    status: str(movie.status, 32) ?? "unknown",
                    hasFile: Boolean(file),
                    webUrl: movie.titleSlug ? radarr.webUrl(`movie/${encodeURIComponent(movie.titleSlug)}`) : null,
                    sizeBytes: file ? int(file.size) : 0,
                    poster: art.cover("radarr", image(movie.images, "poster"), "poster-500"),
                    backdrop: art.cover("radarr", image(movie.images, "fanart"), "fanart"),
                    file: file
                        ? {
                            id: file.id,
                            fileName: fileName(file.relativePath ?? file.path),
                            path: str(file.path, 2048),
                            sizeBytes: int(file.size),
                            dateAdded: str(file.dateAdded, 40),
                            releaseGroup: str(file.releaseGroup, 128),
                            edition: str(file.edition, 128),
                            spec: mediaSpec(file.quality, file.mediaInfo),
                        }
                        : null,
                };
            }
            catch (error) {
                return fail("radarr", error);
            }
        },
    };
}
const notConfigured = () => ({ ok: true, state: "not_configured", webUrl: null, plays: 0, seconds: 0, windows: [], users: [], seasons: [], recent: [] });
