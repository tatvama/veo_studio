/**
 * Video scopes and colour statistics on the CPU, from an RGBA frame (the Program monitor's read-back): waveform, RGB
 * parade, vectorscope and histogram as RGBA pictures, plus the statistics the colour tools fall back on when the engine
 * has no `analyzeColor` / `matchColor` yet (grey-world white balance, a per-channel mean / spread match solved as
 * colour-wheel lift and gain). Pure.
 */

export type ScopeKind = "waveform" | "parade" | "vectorscope" | "histogram";
export interface RgbaFrame { data: Uint8Array | Uint8ClampedArray; width: number; height: number }

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Every `step`-th pixel in both directions, so a 1080p frame costs ~20k samples. */
export const stepFor = (f: RgbaFrame, samples = 24000) => Math.max(1, Math.floor(Math.sqrt((f.width * f.height) / samples)));

/** A scope as an RGBA picture outW × outH (transparent background, graticule not included). */
export function scopeImage(kind: ScopeKind, f: RgbaFrame, outW: number, outH: number, step = stepFor(f)): Uint8ClampedArray<ArrayBuffer> {
  const W = Math.max(1, Math.round(outW)), H = Math.max(1, Math.round(outH));
  const out = new Uint8ClampedArray(W * H * 4);
  const d = f.data, fw = f.width, fh = f.height;
  if (!fw || !fh) return out;
  if (kind === "histogram") {
    const bins = [new Float64Array(256), new Float64Array(256), new Float64Array(256), new Float64Array(256)];
    for (let y = 0; y < fh; y += step) for (let x = 0; x < fw; x += step) {
      const i = (y * fw + x) * 4;
      bins[0][d[i]]++; bins[1][d[i + 1]]++; bins[2][d[i + 2]]++; bins[3][Math.round(luma(d[i], d[i + 1], d[i + 2]))]++;
    }
    const max = Math.max(1, ...bins.slice(0, 3).map((b) => Math.max(...b.slice(1, 255))));
    const cols = [[255, 70, 70], [70, 255, 110], [80, 140, 255], [220, 220, 220]];
    for (let x = 0; x < W; x++) {
      const bin = Math.min(255, Math.floor((x / W) * 256));
      for (let c = 0; c < 4; c++) {
        const hgt = Math.min(H, Math.round((Math.sqrt(bins[c][bin] / max)) * H * 0.95));
        for (let y = H - hgt; y < H; y++) {
          const o = (y * W + x) * 4;
          if (c === 3) { out[o + 3] = Math.max(out[o + 3], 40); continue; }
          out[o + c] = Math.min(255, out[o + c] + cols[c][c] * 0.75);
          out[o + 3] = Math.max(out[o + 3], 170);
        }
      }
    }
    return out;
  }
  const acc = new Float32Array(W * H * 3);
  const add = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 3;
    acc[o] += r; acc[o + 1] += g; acc[o + 2] += b;
  };
  if (kind === "waveform" || kind === "parade") {
    const parts = kind === "parade" ? 3 : 1;
    const pw = W / parts;
    for (let y = 0; y < fh; y += step) for (let x = 0; x < fw; x += step) {
      const i = (y * fw + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (kind === "waveform") {
        add(Math.floor((x / fw) * W), Math.round((1 - luma(r, g, b) / 255) * (H - 1)), 1, 1, 1);
      } else {
        const px = (x / fw) * pw;
        add(Math.floor(px), Math.round((1 - r / 255) * (H - 1)), 1, 0, 0);
        add(Math.floor(pw + px), Math.round((1 - g / 255) * (H - 1)), 0, 1, 0);
        add(Math.floor(2 * pw + px), Math.round((1 - b / 255) * (H - 1)), 0, 0, 1);
      }
    }
  } else {
    // vectorscope: BT.709 Cb / Cr, each sample in its own colour
    const R = Math.min(W, H) / 2 - 2, cx = W / 2, cy = H / 2;
    for (let y = 0; y < fh; y += step) for (let x = 0; x < fw; x += step) {
      const i = (y * fw + x) * 4;
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, l = luma(r, g, b);
      const cb = (b - l) / 1.8556, cr = (r - l) / 1.5748;
      add(Math.round(cx + cb * 2 * R), Math.round(cy - cr * 2 * R), 0.4 + r, 0.4 + g, 0.4 + b);
    }
  }
  // tone map the counts (log), tinted green for the waveform like a hardware scope
  let max = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > max) max = acc[i];
  const k = max > 0 ? 1 / Math.log1p(max) : 0;
  for (let p = 0, o = 0; p < W * H; p++, o += 4) {
    const r = acc[p * 3], g = acc[p * 3 + 1], b = acc[p * 3 + 2];
    if (!(r || g || b)) continue;
    if (kind === "waveform") {
      const v = Math.log1p(r) * k;
      out[o] = 120 * v + 60; out[o + 1] = 255 * Math.min(1, v * 1.4); out[o + 2] = 140 * v + 60; out[o + 3] = Math.min(255, 90 + 255 * v);
    } else {
      const s = (x: number) => Math.min(255, Math.log1p(x) * k * 255 * 1.6);
      out[o] = s(r); out[o + 1] = s(g); out[o + 2] = s(b); out[o + 3] = Math.min(255, 80 + Math.max(out[o], out[o + 1], out[o + 2]));
    }
  }
  return out;
}

