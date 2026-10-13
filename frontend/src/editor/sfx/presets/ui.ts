/**
 * Small sounds: pops and bubbles, interface clicks and chimes, keys and typing, camera mechanics, bells, ticks and
 * countdowns, cash and coins. Most are a few timed "notes" (a tone with a pitch bend and an envelope, an FM tone, a
 * bell made of decaying partials, or a burst of filtered noise). docs/EDITOR.md §15.1.
 */
import {
  add, addSt, burst, clamp, fitSt, fm, glide, modal, mul, osc, pan, perc, ping, scatter, secs, sig, spread, svf, swell, TAU, white,
  type FType, type Rng, type Sig, type Stereo, type Wave,
} from "../dsp.ts";
import type { RenderCtx, SfxDef, SfxTag, Values } from "../types.ts";
import { bright, HALL, inSpace, P, pk, PLATE, ROOM, STUDIO, tailSeconds, val, type Space } from "./common.ts";

// ── timed notes ─────────────────────────────────────────────────────────────────────────────────────────

/** A bell's partials: [ratio, amplitude, decay as a fraction of the note's decay]. */
type Partials = [number, number, number][];
export const BELL: Partials = [[1, 1, 1], [2.0, 0.45, 0.6], [3.01, 0.28, 0.42], [4.17, 0.18, 0.3], [5.43, 0.12, 0.22], [6.8, 0.07, 0.15]];
const MARIMBA: Partials = [[1, 1, 1], [3.93, 0.35, 0.3], [9.2, 0.12, 0.12]];

interface Note {
  t: number; f: number;
  /** Bend from f to f · bend over `bendTime` s. */
  bend?: number; bendTime?: number;
  decay: number; attack?: number; hold?: number; level?: number; pan?: number;
  wave?: Wave | "fm" | "bell" | "marimba";
  ratio?: number; index?: number; partials?: Partials;
}
interface Noise { t: number; fc: number; q: number; decay: number; level: number; type?: FType; attack?: number; pan?: number }
interface NotesO { notes: Note[]; noise?: Noise[]; lp?: number; space: Space; width?: number }

function noteSig(nt: Note, sr: number, k: number, b: number, rng: Rng): Sig {
  const a = nt.attack ?? 0.002, m = secs(a + (nt.hold ?? 0) + nt.decay * 1.1, sr) + 2;
  const f0 = nt.f * k, f = nt.bend && nt.bend !== 1 ? glide(m, f0, f0 * nt.bend, 0.7, sr, nt.bendTime ?? 0.03) : f0;
  const env = perc(m, sr, a, nt.decay, nt.hold ?? 0);
  if (nt.wave === "bell" || nt.wave === "marimba" || nt.partials) {
    const ps = nt.partials ?? (nt.wave === "marimba" ? MARIMBA : BELL);
    const y = modal(m, sr, f, ps.map(([r, amp, d]) => [r, amp * (r > 1.5 ? Math.min(1.6, b) : 1), Math.max(0.01, d * nt.decay)]), rng);
    return mul(y, perc(m, sr, a, nt.decay * 3, nt.hold ?? 0));
  }
  if (nt.wave === "fm") return mul(fm(m, sr, f, nt.ratio ?? 2, env.map((e) => (nt.index ?? 2) * b * e)), env);
  const y = osc(m, sr, f, nt.wave ?? "sine");
  return mul(nt.wave === "square" || nt.wave === "saw" ? svf(y, sr, "lp", 3500 * b, 0.7) : y, env);
}

function notes(o: NotesO, v: Values, c: RenderCtx, timeScale = 1): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), punch = clamp(val(v, "punch", 0.5), 0, 1), w = clamp(val(v, "width", o.width ?? 0.4), 0, 1);
  const mix: Stereo = [sig(n), sig(n)];
  for (const nt of o.notes) addSt(mix, pan(noteSig({ ...nt, t: nt.t * timeScale }, sr, k, b, rng), (nt.pan ?? 0) * w), nt.level ?? 1, secs(nt.t * timeScale, sr));
  for (const z of o.noise ?? []) {
    const x = burst(sr, rng, z.fc * b * (z.type === "bpq" ? k : 1), z.q, z.attack ?? 0.0004, z.decay, z.type ?? "bp");
    addSt(mix, pan(x, (z.pan ?? 0) * w), z.level * (0.4 + 1.2 * punch) * (z.type === "bpq" ? 3 / z.q : 1), secs(z.t * timeScale, sr));
  }
  let st = mix;
  if (o.lp) st = [svf(st[0], sr, "lp", o.lp * b), svf(st[1], sr, "lp", o.lp * b)];
  return inSpace(st, sr, v, o.space);
}

const notesLen = (o: NotesO, scale = 1) => {
  let end = 0;
  for (const nt of o.notes) end = Math.max(end, nt.t * scale + (nt.attack ?? 0.002) + (nt.hold ?? 0) + nt.decay * (nt.wave === "bell" || nt.wave === "marimba" ? 1.2 : 1.05));
  for (const z of o.noise ?? []) end = Math.max(end, z.t * scale + z.decay * 1.2);
  return end;
};

