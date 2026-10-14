/**
 * Hits: impacts and booms (a pitch-dropping body, a noise crack, a low-passed thump, inharmonic metal, a noise wash,
 * a chord stab, debris), sub drops, braams (detuned saw stacks through a brassy filter), drums and stabs, claps, and
 * the reversed sounds built from them. docs/EDITOR.md §15.1.
 */
import {
  add, addSt, adsr, bpf, burst, clamp, drive, echo, eq, fades, fitSt, glide, modal, mono, mul, mulSt, noise, osc, oscInto, perc, reverb, reverseSt,
  scatter, secs, sig, spread, stack, svf, white, type NoiseColor, type Stereo,
} from "../dsp.ts";
import type { RenderCtx, SfxDef, SfxTag, Values } from "../types.ts";
import { bright, HALL, HUGE, inSpace, P, pk, PLATE, ROOM, STUDIO, tailSeconds, val, type Space } from "./common.ts";

// ── impact ──────────────────────────────────────────────────────────────────────────────────────────────

interface ImpactO {
  /** The decay (s) the `length` param scales from. */
  nominal: number;
  body?: { f0: number; f1: number; glide: number; decay: number; level: number; drive?: number; harm?: number };
  crack?: { level: number; hp: number; decay: number; bp?: number };
  thump?: { level: number; lp: number; decay: number; color?: NoiseColor; lpEnd?: number };
  metal?: { f0: number; ratios: number[]; decay: number; level: number; square?: boolean; hp?: number };
  wash?: { level: number; hp?: number; lp?: number; decay: number };
  stab?: { f0: number; chord: number[]; decay: number; level: number; cutoff?: number };
  debris?: { rate: number; decay: number; level: number };
  lp?: number;
  echo?: { time: number; fb: number; mix: number };
  space: Space;
}

function impact(o: ImpactO, v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, s = Math.max(0.05, v.length / o.nominal), k = pk(v), b = bright(v), punch = clamp(val(v, "punch", 0.5), 0, 1);
  const w = clamp(val(v, "width", 0.6), 0, 1);
  const mix: Stereo = [sig(n), sig(n)];
  if (o.body) {
    const bd = o.body, f = glide(n, bd.f0 * k, bd.f1 * k, 0.55, sr, bd.glide * Math.sqrt(s));
    let y = mul(osc(n, sr, f), perc(n, sr, 0.004 - 0.003 * punch, bd.decay * s));
    if (bd.harm) add(y, mul(osc(n, sr, f.map((x) => x * 2)), perc(n, sr, 0.002, bd.decay * s * 0.5)), bd.harm);
    if (bd.drive) y = drive(y, bd.drive);
    addSt(mix, y, bd.level);
  }
  if (o.crack) {
    const cr = o.crack, m = secs(cr.decay * 1.3 + 0.002, sr);
    const z = white(m, rng.fork(2));
    const y = mul(cr.bp ? svf(z, sr, "bp", cr.bp * b, 0.9) : svf(z, sr, "hp", cr.hp * b, 0.7), perc(m, sr, 0.0004, cr.decay));
    addSt(mix, spread(y, sr, 0.3 * w), cr.level * (0.35 + 1.3 * punch));
  }
  if (o.thump) {
    const th = o.thump, z = noise(th.color ?? "pink", n, rng.fork(3));
    const cut = th.lpEnd ? glide(n, th.lp * b, th.lpEnd * b, 0.6, sr, th.decay * s) : th.lp * b;
    addSt(mix, spread(mul(svf(svf(z, sr, "lp", cut, 0.7), sr, "lp", cut, 0.7), perc(n, sr, 0.002, th.decay * s)), sr, 0.4 * w), th.level);
  }
  if (o.metal) {
    const me = o.metal;
    let y: Float64Array;
    if (me.square) {
      y = sig(n);
      me.ratios.forEach((r) => oscInto(y, sr, me.f0 * k * r, "square", 1 / me.ratios.length, 1, rng.next()));
      y = mul(svf(svf(y, sr, "hp", (me.hp ?? 6000) * b, 0.7), sr, "bp", 9000 * b, 0.6), perc(n, sr, 0.001, me.decay * s));
    } else y = modal(n, sr, me.f0 * k, me.ratios.map((r, j) => [r, 1 / (1 + j * 0.5), me.decay * s * Math.max(0.15, 1 - j * 0.09)]), rng.fork(4));
    addSt(mix, spread(y, sr, 0.3 + 0.6 * w), me.level);
  }
  if (o.wash) {
    const wa = o.wash;
    let y = white(n, rng.fork(5));
    if (wa.hp) y = svf(y, sr, "hp", wa.hp * b, 0.7);
    if (wa.lp) y = svf(y, sr, "lp", wa.lp * b, 0.7);
    addSt(mix, spread(mul(y, perc(n, sr, 0.002, wa.decay * s)), sr, 0.5 + 0.5 * w), wa.level);
  }
  if (o.stab) {
    const sb = o.stab, sm: Stereo = [sig(n), sig(n)];
    sb.chord.forEach((iv, j) => addSt(sm, stack(n, sr, sb.f0 * k * Math.pow(2, iv / 12), 5, 16, rng.fork(20 + j), 0.5 + 0.4 * w), 1 / Math.sqrt(sb.chord.length)));
    const cut = glide(n, (sb.cutoff ?? 4000) * b, 350 * b, 0.5, sr, sb.decay * s);
    const e = perc(n, sr, 0.004, sb.decay * s);
    addSt(mix, [mul(svf(sm[0], sr, "lp", cut, 1.1), e), mul(svf(sm[1], sr, "lp", cut, 1.1), e)], sb.level);
  }
  if (o.debris) {
    const de = o.debris, end = Math.min(n, secs(de.decay * s, sr));
    const rate = sig(n).map((_, i) => (i < end ? de.rate * Math.pow(1 - i / end, 1.5) : 0.001));
    scatter(mix, sr, rng.fork(6), rate, (r) => ({ x: burst(sr, r, r.range(900, 4500) * b, 1.2, 0.0005, r.range(0.004, 0.02)), gain: de.level * r.range(0.2, 1), pan: r.bi() * w }), 0, end);
  }
  let st = mix;
  if (o.lp) st = [svf(st[0], sr, "lp", o.lp * b), svf(st[1], sr, "lp", o.lp * b)];
  if (o.echo) st = echo(st, sr, o.echo.time, o.echo.fb, o.echo.mix, 0.35);
  return inSpace(st, sr, v, o.space);
}

