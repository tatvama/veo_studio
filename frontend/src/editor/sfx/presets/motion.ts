/**
 * Movement: whooshes and swishes (band-passed noise swept up and down under a swell, with optional doppler tones,
 * flanging, sub rumble, gusts and pan sweeps), risers and downlifters (noise sweeps, detuned saw stacks, a
 * Shepard–Risset glide, FM, accelerating tremolo). docs/EDITOR.md §15.1.
 */
import {
  add, addSt, balance, brown, clamp, comb, crush, fitSt, fm, glide, mul, mulSt, noise, osc, pink, reverseSt, secs, sig, spread,
  stack, svf, swell, TAU, wander, type FType, type NoiseColor, type Stereo, type Wave,
} from "../dsp.ts";
import type { RenderCtx, SfxDef, SfxTag, Values } from "../types.ts";
import { bright, HALL, HUGE, inSpace, P, pk, PLATE, ROOM, smooth, tailSeconds, type Space } from "./common.ts";

// ── whoosh ──────────────────────────────────────────────────────────────────────────────────────────────

interface Pass { from: number; to: number; gain: number; f: number }
interface WhooshO {
  color: NoiseColor | "mix";
  /** Filter centre at the start, the peak and the end (Hz). */
  f: [number, number, number];
  q: number; peak: number; rise?: number; fall?: number;
  pan?: [number, number];
  passes?: Pass[];
  tone?: { f0: number; f1: number; wave: Wave; level: number; ratio?: number; index?: number };
  flange?: number; sub?: number; flutter?: number; gust?: number; lpMix?: number;
  ring?: { q: number; level: number; mul: number };
  space: Space; reverse?: boolean;
}

function whoosh(o: WhooshO, v: Values, c: RenderCtx): Stereo {
  const { sr, rng } = c, nb = Math.max(16, secs(v.length, sr)), k = pk(v) * bright(v), w = clamp(v.width ?? 0.5, 0, 1);
  const env = sig(nb), fc = sig(nb).fill(o.f[0] * k);
  for (const p of o.passes ?? [{ from: 0, to: 1, gain: 1, f: 1 }]) {
    const a = Math.round(p.from * nb), m = Math.max(2, Math.round(p.to * nb) - a), e = swell(m, o.peak, o.rise ?? 1, o.fall ?? 1);
    for (let i = 0; i < m && a + i < nb; i++) {
      const u = i / (m - 1), g = p.gain * e[i];
      const f = u < o.peak ? o.f[0] * Math.pow(o.f[1] / o.f[0], Math.pow(u / o.peak, 0.8)) : o.f[1] * Math.pow(o.f[2] / o.f[1], Math.pow((u - o.peak) / (1 - o.peak), 0.8));
      if (g >= env[a + i]) { env[a + i] = g; fc[a + i] = f * p.f * k; }
    }
  }
  if (o.gust) {
    const wd = wander(nb, sr, rng.fork(7), 1.7);
    for (let i = 0; i < nb; i++) { fc[i] *= Math.pow(2, o.gust * 1.1 * wd[i]); env[i] *= 1 + 0.4 * o.gust * wd[i]; }
  }
  const nz = o.color === "mix" ? add(brown(nb, rng.fork(1)), pink(nb, rng.fork(2)), 0.8) : noise(o.color, nb, rng.fork(1));
  let y = svf(nz, sr, "bp", fc, o.q);
  if (o.lpMix) add(y, svf(nz, sr, "lp", fc.map((f) => f * 0.7)), o.lpMix);
  if (o.ring) add(y, svf(nz, sr, "bpq", fc.map((f) => f * o.ring!.mul), o.ring.q), (o.ring.level * 3) / o.ring.q);
  if (o.flutter) {
    const fl = wander(nb, sr, rng.fork(3), 42);
    for (let i = 0; i < nb; i++) y[i] *= 1 - o.flutter * 0.45 * (1 + fl[i]);
  }
  mul(y, env);
  if (o.tone) {
    const t = o.tone, fr = sig(nb);
    for (let i = 0; i < nb; i++) { const u = i / (nb - 1), s = 1 / (1 + Math.exp(-(u - o.peak) * 9)); fr[i] = (t.f0 + (t.f1 - t.f0) * s) * pk(v); }
    let tn = t.index ? fm(nb, sr, fr, t.ratio ?? 1, fr.map((_, i) => (t.index ?? 0) * env[i])) : osc(nb, sr, fr, t.wave);
    if (t.wave === "saw" || t.wave === "square") tn = svf(tn, sr, "lp", fc.map((f) => f * 1.3), 0.9);
    add(y, mul(tn, env.map((e) => e * e)), t.level);
  }
  if (o.sub) add(y, mul(osc(nb, sr, 46 * pk(v)), env.map((e) => e * e * e)), o.sub);
  if (o.flange) y = comb(y, sr, env.map((e) => 0.0007 + 0.0065 * (1 - e)), 0.25 + 0.5 * o.flange, 0.15, 0.5);
  let st = spread(y, sr, 0.25 + 0.6 * w);
  if (o.pan) {
    const pc = sig(nb);
    for (let i = 0; i < nb; i++) pc[i] = (o.pan[0] + (o.pan[1] - o.pan[0]) * smooth(i / (nb - 1))) * (0.3 + 0.7 * w);
    st = balance(st, pc);
  }
  st = inSpace(fitSt(st, c.n), sr, v, o.space);
  return o.reverse ? reverseSt(st) : st;
}