type Cat = "pop" | "ui" | "bell" | "tick" | "cash" | "camera" | "typing";
/** A notes preset: pitch, brightness, punch, tail (and a speed for the ones with several notes). */
const N = (id: string, name: string, cat: Cat, tags: SfxTag[], d: { tail?: number; punch?: number; brightness?: number; speed?: boolean }, o: NotesO): SfxDef => ({
  id, name, category: cat, tags, stereo: false,
  params: [P.pitch(), P.brightness(d.brightness ?? 0.5), P.punch(d.punch ?? 0.5), P.tail(d.tail ?? 0.2), ...(d.speed ? [P.num("speed", "Speed", 1, 0.5, 2, 0.05, "×")] : [])],
  len: (v) => notesLen(o, 1 / val(v, "speed", 1)) + tailSeconds(v, o.space),
  render: (v, c) => notes(o, v, c, 1 / val(v, "speed", 1)),
});

// ── pops and bubbles ────────────────────────────────────────────────────────────────────────────────────

function bubbles(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), L = Math.min(n, secs(v.length, sr)), dens = val(v, "density", 14), w = clamp(val(v, "width", 0.6), 0, 1);
  const mix: Stereo = [sig(n), sig(n)];
  const env = swell(L, 0.3, 0.8, 1.2);
  scatter(mix, sr, rng.fork(1), env.map((e) => 0.5 + dens * e), (r) => {
    const f = r.range(320, 1300) * k;
    return { x: ping(sr, f, r.range(0.035, 0.08), 0.002, r.range(1.6, 2.6) * Math.min(1.4, b), 0.05), gain: r.range(0.35, 1), pan: r.bi() * w };
  }, 0, L);
  return inSpace(mix, sr, v, ROOM);
}

export const POPS: SfxDef[] = [
  N("pop.mouth", "Mouth pop", "pop", ["pop"], { tail: 0.2 }, { notes: [{ t: 0, f: 280, bend: 3.2, bendTime: 0.03, decay: 0.09, attack: 0.001 }], noise: [{ t: 0, fc: 1200, q: 1, decay: 0.012, level: 0.25 }], space: ROOM }),
  N("pop.bubble", "Bubble", "pop", ["pop"], { tail: 0.2 }, { notes: [{ t: 0, f: 500, bend: 2.8, bendTime: 0.06, decay: 0.08, attack: 0.002 }], space: ROOM }),
  {
    id: "pop.bubbles", name: "Bubbles", category: "pop", tags: ["pop"], stereo: true,
    params: [P.length(1.5, 0.3, 8), P.num("density", "Bubbles per second", 14, 2, 40, 1, "/s"), P.pitch(), P.brightness(), P.width(0.6), P.tail(0.2)],
    len: (v) => v.length + 0.12 + tailSeconds(v, ROOM),
    render: bubbles,
  },
  N("pop.cork", "Cork pop", "pop", ["pop"], { tail: 0.3, punch: 0.6 }, {
    notes: [{ t: 0.002, f: 540, bend: 0.85, bendTime: 0.05, decay: 0.09 }, { t: 0, f: 180, bend: 1.4, decay: 0.05, level: 0.4 }],
    noise: [{ t: 0, fc: 900, q: 2, decay: 0.025, level: 0.7 }], space: ROOM,
  }),
  N("pop.soft", "Soft pop", "pop", ["pop"], { tail: 0.15, punch: 0.3 }, { notes: [{ t: 0, f: 160, bend: 2.1, bendTime: 0.04, decay: 0.12, attack: 0.004 }], noise: [{ t: 0, fc: 400, q: 0.8, decay: 0.02, level: 0.3, type: "lp" }], space: ROOM }),
  N("pop.cartoon", "Cartoon pop", "pop", ["pop"], { tail: 0.25 }, { notes: [{ t: 0, f: 600, bend: 2.5, bendTime: 0.05, decay: 0.16, wave: "fm", ratio: 2, index: 2.2 }, { t: 0.04, f: 1800, decay: 0.12, wave: "bell", level: 0.25 }], space: ROOM }),
  N("pop.balloon", "Balloon pop", "pop", ["pop"], { tail: 0.45, punch: 0.75 }, { notes: [{ t: 0, f: 110, bend: 0.7, decay: 0.05, level: 0.5 }], noise: [{ t: 0, fc: 300, q: 0.7, decay: 0.09, level: 1, type: "hp" }, { t: 0, fc: 2600, q: 0.8, decay: 0.02, level: 0.6 }], space: ROOM }),
  N("pop.bloop", "Bloop", "pop", ["pop"], { tail: 0.25 }, { notes: [{ t: 0, f: 900, bend: 0.25, bendTime: 0.12, decay: 0.18, attack: 0.003 }], space: ROOM }),
];