const bodyLen = (v: Values) => v.length * 1.15 + 0.03;
const I = (id: string, name: string, cat: "impact" | "hit", tags: SfxTag[], d: { length: number; lmin?: number; lmax?: number; punch?: number; brightness?: number; tail?: number }, o: ImpactO): SfxDef => ({
  id, name, category: cat, tags, stereo: true,
  params: [P.length(d.length, d.lmin ?? Math.max(0.08, d.length * 0.3), d.lmax ?? Math.max(1, d.length * 3)), P.pitch(), P.brightness(d.brightness ?? 0.5), P.punch(d.punch ?? 0.6), P.tail(d.tail ?? 0.3)],
  len: (v) => bodyLen(v) + tailSeconds(v, o.space),
  render: (v, c) => impact(o, v, c),
});

export const IMPACTS: SfxDef[] = [
  I("impact.boom_deep", "Deep boom", "impact", ["impact", "boom"], { length: 2.4, punch: 0.4, brightness: 0.45, tail: 0.35 },
    { nominal: 2.4, body: { f0: 90, f1: 32, glide: 0.35, decay: 2.4, level: 1, drive: 0.25, harm: 0.25 }, thump: { level: 0.5, lp: 300, decay: 0.8 }, crack: { level: 0.15, hp: 1500, decay: 0.03 }, space: HALL }),
  I("impact.punch", "Punch", "impact", ["impact", "hit"], { length: 0.35, punch: 0.7, tail: 0.15 },
    { nominal: 0.35, body: { f0: 160, f1: 60, glide: 0.06, decay: 0.3, level: 1, drive: 0.2 }, crack: { level: 0.6, hp: 2000, decay: 0.03 }, thump: { level: 0.45, lp: 1200, decay: 0.12 }, space: ROOM }),
  I("impact.metal", "Metal-like impact", "impact", ["impact"], { length: 1.8, punch: 0.6, tail: 0.35 },
    { nominal: 1.8, metal: { f0: 180, ratios: [1, 2.76, 5.4, 8.93, 13.34, 1.5, 3.9], decay: 1.8, level: 0.8 }, crack: { level: 0.6, hp: 3000, decay: 0.02 }, body: { f0: 120, f1: 70, glide: 0.05, decay: 0.3, level: 0.45 }, space: HALL }),
  I("impact.cinematic", "Cinematic hit", "impact", ["impact", "boom"], { length: 2.2, punch: 0.7, tail: 0.55 },
    { nominal: 2.2, body: { f0: 100, f1: 35, glide: 0.25, decay: 2, level: 1, drive: 0.35, harm: 0.2 }, crack: { level: 0.7, hp: 1500, decay: 0.05 }, thump: { level: 0.6, lp: 600, decay: 0.6 },
      metal: { f0: 90, ratios: [1, 2.76, 5.4, 8.93], decay: 1.5, level: 0.25 }, wash: { level: 0.25, lp: 3000, decay: 1.2 }, space: HUGE }),
  I("impact.thud", "Thud", "impact", ["impact"], { length: 0.45, punch: 0.4, brightness: 0.35, tail: 0.1 },
    { nominal: 0.45, body: { f0: 110, f1: 55, glide: 0.05, decay: 0.35, level: 1, harm: 0.15 }, thump: { level: 0.7, lp: 400, decay: 0.2 }, space: STUDIO }),
  I("impact.slam", "Slam", "impact", ["impact", "hit"], { length: 0.6, punch: 0.6, tail: 0.35 },
    { nominal: 0.6, body: { f0: 140, f1: 80, glide: 0.04, decay: 0.4, level: 0.8 }, thump: { level: 0.6, lp: 1500, decay: 0.25 }, crack: { level: 0.5, hp: 1200, decay: 0.03 }, space: ROOM }),
  I("impact.distant", "Distant boom", "impact", ["boom"], { length: 3, punch: 0.3, brightness: 0.4, tail: 0.7 },
    { nominal: 3, body: { f0: 70, f1: 30, glide: 0.4, decay: 3, level: 1, harm: 0.3 }, thump: { level: 0.6, lp: 200, decay: 1.5, color: "brown" }, lp: 900, space: HUGE }),
  I("impact.trailer", "Trailer hit", "impact", ["impact", "boom"], { length: 2.4, punch: 0.75, tail: 0.5 },
    { nominal: 2.4, body: { f0: 85, f1: 35, glide: 0.3, decay: 2.2, level: 1, drive: 0.4, harm: 0.25 }, crack: { level: 0.8, hp: 1800, decay: 0.04 }, stab: { f0: 55, chord: [0, 7, 12, 15], decay: 1.4, level: 0.45 },
      metal: { f0: 110, ratios: [1, 2.76, 5.4], decay: 1.2, level: 0.15 }, space: HUGE }),
  I("impact.crash", "Crash impact", "impact", ["impact"], { length: 2.2, punch: 0.6, tail: 0.3 },
    { nominal: 2.2, wash: { level: 0.85, hp: 2500, decay: 2.2 }, metal: { f0: 400, ratios: [1, 1.48, 1.81, 2.55, 2.97, 3.9], decay: 1.8, level: 0.35, square: true, hp: 4000 }, body: { f0: 120, f1: 60, glide: 0.05, decay: 0.3, level: 0.5 },
      crack: { level: 0.6, hp: 2000, decay: 0.03 }, space: HALL }),
  I("impact.sub_boom", "Sub boom", "impact", ["boom"], { length: 3, punch: 0.4, brightness: 0.4, tail: 0.25 },
    { nominal: 3, body: { f0: 55, f1: 28, glide: 0.5, decay: 3, level: 1, drive: 0.5, harm: 0.35 }, thump: { level: 0.3, lp: 150, decay: 0.8, color: "brown" }, space: HALL }),
  I("impact.tight", "Tight hit", "impact", ["impact", "hit"], { length: 0.25, lmin: 0.08, punch: 0.75, tail: 0.15 },
    { nominal: 0.25, body: { f0: 200, f1: 90, glide: 0.03, decay: 0.18, level: 1 }, crack: { level: 0.8, hp: 4000, decay: 0.015 }, thump: { level: 0.4, lp: 2000, decay: 0.06 }, space: ROOM }),
  I("impact.explosion", "Explosion-like boom", "impact", ["boom", "impact"], { length: 3, punch: 0.7, brightness: 0.45, tail: 0.45 },
    { nominal: 3, thump: { level: 1, lp: 1600, lpEnd: 180, decay: 2.5, color: "brown" }, body: { f0: 60, f1: 30, glide: 0.3, decay: 1.5, level: 0.8, drive: 0.4 }, crack: { level: 1, hp: 800, decay: 0.08 },
      debris: { rate: 40, decay: 2, level: 0.35 }, space: HUGE }),
];