const W = (id: string, name: string, tags: SfxTag[], d: { length: number; lmin?: number; lmax?: number; brightness?: number; width?: number; tail?: number }, o: WhooshO): SfxDef => ({
  id, name, category: "whoosh", tags, stereo: true,
  params: [P.length(d.length, d.lmin ?? 0.15, d.lmax ?? 4), P.pitch(), P.brightness(d.brightness ?? 0.5), P.width(d.width ?? 0.6), P.tail(d.tail ?? 0.2)],
  len: (v) => v.length + tailSeconds(v, o.space),
  render: (v, c) => whoosh(o, v, c),
});

export const WHOOSH: SfxDef[] = [
  W("whoosh.air_soft", "Soft air whoosh", ["whoosh"], { length: 0.9, brightness: 0.45, width: 0.5, tail: 0.2 },
    { color: "pink", f: [350, 1800, 500], q: 1.1, peak: 0.55, rise: 1.2, fall: 1.4, pan: [-0.4, 0.4], space: ROOM }),
  W("whoosh.fast", "Fast whoosh", ["whoosh"], { length: 0.38, lmin: 0.15, lmax: 1.5, brightness: 0.55, width: 0.7, tail: 0.15 },
    { color: "white", f: [900, 5000, 1400], q: 1.4, peak: 0.5, rise: 1.5, fall: 2, pan: [-0.8, 0.8], space: ROOM }),
  W("whoosh.heavy", "Heavy whoosh", ["whoosh"], { length: 1.3, brightness: 0.4, width: 0.6, tail: 0.3 },
    { color: "mix", f: [180, 1100, 220], q: 0.8, peak: 0.55, rise: 1.1, fall: 1.3, lpMix: 0.6, sub: 0.35, pan: [-0.3, 0.3], space: HALL }),
  W("whoosh.cinematic", "Cinematic whoosh", ["whoosh"], { length: 1.6, brightness: 0.5, width: 0.8, tail: 0.45 },
    { color: "pink", f: [250, 2400, 400], q: 0.9, peak: 0.6, rise: 1.3, fall: 1.2, tone: { f0: 220, f1: 90, wave: "saw", level: 0.22 }, flange: 0.3, sub: 0.25, pan: [-0.5, 0.5], space: HUGE }),
  W("whoosh.scifi", "Sci-fi whoosh", ["whoosh"], { length: 1.1, brightness: 0.55, width: 0.7, tail: 0.3 },
    { color: "white", f: [600, 4500, 900], q: 2.5, peak: 0.5, tone: { f0: 1200, f1: 300, wave: "sine", level: 0.4, ratio: 1.5, index: 3 }, flange: 0.7, pan: [-0.6, 0.6], space: PLATE }),
  W("whoosh.reverse", "Reverse whoosh", ["whoosh", "reverse"], { length: 0.8, width: 0.6, tail: 0.6 },
    { color: "pink", f: [500, 2600, 600], q: 1.0, peak: 0.3, rise: 0.9, fall: 1.5, space: HALL, reverse: true }),
  W("whoosh.double", "Double whoosh", ["whoosh"], { length: 0.9, lmin: 0.3, width: 0.7, tail: 0.2 },
    { color: "pink", f: [600, 3200, 800], q: 1.2, peak: 0.5, rise: 1.3, fall: 1.6, pan: [-0.7, 0.7], passes: [{ from: 0, to: 0.56, gain: 1, f: 1 }, { from: 0.42, to: 1, gain: 0.9, f: 1.25 }], space: ROOM }),
  W("whoosh.wind", "Wind gust whoosh", ["whoosh", "wind"], { length: 2.2, lmin: 0.5, lmax: 6, brightness: 0.45, width: 0.8, tail: 0.15 },
    { color: "pink", f: [300, 1400, 350], q: 3.2, peak: 0.5, gust: 0.6, lpMix: 0.25, space: ROOM }),
  W("swish.short", "Short swish", ["swish"], { length: 0.22, lmin: 0.1, lmax: 0.8, brightness: 0.55, width: 0.5, tail: 0.1 },
    { color: "white", f: [2200, 7000, 3500], q: 1.3, peak: 0.55, rise: 1.5, fall: 2, pan: [-0.3, 0.3], space: ROOM }),
  W("swish.cloth", "Cloth swish", ["swish"], { length: 0.32, lmin: 0.12, lmax: 1, brightness: 0.45, width: 0.4, tail: 0.1 },
    { color: "pink", f: [1200, 3200, 1500], q: 0.9, peak: 0.5, flutter: 0.7, space: ROOM }),
  W("swish.blade", "Blade swish", ["swish", "whoosh"], { length: 0.36, lmin: 0.15, lmax: 1.2, brightness: 0.55, width: 0.6, tail: 0.2 },
    { color: "white", f: [2500, 6500, 3000], q: 1.6, peak: 0.5, rise: 1.4, fall: 1.8, ring: { q: 14, level: 0.5, mul: 1.1 }, pan: [-0.5, 0.5], space: ROOM }),
  W("whoosh.pass_by", "Pass-by whoosh", ["whoosh"], { length: 1.8, lmin: 0.5, lmax: 6, brightness: 0.45, width: 0.9, tail: 0.25 },
    { color: "mix", f: [300, 2200, 350], q: 1.0, peak: 0.5, tone: { f0: 340, f1: 220, wave: "saw", level: 0.16 }, pan: [-1, 1], lpMix: 0.3, space: HALL }),
  W("whoosh.zoom", "Zoom whoosh", ["whoosh"], { length: 0.7, lmin: 0.2, lmax: 3, brightness: 0.55, width: 0.6, tail: 0.2 },
    { color: "white", f: [250, 6000, 7000], q: 1.2, peak: 0.8, rise: 2, fall: 0.6, flange: 0.5, space: PLATE }),
  W("whoosh.tail", "Whoosh with tail", ["whoosh"], { length: 0.6, lmin: 0.2, lmax: 3, brightness: 0.5, width: 0.7, tail: 0.75 },
    { color: "pink", f: [400, 2600, 500], q: 1.0, peak: 0.4, rise: 1.2, fall: 1.6, pan: [-0.4, 0.4], space: HUGE }),
];

