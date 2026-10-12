/**
 * The procedural luma-matte library (docs/EDITOR.md §10): 66 patterns, each a small GLSL function the GPU renders
 * once per aspect ratio into a texture, equalised so every matte sweeps at an even pace (its histogram's CDF), and
 * one transition shader ("tv:matte_<id>") that wipes through it with softness, invert, angle and an optional glowing
 * edge (burns). Seeds come from the id (FNV-1a → mulberry32), so a matte is the same on every run and machine. Pure.
 *
 * A body computes `float m` from `p` (centred, aspect-corrected: x in ±asp/2, y in ±0.5, y down), `uv` (0..1),
 * `r` = |p|, `th` (angle from 12 o'clock, clockwise, −π..π), `asp` and `S` (vec4 seeds 0..1). Lower values switch
 * to the incoming picture first. Only the order matters (equalisation removes any monotone remap).
 */

export interface MatteDef {
  id: string; label: string; body: string;
  /** Default softness of the wipe edge (0..0.5). */
  softness?: number;
  /** A glowing edge: width (matte units) and colour (burns, ink). */
  edge?: [number, number, number, number];
}

const T = "6.283185307179586";
export const MATTES: MatteDef[] = [
  // gradients
  { id: "linear", label: "Linear wipe", body: "return uv.x;", softness: 0.2 },
  { id: "linear_up", label: "Linear wipe up", body: "return 1.0 - uv.y;", softness: 0.2 },
  { id: "diagonal", label: "Diagonal wipe", body: "return uv.x + uv.y;", softness: 0.2 },
  { id: "radial", label: "Radial", body: "return r;", softness: 0.2 },
  { id: "radial_corner", label: "Radial from corner", body: "return length((uv - vec2(0.0)) * vec2(asp, 1.0));", softness: 0.2 },
  { id: "radial_oval", label: "Oval", body: "return length(p / vec2(asp, 1.0));", softness: 0.2 },
  { id: "radial_double", label: "Two circles", body: "return min(length(p - vec2(-asp * 0.25, 0.0)), length(p - vec2(asp * 0.25, 0.0)));", softness: 0.2 },
  { id: "conic_corner", label: "Fan from corner", body: "vec2 q = (uv - vec2(0.0, 1.0)) * vec2(asp, 1.0); return atan(-q.y, q.x);", softness: 0.2 },
  { id: "conic", label: "Conic sweep", body: `return mod(th + 1.5707963, ${T});`, softness: 0.2 },
  // clock wipes
  { id: "clock", label: "Clock wipe", body: `return mod(th, ${T});` },
  { id: "clock_2", label: "Clock wipe, two hands", body: "return mod(th, 3.14159265);" },
  { id: "clock_4", label: "Clock wipe, four hands", body: "return mod(th, 1.5707963);" },
  { id: "clock_split", label: "Clock wipe, both ways", body: "return abs(th);" },
  // iris shapes
  { id: "iris_circle", label: "Iris circle", body: "return r;", softness: 0.02 },
  { id: "iris_heart", label: "Iris heart", body: "return r / heartR(p);" },
  { id: "iris_star5", label: "Iris star (5)", body: "return r / starR(th, 5.0, 0.45);" },
  { id: "iris_star6", label: "Iris star (6)", body: "return r / starR(th, 6.0, 0.55);" },
  { id: "iris_diamond", label: "Iris diamond", body: "return abs(p.x) + abs(p.y);" },
  { id: "iris_hexagon", label: "Iris hexagon", body: "return r / polyR(th + 0.5235988, 6.0);" },
  { id: "iris_cross", label: "Iris cross", body: "return min(max(abs(p.x), abs(p.y) * 3.0), max(abs(p.x) * 3.0, abs(p.y)));" },
  { id: "iris_square", label: "Iris square", body: "return max(abs(p.x), abs(p.y));" },
  { id: "iris_triangle", label: "Iris triangle", body: "return r / polyR(th, 3.0);" },
  { id: "iris_petals", label: "Iris flower", body: "return r / (0.62 + 0.38 * abs(cos(th * 3.0)));" },
  // barn doors
  { id: "barn_doors", label: "Barn doors", body: "return abs(p.x);" },
  { id: "barn_doors_v", label: "Barn doors (vertical)", body: "return abs(p.y);" },
  { id: "barn_doors_diagonal", label: "Barn doors (diagonal)", body: "return abs(p.x + p.y);" },
  // blinds and stripes
  { id: "blinds", label: "Venetian blinds", body: "return fract(uv.y * 10.0) + uv.y * 0.02;" },
  { id: "blinds_v", label: "Venetian blinds (vertical)", body: "return fract(uv.x * 14.0) + uv.x * 0.02;" },
  { id: "stripes_diagonal", label: "Diagonal stripes", body: "return fract((p.x + p.y) * 9.0) + (uv.x + uv.y) * 0.03;" },
  { id: "stripes_diagonal_reverse", label: "Diagonal stripes (reverse)", body: "return fract((p.x - p.y) * 9.0) + (uv.x - uv.y) * 0.03;" },
  // checker and mosaics
  { id: "checker", label: "Checkerboard", body: "vec2 c = floor(p * 8.0); float par = mod(c.x + c.y, 2.0); return par + fract(p.y * 8.0);" },
  { id: "mosaic", label: "Mosaic", body: "return nHash(floor(p * 12.0) + S.xy * 97.0);" },
  { id: "mosaic_fine", label: "Mosaic (fine)", body: "return nHash(floor(p * 34.0) + S.xy * 97.0);" },
  { id: "random_squares", label: "Random squares", body: "return nHash(floor(p * 10.0) + S.zw * 89.0) * 0.6 + uv.x * 0.4;" },
  { id: "random_bars", label: "Random bars", body: "return nHash(vec2(floor(uv.x * 40.0), S.x * 50.0));" },
  { id: "random_bars_h", label: "Random bars (horizontal)", body: "return nHash(vec2(floor(uv.y * 26.0), S.y * 50.0));" },
  { id: "tiles_sweep", label: "Tiles sweep", body: "vec2 c = floor(uv * vec2(16.0, 9.0)); return (c.x + c.y) / 24.0 + nHash(c + S.xy * 31.0) * 0.15;" },
  { id: "dots", label: "Growing dots", body: "vec2 q = p * 11.0; return length(fract(q) - 0.5) * 1.0 + uv.x * 0.35;" },
  { id: "hexagons", label: "Hexagons", body: "vec2 c; vec3 v = hexCell(p * 9.0, c); return v.x + nHash(c + S.xy * 13.0) * 0.6;" },
  // spirals and ripples
  { id: "spiral", label: "Spiral", body: `return r * 3.0 + mod(th, ${T}) / ${T};` },
  { id: "spiral_double", label: "Double spiral", body: "return r * 3.0 + mod(th, 3.14159265) / 3.14159265;" },
  { id: "spiral_tight", label: "Spiral (tight)", body: `return r * 7.0 + mod(th, ${T}) / ${T};` },
  { id: "ripples", label: "Ripples", body: "return r + 0.06 * sin(r * 48.0);" },
  { id: "rings", label: "Rings", body: "float k = r * 9.0; return mod(floor(k), 2.0) + fract(k);" },
  { id: "sunburst", label: "Sunburst", body: `return fract(th * 12.0 / ${T}) + r * 0.25;` },
  { id: "pinwheel", label: "Pinwheel", body: `return fract(th * 4.0 / ${T} + r * 0.8);` },
  // painterly
  { id: "brush", label: "Brush strokes", body: "return strokes(p, S, 7.0);" },
  { id: "brush_v", label: "Brush strokes (vertical)", body: "return strokes(vec2(p.y, p.x) * vec2(1.0, 1.0), S, 11.0);" },
  { id: "brush_diagonal", label: "Brush strokes (diagonal)", body: "return strokes(gRot(0.5) * p, S, 8.0);" },
  { id: "paint_splatter", label: "Paint splatter", body: "return splats(p, S, 22.0, 0.55);" },
  { id: "ink_bleed", label: "Ink bleed", body: "vec2 w = vec2(nFbm(p * 3.0 + S.xy * 10.0), nFbm(p * 3.0 + S.zw * 10.0)) - 0.5; return length(p + w * 0.5) + 0.25 * nFbm(p * 9.0 + S.x * 7.0);",
    softness: 0.06, edge: [0.03, 0.05, 0.05, 0.08] },
  { id: "ink_drops", label: "Ink drops", body: "return splats(p + (vec2(nFbm(p * 4.0 + S.xy * 9.0), nFbm(p * 4.0 + S.zw * 9.0)) - 0.5) * 0.25, S, 9.0, 1.0);", softness: 0.05 },
  // smoke, clouds, burns
  { id: "smoke", label: "Smoke", body: "vec2 w = vec2(nFbm(p * 2.5 + S.xy * 20.0), nFbm(p * 2.5 + S.zw * 20.0)); return nFbm(p * 3.0 + w * 2.0 + S.x * 5.0);", softness: 0.12 },
  { id: "smoke_rising", label: "Rising smoke", body: "vec2 w = vec2(nFbm(p * 2.5 + S.xy * 20.0), nFbm(p * 2.5 + S.zw * 20.0)); return (0.5 - p.y) * 1.3 + nFbm(p * 3.0 + w * 2.0) * 0.9;", softness: 0.1 },
  { id: "clouds", label: "Clouds", body: "return nFbm(p * 2.2 + S.xy * 30.0) + 0.35 * abs(nFbm(p * 6.0 + S.zw * 30.0) - 0.5);", softness: 0.1 },
  { id: "burn", label: "Burn", body: "vec2 c = (S.xy - 0.5) * vec2(asp, 1.0) * 0.6; return length(p - c) + 0.35 * nFbm(p * 5.0 + S.zw * 40.0);",
    softness: 0.02, edge: [0.035, 1.0, 0.45, 0.08] },
  { id: "burn_center", label: "Burn from the centre", body: "return r + 0.3 * nFbm(p * 6.0 + S.xy * 40.0);", softness: 0.02, edge: [0.035, 1.0, 0.55, 0.12] },
  { id: "burn_edges", label: "Burn from the edges", body: "return 1.0 - max(abs(p.x) / asp, abs(p.y)) * 2.0 + 0.4 * nFbm(p * 6.0 + S.zw * 40.0);", softness: 0.02, edge: [0.035, 1.0, 0.4, 0.05] },
  // cells
  { id: "crystal", label: "Crystals", body: "vec2 c; vec3 v = nVoronoi(p * 8.0 + S.xy * 50.0, 1.0, c); return v.z;" },
  { id: "crystal_grow", label: "Crystal growth", body: "vec2 c; vec3 v = nVoronoi(p * 6.0 + S.xy * 50.0, 1.0, c); return v.x * 0.7 + v.z * 0.5;" },
  { id: "shatter", label: "Shatter", body: "vec2 c; vec3 v = nVoronoi(p * 7.0 + S.zw * 50.0, 1.0, c); vec2 cc = (c + 0.5 - S.zw * 50.0) / 7.0; return length(cc) + v.z * 0.12;" },
  // edges that sweep
  { id: "zigzag", label: "Zigzag", body: "float z = abs(fract(uv.y * 8.0) - 0.5); return uv.x * asp + z * 0.25;" },
  { id: "zigzag_v", label: "Zigzag (vertical)", body: "float z = abs(fract(uv.x * 12.0) - 0.5); return uv.y + z * 0.2;" },
  { id: "wave", label: "Wave", body: "return uv.x * asp + 0.07 * sin(uv.y * 18.0);" },
  { id: "wave_v", label: "Wave (vertical)", body: "return uv.y + 0.06 * sin(uv.x * 22.0);" },
  { id: "plasma", label: "Plasma", body: "return sin(p.x * 9.0 + S.x * 6.0) + sin(p.y * 11.0 + S.y * 6.0) + sin((p.x + p.y) * 7.0 + S.z * 6.0) + sin(r * 14.0);", softness: 0.08 },
  { id: "bubbles", label: "Bubbles", body: "return bubbles(p, S);", softness: 0.03 },
  { id: "noise", label: "Noise dissolve", body: "return nHash(floor(uv * vec2(640.0, 360.0)) + S.xy * 1000.0);", softness: 0.02 },
];

