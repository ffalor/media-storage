import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArrClient } from "./arr.js";

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

type Source = "s" | "r" | "x";
type Image = { type: string; body: Buffer; etag: string };

const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

export type MediaCoverVariant = "poster" | "poster-500" | "poster-250" | "fanart" | "fanart-360";

export class Artwork {
  private readonly secret: Buffer;
  private readonly cache = new Map<string, Image>();
  private cacheBytes = 0;
  private readonly inflight = new Map<string, Promise<Image | null>>();

  constructor(
    private readonly clients: { sonarr: ArrClient; radarr: ArrClient },
    keys: readonly (string | undefined)[],
  ) {
    this.secret = createHash("sha256")
      .update("openclaw/media-storage/artwork/v1\0")
      .update(keys.map((key) => key ?? "").join("\0"))
      .digest();
  }

  private sign(payload: string) {
    return createHmac("sha256", this.secret).update(payload).digest().subarray(0, 18).toString("base64url");
  }

  private url(source: Source, ref: string) {
    const payload = b64url(`${source}|${ref}`);
    return `${PREFIX}${payload}.${this.sign(payload)}`;
  }

  /**
   * Map a Sonarr/Radarr image `url` ("/MediaCover/5/poster.jpg?lastWrite=…") to a signed
   * path for the authenticated mediacover API, optionally selecting a resized variant.
   */
  cover(service: "sonarr" | "radarr", image: { url?: string | null } | undefined, variant: MediaCoverVariant): string | null {
    const match = image?.url?.match(/\/MediaCover\/(\d+)\/([a-z]+)\.(jpg|png)(?:\?(.*))?$/i);
    if (!match) return null;
    const [, id, , ext, query] = match;
    const version = query ? query.replace(/[^a-zA-Z0-9=&_-]/g, "").slice(0, 64) : "";
    const file = ext!.toLowerCase() === "png" && !variant.includes("-") ? `${variant}.png` : `${variant}.jpg`;
    return this.url(service === "sonarr" ? "s" : "r", `api/v3/mediacover/${id}/${file}${version ? `?${version}` : ""}`);
  }

  /** Signed proxy path for a public artwork URL reported by Sonarr/Radarr (e.g. episode stills). */
  remote(remoteUrl: string | null | undefined): string | null {
    if (!remoteUrl) return null;
    try {
      const parsed = new URL(remoteUrl);
      if (parsed.protocol !== "https:" || !REMOTE_HOSTS.has(parsed.hostname)) return null;
      return this.url("x", parsed.toString());
    } catch {
      return null;
    }
  }

  private verify(pathname: string): { source: Source; ref: string; key: string } | null {
    if (!pathname.startsWith(PREFIX)) return null;
    const token = pathname.slice(PREFIX.length);
    const dot = token.lastIndexOf(".");
    if (dot <= 0 || token.length > 2048) return null;
    const payload = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(this.sign(payload));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const bar = decoded.indexOf("|");
    const source = decoded.slice(0, bar) as Source;
    if (!["s", "r", "x"].includes(source)) return null;
    return { source, ref: decoded.slice(bar + 1), key: token.slice(dot + 1) };
  }

  private async fetchImage(source: Source, ref: string, etag: string): Promise<Image | null> {
    let response: Response;
    if (source === "x") {
      const parsed = new URL(ref);
      if (parsed.protocol !== "https:" || !REMOTE_HOSTS.has(parsed.hostname)) return null;
      response = await fetch(parsed, { signal: AbortSignal.timeout(15_000), headers: { Accept: "image/*" } });
    } else {
      response = await (source === "s" ? this.clients.sonarr : this.clients.radarr).raw(ref);
    }
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !/^image\/(jpeg|png|webp|gif|avif)/i.test(type)) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_IMAGE_BYTES) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_IMAGE_BYTES) return null;
    return { type: type.split(";")[0]!, body, etag: `"${etag}"` };
  }

  private remember(key: string, image: Image) {
    if (image.body.length > CACHE_ITEM_BYTES) return;
    this.cache.set(key, image);
    this.cacheBytes += image.body.length;
    for (const [oldKey, old] of this.cache) {
      if (this.cacheBytes <= CACHE_BYTES) break;
      this.cache.delete(oldKey);
      this.cacheBytes -= old.body.length;
    }
  }

  private load(source: Source, ref: string, key: string): Promise<Image | null> {
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
          if (image) this.remember(key, image);
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
  handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const send = (status: number, headers: Record<string, string> = {}, body?: Buffer) => {
      res.statusCode = status;
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      res.end(method === "HEAD" ? undefined : body);
      return true;
    };
    if (method !== "GET" && method !== "HEAD") return send(405, { Allow: "GET, HEAD" });
    const target = this.verify(pathname);
    if (!target) return send(404, { "Cache-Control": "no-store" });
    const etag = `"${target.key}"`;
    if (req.headers["if-none-match"] === etag) return send(304, { ETag: etag, "Cache-Control": "private, max-age=604800, immutable" });
    const image = await this.load(target.source, target.ref, target.key);
    if (!image) return send(404, { "Cache-Control": "private, max-age=300" });
    return send(
      200,
      {
        "Content-Type": image.type,
        "Content-Length": String(image.body.length),
        "Cache-Control": "private, max-age=604800, immutable",
        ETag: image.etag,
      },
      image.body,
    );
  };
}