// ── risers and downlifters ──────────────────────────────────────────────────────────────────────────────

interface RiseO {
  /** 1 = rises, −1 = falls. */
  dir: 1 | -1;
  /** The loudness curve's exponent (rises: u^curve; falls: (1 − u)^curve). */
  curve: number;
  attack?: number;
  noise?: { color: NoiseColor; f: [number, number]; q: number; level: number; type?: FType };
  synth?: { f0: number; semis: number; chord: number[]; voices: number; cents: number; wave: Wave; level: number; filter: [number, number]; q?: number; vib?: [number, number] };
  shepard?: { base: number; octaves: number; speed: number; level: number };
  fm?: { f: [number, number]; ratio: number; index: [number, number]; level: number };
  sub?: { f: [number, number]; level: number };
  trem?: { from: number; to: number; depth: number; square?: boolean };
  flange?: number;
  crush?: [number, number];
  space: Space;
}

function riser(o: RiseO, v: Values, c: RenderCtx): Stereo {
  const { sr, rng } = c, nb = Math.max(16, secs(v.length, sr)), k = pk(v), b = bright(v), w = clamp(v.width ?? 0.6, 0, 1);
  const mix: Stereo = [sig(nb), sig(nb)];
  const u = (i: number) => i / (nb - 1);
  if (o.noise) {
    const z = noise(o.noise.color, nb, rng.fork(1));
    const y = svf(z, sr, o.noise.type ?? "bp", glide(nb, o.noise.f[0] * b * k, o.noise.f[1] * b * k, o.dir > 0 ? 1.4 : 0.7), o.noise.q);
    addSt(mix, spread(y, sr, 0.3 + 0.7 * w), o.noise.level);
  }
  if (o.synth) {
    const s = o.synth, fr = sig(nb);
    const vib = s.vib ? sig(nb) : null;
    let vph = 0;
    for (let i = 0; i < nb; i++) {
      let f = s.f0 * k * Math.pow(2, (s.semis * Math.pow(u(i), o.dir > 0 ? 1.5 : 0.8)) / 12);
      if (vib && s.vib) { const rate = 5 + 2 * u(i); vph += rate / sr; f *= 1 + (s.vib[0] + (s.vib[1] - s.vib[0]) * u(i)) * Math.sin(TAU * vph); }
      fr[i] = f;
    }
    const sm: Stereo = [sig(nb), sig(nb)];
    s.chord.forEach((iv, j) => addSt(sm, stack(nb, sr, fr.map((f) => f * Math.pow(2, iv / 12)), s.voices, s.cents, rng.fork(10 + j), 0.4 + 0.5 * w, s.wave), 1 / Math.sqrt(s.chord.length)));
    const cut = glide(nb, s.filter[0] * b, s.filter[1] * b, o.dir > 0 ? 1.3 : 0.8);
    addSt(mix, [svf(sm[0], sr, "lp", cut, s.q ?? 0.9), svf(sm[1], sr, "lp", cut, s.q ?? 0.9)], s.level);
  }
  if (o.shepard) {
    const sh = o.shepard, y = sig(nb), comps = sh.octaves, ph = new Float64Array(comps).map(() => rng.next());
    for (let i = 0; i < nb; i++) {
      const prog = sh.speed * (o.dir > 0 ? u(i) : -u(i));
      for (let j = 0; j < comps; j++) {
        let pos = (j + prog) % comps; if (pos < 0) pos += comps;
        const f = sh.base * k * Math.pow(2, pos), a = 0.5 - 0.5 * Math.cos((TAU * pos) / comps);
        y[i] += a * Math.sin(TAU * ph[j]);
        ph[j] += f / sr; if (ph[j] >= 1) ph[j] -= 1;
      }
    }
    addSt(mix, spread(svf(y, sr, "lp", 6000 * b), sr, 0.4 + 0.5 * w), sh.level / Math.sqrt(comps));
  }
  if (o.fm) {
    const f = o.fm, fr = glide(nb, f.f[0] * k, f.f[1] * k, o.dir > 0 ? 1.5 : 0.7);
    addSt(mix, spread(fm(nb, sr, fr, f.ratio, glide(nb, Math.max(0.01, f.index[0]), Math.max(0.01, f.index[1]), 1)), sr, 0.3 + 0.6 * w), f.level);
  }
  if (o.sub) {
    const s = osc(nb, sr, glide(nb, o.sub.f[0] * k, o.sub.f[1] * k, 0.8));
    addSt(mix, s, o.sub.level);
  }
  // loudness over time, an accelerating tremolo, flanging, crushing
  const env = sig(nb), A = Math.max(1, secs(o.attack ?? 0.01, sr));
  for (let i = 0; i < nb; i++) env[i] = (o.dir > 0 ? Math.pow(u(i), o.curve) : Math.pow(1 - u(i), o.curve)) * Math.min(1, i / A);
  if (o.dir > 0) { const rl = Math.min(nb, secs(0.03, sr)); for (let i = 0; i < rl; i++) env[nb - 1 - i] *= i / rl; }
  if (o.trem) {
    let ph = 0;
    for (let i = 0; i < nb; i++) {
      const pos = o.dir > 0 ? u(i) : 1 - u(i), rate = o.trem.from * Math.pow(o.trem.to / o.trem.from, pos);
      ph += rate / sr;
      const l = o.trem.square ? (ph % 1 < 0.5 ? 1 : 0.15) : 0.5 + 0.5 * Math.cos(TAU * ph);
      env[i] *= 1 - o.trem.depth * (1 - l);
    }
  }
  let st = mulSt(mix, env);
  if (o.flange) {
    const d = sig(nb);
    for (let i = 0; i < nb; i++) d[i] = 0.0008 + 0.006 * (0.5 + 0.5 * Math.sin(TAU * 0.35 * (i / sr)));
    st = [comb(st[0], sr, d, 0.3 + 0.45 * o.flange, 0.1, 0.5), comb(st[1], sr, d.map((x) => x * 1.13), 0.3 + 0.45 * o.flange, 0.1, 0.5)];
  }
  if (o.crush) {
    const bits = glide(nb, o.crush[0], o.crush[1], 1), hold = bits.map((x) => 1 + Math.round(Math.max(0, 12 - x) * 1.5));
    st = [crush(st[0], bits, hold), crush(st[1], bits, hold)];
  }
  return inSpace(fitSt(st, c.n), sr, v, o.space);
}

