import { Type, type Static, type TSchema } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";

/**
 * Shared, browser-safe operation contract for the media-storage plugin.
 *
 * Every size is an exact byte count reported by Sonarr/Radarr (logical file size).
 * Formatting is purely a UI concern. Feature payloads are bounded JSON
 * (4096 nodes / 256 KiB), so the two library listings are paginated.
 */

const Id = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });
const Bytes = Type.Integer({ minimum: 0, maximum: 9_007_199_254_740_991 });
const Count = Type.Integer({ minimum: 0, maximum: 10_000_000 });
const Text = (maxLength = 512) => Type.String({ maxLength });
const OptText = (maxLength = 512) => Type.Union([Type.String({ maxLength }), Type.Null()]);
/** Same-origin, signed artwork path served by this plugin. Never contains an API key. */
const Art = Type.Union([Type.String({ maxLength: 2048, pattern: "^/media-storage/art/" }), Type.Null()]);

export const ServiceName = Type.Union([Type.Literal("sonarr"), Type.Literal("radarr")]);

export const ServiceError = Type.Object(
  {
    service: ServiceName,
    code: Type.Union([
      Type.Literal("not_configured"),
      Type.Literal("unreachable"),
      Type.Literal("timeout"),
      Type.Literal("unauthorized"),
      Type.Literal("upstream_error"),
      Type.Literal("bad_response"),
      Type.Literal("not_found"),
      Type.Literal("stale"),
    ]),
    message: Text(400),
  },
  { additionalProperties: false },
);

const Failure = Type.Object({ ok: Type.Literal(false), error: ServiceError }, { additionalProperties: false });
const result = <T extends TSchema>(ok: T) => Type.Union([ok, Failure]);

export const ServiceStatus = Type.Object(
  {
    service: ServiceName,
    state: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
    version: OptText(64),
    /** Number of Sonarr/Radarr health-check notices (warnings/errors). */
    healthIssues: Count,
    error: Type.Union([ServiceError, Type.Null()]),
  },
  { additionalProperties: false },
);

export const SeriesSummary = Type.Object(
  {
    id: Id,
    title: Text(),
    year: Type.Integer({ minimum: 0, maximum: 3000 }),
    sizeBytes: Bytes,
    seasonCount: Count,
    /** Unique media files (multi-episode files counted once). */
    fileCount: Count,
    status: Text(32),
    network: OptText(128),
    poster: Art,
  },
  { additionalProperties: false },
);

export const MovieSummary = Type.Object(
  {
    id: Id,
    title: Text(),
    year: Type.Integer({ minimum: 0, maximum: 3000 }),
    sizeBytes: Bytes,
    hasFile: Type.Boolean(),
    quality: OptText(64),
    /** Vertical resolution class from Radarr quality (2160, 1080, ...), 0 if unknown. */
    resolution: Type.Integer({ minimum: 0, maximum: 10000 }),
    videoCodec: OptText(64),
    poster: Art,
  },
  { additionalProperties: false },
);

const Ranked = Type.Object(
  { id: Id, title: Text(), year: Type.Integer({ minimum: 0, maximum: 3000 }), sizeBytes: Bytes, poster: Art, backdrop: Art },
  { additionalProperties: false },
);

const ServiceTotals = Type.Object(
  {
    status: ServiceStatus,
    sizeBytes: Bytes,
    itemCount: Count,
    fileCount: Count,
    largest: Type.Union([Ranked, Type.Null()]),
    top: Type.Array(Ranked, { maxItems: 12 }),
  },
  { additionalProperties: false },
);

export const Overview = Type.Object(
  {
    ok: Type.Literal(true),
    retrievedAt: Text(40),
    tv: ServiceTotals,
    movies: ServiceTotals,
    combinedBytes: Bytes,
    /** False when one service was unavailable and the combined total only covers the other. */
    complete: Type.Boolean(),
  },
  { additionalProperties: false },
);

const PageInput = Type.Object(
  {
    offset: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    limit: Type.Integer({ minimum: 1, maximum: 200 }),
    /** Snapshot generation from the first page; mismatches return a `stale` error. */
    generation: Type.Optional(Text(64)),
  },
  { additionalProperties: false },
);

const page = <T extends TSchema>(item: T) =>
  Type.Object(
    {
      ok: Type.Literal(true),
      generation: Text(64),
      retrievedAt: Text(40),
      total: Count,
      offset: Count,
      items: Type.Array(item, { maxItems: 200 }),
    },
    { additionalProperties: false },
  );

export const SeasonSummary = Type.Object(
  {
    seasonNumber: Type.Integer({ minimum: 0, maximum: 10000 }),
    label: Text(64),
    sizeBytes: Bytes,
    fileCount: Count,
    episodeFileCount: Count,
    totalEpisodes: Count,
    monitored: Type.Boolean(),
    /** Representative still from Sonarr's episode artwork; Sonarr exposes no season posters. */
    artwork: Art,
    /** Files Sonarr could not return (corrupt records); their bytes are derived from Sonarr's season statistics. */
    unreadableFiles: Count,
  },
  { additionalProperties: false },
);

export const SeriesDetail = Type.Object(
  {
    ok: Type.Literal(true),
    retrievedAt: Text(40),
    id: Id,
    title: Text(),
    year: Type.Integer({ minimum: 0, maximum: 3000 }),
    overview: OptText(4000),
    network: OptText(128),
    status: Text(32),
    genres: Type.Array(Text(64), { maxItems: 8 }),
    runtime: Count,
    certification: OptText(32),
    path: OptText(1024),
    sizeBytes: Bytes,
    fileCount: Count,
    seasonCount: Count,
    poster: Art,
    backdrop: Art,
    seasons: Type.Array(SeasonSummary, { maxItems: 200 }),
  },
  { additionalProperties: false },
);

