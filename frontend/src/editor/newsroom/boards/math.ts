/**
 * Board maths (docs/EDITOR.md §16.3, nr-boards): count-up values, item-by-item build timing, bar scaling and percents,
 * election seat arcs, table columns, pin drops and text wrapping, plus reading field values into rows and items.
 * Everything a board kind draws comes from these, so it is testable in Node. Pure (no canvas, no clock).
 */
import type { GfxListItem, GfxTableRow, GfxValue, NumberFormat } from "../types.ts";

export const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
export const lerp = (a: number, b: number, x: number): number => a + (b - a) * x;
/** 0 → 1 over [start, start + dur] (a zero length jumps at `start`). */
export const progress = (t: number, start: number, dur: number): number => (dur <= 0 ? (t >= start ? 1 : 0) : clamp01((t - start) / dur));

// ── easing ───────────────────────────────────────────────────────────────────

/** Named easings (the AnimEase names, plus "quint" and "cubic"). Unknown names ease out (cubic). */
export function easeBy(kind: string | undefined, x: number): number {
  const t = clamp01(x);
  switch (kind) {
    case "linear": return t;
    case "ease_in": return t * t * t;
    case "ease_in_out": return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case "quint": return 1 - Math.pow(1 - t, 5);
    case "expo": return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
    case "back": { const c = 1.70158, u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; }
    case "elastic": return t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
    case "bounce": {
      const n = 7.5625, d = 2.75;
      if (t < 1 / d) return n * t * t;
      if (t < 2 / d) { const u = t - 1.5 / d; return n * u * u + 0.75; }
      if (t < 2.5 / d) { const u = t - 2.25 / d; return n * u * u + 0.9375; }
      const u = t - 2.625 / d; return n * u * u + 0.984375;
    }
    default: return 1 - Math.pow(1 - t, 3);
  }
}

// ── values from fields ───────────────────────────────────────────────────────

/** A number from a field or a cell: 1234, "1,23,456", "₹ 45.6", "-3.2%" → 1234, 123456, 45.6, -3.2; else NaN. */
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v !== "string") return NaN;
  const s = v.replace(/[\s,₹$€£%+]/g, "").replace(/[−–]/g, "-");
  if (!s || !/^-?\d*\.?\d+(e-?\d+)?$/i.test(s)) return NaN;
  return Number(s);
}
const LIST_MARK = /^\s*(?:[-•*·▪►]|\d{1,2}[.)])\s+/;
/** List items from a list field, a string array or the lines of a longtext (leading "-", "•", "1." markers dropped). */
export function listItems(v: GfxValue | undefined): GfxListItem[] {
  if (Array.isArray(v)) {
    return (v as unknown[]).flatMap((x): GfxListItem[] => {
      if (typeof x === "string") return x.trim() ? [{ text: x.replace(LIST_MARK, "").trim() }] : [];
      if (x && typeof x === "object" && "text" in x) return String((x as GfxListItem).text ?? "").trim() ? [x as GfxListItem] : [];
      return [];
    });
  }
  if (typeof v === "string") return v.split(/\r?\n/).map((s) => s.replace(LIST_MARK, "").trim()).filter(Boolean).map((text) => ({ text }));
  return [];
}
/** Rows of a table field (anything else: none). */
export function tableRows(v: GfxValue | undefined): GfxTableRow[] {
  return Array.isArray(v) ? (v as unknown[]).filter((r): r is GfxTableRow => !!r && typeof r === "object" && !Array.isArray(r)) : [];
}
/** "a, b c" → ["a", "b", "c"] (column ids in props). */
export const idList = (s: unknown): string[] => (typeof s === "string" ? s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean) : []);

// ── counting numbers ─────────────────────────────────────────────────────────

/** Digits after the point (at most 4), so a count shows the target's precision all the way. */
export function decimalsOf(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return 0;
  const s = String(Number(n.toFixed(4)));
  const i = s.indexOf(".");
  return i < 0 ? 0 : Math.min(4, s.length - i - 1);
}
export const roundTo = (n: number, d: number): number => { const k = Math.pow(10, d); return Math.round(n * k) / k; };

export interface CountSpec { from: number; to: number; start: number; dur: number; ease?: string; decimals: number }
/** The value a counting number shows at `t`: eased from → to, rounded to its decimals (so the digits never jitter). */
export function countValue(c: CountSpec, t: number, ease: (x: number) => number = (x) => easeBy(c.ease ?? "expo", x)): number {
  const p = progress(t, c.start, c.dur);
  if (p >= 1) return c.to;
  return roundTo(lerp(c.from, c.to, ease(p)), c.decimals);
}

