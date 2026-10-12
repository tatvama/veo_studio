/**
 * YUV 4:2:0 read-back layout (BT.709, limited range). The GPU packs the frame into one RGBA8 target so a single
 * readPixels returns planar I420 bytes:
 *   rows [0, H)                 Y: texel (i, r) holds Y(4i..4i+3, r)                         → W/4 texels wide
 *   rows [H, H + H/4)           U: texel (i, r) holds U row 2r (i < W/8) or 2r+1 (i ≥ W/8)   → two chroma rows per row
 *   rows [H + H/4, H + H/2)     V: the same
 * so each target row is W bytes and the planes come out contiguous. W must be a multiple of 8 and H of 4 for that;
 * other sizes are padded on the GPU (edge pixels repeated) and `repack()` crops them on the CPU.
 */
export const KR = 0.2126, KB = 0.0722, KG = 1 - KR - KB;

export interface YuvLayout {
  w: number; h: number;
  /** Padded width (multiple of 8) and chroma size. */
  padW: number; cw: number; ch: number;
  /** The RGBA8 target: texW texels × texH rows. */
  texW: number; texH: number;
  /** Rows per chroma plane in the target. */
  cRows: number;
  /** The read-back already is I420 (no repack needed). */
  direct: boolean;
  /** Bytes of the I420 frame (w·h·1.5). */
  bytes: number;
}

export function yuvLayout(w: number, h: number): YuvLayout {
  if (!(w >= 2 && h >= 2) || w % 2 || h % 2) throw new Error(`YUV 4:2:0 needs even dimensions (got ${w}×${h})`);
  const padW = Math.ceil(w / 8) * 8;
  const cw = w / 2, ch = h / 2, cRows = Math.ceil(ch / 2);
  const texW = padW / 4;
  return { w, h, padW, cw, ch, texW, texH: h + 2 * cRows, cRows, direct: padW === w && ch % 2 === 0, bytes: w * h * 1.5 };
}

/** For a target texel: which plane, and the (x, y) of its first sample in that plane (the next three follow in x). */
export function texelSource(L: YuvLayout, i: number, r: number): { plane: "y" | "u" | "v"; x: number; y: number } {
  if (r < L.h) return { plane: "y", x: 4 * i, y: r };
  const plane = r < L.h + L.cRows ? "u" : "v";
  const rr = r - L.h - (plane === "v" ? L.cRows : 0);
  const half = L.texW / 2;
  return i < half ? { plane, x: 4 * i, y: 2 * rr } : { plane, x: 4 * (i - half), y: 2 * rr + 1 };
}

/** The read-back bytes (texW·4 per row, texH rows) → I420 (w·h Y, then U, then V). Returns `buf` itself when direct. */
export function repack(L: YuvLayout, buf: Uint8Array, out?: Uint8Array): Uint8Array {
  if (L.direct && !out) return buf.subarray(0, L.bytes);
  const dst = out ?? new Uint8Array(L.bytes);
  const stride = L.texW * 4;  // = padW bytes
  for (let y = 0; y < L.h; y++) dst.set(buf.subarray(y * stride, y * stride + L.w), y * L.w);
  const plane = (base: number, off: number) => {
    for (let cy = 0; cy < L.ch; cy++) {
      const row = base + (cy >> 1), x0 = (cy & 1) * (L.padW / 2);
      const s = row * stride + x0;
      dst.set(buf.subarray(s, s + L.cw), off + cy * L.cw);
    }
  };
  plane(L.h, L.w * L.h);
  plane(L.h + L.cRows, L.w * L.h + L.cw * L.ch);
  return dst;
}

/** BT.709 limited range, RGB 0..1 → code values 0..255 (unrounded). */
export function rgbToYuv(r: number, g: number, b: number): [number, number, number] {
  const y = KR * r + KG * g + KB * b;
  return [16 + 219 * y, 128 + 224 * ((b - y) / (2 * (1 - KB))), 128 + 224 * ((r - y) / (2 * (1 - KR)))];
}

/** Code values → RGB (not clamped: limited range leaves room below black and above white). */
export function yuvToRgbRaw(Y: number, U: number, V: number): [number, number, number] {
  const y = (Y - 16) / 219, pb = (U - 128) / 224, pr = (V - 128) / 224;
  const r = y + 2 * (1 - KR) * pr, b = y + 2 * (1 - KB) * pb;
  return [r, (y - KR * r - KB * b) / KG, b];
}

/** Code values → RGB 0..1 (clamped). */
export function yuvToRgb(Y: number, U: number, V: number): [number, number, number] {
  const c = (v: number) => Math.min(1, Math.max(0, v));
  const [r, g, b] = yuvToRgbRaw(Y, U, V);
  return [c(r), c(g), c(b)];
}

