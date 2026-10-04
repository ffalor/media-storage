import type { FeatureClient } from "openclaw/plugin-sdk/feature-contract";
import {
  contract,
  LIBRARY_PAGE,
  type MovieDetailT,
  type MovieSummaryT,
  type OverviewT,
  type SeasonFilesT,
  type SeriesDetailT,
  type SeriesSummaryT,
  type ServiceErrorT,
} from "../contract.js";

export type Resource<T> =
  | { status: "idle" }
  | { status: "loading"; data?: T }
  | { status: "ready"; data: T; at: number }
  | { status: "error"; error: ServiceErrorT; data?: T };

type Client = FeatureClient<typeof contract>;

const DETAIL_TTL = 3 * 60_000;

/** Turn transport failures into a displayable error without leaking internals. */
function transportError(service: "sonarr" | "radarr", error: unknown): ServiceErrorT {
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
  overview: Resource<OverviewT> = { status: "idle" };
  series: Resource<SeriesSummaryT[]> = { status: "idle" };
  movies: Resource<MovieSummaryT[]> = { status: "idle" };
  readonly seriesDetail = new Map<number, Resource<SeriesDetailT>>();
  readonly seasonFiles = new Map<string, Resource<SeasonFilesT>>();
  readonly movieDetail = new Map<number, Resource<MovieDetailT>>();
  refreshing = false;
  /** UI preferences that survive navigation within the page. */
  readonly prefs = { tvQuery: "", tvSort: "size-desc", movieQuery: "", movieSort: "size-desc", fileSort: "size" as "size" | "episode" };

  private epoch = 0;
  private disposed = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly client: Client) {}

  /** Re-read snapshots after the backend finishes a background rebuild. */
  watchUpdates() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = this.client.on("library-updated", () => {
      clearTimeout(timer);
      // TV and movie rebuilds finish separately; coalesce them into one re-read.
      timer = setTimeout(() => {
        if (!this.disposed && !this.refreshing) void this.load(false);
      }, 1500);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }

  private emit() {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
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
    if (this.series.status !== "ready" || refresh) this.series = { status: "loading", data: "data" in this.series ? this.series.data : undefined };
    if (this.movies.status !== "ready" || refresh) this.movies = { status: "loading", data: "data" in this.movies ? this.movies.data : undefined };
    this.emit();

    const overview = this.client.invoke("overview", refresh ? { refresh: true } : {}).then(
      (data) => {
        if (!live()) return;
        this.overview = { status: "ready", data, at: Date.now() };
        this.emit();
      },
      (error: unknown) => {
        if (!live()) return;
        this.overview = { status: "error", error: transportError("sonarr", error) };
        this.emit();
      },
    );
    // A refresh rebuilds the backend snapshots first so library pages read fresh data.
    if (refresh) await overview;
    if (!live()) return;
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

  private async loadLibrary(kind: "series" | "movies", live: () => boolean, attempt = 0): Promise<void> {
    const service = kind === "series" ? "sonarr" : "radarr";
    const set = (value: Resource<SeriesSummaryT[]> | Resource<MovieSummaryT[]>) => {
      if (kind === "series") this.series = value as Resource<SeriesSummaryT[]>;
      else this.movies = value as Resource<MovieSummaryT[]>;
      this.emit();
    };
    try {
      const first = await this.client.invoke(kind, { offset: 0, limit: LIBRARY_PAGE });
      if (!live()) return;
      if (!first.ok) return set({ status: "error", error: first.error });
      const offsets: number[] = [];
      for (let offset = first.items.length; offset < first.total; offset += LIBRARY_PAGE) offsets.push(offset);
      const rest = await Promise.all(
        offsets.map((offset) => this.client.invoke(kind, { offset, limit: LIBRARY_PAGE, generation: first.generation })),
      );
      if (!live()) return;
      const failed = rest.find((page) => !page.ok);
      if (failed && !failed.ok) {
        if (failed.error.code === "stale" && attempt < 2) return this.loadLibrary(kind, live, attempt + 1);
        return set({ status: "error", error: failed.error });
      }
      const items = ([first, ...rest] as { ok: boolean; items?: unknown[] }[]).flatMap((page) => (page.ok ? (page.items ?? []) : []));
      set({ status: "ready", data: items as never, at: Date.now() });
    } catch (error) {
      if (live()) set({ status: "error", error: transportError(service, error) });
    }
  }

  private async detail<T>(
    map: Map<string | number, Resource<T>>,
    key: string | number,
    service: "sonarr" | "radarr",
    fetcher: () => Promise<{ ok: true } & T | { ok: false; error: ServiceErrorT }>,
    force: boolean,
  ) {
    const current = map.get(key);
    if (!force && current && (current.status === "loading" || (current.status === "ready" && Date.now() - current.at < DETAIL_TTL))) return;
    const epoch = this.epoch;
    map.set(key, { status: "loading", data: current && "data" in current ? current.data : undefined });
    this.emit();
    try {
      const result = await fetcher();
      if (this.disposed || epoch !== this.epoch) return;
      map.set(key, result.ok ? { status: "ready", data: result as T, at: Date.now() } : { status: "error", error: result.error });
    } catch (error) {
      if (this.disposed || epoch !== this.epoch) return;
      map.set(key, { status: "error", error: transportError(service, error) });
    }
    this.emit();
  }

  loadSeries(seriesId: number, force = false) {
    return this.detail(this.seriesDetail as Map<string | number, Resource<SeriesDetailT>>, seriesId, "sonarr", () => this.client.invoke("series-detail", { seriesId }), force);
  }

  loadSeason(seriesId: number, seasonNumber: number, force = false) {
    return this.detail(
      this.seasonFiles as Map<string | number, Resource<SeasonFilesT>>,
      `${seriesId}:${seasonNumber}`,
      "sonarr",
      async () => {
        const first = await this.client.invoke("season-files", { seriesId, seasonNumber });
        if (!first.ok) return first;
        const files = [...first.files];
        while (files.length < first.total) {
          const next = await this.client.invoke("season-files", { seriesId, seasonNumber, offset: files.length });
          if (!next.ok) return next;
          if (!next.files.length) break;
          files.push(...next.files);
        }
        return { ...first, files };
      },
      force,
    );
  }

  loadMovie(movieId: number, force = false) {
    return this.detail(this.movieDetail as Map<string | number, Resource<MovieDetailT>>, movieId, "radarr", () => this.client.invoke("movie-detail", { movieId }), force);
  }
}
