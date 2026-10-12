/**
 * FFmpeg xfade's pseudo-random number, frand(x, y) = fract(sinf(x·12.9898 + y·78.233) · 43758.545), in float32 as
 * the C code computes it. GPUs can't reproduce sinf of large arguments, so the dissolve and wind transitions read
 * these values from small tables made here (the winds use one value per row / column).
 */
const f = Math.fround;
const K1 = f(12.9898), K2 = f(78.233), K3 = f(43758.545);

export function frand(x: number, y: number): number {
  const r = f(f(Math.sin(f(f(f(x) * K1) + f(f(y) * K2)))) * K3);
  return f(r - Math.floor(r));
}

/** Two rows of `n`: row 0 = frand(0, i) (per-row values), row 1 = frand(i, 0) (per-column values). */
export function frandRows(n: number): Float32Array {
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { out[i] = frand(0, i); out[n + i] = frand(i, 0); }
  return out;
}

/** frand(x, y) for every pixel of a w×h frame, rows top first. */
export function frandGrid(w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = frand(x, y);
  return out;
}