// ── clicks and interface sounds ─────────────────────────────────────────────────────────────────────────

const click = (t: number, fc: number, level = 1, pn = 0): Noise[] => [
  { t, fc: fc * 1.9, q: 0.7, decay: 0.004, level: 0.5 * level, type: "hp", pan: pn },
  { t, fc, q: 5, decay: 0.05, level: 0.9 * level, type: "bpq", pan: pn },
];

export const UI: SfxDef[] = [
  N("ui.click", "Click", "ui", ["click"], { tail: 0.25, punch: 0.6 }, { notes: [{ t: 0, f: 1400, decay: 0.03, level: 0.25 }], noise: click(0, 3200), space: STUDIO }),
  N("ui.tap", "Tap", "ui", ["click"], { tail: 0.2, punch: 0.4, brightness: 0.4 }, { notes: [{ t: 0, f: 900, bend: 0.9, decay: 0.06, attack: 0.001 }], noise: [{ t: 0, fc: 1800, q: 1, decay: 0.012, level: 0.5 }], space: STUDIO }),
  N("ui.toggle_on", "Toggle on", "ui", ["click"], { tail: 0.2, speed: true }, { notes: [{ t: 0, f: 1300, decay: 0.03, level: 0.25 }, { t: 0.065, f: 1750, decay: 0.035, level: 0.3 }], noise: [...click(0, 2600, 0.8), ...click(0.065, 3400)], space: STUDIO }),
  N("ui.toggle_off", "Toggle off", "ui", ["click"], { tail: 0.2, speed: true }, { notes: [{ t: 0, f: 1750, decay: 0.03, level: 0.25 }, { t: 0.065, f: 1300, decay: 0.035, level: 0.3 }], noise: [...click(0, 3400, 0.8), ...click(0.065, 2600)], space: STUDIO }),
  {
    id: "ui.swipe", name: "Swipe", category: "ui", tags: ["swish"], stereo: true,
    params: [P.length(0.18, 0.08, 0.8), P.pitch(), P.brightness(0.55), P.width(0.6), P.tail(0.15)],
    len: (v) => v.length + tailSeconds(v, STUDIO),
    render: (v, c) => {
      const { sr, rng, n } = c, nb = Math.max(16, secs(v.length, sr)), e = swell(nb, 0.45, 1.3, 1.8), k = pk(v) * bright(v), w = clamp(v.width, 0, 1);
      const y = mul(svf(white(nb, rng.fork(1)), sr, "bp", glide(nb, 1500 * k, 5500 * k, 1), 1.3), e);
      const p = sig(nb).map((_, i) => (-0.7 + 1.4 * (i / nb)) * w);
      return inSpace(fitSt(pan(y, p), n), sr, v, STUDIO);
    },
  },
  N("ui.success", "Success", "ui", ["ding"], { tail: 0.35, speed: true }, { notes: [{ t: 0, f: 1046.5, decay: 0.45, wave: "marimba", level: 0.8 }, { t: 0.1, f: 1568, decay: 0.6, wave: "marimba" }], space: PLATE }),
  N("ui.error", "Error", "ui", [], { tail: 0.2, speed: true, brightness: 0.45 }, { notes: [{ t: 0, f: 330, decay: 0.16, hold: 0.06, wave: "square", attack: 0.004 }, { t: 0.15, f: 247, decay: 0.22, hold: 0.08, wave: "square", attack: 0.004 }], space: STUDIO }),
  N("ui.notification", "Notification", "ui", ["ding"], { tail: 0.35, speed: true }, { notes: [{ t: 0, f: 1318.5, decay: 0.7, wave: "bell" }, { t: 0.13, f: 1046.5, decay: 0.9, wave: "bell", level: 0.9 }], space: PLATE }),
  N("ui.hover", "Hover tick", "ui", ["click"], { tail: 0.3, punch: 0.5, brightness: 0.55 }, { notes: [{ t: 0, f: 2400, decay: 0.035, level: 0.35 }], noise: click(0, 5200, 0.8), space: STUDIO }),
  N("ui.select", "Select", "ui", ["click"], { tail: 0.2, speed: true }, { notes: [{ t: 0.012, f: 1200, bend: 1.5, bendTime: 0.04, decay: 0.08, attack: 0.002 }], noise: click(0, 3000), space: STUDIO }),
  N("ui.back", "Back", "ui", ["click"], { tail: 0.2, speed: true }, { notes: [{ t: 0.012, f: 1500, bend: 0.6, bendTime: 0.05, decay: 0.09, attack: 0.002 }], noise: click(0, 2500), space: STUDIO }),
  N("ui.message", "Message pop", "ui", ["pop", "ding"], { tail: 0.3, speed: true }, { notes: [{ t: 0, f: 480, bend: 2.6, bendTime: 0.05, decay: 0.09 }, { t: 0.06, f: 1760, decay: 0.4, wave: "bell", level: 0.5 }], space: PLATE }),
];