const UNITS = {
  indian: [[1e12, " lakh crore"], [1e7, " crore"], [1e5, " lakh"]] as [number, string][],
  international: [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as [number, string][],
};
/** The compact unit a value is written in (1,25,00,000 → crore), or null when it is below the smallest unit. */
export function compactUnit(v: number, system: "indian" | "international"): { div: number; label: string } | null {
  const a = Math.abs(v);
  const u = UNITS[system].find(([d]) => a >= d);
  return u ? { div: u[0], label: u[1] } : null;
}

/**
 * How a counting number is written: the target's compact unit is kept for the whole count (0.0 crore → 12.5 crore,
 * never "12,345" → "1.2 lakh" → "12.5 crore"), and the decimals are fixed. `n` = the value to format with `f`.
 */
export function countFormat(to: number, f: NumberFormat, system: "indian" | "international"): { div: number; f: NumberFormat } {
  const u = f.compact ? compactUnit(to, system) : null;
  if (!u) {
    const d = f.decimals ?? decimalsOf(to);
    return { div: 1, f: { ...f, compact: false, decimals: d } };
  }
  const x = Math.abs(to) / u.div;
  const d = f.decimals ?? (x >= 100 ? 0 : decimalsOf(roundTo(x, 2)));
  return { div: u.div, f: { ...f, compact: false, decimals: d, suffix: u.label + (f.suffix ?? "") } };
}

/** Seconds left on a countdown `from` seconds long, `t - start` seconds in (whole seconds, never below 0). */
export const timerLeft = (from: number, t: number, start: number): number => Math.max(0, Math.ceil(from - Math.max(0, t - start) - 1e-6));
/** Countdown parts: "dhms" → [days, hours, minutes, seconds], "hms", "ms" (the first part takes the rest). */
export function timerParts(sec: number, units: "dhms" | "hms" | "ms"): number[] {
  const s = Math.max(0, Math.floor(sec));
  if (units === "ms") return [Math.floor(s / 60), s % 60];
  if (units === "hms") return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60];
  return [Math.floor(s / 86400), Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60];
}
export const pad2 = (n: number): string => String(n).padStart(2, "0");
/** Seconds from a number (seconds) or "hh:mm:ss" / "mm:ss" / "3d 04:10:00" text; NaN when unreadable. */
export function parseDuration(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  const m = /^\s*(?:(\d+)\s*d\s*)?(\d+(?::\d{1,2}){0,2})\s*$/i.exec(v);
  if (!m) return NaN;
  const parts = m[2].split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return (Number(m[1] ?? 0) * 86400) + parts[0] * 3600 + parts[1] * 60 + parts[2];
}
/** A formatted number split for drawing: sign, the part before the digits (₹, "Rs "), the digits, the unit after. */
export function splitNumberText(s: string): { sign: string; lead: string; core: string; tail: string } {
  const m = /^([+\-−]?)([^\p{Nd}]*?)(\p{Nd}[\p{Nd},.]*)(.*)$/u.exec(s);
  if (!m) return { sign: "", lead: "", core: s, tail: "" };
  return { sign: m[1], lead: m[2], core: m[3], tail: m[4] };
}
/** "01:59:30" (the first part unpadded past 99). */
export const timerText = (sec: number, units: "dhms" | "hms" | "ms"): string => timerParts(sec, units).map(pad2).join(":");

// ── building items one by one ────────────────────────────────────────────────

