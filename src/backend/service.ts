import type {
  EpisodeFileT,
  RequestDetailT,
  RequestOverviewT,
  MediaSpecT,
  MovieDetailT,
  MovieSummaryT,
  OverviewT,
  SeasonFilesT,
  SeasonSummaryT,
  SeriesDetailT,
  SeriesSummaryT,
  ServiceErrorT,
  ServiceNameT,
  ServiceStatusT,
} from "../contract.js";
import { SEASON_FILES_PAGE, TOP_MAX } from "../contract.js";
import { ArrError, mapLimit, toServiceError, TtlCache, type ArrClient } from "./arr.js";
import type { Artwork } from "./artwork.js";
import { toWatch, type WatchService } from "./tautulli.js";
import { requesters, seasonRequester, type Request, type RequestService } from "./seerr.js";

// ---- Minimal upstream shapes (Sonarr v4 / Radarr v6 API v3) --------------------------------

type ArrImage = { coverType: string; url?: string; remoteUrl?: string };
type ArrQuality = { quality?: { name?: string; resolution?: number } };
type ArrMediaInfo = {
  audioChannels?: number;
  audioCodec?: string;
  audioLanguages?: string;
  videoBitDepth?: number;
  videoBitrate?: number;
  videoCodec?: string;
  videoDynamicRange?: string;
  videoDynamicRangeType?: string;
  resolution?: string;
  runTime?: string;
  subtitles?: string;
};
type SonarrSeason = {
  seasonNumber: number;
  monitored?: boolean;
  statistics?: { episodeFileCount?: number; episodeCount?: number; totalEpisodeCount?: number; sizeOnDisk?: number };
};
type SonarrSeries = {
  id: number;
  title: string;
  tvdbId?: number;
  tmdbId?: number;
  titleSlug?: string;
  year?: number;
  status?: string;
  network?: string;
  overview?: string;
  genres?: string[];
  runtime?: number;
  certification?: string;
  path?: string;
  images?: ArrImage[];
  seasons?: SonarrSeason[];
  statistics?: { seasonCount?: number; episodeFileCount?: number; sizeOnDisk?: number };
};
type SonarrEpisodeFile = {
  id: number;
  seriesId: number;
  seasonNumber: number;
  relativePath?: string;
  path?: string;
  size: number;
  dateAdded?: string;
  releaseGroup?: string;
  quality?: ArrQuality;
  mediaInfo?: ArrMediaInfo;
};
type SonarrEpisode = {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  airDate?: string;
  episodeFileId?: number;
  hasFile?: boolean;
  images?: ArrImage[];
};
type RadarrMovieFile = {
  id: number;
  relativePath?: string;
  path?: string;
  size: number;
  dateAdded?: string;
  releaseGroup?: string;
  edition?: string;
  quality?: ArrQuality;
  mediaInfo?: ArrMediaInfo;
};
type RadarrMovie = {
  id: number;
  title: string;
  tmdbId?: number;
  titleSlug?: string;
  year?: number;
  overview?: string;
  studio?: string;
  genres?: string[];
  certification?: string;
  runtime?: number;
  status?: string;
  hasFile?: boolean;
  sizeOnDisk?: number;
  images?: ArrImage[];
  movieFile?: RadarrMovieFile;
};

// ---- Helpers -----------------------------------------------------------------------------

/** Library snapshots older than this are served immediately and rebuilt in the background. */
export const STALE_AFTER = 10 * 60_000;
const DETAIL_TTL = 5 * 60_000;
const STATUS_TTL = 60_000;

const str = (value: unknown, max = 512): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const int = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
const image = (images: ArrImage[] | undefined, type: string) => images?.find((entry) => entry.coverType === type);
const fileName = (path: string | undefined) => (path ? (path.split(/[\\/]/).pop() ?? null) : null);
const seasonLabel = (n: number) => (n === 0 ? "Specials" : `Season ${n}`);
const nowIso = () => new Date().toISOString();