// ── keys and typing ─────────────────────────────────────────────────────────────────────────────────────

type KeyKind = "key" | "space" | "typewriter" | "return";
/** One key: the press click, the switch's ring, the bottom-out thock and the release (a typewriter: a strike, the
 *  type bar's ring and the carriage thunk). */
function key(r: Rng, sr: number, k: number, b: number, kind: KeyKind): Sig {
  const m = secs(0.2, sr), y = sig(m);
  if (kind === "typewriter") {
    add(y, burst(sr, r, 2600 * b, 0.8, 0.0003, 0.006, "hp"), 0.9);
    add(y, modal(secs(0.12, sr), sr, r.range(1700, 1950) * k, [[1, 0.6, 0.09], [1.61, 0.4, 0.06], [2.29, 0.3, 0.05]], r), 0.45);
    add(y, ping(sr, r.range(150, 175) * k, 0.06, 0.001), 0.6);
    add(y, burst(sr, r, 900 * b, 1.2, 0.001, 0.03), 0.4, secs(0.004, sr));
    return y;
  }
  const big = kind === "space" || kind === "return";
  add(y, burst(sr, r, 3800 * b, 0.7, 0.0003, 0.004, "hp"), 0.6);
  add(y, burst(sr, r, r.range(2300, 3300) * k * b, 5, 0.0004, 0.018, "bpq"), 0.25);
  add(y, burst(sr, r, (big ? 320 : r.range(450, 680)) * k, 1.5, 0.001, big ? 0.045 : 0.03), big ? 1.1 : 0.8, secs(0.003, sr));
  add(y, ping(sr, (big ? 150 : r.range(190, 240)) * k, big ? 0.04 : 0.025, 0.001), 0.5, secs(0.003, sr));
  if (big) add(y, burst(sr, r, 1800 * b, 1.2, 0.0005, 0.01), 0.35, secs(0.012, sr));
  const rel = secs(r.range(0.06, 0.09), sr);
  add(y, burst(sr, r, 3400 * b, 0.8, 0.0003, 0.003, "hp"), 0.22, rel);
  add(y, burst(sr, r, 600 * k, 1.5, 0.001, 0.015), 0.25, rel);
  return y;
}

function typingBurst(v: Values, c: RenderCtx, typewriter: boolean): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), L = v.length, cps = clamp(val(v, "cps", 8), 1, 20), w = clamp(val(v, "width", 0.4), 0, 1);
  const mix: Stereo = [sig(n), sig(n)], r = rng.fork(1);
  let t = 0.01, inWord = r.int(2, 7), words = 0;
  while (t < L - 0.05) {
    const space = inWord <= 0;
    const kind: KeyKind = typewriter ? "typewriter" : space ? "space" : "key";
    const x = key(r, sr, k * (space && typewriter ? 0.8 : 1), b, kind);
    addSt(mix, pan(x, r.range(-0.5, 0.5) * w), (space ? 0.9 : 1) * r.range(0.7, 1), secs(t, sr));
    if (space) { inWord = r.int(2, 8); words++; } else inWord--;
    let dt = (1 / cps) * r.range(0.6, 1.45);
    if (space && words % r.int(4, 7) === 0) dt += r.range(0.15, 0.4);
    t += dt;
  }
  return inSpace(mix, sr, v, STUDIO);
}

function carriageReturn(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), mix: Stereo = [sig(n), sig(n)], r = rng.fork(1), s = 1 / val(v, "speed", 1);
  const L = 0.45 * s;
  for (let j = 0, t = 0; t < L; j++) {
    addSt(mix, burst(sr, r, (2200 + 900 * (t / L)) * k * b, 4, 0.0003, 0.012, "bpq"), 0.25, secs(t, sr));
    t += Math.max(0.018, 0.05 * Math.pow(1 - t / L, 1.3)) * s * r.range(0.85, 1.15);
  }
  const m = secs(L, sr), slide = mul(svf(white(m, r), sr, "bp", glide(m, 800 * b, 2200 * b), 1.5), swell(m, 0.6, 1, 1));
  addSt(mix, slide, 0.25);
  addSt(mix, key(r, sr, k * 0.8, b, "typewriter"), 0.9, secs(L, sr));
  addSt(mix, modal(secs(1.3, sr), sr, 2093 * k, BELL.map(([q, a, d]) => [q, a, d * 1.2] as [number, number, number]), r), 0.55, secs(L + 0.03, sr));
  return inSpace(mix, sr, v, STUDIO);
}

