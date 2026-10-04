import type { ControlUiHost, ControlUiPageTarget } from "openclaw/plugin-sdk/control-ui";
import type {
  EpisodeFileT,
  MediaSpecT,
  MovieDetailT,
  MovieSummaryT,
  OverviewT,
  SeasonFilesT,
  SeriesDetailT,
  SeriesSummaryT,
  ServiceErrorT,
  ServiceStatusT,
} from "../contract.js";
import {
  artwork,
  bytesParts,
  episodeCode,
  exactBytes,
  fmtBitrate,
  fmtBytes,
  fmtDate,
  fmtDuration,
  fmtInt,
  fmtRelative,
  h,
  icon,
  resolutionLabel,
  sizeBlock,
} from "./dom.js";
import { saveTopCount, TOP_COUNTS, type Resource, type Store } from "./store.js";

export const PAGE_ID = "media-storage";

type Route =
  | { view: "overview" }
  | { view: "tv" }
  | { view: "series"; seriesId: number }
  | { view: "season"; seriesId: number; season: number }
  | { view: "movies" }
  | { view: "movie"; movieId: number };

const positive = (value: string | undefined) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export function parseRoute(params: Readonly<Record<string, string>>): Route {
  const series = positive(params.series);
  const movie = positive(params.movie);
  const season = params.season !== undefined && /^\d{1,4}$/.test(params.season) ? Number(params.season) : null;
  if (series && season !== null) return { view: "season", seriesId: series, season };
  if (series) return { view: "series", seriesId: series };
  if (movie) return { view: "movie", movieId: movie };
  if (params.view === "tv") return { view: "tv" };
  if (params.view === "movies") return { view: "movies" };
  return { view: "overview" };
}

function routeParams(route: Route): Record<string, string> {
  switch (route.view) {
    case "overview":
      return {};
    case "tv":
      return { view: "tv" };
    case "movies":
      return { view: "movies" };
    case "series":
      return { view: "tv", series: String(route.seriesId) };
    case "season":
      return { view: "tv", series: String(route.seriesId), season: String(route.season) };
    case "movie":
      return { view: "movies", movie: String(route.movieId) };
  }
}

const section = (route: Route) => (route.view === "overview" ? "overview" : route.view === "tv" || route.view === "series" || route.view === "season" ? "tv" : "movies");
const routeKey = (route: Route) => JSON.stringify(routeParams(route));

/** The native Media Storage page. Owns its DOM; data comes only from the feature client. */
export class MediaStorageApp {
  readonly root: HTMLElement;
  private readonly header: HTMLElement;
  private readonly main: HTMLElement;
  private route: Route;
  private renderedKey = "";
  private presented = true;
  private ticker: number | undefined;
  private readonly cleanup: (() => void)[] = [];
  private focusOnRender = false;
  private gridRefresh: (() => void) | null = null;

  constructor(
    private readonly host: ControlUiHost,
    private readonly store: Store,
    params: Readonly<Record<string, string>>,
  ) {
    this.route = parseRoute(params);
    this.header = h("header", { class: "ms-header" });
    this.main = h("main", { class: "ms-main", id: "ms-main" });
    this.root = h("div", { class: "ms-root" }, this.header, this.main);
    this.cleanup.push(this.store.subscribe(() => this.render()));
    this.startTicker();
    this.render();
    this.ensureData();
  }

  dispose() {
    for (const fn of this.cleanup.splice(0)) fn();
    if (this.ticker) window.clearInterval(this.ticker);
    this.root.remove();
  }

  setPresented(presented: boolean) {
    if (presented === this.presented) return;
    this.presented = presented;
    if (presented) {
      this.startTicker();
      this.render();
    } else if (this.ticker) {
      window.clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  setParams(params: Readonly<Record<string, string>>) {
    const next = parseRoute(params);
    if (routeKey(next) === routeKey(this.route)) return;
    this.route = next;
    this.focusOnRender = true;
    this.ensureData();
    this.render();
  }

  focus() {
    this.root.querySelector<HTMLElement>("[data-ms-heading]")?.focus({ preventScroll: true });
  }

  private startTicker() {
    if (this.ticker) return;
    this.ticker = window.setInterval(() => {
      const stamp = this.header.querySelector<HTMLElement>("[data-ms-updated]");
      const at = this.store.overview.status === "ready" ? this.store.overview.data.retrievedAt : null;
      if (stamp && at) stamp.textContent = `Updated ${fmtRelative(at)}`;
    }, 30_000);
  }

  private ensureData() {
    if (this.store.overview.status === "idle") void this.store.load();
    const route = this.route;
    if (route.view === "series") void this.store.loadSeries(route.seriesId);
    if (route.view === "season") {
      void this.store.loadSeries(route.seriesId);
      void this.store.loadSeason(route.seriesId, route.season);
    }
    if (route.view === "movie") void this.store.loadMovie(route.movieId);
  }

  private go(route: Route) {
    this.host.navigation.openPage({ id: PAGE_ID, params: routeParams(route) });
  }

  private target(route: Route): ControlUiPageTarget {
    return { id: PAGE_ID, params: routeParams(route) };
  }

  /** An anchor with a real href (new-tab friendly) that navigates natively on plain clicks. */
  private link(route: Route, attrs: Record<string, string>, ...children: (Node | string | null)[]) {
    const a = h("a", { ...attrs, href: this.host.navigation.pageHref(this.target(route)) }, ...children);
    a.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      this.go(route);
    });
    return a;
  }

  // ---- Rendering ---------------------------------------------------------------------------

  private render() {
    if (!this.presented) return;
    this.renderHeader();
    const key = routeKey(this.route);
    const changed = key !== this.renderedKey;
    // Library views keep their toolbar (and search focus) while data changes underneath.
    if (!changed && this.gridRefresh) {
      this.gridRefresh();
      return;
    }
    this.gridRefresh = null;
    const view = this.renderView();
    view.classList.add("ms-view");
    if (changed) view.classList.add("ms-enter");
    this.main.replaceChildren(view);
    this.renderedKey = key;
    if (changed && this.focusOnRender) {
      this.focusOnRender = false;
      this.focus();
      this.root.scrollIntoView?.({ block: "start" });
    }
  }