/** GLSL helpers the bodies may call (after NOISE_GLSL and GEOM_GLSL). */
export const MATTE_HELPERS = `
// boundary radius of a regular polygon (circumradius 1) in direction th (0 = a vertex)
float polyR(float th, float n) {
  float s = 6.283185307179586 / n;
  float a = mod(th, s) - s * 0.5;
  return cos(s * 0.5) / cos(a);
}
// boundary radius of an n-pointed star (outer 1, inner k)
float starR(float th, float n, float k) {
  float s = 6.283185307179586 / n;
  float a = abs(mod(th, s) - s * 0.5);
  vec2 p0 = vec2(cos(s * 0.5), sin(s * 0.5)) * k, p1 = vec2(1.0, 0.0);
  vec2 d = vec2(cos(s * 0.5 - a), sin(s * 0.5 - a));
  vec2 e = p1 - p0;
  return (p0.x * e.y - p0.y * e.x) / (d.x * e.y - d.y * e.x);
}
// heart: the scale at which p lies on (x² + y² − 1)³ = x² y³ (bisection along the ray), y up
float heartF(vec2 q) { float a = dot(q, q) - 1.0; return a * a * a - q.x * q.x * q.y * q.y * q.y; }
float heartR(vec2 p) {
  vec2 d = normalize(vec2(p.x, -p.y) + vec2(0.0, 1e-6));
  float lo = 0.0, hi = 1.6;
  for (int i = 0; i < 22; i++) { float m = 0.5 * (lo + hi); if (heartF(d * m) < 0.0) lo = m; else hi = m; }
  return max(lo, 1e-3) * 0.5;
}
// nearest hexagon centre on a hex grid: (distance, -, -), cell id
vec3 hexCell(vec2 q, out vec2 cell) {
  vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(q, s) - s * 0.5, b = mod(q - s * 0.5, s) - s * 0.5;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  cell = floor((q - g) * 4.0 + 0.5);
  return vec3(length(g), 0.0, 0.0);
}
// rows of paint strokes, painted one after another, alternate rows the other way, ragged edges
float strokes(vec2 p, vec4 S, float rows) {
  float y = p.y + 0.5;
  float jag = (nFbm(vec2(p.x * 6.0, y * rows * 0.7) + S.xy * 20.0) - 0.5) * 0.9 / rows;
  float row = floor((y + jag) * rows);
  float x = p.x * 0.5 + 0.5 + (nFbm(vec2(y * 30.0, row) + S.zw * 10.0) - 0.5) * 0.12;
  x = mod(row, 2.0) < 1.0 ? x : 1.0 - x;
  return row + clamp(x, 0.0, 1.0) * 1.05;
}
// splats: each of n blobs grows from its point at its own time; the pixel goes when the first reaches it
float splats(vec2 p, vec4 S, float n, float wobble) {
  float m = 1e9;
  for (int i = 0; i < 32; i++) {
    if (float(i) >= n) break;
    vec2 h = nHash2(vec2(float(i), S.x * 100.0));
    vec2 c = (h - 0.5) * vec2(1.6, 1.0);
    float t0 = nHash(vec2(float(i), S.y * 100.0));
    vec2 d = p - c;
    float ang = atan(d.y, d.x);
    float rr = length(d) * (1.0 + wobble * 0.25 * sin(ang * (3.0 + floor(h.x * 5.0)) + h.y * 6.0));
    m = min(m, t0 * 0.8 + rr * 1.2);
  }
  return m;
}
// bubbles rising from the bottom, each grows from its centre
float bubbles(vec2 p, vec4 S) {
  float m = 1e9;
  for (int i = 0; i < 40; i++) {
    vec2 h = nHash2(vec2(float(i) * 1.7, S.z * 100.0));
    vec2 c = vec2((h.x - 0.5) * 1.9, (h.y - 0.5) * 1.05);
    float rad = 0.04 + 0.12 * nHash(vec2(float(i), S.w * 100.0));
    float t0 = (c.y + 0.6) * 0.6 * -1.0 + 1.0;
    m = min(m, t0 * 0.7 + length(p - c) / rad * 0.25);
  }
  return min(m, 2.0 + p.y);
}
`;