export interface BuildSpec {
  n: number;
  /** Seconds from the clip start when the first item starts. */
  start: number;
  /** all = together; stagger = quick succession; paced = one every `every` s (0 = spread over the first part of the clip). */
  mode: "all" | "stagger" | "paced";
  stagger: number; every: number;
  /** The clip's length (paced auto). */
  clipDur: number;
}
/** Seconds between items for a paced build with `every` = 0: the items arrive over about the first 45 % of the clip. */
export function autoEvery(n: number, start: number, clipDur: number): number {
  if (n <= 1) return 0;
  const span = Math.max(0, clipDur * 0.45 - start);
  return Math.min(2.5, Math.max(0.35, span / (n - 1)));
}
/** When each item starts (seconds from the clip start). */
export function buildTimes(b: BuildSpec): number[] {
  const gap = b.mode === "all" ? 0 : b.mode === "stagger" ? Math.max(0, b.stagger) : b.every > 0 ? b.every : autoEvery(b.n, b.start, b.clipDur);
  return Array.from({ length: Math.max(0, b.n) }, (_, i) => b.start + i * gap);
}
/** The latest item that has started at `t` (−1 before the first). */
export function latestItem(t: number, times: number[]): number {
  let k = -1;
  for (let i = 0; i < times.length; i++) if (t >= times[i]) k = i;
  return k;
}
/** The highlighted item: "latest" follows the build; "cycle" then moves through the items every `every` s. */
export function highlightAt(t: number, times: number[], mode: "none" | "latest" | "cycle", every: number): number {
  if (mode === "none" || !times.length) return -1;
  const k = latestItem(t, times);
  if (mode === "latest" || k < times.length - 1) return k;
  const last = times[times.length - 1], step = every > 0 ? every : 2.5;
  return Math.floor((t - last) / step + times.length - 1) % times.length;
}
/**
 * How much item i is highlighted at `t` (0..1, cross-fading over `fade` s): "latest" = from its start until the next
 * item starts (the last stays lit); "cycle" = then each item in turn every `every` s.
 */
export function highlightWeight(t: number, times: number[], mode: "none" | "latest" | "cycle", every: number, i: number, fade = 0.25): number {
  const n = times.length;
  if (mode === "none" || i < 0 || i >= n) return 0;
  const on = (a: number, b: number) => progress(t, a, fade) * (1 - progress(t, b, fade));
  const next = i + 1 < n ? times[i + 1] : Infinity;
  if (mode === "latest" || n === 1) return on(times[i], next);
  const step = every > 0 ? every : 2.5, last = times[n - 1];
  // before the cycle: like latest, the last item hands over to the first when the cycle starts
  let w = on(times[i], i === n - 1 ? last + step : next);
  if (t >= last + step - fade) {
    const k = Math.floor((t - last) / step);           // cycle slot
    for (const s of [k - 1, k]) {
      if (s < 1) continue;
      if (((s + n - 1) % n) !== i) continue;
      const a = last + s * step;
      w = Math.max(w, on(a, a + step));
    }
  }
  return clamp01(w);
}

export interface ListLayoutOpts {
  w: number; h: number; size: number; minFrac?: number; lineH?: number; maxLines?: number;
  /** Text indent (marker column) and plate padding, as fractions of the size. */
  indent?: number; padX?: number; padY?: number;
  /** Gap between items (fraction of the size); with `spread`, spare height widens it up to `maxGap`. */
  gap?: number; spread?: boolean; maxGap?: number;
  valign?: "top" | "center";
  /** Extra height per item (fractions of the size), e.g. a kicker line above the text. */
  extra?: number[];
}
export interface ListLayout { size: number; rows: { lines: string[]; y: number; h: number }[]; shrunk: number; cut: boolean }
/**
 * Lays a list out in a box: every item wraps (≤ maxLines), and the size shrinks (to 60 %) until the list fits. The
 * spare height goes between items (`spread`) or above and below (`valign` center).
 */
