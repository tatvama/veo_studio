/**
 * Textures: glitches and digital noise, tape and vinyl (variable-speed playback of a generated source: tape stops and
 * starts, scratches; crackle), heartbeats, ambience loops (wind, rain, room tone, city, ocean, crickets, fire, a noise
 * bed) and crowds (granular applause, a cheer and a murmur from formant-filtered voices: crowd-like, not recordings).
 * Loops are seamless: a continuous bed is cross-faded into its own start, events wrap around. docs/EDITOR.md §15.1.
 */
import {
  add, addSt, adsr, brown, burst, clamp, crush, db, dust, fitSt, glide, mul, mulSt, osc, oscInto, pan, perc, pink, ping, scatter, secs, sig, spread,
  stack, svf, swell, TAU, vari, wander, white, width as msWidth, type Rng, type Sig, type Stereo,
} from "../dsp.ts";
import { loopCrossfade } from "../level.ts";
import type { RenderCtx, SfxDef, SfxTag, Values } from "../types.ts";
import { bright, HALL, inSpace, P, pk, ROOM, STUDIO, tailSeconds, val } from "./common.ts";

const both = (st: Stereo, f: (x: Sig, ch: number) => Sig): Stereo => [f(st[0], 0), f(st[1], 1)];

// ── glitch and digital ──────────────────────────────────────────────────────────────────────────────────

const GL_PARAMS = (length: number, intensity = 0.6) => [P.length(length, 0.15, 6), P.pitch(), P.brightness(), P.intensity(intensity), P.width(0.6)];
const G = (id: string, name: string, tags: SfxTag[], length: number, render: (v: Values, c: RenderCtx) => Stereo, intensity?: number): SfxDef => ({
  id, name, category: "glitch", tags, stereo: true, params: GL_PARAMS(length, intensity), len: (v) => v.length + 0.02, render,
});
/** A segment with 2 ms edges. */
const edge = (x: Sig, sr: number) => { const e = Math.min(x.length >> 1, secs(0.002, sr)); for (let i = 0; i < e; i++) { const g = i / e; x[i] *= g; x[x.length - 1 - i] *= g; } return x; };

function glitchBurst(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), I = clamp(v.intensity, 0, 1), w = clamp(v.width, 0, 1), L = secs(v.length, sr), mix: Stereo = [sig(n), sig(n)], r = rng.fork(1);
  let t = 0, last: Sig | null = null;
  while (t < L) {
    const m = Math.min(L - t, secs(r.range(0.015, 0.07), sr));
    if (m < 8) break;
    const kind = r.next();
    let x: Sig;
    if (last && kind < 0.18) x = fitSt([last, last], m)[0];
    else if (kind < 0.42) x = svf(osc(m, sr, r.range(80, 2000) * k, "square"), sr, "lp", 5000 * b);
    else if (kind < 0.66) x = crush(white(m, r), r.range(2, 5 + 3 * (1 - I)), r.int(2, 12));
    else if (kind < 0.82) x = osc(m, sr, r.range(300, 3000) * k, r.chance(0.5) ? "sine" : "tri");
    else x = sig(m);
    last = x;
    addSt(mix, pan(edge(Float64Array.from(x), sr), r.bi() * w), r.range(0.5, 1), t);
    t += m;
  }
  return mix;
}

function stutter(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), I = clamp(v.intensity, 0, 1), w = clamp(v.width, 0, 1), r = rng.fork(1), L = secs(v.length, sr);
  const src = stack(secs(0.08, sr), sr, 220 * k, 5, 20, r, 0.5);
  add(src[0], white(src[0].length, r), 0.25); add(src[1], white(src[1].length, r), 0.25);
  const chunkSrc = both(src, (x) => svf(x, sr, "lp", 4500 * b));
  const mix: Stereo = [sig(n), sig(n)];
  let t = 0, len = 0.07, step = 0;
  while (t < L) {
    const m = Math.min(secs(len, sr), L - t);
    if (m < 16) break;
    const rate = Math.pow(2, (step % 4) * (0.15 + 0.35 * I));
    const ch = both(chunkSrc, (x) => edge(crush(vari(x, rate, m), 12 - 7 * I, 1 + Math.round(4 * I)), sr));
    addSt(mix, [ch[0], ch[1]], 1, t);
    t += m + secs(0.004 + 0.01 * r.next(), sr);
    len = Math.max(0.012, len * (0.86 - 0.08 * I));
    step++;
  }
  return msWidth(mix, 0.4 + 1.2 * w);
}

function crushSweep(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), I = clamp(v.intensity, 0, 1), m = secs(v.length, sr);
  const src = stack(m, sr, 110 * k, 5, 18, rng.fork(1), 0.5 + 0.4 * v.width);
  [165, 220].forEach((f, j) => addSt(src, stack(m, sr, f * k, 3, 12, rng.fork(2 + j), 0.5), 0.6));
  const bits = glide(m, 12, 2.2 - 1.2 * I, 1.2), hold = bits.map((x) => 1 + Math.round(Math.pow(Math.max(0, 12 - x), 1.4) * (1 + I)));
  const st = both(src, (x) => crush(svf(x, sr, "lp", 6000 * b), bits, hold));
  return fitSt(mulSt(st, adsr(m, sr, 0.01, 0.3, 0.85, 0.05)), n);
}