/** CPU reference of the GPU packing (tests and the lab's round-trip check): RGBA8 pixels, rows top first. */
export function packI420(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const L = yuvLayout(w, h);
  const out = new Uint8Array(L.bytes);
  const px = (x: number, y: number) => {
    const o = (Math.min(y, h - 1) * w + Math.min(x, w - 1)) * 4;
    return [rgba[o] / 255, rgba[o + 1] / 255, rgba[o + 2] / 255] as const;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = Math.round(rgbToYuv(...px(x, y))[0]);
  for (let cy = 0; cy < L.ch; cy++) for (let cx = 0; cx < L.cw; cx++) {
    let u = 0, v = 0;
    for (let k = 0; k < 4; k++) {
      const [, uu, vv] = rgbToYuv(...px(2 * cx + (k & 1), 2 * cy + (k >> 1)));
      u += uu; v += vv;
    }
    out[w * h + cy * L.cw + cx] = Math.round(u / 4);
    out[w * h + L.cw * L.ch + cy * L.cw + cx] = Math.round(v / 4);
  }
  return out;
}

/** GLSL for the packing pass, built from the same constants. */
export const YUV_GLSL = `
const vec3 YUV_K = vec3(${KR}, ${KG.toFixed(4)}, ${KB});
float yuvY(vec3 c) { return (16.0 + 219.0 * dot(c, YUV_K)) / 255.0; }
vec2 yuvUV(vec3 c) {
  float y = dot(c, YUV_K);
  return vec2(128.0 + 224.0 * (c.b - y) / ${(2 * (1 - KB)).toFixed(4)}, 128.0 + 224.0 * (c.r - y) / ${(2 * (1 - KR)).toFixed(4)}) / 255.0;
}`;

// ── matrices between YCbCr interpretations ─────────────────────────────────────────────────────────────────────
export type Matrix = "bt709" | "bt601";
const K: Record<Matrix, [number, number]> = { bt709: [KR, KB], bt601: [0.299, 0.114] };

/** rgb → (y, pb, pr) for a matrix, row-major 3×3. */
function toYpbpr(m: Matrix): number[] {
  const [kr, kb] = K[m], kg = 1 - kr - kb;
  return [kr, kg, kb, -kr / (2 * (1 - kb)), -kg / (2 * (1 - kb)), 0.5, 0.5, -kg / (2 * (1 - kr)), -kb / (2 * (1 - kr))];
}
function mul(a: number[], b: number[]): number[] {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
}
export function inv3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error("singular matrix");
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((x) => x / det);
}
/** Row-major 3×3 taking RGB decoded with `from` to the RGB the same YCbCr decodes to with `to`. */
export function basis(from: Matrix, to: Matrix): number[] {
  return from === to ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : mul(inv3(toYpbpr(to)), toYpbpr(from));
}
/** A row-major 3×3 as a GLSL mat3 (column-major). */
export const glslMat3 = (m: number[]) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

// ── 10-bit read-back (readYuv420p10): planar 4:2:0, 10-bit codes in little-endian 16-bit words ─────────────────────
/**
 * The same idea as the 8-bit layout with two samples per RGBA8 texel (low byte, high byte, low, high), so one
 * readPixels viewed as a Uint16Array is yuv420p10le:
 *   rows [0, H)                Y: texel (i, r) holds Y(2i, 2i+1, r)                                → W/2 texels wide
 *   rows [H, H + H/4)          U: texel (i, r) holds U row 2r (i < W/4) or 2r+1 (i ≥ W/4)
 *   rows [H + H/4, H + H/2)    V: the same
 * W must be a multiple of 4 and H/2 even for that; other sizes are padded on the GPU and cropped by `repack10()`.
 */
export interface Yuv10Layout { w: number; h: number; padW: number; cw: number; ch: number; texW: number; texH: number; cRows: number; direct: boolean; samples: number }

export function yuv10Layout(w: number, h: number): Yuv10Layout {
  if (!(w >= 2 && h >= 2) || w % 2 || h % 2) throw new Error(`YUV 4:2:0 needs even dimensions (got ${w}×${h})`);
  const padW = Math.ceil(w / 4) * 4, cw = w / 2, ch = h / 2, cRows = Math.ceil(ch / 2);
  return { w, h, padW, cw, ch, texW: padW / 2, texH: h + 2 * cRows, cRows, direct: padW === w && ch % 2 === 0, samples: w * h * 1.5 };
}

/** For a target texel: which plane, and the (x, y) of its first sample (the second follows in x). */
export function texelSource10(L: Yuv10Layout, i: number, r: number): { plane: "y" | "u" | "v"; x: number; y: number } {
  if (r < L.h) return { plane: "y", x: 2 * i, y: r };
  const plane = r < L.h + L.cRows ? "u" : "v";
  const rr = r - L.h - (plane === "v" ? L.cRows : 0);
  const half = L.texW / 2;
  return i < half ? { plane, x: 2 * i, y: 2 * rr } : { plane, x: 2 * (i - half), y: 2 * rr + 1 };
}

/** The read-back bytes → planar 4:2:0 16-bit words (w·h Y, then U, then V). A view of `buf` when direct. */
export function repack10(L: Yuv10Layout, buf: Uint8Array, out?: Uint16Array): Uint16Array {
  const words = new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
  if (L.direct && !out) return words.subarray(0, L.samples);
  const dst = out ?? new Uint16Array(L.samples);
  const stride = L.padW;  // words per target row
  for (let y = 0; y < L.h; y++) dst.set(words.subarray(y * stride, y * stride + L.w), y * L.w);
  const plane = (base: number, off: number) => {
    for (let cy = 0; cy < L.ch; cy++) {
      const s = (base + (cy >> 1)) * stride + (cy & 1) * (L.padW / 2);
      dst.set(words.subarray(s, s + L.cw), off + cy * L.cw);
    }
  };
  plane(L.h, L.w * L.h);
  plane(L.h + L.cRows, L.w * L.h + L.cw * L.ch);
  return dst;
}
