/**
 * The audio-reactive visualiser (docs/EDITOR.md §15.4): a generated video clip (ClipSource "visualizer") that draws
 * an audio clip's (or a media item's) precomputed spectrum frames (spectrum.ts) as bars, mirrored bars, a line wave, a
 * circle, particles or a filled spectrum, with colours, a gradient, glow, smoothing, a frequency range and a
 * sensitivity. The values of a frame depend only on the frame number (smoothing looks back over the frames before it,
 * never at what was drawn last), and the particles only on the time, so any frame drawn in any order, in the preview
 * or in the export, is the same picture.
 *
 * `VISUALIZER_STYLES` and `makeVisualizerSource` are the public API (the podcast audiogram template feature-detects
 * them). Drawing takes any Canvas 2D context; the rest is pure.
 */
import { clamp, hash01 } from "./dsp.ts";
import { fromByte, SPECTRUM_BANDS, type SpectrumData } from "./spectrum.ts";
import type { ClipSource, VisualizerStyle } from "../model/types.ts";

export type { VisualizerStyle } from "../model/types.ts";
export type VisualizerSource = Extract<ClipSource, { type: "visualizer" }>;

export const VISUALIZER_STYLES: readonly { id: VisualizerStyle; label: string }[] = [
  { id: "bars", label: "Bars" },
  { id: "mirror", label: "Mirrored bars" },
  { id: "line", label: "Line wave" },
  { id: "circle", label: "Circle" },
  { id: "particles", label: "Particles" },
  { id: "fill", label: "Spectrum fill" },
];

/** Colour sets for the picker (our own). */
export const VISUALIZER_PALETTES: { id: string; label: string; colors: string[] }[] = [
  { id: "aurora", label: "Aurora", colors: ["#22d3ee", "#a78bfa", "#f0abfc"] },
  { id: "sunset", label: "Sunset", colors: ["#fb923c", "#f43f5e", "#fde047"] },
  { id: "mint", label: "Mint", colors: ["#34d399", "#2dd4bf", "#bef264"] },
  { id: "mono", label: "White", colors: ["#ffffff", "#cbd5e1", "#94a3b8"] },
  { id: "gold", label: "Gold", colors: ["#fbbf24", "#f59e0b", "#fef3c7"] },
  { id: "neon", label: "Neon", colors: ["#e879f9", "#22d3ee", "#a3e635"] },
];

export interface VisualizerSettings {
  style: VisualizerStyle; colors: string[]; gradient: boolean;
  /** 0..1 */ glow: number;
  /** 0 (none) … 0.95 (slow fall) */ smoothing: number;
  /** Hz */ freqMin: number; freqMax: number;
  /** × the height (0.25 … 4) */ sensitivity: number;
  /** Bars (or points) drawn, 8 … 128. */ bars: number;
  /** x, y, w, h as fractions of the frame. */ box: [number, number, number, number];
  /** Bar width / line weight 0.1 … 1. */ thickness: number;
  background?: string;
  /** Spectrum bands precomputed (the sidecar key). */ bands: number;
  /** A media visualiser: media seconds at the clip's start. */ offset: number;
}

export const VISUALIZER_DEFAULTS: VisualizerSettings = {
  style: "bars", colors: VISUALIZER_PALETTES[0].colors, gradient: true, glow: 0.35, smoothing: 0.6, freqMin: 40, freqMax: 12000,
  sensitivity: 1, bars: 48, box: [0.1, 0.3, 0.8, 0.4], thickness: 0.7, bands: SPECTRUM_BANDS, offset: 0,
};

const STYLE_IDS = new Set<string>(VISUALIZER_STYLES.map((s) => s.id));
const num = (v: unknown, d: number, a: number, b: number) => (typeof v === "number" && Number.isFinite(v) ? clamp(v, a, b) : d);

/** A visualiser source's settings, every value present and in range. */
export function visualizerSettings(src: Partial<VisualizerSource>): VisualizerSettings {
  const d = VISUALIZER_DEFAULTS;
  const colors = Array.isArray(src.colors) && src.colors.length && src.colors.every((c) => typeof c === "string" && c.length < 64) ? src.colors.slice(0, 4) : d.colors;
  const box = Array.isArray(src.box) && src.box.length === 4 && src.box.every((x) => typeof x === "number" && Number.isFinite(x))
    ? [clamp(src.box[0], -0.5, 1), clamp(src.box[1], -0.5, 1), clamp(src.box[2], 0.02, 2), clamp(src.box[3], 0.02, 2)] as [number, number, number, number] : d.box;
  const fMin = num(src.freqMin, d.freqMin, 20, 15000), fMax = num(src.freqMax, d.freqMax, 60, 16000);
  return {
    style: STYLE_IDS.has(src.style as string) ? (src.style as VisualizerStyle) : d.style, colors, gradient: src.gradient ?? d.gradient,
    glow: num(src.glow, d.glow, 0, 1), smoothing: num(src.smoothing, d.smoothing, 0, 0.95),
    freqMin: Math.min(fMin, fMax / 1.5), freqMax: Math.max(fMax, fMin * 1.5), sensitivity: num(src.sensitivity, d.sensitivity, 0.25, 4),
    bars: Math.round(num(src.bars, d.bars, 8, 128)), box, thickness: num(src.thickness, d.thickness, 0.1, 1),
    ...(typeof src.background === "string" && src.background ? { background: src.background } : {}),
    bands: Number.isInteger(src.bands) && src.bands! >= 8 && src.bands! <= 128 ? src.bands! : d.bands, offset: num(src.offset, 0, 0, 1e7),
  };
}

