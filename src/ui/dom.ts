type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener> & { class?: string };

/** Tiny DOM builder. Strings are always inserted as text, never HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (typeof value === "function") el.addEventListener(name.replace(/^on/, ""), value);
      else if (name === "class") el.className = String(value);
      else el.setAttribute(name, value === true ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS: Record<string, string[]> = {
  refresh: ["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "m21 21-4.3-4.3"],
  chevronRight: ["m9 18 6-6-6-6"],
  chevronLeft: ["m15 18-6-6 6-6"],
  chevronDown: ["m6 9 6 6 6-6"],
  tv: ["M4 7h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z", "m8 3 4 4 4-4"],
  film: [
    "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
    "M7 3v18M17 3v18M3 8h4M3 12h18M3 16h4M17 8h4M17 16h4",
  ],
  alert: ["M12 9v4", "M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"],
  file: ["M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z", "M14 3v6h6"],
  external: ["M14 4h6v6", "M20 4 10 14", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
};

export function icon(name: keyof typeof ICONS | string, cls = "ms-icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", cls);
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// ---- Formatting (display only; underlying values remain exact bytes) ------------------------

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Decimal (SI) units, matching how drives are sold. */
export function bytesParts(bytes: number): { value: string; unit: string } {
  if (!Number.isFinite(bytes) || bytes <= 0) return { value: "0", unit: "B" };
  const exp = Math.min(Math.floor(Math.log10(bytes) / 3), UNITS.length - 1);
  const scaled = bytes / 1000 ** exp;
  const digits = exp === 0 ? 0 : scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  return { value: scaled.toFixed(digits), unit: UNITS[exp]! };
}

export const fmtBytes = (bytes: number) => {
  const { value, unit } = bytesParts(bytes);
  return `${value} ${unit}`;
};

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
export const fmtInt = (n: number) => integer.format(n);
export const exactBytes = (bytes: number) => `${integer.format(bytes)} bytes`;

export function fmtRelative(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(iso).toLocaleDateString();
}

export function fmtDate(iso: string | null | undefined) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function fmtDuration(seconds: number) {
  if (!seconds) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export function fmtBitrate(bitsPerSecond: number) {
  if (!bitsPerSecond) return null;
  return bitsPerSecond >= 1e6 ? `${(bitsPerSecond / 1e6).toFixed(1)} Mb/s` : `${Math.round(bitsPerSecond / 1e3)} kb/s`;
}

export function resolutionLabel(resolutionClass: number) {
  if (resolutionClass >= 2000) return "4K";
  if (resolutionClass >= 1000) return "1080p";
  if (resolutionClass >= 700) return "720p";
  if (resolutionClass > 0) return "SD";
  return null;
}

export function episodeCode(season: number, episodes: { number: number }[]) {
  const s = `S${String(season).padStart(2, "0")}`;
  if (!episodes.length) return s;
  const first = episodes[0]!.number;
  const last = episodes[episodes.length - 1]!.number;
  const e = (n: number) => `E${String(n).padStart(2, "0")}`;
  return first === last ? `${s}${e(first)}` : `${s}${e(first)}–${e(last)}`;
}

export function initials(title: string) {
  return title
    .replace(/^(the|a|an)\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

/** Lazily loaded artwork that fades in and degrades to a typographic placeholder. */
export function artwork(src: string | null, alt: string, cls: string, opts: { eager?: boolean; fallback?: string } = {}) {
  const frame = h("div", { class: `ms-art ${cls}` });
  const fallback = h("span", { class: "ms-art__fallback", "aria-hidden": "true" }, opts.fallback ?? initials(alt));
  frame.append(fallback);
  if (!src) {
    frame.classList.add("is-missing");
    return frame;
  }
  const img = h("img", {
    src,
    alt,
    loading: opts.eager ? "eager" : "lazy",
    decoding: "async",
    draggable: "false",
  });
  img.addEventListener("load", () => frame.classList.add("is-loaded"), { once: true });
  img.addEventListener(
    "error",
    () => {
      img.remove();
      frame.classList.add("is-missing");
    },
    { once: true },
  );
  frame.append(img);
  if (img.complete && img.naturalWidth) frame.classList.add("is-loaded");
  return frame;
}

export function sizeBlock(bytes: number, cls = "ms-size") {
  const { value, unit } = bytesParts(bytes);
  return h("span", { class: cls, title: exactBytes(bytes), "data-bytes": String(bytes) }, h("span", { class: `${cls}__value` }, value), h("span", { class: `${cls}__unit` }, unit));
}

export function shareBar(fraction: number, cls = "") {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  const bar = h("span", { class: `ms-share ${cls}`, "aria-hidden": "true" }, h("span", { class: "ms-share__fill" }));
  (bar.firstChild as HTMLElement).style.width = `${pct.toFixed(2)}%`;
  return bar;
}
