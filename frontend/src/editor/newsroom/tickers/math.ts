/**
 * Ticker maths (docs/EDITOR.md §16.3, §16.10): crawl speed and position (seamless for any clip length), flip and
 * stack timing, flip pages, priority-item flashing, readability for the graphics check, loop lengths, market deltas
 * and the match clock. Everything is a pure function of time, so exports repeat exactly. Node-testable.
 */

export const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);

// ── speed ────────────────────────────────────────────────────────────────────

/** Crawl presets as a share of the frame height per second (EBU practice for 16:9). */
export const SPEED_SHARE = { slow: 0.10, normal: 0.14, fast: 0.19 } as const;
export type SpeedName = keyof typeof SPEED_SHARE;
/** Portrait frames crawl 15 % slower: the window is narrow, so words need longer on screen. */
export const PORTRAIT_SPEED = 0.85;

/**
 * Crawl speed in design px per second. Presets are shares of the frame's short side (the height in 16:9); a portrait
 * frame (9:16, 4:5) also runs 15 % slower. `custom` px/s is used when the preset is "custom" (or a number is given).
 */
export function crawlSpeed(speed: string | number | undefined, designW: number, designH: number, custom?: number): number {
  if (typeof speed === "number" && speed > 0) return speed;
  if (speed === "custom" && custom && custom > 0) return custom;
  const share = SPEED_SHARE[speed as SpeedName] ?? SPEED_SHARE.normal;
  return share * Math.min(designW, designH) * (designH > designW ? PORTRAIT_SPEED : 1);
}

/**
 * A speed rounded to whole design px per frame when that changes it by 8 % or less (a crawl that moves the same
 * number of pixels every frame doesn't judder at 1080p). Otherwise, and without a frame rate, it is kept.
 */
export function frameSpeed(px: number, fps: number): number {
  if (!(fps > 0) || !(px > 0)) return px;
  const q = Math.max(1, Math.round(px / fps)) * fps;
  return Math.abs(q - px) / px <= 0.08 ? q : px;
}

/** A speed adjusted so `seconds` of crawl moves a whole number of strip lengths (the last frame leads into the first). */
export function loopSpeed(px: number, cycle: number, seconds: number): number {
  if (!(cycle > 0) || !(seconds > 0) || !(px > 0)) return px;
  const n = Math.max(1, Math.round((px * seconds) / cycle));
  return (n * cycle) / seconds;
}

// ── crawl position ───────────────────────────────────────────────────────────

/**
 * Where the strip starts, in px from the window's left edge, `t` seconds into the clip (the strip moves left).
 * startFull: the strip already fills the window at t = 0; otherwise it enters from the right edge. A result ≤ 0 is
 * the periodic part: copies of the strip repeat every `cycle` px to the right, so the crawl never shows a gap or a
 * jump, whatever the clip length. A result > 0: the first copy is still coming in (nothing to its left).
 */
export function crawlStart(t: number, speed: number, cycle: number, winW: number, startFull: boolean): number {
  const x = (startFull ? 0 : winW) - speed * Math.max(0, t);
  if (x > 0 || !(cycle > 0)) return x;
  const m = -x % cycle;
  return m === 0 ? 0 : -m;
}

/** The test's name for crawlStart's offset: how far the strip has moved past the window's left edge (0 ≤ x < cycle). */
export const crawlOffset = (t: number, speed: number, cycle: number, winW = 0, startFull = true): number =>
  Math.max(0, -crawlStart(t, speed, cycle, winW, startFull));

/** One strip piece on screen: item `i` at x (window px; its left edge). */
export interface Placed { i: number; x: number }

/**
 * The strip pieces visible in a window `winW` wide, given where the strip starts (crawlStart) and each piece's
 * width (an item plus the separator after it). Left to right.
 */
export function crawlVisible(start: number, widths: number[], winW: number): Placed[] {
  const out: Placed[] = [];
  const cycle = widths.reduce((a, w) => a + Math.max(0, w), 0);
  if (!(cycle > 0) || !widths.length) return out;
  let x = start;
  // skip whole copies that ended before the window (start ≤ 0 is already within one cycle)
  for (let guard = 0; x < winW && guard < 10000; guard++) {
    for (let i = 0; i < widths.length && x < winW; i++) {
      const w = Math.max(0, widths[i]);
      if (x + w > 0 && w > 0) out.push({ i, x });
      x += w;
    }
  }
  return out;
}

/**
 * The item at window position `ref` (px) and how far past `ref` its left edge has moved (px). -1 when nothing is
 * there yet (the strip is still coming in).
 */