export function layoutList(texts: string[], o: ListLayoutOpts, measure: (s: string, size: number) => number): ListLayout {
  const minFrac = o.minFrac ?? 0.6, lineH = o.lineH ?? 1.2, maxLines = Math.max(1, o.maxLines ?? 2);
  const indent = o.indent ?? 1.1, padX = o.padX ?? 0, padY = o.padY ?? 0, gap = o.gap ?? 0.55;
  const n = texts.length;
  const measureAt = (s: number, cutLines: boolean) => {
    const tw = Math.max(10, o.w - s * indent - 2 * s * padX);
    let cut = false;
    const rows = texts.map((tx, i) => {
      let lines = wrapWords(tx, tw, (x) => measure(x, s));
      if (cutLines && (lines.length > maxLines || lines.some((l) => measure(l, s) > tw + 0.5))) {
        cut = true;
        const keep = lines.slice(0, maxLines);
        keep[keep.length - 1] = ellipsize(lines.slice(maxLines - 1).join(" "), tw, (x) => measure(x, s));
        lines = keep;
      }
      return { lines, h: lines.length * s * lineH + 2 * s * padY + s * (o.extra?.[i] ?? 0) };
    });
    const total = rows.reduce((a, r) => a + r.h, 0) + Math.max(0, n - 1) * s * gap;
    const fits = rows.every((r) => r.lines.length <= maxLines && r.lines.every((l) => measure(l, s) <= tw + 0.5));
    return { rows, total, fits, cut };
  };
  let size = o.size, m = measureAt(size, false);
  while (!(m.fits && m.total <= o.h + 0.5) && size > o.size * minFrac + 1e-6) {
    size = Math.max(o.size * minFrac, size - o.size * 0.04);
    m = measureAt(size, false);
  }
  if (!(m.fits && m.total <= o.h + 0.5)) m = measureAt(size, true);
  let g = size * gap, y0 = 0;
  const spare = o.h - m.total;
  if (spare > 0 && o.spread && n > 1) {
    const extra = Math.min(spare / (n - 1), size * Math.max(0, (o.maxGap ?? 1.4) - gap));
    g += extra;
    y0 = o.valign === "center" ? (spare - extra * (n - 1)) / 2 : 0;
  } else if (spare > 0 && o.valign === "center") y0 = spare / 2;
  let y = y0;
  const rows = m.rows.map((r) => { const out = { lines: r.lines, y, h: r.h }; y += r.h + g; return out; });
  return { size, rows, shrunk: size / o.size, cut: m.cut };
}

/**
 * Lays a list out side by side (timelines, cards): `n` equal columns `colW` wide, each item wrapped to ≤ maxLines;
 * the size shrinks (to 60 %) until the tallest column fits `h` (after `head` text heights for the marker and tag).
 */
export function layoutColumns(texts: string[], o: { colW: number; h: number; size: number; lineH?: number; maxLines?: number; head?: number; minFrac?: number },
  measure: (s: string, size: number) => number): { size: number; cols: string[][]; cut: boolean } {
  const lineH = o.lineH ?? 1.2, maxLines = Math.max(1, o.maxLines ?? 4), minFrac = o.minFrac ?? 0.6, head = o.head ?? 0;
  const at = (s: number) => texts.map((tx) => wrapWords(tx, o.colW, (x) => measure(x, s)));
  const fits = (s: number, cols: string[][]) => cols.every((ls) => ls.length <= maxLines && ls.every((l) => measure(l, s) <= o.colW + 0.5))
    && Math.max(0, ...cols.map((ls) => ls.length)) * s * lineH + head * s <= o.h + 0.5;
  let size = o.size, cols = at(size);
  while (!fits(size, cols) && size > o.size * minFrac + 1e-6) { size = Math.max(o.size * minFrac, size - o.size * 0.04); cols = at(size); }
  let cut = false;
  if (!fits(size, cols)) {
    const room = Math.max(1, Math.min(maxLines, Math.floor((o.h - head * size) / (size * lineH))));
    cols = cols.map((ls) => {
      if (ls.length <= room && ls.every((l) => measure(l, size) <= o.colW + 0.5)) return ls;
      cut = true;
      const keep = ls.slice(0, room);
      keep[keep.length - 1] = ellipsize(ls.slice(room - 1).join(" "), o.colW, (x) => measure(x, size));
      return keep;
    });
  }
  return { size, cols, cut };
}

/** Item i's share of an out phase (out 1 → 0): the last item leaves first, the whole list in the phase. */
export function outShare(out: number, i: number, n: number, overlap = 0.6): number {
  if (n <= 1) return clamp01(out);
  const k = 1 - overlap, span = 1 + (n - 1) * k * 0.25;
  const x = (1 - clamp01(out)) * span - (n - 1 - i) * k * 0.25;
  return 1 - clamp01(x);
}

// ── bars and percents ────────────────────────────────────────────────────────