function staticBurst(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, b = bright(v), I = clamp(v.intensity, 0, 1), w = clamp(v.width, 0, 1), m = secs(v.length, sr), r = rng.fork(1);
  const gate = sig(m);
  for (let i = 0, on = true, left = 0; i < m; i++) { if (left-- <= 0) { on = r.chance(0.75 - 0.3 * I); left = secs(r.range(0.008, 0.05), sr); } gate[i] = on ? 1 : 0.08; }
  const sm = lpEdge(gate, sr);
  const st = both([white(m, r.fork(1)), white(m, r.fork(2))], (x) => {
    const y = svf(svf(x, sr, "hp", 500, 0.7), sr, "lp", 9000 * b, 0.7);
    add(y, dust(m, sr, r, 60 + 120 * I), 0.8);
    return mul(y, sm);
  });
  const st2: Stereo = [st[0], st[0].map((s, i) => (1 - w) * s + w * st[1][i])];
  return fitSt(mulSt(st2, swell(m, 0.15, 0.6, 0.8)), n);
}
/** A 1 ms smoothing of a gate (no clicks). */
function lpEdge(x: Sig, sr: number): Sig { const a = Math.exp(-1 / (0.001 * sr)); let y = x[0] ?? 0; return x.map((s) => (y = s + (y - s) * a)); }

function errorBuzz(v: Values, c: RenderCtx): Stereo {
  const { sr, n } = c, k = pk(v), b = bright(v), I = clamp(v.intensity, 0, 1), m = secs(v.length, sr);
  const y = osc(m, sr, 110 * k, "square");
  add(y, osc(m, sr, 220 * k * 1.005, "saw"), 0.5);
  const am = sig(m).map((_, i) => 0.55 + 0.45 * Math.sign(Math.sin((TAU * 28 * i) / sr)));
  const z = mul(crush(svf(y, sr, "lp", 3000 * b), 8 - 4 * I, 1 + Math.round(3 * I)), lpEdge(am, sr));
  return fitSt(spread(mul(z, adsr(m, sr, 0.004, 0.2, 0.9, 0.03)), sr, 0.3 * v.width), n);
}

function blips(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), w = clamp(v.width, 0, 1), L = v.length, mix: Stereo = [sig(n), sig(n)], r = rng.fork(1);
  const scale = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24];
  for (let t = 0; t < L - 0.03; ) {
    const d = r.range(0.025, 0.06), m = secs(d, sr), f = 800 * k * Math.pow(2, r.pick(scale) / 12);
    const x = mul(osc(m, sr, f, r.chance(0.6) ? "square" : "sine"), perc(m, sr, 0.001, d * 2, d * 0.4));
    addSt(mix, pan(svf(x, sr, "lp", 6000 * b), r.bi() * w), r.range(0.5, 1), secs(t, sr));
    t += d + r.range(0, 0.05) * (1.2 - clamp(v.intensity, 0, 1));
  }
  return mix;
}

function tvStatic(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, b = bright(v), I = clamp(v.intensity, 0, 1), m = secs(v.length, sr), r = rng.fork(1);
  const st = both([white(m, r.fork(1)), white(m, r.fork(2))], (x) => svf(svf(x, sr, "hp", 300), sr, "lp", 9000 * b));
  const hum = osc(m, sr, 60, "saw");
  const h = svf(hum, sr, "lp", 400);
  addSt(st, h, 0.12 + 0.2 * I);
  addSt(st, dust(m, sr, r, 30 + 80 * I), 0.5);
  const st2: Stereo = [st[0], st[0].map((s, i) => (1 - v.width) * s + v.width * st[1][i])];
  return fitSt(mulSt(st2, adsr(m, sr, 0.01, 0.2, 1, 0.05)), n);
}

function scan(v: Values, c: RenderCtx): Stereo {
  const { sr, n } = c, k = pk(v), b = bright(v), w = clamp(v.width, 0, 1), L = v.length, mix: Stereo = [sig(n), sig(n)];
  const per = 0.08 * (1.3 - 0.6 * clamp(v.intensity, 0, 1));
  let j = 0;
  for (let t = 0; t < L - 0.06; t += per, j++) {
    const m = secs(0.06, sr), x = mul(osc(m, sr, glide(m, 800 * k, 3000 * k * Math.min(1.5, b), 1.5)), perc(m, sr, 0.002, 0.07, 0.02));
    addSt(mix, pan(x, (j % 2 ? 1 : -1) * 0.5 * w), 1, secs(t, sr));
  }
  return mix;
}

