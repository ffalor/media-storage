import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
/**
 * Artwork delivery.
 *
 * Operations return same-origin paths like `/media-storage/art/v1/<payload>.<sig>`.
 * The payload names an upstream image (a Sonarr/Radarr MediaCover API path, or a
 * public TVDB/TMDB https URL Sonarr/Radarr reported). The HMAC signature is keyed by
 * a secret derived from (but not revealing) the API keys, so the browser can only
 * request artwork the backend itself handed out. API keys never leave this process:
 * the route adds the X-Api-Key header server-side.
 */
export const ART_ROUTE = "/media-storage/art";
const PREFIX = `${ART_ROUTE}/v1/`;
const REMOTE_HOSTS = new Set(["artworks.thetvdb.com", "thetvdb.com", "www.thetvdb.com", "image.tmdb.org", "assets.fanart.tv"]);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_ITEM_BYTES = 3 * 1024 * 1024;
const b64url = (value) => Buffer.from(value).toString("base64url");
export class Artwork {
    clients;
    secret;
    cache = new Map();
    cacheBytes = 0;
    inflight = new Map();
    // Random per-instance signing key, so artwork URLs never depend on (or reveal) the API keys.
    constructor(clients) {
        this.clients = clients;
        this.secret = randomBytes(32);
    }
    sign(payload) {
        return createHmac("sha256", this.secret).update(payload).digest().subarray(0, 18).toString("base64url");
    }
    url(source, ref) {
        const payload = b64url(`${source}|${ref}`);
        return `${PREFIX}${payload}.${this.sign(payload)}`;
    }
    /**
     * Map a Sonarr/Radarr image `url` ("/MediaCover/5/poster.jpg?lastWrite=…") to a signed
     * path for the authenticated mediacover API, optionally selecting a resized variant.
     */
    cover(service, image, variant) {
        const match = image?.url?.match(/\/MediaCover\/(\d+)\/([a-z]+)\.(jpg|png)(?:\?(.*))?$/i);
        if (!match)
            return null;
        const [, id, , ext, query] = match;
        const version = query ? query.replace(/[^a-zA-Z0-9=&_-]/g, "").slice(0, 64) : "";
        const file = ext.toLowerCase() === "png" && !variant.includes("-") ? `${variant}.png` : `${variant}.jpg`;
        return this.url(service === "sonarr" ? "s" : "r", `api/v3/mediacover/${id}/${file}${version ? `?${version}` : ""}`);
    }
    /** Signed proxy path for a public artwork URL reported by Sonarr/Radarr (e.g. episode stills). */
    remote(remoteUrl) {
        if (!remoteUrl)
            return null;
        try {
            const parsed = new URL(remoteUrl);
            if (parsed.protocol !== "https:" || !REMOTE_HOSTS.has(parsed.hostname))
                return null;
            return this.url("x", parsed.toString());
        }
        catch {
            return null;
        }
    }
    verify(pathname) {
        if (!pathname.startsWith(PREFIX))
            return null;
        const token = pathname.slice(PREFIX.length);
        const dot = token.lastIndexOf(".");
        if (dot <= 0 || token.length > 2048)
            return null;
        const payload = token.slice(0, dot);
        const given = Buffer.from(token.slice(dot + 1));
        const expected = Buffer.from(this.sign(payload));
        if (given.length !== expected.length || !timingSafeEqual(given, expected))
            return null;
        const decoded = Buffer.from(payload, "base64url").toString("utf8");
        const bar = decoded.indexOf("|");
        const source = decoded.slice(0, bar);
        if (!["s", "r", "x"].includes(source))
            return null;
        return { source, ref: decoded.slice(bar + 1), key: token.slice(dot + 1) };
    }
    async fetchImage(source, ref, etag) {
        let response;
        if (source === "x") {
            const parsed = new URL(ref);
            if (parsed.protocol !== "https:" || !REMOTE_HOSTS.has(parsed.hostname))
                return null;
            response = await fetch(parsed, { signal: AbortSignal.timeout(15_000), headers: { Accept: "image/*" } });
        }
        else {
            response = await (source === "s" ? this.clients.sonarr : this.clients.radarr).raw(ref);
        }
        const type = response.headers.get("content-type") ?? "";
        if (!response.ok || !/^image\/(jpeg|png|webp|gif|avif)/i.test(type)) {
            await response.body?.cancel().catch(() => { });
            return null;
        }
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (declared > MAX_IMAGE_BYTES) {
            await response.body?.cancel().catch(() => { });
            return null;
        }
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > MAX_IMAGE_BYTES)
            return null;
        return { type: type.split(";")[0], body, etag: `"${etag}"` };
    }
    remember(key, image) {
        if (image.body.length > CACHE_ITEM_BYTES)
            return;
        this.cache.set(key, image);
        this.cacheBytes += image.body.length;
        for (const [oldKey, old] of this.cache) {
            if (this.cacheBytes <= CACHE_BYTES)
                break;
            this.cache.delete(oldKey);
            this.cacheBytes -= old.body.length;
        }
    }
    load(source, ref, key) {
        const cached = this.cache.get(key);
        if (cached) {
            // LRU touch.
            this.cache.delete(key);
            this.cache.set(key, cached);
            return Promise.resolve(cached);
        }
        let pending = this.inflight.get(key);
        if (!pending) {
            pending = this.fetchImage(source, ref, key)
                .catch(() => null)
                .then((image) => {
                if (image)
                    this.remember(key, image);
                return image;
            })
                .finally(() => this.inflight.delete(key));
            this.inflight.set(key, pending);
        }
        return pending;
    }
    clearCache() {
        this.cache.clear();
        this.cacheBytes = 0;
    }
    /** Gateway HTTP route handler (auth: "plugin"; the signature is the capability). */
    handle = async (req, res) => {
        const method = req.method ?? "GET";
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        const send = (status, headers = {}, body) => {
            res.statusCode = status;
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
            for (const [name, value] of Object.entries(headers))
                res.setHeader(name, value);
            res.end(method === "HEAD" ? undefined : body);
            return true;
        };
        if (method !== "GET" && method !== "HEAD")
            return send(405, { Allow: "GET, HEAD" });
        const target = this.verify(pathname);
        if (!target)
            return send(404, { "Cache-Control": "no-store" });
        const etag = `"${target.key}"`;
        if (req.headers["if-none-match"] === etag)
            return send(304, { ETag: etag, "Cache-Control": "private, max-age=604800, immutable" });
        const image = await this.load(target.source, target.ref, target.key);
        if (!image)
            return send(404, { "Cache-Control": "private, max-age=300" });
        return send(200, {
            "Content-Type": image.type,
            "Content-Length": String(image.body.length),
            "Cache-Control": "private, max-age=604800, immutable",
            ETag: image.etag,
        }, image.body);
    };
}
