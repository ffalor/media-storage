import type { WatchDetailT, WatchOverviewT, WatchT } from "../contract.js";
import { STALE_DAYS } from "../contract.js";
import { ArrError, toServiceError, TtlCache } from "./arr.js";

/**
 * Optional Tautulli integration. Everything here degrades to "no watch data": an unset API key
 * means no requests at all, and a failing Tautulli never fails a Sonarr/Radarr response.
 */

const INDEX_TTL = 10 * 60_000;
const DETAIL_TTL = 2 * 60_000;
const STATUS_TTL = 60_000;
const DAY = 86_400_000;

export type TautulliClient = {
  readonly configured: boolean;
  webUrl: (path: string) => string;
  /** GET /api/v2?cmd=... and return `response.data`. */
  call: <T>(cmd: string, params?: Record<string, string | number>, options?: { timeoutMs?: number }) => Promise<T>;
};

/** `getApiKey` is called per request so the key is never retained. Tautulli takes the key as a query parameter. */
export function createTautulliClient(baseUrl: string, getApiKey: () => string | undefined): TautulliClient {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  return {
    webUrl: (path: string) => new URL(path, base).toString(),
    get configured() {
      return Boolean(getApiKey());
    },
    async call<T>(cmd: string, params: Record<string, string | number> = {}, options: { timeoutMs?: number } = {}) {
      const apiKey = getApiKey();
      if (!apiKey) throw new ArrError("tautulli", "not_configured", "Tautulli is not configured.");
      const url = new URL("api/v2", base);
      url.searchParams.set("apikey", apiKey);
      url.searchParams.set("cmd", cmd);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
      const timeoutMs = options.timeoutMs ?? 15_000;
      let response: Response;
      try {
        response = await fetch(url, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        throw new ArrError(
          "tautulli",
          timeout ? "timeout" : "unreachable",
          timeout ? `Tautulli did not respond within ${Math.round(timeoutMs / 1000)} seconds.` : `Tautulli could not be reached at ${base.host}.`,
        );
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        throw new ArrError("tautulli", "unauthorized", `Tautulli rejected the API key (HTTP ${response.status}).`, response.status);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new ArrError("tautulli", "upstream_error", `Tautulli returned HTTP ${response.status}.`, response.status);
      }
      let body: { response?: { result?: string; message?: string | null; data?: unknown } };
      try {
        body = await response.json();
      } catch {
        throw new ArrError("tautulli", "bad_response", "Tautulli returned a response that was not valid JSON.");
      }
      if (body.response?.result !== "success") {
        const message = typeof body.response?.message === "string" ? body.response.message : "";
        const unauthorized = /api ?key/i.test(message);
        throw new ArrError("tautulli", unauthorized ? "unauthorized" : "upstream_error", unauthorized ? "Tautulli rejected the API key." : `Tautulli could not run ${cmd}.`);
      }
      return body.response.data as T;
    },
  };
}

// ---- Matching ------------------------------------------------------------------------------

/** Lowercase alphanumerics with "&" as "and" and a leading "the" dropped. */
const norm = (title: string) =>
  title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "")
    .replace(/ /g, "");
/** Drop trailing qualifiers like "(2005)" or "(US)" that only one side includes. */
const bare = (title: string) => norm(title.replace(/\s*\([^)]*\)\s*$/, "")) || norm(title);

/**
 * Title + year lookup tolerant of the differences between Sonarr/Radarr and Plex naming.
 * Ambiguous title-only matches are rejected rather than guessed.
 */