/** Bar lengths 0..1: of the largest value, of the total, or of a fixed maximum. Negatives count as 0. */
export function barFractions(values: number[], scale: "max" | "total" | "fixed", max = 0): number[] {
  const v = values.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const d = scale === "fixed" && max > 0 ? max : scale === "total" ? v.reduce((a, b) => a + b, 0) : Math.max(0, ...v);
  return v.map((x) => (d > 0 ? Math.min(1, x / d) : 0));
}
/** Percents of the total that add up to exactly 100 at `decimals` (largest remainder). */
export function percents(values: number[], decimals = 0): number[] {
  const v = values.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const total = v.reduce((a, b) => a + b, 0);
  if (total <= 0) return v.map(() => 0);
  const k = Math.pow(10, decimals), units = 100 * k;
  const raw = v.map((x) => (x / total) * units);
  const floor = raw.map(Math.floor);
  let left = units - floor.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left <= 0) break; if (v[i] > 0) { floor[i]++; left--; } }
  return floor.map((x) => x / k);
}
/** A bar's growth 0..1 at `t` (the bars start one after another, `stagger` apart). */
export const growAt = (t: number, start: number, i: number, stagger: number, dur: number, ease = "quint"): number =>
  easeBy(ease, progress(t, start + i * stagger, dur));

// ── election seats ───────────────────────────────────────────────────────────

export interface SeatArc { label: string; seats: number; color?: string; a0: number; a1: number }
/** Seats needed for a majority. */
export const majorityOf = (total: number): number => Math.floor(Math.max(0, total) / 2) + 1;
/**
 * Half-donut segments, left → right (canvas angles: π is the left end, 1.5π the top, 2π the right end). `total` is the
 * house size (default the seats given); undeclared seats stay empty. `reveal` 0..1 sweeps them in from the left.
 */
export function seatArcs(rows: { label: string; seats: number; color?: string }[], total = 0, reveal = 1): SeatArc[] {
  const sum = rows.reduce((a, r) => a + Math.max(0, r.seats || 0), 0);
  const house = Math.max(sum, total, 1);
  const end = Math.PI + Math.PI * clamp01(reveal);
  const out: SeatArc[] = [];
  let at = 0;
  for (const r of rows) {
    const s = Math.max(0, r.seats || 0);
    const a0 = Math.PI + (Math.PI * at) / house, a1 = Math.PI + (Math.PI * (at + s)) / house;
    at += s;
    out.push({ label: r.label, seats: s, ...(r.color ? { color: r.color } : {}), a0: Math.min(a0, end), a1: Math.min(a1, end) });
  }
  return out;
}
/** Where the majority line sits on the half donut (the boundary just before the majority seat). */
export const majorityAngle = (house: number, majority = majorityOf(house)): number =>
  Math.PI + Math.PI * clamp01((majority - 0.5) / Math.max(1, house));
/** The row with the most seats (−1 when none). */
export function leaderOf(values: number[]): number {
  let k = -1;
  for (let i = 0; i < values.length; i++) if (values[i] > 0 && (k < 0 || values[i] > values[k])) k = i;
  return k;
}

// ── tables ───────────────────────────────────────────────────────────────────

export interface TableCol { id: string; label: string }
/** "player=Batter, r=R, b" → columns (label after "=" or ":"); empty = every key of the first row, in order. */
export function parseColumns(spec: unknown, rows: GfxTableRow[]): TableCol[] {
  const s = typeof spec === "string" ? spec.trim() : "";
  if (!s) return Object.keys(rows[0] ?? {}).filter((k) => k !== "color" && k !== "highlight").map((id) => ({ id, label: titleCase(id) }));
  return s.split(",").map((part) => {
    const m = /^\s*([^=:]+?)\s*(?:[=:]\s*(.*?))?\s*$/.exec(part);
    const id = (m?.[1] ?? part).trim();
    return { id, label: m?.[2] !== undefined && m[2] !== "" ? m[2] : titleCase(id) };
  }).filter((c) => c.id);
}
const titleCase = (s: string) => s.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
/** True when every non-empty cell of a column is a number. */
export function isNumericCol(rows: GfxTableRow[], id: string): boolean {
  let any = false;
  for (const r of rows) {
    const v = r[id];
    if (v === undefined || v === "" || v === "-" || v === "–") continue;
    if (!Number.isFinite(num(v))) return false;
    any = true;
  }
  return any;
}
export type Align = "left" | "center" | "right";
/** "lrrc" → aligns per column; "auto" / missing letters: the first column left, number columns right, others left. */
export function parseAligns(spec: unknown, cols: TableCol[], rows: GfxTableRow[]): Align[] {
  const s = typeof spec === "string" && spec.trim() !== "auto" ? spec.replace(/[\s,]/g, "").toLowerCase() : "";
  return cols.map((c, i) => {
    const ch = s[i];
    if (ch === "l") return "left";
    if (ch === "c") return "center";
    if (ch === "r") return "right";
    return i > 0 && isNumericCol(rows, c.id) ? "right" : "left";
  });
}
/**
 * Column x / w inside `width`: from weights ("3,1,1") or, when "auto", from the content widths (the first column takes
 * what's left, so long names fit). `gap` = padding between columns.
 */