/**
 * A visualiser clip source: drawn from an audio clip of the same sequence (kept in sync with it as it moves or is
 * trimmed) or from a media item (from `offset` seconds). Unset settings take the defaults.
 */
export function makeVisualizerSource(opts: { audioClipId?: string; mediaId?: string } & Partial<Omit<VisualizerSource, "type" | "audioClipId" | "mediaId">>): VisualizerSource {
  if (!opts.audioClipId && !opts.mediaId) throw new Error("A visualiser needs an audio clip or a media item");
  const s = visualizerSettings(opts as Partial<VisualizerSource>);
  const out: VisualizerSource = { type: "visualizer", style: s.style, colors: s.colors, gradient: s.gradient, glow: s.glow, smoothing: s.smoothing,
    freqMin: s.freqMin, freqMax: s.freqMax, sensitivity: s.sensitivity, bars: s.bars, box: s.box, thickness: s.thickness };
  if (opts.audioClipId) out.audioClipId = opts.audioClipId;
  if (opts.mediaId) out.mediaId = opts.mediaId;
  if (s.background) out.background = s.background;
  if (s.offset) out.offset = s.offset;
  if (s.bands !== SPECTRUM_BANDS) out.bands = s.bands;
  return out;
}
export const isVisualizerSource = (s: { type: string } | null | undefined): s is VisualizerSource => s?.type === "visualizer";

// ── values ───────────────────────────────────────────────────────────────────────────────────────────────

/** For each displayed bar: the spectrum bands it covers [i0, i1] (max over them), or an interpolation point. */
export interface BarMap { bars: number; spans: { i0: number; i1: number; at: number }[] }
const mapCache = new Map<string, BarMap>();

/**
 * Bars over [freqMin, freqMax] (log-spaced) → the precomputed bands: a bar that spans whole bands takes their peak, one
 * narrower than a band is interpolated at its centre.
 */
export function barMap(bands: number, fMin: number, fMax: number, bars: number, lo: number, hi: number): BarMap {
  const key = `${bands}|${fMin}|${fMax}|${bars}|${lo}|${hi}`;
  const hit = mapCache.get(key);
  if (hit) return hit;
  const a = clamp(lo, fMin, fMax), b = clamp(hi, a * 1.01, fMax);
  const pos = (f: number) => (Math.log(f / fMin) / Math.log(fMax / fMin)) * bands;
  const spans = Array.from({ length: bars }, (_, j) => {
    const f0 = a * Math.pow(b / a, j / bars), f1 = a * Math.pow(b / a, (j + 1) / bars);
    const p0 = pos(f0), p1 = pos(f1);
    const i0 = clamp(Math.floor(p0), 0, bands - 1), i1 = clamp(Math.ceil(p1) - 1, 0, bands - 1);
    return { i0, i1: Math.max(i0, i1), at: (p0 + p1) / 2 - 0.5 };
  });
  const m = { bars, spans };
  if (mapCache.size > 64) mapCache.clear();
  mapCache.set(key, m);
  return m;
}

/** 0..1 for a band's dB (−72 … −12 dB fills the box at sensitivity 1). */
export const barValue = (db: number, sensitivity: number) => clamp(((db + 72) / 60) * sensitivity, 0, 1);
/** 0..1 for the frame level (−60 … −6 dB). */
export const levelValue = (db: number, sensitivity: number) => clamp(((db + 60) / 54) * sensitivity, 0, 1);

/** One frame's bars and level before smoothing (zeros where the frame isn't in the audio's range). */
export function rawValues(spec: SpectrumData, n: number, s: VisualizerSettings, map: BarMap): { bars: Float32Array; level: number } {
  const out = new Float32Array(map.bars);
  if (n < 0 || n >= spec.frames) return { bars: out, level: 0 };
  const stride = spec.bands + 1, o = n * stride, d = spec.data;
  for (let j = 0; j < map.bars; j++) {
    const { i0, i1, at } = map.spans[j];
    let db: number;
    if (i1 > i0) { let m = 0; for (let i = i0; i <= i1; i++) if (d[o + i] > m) m = d[o + i]; db = fromByte(m); }
    else {
      const k = clamp(Math.floor(at), 0, spec.bands - 2), t = clamp(at - k, 0, 1);
      db = fromByte(d[o + k]) * (1 - t) + fromByte(d[o + k + 1]) * t;
    }
    out[j] = barValue(db, s.sensitivity);
  }
  return { bars: out, level: levelValue(fromByte(d[o + spec.bands]), s.sensitivity) };
}