const R = (id: string, name: string, cat: "riser" | "downlifter", d: { length: number; lmin?: number; lmax?: number; brightness?: number; width?: number; tail?: number }, o: RiseO): SfxDef => ({
  id, name, category: cat, tags: [cat], stereo: true,
  params: [P.length(d.length, d.lmin ?? 0.5, d.lmax ?? 12), P.pitch(), P.brightness(d.brightness ?? 0.5), P.width(d.width ?? 0.7), P.tail(d.tail ?? 0.3)],
  len: (v) => v.length + tailSeconds(v, o.space),
  render: (v, c) => riser(o, v, c),
});

const SAW_STACK = { voices: 7, cents: 24, wave: "saw" as Wave };

export const RISERS: SfxDef[] = [
  R("riser.noise", "Noise riser", "riser", { length: 4, tail: 0.3 },
    { dir: 1, curve: 2.2, noise: { color: "white", f: [300, 9000], q: 0.9, level: 1 }, flange: 0.4, space: HALL }),
  R("riser.synth", "Synth riser", "riser", { length: 4, tail: 0.35 },
    { dir: 1, curve: 1.8, synth: { f0: 110, semis: 12, chord: [0, 7, 12], ...SAW_STACK, level: 1, filter: [400, 9000] }, noise: { color: "pink", f: [400, 8000], q: 0.8, level: 0.3 }, space: HALL }),
  R("riser.tension", "Tension riser (strings-like)", "riser", { length: 6, lmax: 16, brightness: 0.45, tail: 0.4 },
    { dir: 1, curve: 1.4, attack: 0.8, synth: { f0: 220, semis: 5, chord: [0, 1, 7, 12], voices: 5, cents: 14, wave: "saw", level: 1, filter: [700, 4200], q: 0.8, vib: [0.002, 0.012] }, trem: { from: 4, to: 14, depth: 0.45 }, space: HALL }),
  R("riser.shepard", "Shepard-like riser", "riser", { length: 6, lmax: 20, tail: 0.3 },
    { dir: 1, curve: 0.8, attack: 0.6, shepard: { base: 55, octaves: 7, speed: 1.6, level: 1 }, noise: { color: "pink", f: [500, 6000], q: 0.7, level: 0.12 }, space: HALL }),
  R("riser.filter", "Filter sweep riser", "riser", { length: 3, tail: 0.3 },
    { dir: 1, curve: 1.5, synth: { f0: 55, semis: 0, chord: [0, 7, 12], voices: 5, cents: 18, wave: "saw", level: 1, filter: [150, 8000], q: 5 }, noise: { color: "pink", f: [200, 7000], q: 0.8, level: 0.3 }, space: PLATE }),
  R("riser.scifi", "Sci-fi riser", "riser", { length: 3, tail: 0.3 },
    { dir: 1, curve: 1.6, fm: { f: [200, 1600], ratio: 2.01, index: [1, 8], level: 1 }, trem: { from: 2, to: 22, depth: 0.5 }, flange: 0.6, space: PLATE }),
  R("riser.short", "Short riser", "riser", { length: 1.5, lmin: 0.3, lmax: 4, tail: 0.25 },
    { dir: 1, curve: 2, noise: { color: "white", f: [500, 9000], q: 0.9, level: 0.8 }, synth: { f0: 220, semis: 12, chord: [0, 12], voices: 5, cents: 20, wave: "saw", level: 0.6, filter: [600, 8000] }, space: ROOM }),
  R("riser.pulse", "Pulse riser", "riser", { length: 4, tail: 0.3 },
    { dir: 1, curve: 1.6, noise: { color: "pink", f: [400, 7000], q: 0.9, level: 0.8 }, synth: { f0: 55, semis: 7, chord: [0, 12], voices: 5, cents: 15, wave: "saw", level: 0.7, filter: [300, 3500] }, trem: { from: 4, to: 32, depth: 0.85, square: true }, space: ROOM }),
];