function runtimeSeconds(value: string | undefined): number {
  if (!value) return 0;
  const parts = value.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  return Math.round(parts.reduce((total, part) => total * 60 + part, 0));
}

function channels(value: number | undefined) {
  if (!value) return "";
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

export function mediaSpec(quality: ArrQuality | undefined, info: ArrMediaInfo | undefined): MediaSpecT {
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

export type Failure = { ok: false; error: ServiceErrorT };
const fail = (service: ServiceNameT, error: unknown): Failure => ({ ok: false, error: toServiceError(service, error) });

type TvLibrary = {
  generation: string;
  retrievedAt: string;
  items: SeriesSummaryT[];
  backdrops: Map<number, string | null>;
  /** TVDB/TMDB ids for matching Seerr requests. */
  ext: Map<number, { tvdbId: number; tmdbId: number }>;
  /** Per-season bytes from Sonarr statistics, for splitting a series between requesters. */
  seasonBytes: Map<number, [season: number, bytes: number][]>;
  sizeBytes: number;
  fileCount: number;
};
type MovieLibrary = {
  generation: string;
  retrievedAt: string;
  items: MovieSummaryT[];
  backdrops: Map<number, string | null>;
  /** TMDB ids for matching Seerr requests. */
  tmdb: Map<number, number>;
  sizeBytes: number;
  fileCount: number;
};
/**
 * Stale-while-revalidate holder for a library snapshot. The first load (or a forced one) is
 * awaited; afterwards callers get the last snapshot instantly, and a stale snapshot triggers a
 * single background rebuild whose completion is announced through onRefreshed.
 */
class Snapshot<T> {
  private value: T | undefined;
  private at = 0;
  private pending: Promise<T> | undefined;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly onRefreshed: () => void,
  ) {}

  private run(): Promise<T> {
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

  get(force = false): Promise<T> {
    if (force || this.value === undefined) return this.run();
    if (!this.pending && Date.now() - this.at > STALE_AFTER) {
      this.run().then(this.onRefreshed, () => {});
    }
    return Promise.resolve(this.value);
  }

  /** Build in the background; failures are left for the next request to report. */
  warm() {
    return this.run().then(
      () => {},
      () => {},
    );
  }
}

type SeriesBundle = {
  retrievedAt: string;
  series: SonarrSeries;
  files: SonarrEpisodeFile[];
  episodes: SonarrEpisode[];
  /** File ids Sonarr references but cannot return (corrupt records). */
  unreadable: number[];
};

// ---- Service -----------------------------------------------------------------------------

export type MediaServiceLogger = { warn: (message: string) => void };
export type LibraryUpdate = { library: "tv" | "movies"; retrievedAt: string };

export function createMediaService(deps: {
  sonarr: ArrClient;
  radarr: ArrClient;
  art: Artwork;
  /** Optional Tautulli watch stats. */
  watch?: WatchService;
  /** Optional Seerr requests. */
  requests?: RequestService;
  logger?: MediaServiceLogger;
  /** Called after a background rebuild replaces a library snapshot. */
  onLibraryUpdated?: (update: LibraryUpdate) => void;
}) {
  const { sonarr, radarr, art } = deps;
  const cache = new TtlCache(512);
  let generationCounter = 0;
  const nextGeneration = () => `${Date.now().toString(36)}-${(++generationCounter).toString(36)}`;

  /** Unique episode files for a series, isolating corrupt Sonarr records instead of failing the series. */
  async function seriesFiles(seriesId: number, episodes?: SonarrEpisode[]) {
    try {
      return { files: await sonarr.json<SonarrEpisodeFile[]>(`/episodefile?seriesId=${seriesId}`), unreadable: [] as number[] };
    } catch (error) {
      if (!(error instanceof ArrError) || error.code !== "upstream_error") throw error;
      // Sonarr returns HTTP 500 for the whole series when one stored file record is corrupt.
      // Fetch the referenced files individually so only the broken record is affected.
      const eps = episodes ?? (await sonarr.json<SonarrEpisode[]>(`/episode?seriesId=${seriesId}`));
      const ids = [...new Set(eps.map((episode) => episode.episodeFileId).filter((id): id is number => int(id) > 0))];
      const unreadable: number[] = [];
      const files = (
        await mapLimit(ids, 4, async (id) => {
          try {
            return await sonarr.json<SonarrEpisodeFile>(`/episodefile/${id}`);
          } catch (inner) {
            if (inner instanceof ArrError && (inner.code === "upstream_error" || inner.code === "not_found")) {
              unreadable.push(id);
              return null;
            }
            throw inner;
          }
        })
      ).filter((file): file is SonarrEpisodeFile => file !== null);
      if (unreadable.length) deps.logger?.warn(`media-storage: Sonarr series ${seriesId} has ${unreadable.length} unreadable episode-file record(s).`);
      return { files, unreadable };
    }
  }

  async function loadTvLibrary(): Promise<TvLibrary> {
      {
        const series = await sonarr.json<SonarrSeries[]>("/series", { timeoutMs: 30_000 });
        // Count unique files per series. Sonarr's statistics.episodeFileCount counts episodes
        // with files, which double-counts multi-episode files, so it is not used for counts.
        const scans = await mapLimit(series, 6, async (entry) => {
          if (!int(entry.statistics?.episodeFileCount) && !int(entry.statistics?.sizeOnDisk)) return { fileCount: 0, sizeBytes: 0 };
          const { files, unreadable } = await seriesFiles(entry.id);
          const readable = files.reduce((total, file) => total + int(file.size), 0);
          return {
            fileCount: files.length + unreadable.length,
            // With unreadable records the exact byte total comes from Sonarr's per-series
            // statistics, which Sonarr computes from the same unique file rows.
            sizeBytes: unreadable.length ? Math.max(int(entry.statistics?.sizeOnDisk), readable) : readable,
          };
        });
        const backdrops = new Map<number, string | null>();
        const ext = new Map<number, { tvdbId: number; tmdbId: number }>();
        const seasonBytes = new Map<number, [number, number][]>();
        const items: SeriesSummaryT[] = series.map((entry, index) => {
          backdrops.set(entry.id, art.cover("sonarr", image(entry.images, "fanart"), "fanart"));
          ext.set(entry.id, { tvdbId: int(entry.tvdbId), tmdbId: int(entry.tmdbId) });
          seasonBytes.set(entry.id, (entry.seasons ?? []).map((season) => [season.seasonNumber, int(season.statistics?.sizeOnDisk)] as [number, number]).filter(([, bytes]) => bytes > 0));
          return {
            id: entry.id,
            title: str(entry.title) ?? `Series ${entry.id}`,
            year: int(entry.year),
            sizeBytes: scans[index]!.sizeBytes,
            seasonCount: int(entry.statistics?.seasonCount),
            fileCount: scans[index]!.fileCount,
            status: str(entry.status, 32) ?? "unknown",
            network: str(entry.network, 128),
            poster: art.cover("sonarr", image(entry.images, "poster"), "poster-500"),
            watch: null,
            requestedBy: null,
          };
        });
        items.sort((a, b) => b.sizeBytes - a.sizeBytes || a.title.localeCompare(b.title));
        return {
          generation: nextGeneration(),
          retrievedAt: nowIso(),
          items,
          backdrops,
          ext,
          seasonBytes,
          sizeBytes: items.reduce((total, item) => total + item.sizeBytes, 0),
          fileCount: items.reduce((total, item) => total + item.fileCount, 0),
        };
      }
  }

  async function loadMovieLibrary(): Promise<MovieLibrary> {
      {
        const movies = await radarr.json<RadarrMovie[]>("/movie", { timeoutMs: 30_000 });
        const backdrops = new Map<number, string | null>();
        const tmdb = new Map<number, number>();
        const items: MovieSummaryT[] = movies.map((movie) => {
          backdrops.set(movie.id, art.cover("radarr", image(movie.images, "fanart"), "fanart"));
          tmdb.set(movie.id, int(movie.tmdbId));
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
            requestedBy: null,
          };
        });
        items.sort((a, b) => b.sizeBytes - a.sizeBytes || a.title.localeCompare(b.title));
        return {
          generation: nextGeneration(),
          retrievedAt: nowIso(),
          items,
          backdrops,
          tmdb,
          sizeBytes: items.reduce((total, item) => total + item.sizeBytes, 0),
          fileCount: items.filter((item) => item.hasFile).length,
        };
      }
  }

  const tvSnapshot: Snapshot<TvLibrary> = new Snapshot(loadTvLibrary, () =>
    deps.onLibraryUpdated?.({ library: "tv", retrievedAt: nowIso() }),
  );
  const movieSnapshot: Snapshot<MovieLibrary> = new Snapshot(loadMovieLibrary, () =>
    deps.onLibraryUpdated?.({ library: "movies", retrievedAt: nowIso() }),
  );
  const tvLibrary = (force = false) => tvSnapshot.get(force);
  const movieLibrary = (force = false) => movieSnapshot.get(force);

  type RequestIndex = NonNullable<Awaited<ReturnType<RequestService["index"]>>>;

  /** Accepted Seerr requests for a library item, oldest first. */
  function requestsOf(idx: RequestIndex, library: TvLibrary | MovieLibrary, id: number): Request[] {
    const requests = deps.requests!;
    if ("ext" in library) return requests.seriesRequests(idx, library.ext.get(id) ?? { tvdbId: 0, tmdbId: 0 });
    return requests.movieRequests(idx, library.tmdb.get(id) ?? 0);
  }

  const names = (requests: Request[]) => {
    const list = requesters(requests);
    return list.length ? list.slice(0, 10) : null;
  };

  /**
   * Attach Tautulli play counts and Seerr requesters to library items. Both are looked up per read
   * so they refresh independently of the library snapshot.
   */
  async function decorate<T extends { id: number; title: string; year: number; watch: unknown; requestedBy: unknown }>(kind: "tv" | "movies", library: TvLibrary | MovieLibrary, items: T[]): Promise<T[]> {
    const [watchIdx, requestIdx] = await Promise.all([deps.watch?.index() ?? null, deps.requests?.index() ?? null]);
    if (!watchIdx && !requestIdx) return items;
    return items.map((item) => ({
      ...item,
      watch: watchIdx ? toWatch(watchIdx[kind](item.title, item.year)) : null,
      requestedBy: requestIdx ? names(requestsOf(requestIdx, library, item.id)) : null,
    }));
  }

  /** Split each title's bytes between requesters (series by season) and total them per user. */
  function requestTotals(
    idx: RequestIndex,
    tv: TvLibrary | null,
    movies: MovieLibrary | null,
    watchIdx: Awaited<ReturnType<WatchService["index"]>> | null,
  ): Omit<RequestOverviewT, "status"> {
    const users = new Map<string, { sizeBytes: number; items: Set<string>; neverWatchedBytes: number }>();
    let notRequestedBytes = 0;
    const credit = (user: string | null, key: string, bytes: number, never: boolean) => {
      if (!bytes) return;
      if (!user) {
        notRequestedBytes += bytes;
        return;
      }
      const entry = users.get(user) ?? { sizeBytes: 0, items: new Set<string>(), neverWatchedBytes: 0 };
      entry.sizeBytes += bytes;
      entry.items.add(key);
      if (never) entry.neverWatchedBytes += bytes;
      users.set(user, entry);
    };
    for (const item of tv?.items ?? []) {
      if (!item.sizeBytes) continue;
      const requests = requestsOf(idx, tv!, item.id);
      const never = watchIdx?.tv(item.title, item.year)?.plays === 0;
      const seasons = tv!.seasonBytes.get(item.id) ?? [];
      const statTotal = seasons.reduce((sum, [, bytes]) => sum + bytes, 0);
      if (!requests.length || !statTotal) {
        credit(requests[0]?.user ?? null, `tv:${item.id}`, item.sizeBytes, never);
        continue;
      }
      // Season shares come from Sonarr's statistics; scale them to the exact series total.
      let assigned = 0;
      seasons.forEach(([season, bytes], index) => {
        const share = index === seasons.length - 1 ? item.sizeBytes - assigned : Math.round((item.sizeBytes * bytes) / statTotal);
        assigned += share;
        credit(seasonRequester(requests, season)?.user ?? null, `tv:${item.id}`, share, never);
      });
    }
    for (const item of movies?.items ?? []) {
      if (!item.sizeBytes) continue;
      const requests = requestsOf(idx, movies!, item.id);
      credit(requests[0]?.user ?? null, `movie:${item.id}`, item.sizeBytes, watchIdx?.movies(item.title, item.year)?.plays === 0);
    }
    return {
      users: [...users.entries()]
        .map(([name, entry]) => ({ name, sizeBytes: entry.sizeBytes, items: entry.items.size, neverWatchedBytes: watchIdx ? entry.neverWatchedBytes : null }))
        .sort((a, b) => b.sizeBytes - a.sizeBytes)
        .slice(0, 200),
      notRequestedBytes,
    };
  }

  function status(client: ArrClient, force: boolean): Promise<ServiceStatusT> {
    return cache.get(
      `status:${client.service}`,
      STATUS_TTL,
      async () => {
        try {
          const [system, health] = await Promise.all([
            client.json<{ appName?: string; version?: string }>("/system/status", { timeoutMs: 10_000 }),
            client.json<unknown[]>("/health", { timeoutMs: 10_000 }).catch(() => []),
          ]);
          const expected = client.service === "sonarr" ? "Sonarr" : "Radarr";
          if (system.appName !== expected) {
            throw new ArrError(client.service, "bad_response", `The configured ${expected} URL answered as ${str(system.appName, 32) ?? "an unknown service"}.`);
          }
          return { service: client.service, state: "ok", version: str(system.version, 64), healthIssues: Array.isArray(health) ? health.length : 0, error: null };
        } catch (error) {
          return { service: client.service, state: "error", version: null, healthIssues: 0, error: toServiceError(client.service, error) };
        }
      },
      force,
    );
  }

  // Sonarr and Radarr route their web pages by titleSlug (Radarr's slug is the TMDB id).
  const seriesWebUrl = (series: SonarrSeries) =>
    series.titleSlug ? sonarr.webUrl(`series/${encodeURIComponent(series.titleSlug)}`) : null;

  function seriesBundle(seriesId: number): Promise<SeriesBundle> {
    return cache.get(`tv:series:${seriesId}`, DETAIL_TTL, async () => {
      const [series, episodes] = await Promise.all([
        sonarr.json<SonarrSeries>(`/series/${seriesId}`),
        sonarr.json<SonarrEpisode[]>(`/episode?seriesId=${seriesId}&includeImages=true`, { timeoutMs: 30_000 }),
      ]);
      const { files, unreadable } = await seriesFiles(seriesId, episodes);
      return { retrievedAt: nowIso(), series, files, episodes, unreadable };
    });
  }

  /** Per-season unique file accounting. Unreadable files get bytes derived from season statistics. */
  function seasonAccounting(bundle: SeriesBundle, seasonNumber: number) {
    const season = bundle.series.seasons?.find((entry) => entry.seasonNumber === seasonNumber);
    const files = bundle.files.filter((file) => file.seasonNumber === seasonNumber);
    const readableBytes = files.reduce((total, file) => total + int(file.size), 0);
    const episodesByFile = new Map<number, SonarrEpisode[]>();
    for (const episode of bundle.episodes) {
      const id = int(episode.episodeFileId);
      if (id) episodesByFile.set(id, [...(episodesByFile.get(id) ?? []), episode]);
    }
    const unreadable = bundle.unreadable.filter((id) =>
      (episodesByFile.get(id) ?? []).some((episode) => episode.seasonNumber === seasonNumber),
    );
    const statBytes = int(season?.statistics?.sizeOnDisk);
    const sizeBytes = unreadable.length ? Math.max(statBytes, readableBytes) : readableBytes;
    const missing = sizeBytes - readableBytes;
    const derived = new Map<number, number>();
    unreadable.forEach((id, index) => {
      const share = Math.floor(missing / unreadable.length);
      derived.set(id, index === 0 ? missing - share * (unreadable.length - 1) : share);
    });
    return { season, files, unreadable, derived, sizeBytes, episodesByFile };
  }

  function still(episodes: SonarrEpisode[]) {
    for (const episode of episodes) {
      const url = art.remote(image(episode.images, "screenshot")?.remoteUrl);
      if (url) return url;
    }
    return null;
  }

  return {
    /** Build both library snapshots (Gateway startup). */
    warm() {
      return Promise.all([tvSnapshot.warm(), movieSnapshot.warm(), status(sonarr, false), status(radarr, false)]);
    },

    async overview(refresh: boolean): Promise<OverviewT> {
      if (refresh) cache.clear();
      const [sonarrStatus, radarrStatus, tv, movies, index, requestIdx] = await Promise.all([
        status(sonarr, refresh),
        status(radarr, refresh),
        tvLibrary(refresh).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => fail("sonarr", error),
        ),
        movieLibrary(refresh).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => fail("radarr", error),
        ),
        // Load the Tautulli index alongside the libraries; failures resolve to null.
        deps.watch?.index(refresh) ?? Promise.resolve(null),
        deps.requests?.index(refresh) ?? Promise.resolve(null),
      ]);
      const totals = (
        state: ServiceStatusT,
        lib: { ok: true; value: TvLibrary | MovieLibrary } | Failure,
        countFiles: boolean,
        kind: "tv" | "movies",
      ) => {
        const library = lib.ok ? lib.value : null;
        const effective: ServiceStatusT =
          lib.ok || state.state === "error" ? state : { ...state, state: "error", error: lib.error };
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
            requestedBy: requestIdx && library ? names(requestsOf(requestIdx, library, item.id)) : null,
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
        requests: !deps.requests?.configured()
          ? null
          : requestIdx
            ? { status: { state: "ok", version: requestIdx.version, error: null }, ...requestTotals(requestIdx, tv.ok ? tv.value : null, movies.ok ? movies.value : null, index) }
            : { status: { state: "error", version: null, error: toServiceError("seerr", deps.requests.error()) }, users: [], notRequestedBytes: 0 },
      };
    },

    async seriesPage(input: { offset: number; limit: number; generation?: string }) {
      try {
        const library = await tvLibrary();
        if (input.generation && input.generation !== library.generation) {
          return { ok: false as const, error: { service: "sonarr" as const, code: "stale" as const, message: "The TV library changed; reload from the first page." } };
        }
        return {
          ok: true as const,
          generation: library.generation,
          retrievedAt: library.retrievedAt,
          total: library.items.length,
          offset: input.offset,
          items: await decorate("tv", library, library.items.slice(input.offset, input.offset + input.limit)),
        };
      } catch (error) {
        return fail("sonarr", error);
      }
    },

    async moviesPage(input: { offset: number; limit: number; generation?: string }) {
      try {
        const library = await movieLibrary();
        if (input.generation && input.generation !== library.generation) {
          return { ok: false as const, error: { service: "radarr" as const, code: "stale" as const, message: "The movie library changed; reload from the first page." } };
        }
        return {
          ok: true as const,
          generation: library.generation,
          retrievedAt: library.retrievedAt,
          total: library.items.length,
          offset: input.offset,
          items: await decorate("movies", library, library.items.slice(input.offset, input.offset + input.limit)),
        };
      } catch (error) {
        return fail("radarr", error);
      }
    },

    async seriesDetail(seriesId: number): Promise<({ ok: true } & SeriesDetailT) | Failure> {
      try {
        const bundle = await seriesBundle(seriesId);
        const { series } = bundle;
        const seasons: SeasonSummaryT[] = (series.seasons ?? [])
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
      } catch (error) {
        return fail("sonarr", error);
      }
    },

    async seasonFiles(seriesId: number, seasonNumber: number, offset = 0): Promise<({ ok: true } & SeasonFilesT) | Failure> {
      try {
        const bundle = await seriesBundle(seriesId);
        const account = seasonAccounting(bundle, seasonNumber);
        if (!account.season && account.files.length === 0) {
          throw new ArrError("sonarr", "not_found", `This series has no ${seasonLabel(seasonNumber).toLowerCase()}.`, 404);
        }
        const episodesOf = (id: number) =>
          (account.episodesByFile.get(id) ?? []).slice().sort((a, b) => a.episodeNumber - b.episodeNumber);
        const toEpisodes = (episodes: SonarrEpisode[]) =>
          episodes.slice(0, 50).map((episode) => ({
            number: episode.episodeNumber,
            title: str(episode.title) ?? "TBA",
            airDate: str(episode.airDate, 32),
          }));
        const files: EpisodeFileT[] = [
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
      } catch (error) {
        return fail("sonarr", error);
      }
    },

    async watchDetail(kind: "series" | "movie", id: number) {
      try {
        if (!deps.watch?.configured()) return notConfigured();
        // Match on the Sonarr/Radarr title: from the snapshot when present, otherwise the item itself.
        const library = kind === "series" ? await tvLibrary() : await movieLibrary();
        let item: { title: string; year: number } | undefined = library.items.find((entry) => entry.id === id);
        if (!item) {
          const raw = kind === "series" ? await sonarr.json<SonarrSeries>(`/series/${id}`) : await radarr.json<RadarrMovie>(`/movie/${id}`);
          item = { title: str(raw.title) ?? "", year: int(raw.year) };
        }
        return await deps.watch.detail(kind, item);
      } catch (error) {
        return fail(error instanceof ArrError ? error.service : "tautulli", error);
      }
    },

    async requestDetail(kind: "series" | "movie", id: number): Promise<RequestDetailT | Failure> {
      const requests = deps.requests;
      if (!requests?.configured()) return { ok: true, state: "not_configured", webUrl: null, requests: [] };
      try {
        const idx = await requests.index();
        if (!idx) throw requests.error();
        let list: Request[];
        let tmdbId: number;
        if (kind === "series") {
          const library = await tvLibrary();
          let ids = library.ext.get(id);
          if (!ids) {
            const raw = await sonarr.json<SonarrSeries>(`/series/${id}`);
            ids = { tvdbId: int(raw.tvdbId), tmdbId: int(raw.tmdbId) };
          }
          list = requests.seriesRequests(idx, ids);
          tmdbId = ids.tmdbId || (list[0]?.tmdbId ?? 0);
        } else {
          const library = await movieLibrary();
          tmdbId = library.tmdb.get(id) ?? int((await radarr.json<RadarrMovie>(`/movie/${id}`)).tmdbId);
          list = requests.movieRequests(idx, tmdbId);
        }
        return {
          ok: true,
          state: list.length ? "ok" : "none",
          webUrl: requests.webUrl(kind === "series" ? "tv" : "movie", tmdbId),
          requests: list.slice(0, 50).map((request) => ({ user: request.user, at: request.at, seasons: request.seasons.slice(0, 200) })),
        };
      } catch (error) {
        return fail(error instanceof ArrError ? error.service : "seerr", error);
      }
    },

    async movieDetail(movieId: number): Promise<({ ok: true } & MovieDetailT) | Failure> {
      try {
        const movie = await cache.get(`movies:movie:${movieId}`, DETAIL_TTL, () => radarr.json<RadarrMovie>(`/movie/${movieId}`));
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
      } catch (error) {
        return fail("radarr", error);
      }
    },
  };
}

const notConfigured = () => ({ ok: true as const, state: "not_configured" as const, webUrl: null, plays: 0, seconds: 0, windows: [], users: [], seasons: [], recent: [] });

export type MediaService = ReturnType<typeof createMediaService>;