function powerGlitch(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), I = clamp(v.intensity, 0, 1), m = secs(v.length, sr), r = rng.fork(1);
  const src = svf(osc(secs(v.length + 0.5, sr), sr, 60 * k, "saw"), sr, "lp", 900 * b);
  add(src, osc(src.length, sr, 120 * k), 0.3);
  const rate = sig(m).map((_, i) => { const u = i / m; return u < 0.7 ? 1 : 1 - 0.75 * Math.pow((u - 0.7) / 0.3, 1.2); });
  const y = vari(src, rate, m);
  const gate = sig(m).fill(1);
  for (let cut = 0; cut < 3 + Math.round(4 * I); cut++) { const a = r.int(0, m - 1), len = secs(r.range(0.02, 0.09), sr); for (let i = a; i < Math.min(m, a + len); i++) gate[i] = 0.05; }
  mul(y, lpEdge(gate, sr));
  add(y, mul(dust(m, sr, r, 40 + 100 * I), gate.map((g) => 1.2 - g)), 0.9);
  return fitSt(spread(mul(y, adsr(m, sr, 0.01, 0.3, 1, 0.08)), sr, 0.3 * v.width), n);
}

function vhs(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), I = clamp(v.intensity, 0, 1), m = secs(v.length, sr), r = rng.fork(1);
  const wob = sig(m).map((_, i) => 1 + 0.012 * I * Math.sin((TAU * 0.6 * i) / sr) + 0.003 * Math.sin((TAU * 8 * i) / sr));
  const pad: Stereo = [sig(m), sig(m)];
  [0, 4, 7].forEach((st, j) => addSt(pad, stack(m, sr, wob.map((x) => x * 196 * k * Math.pow(2, st / 12)), 3, 10, r.fork(j), 0.5 + 0.4 * v.width), 0.6));
  const st = both(pad, (x) => svf(x, sr, "lp", 1600 * b, 0.8));
  for (let j = 0; j < 2 + Math.round(4 * I); j++) {
    const a = r.int(0, m - 1), d = secs(r.range(0.02, 0.1), sr);
    if (r.chance(0.5)) addSt(st, mul(svf(white(d, r), sr, "hp", 2000), perc(d, sr, 0.001, d / sr)), 0.6, a);
    else addSt(st, mul(osc(d, sr, 59.94, "square"), perc(d, sr, 0.002, d / sr)), 0.35, a);
    if (r.chance(0.4)) for (let i = a; i < Math.min(m, a + d); i++) { st[0][i] *= 0.2; st[1][i] *= 0.2; }
  }
  addSt(st, svf(white(m, r), sr, "hp", 5000), 0.03);
  return fitSt(mulSt(st, adsr(m, sr, 0.02, 0.3, 1, 0.08)), n);
}

export const GLITCH: SfxDef[] = [
  G("glitch.burst", "Glitch burst", ["glitch"], 0.6, glitchBurst),
  G("glitch.stutter", "Data stutter", ["glitch"], 0.8, stutter),
  G("glitch.crush_sweep", "Bitcrush sweep", ["glitch"], 1.2, crushSweep),
  G("glitch.static_burst", "Static burst", ["static", "glitch"], 0.7, staticBurst),
  G("glitch.error_buzz", "Error buzz", ["glitch"], 0.45, errorBuzz),
  G("glitch.blips", "Digital blips", ["glitch"], 0.9, blips),
  G("glitch.tv_static", "TV static", ["static"], 2, tvStatic, 0.4),
  G("glitch.scan", "Data scan", ["glitch"], 1.2, scan),
  G("glitch.power", "Power glitch", ["glitch"], 1.2, powerGlitch),
  G("glitch.vhs", "Tape glitch (VHS-like)", ["glitch"], 1.2, vhs),
];

// ── tape and vinyl ──────────────────────────────────────────────────────────────────────────────────────

/** A short musical bed (a chord on the beat with a kick) for the tape effects to work on. */
function musicBed(sr: number, r: Rng, seconds: number, k: number, b: number): Stereo {
  const m = secs(seconds, sr), st: Stereo = [sig(m), sig(m)], beat = 0.5;
  [0, 3, 7, 12].forEach((iv, j) => addSt(st, stack(m, sr, 130.8 * k * Math.pow(2, iv / 12), 3, 12, r.fork(j), 0.6), 0.4));
  const chord = both(st, (x) => svf(x, sr, "lp", 2200 * b, 0.8));
  const gate = sig(m);
  for (let t = 0; t < seconds; t += beat / 2) { const a = secs(t, sr), e = perc(secs(beat / 2, sr), sr, 0.005, 0.3); add(gate, e, 1, a); }
  mulSt(chord, gate);
  for (let t = 0; t < seconds; t += beat) {
    const x = mul(osc(secs(0.3, sr), sr, glide(secs(0.3, sr), 150, 50, 0.6, sr, 0.04)), perc(secs(0.3, sr), sr, 0.002, 0.28));
    addSt(chord, x, 0.9, secs(t, sr));
  }
  return chord;
}

function tapeStop(v: Values, c: RenderCtx, start: boolean): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), L = v.length, pre = start ? 0 : 0.35, post = start ? 0.5 : 0;
  const src = musicBed(sr, rng.fork(1), pre + L + post + 0.5, k, b), m = secs(pre + L + post, sr), a = secs(pre, sr), d = secs(L, sr);
  const cv = clamp(val(v, "curve", 1.6), 0.5, 4);
  const rate = sig(m).map((_, i) => {
    if (start) return i < d ? Math.pow(i / d, cv) : 1;
    return i < a ? 1 : i < a + d ? Math.pow(1 - (i - a) / d, cv) : 0;
  });
  const out = both(src, (x) => vari(x, rate, m));
  if (!start) { const e = Math.min(m, secs(0.02, sr)); for (let i = 0; i < e; i++) { const g = i / e; out[0][m - 1 - i] *= g; out[1][m - 1 - i] *= g; } }
  return fitSt(out, n);
}

