// Startup warm-up + stale-while-revalidate behaviour, against the live APIs.
import fs from "node:fs";
for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) { const i = line.indexOf("="); if (i > 0) process.env[line.slice(0, i)] = line.slice(i + 1).trim(); }
const { default: plugin } = await import("../dist/index.js");
const actions = {}, services = [], emitted = [];
const api = new Proxy({ id: "media-storage", pluginConfig: { sonarr: { url: process.env.SONARR_URL, apiKey: process.env.SONARR_API_KEY }, radarr: { url: process.env.RADARR_URL, apiKey: process.env.RADARR_API_KEY } },
  logger: { warn() {} }, registerSessionAction: (a) => (actions[a.id] = a), registerService: (s) => services.push(s) }, { get: (t, k) => t[k] ?? (() => {}) });
plugin.register(api);
const assert = (c, m) => { console.log(c ? "ok  " : "FAIL", m); if (!c) process.exitCode = 1; };
const overview = async (payload = {}) => { const t = Date.now(); const r = await actions.overview.handler({ payload }); return { ms: Date.now() - t, v: r.result }; };
assert(services.some((s) => s.id === "media-storage:warm"), `services registered: ${services.map((s) => s.id).join(", ")}`);
for (const s of services) await s.start({ gatewayEvents: { emit: (e, v) => emitted.push([e, v]) } });
await actions.overview.handler({ payload: {} }); // waits only if the startup scan is still running
await new Promise((r) => setTimeout(r, 100));
let o = await overview(); assert(o.ms < 500 && o.v.tv.itemCount > 0, `first view after warm-up: ${o.ms} ms, ${o.v.tv.itemCount} series`);
o = await overview(); assert(o.ms < 500 && emitted.length === 0, `fresh view: ${o.ms} ms, no rebuild`);
const realNow = Date.now; Date.now = () => realNow() + 11 * 60_000; // pretend 11 minutes passed
o = await overview(); assert(o.ms < 500, `stale view served instantly: ${o.ms} ms (retrievedAt ${o.v.retrievedAt})`);
for (let i = 0; i < 40 && emitted.length < 2; i++) await new Promise((r) => setTimeout(r, 500));
assert(emitted.filter(([e]) => e === "library-updated").length === 2, `background rebuild emitted: ${JSON.stringify(emitted.map(([, v]) => v.library))}`);
const before = o.v.retrievedAt; o = await overview(); assert(o.v.retrievedAt > before, `next read has new snapshot (${o.v.retrievedAt})`);
o = await overview({ refresh: true }); assert(o.ms > 1000, `Refresh button still forces a live pull: ${o.ms} ms`);
Date.now = realNow;
console.log(process.exitCode ? "FAILURES" : "ALL PASSED");
