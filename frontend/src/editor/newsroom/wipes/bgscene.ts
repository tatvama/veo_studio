/**
 * Procedural news backgrounds (docs/EDITOR.md §16, nr-wipes): a background is a list of simple primitives (glows,
 * circles, lines, polygons, text) computed from the loop phase φ = (t / period) mod 1 with whole-number cycles only,
 * so t and t + period give exactly the same picture and every loop is seamless. The "bg" kind (render/kinds/bg.ts)
 * paints the primitives in the look's colours. Pure: no canvas, seeded hashes only.
 */
import { hash01, type Pt } from "./geometry.ts";

export type BgStyle = "grid" | "streaks" | "globe" | "dots" | "bokeh" | "waves" | "particles" | "hex" | "gradient" | "tape";
export const BG_STYLES: { value: BgStyle; label: string }[] = [
  { value: "grid", label: "News grid" }, { value: "streaks", label: "Light streaks" }, { value: "globe", label: "Wireframe globe" },
  { value: "dots", label: "Dotted globe" }, { value: "bokeh", label: "Bokeh" }, { value: "waves", label: "Waves" },
  { value: "particles", label: "Drifting particles" }, { value: "hex", label: "Hex mesh" }, { value: "gradient", label: "Gradient flow" },
  { value: "tape", label: "Ticker tape" },
];

/** Palette slots a primitive uses: the kind maps them to the layer's colours. */
export type BgColor = "main" | "accent" | "light" | "top" | "bottom" | "up" | "down";

export type BgPrim =
  | { k: "glow"; x: number; y: number; r: number; c: BgColor; a: number }
  | { k: "dot"; x: number; y: number; r: number; c: BgColor; a: number }
  | { k: "ring"; x: number; y: number; r: number; c: BgColor; a: number; w: number }
  | { k: "line"; pts: Pt[]; c: BgColor; a: number; w: number; closed?: boolean }
  | { k: "poly"; pts: Pt[]; c: BgColor; a: number }
  | { k: "text"; x: number; y: number; s: string; size: number; c: BgColor; a: number };

export interface BgParams {
  style: BgStyle; period: number; density: number; seed: number; speed: number;
  /** Globes: centre (fractions of the frame) and radius (fraction of the shorter side); null = the ratio's default. */
  cx: number | null; cy: number | null; r: number | null;
}

export function bgParams(p: Record<string, unknown>): BgParams {
  const n = (v: unknown, d: number, lo: number, hi: number) => { const x = typeof v === "number" && Number.isFinite(v) ? v : d; return Math.min(hi, Math.max(lo, x)); };
  const style = BG_STYLES.some((s) => s.value === p.style) ? (p.style as BgStyle) : "grid";
  const opt = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
  return {
    style, period: n(p.period, 12, 2, 120), density: n(p.density, 1, 0.2, 2), seed: Math.round(n(p.seed, 1, 0, 1e9)), speed: Math.round(n(p.speed, 1, 1, 6)),
    cx: opt(p.cx, -0.5, 1.5), cy: opt(p.cy, -0.5, 1.5), r: opt(p.r, 0.05, 1.5),
  };
}

/** The loop phase 0..1 at t (whole periods drop out exactly). */
export function bgPhase(period: number, t: number): number {
  const P = Math.max(1e-3, period);
  const x = (t / P) % 1;
  const r = x < 0 ? x + 1 : x;
  // snap away float dust so t and t + P agree to the last bit
  return Math.round(r * 1e9) / 1e9 % 1;
}

const TAU = Math.PI * 2;
const h = (i: number, seed: number, salt: number) => hash01(i, seed, salt);
const wrap = (x: number, m: number) => ((x % m) + m) % m;

// ── styles ───────────────────────────────────────────────────────────────────