/** A vocal-like source for scratching: a sawtooth through vowel formants, with breath. */
function vocalSource(sr: number, r: Rng, seconds: number, k: number, b: number): Sig {
  const m = secs(seconds, sr), src = sig(m);
  oscInto(src, sr, wander(m, sr, r, 3).map((x) => 130 * k * (1 + 0.08 * x)), "saw");
  add(src, white(m, r), 0.15);
  const y = sig(m);
  for (const [f, q, g] of [[750, 8, 1], [1150, 9, 0.6], [2600, 10, 0.3]] as const) add(y, svf(src, sr, "bpq", f * b, q), g / q * 4);
  return y;
}

function scratch(v: Values, c: RenderCtx, strokes: number): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), L = v.length, m = secs(L, sr), src = vocalSource(sr, rng.fork(1), 3, k, b);
  const speed = clamp(val(v, "speed", 1), 0.4, 2.5);
  const rate = sig(m).map((_, i) => { const u = i / m; return 2.6 * speed * Math.sin(TAU * strokes * u) * Math.sin(Math.PI * u) + 0.15; });
  const y = vari(src, rate, m, src.length / 2);
  const env = sig(m).map((_, i) => Math.min(1, Math.abs(rate[i]) * 1.2) * Math.min(1, i / (0.004 * sr)) * Math.min(1, (m - i) / (0.01 * sr)));
  return fitSt(spread(mul(y, env), sr, 0.2 * val(v, "width", 0.3)), n);
}

export const TAPE: SfxDef[] = [
  {
    id: "tape.stop", name: "Tape stop", category: "tape", tags: ["tape_stop"], stereo: true,
    params: [P.length(0.9, 0.2, 4, "Stop time"), P.num("curve", "Curve", 1.6, 0.5, 4, 0.1), P.pitch(), P.brightness()],
    len: (v) => 0.35 + v.length + 0.02, render: (v, c) => tapeStop(v, c, false),
  },
  {
    id: "tape.start", name: "Tape start", category: "tape", tags: [], stereo: true,
    params: [P.length(0.8, 0.2, 4, "Start time"), P.num("curve", "Curve", 1.6, 0.5, 4, 0.1), P.pitch(), P.brightness()],
    len: (v) => v.length + 0.5, render: (v, c) => tapeStop(v, c, true),
  },
  {
    id: "tape.scratch", name: "Record scratch", category: "tape", tags: ["scratch"], stereo: false,
    params: [P.length(0.6, 0.2, 2), P.num("speed", "Speed", 1, 0.4, 2.5, 0.05, "×"), P.pitch(), P.brightness()],
    len: (v) => v.length, render: (v, c) => scratch(v, c, 1.5),
  },
  {
    id: "tape.crackle", name: "Vinyl crackle loop", category: "tape", tags: [], stereo: true, loop: "wrap", overhang: 0.1,
    params: [P.length(6, 2, 30), P.num("crackle", "Crackle", 0.5, 0, 1, 0.01), P.brightness(), P.width(0.6)],
    len: (v) => v.length,
    render: (v, c) => {
      const { sr, rng, n } = c, b = bright(v), cr = clamp(v.crackle, 0, 1), w = clamp(v.width, 0, 1), Lp = c.loopN ?? n;
      const out = bed(c, (m) => {
        const hiss: Stereo = [svf(pink(m, rng.fork(1)), sr, "hp", 3000 * b), svf(pink(m, rng.fork(2)), sr, "hp", 3000 * b)];
        const rum = svf(brown(m, rng.fork(3)), sr, "lp", 60);
        return [add(mul(hiss[0], 0.12), rum, 0.25), add(mul(hiss[1], 0.12), rum, 0.25)];
      });
      for (let ch = 0; ch < 2; ch++) {
        const r = rng.fork(10 + ch), tgt: Stereo = [out[ch], sig(n)];
        scatter(tgt, sr, r, 8 + 60 * cr, (q) => ({ x: burst(sr, q, q.range(1500, 6000) * b, 0.8, 0.0001, q.range(0.0004, 0.0015), "hp"), gain: q.range(0.1, 0.6), pan: -1 }), 0, Lp);
        scatter(tgt, sr, r, 0.6 + 1.2 * cr, (q) => ({ x: burst(sr, q, q.range(500, 1200), 0.8, 0.0003, 0.004, "lp"), gain: q.range(0.5, 1), pan: -1 }), 0, Lp);
      }
      return msWidth(out, w);
    },
  },
  {
    id: "tape.scratch_double", name: "Double scratch", category: "tape", tags: ["scratch"], stereo: false,
    params: [P.length(0.8, 0.25, 2.5), P.num("speed", "Speed", 1, 0.4, 2.5, 0.05, "×"), P.pitch(), P.brightness()],
    len: (v) => v.length, render: (v, c) => scratch(v, c, 3),
  },
];