export interface ChannelStats { mean: [number, number, number]; std: [number, number, number]; luma: { min: number; max: number; mean: number } }

/** Mean and spread per channel (0..1), and the luma range, over the frame (or the mid-tones only). */
export function frameStats(f: RgbaFrame, opts: { midtones?: boolean; step?: number } = {}): ChannelStats {
  const step = opts.step ?? stepFor(f);
  const d = f.data;
  let n = 0;
  const s = [0, 0, 0], q = [0, 0, 0];
  let lmin = 1, lmax = 0, lsum = 0;
  for (let y = 0; y < f.height; y += step) for (let x = 0; x < f.width; x += step) {
    const i = (y * f.width + x) * 4;
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, l = luma(r, g, b);
    if (l < lmin) lmin = l; if (l > lmax) lmax = l; lsum += l;
    if (opts.midtones && (l < 0.12 || l > 0.92)) continue;
    s[0] += r; s[1] += g; s[2] += b; q[0] += r * r; q[1] += g * g; q[2] += b * b; n++;
  }
  const cnt = Math.max(1, n);
  const mean = s.map((v) => v / cnt) as [number, number, number];
  const std = q.map((v, i) => Math.sqrt(Math.max(0, v / cnt - mean[i] * mean[i]))) as [number, number, number];
  const all = Math.max(1, Math.ceil(f.height / step) * Math.ceil(f.width / step));
  return { mean, std, luma: { min: lmin, max: lmax, mean: lsum / all } };
}

const clamp = (v: number, a = -1, b = 1) => Math.max(a, Math.min(b, v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Grey-world white balance in the Adjust effect's units: temperature (+ warmer) and tint (+ magenta), the amounts that
 * bring the mid-tones' red / blue and green / magenta back to neutral (adjust maps them to colorbalance ±0.15).
 */
export function greyWorldWb(st: ChannelStats): { temperature: number; tint: number } {
  const [r, g, b] = st.mean;
  const m = Math.max(1e-3, (r + g + b) / 3);
  const temperature = clamp(-((r - b) / m) / 0.6);
  const tint = clamp(((g - (r + b) / 2) / m) / 0.45);
  return { temperature: r3(temperature), tint: r3(tint) };
}

/**
 * The colour-wheel lift and gain (engine wheels: c' = (c + lift/2·(1−c))·(1+gain)) that move each channel's mean and
 * spread from `src` to `ref` (a Reinhard-style transfer per RGB channel, limited to the wheels' ranges).
 */
export function matchWheels(src: ChannelStats, ref: ChannelStats): { lift: [number, number, number]; gamma: [number, number, number]; gain: [number, number, number] } {
  const lift: number[] = [], gain: number[] = [];
  for (let c = 0; c < 3; c++) {
    // flat pictures (no spread to compare) only shift; else spread ratio, limited
    const a = src.std[c] < 0.02 && ref.std[c] < 0.02 ? 1 : clamp(ref.std[c] / Math.max(0.02, src.std[c]), 0.4, 2.5);
    const b = ref.mean[c] - a * src.mean[c];
    // c' = c·(1−L)·G + L·G  →  a = (1−L)·G, b = L·G
    const G = a + b;
    const L = Math.abs(G) > 1e-6 ? b / G : 0;
    lift.push(r3(clamp(2 * L)));
    gain.push(r3(clamp(G - 1)));
  }
  return { lift: lift as [number, number, number], gamma: [0, 0, 0], gain: gain as [number, number, number] };
}