export function createMatcher<T extends { title: string; year: number }>(items: readonly T[]) {
  const exact = new Map<string, T[]>();
  const loose = new Map<string, T[]>();
  const add = (map: Map<string, T[]>, key: string, item: T) => {
    const list = map.get(key);
    if (!list) map.set(key, [item]);
    else if (!list.includes(item)) list.push(item);
  };
  for (const item of items) {
    for (const name of new Set([norm(item.title), bare(item.title)])) {
      add(exact, `${name}|${item.year}`, item);
      add(loose, name, item);
    }
  }
  const one = (list: T[] | undefined) => (list?.length === 1 ? list[0] : undefined);
  return (title: string, year: number): T | undefined => {
    for (const name of [norm(title), bare(title)]) {
      const hit = one(exact.get(`${name}|${year}`));
      if (hit) return hit;
    }
    for (const name of [norm(title), bare(title)]) {
      // Plex and TVDB/TMDB sometimes disagree on the year by one.
      const near = [year - 1, year + 1].map((y) => one(exact.get(`${name}|${y}`))).filter((item): item is T => Boolean(item));
      if (near.length === 1) return near[0];
      const hit = one(loose.get(name));
      if (hit) return hit;
    }
    return undefined;
  };
}

// ---- Index ---------------------------------------------------------------------------------

type MediaRow = { rating_key?: string | number; title?: string; year?: string | number; media_index?: string | number; play_count?: number | null; last_played?: number | null };
type HomeRow = { live?: number; rating_key?: number; grandparent_rating_key?: number; title?: string; total_plays?: number; users_watched?: number; last_play?: number };

export type WatchEntry = { ratingKey: number; sectionId: number; title: string; year: number; plays: number; lastPlayed: number };
type Popular = { ratingKey: number; title: string; plays: number; users: number; lastPlayed: number };
type WatchIndex = {
  version: string | null;
  tv: (title: string, year: number) => WatchEntry | undefined;
  movies: (title: string, year: number) => WatchEntry | undefined;
  byKey: Map<number, WatchEntry>;
  popular: { tv: Popular[]; movies: Popular[] };
};

const num = (value: unknown) => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const iso = (seconds: number) => (seconds > 0 ? new Date(seconds * 1000).toISOString() : null);
const text = (value: unknown, max = 512) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

export const toWatch = (entry: WatchEntry | undefined): WatchT | null => (entry ? { plays: entry.plays, lastPlayed: iso(entry.lastPlayed) } : null);

export type WatchService = ReturnType<typeof createWatchService>;
export type LibraryItem = { id: number; title: string; year: number; sizeBytes: number; poster: string | null };