// ── heartbeat ───────────────────────────────────────────────────────────────────────────────────────────

const beatLen = (v: Values) => { const p = 60 / v.bpm; return Math.max(1, Math.round(v.length / p)) * p; };
function heartbeat(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, k = pk(v), punch = clamp(val(v, "punch", 0.5), 0, 1), p = 60 / v.bpm, beats = Math.max(1, Math.round((c.loopN ?? n) / sr / p)), mix: Stereo = [sig(n), sig(n)], r = rng.fork(1);
  const thump = (f: number, decay: number, lvl: number, at: number) => {
    const m = secs(decay * 1.3, sr), x = mul(osc(m, sr, glide(m, f * 1.4 * k, f * k, 0.5, sr, 0.03)), perc(m, sr, 0.006 - 0.004 * punch, decay));
    add(x, mul(svf(white(m, r), sr, "lp", 250, 0.7), perc(m, sr, 0.003, decay * 0.6)), 0.5 + 0.6 * punch);
    addSt(mix, x, lvl, secs(at, sr));
  };
  const gap = Math.min(0.3, 0.36 * p);
  for (let j = 0; j < beats; j++) { const t = j * p; thump(52, 0.14, 1, t); thump(64, 0.1, 0.7, t + gap); }
  return inSpace(both(mix, (x) => svf(x, sr, "lp", 900)), sr, v, STUDIO);
}
const HB = (id: string, name: string, bpm: number, punch: number): SfxDef => ({
  id, name, category: "heartbeat", tags: ["heartbeat"], stereo: false, loop: "wrap",
  params: [P.length(bpm > 100 ? 4 : 5, 1, 30), P.num("bpm", "Beats per minute", bpm, 40, 180, 1, "bpm"), P.pitch(0, 7), P.punch(punch), P.tail(0.1)],
  len: beatLen, render: heartbeat,
});
export const HEARTBEATS: SfxDef[] = [HB("heart.loop", "Heartbeat loop", 70, 0.45), HB("heart.racing", "Racing heartbeat", 130, 0.7)];

// ── ambience loops ──────────────────────────────────────────────────────────────────────────────────────

/** A continuous bed that loops: rendered a little long, its overhang cross-faded into its start, silent after the
 *  loop (so the framework's wrap of event tails doesn't double it). */
function bed(c: RenderCtx, make: (m: number) => Stereo): Stereo {
  const L = c.loopN ?? c.n, X = Math.max(1, Math.min(secs(0.75, c.sr), Math.floor(L * 0.2)));
  return fitSt(loopCrossfade(make(L + X), L), c.n);
}
const AMB = (id: string, name: string, tags: SfxTag[], extra: SfxDef["params"], render: (v: Values, c: RenderCtx) => Stereo, overhang = 0): SfxDef => ({
  id, name, category: "ambience", tags, stereo: true, loop: "wrap", overhang,
  params: [P.length(8, 3, 30), ...extra, P.brightness(), P.width(0.8)],
  len: (v) => v.length, render,
});

function windAmb(v: Values, c: RenderCtx): Stereo {
  const { sr, rng } = c, b = bright(v), I = clamp(v.intensity, 0, 1), w = clamp(v.width, 0, 1);
  return bed(c, (m) => {
    const md = wander(m, sr, rng.fork(1), 0.12), gust = wander(m, sr, rng.fork(2), 0.07);
    const side = (ch: number): Sig => {
      const z = pink(m, rng.fork(10 + ch)), r2 = wander(m, sr, rng.fork(20 + ch), 0.2);
      const fc = sig(m).map((_, i) => 420 * b * Math.pow(2, 1.1 * (md[i] * 0.7 + r2[i] * 0.3 * w)));
      const y = svf(z, sr, "bp", fc, 1.8);
      add(y, svf(brown(m, rng.fork(30 + ch)), sr, "lp", 280), 0.6);
      const g = svf(white(m, rng.fork(40 + ch)), sr, "bpq", fc.map((f) => f * 2.6), 4);
      add(y, mul(g, gust.map((x) => Math.pow(Math.max(0, x), 2) * I)), 0.4);
      return mul(y, md.map((x, i) => 0.55 + 0.35 * x + 0.3 * I * Math.max(0, gust[i])));
    };
    return [side(0), side(1)];
  });
}

function rainAmb(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, b = bright(v), I = clamp(v.intensity, 0, 1), w = clamp(v.width, 0, 1), Lp = c.loopN ?? n;
  const out = bed(c, (m) => [0, 1].map((ch) => svf(svf(pink(m, rng.fork(1 + ch)), sr, "hp", 450), sr, "lp", 6500 * b)) as Stereo);
  mulSt(out, 0.5);
  for (let ch = 0; ch < 2; ch++) {
    const tgt: Stereo = [out[ch], sig(n)];
    scatter(tgt, sr, rng.fork(10 + ch), 120 + 500 * I, (q) => ({ x: burst(sr, q, q.range(2000, 9000) * b, q.range(1.2, 3), 0.0002, q.range(0.001, 0.004)), gain: Math.pow(q.next(), 2) * 0.9, pan: -1 }), 0, Lp);
    scatter(tgt, sr, rng.fork(20 + ch), 3 + 6 * I, (q) => ({ x: add(ping(sr, q.range(1200, 3200) * b, 0.02, 0.0005, 0.7), burst(sr, q, 3500 * b, 1.5, 0.0002, 0.003), 0.6), gain: q.range(0.3, 0.8), pan: -1 }), 0, Lp);
  }
  return msWidth(out, w);
}