export function crawlItemAt(ref: number, start: number, widths: number[]): { i: number; into: number } {
  const cycle = widths.reduce((a, w) => a + Math.max(0, w), 0);
  if (!(cycle > 0) || ref < start) return { i: -1, into: 0 };
  let d = (ref - start) % cycle;
  for (let i = 0; i < widths.length; i++) {
    const w = Math.max(0, widths[i]);
    if (d < w) return { i, into: d };
    d -= w;
  }
  return { i: widths.length - 1, into: 0 };
}

/** Mirrors a left-moving position for a crawl that moves right (the piece itself isn't flipped). */
export const mirrorX = (x: number, w: number, winW: number) => winW - x - w;

// ── flip and stack ───────────────────────────────────────────────────────────

export interface FlipState {
  /** The page (item) shown, and the one it replaced. */
  index: number; prev: number;
  /** The change from prev to index: 0 → 1 (1 = settled). */
  k: number;
  /** How many changes so far (stack rows roll by this). */
  step: number;
}

/**
 * What a flip ticker shows `u` seconds after it came in: each of `n` pages holds `hold` s, the change takes `trans` s
 * at the start of a page's turn, and the first page shows without a change. Loops for ever.
 */
export function flipState(u: number, n: number, hold: number, trans: number): FlipState {
  if (n <= 0) return { index: -1, prev: -1, k: 1, step: 0 };
  const h = Math.max(0.5, hold);
  const t = Math.max(0, u);
  const step = Math.floor(t / h + 1e-9);
  const local = t - step * h;
  const index = step % n;
  if (n === 1 || step === 0) return { index, prev: index, k: 1, step };
  const d = Math.min(Math.max(0, trans), h * 0.8);
  return { index, prev: (step - 1) % n, k: d > 0 ? clamp01(local / d) : 1, step };
}

/** Just the page index of flipState. */
export const flipIndex = (u: number, n: number, hold: number): number => flipState(u, n, hold, 0).index;

/**
 * Pages for a flip ticker: up to `per` items each, in order. With `byTag`, a page never mixes tags (a rates strip
 * shows one city at a time).
 */
export function pagesOf(items: { tag?: string }[], per: number, byTag = false): number[][] {
  const n = Math.max(1, Math.floor(per) || 1);
  const out: number[][] = [];
  let cur: number[] = [];
  items.forEach((it, i) => {
    const prev = cur.length ? items[cur[cur.length - 1]] : null;
    if (cur.length >= n || (byTag && prev && (prev.tag ?? "") !== (it.tag ?? ""))) { out.push(cur); cur = []; }
    cur.push(i);
  });
  if (cur.length) out.push(cur);
  return out;
}

// ── flashing priority items ──────────────────────────────────────────────────

/**
 * Strength 0..1 of a priority item's flash `t` seconds in: on for the first 55 % of each period, off for the rest,
 * with short soft edges. Snapped to frames. A period under 0.5 s is raised to 0.5 s (no more than 2 flashes a
 * second: photosensitivity guidance).
 */
export function flashLevel(t: number, period = 1, fps = 0): number {
  const p = Math.max(0.5, period || 1);
  const ts = fps > 0 ? Math.round(t * fps) / fps : t;
  const x = (((ts % p) + p) % p) / p;
  const e = 0.08;
  if (x < e) return x / e;
  if (x < 0.55) return 1;
  if (x < 0.55 + e) return 1 - (x - 0.55) / e;
  return 0;
}

// ── readability (graphics check) ─────────────────────────────────────────────

/** Average glyph width as a share of the font size (condensed news faces ≈ 0.45, Inter ≈ 0.55). */
export const CHAR_W = 0.5;
/** Characters a second a viewer reads comfortably in a crawl, and the most before it's unreadable. */
export const READ_CPS = { ok: 11, max: 14 };
/** Seconds a word should stay on screen at least (comfortable / bare minimum). */
export const READ_ONSCREEN = { ok: 4, min: 2.5 };

export interface Readability {
  pxPerSec: number;
  /** Characters passing a point each second. */
  charsPerSec: number;
  /** Seconds a word takes to cross the window. */
  onScreen: number;
  level: "ok" | "fast" | "too-fast";
  ok: boolean;
}

/** How readable a crawl is at `pxPerSec` with `fontSize` text in a window `windowW` wide (all design px). */
export function readableSpeed(pxPerSec: number, fontSize: number, windowW: number): Readability {
  const cps = pxPerSec / Math.max(1, CHAR_W * fontSize);
  const onScreen = pxPerSec > 0 ? windowW / pxPerSec : Infinity;
  const level = cps > READ_CPS.max || onScreen < READ_ONSCREEN.min ? "too-fast" : cps > READ_CPS.ok || onScreen < READ_ONSCREEN.ok ? "fast" : "ok";
  return { pxPerSec, charsPerSec: cps, onScreen, level, ok: level === "ok" };
}