const KEY_PARAMS = () => [P.pitch(), P.brightness(), P.tail(0.2)];
export const TYPING: SfxDef[] = [
  {
    id: "typing.key", name: "Single key", category: "typing", tags: ["typing", "click"], stereo: false, params: KEY_PARAMS(),
    len: (v) => 0.2 + tailSeconds(v, STUDIO),
    render: (v, c) => inSpace(fitSt(pan(key(c.rng.fork(1), c.sr, pk(v), bright(v), "key"), 0), c.n), c.sr, v, STUDIO),
  },
  {
    id: "typing.burst", name: "Typing burst", category: "typing", tags: ["typing"], stereo: true,
    params: [P.length(3, 0.5, 20), P.num("cps", "Characters per second", 8, 2, 16, 0.5, "/s"), P.pitch(), P.brightness(), P.width(0.4), P.tail(0.15)],
    len: (v) => v.length + 0.2 + tailSeconds(v, STUDIO),
    render: (v, c) => typingBurst(v, c, false),
  },
  {
    id: "typing.typewriter_key", name: "Typewriter key", category: "typing", tags: ["typing"], stereo: false, params: KEY_PARAMS(),
    len: (v) => 0.2 + tailSeconds(v, STUDIO),
    render: (v, c) => inSpace(fitSt(pan(key(c.rng.fork(1), c.sr, pk(v), bright(v), "typewriter"), 0), c.n), c.sr, v, STUDIO),
  },
  {
    id: "typing.typewriter", name: "Typewriter burst", category: "typing", tags: ["typing"], stereo: true,
    params: [P.length(3, 0.5, 20), P.num("cps", "Characters per second", 6, 2, 12, 0.5, "/s"), P.pitch(), P.brightness(), P.width(0.3), P.tail(0.2)],
    len: (v) => v.length + 0.2 + tailSeconds(v, STUDIO),
    render: (v, c) => typingBurst(v, c, true),
  },
  {
    id: "typing.carriage_return", name: "Carriage return", category: "typing", tags: ["typing", "ding"], stereo: false,
    params: [P.pitch(), P.brightness(), P.num("speed", "Speed", 1, 0.5, 2, 0.05, "×"), P.tail(0.2)],
    len: (v) => 0.45 / val(v, "speed", 1) + 1.35 + tailSeconds(v, STUDIO),
    render: carriageReturn,
  },
];

// ── camera ──────────────────────────────────────────────────────────────────────────────────────────────

/** A shutter: mirror slap, curtain, mirror return. */
function shutter(mix: Stereo, sr: number, r: Rng, at: number, k: number, b: number, level = 1) {
  const o = secs(at, sr);
  addSt(mix, burst(sr, r, 320 * k, 1.1, 0.001, 0.035), 0.9 * level, o);
  addSt(mix, burst(sr, r, 4200 * b, 0.7, 0.0003, 0.005, "hp"), 0.55 * level, o);
  addSt(mix, burst(sr, r, 3000 * k * b, 3, 0.0004, 0.014, "bpq"), 0.3 * level, o + secs(0.055, sr));
  addSt(mix, burst(sr, r, 2000 * b, 1, 0.002, 0.06), 0.25 * level, o + secs(0.01, sr));
  addSt(mix, burst(sr, r, 450 * k, 1.2, 0.001, 0.03), 0.55 * level, o + secs(0.11, sr));
  addSt(mix, burst(sr, r, 3600 * b, 0.7, 0.0003, 0.004, "hp"), 0.3 * level, o + secs(0.11, sr));
}