function grid(f: number, W: number, H: number, P: BgParams): BgPrim[] {
  const out: BgPrim[] = [];
  const hz = H * (H > W ? 0.52 : 0.6), cx = W / 2;
  out.push({ k: "glow", x: cx, y: hz, r: Math.max(W, H) * 0.55, c: "main", a: 0.35 });
  out.push({ k: "glow", x: cx, y: hz, r: Math.max(W, H) * 0.18, c: "light", a: 0.12 });
  // the floor: lines to the vanishing point, and cross lines coming towards us (one slot per loop × speed)
  const n = Math.round(14 * P.density);
  for (let i = -n; i <= n; i++) {
    const xb = cx + i * (W / n) * 1.6;
    out.push({ k: "line", pts: [[cx + i * W * 0.012, hz], [xb, H + 4]], c: "main", a: 0.5, w: 2 });
  }
  const K = 16;
  for (let k = 0; k < K; k++) {
    const z = (k + 1 - wrap(f * P.speed * 2, 1)) / K;           // 0 near … 1 far
    const y = hz + (H - hz) * Math.pow(1 - z, 2.2);
    const a = 0.6 * Math.sin(Math.PI * Math.min(1, Math.max(0, (1 - z) * 1.05)));
    if (a > 0.004) out.push({ k: "line", pts: [[-4, y], [W + 4, y]], c: "main", a, w: 2 });
  }
  // a mirrored ceiling, fainter
  for (let k = 0; k < K; k++) {
    const z = (k + 1 - wrap(f * P.speed * 2, 1)) / K;
    const y = hz * 0.22 - hz * 0.22 * Math.pow(1 - z, 2.2) * 1.0;
    const a = 0.14 * Math.sin(Math.PI * Math.min(1, Math.max(0, (1 - z) * 1.05)));
    if (a > 0.004) out.push({ k: "line", pts: [[-4, y], [W + 4, y]], c: "accent", a, w: 1 });
  }
  // soft beams of light above the horizon, breathing
  for (let i = 0; i < 5; i++) {
    const x = W * (0.1 + 0.8 * h(i, P.seed, 1)), bw = 70 + 110 * h(i, P.seed, 3);
    const a = 0.03 + 0.04 * (0.5 + 0.5 * Math.sin(TAU * (f * (1 + (i % 2)) + h(i, P.seed, 2))));
    out.push({ k: "poly", pts: [[x - bw, hz], [x + bw, hz], [x + bw * 0.6, 0], [x - bw * 0.6, 0]], c: "light", a });
  }
  out.push({ k: "line", pts: [[-4, hz], [W + 4, hz]], c: "light", a: 0.25, w: 2 });
  // a scan line across the horizon
  const sx = wrap(f * P.speed, 1) * (W + 600) - 300;
  out.push({ k: "line", pts: [[sx - 300, hz], [sx + 300, hz]], c: "light", a: 0.5, w: 3 });
  return out;
}

function streaks(f: number, W: number, H: number, P: BgParams): BgPrim[] {
  const out: BgPrim[] = [];
  out.push({ k: "glow", x: W * 0.3, y: H * 0.35, r: Math.max(W, H) * 0.6, c: "main", a: 0.28 });
  out.push({ k: "glow", x: W * 0.85, y: H * 0.8, r: Math.max(W, H) * 0.45, c: "accent", a: 0.12 });
  const n = Math.round(40 * P.density);
  const ang = -0.38, ux = Math.cos(ang), uy = Math.sin(ang);
  const span = W + H;
  for (let i = 0; i < n; i++) {
    const len = 180 + 520 * h(i, P.seed, 3);
    const off = (h(i, P.seed, 4) - 0.5) * span * 0.75;          // across the travel
    const cyc = P.speed * (1 + (i % 3));
    const s = wrap(h(i, P.seed, 5) + f * cyc, 1) * (span + len * 2) - span / 2 - len;
    const cx = W / 2 + ux * s - uy * off, cy = H / 2 + uy * s + ux * off;
    const c: BgColor = i % 5 === 0 ? "accent" : i % 3 === 0 ? "light" : "main";
    const a = 0.22 + 0.4 * h(i, P.seed, 6);
    const w = 1.5 + 5 * h(i, P.seed, 7);
    const p0: Pt = [cx - ux * len / 2, cy - uy * len / 2], p1: Pt = [cx + ux * len / 2, cy + uy * len / 2];
    out.push({ k: "line", pts: [p0, p1], c, a: a * 0.3, w: w * 5 });
    out.push({ k: "line", pts: [p0, p1], c, a, w });
  }
  return out;
}