export const MediaSpec = Type.Object(
  {
    quality: OptText(64),
    resolution: OptText(32),
    resolutionClass: Type.Integer({ minimum: 0, maximum: 10000 }),
    videoCodec: OptText(64),
    dynamicRange: OptText(64),
    bitDepth: Type.Integer({ minimum: 0, maximum: 64 }),
    videoBitrate: Type.Integer({ minimum: 0 }),
    audio: OptText(96),
    audioLanguages: OptText(256),
    subtitles: OptText(256),
    runtime: OptText(32),
    runtimeSeconds: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const EpisodeFile = Type.Object(
  {
    id: Id,
    episodes: Type.Array(
      Type.Object(
        { number: Type.Integer({ minimum: 0, maximum: 100000 }), title: Text(), airDate: OptText(32) },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
    still: Art,
    fileName: OptText(1024),
    path: OptText(2048),
    sizeBytes: Bytes,
    /** True when Sonarr could not return this record and the size was derived from season statistics. */
    sizeDerived: Type.Boolean(),
    releaseGroup: OptText(128),
    dateAdded: OptText(40),
    spec: MediaSpec,
  },
  { additionalProperties: false },
);

export const SeasonFiles = Type.Object(
  {
    ok: Type.Literal(true),
    retrievedAt: Text(40),
    seriesId: Id,
    seriesTitle: Text(),
    seasonNumber: Type.Integer({ minimum: 0, maximum: 10000 }),
    label: Text(64),
    sizeBytes: Bytes,
    total: Count,
    offset: Count,
    files: Type.Array(EpisodeFile, { maxItems: 100 }),
    backdrop: Art,
  },
  { additionalProperties: false },
);

export const MovieDetail = Type.Object(
  {
    ok: Type.Literal(true),
    retrievedAt: Text(40),
    id: Id,
    title: Text(),
    year: Type.Integer({ minimum: 0, maximum: 3000 }),
    overview: OptText(4000),
    studio: OptText(128),
    genres: Type.Array(Text(64), { maxItems: 8 }),
    certification: OptText(32),
    runtimeMinutes: Count,
    status: Text(32),
    hasFile: Type.Boolean(),
    sizeBytes: Bytes,
    poster: Art,
    backdrop: Art,
    file: Type.Union([
      Type.Object(
        {
          id: Id,
          fileName: OptText(1024),
          path: OptText(2048),
          sizeBytes: Bytes,
          dateAdded: OptText(40),
          releaseGroup: OptText(128),
          edition: OptText(128),
          spec: MediaSpec,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export const contract = defineFeatureContract({
  pluginId: "media-storage",
  operations: {
    overview: {
      kind: "query",
      description: "Storage totals, counts, largest items, and Sonarr/Radarr connectivity. refresh bypasses all caches.",
      input: Type.Object({ refresh: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      output: Overview,
    },
    series: {
      kind: "query",
      description: "One page of the Sonarr series library with exact unique-file storage totals.",
      input: PageInput,
      output: result(page(SeriesSummary)),
    },
    "series-detail": {
      kind: "query",
      description: "Sonarr series metadata and exact per-season storage (Season 0 / Specials included).",
      input: Type.Object({ seriesId: Id }, { additionalProperties: false }),
      output: result(SeriesDetail),
    },
    "season-files": {
      kind: "query",
      description: "Unique media files in one season, largest first; multi-episode files appear once.",
      input: Type.Object(
        {
          seriesId: Id,
          seasonNumber: Type.Integer({ minimum: 0, maximum: 10000 }),
          offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
        },
        { additionalProperties: false },
      ),
      output: result(SeasonFiles),
    },
    movies: {
      kind: "query",
      description: "One page of the Radarr movie library with exact movie-file sizes.",
      input: PageInput,
      output: result(page(MovieSummary)),
    },
    "movie-detail": {
      kind: "query",
      description: "Radarr movie metadata and its media file.",
      input: Type.Object({ movieId: Id }, { additionalProperties: false }),
      output: result(MovieDetail),
    },
  },
  events: {
    /** A background rebuild replaced a library snapshot; clients should re-read it. */
    "library-updated": Type.Object(
      { library: Type.Union([Type.Literal("tv"), Type.Literal("movies")]), retrievedAt: Text(40) },
      { additionalProperties: false },
    ),
  },
});

export type OverviewT = Static<typeof Overview>;
export type SeriesSummaryT = Static<typeof SeriesSummary>;
export type MovieSummaryT = Static<typeof MovieSummary>;
export type SeriesDetailT = Static<typeof SeriesDetail>;
export type SeasonSummaryT = Static<typeof SeasonSummary>;
export type SeasonFilesT = Static<typeof SeasonFiles>;
export type EpisodeFileT = Static<typeof EpisodeFile>;
export type MovieDetailT = Static<typeof MovieDetail>;
export type MediaSpecT = Static<typeof MediaSpec>;
export type ServiceErrorT = Static<typeof ServiceError>;
export type ServiceStatusT = Static<typeof ServiceStatus>;
export type ServiceNameT = Static<typeof ServiceName>;

export const SEASON_FILES_PAGE = 60;
export const LIBRARY_PAGE = 150;