export const CAMERA: SfxDef[] = [
  {
    id: "camera.shutter", name: "Shutter", category: "camera", tags: ["shutter"], stereo: false, params: [P.pitch(), P.brightness(), P.tail(0.2)],
    len: (v) => 0.25 + tailSeconds(v, STUDIO),
    render: (v, c) => { const mix: Stereo = [sig(c.n), sig(c.n)]; shutter(mix, c.sr, c.rng.fork(1), 0, pk(v), bright(v)); return inSpace(mix, c.sr, v, STUDIO); },
  },
  {
    id: "camera.burst", name: "Shutter burst", category: "camera", tags: ["shutter"], stereo: false,
    params: [P.num("count", "Shots", 5, 2, 20), P.num("rate", "Shots per second", 8, 2, 14, 0.5, "/s"), P.pitch(), P.brightness(), P.tail(0.2)],
    len: (v) => (Math.round(v.count) - 1) / v.rate + 0.25 + tailSeconds(v, STUDIO),
    render: (v, c) => {
      const mix: Stereo = [sig(c.n), sig(c.n)], r = c.rng.fork(1);
      for (let j = 0; j < Math.round(v.count); j++) shutter(mix, c.sr, r, j / v.rate, pk(v) * r.range(0.97, 1.03), bright(v), r.range(0.85, 1));
      return inSpace(mix, c.sr, v, STUDIO);
    },
  },
  {
    id: "camera.film_wind", name: "Film wind", category: "camera", tags: [], stereo: false, params: [P.length(0.7, 0.3, 3), P.pitch(), P.brightness(), P.tail(0.15)],
    len: (v) => v.length + 0.1 + tailSeconds(v, STUDIO),
    render: (v, c) => {
      const { sr, n } = c, r = c.rng.fork(1), k = pk(v), b = bright(v), L = v.length, m = secs(L, sr), mix: Stereo = [sig(n), sig(n)];
      for (let t = 0; t < L; t += (1 / 34) * r.range(0.9, 1.1)) addSt(mix, burst(sr, r, 2500 * k * b, 4, 0.0003, 0.01, "bpq"), 0.35 * r.range(0.7, 1), secs(t, sr));
      const motor = svf(osc(m, sr, 140 * k, "saw"), sr, "bp", 900 * b, 2);
      for (let i = 0; i < m; i++) motor[i] *= 0.6 + 0.4 * Math.sin((TAU * 35 * i) / sr);
      addSt(mix, mul(motor, swell(m, 0.2, 0.6, 0.8)), 0.5);
      return inSpace(mix, sr, v, STUDIO);
    },
  },
  {
    id: "camera.flash_charge", name: "Flash charge", category: "camera", tags: [], stereo: false, params: [P.length(1.6, 0.4, 5), P.pitch(), P.brightness(), P.tail(0.2)],
    len: (v) => v.length + 0.25 + tailSeconds(v, STUDIO),
    render: (v, c) => {
      const { sr, n } = c, r = c.rng.fork(1), k = pk(v), b = bright(v), m = secs(v.length, sr), mix: Stereo = [sig(n), sig(n)];
      const f = glide(m, 900 * k, 6800 * k, 0.55), whine = osc(m, sr, f);
      add(whine, osc(m, sr, f.map((x) => x * 2)), 0.12 * b);
      const e = sig(m).map((_, i) => (0.35 + 0.65 * (i / m)) * Math.min(1, i / (0.02 * sr)) * Math.min(1, (m - i) / (0.01 * sr)));
      addSt(mix, mul(whine, e), 0.6);
      addSt(mix, mul(svf(white(m, r), sr, "hp", 5000), e), 0.04);
      const at = secs(v.length + 0.05, sr);
      addSt(mix, burst(sr, r, 1800 * b, 0.8, 0.0003, 0.02), 1, at);
      addSt(mix, ping(sr, 140 * k, 0.05), 0.6, at);
      return inSpace(mix, sr, v, STUDIO);
    },
  },
];

// ── bells ───────────────────────────────────────────────────────────────────────────────────────────────

interface BellO { f0: number; partials: Partials; strike?: number; beat?: number; arp?: number[]; gap?: number; space: Space }
function bell(o: BellO, v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), w = clamp(val(v, "width", 0.5), 0, 1), D = v.length, mix: Stereo = [sig(n), sig(n)];
  const ps = (beat: number): [number, number, number][] => o.partials.map(([r, a, d]) => [r + beat / o.f0, a * (r > 1.5 ? Math.min(1.8, b) : 1), Math.max(0.02, d * D)]);
  (o.arp ?? [0]).forEach((st, j) => {
    const f = o.f0 * k * Math.pow(2, st / 12), at = secs(j * (o.gap ?? 0.05), sr), m = n - at;
    if (m <= 0) return;
    // the same partial phases on both sides; the right one is detuned by `beat`, so the two drift apart into a shimmer
    const L = modal(m, sr, f, ps(0), rng.fork(j * 2 + 1)), R = modal(m, sr, f, ps(o.beat ?? 0), rng.fork(j * 2 + 1));
    for (let i = 0; i < m; i++) R[i] = (1 - w) * L[i] + w * R[i];
    const p = o.arp ? (j % 2 ? 1 : -1) * 0.5 * w : 0, th = ((p + 1) * Math.PI) / 4;
    add(mix[0], L, Math.cos(th) * Math.SQRT2, at);
    add(mix[1], R, Math.sin(th) * Math.SQRT2, at);
    if (o.strike) addSt(mix, burst(sr, rng, 4000 * b, 0.8, 0.0003, 0.006, "hp"), o.strike, at);
  });
  return inSpace(mix, sr, v, o.space);
}
const BL = (id: string, name: string, d: { length: number; tail?: number }, o: BellO): SfxDef => ({
  id, name, category: "bell", tags: ["ding"], stereo: true,
  params: [P.length(d.length, 0.2, 8, "Ring"), P.pitch(), P.brightness(), P.width(0.5), P.tail(d.tail ?? 0.3)],
  len: (v) => v.length * 1.05 + (o.arp ? (o.arp.length - 1) * (o.gap ?? 0.05) : 0) + 0.02 + tailSeconds(v, o.space),
  render: (v, c) => bell(o, v, c),
});