export const DOWNLIFTERS: SfxDef[] = [
  R("down.noise", "Noise downlifter", "downlifter", { length: 3, tail: 0.35 },
    { dir: -1, curve: 1.5, attack: 0.02, noise: { color: "white", f: [9000, 250], q: 0.9, level: 1 }, flange: 0.3, space: HALL }),
  R("down.synth", "Synth downlifter", "downlifter", { length: 2.5, tail: 0.35 },
    { dir: -1, curve: 1.3, attack: 0.01, synth: { f0: 440, semis: -24, chord: [0, 7, 12], ...SAW_STACK, level: 1, filter: [9000, 300] }, space: HALL }),
  R("down.sub", "Sub downlifter", "downlifter", { length: 2.5, brightness: 0.4, tail: 0.2 },
    { dir: -1, curve: 1.1, attack: 0.01, sub: { f: [140, 35], level: 1 }, noise: { color: "brown", f: [900, 120], q: 0.7, level: 0.35, type: "lp" }, space: ROOM }),
  R("down.filter", "Filter sweep down", "downlifter", { length: 2.5, tail: 0.3 },
    { dir: -1, curve: 1.2, attack: 0.01, synth: { f0: 55, semis: 0, chord: [0, 7, 12], voices: 5, cents: 18, wave: "saw", level: 1, filter: [8000, 150], q: 5 }, space: PLATE }),
  R("down.power", "Power down (sci-fi)", "downlifter", { length: 2, tail: 0.25 },
    { dir: -1, curve: 1.0, attack: 0.01, fm: { f: [900, 60], ratio: 1.5, index: [6, 0.5], level: 1 }, crush: [12, 3], space: ROOM }),
  R("down.whoosh", "Whoosh downlifter", "downlifter", { length: 2.5, tail: 0.5 },
    { dir: -1, curve: 2.2, attack: 0.08, noise: { color: "pink", f: [6000, 300], q: 1.2, level: 1 }, sub: { f: [90, 40], level: 0.25 }, space: HUGE }),
];