  private renderView(): HTMLElement {
    const route = this.route;
    switch (route.view) {
      case "overview":
        return this.overviewView();
      case "tv":
        return this.libraryView("tv");
      case "movies":
        return this.libraryView("movies");
      case "series":
        return this.seriesView(route.seriesId);
      case "season":
        return this.seasonView(route.seriesId, route.season);
      case "movie":
        return this.movieView(route.movieId);
    }
  }

  private renderHeader() {
    const overview = this.store.overview;
    const data = "data" in overview ? overview.data : undefined;
    const active = section(this.route);
    const tab = (id: "overview" | "tv" | "movies", label: string, route: Route) =>
      this.link(route, { class: `ms-tab${active === id ? " is-active" : ""}`, ...(active === id ? { "aria-current": "page" } : {}) }, label);
    const service = (name: string, status: ServiceStatusT | undefined) => {
      const state = !status ? "pending" : status.state === "ok" ? (status.healthIssues ? "warn" : "ok") : "error";
      const detail = !status
        ? `${name}: checking…`
        : status.state === "ok"
          ? `${name} ${status.version ?? ""} connected${status.healthIssues ? ` · ${status.healthIssues} health notice${status.healthIssues === 1 ? "" : "s"}` : ""}`
          : `${name} unavailable: ${status.error?.message ?? "unknown error"}`;
      return h("span", { class: `ms-svc is-${state}`, title: detail, role: "img", "aria-label": detail }, h("span", { class: "ms-svc__dot" }), name);
    };
    const refreshing = this.store.refreshing || overview.status === "loading";
    const refresh = h(
      "button",
      { class: `ms-btn ms-btn--quiet${refreshing ? " is-busy" : ""}`, type: "button", "aria-label": "Refresh from Sonarr and Radarr", disabled: refreshing },
      icon("refresh"),
      h("span", { class: "ms-btn__label" }, refreshing ? "Refreshing" : "Refresh"),
    );
    refresh.addEventListener("click", () => void this.store.load(true));

    this.header.replaceChildren(
      h(
        "div",
        { class: "ms-header__row" },
        h("div", { class: "ms-brand" }, h("h1", { class: "ms-brand__title" }, "Media Storage")),
        h(
          "div",
          { class: "ms-header__status" },
          h("span", { class: "ms-svcs" }, service("Sonarr", data?.tv.status), service("Radarr", data?.movies.status)),
          h("span", { class: "ms-updated", "data-ms-updated": "", "aria-live": "polite" }, data ? `Updated ${fmtRelative(data.retrievedAt)}` : ""),
          refresh,
        ),
      ),
      h("nav", { class: "ms-tabs", "aria-label": "Media Storage sections" }, tab("overview", "Overview", { view: "overview" }), tab("tv", "TV", { view: "tv" }), tab("movies", "Movies", { view: "movies" })),
    );
  }

  private heading(text: string, cls = "ms-h2") {
    return h("h2", { class: cls, tabindex: "-1", "data-ms-heading": "" }, text);
  }

  private errorState(error: ServiceErrorT, retry: () => void, compact = false) {
    const name = error.service === "sonarr" ? "Sonarr" : "Radarr";
    const title =
      error.code === "not_found"
        ? "Not found"
        : error.code === "unauthorized"
          ? `${name} rejected the API key`
          : error.code === "not_configured"
            ? `${name} isn't configured`
            : `${name} is unavailable`;
    const button = h("button", { class: "ms-btn", type: "button" }, icon("refresh"), "Retry");
    button.addEventListener("click", retry);
    return h(
      "div",
      { class: `ms-state ms-state--error${compact ? " is-compact" : ""}`, role: "alert" },
      icon("alert", "ms-state__icon"),
      h("div", { class: "ms-state__body" }, h("p", { class: "ms-state__title" }, title), h("p", { class: "ms-state__text" }, error.message)),
      button,
    );
  }

  // ---- Overview ----------------------------------------------------------------------------

  private overviewView() {
    const res = this.store.overview;
    const data = "data" in res ? res.data : undefined;
    const view = h("section", { class: "ms-overview", "aria-labelledby": "ms-ov-h" });
    if (!data) {
      if (res.status === "error") {
        view.append(this.errorState(res.error, () => void this.store.load(true)));
        return view;
      }
      view.append(this.overviewSkeleton());
      return view;
    }
    view.append(this.overviewHero(data));
    const features = h("div", { class: "ms-features" });
    if (data.tv.largest) features.append(this.featureCard("Largest series", data.tv.largest, { view: "series", seriesId: data.tv.largest.id }, data.tv.sizeBytes, "tv"));
    if (data.movies.largest) features.append(this.featureCard("Largest movie", data.movies.largest, { view: "movie", movieId: data.movies.largest.id }, data.movies.sizeBytes, "movie"));
    if (features.childElementCount) view.append(features);
    const prefs = this.store.prefs;
    const count = h("select", { class: "ms-select__input", "aria-label": "Number of top items" }, ...TOP_COUNTS.map((n) => h("option", { value: String(n) }, `Top ${n}`)));
    count.value = String(prefs.topCount);
    const ranks = h("div", { class: "ms-ranks" });
    const drawRanks = () => ranks.replaceChildren(this.rankList("Top series", data.tv, "tv"), this.rankList("Top movies", data.movies, "movie"));
    count.addEventListener("change", () => {
      prefs.topCount = Number(count.value);
      saveTopCount(prefs.topCount);
      drawRanks();
    });
    drawRanks();
    view.append(h("div", { class: "ms-ranks__bar" }, h("label", { class: "ms-select" }, h("span", { class: "ms-visually-hidden" }, "Show"), count, icon("chevronDown", "ms-icon ms-select__chev"))), ranks);
    return view;
  }