/** A sphere point (lat, lon) turned by `spin` about the vertical axis and tilted, projected: [x, y, z]. */
function sphere(lat: number, lon: number, spin: number, tilt: number): [number, number, number] {
  const cl = Math.cos(lat);
  const x = cl * Math.sin(lon + spin), y = Math.sin(lat), z = cl * Math.cos(lon + spin);
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  return [x, y * ct - z * st, y * st + z * ct];
}

function globeAt(W: number, H: number, P: BgParams): { cx: number; cy: number; R: number } {
  const d = H > W ? { cx: W / 2, cy: H * 0.42, R: W * 0.44 } : { cx: W * 0.66, cy: H * 0.5, R: H * 0.4 };
  return { cx: P.cx !== null ? P.cx * W : d.cx, cy: P.cy !== null ? P.cy * H : d.cy, R: P.r !== null ? P.r * Math.min(W, H) : d.R };
}

function globe(f: number, W: number, H: number, P: BgParams): BgPrim[] {
  const out: BgPrim[] = [];
  const { cx, cy, R } = globeAt(W, H, P);
  out.push({ k: "glow", x: cx, y: cy, r: R * 1.9, c: "main", a: 0.32 });
  out.push({ k: "dot", x: cx, y: cy, r: R, c: "bottom", a: 0.55 });
  const M = 18, tilt = 0.38;
  const spin = (f * P.speed * TAU) / M;  // one meridian spacing per loop
  const seg = 48;
  for (let j = 0; j < M; j++) {
    const lon = (j * TAU) / M;
    let cur: Pt[] = [], front = true;
    const flush = () => { if (cur.length > 1) out.push({ k: "line", pts: cur, c: front ? "main" : "main", a: front ? 0.75 : 0.16, w: front ? 2 : 1.2 }); };
    for (let i = 0; i <= seg; i++) {
      const lat = -Math.PI / 2 + (Math.PI * i) / seg;
      const [x, y, z] = sphere(lat, lon, spin, tilt);
      const fr = z >= 0;
      const pt: Pt = [cx + x * R, cy - y * R];
      if (i > 0 && fr !== front) { cur.push(pt); flush(); cur = [pt]; front = fr; } else { if (i === 0) front = fr; cur.push(pt); }
    }
    flush();
  }
  for (let k = -2; k <= 2; k++) {
    const lat = (k * Math.PI) / 6;
    let cur: Pt[] = [], front = true;
    const flush = () => { if (cur.length > 1) out.push({ k: "line", pts: cur, c: k === 0 ? "accent" : "main", a: front ? (k === 0 ? 0.8 : 0.6) : 0.14, w: front ? 1.8 : 1 }); };
    for (let i = 0; i <= 72; i++) {
      const [x, y, z] = sphere(lat, (i * TAU) / 72, 0, tilt);
      const fr = z >= 0;
      const pt: Pt = [cx + x * R, cy - y * R];
      if (i > 0 && fr !== front) { cur.push(pt); flush(); cur = [pt]; front = fr; } else { if (i === 0) front = fr; cur.push(pt); }
    }
    flush();
  }
  out.push({ k: "ring", x: cx, y: cy, r: R, c: "light", a: 0.45, w: 2.5 });
  // an orbit with a satellite going round once per loop
  const orb: Pt[] = [];
  for (let i = 0; i <= 96; i++) { const a = (i * TAU) / 96; orb.push([cx + Math.cos(a) * R * 1.32, cy + Math.sin(a) * R * 0.34]); }
  out.push({ k: "line", pts: orb, c: "accent", a: 0.35, w: 1.5 });
  const sa = f * TAU * P.speed;
  out.push({ k: "glow", x: cx + Math.cos(sa) * R * 1.32, y: cy + Math.sin(sa) * R * 0.34, r: 26, c: "light", a: 0.9 });
  out.push({ k: "dot", x: cx + Math.cos(sa) * R * 1.32, y: cy + Math.sin(sa) * R * 0.34, r: 5, c: "light", a: 1 });
  return out;
}