// ── deterministic seeds ─────────────────────────────────────────────────────────────────────────────────────────
/** FNV-1a 32-bit. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** mulberry32: a small seeded PRNG (0..1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** The seeds of a matte (vec4, 0..1), the same on every run. */
export function matteSeed(id: string): [number, number, number, number] {
  const r = mulberry32(fnv1a(`tatvam-matte:${id}`));
  return [r(), r(), r(), r()];
}

export const matteDef = (id: string) => MATTES.find((m) => m.id === id);

/** The generator's fragment body for a matte (after HEADER, NOISE_GLSL, GEOM_GLSL, MATTE_HELPERS). */
export function matteFunction(d: MatteDef): string {
  return `float matteOf(vec2 p, vec2 uv) {
  float r = length(p), th = atan(p.x, -p.y), asp = uAsp;
  vec4 S = uSeed;
  ${d.body}
}`;
}

/** Bins of the equalisation table. */
export const MATTE_CURVE = 1024;
/** The histogram-equalisation table of raw matte values: CDF at MATTE_CURVE points over [min, max]. */
export function equalise(values: ArrayLike<number>): { table: Float32Array; min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < values.length; i++) { const v = values[i]; if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; } }
  if (!(max > min)) { min = 0; max = 1; }
  const N = MATTE_CURVE, hist = new Float64Array(N);
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    hist[Math.min(N - 1, Math.max(0, Math.floor(((v - min) / (max - min)) * N)))]++;
    n++;
  }
  const table = new Float32Array(N);
  let acc = 0;
  for (let i = 0; i < N; i++) { acc += hist[i]; table[i] = n ? acc / n : i / (N - 1); }
  return { table, min, max };
}

/** Long side of a matte texture. */
export const MATTE_SIZE = 1024;
/** Matte texture size for an output aspect ratio (w / h), rounded so nearby ratios share one. */
export function matteSize(aspect: number): { w: number; h: number; key: string } {
  const x = Math.min(8, Math.max(0.125, aspect)), a = Math.round(x * 1000) / 1000;
  const w = x >= 1 ? MATTE_SIZE : Math.max(16, Math.round(MATTE_SIZE * x)), h = x >= 1 ? Math.max(16, Math.round(MATTE_SIZE / x)) : MATTE_SIZE;
  return { w, h, key: a.toFixed(3) };
}