/**
 * The values drawn for spectrum frame `n`: each bar is the largest of its last frames decayed by `smoothing` per frame
 * (peaks fall slowly, attacks are instant). `inRange(k)` says whether frame k is inside the audio clip (silence else).
 */
export function frameValues(spec: SpectrumData | null, n: number, s: VisualizerSettings, inRange: (k: number) => boolean = () => true): { bars: Float32Array; level: number } {
  const bars = new Float32Array(s.bars);
  if (!spec) return { bars, level: 0 };
  const map = barMap(spec.bands, spec.fMin, spec.fMax, s.bars, s.freqMin, s.freqMax);
  const K = s.smoothing > 0.01 ? Math.min(24, Math.ceil(Math.log(0.05) / Math.log(s.smoothing))) : 0;
  let level = 0;
  for (let k = 0; k <= K; k++) {
    const f = n - k;
    if (f < 0) break;
    if (!inRange(f)) continue;
    const w = Math.pow(s.smoothing, k);
    const r = rawValues(spec, f, s, map);
    for (let j = 0; j < bars.length; j++) { const v = r.bars[j] * w; if (v > bars[j]) bars[j] = v; }
    level = Math.max(level, r.level * w);
  }
  return { bars, level };
}

// ── drawing ──────────────────────────────────────────────────────────────────────────────────────────────

/** The Canvas 2D calls the drawing uses (an HTML or offscreen canvas's context, or a recorder in the tests). */
export type Ctx2D = Pick<CanvasRenderingContext2D, "save" | "restore" | "clearRect" | "fillRect" | "beginPath" | "moveTo" | "lineTo" | "quadraticCurveTo"
  | "closePath" | "fill" | "stroke" | "arc" | "createLinearGradient" | "createRadialGradient"> & {
  fillStyle: unknown; strokeStyle: unknown; lineWidth: number; lineCap: string; lineJoin: string; shadowColor: string; shadowBlur: number; globalAlpha: number;
};

const PARTICLES = 96;

/**
 * Draws one frame into a W×H context (cleared first; transparent outside the drawing unless a background is set) and
 * returns the box it may have drawn in (pixels x, y, w, h), for CustomSource.bounds.
 */
