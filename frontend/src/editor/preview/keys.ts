/**
 * Cache keys of the preview thumbnails (preview-polish): a thumbnail is cached by the item's id, its version (a hash
 * of what draws it: the effect chain, the title spec, the template's layers), the frame source (a sample, or the
 * user's clip at a time) and the size, plus the renderer's version so a change in how cards are drawn never shows a
 * stale picture. Card sizes come from a few DPR-aware buckets, so panels share their renders. Pure.
 */

/** Bumped when the cards' drawing changes (old IndexedDB entries are then simply never read again). */
export const PREVIEW_RENDER_VERSION = 4;

/** JSON with sorted keys (the same value always gives the same text; undefined fields are left out). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : "null";
    return v === undefined ? "null" : JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== "function").sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/** FNV-1a (52 bits kept, base 36): a short, stable digest of a string. */
export function digest(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) ^ (h1 >>> 13);
  }
  return ((h1 >>> 0) * 2 ** 20 + ((h2 >>> 0) & 0xfffff)).toString(36);
}

/** The version of an item: a digest of what draws it. */
export const versionOf = (def: unknown): string => digest(stableStringify(def));

/** Where a thumbnail's picture comes from. */
export type FrameSourceRef =
  | { kind: "sample"; id: string }
  | { kind: "clip"; mediaId: string; t: number; rev?: string }
  | { kind: "pair"; a: FrameSourceRef; b: FrameSourceRef };

/** The frame source as text: "s:<id>", "c:<media>@<t to 0.1 s>[~rev]", "p:(a)(b)". */
export function sourceKey(src: FrameSourceRef): string {
  if (src.kind === "sample") return `s:${src.id}`;
  if (src.kind === "pair") return `p:(${sourceKey(src.a)})(${sourceKey(src.b)})`;
  return `c:${src.mediaId}@${(Math.round(src.t * 10) / 10).toFixed(1)}${src.rev ? `~${src.rev}` : ""}`;
}

export interface ThumbKeyParts {
  /** "chain" (moods, looks, LUTs, effects), "transition", "title", "sequence". */
  kind: string;
  id: string;
  version: string;
  source: FrameSourceRef | string;
  w: number; h: number;
  /** A still ("" / undefined) or a frame of an animation ("f12", "k0.50"). */
  variant?: string;
}

/** The cache key of one picture. */
export function thumbKey(p: ThumbKeyParts): string {
  const src = typeof p.source === "string" ? p.source : sourceKey(p.source);
  return `r${PREVIEW_RENDER_VERSION}|${p.kind}|${p.id}|${p.version}|${src}|${Math.round(p.w)}x${Math.round(p.h)}${p.variant ? `|${p.variant}` : ""}`;
}

/** Card widths the renders come in (device pixels). */
export const SIZE_BUCKETS = [96, 128, 160, 192, 256, 320, 384, 480, 640];

/**
 * The render size for a card `cssWidth` CSS pixels wide on a `dpr` screen: the smallest bucket at least that many
 * device pixels (the largest when none is), and its height at the aspect (16:9 by default).
 */
export function sizeBucket(cssWidth: number, dpr = 1, aspect = 16 / 9): { w: number; h: number } {
  const want = Math.max(1, cssWidth) * Math.min(3, Math.max(1, dpr || 1));
  const w = SIZE_BUCKETS.find((b) => b >= want - 0.5) ?? SIZE_BUCKETS[SIZE_BUCKETS.length - 1];
  return { w, h: Math.max(2, Math.round(w / aspect)) };
}