export const BELLS: SfxDef[] = [
  BL("bell.ding", "Ding", { length: 1.2 }, { f0: 1318.5, partials: BELL, strike: 0.2, beat: 1.2, space: PLATE }),
  BL("bell.chime", "Chime", { length: 2.2 }, { f0: 880, partials: [[1, 1, 1], [2.756, 0.5, 0.55], [5.404, 0.3, 0.32], [8.933, 0.18, 0.2], [13.34, 0.08, 0.12]], strike: 0.15, beat: 0.8, space: PLATE }),
  BL("bell.service", "Service bell", { length: 1.8 }, { f0: 2650, partials: [[1, 1, 1], [2.32, 0.4, 0.5], [4.25, 0.25, 0.3], [6.63, 0.12, 0.18]], strike: 0.35, beat: 2.5, space: ROOM }),
  BL("bell.glass", "Glass ting-like", { length: 0.9 }, { f0: 2200, partials: [[1, 1, 1], [2.61, 0.3, 0.45], [5.12, 0.12, 0.25]], strike: 0.12, beat: 1.5, space: ROOM }),
  BL("bell.large", "Large bell-like", { length: 5, tail: 0.4 }, { f0: 196, partials: [[0.5, 0.7, 1.4], [1, 1, 1], [1.183, 0.6, 0.8], [1.506, 0.45, 0.6], [2, 0.5, 0.5], [2.514, 0.3, 0.35], [2.662, 0.25, 0.3], [3.011, 0.2, 0.25], [4.166, 0.12, 0.18]], strike: 0.25, beat: 0.6, space: HALL }),
  BL("bell.sparkle", "Sparkle chime", { length: 1.1 }, { f0: 1760, partials: [[1, 1, 1], [2.0, 0.3, 0.5], [3.0, 0.15, 0.3]], arp: [0, 2, 4, 7, 9, 12, 14], gap: 0.045, beat: 2, space: PLATE }),
];

// ── ticks and countdowns ────────────────────────────────────────────────────────────────────────────────

const wood = (sr: number, r: Rng, f: number, k: number, b: number): Sig => {
  const y = burst(sr, r, f * k * b, 8, 0.0003, 0.02, "bpq");
  mul(y, 0.4);
  add(y, modal(secs(0.08, sr), sr, f * 0.48 * k, [[1, 0.7, 0.04], [2.31, 0.3, 0.025]], r), 0.6);
  add(y, burst(sr, r, 5000 * b, 0.7, 0.0002, 0.003, "hp"), 0.5);
  return y;
};

/** A loop of ticks on a beat grid (seconds = whole beats). */
function tickLoop(v: Values, c: RenderCtx, fast: boolean): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), period = 60 / val(v, "bpm", fast ? 240 : 60), beats = Math.max(2, Math.round((c.loopN ?? n) / sr / period)), mix: Stereo = [sig(n), sig(n)], r = rng.fork(1);
  for (let j = 0; j < beats; j++) {
    const t = j * period;
    const hi = j % 2 === 0;
    addSt(mix, wood(sr, r, (hi ? 2600 : 1750) * (fast ? 1.15 : 1), k, b), hi ? 1 : 0.85, secs(t, sr));
  }
  return inSpace(mix, sr, v, STUDIO);
}
/** A loop of whole beats, an even number of them (tick, tock). */
const loopBeats = (v: Values, bpm: number) => { const p = 60 / val(v, "bpm", bpm); return Math.max(2, 2 * Math.round(v.length / p / 2)) * p; };

const beep = (t: number, f: number, len: number, level = 1): Note => ({ t, f, decay: 0.025, attack: 0.004, hold: len, level, wave: "sine" });
function countdown(v: Values, c: RenderCtx): Stereo {
  const gap = val(v, "interval", 1), cnt = Math.round(val(v, "count", 3));
  const ns: Note[] = [];
  for (let j = 0; j < cnt; j++) ns.push(beep(j * gap, 1000, 0.12));
  ns.push(beep(cnt * gap, 2000, 0.55));
  return notes({ notes: ns, space: STUDIO }, v, c);
}

export const TICKS: SfxDef[] = [
  {
    id: "tick.clock", name: "Clock tick", category: "tick", tags: ["tick"], stereo: false, params: [P.pitch(), P.brightness(), P.tail(0.25)],
    len: (v) => 0.12 + tailSeconds(v, STUDIO),
    render: (v, c) => inSpace(fitSt(pan(wood(c.sr, c.rng.fork(1), 2600, pk(v), bright(v)), 0), c.n), c.sr, v, STUDIO),
  },
  {
    id: "tick.tock_loop", name: "Tick-tock loop", category: "tick", tags: ["tick"], stereo: false, loop: "wrap",
    params: [P.length(4, 1, 30), P.num("bpm", "Ticks per minute", 60, 30, 240, 1, "bpm"), P.pitch(), P.brightness(), P.tail(0.15)],
    len: (v) => loopBeats(v, 60),
    render: (v, c) => tickLoop(v, c, false),
  },
  N("tick.beep", "Countdown beep", "tick", ["countdown"], { tail: 0.1 }, { notes: [beep(0, 1000, 0.15)], space: STUDIO }),
  N("tick.final_beep", "Final beep", "tick", ["countdown"], { tail: 0.15 }, { notes: [beep(0, 2000, 0.6)], space: STUDIO }),
  {
    id: "tick.countdown", name: "Countdown 3-2-1", category: "tick", tags: ["countdown", "tick"], stereo: false,
    params: [P.num("count", "Beeps", 3, 1, 10), P.num("interval", "Interval", 1, 0.25, 2, 0.05, "s"), P.pitch(), P.tail(0.1)],
    len: (v) => Math.round(v.count) * v.interval + 0.6 + 0.05 + tailSeconds(v, STUDIO),
    render: countdown,
  },
  {
    id: "tick.timer", name: "Suspense timer", category: "tick", tags: ["tick"], stereo: false, loop: "wrap",
    params: [P.length(4, 1, 30), P.num("bpm", "Ticks per minute", 240, 60, 480, 1, "bpm"), P.pitch(), P.brightness(), P.tail(0.1)],
    len: (v) => loopBeats(v, 240),
    render: (v, c) => tickLoop(v, c, true),
  },
];