export function columnLayout(weights: unknown, content: number[], width: number, gap: number): { x: number; w: number }[] {
  const n = content.length;
  if (!n) return [];
  const ws = typeof weights === "string" ? weights.split(/[\s,]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0) : [];
  let widths: number[];
  const inner = Math.max(0, width - gap * (n - 1));
  if (ws.length >= n) {
    const sum = ws.slice(0, n).reduce((a, b) => a + b, 0);
    widths = ws.slice(0, n).map((w) => (inner * w) / sum);
  } else {
    const rest = content.slice(1).map((c) => Math.max(c, 0));
    const restSum = rest.reduce((a, b) => a + b, 0);
    const first = Math.max(inner * 0.28, inner - restSum);
    const k = restSum > 0 ? Math.min(1, (inner - first) / restSum) : 0;
    // spare room goes to the number columns evenly so they don't crowd the edge
    const spare = Math.max(0, inner - first - restSum * k);
    widths = [first, ...rest.map((c) => c * k + (n > 1 ? spare / (n - 1) : 0))];
  }
  let x = 0;
  return widths.map((w) => { const r = { x, w }; x += w + gap; return r; });
}

// ── pins ─────────────────────────────────────────────────────────────────────

export interface Pin { label: string; x: number; y: number; color?: string; note?: string }
/** Pins from table rows: x / y as 0..1 of the map (or 0..100, read as percent), clamped to the map. */
export function pinsFrom(rows: GfxTableRow[], c: { label?: string; x?: string; y?: string; color?: string; note?: string } = {}): Pin[] {
  const L = c.label || "label", X = c.x || "x", Y = c.y || "y", C = c.color || "color", N = c.note || "note";
  const frac = (v: number) => clamp01(Math.abs(v) > 1 ? v / 100 : v);
  return rows.flatMap((r) => {
    const x = num(r[X]), y = num(r[Y]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    const p: Pin = { label: String(r[L] ?? ""), x: frac(x), y: frac(y) };
    if (r[C]) p.color = String(r[C]);
    if (r[N] !== undefined && r[N] !== "") p.note = String(r[N]);
    return [p];
  });
}
/** Where a picture iw×ih sits in a box: contain (whole picture) or cover (fills, cropped). */
export function fitRect(iw: number, ih: number, box: [number, number, number, number], fit: "contain" | "cover"): [number, number, number, number] {
  const [x, y, w, h] = box;
  if (!(iw > 0 && ih > 0)) return [x, y, w, h];
  const k = fit === "cover" ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
  const dw = iw * k, dh = ih * k;
  return [x + (w - dw) / 2, y + (h - dh) / 2, dw, dh];
}
/** A pin dropping in: `y` = offset in pin heights (−1.6 → 0, a small bounce), `a` = alpha, `s` = squash at landing. */
export function pinDrop(t: number, start: number, dur: number): { y: number; a: number; s: number } {
  const p = progress(t, start, dur);
  if (p <= 0) return { y: -1.6, a: 0, s: 1 };
  const e = easeBy("bounce", p);
  const land = p > 0.36 && p < 0.6 ? Math.sin(((p - 0.36) / 0.24) * Math.PI) * 0.12 : 0;
  return { y: -1.6 * (1 - e), a: clamp01(p * 4), s: 1 - land };
}
export type TagSide = "right" | "left" | "above" | "below";
const overlap = (a: [number, number, number, number], b: [number, number, number, number]) =>
  Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
/** Where a pin's tag box sits on each side of a pin (tip at x, y; the head is about `s` tall). */
export function tagRect(side: TagSide, x: number, y: number, w: number, h: number, s: number): [number, number, number, number] {
  const hy = y - s * 0.62;
  if (side === "left") return [x - s * 0.42 - w, hy - h / 2, w, h];
  if (side === "above") return [x - w / 2, y - s * 1.12 - h, w, h];
  if (side === "below") return [x - w / 2, y + s * 0.3, w, h];
  return [x + s * 0.42, hy - h / 2, w, h];
}
/**
 * Picks each pin's tag side (in order: earlier pins keep the better spots): right unless that runs off the map or
 * covers another tag or pin, then left, above, below; the least-covered side wins. Static, so tags never jump.
 */
export function placeTags(pins: [number, number][], sizes: [number, number][], area: [number, number, number, number], s: number): TagSide[] {
  const placed: [number, number, number, number][] = [];
  const heads = pins.map(([x, y]) => [x - s * 0.45, y - s * 1.05, s * 0.9, s * 1.05] as [number, number, number, number]);
  const [ax, ay, aw, ah] = area;
  return pins.map(([x, y], i) => {
    let best: TagSide = "right", score = Infinity;
    for (const side of ["right", "left", "above", "below"] as TagSide[]) {
      const r = tagRect(side, x, y, sizes[i][0], sizes[i][1], s);
      const out = Math.max(0, ax - r[0]) + Math.max(0, r[0] + r[2] - (ax + aw)) + Math.max(0, ay - r[1]) + Math.max(0, r[1] + r[3] - (ay + ah));
      let sc = out * r[3] * 4 + (side === "right" ? 0 : side === "left" ? 1 : 2);
      for (const p of placed) sc += overlap(r, p) * 2;
      heads.forEach((hd, j) => { if (j !== i) sc += overlap(r, hd); });
      if (sc < score) { score = sc; best = side; }
    }
    placed.push(tagRect(best, x, y, sizes[i][0], sizes[i][1], s));
    return best;
  });
}

/** A pulse ring 0..1 (radius grows, alpha falls) every `period` s; 0 = off. */
export const pulseAt = (shown: number, period: number): number => (period > 0 && shown > 0 ? (shown % period) / period : 0);

// ── text ─────────────────────────────────────────────────────────────────────

/**
 * Words into lines no wider than `maxW` (by `measure`). Breaks at spaces only (Indic letters join, so never inside a
 * word); a word wider than the line stays on its own line (the caller shrinks or ellipsizes it). Newlines are kept.
 */
export function wrapWords(text: string, maxW: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && measure(next) > maxW) { out.push(line); line = w; } else line = next;
    }
    out.push(line);
  }
  return out;
}