function roomAmb(v: Values, c: RenderCtx): Stereo {
  const { sr, rng } = c, b = bright(v), hum = clamp(v.hum, 0, 1), w = clamp(v.width, 0, 1);
  return bed(c, (m) => {
    const common = svf(brown(m, rng.fork(1)), sr, "lp", 250 * b);
    const drift = wander(m, sr, rng.fork(2), 0.15);
    const side = (ch: number) => {
      const y = add(Float64Array.from(common), svf(brown(m, rng.fork(10 + ch)), sr, "lp", 250 * b), w);
      add(y, svf(pink(m, rng.fork(20 + ch)), sr, "hp", 2500 * b), 0.05);
      add(y, osc(m, sr, 50, "sine"), 0.04 * hum);
      add(y, osc(m, sr, 100, "sine", 0.3), 0.025 * hum);
      return mul(y, drift.map((x) => db(0.8 * x)));
    };
    return [side(0), side(1)];
  });
}

function cityAmb(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, b = bright(v), I = clamp(v.intensity, 0, 1), w = clamp(v.width, 0, 1), Lp = c.loopN ?? n;
  const out = bed(c, (m) => {
    const lfo = wander(m, sr, rng.fork(1), 0.1);
    return [0, 1].map((ch) => {
      const y = svf(brown(m, rng.fork(2 + ch)), sr, "lp", 180 * b);
      add(y, svf(pink(m, rng.fork(4 + ch)), sr, "bp", 700 * b, 0.6), 0.2);
      add(y, osc(m, sr, 120, "sine"), 0.02);
      return mul(y, lfo.map((x) => 0.8 + 0.2 * x));
    }) as Stereo;
  });
  const cars = Math.max(1, Math.round((Lp / sr) * (0.25 + 0.6 * I)));
  const r = rng.fork(9);
  for (let j = 0; j < cars; j++) {
    const d = r.range(3, 6.5), m = secs(d, sr), at = secs(r.range(0, Lp / sr), sr), dir = r.chance(0.5) ? 1 : -1;
    const z = svf(svf(pink(m, r), sr, "bp", glide(m, r.range(500, 900) * b, r.range(280, 450) * b), 0.9), sr, "lp", 1800 * b);
    const e = swell(m, r.range(0.4, 0.6), 1.6, 1.6);
    const st = pan(mul(z, e), sig(m).map((_, i) => dir * (-0.8 + 1.6 * (i / m)) * w));
    addSt(out, st, r.range(0.5, 1.1), at);
  }
  return out;
}

function oceanAmb(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, b = bright(v), w = clamp(v.width, 0, 1), Lp = c.loopN ?? n, per = clamp(val(v, "period", 7), 3, 15);
  const out = bed(c, (m) => [0, 1].map((ch) => mul(svf(brown(m, rng.fork(1 + ch)), sr, "lp", 500 * b), 0.35)) as Stereo);
  const waves = Math.max(1, Math.round(Lp / sr / per)), step = Lp / waves, r = rng.fork(5);
  for (let j = 0; j < waves; j++) {
    const d = per * r.range(0.85, 1.1), m = secs(d, sr), at = Math.round(j * step + r.range(-0.1, 0.1) * step);
    const e = sig(m).map((_, i) => { const u = i / m; return u < 0.25 ? Math.pow(u / 0.25, 1.5) : Math.pow(1 - (u - 0.25) / 0.75, 1.8); });
    const cut = e.map((x) => (350 + 3200 * x) * b);
    const pl = r.range(-0.4, 0.4) * w;
    const st: Stereo = [mul(svf(pink(m, r.fork(1)), sr, "lp", cut), e), mul(svf(pink(m, r.fork(2)), sr, "lp", cut), e)];
    addSt(out, [mul(st[0], 1 - Math.max(0, pl)), mul(st[1], 1 + Math.min(0, pl))], r.range(0.7, 1), Math.max(0, at));
  }
  return out;
}

function cricketsAmb(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), I = clamp(v.intensity, 0, 1), w = clamp(v.width, 0, 1), Lp = c.loopN ?? n;
  const out = bed(c, (m) => [0, 1].map((ch) => mul(svf(pink(m, rng.fork(1 + ch)), sr, "lp", 1800 * b), 0.08)) as Stereo);
  const count = 3 + Math.round(5 * I);
  for (let j = 0; j < count; j++) {
    const r = rng.fork(100 + j), f = r.range(4000, 5200) * k, pulses = r.int(3, 4), prate = r.range(25, 35), period = r.range(0.45, 1.1), lvl = r.range(0.3, 1), pn = r.bi() * w;
    const far = r.chance(0.4);
    for (let t = r.range(0, period); t < Lp / sr; t += period * r.range(0.9, 1.1)) {
      for (let p = 0; p < pulses; p++) {
        const m = secs(0.016, sr);
        let x = mul(osc(m, sr, f), perc(m, sr, 0.002, 0.02, 0.006));
        if (far) x = svf(x, sr, "lp", 3500);
        addSt(out, pan(x, pn), lvl * (far ? 0.5 : 1), secs(t + p / prate, sr));
      }
    }
  }
  return out;
}