// ── hits and stabs ──────────────────────────────────────────────────────────────────────────────────────

interface ClapO { nominal: number; bursts: number; spacing: number; fc: number; q: number; decay: number; tailDecay: number; space: Space }
function clap(o: ClapO, v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, k = pk(v) * bright(v), mix: Stereo = [sig(n), sig(n)], punch = clamp(val(v, "punch", 0.6), 0, 1);
  let t = 0;
  for (let j = 0; j < o.bursts; j++) {
    const last = j === o.bursts - 1;
    const x = burst(sr, rng, o.fc * k * rng.range(0.9, 1.1), o.q, 0.0004, last ? o.tailDecay * Math.max(0.2, v.length / o.nominal) : o.decay);
    addSt(mix, spread(x, sr, 0.25), (last ? 1 : 0.6 + 0.4 * punch) * rng.range(0.85, 1), secs(t, sr));
    t += o.spacing * rng.range(0.75, 1.25);
  }
  return inSpace(mix, sr, v, o.space);
}
const CL = (id: string, name: string, d: { length: number; tail: number }, o: ClapO): SfxDef => ({
  id, name, category: "hit", tags: ["hit"], stereo: true,
  params: [P.length(d.length, 0.05, 1.5), P.pitch(), P.brightness(), P.punch(0.6), P.tail(d.tail)],
  len: (v) => o.bursts * o.spacing * 1.25 + o.tailDecay * Math.max(0.2, v.length / o.nominal) * 1.2 + tailSeconds(v, o.space),
  render: (v, c) => clap(o, v, c),
});