export function drawVisualizer(ctx: Ctx2D, W: number, H: number, v: { bars: Float32Array; level: number }, s: VisualizerSettings, t: number): [number, number, number, number] {
  ctx.clearRect(0, 0, W, H);
  if (s.background) { ctx.fillStyle = s.background; ctx.fillRect(0, 0, W, H); }
  const bx = s.box[0] * W, by = s.box[1] * H, bw = s.box[2] * W, bh = s.box[3] * H;
  const c0 = s.colors[0] ?? "#22d3ee", c1 = s.colors[1] ?? c0, c2 = s.colors[2] ?? c1;
  const glow = s.glow * Math.min(W, H) * 0.03;
  const n = v.bars.length;
  const lw = Math.max(1.5, s.thickness * 0.008 * Math.min(W, H));
  ctx.save();
  if (glow > 0.5) { ctx.shadowColor = c0; ctx.shadowBlur = glow; }
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  const vgrad = (y0: number, y1: number, mid = false) => {
    if (!s.gradient || c1 === c0) return c0;
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    if (mid) { g.addColorStop(0, c1); g.addColorStop(0.5, c0); g.addColorStop(1, c1); } else { g.addColorStop(0, c0); g.addColorStop(1, c1); }
    return g;
  };
  const hgrad = () => {
    if (!s.gradient || c1 === c0) return c0;
    const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    g.addColorStop(0, c0); g.addColorStop(0.5, c1); g.addColorStop(1, c2);
    return g;
  };
  const slot = bw / Math.max(1, n);
  const minH = Math.max(1, bh * 0.012);
  /** A smooth path through the points (quadratics through their midpoints). */
  const smooth = (xs: number[], ys: number[], start: boolean) => {
    if (start) ctx.moveTo(xs[0], ys[0]); else ctx.lineTo(xs[0], ys[0]);
    for (let i = 1; i < xs.length - 1; i++) ctx.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[i + 1]) / 2, (ys[i] + ys[i + 1]) / 2);
    ctx.lineTo(xs[xs.length - 1], ys[ys.length - 1]);
  };
  let extra = 0;
  switch (s.style) {
    case "bars": {
      ctx.fillStyle = vgrad(by + bh, by);
      const w = Math.max(1, slot * s.thickness);
      for (let j = 0; j < n; j++) { const h = Math.max(minH, v.bars[j] * bh); ctx.fillRect(bx + j * slot + (slot - w) / 2, by + bh - h, w, h); }
      break;
    }
    case "mirror": {
      ctx.fillStyle = vgrad(by, by + bh, true);
      const w = Math.max(1, slot * s.thickness), cy = by + bh / 2;
      for (let j = 0; j < n; j++) { const h = Math.max(minH, v.bars[j] * bh); ctx.fillRect(bx + j * slot + (slot - w) / 2, cy - h / 2, w, h); }
      break;
    }
    case "line": {
      const cy = by + bh / 2;
      const xs = [bx, ...Array.from({ length: n }, (_, j) => bx + (j + 0.5) * slot), bx + bw];
      const amp = [0, ...v.bars, 0].map((x) => x * bh * 0.5);
      ctx.strokeStyle = hgrad(); ctx.lineWidth = lw;
      ctx.beginPath(); smooth(xs, amp.map((a) => cy - a), true); ctx.stroke();
      ctx.beginPath(); smooth(xs, amp.map((a) => cy + a), true); ctx.stroke();
      break;
    }
    case "fill": {
      const base = by + bh;
      const xs = [bx, ...Array.from({ length: n }, (_, j) => bx + (j + 0.5) * slot), bx + bw];
      const ys = [base, ...Array.from(v.bars, (x) => base - Math.max(minH, x * bh)), base];
      ctx.beginPath(); smooth(xs, ys, true); ctx.lineTo(bx + bw, base); ctx.lineTo(bx, base); ctx.closePath();
      ctx.globalAlpha = 0.75; ctx.fillStyle = vgrad(by, base); ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = c0; ctx.lineWidth = lw;
      ctx.beginPath(); smooth(xs, ys, true); ctx.stroke();
      break;
    }
    case "circle": {
      const cx = bx + bw / 2, cy = by + bh / 2, R = Math.min(bw, bh) / 2;
      const r0 = R * 0.55 * (1 + 0.12 * v.level), len = R * 0.45;
      const spokes = n * 2;
      ctx.lineWidth = Math.max(1.5, ((2 * Math.PI * r0) / spokes) * s.thickness * 0.8);
      ctx.strokeStyle = vgrad(cy - R, cy + R);
      ctx.beginPath();
      for (let k = 0; k < spokes; k++) {
        const val = v.bars[k < n ? k : spokes - 1 - k];
        const a = -Math.PI / 2 + ((k + 0.5) / spokes) * 2 * Math.PI;
        const r1 = r0 + Math.max(R * 0.02, val * len);
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      }
      ctx.stroke();
      ctx.globalAlpha = 0.6; ctx.strokeStyle = c2; ctx.lineWidth = Math.max(1, lw * 0.6);
      ctx.beginPath(); ctx.arc(cx, cy, r0 * 0.94, 0, 2 * Math.PI); ctx.stroke();
      extra = R * 0.12;
      break;
    }
    case "particles": {
      const cx = bx + bw / 2, cy = by + bh / 2, m = Math.min(W, H);
      const cols = [c0, c1, c2];
      ctx.globalAlpha = 0.25 + 0.5 * v.level; ctx.fillStyle = c0;
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(1, Math.min(bw, bh) * (0.04 + 0.08 * v.level)), 0, 2 * Math.PI); ctx.fill();
      for (let i = 0; i < PARTICLES; i++) {
        const a = hash01(i, 1) * 2 * Math.PI, sp = 0.35 + 0.65 * hash01(i, 2), life = 2.2 + 1.6 * hash01(i, 3);
        const age = (((t * sp + hash01(i, 4) * life) % life) + life) % life, u = age / life;
        const d = Math.pow(u, 0.8);
        const x = cx + Math.cos(a) * d * bw * 0.5, y = cy + Math.sin(a) * d * bh * 0.5;
        const b = n ? v.bars[(i * 7) % n] : 0;
        const r = (0.003 + 0.007 * hash01(i, 5)) * m * (0.6 + 1.6 * b);
        ctx.globalAlpha = clamp((1 - u) * (0.25 + 0.75 * Math.max(v.level, b)), 0, 1);
        ctx.fillStyle = cols[i % 3];
        ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, r), 0, 2 * Math.PI); ctx.fill();
      }
      extra = m * 0.02;
      break;
    }
  }
  ctx.restore();
  if (s.background) return [0, 0, W, H];
  const mg = glow * 2 + lw + extra + 2;
  return [bx - mg, by - mg, bw + 2 * mg, bh + 2 * mg];
}