/** The fastest comfortable crawl (px/s) for a font size and window (the graphics check's "Fix"). */
export const maxReadableSpeed = (fontSize: number, windowW: number): number =>
  Math.min(READ_CPS.ok * CHAR_W * fontSize, windowW / READ_ONSCREEN.ok);

// ── loop lengths (the item editor's estimate) ────────────────────────────────

/** A rough width of a text in design px without a canvas (for estimates only). */
export function estimateWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x0300 && c <= 0x036f) continue;
    if (c >= 0x0900 && c <= 0x0d7f) { w += /[ा-्॑-ॗॢॣঁ-ঃ়-਼্-઼੍-଼્-୍ா-்ా-಼ౖ-ೖാ-്ँ-ः]/.test(ch) ? 0.12 : 0.62; continue; }
    w += ch === " " ? 0.26 : /[A-Z0-9]/.test(ch) ? 0.56 : /[a-z]/.test(ch) ? 0.48 : /[.,:;'|!]/.test(ch) ? 0.24 : 0.55;
  }
  return w * size;
}

/** Seconds one pass of a crawl takes: the strip length over the speed. */
export const crawlLoopSeconds = (stripW: number, pxPerSec: number): number => (pxPerSec > 0 ? stripW / pxPerSec : 0);

/**
 * An estimate of one crawl loop in seconds for items of text, at the 16:9 defaults (40 px text, normal speed) unless
 * told otherwise.
 */
export function estimateLoop(items: { text: string; tag?: string; value?: number }[], o: { size?: number; pxPerSec?: number; gap?: number } = {}): number {
  const size = o.size ?? 40;
  const gap = o.gap ?? size * 1.6;
  const strip = items.reduce((a, it) => a + estimateWidth(it.text, size) + (it.tag ? estimateWidth(it.tag, size * 0.6) + size : 0) + (it.value !== undefined ? size * 4 : 0) + gap, 0);
  return crawlLoopSeconds(strip, o.pxPerSec ?? crawlSpeed("normal", 1920, 1080));
}

// ── market values ────────────────────────────────────────────────────────────

export type DeltaStyle = "pct" | "abs" | "abs+pct";
/**
 * A delta to show: direction (1 up, -1 down, 0 flat) and its size. "pct": `delta` is already a percentage; "abs":
 * points; "abs+pct": points plus the percentage of the previous value (value − delta).
 */
export function deltaParts(value: number | undefined, delta: number | undefined, style: DeltaStyle): { dir: 1 | -1 | 0; abs?: number; pct?: number } {
  if (delta === undefined || delta === null || !Number.isFinite(delta)) return { dir: 0 };
  const dir: 1 | -1 | 0 = delta > 0 ? 1 : delta < 0 ? -1 : 0;
  if (style === "pct") return { dir, pct: Math.abs(delta) };
  if (style === "abs") return { dir, abs: Math.abs(delta) };
  const prev = value !== undefined && Number.isFinite(value) ? value - delta : NaN;
  return { dir, abs: Math.abs(delta), ...(Number.isFinite(prev) && prev !== 0 ? { pct: Math.abs((delta / prev) * 100) } : {}) };
}

// ── clocks ───────────────────────────────────────────────────────────────────

/** A blinking colon is shown during the first half of each second of the clock. */
export const colonOn = (ms: number): boolean => ((ms % 1000) + 1000) % 1000 < 500;

/** "67:12" / "12:40" / "1:05:10" / "45" (minutes) → seconds; null when it isn't a time. */
export function parseClock(s: unknown): number | null {
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  if (typeof s !== "string") return null;
  const m = /^\s*(\d{1,3})(?::(\d{1,2}))?(?::(\d{1,2}))?\s*$/.exec(s);
  if (!m) return null;
  const a = +m[1], b = m[2] !== undefined ? +m[2] : null, c = m[3] !== undefined ? +m[3] : null;
  if (c !== null) return a * 3600 + (b ?? 0) * 60 + c;
  if (b !== null) return a * 60 + b;
  return a * 60;
}

/** A running match clock `elapsed` s after it showed `start` s: counting up, or down and stopping at 0. */
export function matchTime(start: number, elapsed: number, down: boolean): number {
  const e = Math.max(0, Math.floor(elapsed + 1e-6));
  return down ? Math.max(0, start - e) : start + e;
}

/** Seconds as "mm:ss" (minutes can pass 99: "105:20"). */
export function fmtMatch(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