/**
 * The largest size (from `size` down to `size × minFrac`, 4 % steps) at which `text` wraps into ≤ `maxLines` lines
 * that fit `maxW` and whose height (lines × size × lineH) fits `maxH`. At the smallest size the lines are cut to
 * `maxLines` with an ellipsis. `measure(s, size)` measures at a size.
 */
export function fitText(text: string, o: { maxW: number; maxH: number; size: number; minFrac?: number; maxLines?: number; lineH?: number },
  measure: (s: string, size: number) => number): { size: number; lines: string[]; shrunk: number; cut: boolean } {
  const minFrac = o.minFrac ?? 0.6, maxLines = Math.max(1, o.maxLines ?? 2), lineH = o.lineH ?? 1.18;
  const lo = o.size * minFrac;
  for (let s = o.size; s >= lo - 1e-6; s -= o.size * 0.04) {
    const lines = wrapWords(text, o.maxW, (x) => measure(x, s));
    if (lines.length <= maxLines && lines.length * s * lineH <= o.maxH + 0.5 && lines.every((l) => measure(l, s) <= o.maxW + 0.5)) {
      return { size: s, lines, shrunk: s / o.size, cut: false };
    }
  }
  const lines = wrapWords(text, o.maxW, (x) => measure(x, lo));
  const fit = Math.max(1, Math.min(maxLines, Math.floor((o.maxH + 0.5) / (lo * lineH))));
  const keep = lines.slice(0, fit);
  const cut = lines.length > fit || keep.some((l) => measure(l, lo) > o.maxW + 0.5);
  if (cut && keep.length) keep[keep.length - 1] = ellipsize(lines.slice(fit - 1).join(" "), o.maxW, (x) => measure(x, lo));
  return { size: lo, lines: keep, shrunk: minFrac, cut };
}
/** Cuts text to `maxW` with "…" (at word ends when it can). */
export function ellipsize(text: string, maxW: number, measure: (s: string) => number): string {
  if (measure(text) <= maxW) return text;
  const words = text.split(/\s+/);
  while (words.length > 1) { words.pop(); const s = `${words.join(" ")}…`; if (measure(s) <= maxW) return s; }
  const chars = Array.from(text);
  while (chars.length > 1) { chars.pop(); const s = `${chars.join("")}…`; if (measure(s) <= maxW) return s; }
  return "…";
}