// ── cash and coins ──────────────────────────────────────────────────────────────────────────────────────

const coinPing = (sr: number, r: Rng, f: number, decay: number): Sig => modal(secs(decay * 1.2, sr), sr, f, [[1, 1, decay], [1.62, 0.5, decay * 0.7], [2.31, 0.3, decay * 0.5]], r);

export const CASH: SfxDef[] = [
  {
    id: "cash.register", name: "Cash register-like", category: "cash", tags: ["cash", "ding"], stereo: true, params: [P.pitch(), P.brightness(), P.width(0.5), P.tail(0.3)],
    len: (v) => 1.5 + tailSeconds(v, ROOM),
    render: (v, c) => {
      const { sr, n } = c, r = c.rng.fork(1), k = pk(v), b = bright(v), w = clamp(v.width, 0, 1), mix: Stereo = [sig(n), sig(n)];
      addSt(mix, burst(sr, r, 2600 * b, 3, 0.0003, 0.012, "bpq"), 0.35, 0);
      addSt(mix, burst(sr, r, 380 * k, 1.2, 0.001, 0.04), 0.8, secs(0.01, sr));
      const m = secs(0.18, sr);
      addSt(mix, spread(mul(svf(white(m, r), sr, "bp", glide(m, 700 * b, 1500 * b), 1.2), swell(m, 0.3, 1, 1)), sr, w), 0.3, secs(0.02, sr));
      for (let j = 0; j < 6; j++) addSt(mix, pan(coinPing(sr, r, r.range(3500, 6000) * k, r.range(0.08, 0.16)), r.bi() * w), 0.25, secs(0.05 + j * 0.022, sr));
      addSt(mix, pan(modal(secs(1.4, sr), sr, 2093 * k, BELL.map(([q, a, d]) => [q, a, d * 1.1] as [number, number, number]), r), -0.3 * w), 0.6, secs(0.13, sr));
      addSt(mix, pan(modal(secs(1.2, sr), sr, 2637 * k, BELL, r), 0.3 * w), 0.45, secs(0.135, sr));
      return inSpace(mix, sr, v, ROOM);
    },
  },
  {
    id: "cash.coin", name: "Coin drop", category: "cash", tags: ["cash"], stereo: false, params: [P.pitch(), P.brightness(), P.num("bounces", "Bounces", 8, 1, 16), P.tail(0.25)],
    len: (v) => 1.0 + tailSeconds(v, ROOM),
    render: (v, c) => {
      const { sr, n } = c, r = c.rng.fork(1), k = pk(v), mix: Stereo = [sig(n), sig(n)];
      let t = 0, gap = 0.2, g = 1;
      for (let j = 0; j < Math.round(v.bounces); j++) {
        addSt(mix, coinPing(sr, r, r.range(3900, 4300) * k * Math.min(1.3, bright(v)), 0.25 * g + 0.05), g, secs(t, sr));
        t += gap; gap *= r.range(0.68, 0.76); g *= 0.78;
      }
      return inSpace(mix, sr, v, ROOM);
    },
  },
  {
    id: "cash.coins", name: "Coins pour", category: "cash", tags: ["cash"], stereo: true,
    params: [P.length(1.5, 0.4, 6), P.num("density", "Coins per second", 35, 5, 90, 1, "/s"), P.pitch(), P.brightness(), P.width(0.6), P.tail(0.25)],
    len: (v) => v.length + 0.25 + tailSeconds(v, ROOM),
    render: (v, c) => {
      const { sr, n } = c, L = secs(v.length, sr), k = pk(v), b = bright(v), w = clamp(v.width, 0, 1), mix: Stereo = [sig(n), sig(n)], e = swell(L, 0.25, 0.7, 1.4);
      scatter(mix, sr, c.rng.fork(1), e.map((x) => 1 + v.density * x), (r) => ({ x: coinPing(sr, r, r.range(3000, 6500) * k * Math.min(1.3, b), r.range(0.06, 0.2)), gain: r.range(0.25, 1), pan: r.bi() * w }), 0, L);
      return inSpace(mix, sr, v, ROOM);
    },
  },
];
