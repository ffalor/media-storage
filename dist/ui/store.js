import { LIBRARY_PAGE, } from "../contract.js";
const DETAIL_TTL = 3 * 60_000;
/** Turn transport failures into a displayable error without leaking internals. */
function transportError(service, error) {
    const text = error instanceof Error ? error.message : "";
    const offline = /disconnect|not connected|closed/i.test(text);
    return {
        service,
        code: "upstream_error",
        message: offline ? "The Gateway connection is unavailable. Reconnect and retry." : "The Media Storage backend did not answer. Retry in a moment.",
    };
}
/**
 * Client-side state. Library listings are loaded once (paged) and filtered/sorted locally;
 * detail views load on demand and are cached briefly. Refresh bypasses every cache.
 */
export class Store {
    client;
    overview = { status: "idle" };
    series = { status: "idle" };
    movies = { status: "idle" };
    seriesDetail = new Map();
    seasonFiles = new Map();
    movieDetail = new Map();
    refreshing = false;
    /** UI preferences that survive navigation within the page. */
    prefs = { tvQuery: "", tvSort: "size-desc", movieQuery: "", movieSort: "size-desc", fileSort: "size", topCount: readTopCount() };
    epoch = 0;
    disposed = false;
    listeners = new Set();
    constructor(client) {
        this.client = client;
    }
    /** Re-read snapshots after the backend finishes a background rebuild. */
    watchUpdates() {
        let timer;
        const off = this.client.on("library-updated", () => {
            clearTimeout(timer);
            // TV and movie rebuilds finish separately; coalesce them into one re-read.
            timer = setTimeout(() => {
                if (!this.disposed && !this.refreshing)
                    void this.load(false);
            }, 1500);
        });
        return () => {
            clearTimeout(timer);
            off();
        };
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    dispose() {
        this.disposed = true;
        this.listeners.clear();
    }
    emit() {
        if (this.disposed)
            return;
        for (const listener of this.listeners)
            listener();
    }
    /** Load the overview and both library summaries. */
    async load(refresh = false) {
        const epoch = ++this.epoch;
        const live = () => !this.disposed && epoch === this.epoch;
        if (refresh) {
            this.refreshing = true;
            this.seriesDetail.clear();
            this.seasonFiles.clear();
            this.movieDetail.clear();
        }
        this.overview = { status: "loading", data: "data" in this.overview ? this.overview.data : undefined };
        if (this.series.status !== "ready" || refresh)
            this.series = { status: "loading", data: "data" in this.series ? this.series.data : undefined };
        if (this.movies.status !== "ready" || refresh)
            this.movies = { status: "loading", data: "data" in this.movies ? this.movies.data : undefined };
        this.emit();
        const overview = this.client.invoke("overview", refresh ? { refresh: true } : {}).then((data) => {
            if (!live())
                return;
            this.overview = { status: "ready", data, at: Date.now() };
            this.emit();
        }, (error) => {
            if (!live())
                return;
            this.overview = { status: "error", error: transportError("sonarr", error) };
            this.emit();
        });
        // A refresh rebuilds the backend snapshots first so library pages read fresh data.
        if (refresh)
            await overview;
        if (!live())
            return;
        await Promise.all([
            overview,
            this.loadLibrary("series", live),
            this.loadLibrary("movies", live),
        ]);
        if (live()) {
            this.refreshing = false;
            this.emit();
        }
    }
    async loadLibrary(kind, live, attempt = 0) {
        const service = kind === "series" ? "sonarr" : "radarr";
        const set = (value) => {
            if (kind === "series")
                this.series = value;
            else
                this.movies = value;
            this.emit();
        };
        try {
            const first = await this.client.invoke(kind, { offset: 0, limit: LIBRARY_PAGE });
            if (!live())
                return;
            if (!first.ok)
                return set({ status: "error", error: first.error });
            const offsets = [];
            for (let offset = first.items.length; offset < first.total; offset += LIBRARY_PAGE)
                offsets.push(offset);
            const rest = await Promise.all(offsets.map((offset) => this.client.invoke(kind, { offset, limit: LIBRARY_PAGE, generation: first.generation })));
            if (!live())
                return;
            const failed = rest.find((page) => !page.ok);
            if (failed && !failed.ok) {
                if (failed.error.code === "stale" && attempt < 2)
                    return this.loadLibrary(kind, live, attempt + 1);
                return set({ status: "error", error: failed.error });
            }
            const items = [first, ...rest].flatMap((page) => (page.ok ? (page.items ?? []) : []));
            set({ status: "ready", data: items, at: Date.now() });
        }
        catch (error) {
            if (live())
                set({ status: "error", error: transportError(service, error) });
        }
    }
    async detail(map, key, service, fetcher, force) {
        const current = map.get(key);
        if (!force && current && (current.status === "loading" || (current.status === "ready" && Date.now() - current.at < DETAIL_TTL)))
            return;
        const epoch = this.epoch;
        map.set(key, { status: "loading", data: current && "data" in current ? current.data : undefined });
        this.emit();
        try {
            const result = await fetcher();
            if (this.disposed || epoch !== this.epoch)
                return;
            map.set(key, result.ok ? { status: "ready", data: result, at: Date.now() } : { status: "error", error: result.error });
        }
        catch (error) {
            if (this.disposed || epoch !== this.epoch)
                return;
            map.set(key, { status: "error", error: transportError(service, error) });
        }
        this.emit();
    }
    loadSeries(seriesId, force = false) {
        return this.detail(this.seriesDetail, seriesId, "sonarr", () => this.client.invoke("series-detail", { seriesId }), force);
    }
    loadSeason(seriesId, seasonNumber, force = false) {
        return this.detail(this.seasonFiles, `${seriesId}:${seasonNumber}`, "sonarr", async () => {
            const first = await this.client.invoke("season-files", { seriesId, seasonNumber });
            if (!first.ok)
                return first;
            const files = [...first.files];
            while (files.length < first.total) {
                const next = await this.client.invoke("season-files", { seriesId, seasonNumber, offset: files.length });
                if (!next.ok)
                    return next;
                if (!next.files.length)
                    break;
                files.push(...next.files);
            }
            return { ...first, files };
        }, force);
    }
    loadMovie(movieId, force = false) {
        return this.detail(this.movieDetail, movieId, "radarr", () => this.client.invoke("movie-detail", { movieId }), force);
    }
}
const TOP_COUNT_KEY = "media-storage.topCount";
export const TOP_COUNTS = [5, 10, 15, 25];
function readTopCount() {
    try {
        const saved = Number(localStorage.getItem(TOP_COUNT_KEY));
        if (TOP_COUNTS.includes(saved))
            return saved;
    }
    catch {
        // Storage unavailable; use the default.
    }
    return 10;
}
export function saveTopCount(count) {
    try {
        localStorage.setItem(TOP_COUNT_KEY, String(count));
    }
    catch {
        // Storage unavailable; the choice lasts for this page only.
    }
}