export const HITS: SfxDef[] = [
  I("hit.kick", "Kick", "hit", ["hit"], { length: 0.45, punch: 0.65, tail: 0.08 },
    { nominal: 0.45, body: { f0: 150, f1: 48, glide: 0.045, decay: 0.45, level: 1, drive: 0.25 }, crack: { level: 0.45, hp: 3000, decay: 0.008 }, space: STUDIO }),
  I("hit.snare", "Snare-like hit", "hit", ["hit"], { length: 0.25, punch: 0.6, tail: 0.25 },
    { nominal: 0.25, body: { f0: 200, f1: 185, glide: 0.01, decay: 0.12, level: 0.55, harm: 0.4 }, wash: { level: 0.9, hp: 1500, lp: 9000, decay: 0.22 }, crack: { level: 0.5, hp: 3000, decay: 0.01 }, space: ROOM }),
  CL("hit.clap", "Clap", { length: 0.3, tail: 0.3 }, { nominal: 0.3, bursts: 4, spacing: 0.0095, fc: 1150, q: 1.3, decay: 0.008, tailDecay: 0.17, space: ROOM }),
  I("hit.rim", "Rim shot", "hit", ["hit"], { length: 0.08, lmin: 0.03, lmax: 0.4, punch: 0.7, tail: 0.3 },
    { nominal: 0.08, metal: { f0: 820, ratios: [1, 2.012, 0.48], decay: 0.08, level: 0.9 }, crack: { level: 0.8, hp: 5000, decay: 0.008 }, body: { f0: 420, f1: 400, glide: 0.01, decay: 0.03, level: 0.4 }, space: ROOM }),
  I("hit.orchestral", "Orchestral-like stab", "hit", ["hit"], { length: 0.7, punch: 0.6, tail: 0.5 },
    { nominal: 0.7, stab: { f0: 130.8, chord: [0, 3, 7, 12, 15, 19, 24], decay: 0.7, level: 1, cutoff: 4500 }, body: { f0: 70, f1: 62, glide: 0.08, decay: 0.9, level: 0.5 }, crack: { level: 0.25, hp: 2500, decay: 0.02 }, space: HALL }),
  I("hit.tom", "Tom-like hit", "hit", ["hit"], { length: 0.55, punch: 0.55, tail: 0.25 },
    { nominal: 0.55, body: { f0: 140, f1: 100, glide: 0.12, decay: 0.55, level: 1, harm: 0.2 }, thump: { level: 0.4, lp: 2500, decay: 0.08 }, crack: { level: 0.3, hp: 2500, decay: 0.01 }, space: ROOM }),
  I("hit.cymbal", "Cymbal-like hit", "hit", ["hit"], { length: 1.8, punch: 0.5, tail: 0.25 },
    { nominal: 1.8, metal: { f0: 205.3, ratios: [1, 1.483, 1.8, 2.546, 2.63, 3.9], decay: 1.8, level: 0.8, square: true, hp: 6000 }, wash: { level: 0.6, hp: 6000, decay: 1.4 }, crack: { level: 0.4, hp: 4000, decay: 0.01 }, space: ROOM }),
  I("hit.synth_stab", "Synth stab", "hit", ["hit"], { length: 0.35, punch: 0.6, tail: 0.3 },
    { nominal: 0.35, stab: { f0: 220, chord: [0, 4, 7, 12], decay: 0.35, level: 1, cutoff: 6000 }, echo: { time: 0.18, fb: 0.35, mix: 0.35 }, space: PLATE }),
  I("hit.taiko", "Taiko-like hit", "hit", ["hit"], { length: 0.9, punch: 0.6, tail: 0.45 },
    { nominal: 0.9, body: { f0: 85, f1: 62, glide: 0.08, decay: 0.9, level: 1, drive: 0.2, harm: 0.2 }, thump: { level: 0.5, lp: 900, decay: 0.15 }, crack: { level: 0.4, hp: 1500, decay: 0.012 }, space: HALL }),
  CL("hit.snap", "Snap", { length: 0.06, tail: 0.35 }, { nominal: 0.06, bursts: 1, spacing: 0.002, fc: 2300, q: 2.6, decay: 0.01, tailDecay: 0.03, space: ROOM }),
];