export function createWatchService(tautulli: TautulliClient) {
  const cache = new TtlCache(128);
  let lastError: unknown = null;

  async function loadIndex(): Promise<WatchIndex> {
    const [info, libraries] = await Promise.all([
      tautulli.call<{ tautulli_version?: string }>("get_tautulli_info").catch(() => ({}) as { tautulli_version?: string }),
      // Short timeout: an unreachable Tautulli should not hold up the overview.
      tautulli.call<{ section_id: string | number; section_type: string; is_active?: number; count?: string | number }[]>("get_libraries", {}, { timeoutMs: 6_000 }),
    ]);
    const sections = libraries.filter((lib) => (lib.section_type === "show" || lib.section_type === "movie") && lib.is_active !== 0);
    const entries = { show: [] as WatchEntry[], movie: [] as WatchEntry[] };
    await Promise.all(
      sections.map(async (lib) => {
        const sectionId = num(lib.section_id);
        const read = (refresh: boolean) =>
          tautulli.call<{ data?: MediaRow[]; recordsTotal?: number }>(
            "get_library_media_info",
            { section_id: sectionId, length: 100_000, order_column: "title", ...(refresh ? { refresh: "true" } : {}) },
            { timeoutMs: refresh ? 60_000 : 30_000 },
          );
        let page = await read(false);
        // Tautulli caches this table and can lag far behind Plex; rebuild it when it is short.
        if (num(page.recordsTotal) < num(lib.count)) page = await read(true).catch(() => page);
        for (const row of page.data ?? []) {
          const title = text(row.title);
          const ratingKey = num(row.rating_key);
          if (!title || !ratingKey) continue;
          entries[lib.section_type as "show" | "movie"].push({ ratingKey, sectionId, title, year: num(row.year), plays: num(row.play_count), lastPlayed: num(row.last_played) });
        }
      }),
    );
    const popular = async (statId: string) => {
      const stat = await tautulli
        .call<{ rows?: HomeRow[] }>("get_home_stats", { stat_id: statId, time_range: 30, stats_count: 5 })
        .catch(() => ({ rows: [] }) as { rows?: HomeRow[] });
      return (stat.rows ?? []).filter((row) => !row.live).map((row) => ({
        ratingKey: num(row.grandparent_rating_key) || num(row.rating_key),
        title: text(row.title) ?? "Unknown",
        plays: num(row.total_plays),
        users: num(row.users_watched),
        lastPlayed: num(row.last_play),
      }));
    };
    const [popularTv, popularMovies] = await Promise.all([popular("popular_tv"), popular("popular_movies")]);
    return {
      version: text(info.tautulli_version, 64),
      tv: createMatcher(merge(entries.show)),
      movies: createMatcher(merge(entries.movie)),
      byKey: new Map([...entries.show, ...entries.movie].map((entry) => [entry.ratingKey, entry])),
      popular: { tv: popularTv, movies: popularMovies },
    };
  }

  /** The same title in several Plex libraries (4K + HD) is one item to Sonarr/Radarr. */
  function merge(list: WatchEntry[]) {
    const out = new Map<string, WatchEntry>();
    for (const entry of list) {
      const key = `${norm(entry.title)}|${entry.year}`;
      const prev = out.get(key);
      if (!prev) out.set(key, { ...entry });
      else {
        // Keep the most-played copy's rating key for detail lookups.
        if (entry.plays > prev.plays) Object.assign(prev, { ratingKey: entry.ratingKey, sectionId: entry.sectionId });
        prev.plays += entry.plays;
        prev.lastPlayed = Math.max(prev.lastPlayed, entry.lastPlayed);
      }
    }
    return [...out.values()];
  }

  /** The cached index, or null when unconfigured or failing (the failure is reported by `overview`). */
  const index = (force = false): Promise<WatchIndex | null> =>
    tautulli.configured
      ? cache.get("index", INDEX_TTL, loadIndex, force).then(
          (value) => {
            lastError = null;
            return value;
          },
          (error: unknown) => {
            lastError = error;
            return null;
          },
        )
      : Promise.resolve(null);

  function totals(lookup: WatchIndex["tv"], items: readonly LibraryItem[], popular: Popular[], byKey: Map<number, WatchEntry>) {
    const cutoff = (Date.now() - STALE_DAYS * DAY) / 1000;
    const out = { matched: 0, unmatched: 0, neverWatched: { count: 0, sizeBytes: 0 }, stale: { count: 0, sizeBytes: 0 } };
    for (const item of items) {
      if (!item.sizeBytes) continue;
      const entry = lookup(item.title, item.year);
      if (!entry) {
        out.unmatched++;
        continue;
      }
      out.matched++;
      const bucket = entry.plays === 0 ? out.neverWatched : entry.lastPlayed < cutoff ? out.stale : null;
      if (bucket) {
        bucket.count++;
        bucket.sizeBytes += item.sizeBytes;
      }
    }
    const findItem = createMatcher(items);
    return {
      ...out,
      popular: popular.map((row) => {
        const entry = byKey.get(row.ratingKey);
        const item = findItem(entry?.title ?? row.title, entry?.year ?? 0);
        return { id: item?.id ?? null, title: item?.title ?? row.title, plays: row.plays, users: row.users, lastPlayed: iso(row.lastPlayed), sizeBytes: item ? item.sizeBytes : null, poster: item?.poster ?? null };
      }),
    };
  }

  return {
    configured: () => tautulli.configured,
    index,

    /** Watch summary for the overview, or null when Tautulli is not configured. */
    async overview(libraries: { tv: readonly LibraryItem[] | null; movies: readonly LibraryItem[] | null }): Promise<WatchOverviewT | null> {
      if (!tautulli.configured) return null;
      const idx = await index();
      if (!idx) {
        return { status: { state: "error", version: null, error: toServiceError("tautulli", lastError) }, staleDays: STALE_DAYS, tv: null, movies: null };
      }
      return {
        status: { state: "ok", version: idx.version, error: null },
        staleDays: STALE_DAYS,
        tv: libraries.tv ? totals(idx.tv, libraries.tv, idx.popular.tv, idx.byKey) : null,
        movies: libraries.movies ? totals(idx.movies, libraries.movies, idx.popular.movies, idx.byKey) : null,
      };
    },

    /** Per-item stats. `item` is the Sonarr/Radarr title and year used to find the Plex item. */
    detail(kind: "series" | "movie", item: { title: string; year: number }): Promise<WatchDetailT> {
      const empty = (state: WatchDetailT["state"]): WatchDetailT => ({ ok: true, state, webUrl: null, plays: 0, seconds: 0, windows: [], users: [], seasons: [], recent: [] });
      if (!tautulli.configured) return Promise.resolve(empty("not_configured"));
      return cache.get(`detail:${kind}:${item.title}|${item.year}`, DETAIL_TTL, async () => {
        const idx = await cache.get("index", INDEX_TTL, loadIndex);
        const entry = (kind === "series" ? idx.tv : idx.movies)(item.title, item.year);
        if (!entry) return empty("unmatched");
        const key = entry.ratingKey;
        type TimeRow = { query_days?: number; total_plays?: number; total_time?: number };
        type UserRow = { friendly_name?: string; username?: string; total_plays?: number; total_time?: number };
        type HistoryRow = { date?: number; friendly_name?: string; user?: string; title?: string; parent_media_index?: number | string; media_index?: number | string; percent_complete?: number; media_type?: string };
        const [windows, users, history, seasons] = await Promise.all([
          tautulli.call<TimeRow[]>("get_item_watch_time_stats", { rating_key: key, query_days: "1,7,30,0" }),
          tautulli.call<UserRow[]>("get_item_user_stats", { rating_key: key }),
          tautulli.call<{ data?: HistoryRow[] }>("get_history", { [kind === "series" ? "grandparent_rating_key" : "rating_key"]: key, length: 10 }),
          kind === "series"
            ? tautulli.call<{ data?: MediaRow[] }>("get_library_media_info", { section_id: entry.sectionId, rating_key: key, length: 500 })
            : Promise.resolve({ data: [] as MediaRow[] }),
        ]);
        const all = (windows ?? []).find((row) => row.query_days === 0);
        return {
          ok: true as const,
          state: "ok" as const,
          webUrl: tautulli.webUrl(`info?rating_key=${key}`),
          plays: num(all?.total_plays),
          seconds: num(all?.total_time),
          windows: (windows ?? []).slice(0, 4).map((row) => ({ days: num(row.query_days), plays: num(row.total_plays), seconds: num(row.total_time) })),
          users: (users ?? [])
            .map((row) => ({ name: text(row.friendly_name, 128) ?? text(row.username, 128) ?? "Unknown", plays: num(row.total_plays), seconds: num(row.total_time) }))
            .sort((a, b) => b.plays - a.plays)
            .slice(0, 10),
          seasons: (seasons.data ?? [])
            .filter((row) => row.media_index !== "" && row.media_index !== undefined)
            .map((row) => ({ seasonNumber: num(row.media_index), plays: num(row.play_count), lastPlayed: iso(num(row.last_played)) }))
            .slice(0, 200),
          recent: (history.data ?? []).slice(0, 10).map((row) => {
            const episode = row.media_type === "episode";
            return {
              at: iso(num(row.date)) ?? new Date(0).toISOString(),
              user: text(row.friendly_name, 128) ?? text(row.user, 128) ?? "Unknown",
              title: text(row.title) ?? "Unknown",
              season: episode ? num(row.parent_media_index) : null,
              episode: episode ? num(row.media_index) : null,
              percent: Math.min(100, num(row.percent_complete)),
            };
          }),
        };
      });
    },

    clear: () => cache.clear(),
  };
}