  private overviewHero(data: OverviewT) {
    const total = bytesParts(data.combinedBytes);
    const tvShare = data.combinedBytes ? data.tv.sizeBytes / data.combinedBytes : 0;
    const bar = h("div", { class: "ms-split", role: "img", "aria-label": `TV ${fmtBytes(data.tv.sizeBytes)}, Movies ${fmtBytes(data.movies.sizeBytes)}` });
    const tv = h("span", { class: "ms-split__tv" });
    const mv = h("span", { class: "ms-split__movies" });
    tv.style.flexGrow = String(Math.max(tvShare, 0));
    mv.style.flexGrow = String(Math.max(1 - tvShare, 0));
    if (data.tv.sizeBytes) bar.append(tv);
    if (data.movies.sizeBytes) bar.append(mv);
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    const legend = (cls: string, name: string, bytes: number, share: number, route: Route, status: ServiceStatusT) =>
      this.link(
        route,
        { class: `ms-legend ${cls}` },
        h("span", { class: "ms-legend__swatch", "aria-hidden": "true" }),
        h("span", { class: "ms-legend__name" }, name),
        status.state === "error" ? h("span", { class: "ms-legend__value is-muted" }, "Unavailable") : h("span", { class: "ms-legend__value", title: exactBytes(bytes) }, fmtBytes(bytes)),
        status.state === "error" ? null : h("span", { class: "ms-legend__pct" }, pct(share)),
      );
    const stat = (label: string, value: number, unavailable: boolean) =>
      h("div", { class: "ms-stat" }, h("dt", { class: "ms-stat__label" }, label), h("dd", { class: "ms-stat__value" }, unavailable ? "—" : fmtInt(value)));
    const tvDown = data.tv.status.state === "error";
    const mvDown = data.movies.status.state === "error";
    return h(
      "div",
      { class: "ms-hero-total" },
      h(
        "div",
        { class: "ms-hero-total__figure" },
        h("h2", { class: "ms-eyebrow", id: "ms-ov-h", tabindex: "-1", "data-ms-heading": "" }, data.complete ? "Total media" : "Total media (partial)"),
        h("p", { class: "ms-total", title: exactBytes(data.combinedBytes) }, h("span", { class: "ms-total__value" }, total.value), h("span", { class: "ms-total__unit" }, total.unit)),
        !data.complete
          ? h("p", { class: "ms-note" }, icon("alert"), `${tvDown ? "Sonarr" : "Radarr"} is unavailable, so this total only includes ${tvDown ? "movies" : "TV"}.`)
          : null,
      ),
      h(
        "div",
        { class: "ms-hero-total__split" },
        bar,
        h(
          "div",
          { class: "ms-legends" },
          legend("is-tv", "TV", data.tv.sizeBytes, tvShare, { view: "tv" }, data.tv.status),
          legend("is-movies", "Movies", data.movies.sizeBytes, 1 - tvShare, { view: "movies" }, data.movies.status),
        ),
      ),
      h(
        "dl",
        { class: "ms-stats" },
        stat("Series", data.tv.itemCount, tvDown),
        stat("Episode files", data.tv.fileCount, tvDown),
        stat("Movies", data.movies.itemCount, mvDown),
        stat("Movie files", data.movies.fileCount, mvDown),
      ),
    );
  }

  private featureCard(eyebrow: string, item: OverviewT["tv"]["top"][number], route: Route, total: number, kind: "tv" | "movie") {
    const share = total ? item.sizeBytes / total : 0;
    return this.link(
      route,
      { class: `ms-feature is-${kind}`, "aria-label": `${eyebrow}: ${item.title}, ${fmtBytes(item.sizeBytes)}` },
      artwork(item.backdrop ?? item.poster, "", "ms-feature__backdrop", { eager: true, fallback: "" }),
      h("span", { class: "ms-feature__scrim", "aria-hidden": "true" }),
      h(
        "span",
        { class: "ms-feature__content" },
        artwork(item.poster, item.title, "ms-feature__poster", { eager: true }),
        h(
          "span",
          { class: "ms-feature__text" },
          h("span", { class: "ms-eyebrow" }, eyebrow),
          h("span", { class: "ms-feature__title" }, item.title),
          h("span", { class: "ms-feature__meta" }, sizeBlock(item.sizeBytes, "ms-size ms-size--lg"), h("span", { class: "ms-feature__share" }, `${(share * 100).toFixed(1)}% of ${kind === "tv" ? "TV" : "movies"}`)),
        ),
      ),
    );
  }

  private rankList(title: string, totals: OverviewT["tv"], kind: "tv" | "movie") {
    const wrap = h("section", { class: "ms-rank" }, h("h3", { class: "ms-h3" }, title));
    if (totals.status.state === "error" && totals.status.error) {
      wrap.append(this.errorState(totals.status.error, () => void this.store.load(true), true));
      return wrap;
    }
    const top = totals.top.slice(0, this.store.prefs.topCount);
    const list = h("ol", { class: "ms-rank__list" });
    top.forEach((item, index) => {
      const route: Route = kind === "tv" ? { view: "series", seriesId: item.id } : { view: "movie", movieId: item.id };
      list.append(
        h(
          "li",
          null,
          this.link(
            route,
            { class: "ms-rank__row" },
            h("span", { class: "ms-rank__n" }, String(index + 1)),
            artwork(item.poster, item.title, "ms-rank__poster"),
            h("span", { class: "ms-rank__body" }, h("span", { class: "ms-rank__title" }, item.title, item.year ? h("span", { class: "ms-rank__year" }, ` ${item.year}`) : null)),
            h("span", { class: "ms-rank__size" }, sizeBlock(item.sizeBytes, "ms-size ms-size--row"), sharePct(item.sizeBytes, totals.sizeBytes)),
          ),
        ),
      );
    });
    if (top.length) wrap.append(stackBar(top, totals.sizeBytes, kind, kind === "tv" ? "TV" : "movies"));
    if (!totals.top.length) list.append(h("li", { class: "ms-empty-line" }, "Nothing on disk yet."));
    const more = this.link(kind === "tv" ? { view: "tv" } : { view: "movies" }, { class: "ms-more" }, kind === "tv" ? "All series" : "All movies", icon("chevronRight"));
    wrap.append(list, more);
    return wrap;
  }