/** Smooth 3D value noise for the dotted globe's made-up land (no real geography: no borders to get wrong). */
function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(fx), v = s(fy), w = s(fz);
  const H3 = (a: number, b: number, c: number) => hash01(a * 7349 + b * 3691 + c, seed, 911);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(l(l(H3(xi, yi, zi), H3(xi + 1, yi, zi), u), l(H3(xi, yi + 1, zi), H3(xi + 1, yi + 1, zi), u), v),
    l(l(H3(xi, yi, zi + 1), H3(xi + 1, yi, zi + 1), u), l(H3(xi, yi + 1, zi + 1), H3(xi + 1, yi + 1, zi + 1), u), v), w);
}

const landCache = new Map<string, [number, number, boolean][]>();
/** Points spread evenly over a sphere (lat, lon, land?). */
function landDots(n: number, seed: number): [number, number, boolean][] {
  const key = `${n}:${seed}`;
  let pts = landCache.get(key);
  if (!pts) {
    pts = [];
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), th = ga * i;
      const x = Math.cos(th) * r, z = Math.sin(th) * r;
      const v = noise3(x * 2.3 + 3, y * 2.3 + 3, z * 2.3 + 3, seed) * 0.72 + noise3(x * 5 + 9, y * 5 + 9, z * 5 + 9, seed) * 0.28;
      pts.push([Math.asin(y), Math.atan2(x, z), v > 0.5 && Math.abs(y) < 0.9]);
    }
    landCache.set(key, pts);
  }
  return pts;
}

function dots(f: number, W: number, H: number, P: BgParams): BgPrim[] {
  const out: BgPrim[] = [];
  const { cx, cy, R } = globeAt(W, H, P);
  out.push({ k: "glow", x: cx, y: cy, r: R * 1.8, c: "main", a: 0.3 });
  out.push({ k: "ring", x: cx, y: cy, r: R * 1.01, c: "main", a: 0.35, w: 2 });
  const spin = f * TAU * P.speed;  // a full turn per loop
  const all = landDots(Math.round(3000 * P.density), P.seed);
  const land = all.filter((p) => p[2]);
  const dr = Math.max(1.6, R * 0.0085);
  for (const [lat, lon, isLand] of all) {
    const [x, y, z] = sphere(lat, lon, spin, 0.32);
    if (z < 0.02) continue;
    if (isLand) out.push({ k: "dot", x: cx + x * R, y: cy - y * R, r: dr * (0.65 + 0.45 * z), c: "light", a: 0.3 + 0.65 * z });
    else out.push({ k: "dot", x: cx + x * R, y: cy - y * R, r: dr * 0.55, c: "main", a: 0.12 + 0.2 * z });
  }
  // a few cities pulsing (each pulse loops a whole number of times)
  for (let i = 0; i < 6; i++) {
    const [lat, lon] = land[Math.floor(h(i, P.seed, 21) * land.length)] ?? [0, 0];
    const [x, y, z] = sphere(lat, lon, spin, 0.32);
    if (z < 0.15) continue;
    const ph = wrap(f * (2 + (i % 2)) + h(i, P.seed, 22), 1);
    out.push({ k: "ring", x: cx + x * R, y: cy - y * R, r: 6 + 40 * ph, c: "accent", a: 0.8 * (1 - ph) * z, w: 2 });
    out.push({ k: "dot", x: cx + x * R, y: cy - y * R, r: 4, c: "accent", a: z });
  }
  return out;
}

function bokeh(f: number, W: number, H: number, P: BgParams): BgPrim[] {
  const out: BgPrim[] = [];
  out.push({ k: "glow", x: W * 0.5, y: H * 0.45, r: Math.max(W, H) * 0.7, c: "main", a: 0.22 });
  const n = Math.round(34 * P.density);
  const M = Math.max(W, H);
  for (let i = 0; i < n; i++) {
    const r = M * (0.02 + 0.07 * Math.pow(h(i, P.seed, 31), 2));
    const x = W * h(i, P.seed, 32) + M * 0.05 * Math.sin(TAU * (f * P.speed + h(i, P.seed, 33)));
    const y = H * h(i, P.seed, 34) + M * 0.04 * Math.sin(TAU * (f * P.speed * 2 + h(i, P.seed, 35)));
    const a = (0.08 + 0.2 * h(i, P.seed, 36)) * (0.6 + 0.4 * Math.sin(TAU * (f * (1 + (i % 3)) + h(i, P.seed, 37))));
    const c: BgColor = i % 4 === 0 ? "accent" : i % 3 === 0 ? "light" : "main";
    out.push({ k: "dot", x, y, r, c, a });
    out.push({ k: "ring", x, y, r, c, a: a * 0.9, w: 2 });
  }
  return out;
}