function fireAmb(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, b = bright(v), I = clamp(v.intensity, 0, 1), w = clamp(v.width, 0, 1), Lp = c.loopN ?? n;
  const out = bed(c, (m) => {
    const md = wander(m, sr, rng.fork(1), 0.6);
    return [0, 1].map((ch) => {
      const y = svf(brown(m, rng.fork(2 + ch)), sr, "lp", 260 * b);
      add(y, svf(pink(m, rng.fork(4 + ch)), sr, "hp", 3500 * b), 0.06);
      return mul(y, md.map((x) => 0.7 + 0.3 * x));
    }) as Stereo;
  });
  const r = rng.fork(9);
  const rate = sig(n).map((_, i) => (6 + 28 * I) * (0.5 + Math.max(0, Math.sin((TAU * i) / sr / 1.7 + 1))));
  scatter(out, sr, r, rate, (q) => ({ x: burst(sr, q, q.range(1200, 5000) * b, q.range(1, 3), 0.0002, q.range(0.001, 0.008)), gain: Math.pow(q.next(), 1.5) * 1.2, pan: q.bi() * w }), 0, Lp);
  scatter(out, sr, rng.fork(10), 0.8 + 1.5 * I, (q) => ({ x: burst(sr, q, q.range(400, 900), 1, 0.0005, 0.015, "lp"), gain: q.range(0.6, 1.2), pan: q.bi() * w * 0.6 }), 0, Lp);
  return out;
}

function noiseBed(v: Values, c: RenderCtx): Stereo {
  const { sr, rng } = c, b = clamp(v.brightness, 0, 1), w = clamp(v.width, 0, 1);
  return bed(c, (m) => {
    const common = pink(m, rng.fork(1));
    return [0, 1].map((ch) => {
      const y = add(mul(Float64Array.from(common), 1 - w * 0.7), pink(m, rng.fork(2 + ch)), w);
      add(y, svf(white(m, rng.fork(4 + ch)), sr, "hp", 2000), b * 0.5);
      return svf(y, sr, "lp", 2000 + 14000 * b, 0.6);
    }) as Stereo;
  });
}

export const AMBIENCE: SfxDef[] = [
  AMB("amb.wind", "Wind", ["wind"], [P.intensity(0.5)], windAmb),
  AMB("amb.rain", "Rain", ["rain"], [P.intensity(0.5)], rainAmb, 0.2),
  AMB("amb.room_tone", "Room tone", [], [P.num("hum", "Hum", 0.3, 0, 1, 0.01)], roomAmb),
  AMB("amb.city", "City hum-like", [], [P.intensity(0.5)], cityAmb, 7),
  AMB("amb.ocean", "Ocean-like waves", [], [P.num("period", "Wave period", 7, 3, 15, 0.5, "s")], oceanAmb, 16),
  AMB("amb.crickets", "Crickets-like night", [], [P.pitch(0, 5), P.intensity(0.5)], cricketsAmb, 0.3),
  AMB("amb.fire", "Fire crackle", [], [P.intensity(0.5)], fireAmb, 0.2),
  AMB("amb.noise_bed", "White-noise bed", [], [], noiseBed),
];

// ── crowd ───────────────────────────────────────────────────────────────────────────────────────────────

/** Granular applause: each person claps at their own rate, pitch and place, starting and stopping at their own time. */
function applause(mix: Stereo, sr: number, r: Rng, L: number, people: number, b: number, w: number, level = 1) {
  for (let p = 0; p < people; p++) {
    const q = r.fork(p), rate = q.range(3.2, 5.6), fc = q.range(750, 2600) * b, qq = q.range(1, 2), pn = q.bi() * w, lvl = q.range(0.4, 1) * level;
    const start = q.range(0, 0.6), stop = L - q.range(0, 1.4), dec = q.range(0.007, 0.014);
    for (let t = start; t < stop; t += (1 / rate) * q.range(0.92, 1.08)) {
      const fade = Math.min(1, (stop - t) / 0.6);
      addSt(mix, pan(burst(sr, q, fc * q.range(0.95, 1.05), qq, 0.0004, dec), pn), lvl * fade * q.range(0.7, 1), secs(t, sr));
    }
  }
}