// ── sub drops ───────────────────────────────────────────────────────────────────────────────────────────

interface SubO { f0: number; f1: number; glide: number; decay: number; drive: number; click?: number; harm?: number; settle?: number }
function subdrop(o: SubO, v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, s = Math.max(0.1, v.length / o.decay), k = pk(v), punch = clamp(val(v, "punch", 0.5), 0, 1);
  const f = glide(n, o.f0 * k, o.f1 * k, 0.6, sr, o.glide * s);
  if (o.settle) { const a = secs(o.glide * s, sr); for (let i = a; i < n; i++) f[i] = o.f1 * k * Math.pow(o.settle, Math.min(1, (i - a) / Math.max(1, sr * o.decay * s))); }
  let y = mul(osc(n, sr, f), perc(n, sr, 0.004, o.decay * s));
  if (o.harm) add(y, mul(osc(n, sr, f.map((x) => x * 2), "sine", 0.25), perc(n, sr, 0.004, o.decay * s * 0.7)), o.harm);
  y = svf(drive(y, val(v, "drive", o.drive)), sr, "lp", 420, 0.7);
  if (o.click) { const m = secs(0.02, sr), z = mul(svf(white(m, rng.fork(1)), sr, "hp", 2500), perc(m, sr, 0.0003, 0.012)); add(y, z, o.click * (0.2 + 1.4 * punch)); }
  return mono(y);
}
const SD = (id: string, name: string, d: { length: number; drive: number; punch?: number }, o: SubO): SfxDef => ({
  id, name, category: "sub_drop", tags: ["sub_drop"], stereo: false,
  params: [P.length(d.length, Math.max(0.3, d.length * 0.3), d.length * 3), P.pitch(0, 7), P.drive(d.drive), P.punch(d.punch ?? 0.4)],
  len: (v) => v.length * 1.1 + 0.05,
  render: (v, c) => subdrop(o, v, c),
});