function waves(f: number, W: number, H: number, P: BgParams): BgPrim[] {
  const out: BgPrim[] = [];
  out.push({ k: "glow", x: W * 0.5, y: H * 0.6, r: Math.max(W, H) * 0.6, c: "main", a: 0.25 });
  const n = Math.round(9 * P.density);
  const seg = 90;
  for (let i = 0; i < n; i++) {
    const y0 = H * (0.42 + 0.3 * (i / Math.max(1, n - 1))), A = H * (0.03 + 0.05 * h(i, P.seed, 41));
    const k1 = 1 + (i % 2), k2 = 2 + (i % 3), c1 = P.speed * (1 + (i % 2)), c2 = P.speed;
    const o1 = h(i, P.seed, 42), o2 = h(i, P.seed, 43);
    const pts: Pt[] = [];
    for (let j = 0; j <= seg; j++) {
      const x = (W * j) / seg, u = j / seg;
      pts.push([x, y0 + A * Math.sin(TAU * (k1 * u + c1 * f + o1)) + A * 0.4 * Math.sin(TAU * (k2 * u - c2 * f + o2))]);
    }
    const c: BgColor = i === Math.floor(n / 2) ? "accent" : i % 2 ? "light" : "main";
    if (i % 3 === 0) out.push({ k: "poly", pts: [...pts, [W, H + 4], [0, H + 4]], c: "main", a: 0.07 });
    out.push({ k: "line", pts, c, a: c === "accent" ? 0.7 : 0.32, w: c === "accent" ? 3 : 1.6 });
  }
  return out;
}

function particles(f: number, W: number, H: number, P: BgParams): BgPrim[] {
  const out: BgPrim[] = [];
  out.push({ k: "glow", x: W * 0.5, y: H, r: Math.max(W, H) * 0.75, c: "main", a: 0.3 });
  const n = Math.round(150 * P.density);
  const Hx = H + 80;
  for (let i = 0; i < n; i++) {
    const depth = h(i, P.seed, 51);
    const cyc = P.speed * (1 + Math.floor(depth * 3));
    const y = wrap(h(i, P.seed, 52) * Hx - f * cyc * Hx, Hx) - 40;
    const x = W * h(i, P.seed, 53) + 30 * Math.sin(TAU * (f * P.speed * 2 + h(i, P.seed, 54)));
    const tw = 0.5 + 0.5 * Math.sin(TAU * (f * (2 + (i % 4)) + h(i, P.seed, 55)));
    const c: BgColor = i % 7 === 0 ? "accent" : "light";
    out.push({ k: "dot", x, y, r: 1.2 + 3.2 * depth, c, a: (0.15 + 0.55 * depth) * (0.4 + 0.6 * tw) });
  }
  return out;
}

function hex(f: number, W: number, H: number, P: BgParams): BgPrim[] {
  const out: BgPrim[] = [];
  out.push({ k: "glow", x: W * 0.3, y: H * 0.4, r: Math.max(W, H) * 0.65, c: "main", a: 0.25 });
  const s = 46 / Math.sqrt(P.density);                // hex radius
  const dx = s * Math.sqrt(3), dy = s * 1.5;
  const cols = Math.ceil(W / dx) + 2, rows = Math.ceil(H / dy) + 2;
  const ox = W * 0.3, oy = H * 0.4;
  for (let r = -1; r < rows; r++) for (let q = -1; q < cols; q++) {
    const x = q * dx + (r % 2 ? dx / 2 : 0), y = r * dy;
    const pts: Pt[] = [];
    for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + (k * Math.PI) / 3; pts.push([x + Math.cos(a) * s * 0.94, y + Math.sin(a) * s * 0.94]); }
    const d = Math.hypot(x - ox, y - oy) / Math.max(W, H);
    const wave = Math.pow(0.5 + 0.5 * Math.cos(TAU * (f * P.speed * 2 - d * 2.5)), 6);
    const idx = (r + 1) * 1000 + q + 1;
    const flick = h(idx, P.seed, 61) > 0.93 ? Math.pow(0.5 + 0.5 * Math.sin(TAU * (f * (1 + (idx % 3)) + h(idx, P.seed, 62))), 4) : 0;
    const lit = Math.min(1, wave * 0.55 + flick * 0.8);
    out.push({ k: "line", pts, c: "main", a: 0.24 + 0.5 * lit, w: 2, closed: true });
    if (lit > 0.05) out.push({ k: "poly", pts, c: flick > wave ? "accent" : "main", a: lit * 0.22 });
  }
  return out;
}