const VOWELS: [number, number, number][] = [[800, 1200, 2500], [500, 1900, 2600], [500, 900, 2400], [350, 2200, 2900]];
/** A group of voices on one vowel: detuned sawtooths with vibrato (and breath), through three formants. */
function voices(m: number, sr: number, r: Rng, count: number, f0: [number, number], vowel: [number, number, number], env: (i: number, v: number) => number, rise: number): Sig {
  const src = sig(m);
  for (let j = 0; j < count; j++) {
    const q = r.fork(j), f = q.range(f0[0], f0[1]), vr = q.range(4.5, 6.5), vd = q.range(0.008, 0.02), ph = q.next();
    const fr = sig(m).map((_, i) => f * (1 + rise * (i / m)) * (1 + vd * Math.sin(TAU * vr * (i / sr) + ph * TAU)));
    const tmp = sig(m);
    oscInto(tmp, sr, fr, "saw", 1, 1, q.next());
    add(tmp, white(m, q), 0.25);
    for (let i = 0; i < m; i++) src[i] += tmp[i] * env(i, j);
  }
  const y = sig(m);
  vowel.forEach((f, j) => add(y, svf(src, sr, "bpq", f, 7 + j * 2), (4 / (7 + j * 2)) * (j === 0 ? 1 : j === 1 ? 0.7 : 0.35)));
  return y;
}

function cheer(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), w = clamp(v.width, 0, 1), L = v.length, m = secs(L, sr), mix: Stereo = [sig(n), sig(n)];
  const env = adsr(m, sr, Math.min(1.2, L * 0.3), 0.8, 0.8, Math.min(1.3, L * 0.35));
  VOWELS.forEach((vw, g) => {
    const q = rng.fork(50 + g), onsets = Array.from({ length: 6 }, () => q.range(0, 0.5) * sr), offs = Array.from({ length: 6 }, () => m - q.range(0, 0.8) * sr);
    const y = voices(m, sr, q, 6, [150 * k, 380 * k], vw.map((f) => f * Math.min(1.25, b)) as [number, number, number], (i, j) => (i < onsets[j] || i > offs[j] ? 0 : env[i]), 0.12);
    addSt(mix, spread(y, sr, 0.5 + 0.5 * w), 0.6);
  });
  const ap: Stereo = [sig(n), sig(n)];
  applause(ap, sr, rng.fork(9), L, 18, b, w, 0.6);
  addSt(mix, ap, 0.6);
  return inSpace(mix, sr, v, HALL);
}

function murmur(v: Values, c: RenderCtx): Stereo {
  const { sr, rng } = c, b = bright(v), w = clamp(v.width, 0, 1), talkers = Math.round(val(v, "density", 12));
  return bed(c, (m) => {
    const st: Stereo = [sig(m), sig(m)];
    for (let g = 0; g < 2; g++) {
      const q = rng.fork(10 + g), count = Math.max(1, Math.round(talkers / 2));
      // each talker: syllables (3–6 a second) in phrases with pauses
      const envs = Array.from({ length: count }, (_, j) => {
        const r = q.fork(100 + j), e = sig(m), syl = wander(m, sr, r, r.range(3, 6));
        let on = r.chance(0.6), left = secs(r.range(0.5, 3), sr);
        for (let i = 0; i < m; i++) { if (left-- <= 0) { on = !on; left = secs(on ? r.range(1, 4) : r.range(0.4, 2), sr); } e[i] = on ? Math.max(0, syl[i]) : 0; }
        return lpEdge(e, sr).map((x) => x * x);
      });
      const vw = VOWELS[g * 2], wobble = wander(m, sr, q.fork(7), 0.5);
      const y = voices(m, sr, q, count, [95, 220], vw, (i, j) => envs[j][i], 0);
      const yy = svf(svf(y, sr, "lp", 2600 * b, 0.7), sr, "hp", 150);
      for (let i = 0; i < m; i++) yy[i] *= 1 + 0.15 * wobble[i];
      addSt(st, spread(yy, sr, 0.5 + 0.5 * w), 1, 0);
    }
    return st;
  });
}

export const CROWD: SfxDef[] = [
  {
    id: "crowd.applause", name: "Applause", category: "crowd", tags: ["applause"], stereo: true,
    params: [P.length(5, 1, 20), P.num("density", "People", 30, 4, 80, 1), P.brightness(), P.width(0.8), P.tail(0.3)],
    len: (v) => v.length + 0.05 + tailSeconds(v, ROOM),
    render: (v, c) => { const mix: Stereo = [sig(c.n), sig(c.n)]; applause(mix, c.sr, c.rng.fork(1), v.length, Math.round(v.density), bright(v), clamp(v.width, 0, 1)); return inSpace(mix, c.sr, v, ROOM); },
  },
  {
    id: "crowd.cheer", name: "Cheer swell (crowd-like)", category: "crowd", tags: ["applause"], stereo: true,
    params: [P.length(4, 1.5, 12), P.pitch(0, 5), P.brightness(), P.width(0.8), P.tail(0.35)],
    len: (v) => v.length + 0.05 + tailSeconds(v, HALL),
    render: cheer,
  },
  {
    id: "crowd.murmur", name: "Murmur bed (crowd-like)", category: "crowd", tags: [], stereo: true, loop: "wrap", overhang: 0,
    params: [P.length(8, 3, 30), P.num("density", "Talkers", 12, 2, 30, 1), P.brightness(), P.width(0.8)],
    len: (v) => v.length,
    render: murmur,
  },
];

