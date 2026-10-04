// Exercises the built backend through OpenClaw's real feature-plugin validation path.
import fs from "node:fs";
import http from "node:http";
for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) { const i = line.indexOf("="); if (i > 0) process.env[line.slice(0, i)] = line.slice(i + 1).trim(); }
const { default: plugin } = await import("../dist/index.js");
const actions = {}; let route;
const api = new Proxy({ id: "media-storage", pluginConfig: { sonarr: { url: process.env.SONARR_URL, apiKey: process.env.SONARR_API_KEY }, radarr: { url: process.env.RADARR_URL, apiKey: process.env.RADARR_API_KEY } }, logger: { warn: (m) => console.log("[warn]", m), info() {}, error: console.error },
  registerSessionAction: (a) => (actions[a.id] = a), registerHttpRoute: (r) => (route = r), registerService() {}, registerTool() {} }, { get: (t, k) => t[k] ?? (() => {}) });
plugin.register(api);
const call = async (id, payload) => { const r = await actions[id].handler({ payload }); if (!r.ok) throw new Error(`${id}: ${r.error}`); return r.result; };
const assert = (c, m) => { if (!c) { console.error("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const keys = [process.env.SONARR_API_KEY, process.env.RADARR_API_KEY];
const noKey = (o, m) => assert(!keys.some((k) => JSON.stringify(o).includes(k)), `no API key in ${m}`);

let t = Date.now(); const ov = await call("overview", { refresh: true }); console.log("overview ms", Date.now() - t);
assert(ov.tv.status.state === "ok" && ov.movies.status.state === "ok", `services ok (Sonarr ${ov.tv.status.version}, Radarr ${ov.movies.status.version})`);
assert(ov.combinedBytes === ov.tv.sizeBytes + ov.movies.sizeBytes, `combined ${ov.combinedBytes} = tv ${ov.tv.sizeBytes} + movies ${ov.movies.sizeBytes}`);
noKey(ov, "overview");
const pages = async (op) => { const first = await call(op, { offset: 0, limit: 150 }); let items = [...first.items];
  while (items.length < first.total) { const p = await call(op, { offset: items.length, limit: 150, generation: first.generation }); assert(p.ok, `${op} page ${items.length}`); items.push(...p.items); }
  return items; };
const series = await pages("series"); const movies = await pages("movies");
assert(series.length === ov.tv.itemCount && movies.length === ov.movies.itemCount, `paged ${series.length} series / ${movies.length} movies`);
assert(series.reduce((a, s) => a + s.sizeBytes, 0) === ov.tv.sizeBytes, "series sizes sum to TV total");
assert(series.reduce((a, s) => a + s.fileCount, 0) === ov.tv.fileCount, "series file counts sum to TV file count");
assert(movies.reduce((a, s) => a + s.sizeBytes, 0) === ov.movies.sizeBytes, "movie sizes sum to movie total");
assert(ov.tv.largest.id === series[0].id && ov.movies.largest.id === movies[0].id, `largest: ${ov.tv.largest.title} / ${ov.movies.largest.title}`);
const stale = await call("series", { offset: 0, limit: 10, generation: "bogus" }); assert(!stale.ok && stale.error.code === "stale", "stale generation detected");

// Independent raw reconciliation against Sonarr for multi-episode series + the corrupt one.
const S = new URL("api/v3", process.env.SONARR_URL ?? "http://localhost:8989/").href, H = { headers: { "X-Api-Key": keys[0] } };
for (const id of [5, series.find((s) => /twin peaks/i.test(s.title))?.id ?? 5, series[0].id]) {
  const d = await call("series-detail", { seriesId: id }); assert(d.ok, `series-detail ${id} ${d.title}`);
  assert(d.sizeBytes === d.seasons.reduce((a, s) => a + s.sizeBytes, 0), `  seasons sum to series bytes (${d.sizeBytes})`);
  const summary = series.find((s) => s.id === id);
  assert(summary.sizeBytes === d.sizeBytes && summary.fileCount === d.fileCount, `  detail matches library (${d.fileCount} unique files)`);
  let sFiles = 0, multi = 0;
  for (const season of d.seasons) {
    if (!season.fileCount) continue;
    const f = await call("season-files", { seriesId: id, seasonNumber: season.seasonNumber });
    let files = [...f.files]; while (files.length < f.total) { const n = await call("season-files", { seriesId: id, seasonNumber: season.seasonNumber, offset: files.length }); files.push(...n.files); }
    const ids = new Set(files.map((x) => x.id)); assert(ids.size === files.length, `  S${season.seasonNumber}: ${files.length} files unique`);
    assert(files.reduce((a, x) => a + x.sizeBytes, 0) === season.sizeBytes, `  S${season.seasonNumber}: file bytes == season bytes`);
    multi += files.filter((x) => x.episodes.length > 1).length; sFiles += files.length; noKey(f, "season files");
  }
  assert(sFiles === d.fileCount, `  ${sFiles} files across seasons; ${multi} multi-episode files counted once`);
  const raw = await (await fetch(`${S}/series/${id}`, H)).json();
  assert(raw.statistics.sizeOnDisk === d.sizeBytes, `  bytes match Sonarr statistics exactly (${raw.statistics.sizeOnDisk})`);
  if (raw.statistics.episodeFileCount !== d.fileCount) console.log(`       note: Sonarr episodeFileCount=${raw.statistics.episodeFileCount} counts episodes, unique files=${d.fileCount}`);
  noKey(d, "series detail");
}
const m = await call("movie-detail", { movieId: movies[0].id });
assert(m.ok && m.file && m.file.sizeBytes === movies[0].sizeBytes, `movie-detail ${m.title}: ${m.file.sizeBytes} bytes, ${m.file.spec.resolution} ${m.file.spec.videoCodec}`);
const nf = await call("movie-detail", { movieId: 999999 }); assert(!nf.ok && nf.error.code === "not_found", "missing movie → not_found");

// Artwork route via a real HTTP server.
const srv = http.createServer((q, s) => route.handler(q, s)).listen(0); await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${srv.address().port}`;
for (const [label, url] of [["series poster", series[0].poster], ["movie poster", movies[0].poster], ["series backdrop", ov.tv.largest.backdrop], ["movie backdrop", m.backdrop]]) {
  assert(url && !keys.some((k) => url.includes(k)), `${label} url has no key`);
  const r = await fetch(base + url); const b = await r.arrayBuffer();
  assert(r.status === 200 && /^image\//.test(r.headers.get("content-type")), `${label} → ${r.status} ${r.headers.get("content-type")} ${b.byteLength}B cache=${r.headers.get("cache-control")}`);
  const r2 = await fetch(base + url, { headers: { "If-None-Match": r.headers.get("etag") } }); assert(r2.status === 304, `${label} revalidates 304`);
}
const d5 = await call("series-detail", { seriesId: 5 }); const still = d5.seasons.find((s) => s.artwork)?.artwork;
const rs = await fetch(base + still); assert(rs.status === 200, `season artwork (episode still) → ${rs.status}`);
const tampered = series[0].poster.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
assert((await fetch(base + tampered)).status === 404, "tampered signature → 404");
assert((await fetch(base + series[0].poster, { method: "POST" })).status === 405, "POST → 405");
srv.close();
console.log(process.exitCode ? "FAILURES" : "ALL PASSED");