function gradient(f: number, W: number, H: number, P: BgParams): BgPrim[] {
  const out: BgPrim[] = [];
  const M = Math.max(W, H);
  const blobs: [BgColor, number][] = [["main", 0.55], ["top", 0.5], ["accent", 0.22], ["main", 0.4], ["light", 0.08]];
  blobs.forEach(([c, a], i) => {
    const fx = 1 + (i % 2), fy = 1 + ((i + 1) % 2);
    const x = W * (0.5 + 0.38 * Math.sin(TAU * (fx * f * P.speed + h(i, P.seed, 71))));
    const y = H * (0.5 + 0.36 * Math.cos(TAU * (fy * f * P.speed + h(i, P.seed, 72))));
    out.push({ k: "glow", x, y, r: M * (0.45 + 0.25 * h(i, P.seed, 73)), c, a });
  });
  // soft diagonal sheen bands drifting across once per loop
  for (let i = 0; i < 3; i++) {
    const s = wrap(f * P.speed + i / 3, 1) * (W + H) * 1.4 - (W + H) * 0.2;
    out.push({ k: "poly", pts: [[s - H, H], [s - H + 300, H], [s + 300, 0], [s, 0]], c: "light", a: 0.022 });
  }
  return out;
}

const TAPE_ROWS = 7;
function tapeItem(i: number, seed: number): { s: string; up: boolean } {
  const up = h(i, seed, 81) > 0.42;
  const big = Math.floor(100 + h(i, seed, 82) * 79900), dec = Math.floor(h(i, seed, 83) * 100);
  const pct = (0.05 + h(i, seed, 84) * 3.5).toFixed(2);
  const grp = big.toLocaleString("en-IN");
  return { s: `${up ? "▲" : "▼"} ${grp}.${String(dec).padStart(2, "0")}  ${up ? "+" : "−"}${pct}%`, up };
}
function tape(f: number, W: number, H: number, P: BgParams): BgPrim[] {
  const out: BgPrim[] = [];
  out.push({ k: "glow", x: W * 0.5, y: H * 0.5, r: Math.max(W, H) * 0.7, c: "main", a: 0.22 });
  const slot = 460, perRow = Math.ceil((W + slot) / slot) + 1;
  const rowLen = perRow * slot;
  for (let r = 0; r < TAPE_ROWS; r++) {
    const y = H * (0.1 + (0.8 * r) / (TAPE_ROWS - 1));
    const size = 26 + 18 * h(r, P.seed, 85);
    const a = 0.1 + 0.25 * h(r, P.seed, 86);
    const dir = r % 2 ? 1 : -1;
    const off = wrap(f * P.speed * (1 + (r % 2)) * rowLen * dir, rowLen);
    out.push({ k: "line", pts: [[0, y + size * 0.85], [W, y + size * 0.85]], c: "main", a: a * 0.8, w: 1 });
    for (let j = 0; j < perRow; j++) {
      const x = wrap(j * slot + off, rowLen) - slot;
      if (x > W + 10) continue;
      const it = tapeItem(r * 100 + j, P.seed);
      out.push({ k: "text", x, y, s: it.s, size, c: it.up ? "up" : "down", a: a * 1.6 });
    }
  }
  return out;
}

const STYLES: Record<BgStyle, (f: number, W: number, H: number, P: BgParams) => BgPrim[]> = { grid, streaks, globe, dots, bokeh, waves, particles, hex, gradient, tape };

/** The primitives of a background at t (W×H box, design px). Same for t and t + period. */
export function bgScene(P: BgParams, W: number, H: number, t: number): BgPrim[] {
  return STYLES[P.style](bgPhase(P.period, t), W, H, P);
}
