/**
 * Generator clips (docs/EDITOR.md §11.1: tone, noise, DTMF) for the preview: the same formulas as the export's lavfi
 * sources (desktop main/editor-audio.ts generatorSource: aevalsrc for tones and DTMF, anoisesrc for noise), rendered
 * at unit level; the level (dB, keyframeable) is applied by the mixer as a gain. Noise matches anoisesrc's filters
 * and level, not its random numbers. Pure: no DOM.
 */
import { mulberry32 } from "./ir.ts";
import { generatorDefaults, type AudioParamValue, type GeneratorKind } from "./registry.ts";

export const DTMF: Record<string, [number, number]> = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477], A: [697, 1633], 4: [770, 1209], 5: [770, 1336], 6: [770, 1477], B: [770, 1633],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477], C: [852, 1633], "*": [941, 1209], 0: [941, 1336], "#": [941, 1477], D: [941, 1633],
};
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const fmod1 = (x: number) => x - Math.floor(x);

export const dtmfDigits = (s: string) => s.toUpperCase().replace(/[^0-9*#ABCD]/g, "").slice(0, 32) || "0";

/** Phase in cycles at t of a steady tone, or a log / linear sweep from f to f1 over T seconds. */
export function tonePhase(f: number, f1: number, sweep: string, T: number, t: number): number {
  if (f1 > 0 && Math.abs(f1 - f) > 1e-6) {
    if (sweep !== "linear") { const k = Math.log(f1 / f); return ((f * T) / k) * (Math.exp((t / T) * k) - 1); }
    return f * t + ((f1 - f) / (2 * T)) * t * t;
  }
  return f * t;
}

/**
 * One channel of a generator, `seconds` long at `rate`, at unit level (0 dBFS amplitude; DTMF tones each 0.5).
 * `values` are the generator's params at their first value.
 */
export function renderGenerator(kind: GeneratorKind, values: Record<string, AudioParamValue>, rate: number, seconds: number): Float32Array {
  const v = { ...generatorDefaults(kind), ...values };
  const n = Math.max(1, Math.round(rate * seconds));
  const out = new Float32Array(n);
  const numv = (k: string, d: number) => { const x = Number(v[k]); return Number.isFinite(x) ? x : d; };
  if (kind === "tone") {
    const f = clamp(numv("frequency", 1000), 1, 23000), f1 = clamp(numv("sweepTo", 0), 0, 23000), T = Math.max(0.01, seconds);
    const wave = String(v.wave ?? "sine"), sweep = String(v.sweep ?? "log");
    for (let i = 0; i < n; i++) {
      const ph = tonePhase(f, f1, sweep, T, i / rate);
      out[i] = wave === "square" ? (fmod1(ph) < 0.5 ? 1 : -1) : wave === "sawtooth" ? 2 * fmod1(ph) - 1 : wave === "triangle" ? 4 * Math.abs(fmod1(ph) - 0.5) - 1 : Math.sin(2 * Math.PI * ph);
    }
    return out;
  }
  if (kind === "dtmf") {
    const digits = dtmfDigits(String(v.digits ?? "0"));
    const tone = clamp(numv("tone", 100), 20, 2000) / 1000, gap = clamp(numv("gap", 60), 0, 2000) / 1000;
    [...digits].forEach((ch, k) => {
      const [lo, hi] = DTMF[ch];
      const t0 = k * (tone + gap);
      for (let i = Math.max(0, Math.ceil(t0 * rate)); i < n && i / rate <= t0 + tone; i++) {
        const t = i / rate;
        out[i] += 0.5 * (Math.sin(2 * Math.PI * lo * t) + Math.sin(2 * Math.PI * hi * t));
      }
    });
    return out;
  }
  // noise: anoisesrc's colour filters over uniform white noise (±1)
  const rnd = mulberry32(Math.max(0, Math.round(numv("seed", 1))) * 2654435761);
  const color = String(v.color ?? "pink"), density = clamp(numv("density", 0.05), 0.001, 1);
  const b = new Float64Array(7);
  for (let i = 0; i < n; i++) {
    const w = 2 * rnd() - 1;
    let y: number;
    switch (color) {
      case "white": y = w; break;
      case "pink":
        b[0] = 0.99886 * b[0] + w * 0.0555179; b[1] = 0.99332 * b[1] + w * 0.0750759; b[2] = 0.969 * b[2] + w * 0.153852;
        b[3] = 0.8665 * b[3] + w * 0.3104856; b[4] = 0.55 * b[4] + w * 0.5329522; b[5] = -0.7616 * b[5] - w * 0.016898;
        y = (b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362) * 0.11; b[6] = w * 0.115926; break;
      case "blue":
        b[0] = 0.0555179 * w - 0.99886 * b[0]; b[1] = 0.0750759 * w - 0.99332 * b[1]; b[2] = 0.153852 * w - 0.969 * b[2];
        b[3] = 0.3104856 * w - 0.8665 * b[3]; b[4] = 0.5329522 * w - 0.55 * b[4]; b[5] = -0.016898 * w + 0.7616 * b[5];
        y = (b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362) * 0.11; b[6] = w * 0.115926; break;
      case "brown": b[0] = (0.02 * w + b[0]) / 1.02; y = b[0] * 3.5; break;
      case "violet": b[0] = (0.02 * w - b[0]) / 1.02; y = b[0] * 3.5; break;
      case "velvet": { const u = rnd(); y = u < density ? (w >= 0 ? 1 : -1) : 0; break; }
      default: y = w;
    }
    out[i] = y;
  }
  return out;
}

/** A key for a generator's sound (cached renders). */
export const generatorKey = (kind: string, values: Record<string, unknown>, seconds: number) =>
  `${kind}|${JSON.stringify(Object.entries(values).filter(([k]) => k !== "level").sort())}|${seconds.toFixed(3)}`;