export const SUB_DROPS: SfxDef[] = [
  SD("subdrop.classic", "Sub drop", { length: 1.8, drive: 0.15 }, { f0: 95, f1: 32, glide: 1.0, decay: 1.8, drive: 0.15, harm: 0.25, click: 0.3 }),
  SD("subdrop.long", "Long sub drop", { length: 3.5, drive: 0.2 }, { f0: 110, f1: 28, glide: 2.6, decay: 3.5, drive: 0.2, harm: 0.3 }),
  SD("subdrop.punchy", "Punchy sub drop", { length: 1.2, drive: 0.25, punch: 0.75 }, { f0: 120, f1: 35, glide: 0.5, decay: 1.2, drive: 0.25, harm: 0.3, click: 0.7 }),
  SD("subdrop.distorted", "Distorted sub drop", { length: 2, drive: 0.7 }, { f0: 100, f1: 30, glide: 1.1, decay: 2, drive: 0.7, harm: 0.5, click: 0.3 }),
  SD("subdrop.808", "808-like drop", { length: 2.4, drive: 0.25, punch: 0.6 }, { f0: 180, f1: 45, glide: 0.06, decay: 2.4, drive: 0.25, harm: 0.2, click: 0.5, settle: 0.84 }),
];

// ── braams ──────────────────────────────────────────────────────────────────────────────────────────────

interface BraamO { root: number; chord: number[]; attack: number; filter: [number, number, number]; drive: number; stutter?: number; sub?: number; q?: number }
function braam(o: BraamO, v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, nb = Math.max(16, secs(v.length, sr)), k = pk(v), b = bright(v), w = clamp(val(v, "width", 0.8), 0, 1);
  const sm: Stereo = [sig(nb), sig(nb)];
  o.chord.forEach((iv, j) => addSt(sm, stack(nb, sr, o.root * k * Math.pow(2, iv / 12), 7, 22, rng.fork(30 + j), 0.5 + 0.5 * w), 1 / Math.sqrt(o.chord.length)));
  const L = v.length, a = Math.min(o.attack, L * 0.5);
  const cut = bpf(nb, sr, [[0, o.filter[0] * b], [a * 1.3 + 0.05, o.filter[1] * b, 0.7], [L, o.filter[2] * b, 0.8]]);
  const env = adsr(nb, sr, a, 0.7, 0.72, Math.min(0.8, L * 0.35));
  if (o.stutter) {
    let ph = 0;
    for (let i = 0; i < nb; i++) { const u = i / nb, rate = o.stutter * (1 - 0.5 * u); ph += rate / sr; const x = ph % 1; env[i] *= x < 0.55 ? 1 : x < 0.6 ? 1 - (x - 0.55) / 0.05 : 0.05; }
  }
  let st: Stereo = sm.map((x) => {
    let y = svf(x, sr, "lp", cut, o.q ?? 1.2);
    y = eq(eq(y, sr, "peak", 700, 4, 0.9), sr, "peak", 1800, 3, 1.1);
    return mul(drive(y, o.drive), env);
  }) as Stereo;
  if (o.sub) { const s = mul(osc(nb, sr, (o.root * k) / 2), env); addSt(st, s, o.sub); }
  st = fitSt(st, n);
  return inSpace(st, sr, v, HUGE);
}
const BR = (id: string, name: string, d: { length: number; brightness?: number; tail?: number }, o: BraamO): SfxDef => ({
  id, name, category: "braam", tags: ["braam"], stereo: true,
  params: [P.length(d.length, 0.6, 10), P.pitch(), P.brightness(d.brightness ?? 0.5), P.width(0.8), P.tail(d.tail ?? 0.45)],
  len: (v) => v.length + tailSeconds(v, HUGE),
  render: (v, c) => braam(o, v, c),
});

export const BRAAMS: SfxDef[] = [
  BR("braam.classic", "Trailer braam", { length: 3 }, { root: 55, chord: [0, 7, 12, 19], attack: 0.06, filter: [300, 2400, 900], drive: 0.45, sub: 0.35 }),
  BR("braam.dark", "Dark braam", { length: 3.5, brightness: 0.4 }, { root: 41.2, chord: [0, 7, 12], attack: 0.1, filter: [150, 900, 400], drive: 0.5, sub: 0.4 }),
  BR("braam.bright", "Bright braam", { length: 2.5, brightness: 0.55 }, { root: 73.4, chord: [0, 7, 12, 16], attack: 0.03, filter: [600, 5000, 1800], drive: 0.4, sub: 0.25 }),
  BR("braam.swell", "Swelling braam", { length: 4 }, { root: 55, chord: [0, 7, 12, 15], attack: 1.2, filter: [200, 2600, 1000], drive: 0.45, sub: 0.35 }),
  BR("braam.stutter", "Stutter braam", { length: 3 }, { root: 49, chord: [0, 7, 12], attack: 0.04, filter: [300, 2200, 800], drive: 0.5, stutter: 9, sub: 0.3 }),
];