  private overviewSkeleton() {
    return h(
      "div",
      { class: "ms-skel-overview", "aria-busy": "true", "aria-label": "Loading storage overview" },
      h("div", { class: "ms-hero-total" }, h("div", null, h("span", { class: "ms-skel ms-skel--eyebrow" }), h("span", { class: "ms-skel ms-skel--total" })), h("div", null, h("span", { class: "ms-skel ms-skel--bar" }), h("span", { class: "ms-skel ms-skel--line" })), h("div", { class: "ms-stats" }, ...Array.from({ length: 4 }, () => h("span", { class: "ms-skel ms-skel--stat" })))),
      h("div", { class: "ms-features" }, h("span", { class: "ms-skel ms-skel--feature" }), h("span", { class: "ms-skel ms-skel--feature" })),
    );
  }

  // ---- Libraries ---------------------------------------------------------------------------

  private libraryView(kind: "tv" | "movies") {
    const isTv = kind === "tv";
    const prefs = this.store.prefs;
    const view = h("section", { class: "ms-library", "aria-labelledby": "ms-lib-h" });
    const search = h("input", {
      class: "ms-search__input",
      type: "search",
      placeholder: isTv ? "Search series" : "Search movies",
      "aria-label": isTv ? "Search series" : "Search movies",
      autocomplete: "off",
      spellcheck: "false",
      value: isTv ? prefs.tvQuery : prefs.movieQuery,
    });
    const sortOptions: [string, string][] = isTv
      ? [["size-desc", "Largest first"], ["size-asc", "Smallest first"], ["title", "Title A–Z"], ["seasons", "Most seasons"], ["files", "Most files"]]
      : [["size-desc", "Largest first"], ["size-asc", "Smallest first"], ["title", "Title A–Z"], ["year-desc", "Newest"], ["year-asc", "Oldest"]];
    const sort = h("select", { class: "ms-select__input", "aria-label": "Sort" }, ...sortOptions.map(([value, label]) => h("option", { value }, label)));
    sort.value = isTv ? prefs.tvSort : prefs.movieSort;
    const summary = h("p", { class: "ms-library__summary", "aria-live": "polite" });
    const grid = h("div", { class: "ms-grid", role: "list" });
    const body = h("div", { class: "ms-library__body" });

    view.append(
      h(
        "div",
        { class: "ms-toolbar" },
        h("h2", { class: "ms-h2 ms-toolbar__title", id: "ms-lib-h", tabindex: "-1", "data-ms-heading": "" }, isTv ? "TV" : "Movies"),
        h("label", { class: "ms-search" }, icon("search", "ms-icon ms-search__icon"), search),
        h("label", { class: "ms-select" }, h("span", { class: "ms-visually-hidden" }, "Sort by"), sort, icon("chevronDown", "ms-icon ms-select__chev")),
      ),
      summary,
      body,
    );

    let frame = 0;
    const draw = () => {
      const res = isTv ? this.store.series : this.store.movies;
      const items = "data" in res ? res.data : undefined;
      if (!items) {
        summary.textContent = "";
        if (res.status === "error") body.replaceChildren(this.errorState(res.error, () => void this.store.load(false)));
        else body.replaceChildren(this.gridSkeleton());
        return;
      }
      const query = (isTv ? prefs.tvQuery : prefs.movieQuery).trim().toLocaleLowerCase();
      const filtered = query ? items.filter((item) => item.title.toLocaleLowerCase().includes(query) || String(item.year) === query) : items.slice();
      const mode = isTv ? prefs.tvSort : prefs.movieSort;
      const byTitle = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", ignorePunctuation: true });
      filtered.sort((a, b) => {
        switch (mode) {
          case "size-asc":
            return a.sizeBytes - b.sizeBytes || byTitle(a, b);
          case "title":
            return byTitle(a, b);
          case "seasons":
            return (b as SeriesSummaryT).seasonCount - (a as SeriesSummaryT).seasonCount || b.sizeBytes - a.sizeBytes;
          case "files":
            return (b as SeriesSummaryT).fileCount - (a as SeriesSummaryT).fileCount || b.sizeBytes - a.sizeBytes;
          case "year-desc":
            return b.year - a.year || byTitle(a, b);
          case "year-asc":
            return (a.year || 9999) - (b.year || 9999) || byTitle(a, b);
          default:
            return b.sizeBytes - a.sizeBytes || byTitle(a, b);
        }
      });
      // Shares are of the whole library, so they stay fixed while searching.
      const libraryBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
      const totalBytes = filtered.reduce((sum, item) => sum + item.sizeBytes, 0);
      const noun = isTv ? (filtered.length === 1 ? "series" : "series") : filtered.length === 1 ? "movie" : "movies";
      summary.textContent = `${fmtInt(filtered.length)} ${noun}${query ? ` matching “${query}”` : ""} · ${fmtBytes(totalBytes)}`;
      summary.title = exactBytes(totalBytes);
      if (!filtered.length) {
        body.replaceChildren(
          h("div", { class: "ms-state" }, icon(isTv ? "tv" : "film", "ms-state__icon"), h("div", { class: "ms-state__body" }, h("p", { class: "ms-state__title" }, query ? "No matches" : isTv ? "No series yet" : "No movies yet"), h("p", { class: "ms-state__text" }, query ? "Try a different title or year." : `${isTv ? "Sonarr" : "Radarr"} has no items in its library.`))),
        );
        return;
      }
      grid.replaceChildren(...filtered.map((item) => (isTv ? this.seriesCard(item as SeriesSummaryT, libraryBytes) : this.movieCard(item as MovieSummaryT, libraryBytes))));
      if (body.firstChild !== grid) body.replaceChildren(grid);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };
    search.addEventListener("input", () => {
      if (isTv) prefs.tvQuery = search.value;
      else prefs.movieQuery = search.value;
      schedule();
    });
    search.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && search.value) {
        event.stopPropagation();
        search.value = "";
        search.dispatchEvent(new Event("input"));
      }
    });
    sort.addEventListener("change", () => {
      if (isTv) prefs.tvSort = sort.value;
      else prefs.movieSort = sort.value;
      draw();
    });
    draw();
    let lastRes: unknown = isTv ? this.store.series : this.store.movies;
    this.gridRefresh = () => {
      const res = isTv ? this.store.series : this.store.movies;
      if (res === lastRes) return;
      lastRes = res;
      draw();
    };
    return view;
  }

  private seriesCard(item: SeriesSummaryT, libraryBytes: number) {
    return h(
      "div",
      { role: "listitem", class: "ms-card-wrap" },
      this.link(
        { view: "series", seriesId: item.id },
        { class: "ms-card", "aria-label": `${item.title}, ${fmtBytes(item.sizeBytes)}, ${item.seasonCount} seasons, ${item.fileCount} files` },
        h("span", { class: "ms-card__poster" }, artwork(item.poster, item.title, "ms-poster")),
        h(
          "span",
          { class: "ms-card__body" },
          h("span", { class: "ms-card__title" }, item.title),
          h("span", { class: "ms-card__size" }, sizeBlock(item.sizeBytes), sharePct(item.sizeBytes, libraryBytes)),
          h("span", { class: "ms-card__meta" }, `${item.seasonCount} ${item.seasonCount === 1 ? "season" : "seasons"} · ${fmtInt(item.fileCount)} ${item.fileCount === 1 ? "file" : "files"}`),
        ),
      ),
    );
  }

  private movieCard(item: MovieSummaryT, libraryBytes: number) {
    const res = resolutionLabel(item.resolution);
    return h(
      "div",
      { role: "listitem", class: "ms-card-wrap" },
      this.link(
        { view: "movie", movieId: item.id },
        { class: `ms-card${item.hasFile ? "" : " is-missing-file"}`, "aria-label": `${item.title}${item.year ? ` (${item.year})` : ""}, ${item.hasFile ? fmtBytes(item.sizeBytes) : "no file"}` },
        h("span", { class: "ms-card__poster" }, artwork(item.poster, item.title, "ms-poster"), res ? h("span", { class: "ms-card__badge", "aria-hidden": "true" }, res) : null),
        h(
          "span",
          { class: "ms-card__body" },
          h("span", { class: "ms-card__title" }, item.title),
          h("span", { class: "ms-card__size" }, ...(item.hasFile ? [sizeBlock(item.sizeBytes), sharePct(item.sizeBytes, libraryBytes)] : [h("span", { class: "ms-card__nofile" }, "No file")])),
          h("span", { class: "ms-card__meta" }, item.year ? String(item.year) : "—"),
        ),
      ),
    );
  }

  private gridSkeleton() {
    return h(
      "div",
      { class: "ms-grid", "aria-busy": "true", "aria-label": "Loading library" },
      ...Array.from({ length: 18 }, () => h("div", { class: "ms-card-wrap" }, h("div", { class: "ms-card is-skeleton" }, h("span", { class: "ms-card__poster ms-skel" }), h("span", { class: "ms-card__body" }, h("span", { class: "ms-skel ms-skel--line" }), h("span", { class: "ms-skel ms-skel--short" }))))),
    );
  }

  // ---- Series / season ---------------------------------------------------------------------

  private crumbs(...parts: [string, Route | null][]) {
    const nav = h("nav", { class: "ms-crumbs", "aria-label": "Breadcrumb" });
    const list = h("ol", null);
    parts.forEach(([label, route], index) => {
      const last = index === parts.length - 1;
      const item = h("li", null);
      if (index === 0 && route) {
        item.append(this.link(route, { class: "ms-crumbs__back", "aria-label": `Back to ${label}` }, icon("chevronLeft"), h("span", null, label)));
      } else if (route && !last) item.append(this.link(route, {}, label));
      else item.append(h("span", { "aria-current": "page" }, label));
      list.append(item);
    });
    nav.append(list);
    return nav;
  }

  private seriesView(seriesId: number) {
    const res = this.store.seriesDetail.get(seriesId) ?? ({ status: "loading" } as Resource<SeriesDetailT>);
    const summary = this.findSeries(seriesId);
    const data = "data" in res ? res.data : undefined;
    const title = data?.title ?? summary?.title ?? "Series";
    const view = h("article", { class: "ms-detail" });
    view.append(this.crumbs(["TV", { view: "tv" }], [title, null]));
    view.append(
      this.hero({
        title,
        backdrop: data?.backdrop ?? null,
        poster: data?.poster ?? summary?.poster ?? null,
        meta: data ? [data.year ? String(data.year) : null, data.network, cap(data.status), data.certification, data.runtime ? `${data.runtime} min` : null] : [summary?.year ? String(summary.year) : null, summary?.network ?? null],
        sizeBytes: data?.sizeBytes ?? summary?.sizeBytes ?? null,
        facts: data ? [[fmtInt(data.seasonCount), data.seasonCount === 1 ? "season" : "seasons"], [fmtInt(data.fileCount), data.fileCount === 1 ? "file" : "files"]] : summary ? [[fmtInt(summary.seasonCount), "seasons"], [fmtInt(summary.fileCount), "files"]] : [],
        overview: data?.overview ?? null,
        link: data?.webUrl ? { href: data.webUrl, service: "Sonarr" } : null,
        kind: "tv",
      }),
    );
    if (res.status === "error") {
      view.append(this.errorState(res.error, () => void this.store.loadSeries(seriesId, true)));
      return view;
    }
    const seasonsWrap = h("section", { class: "ms-section", "aria-labelledby": "ms-seasons-h" }, h("h2", { class: "ms-h3", id: "ms-seasons-h" }, "Seasons"));
    if (!data) {
      seasonsWrap.append(h("div", { class: "ms-seasons", "aria-busy": "true" }, ...Array.from({ length: 6 }, () => h("div", { class: "ms-season is-skeleton" }, h("span", { class: "ms-season__art ms-skel" }), h("span", { class: "ms-season__body" }, h("span", { class: "ms-skel ms-skel--line" }), h("span", { class: "ms-skel ms-skel--short" }))))));
      view.append(seasonsWrap);
      return view;
    }
    const grid = h("ol", { class: "ms-seasons" });
    for (const season of data.seasons) {
      const empty = season.fileCount === 0;
      const meta = empty ? `Nothing on disk · ${season.totalEpisodes} ${season.totalEpisodes === 1 ? "episode" : "episodes"}` : `${fmtInt(season.fileCount)} ${season.fileCount === 1 ? "file" : "files"} · ${season.episodeFileCount}/${season.totalEpisodes} episodes`;
      const content = [
        artwork(season.artwork ?? data.backdrop, `${season.label} artwork`, "ms-season__art", { fallback: season.seasonNumber === 0 ? "SP" : String(season.seasonNumber) }),
        h(
          "span",
          { class: "ms-season__body" },
          h("span", { class: "ms-season__name" }, season.label),
          h("span", { class: "ms-season__size" }, sizeBlock(season.sizeBytes), sharePct(season.sizeBytes, data.sizeBytes)),
          h("span", { class: "ms-season__meta" }, meta),
        ),
      ];
      grid.append(
        h(
          "li",
          null,
          empty
            ? h("div", { class: "ms-season is-empty", "aria-label": `${season.label}: nothing on disk` }, ...content)
            : this.link({ view: "season", seriesId, season: season.seasonNumber }, { class: "ms-season", "aria-label": `${season.label}, ${fmtBytes(season.sizeBytes)}, ${season.fileCount} files` }, ...content),
        ),
      );
    }
    seasonsWrap.append(grid);
    view.append(seasonsWrap);
    return view;
  }

  private seasonView(seriesId: number, seasonNumber: number) {
    const key = `${seriesId}:${seasonNumber}`;
    const res = this.store.seasonFiles.get(key) ?? ({ status: "loading" } as Resource<SeasonFilesT>);
    const data = "data" in res ? res.data : undefined;
    const series = this.store.seriesDetail.get(seriesId);
    const seriesData = series && "data" in series ? series.data : undefined;
    const seriesTitle = data?.seriesTitle ?? seriesData?.title ?? this.findSeries(seriesId)?.title ?? "Series";
    const label = data?.label ?? (seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`);
    const view = h("article", { class: "ms-detail ms-season-view" });
    view.append(this.crumbs(["TV", { view: "tv" }], [seriesTitle, { view: "series", seriesId }], [label, null]));

    const seasonInfo = seriesData?.seasons.find((s) => s.seasonNumber === seasonNumber);
    const header = h(
      "header",
      { class: "ms-season-head" },
      artwork(seasonInfo?.artwork ?? data?.backdrop ?? seriesData?.backdrop ?? null, "", "ms-season-head__art", { eager: true, fallback: "" }),
      h("span", { class: "ms-season-head__scrim", "aria-hidden": "true" }),
      h(
        "div",
        { class: "ms-season-head__text" },
        h("p", { class: "ms-eyebrow" }, seriesTitle),
        h("h2", { class: "ms-h1", tabindex: "-1", "data-ms-heading": "" }, label),
        data ? h("p", { class: "ms-season-head__meta" }, sizeBlock(data.sizeBytes, "ms-size ms-size--lg"), h("span", null, `${fmtInt(data.total)} unique ${data.total === 1 ? "file" : "files"}`)) : h("span", { class: "ms-skel ms-skel--line" }),
        data?.webUrl ? serviceLink(data.webUrl, "Sonarr") : null,
      ),
    );
    view.append(header);
    if (res.status === "error") {
      view.append(this.errorState(res.error, () => void this.store.loadSeason(seriesId, seasonNumber, true)));
      return view;
    }
    const prefs = this.store.prefs;
    const list = h("ol", { class: "ms-files" });
    const segmented = h("div", { class: "ms-segmented", role: "radiogroup", "aria-label": "Order files" });
    const option = (value: "size" | "episode", text: string) => {
      const button = h("button", { type: "button", role: "radio", class: "ms-segmented__opt", "aria-checked": prefs.fileSort === value ? "true" : "false" }, text);
      button.addEventListener("click", () => {
        prefs.fileSort = value;
        for (const el of segmented.querySelectorAll("button")) el.setAttribute("aria-checked", String(el === button));
        drawFiles();
      });
      button.addEventListener("keydown", (event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          const buttons = [...segmented.querySelectorAll("button")];
          const next = buttons[(buttons.indexOf(button) + 1) % buttons.length]!;
          next.click();
          next.focus();
        }
      });
      return button;
    };
    segmented.append(option("size", "Largest first"), option("episode", "Episode order"));
    const drawFiles = () => {
      if (!data) return;
      const files = data.files.slice();
      if (prefs.fileSort === "episode") files.sort((a, b) => (a.episodes[0]?.number ?? 1e9) - (b.episodes[0]?.number ?? 1e9));
      list.replaceChildren(...files.map((file) => this.fileRow(file, seasonNumber, data.sizeBytes)));
    };
    const section = h("section", { class: "ms-section", "aria-label": "Media files" }, h("div", { class: "ms-section__head" }, h("h3", { class: "ms-h3" }, "Files"), segmented));
    if (!data) {
      section.append(h("div", { class: "ms-files", "aria-busy": "true" }, ...Array.from({ length: 6 }, () => h("div", { class: "ms-file is-skeleton" }, h("span", { class: "ms-file__still ms-skel" }), h("span", { class: "ms-file__body" }, h("span", { class: "ms-skel ms-skel--line" }), h("span", { class: "ms-skel ms-skel--short" }))))));
    } else if (!data.files.length) {
      section.append(h("div", { class: "ms-state" }, icon("file", "ms-state__icon"), h("div", { class: "ms-state__body" }, h("p", { class: "ms-state__title" }, "No files on disk"), h("p", { class: "ms-state__text" }, "Sonarr has no media files for this season."))));
    } else {
      drawFiles();
      section.append(list);
    }
    view.append(section);
    return view;
  }

  private fileRow(file: EpisodeFileT, season: number, seasonBytes: number) {
    const spec = file.spec;
    const titles = file.episodes.map((e) => e.title).join(" · ") || "Unknown episode";
    const chips = [resolutionLabel(spec.resolutionClass) ?? spec.resolution, spec.quality, [spec.videoCodec, spec.dynamicRange].filter(Boolean).join(" "), spec.audio, spec.runtime ? fmtDuration(spec.runtimeSeconds) ?? spec.runtime : null].filter((v): v is string => Boolean(v));
    return h(
      "li",
      { class: "ms-file" },
      artwork(file.still, "", "ms-file__still", { fallback: episodeCode(season, file.episodes) }),
      h(
        "div",
        { class: "ms-file__body" },
        h("p", { class: "ms-file__code" }, episodeCode(season, file.episodes), file.episodes.length > 1 ? h("span", { class: "ms-file__multi" }, `${file.episodes.length} episodes, one file`) : null),
        h("p", { class: "ms-file__title" }, titles),
        file.fileName ? h("p", { class: "ms-file__name", title: file.path ?? file.fileName }, file.fileName) : h("p", { class: "ms-file__name is-warn" }, "Sonarr could not read this file record. Size is derived from the season total."),
        chips.length ? h("p", { class: "ms-file__spec" }, ...chips.map((chip) => h("span", null, chip))) : null,
      ),
      h("div", { class: "ms-file__size" }, sizeBlock(file.sizeBytes, "ms-size ms-size--row"), sharePct(file.sizeBytes, seasonBytes), file.sizeDerived ? h("span", { class: "ms-file__derived" }, "derived") : null),
    );
  }

  // ---- Movie -------------------------------------------------------------------------------

  private movieView(movieId: number) {
    const res = this.store.movieDetail.get(movieId) ?? ({ status: "loading" } as Resource<MovieDetailT>);
    const summary = this.findMovie(movieId);
    const data = "data" in res ? res.data : undefined;
    const title = data?.title ?? summary?.title ?? "Movie";
    const view = h("article", { class: "ms-detail" });
    view.append(this.crumbs(["Movies", { view: "movies" }], [title, null]));
    const spec = data?.file?.spec;
    view.append(
      this.hero({
        title,
        backdrop: data?.backdrop ?? null,
        poster: data?.poster ?? summary?.poster ?? null,
        meta: data
          ? [data.year ? String(data.year) : null, data.runtimeMinutes ? fmtDuration(data.runtimeMinutes * 60) : null, data.certification, data.studio]
          : [summary?.year ? String(summary.year) : null],
        sizeBytes: data ? (data.hasFile ? data.sizeBytes : null) : (summary?.sizeBytes ?? null),
        facts: spec ? ([[resolutionLabel(spec.resolutionClass) ?? spec.resolution ?? "—", spec.quality ?? ""], [spec.videoCodec ?? "—", spec.dynamicRange ?? "video"]] as [string, string][]) : [],
        overview: data?.overview ?? null,
        link: data?.webUrl ? { href: data.webUrl, service: "Radarr" } : null,
        kind: "movie",
      }),
    );
    if (res.status === "error") {
      view.append(this.errorState(res.error, () => void this.store.loadMovie(movieId, true)));
      return view;
    }
    if (!data) {
      view.append(h("section", { class: "ms-section", "aria-busy": "true" }, h("span", { class: "ms-skel ms-skel--panel" })));
      return view;
    }
    if (!data.file) {
      view.append(h("div", { class: "ms-state" }, icon("film", "ms-state__icon"), h("div", { class: "ms-state__body" }, h("p", { class: "ms-state__title" }, "No file on disk"), h("p", { class: "ms-state__text" }, "Radarr is tracking this movie but has no media file for it, so it uses no storage."))));
      return view;
    }
    view.append(this.whySection(data.file.sizeBytes, data.file.spec, data.runtimeMinutes), this.specSection(data.file));
    return view;
  }

  /** Explain the footprint: bytes over runtime is the average bitrate actually spent. */
  private whySection(bytes: number, spec: MediaSpecT, runtimeMinutes: number) {
    const seconds = spec.runtimeSeconds || runtimeMinutes * 60;
    const average = seconds ? (bytes * 8) / seconds : 0;
    const perHour = seconds ? (bytes / seconds) * 3600 : 0;
    const cell = (label: string, value: string | null, note?: string | null) =>
      value ? h("div", { class: "ms-why__cell" }, h("dt", null, label), h("dd", null, value, note ? h("span", { class: "ms-why__note" }, note) : null)) : null;
    return h(
      "section",
      { class: "ms-section", "aria-labelledby": "ms-why-h" },
      h("h3", { class: "ms-h3", id: "ms-why-h" }, "Why it's this size"),
      h(
        "dl",
        { class: "ms-why" },
        cell("Average bitrate", fmtBitrate(average), "size ÷ runtime"),
        cell("Per hour", perHour ? fmtBytes(perHour) : null),
        cell("Runtime", fmtDuration(seconds)),
        cell("Video", [resolutionLabel(spec.resolutionClass), spec.videoCodec, spec.dynamicRange, spec.bitDepth ? `${spec.bitDepth}-bit` : null].filter(Boolean).join(" · ") || null),
      ),
    );
  }

  private specSection(file: NonNullable<MovieDetailT["file"]>) {
    const s = file.spec;
    const row = (label: string, value: string | null | undefined, mono = false) =>
      value ? h("div", { class: "ms-spec__row" }, h("dt", null, label), h("dd", { class: mono ? "is-mono" : "" }, value)) : null;
    return h(
      "section",
      { class: "ms-section", "aria-labelledby": "ms-file-h" },
      h("h3", { class: "ms-h3", id: "ms-file-h" }, "File"),
      h(
        "dl",
        { class: "ms-spec" },
        row("Size", `${fmtBytes(file.sizeBytes)} (${exactBytes(file.sizeBytes)})`),
        row("Filename", file.fileName, true),
        row("Path", file.path, true),
        row("Quality", s.quality),
        row("Resolution", s.resolution),
        row("Video", [s.videoCodec, s.dynamicRange, s.bitDepth ? `${s.bitDepth}-bit` : null, s.videoBitrate ? fmtBitrate(s.videoBitrate) : null].filter(Boolean).join(" · ") || null),
        row("Audio", [s.audio, s.audioLanguages].filter(Boolean).join(" · ") || null),
        row("Subtitles", s.subtitles),
        row("Runtime", s.runtime),
        row("Edition", file.edition),
        row("Release group", file.releaseGroup),
        row("Added", fmtDate(file.dateAdded)),
      ),
    );
  }

  // ---- Shared ------------------------------------------------------------------------------

  private hero(opts: {
    title: string;
    backdrop: string | null;
    poster: string | null;
    meta: (string | null)[];
    sizeBytes: number | null;
    facts: [string, string][];
    overview: string | null;
    link: { href: string; service: string } | null;
    kind: "tv" | "movie";
  }) {
    return h(
      "header",
      { class: `ms-hero is-${opts.kind}` },
      h("div", { class: "ms-hero__backdrop" }, artwork(opts.backdrop, "", "ms-hero__img", { eager: true, fallback: "" }), h("span", { class: "ms-hero__scrim", "aria-hidden": "true" })),
      h(
        "div",
        { class: "ms-hero__content" },
        artwork(opts.poster, opts.title, "ms-hero__poster", { eager: true }),
        h(
          "div",
          { class: "ms-hero__text" },
          h("h2", { class: "ms-h1", tabindex: "-1", "data-ms-heading": "" }, opts.title),
          h("p", { class: "ms-hero__meta" }, opts.meta.filter(Boolean).join(" · ")),
          h(
            "div",
            { class: "ms-hero__figures" },
            opts.sizeBytes !== null ? sizeBlock(opts.sizeBytes, "ms-size ms-size--xl") : h("span", { class: "ms-skel ms-skel--size" }),
            ...opts.facts.map(([value, label]) => h("span", { class: "ms-fact" }, h("strong", null, value), label ? ` ${label}` : "")),
          ),
          opts.overview ? h("p", { class: "ms-hero__overview" }, opts.overview) : null,
          opts.link ? serviceLink(opts.link.href, opts.link.service) : null,
        ),
      ),
    );
  }

  private findSeries(id: number) {
    const res = this.store.series;
    return "data" in res ? res.data?.find((item) => item.id === id) : undefined;
  }

  private findMovie(id: number) {
    const res = this.store.movies;
    return "data" in res ? res.data?.find((item) => item.id === id) : undefined;
  }
}

function cap(value: string | null) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : null;
}

/** Opens the item's page in the Sonarr/Radarr web UI in a new tab. */
function serviceLink(href: string, service: string) {
  return h(
    "a",
    { class: "ms-service-link", href, target: "_blank", rel: "noopener noreferrer", "aria-label": `Open in ${service} (new tab)` },
    `Open in ${service}`,
    icon("external", "ms-icon ms-icon--sm"),
  );
}

/** Share of the whole library, as muted text beside a size. */
function sharePct(bytes: number, total: number) {
  const pct = total > 0 ? (bytes / total) * 100 : 0;
  const text = pct === 0 ? "0%" : pct < 0.1 ? "<0.1%" : pct < 1 ? `${pct.toFixed(2)}%` : `${pct.toFixed(1)}%`;
  return h("span", { class: "ms-pct", title: "Share of library" }, text);
}

/** One bar per list: a segment for each top item, then everything else. */
function stackBar(top: { title: string; sizeBytes: number }[], total: number, kind: "tv" | "movie", scope: string) {
  const topBytes = top.reduce((sum, item) => sum + item.sizeBytes, 0);
  const pct = (bytes: number) => (total > 0 ? (bytes / total) * 100 : 0);
  const share = `${pct(topBytes).toFixed(1)}%`;
  const bar = h("div", { class: "ms-stack__bar", role: "img", "aria-label": `Top ${top.length} use ${share} of ${scope}` });
  for (const item of top) {
    const seg = h("span", { class: "ms-stack__seg", title: `${item.title} · ${pct(item.sizeBytes).toFixed(1)}%` });
    seg.style.width = `${pct(item.sizeBytes).toFixed(3)}%`;
    bar.append(seg);
  }
  return h(
    "div",
    { class: `ms-stack is-${kind}` },
    h("div", { class: "ms-stack__head" }, h("span", null, `Top ${top.length} use `, h("strong", null, share), ` of ${scope}`), h("span", { class: "ms-stack__total" }, `${fmtBytes(topBytes)} of ${fmtBytes(total)}`)),
    bar,
    h("div", { class: "ms-stack__legend" }, h("span", null, h("i", { class: "ms-stack__key" }), `Top ${top.length}`), h("span", null, h("i", { class: "ms-stack__key is-rest" }), `Everything else · ${fmtBytes(Math.max(0, total - topBytes))}`)),
  );
}