// ── reversed ────────────────────────────────────────────────────────────────────────────────────────────

const CYMBAL: ImpactO = { nominal: 2.5, metal: { f0: 205.3, ratios: [1, 1.483, 1.8, 2.546, 2.63, 3.9], decay: 2.5, level: 0.7, square: true, hp: 5000 }, wash: { level: 0.8, hp: 4500, decay: 2.5 }, space: HALL };
const REV_HIT: ImpactO = { nominal: 1.6, body: { f0: 100, f1: 38, glide: 0.2, decay: 1.6, level: 1, drive: 0.3, harm: 0.25 }, crack: { level: 0.6, hp: 1500, decay: 0.05 }, thump: { level: 0.5, lp: 600, decay: 0.5 }, space: HUGE };

function swellPad(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, k = pk(v), b = bright(v), m = secs(0.5, sr), sm: Stereo = [sig(n), sig(n)];
  [0, 7, 12, 16].forEach((iv, j) => addSt(sm, fitSt(stack(m, sr, 110 * k * Math.pow(2, iv / 12), 5, 18, rng.fork(40 + j), 0.7), n), 0.5));
  const st = mulSt([svf(sm[0], sr, "lp", 2400 * b), svf(sm[1], sr, "lp", 2400 * b)], perc(n, sr, 0.01, 0.45));
  return fades(reverb(st, sr, { size: 0.9, wet: 1.2 * Math.max(0.2, val(v, "tail", 0.6)), dry: 0.15, damp: 0.3, width: 1 }), sr, 0, (n / sr) * 0.6);
}
function suck(v: Values, c: RenderCtx): Stereo {
  const { sr, rng, n } = c, b = bright(v), m = secs(0.12, sr);
  const z = mul(svf(white(m, rng.fork(1)), sr, "bp", 2500 * b * pk(v), 0.8), perc(m, sr, 0.001, 0.1));
  const st: Stereo = [sig(n), sig(n)];
  addSt(st, z);
  return fades(reverb(st, sr, { size: 0.92, wet: 1.4 * Math.max(0.2, val(v, "tail", 0.6)), dry: 0.1, damp: 0.25, width: 1 }), sr, 0, (n / sr) * 0.6);
}

const RV = (id: string, name: string, tags: SfxTag[], d: { length: number }, len: (v: Values) => number, fwd: (v: Values, c: RenderCtx) => Stereo): SfxDef => ({
  id, name, category: "reverse", tags, stereo: true,
  params: [P.length(d.length, 0.4, 8), P.pitch(), P.brightness(), P.tail(0.6)],
  len,
  render: (v, c) => reverseSt(fwd(v, c)),
});

export const REVERSES: SfxDef[] = [
  RV("reverse.cymbal", "Reverse cymbal-like", ["reverse"], { length: 2.5 }, (v) => v.length * 1.15 + 0.03 + tailSeconds({ ...v, tail: v.tail * 0.5 }, HALL),
    (v, c) => impact(CYMBAL, { ...v, tail: v.tail * 0.5 }, c)),
  RV("reverse.swell", "Reverse swell", ["reverse"], { length: 2.5 }, (v) => Math.max(0.6, v.length),
    (v, c) => fitSt(swellPad(v, c), c.n)),
  RV("reverse.hit", "Reverse hit", ["reverse"], { length: 1.6 }, (v) => v.length * 1.15 + tailSeconds(v, HUGE),
    (v, c) => impact(REV_HIT, v, c)),
  RV("reverse.suck", "Reverse suck", ["reverse", "whoosh"], { length: 1.5 }, (v) => Math.max(0.5, v.length),
    (v, c) => fitSt(suck(v, c), c.n)),
];
