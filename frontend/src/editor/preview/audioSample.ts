/**
 * The procedural audio samples the audio effect previews play when no audio clip is selected (preview-polish): a
 * 4 s music loop (drums, bass and chords at 120 BPM) and a 4 s voice-like phrase (formant vowels on a pitch contour
 * with consonant noise bursts: it is not speech, and the UI says "voice-like sample"). Built from the SFX engine's
 * own building blocks (editor/sfx/dsp.ts), seeded, so every render is the same samples, and levelled to −18 LUFS
 * with the true peak under −1 dBTP (editor/sfx/level.ts). Nothing is downloaded. Pure: no DOM, no WebAudio.
 */
import { add, addSt, glide, lp1, mul, osc, oscInto, pan, perc, Rng, secs, sig, stack, stereo, svf, white, type Sig, type Stereo } from "../sfx/dsp.ts";
import { loopWrap, normalise, peaksOf } from "../sfx/level.ts";

export const SAMPLE_RATE = 48000;
export const SAMPLE_SECONDS = 4;
export const SAMPLE_LUFS = -18;
export type AudioSampleKind = "music" | "voice";
export const AUDIO_SAMPLE_LABEL: Record<AudioSampleKind, string> = { music: "music loop", voice: "voice-like sample" };

const toF32 = (st: Stereo): Float32Array[] => st.map((x) => Float32Array.from(x));

// ── the music loop ───────────────────────────────────────────────────────────────────────────────────────

const BPM = 120;
const BEAT = 60 / BPM;
/** A–F–C–G, one chord a second (two beats). */
const CHORDS: { root: number; notes: number[] }[] = [
  { root: 110, notes: [220, 261.63, 329.63] },     // A minor
  { root: 87.31, notes: [174.61, 220, 261.63] },   // F
  { root: 130.81, notes: [196, 261.63, 329.63] },  // C (2nd inversion)
  { root: 98, notes: [196, 246.94, 293.66] },      // G
];

function kick(sr: number, rng: Rng): Sig {
  const n = secs(0.5, sr);
  const body = osc(n, sr, glide(n, 160, 47, 0.32, sr, 0.11), "sine");
  mul(body, perc(n, sr, 0.0015, 0.42));
  const click = svf(white(secs(0.012, sr), rng), sr, "lp", 5000);
  mul(click, perc(click.length, sr, 0.0003, 0.012));
  return add(body, click, 0.5);
}

function snare(sr: number, rng: Rng): Sig {
  const n = secs(0.3, sr);
  const tone = osc(n, sr, glide(n, 240, 185, 1, sr, 0.04), "tri");
  mul(tone, perc(n, sr, 0.001, 0.09));
  const nz = svf(white(n, rng), sr, "bp", 2200, 0.8);
  mul(nz, perc(n, sr, 0.001, 0.2));
  return add(mul(tone, 0.55), nz, 0.9);
}

function hat(sr: number, rng: Rng, open: boolean): Sig {
  const n = secs(open ? 0.25 : 0.06, sr);
  const x = svf(svf(white(n, rng), sr, "hp", 7500, 0.9), sr, "hp", 6000);
  return mul(x, perc(n, sr, 0.0005, open ? 0.22 : 0.045));
}

/** Drums, bass and chords: 4 s at 120 BPM, looping seamlessly (the tails wrap onto the start). */
export function musicLoop(sr = SAMPLE_RATE): Float32Array[] {
  const n = SAMPLE_SECONDS * sr, tail = secs(0.6, sr);
  const out = stereo(n + tail);
  const rng = new Rng(0x7a7a11);
  const at = (beats: number) => Math.round(beats * BEAT * sr);
  // drums: kick on 1 and 3 with a push before 3; snare on 2 and 4; eighth hats, an open one at the end of each bar
  const k = kick(sr, rng.fork(1)), sn = snare(sr, rng.fork(2));
  for (const b of [0, 2, 2.75, 4, 5.5, 6]) addSt(out, k, 0.95, at(b));
  for (const b of [1, 3, 5, 7]) addSt(out, pan(sn, 0.05), 0.55, at(b));
  for (let i = 0; i < 16; i++) {
    const open = i === 7 || i === 15;
    addSt(out, pan(hat(sr, rng.fork(10 + i), open), 0.25), (i % 2 ? 0.2 : 0.13) * (open ? 0.9 : 1), at(i / 2));
  }
  // bass: the chord's root in eighths (octave jump on the "and" of 2)
  for (let c = 0; c < CHORDS.length; c++) {
    const pattern = [0, 0, 1, 0];
    for (let e = 0; e < 4; e++) {
      const len = secs(BEAT / 2 * 0.92, sr);
      const f = CHORDS[c].root * (pattern[e] ? 2 : 1);
      const x = sig(len);
      oscInto(x, sr, f, "saw", 0.7);
      oscInto(x, sr, f / 2, "sine", 0.6);
      const y = svf(x, sr, "lp", 520, 1.1);
      mul(y, perc(len, sr, 0.004, 0.28, 0.05));
      addSt(out, y, 0.42, at(c * 2 + e / 2));
    }
  }
  // chords: a soft detuned pad, a chord a second
  for (let c = 0; c < CHORDS.length; c++) {
    const len = secs(2 * BEAT + 0.12, sr);
    const pad = stereo(len);
    for (const f of CHORDS[c].notes) addSt(pad, stack(len, sr, f, 3, 12, rng.fork(100 + c * 7 + Math.round(f)), 0.7, "saw"), 0.22);
    const env = sig(len);
    const a = secs(0.03, sr), r = secs(0.25, sr);
    for (let i = 0; i < len; i++) env[i] = Math.min(1, i / a) * (i > len - r ? Math.max(0, (len - i) / r) : 1) * (0.75 + 0.25 * Math.exp(-i / (0.35 * sr)));
    const L = mul(svf(pad[0], sr, "lp", 1700, 0.8), env), R = mul(svf(pad[1], sr, "lp", 1700, 0.8), env);
    addSt(out, [L, R], 0.6, at(c * 2));
  }
  const st = loopWrap(out, n);
  normalise(st, sr, true, SAMPLE_LUFS);
  return toF32(st);
}

// ── the voice-like phrase ────────────────────────────────────────────────────────────────────────────────

/** Vowel formants (Hz) of an adult voice, and their levels. */
const VOWELS: Record<string, [number, number, number]> = {
  a: [730, 1090, 2440], e: [530, 1840, 2480], i: [300, 2250, 3000], o: [570, 840, 2410], u: [320, 900, 2250],
  m: [260, 1000, 2200], n: [280, 1500, 2500],
};
type Cons = "" | "t" | "k" | "p" | "d" | "s" | "sh" | "h" | "v" | "m" | "n";
interface Syl { c: Cons; v: string; dur: number; stress?: number }
/** Two phrases of a made-up sentence (a rising then falling contour, a breath between). */
const PHRASES: Syl[][] = [
  [{ c: "t", v: "a", dur: 0.17 }, { c: "v", v: "a", dur: 0.16, stress: 1 }, { c: "m", v: "a", dur: 0.2 }, { c: "s", v: "u", dur: 0.2 }, { c: "d", v: "i", dur: 0.14 }, { c: "", v: "o", dur: 0.26, stress: 1 }],
  [{ c: "h", v: "e", dur: 0.15 }, { c: "n", v: "i", dur: 0.16 }, { c: "k", v: "a", dur: 0.18, stress: 1 }, { c: "sh", v: "o", dur: 0.22 }, { c: "p", v: "e", dur: 0.16 }, { c: "t", v: "u", dur: 0.3 }],
];

/** A formant voice: a pitch-swept glottal source through three moving resonances, with noise for the consonants. */
export function voicePhrase(sr = SAMPLE_RATE): Float32Array[] {
  const n = SAMPLE_SECONDS * sr;
  const rng = new Rng(0x5eed70);
  const f1 = sig(n), f2 = sig(n), f3 = sig(n), voiced = sig(n), noiseMix = sig(n);
  const bursts: { at: number; kind: Cons }[] = [];
  // lay out the syllables: targets per sample (held, then smoothed for coarticulation)
  let t = 0.18;
  let last: [number, number, number] = VOWELS.a;
  const fill = (a: number, b: number, fm: [number, number, number], amp: number) => {
    const i0 = Math.max(0, Math.round(a * sr)), i1 = Math.min(n, Math.round(b * sr));
    for (let i = i0; i < i1; i++) { f1[i] = fm[0]; f2[i] = fm[1]; f3[i] = fm[2]; voiced[i] = amp; }
    last = fm;
  };
  for (let p = 0; p < PHRASES.length; p++) {
    for (const s of PHRASES[p]) {
      const v = VOWELS[s.v] ?? VOWELS.a;
      let cd = 0;
      if (s.c === "t" || s.c === "k" || s.c === "p") { cd = 0.05; fill(t, t + cd, last, 0); bursts.push({ at: t + cd - 0.012, kind: s.c }); }
      else if (s.c === "d") { cd = 0.04; fill(t, t + cd, VOWELS.u, 0.18); bursts.push({ at: t + cd - 0.01, kind: "d" }); }
      else if (s.c === "s" || s.c === "sh") { cd = 0.1; fill(t, t + cd, last, 0); bursts.push({ at: t, kind: s.c }); }
      else if (s.c === "h") { cd = 0.06; fill(t, t + cd, v, 0.05); bursts.push({ at: t, kind: "h" }); }
      else if (s.c === "v") { cd = 0.05; fill(t, t + cd, VOWELS.u, 0.3); bursts.push({ at: t, kind: "v" }); }
      else if (s.c === "m" || s.c === "n") { cd = 0.06; fill(t, t + cd, VOWELS[s.c], 0.45); }
      fill(t + cd, t + s.dur, v, s.stress ? 1 : 0.82);
      t += s.dur;
    }
    t += 0.32; // a breath between the phrases
  }
  // coarticulation: the formants glide (30 ms), the voicing has soft edges (12 ms)
  const sm = (x: Sig, ms: number) => { const y = lp1(x, sr, 1000 / (2 * Math.PI * ms)); x.set(lp1(y.reverse(), sr, 1000 / (2 * Math.PI * ms)).reverse()); return x; };
  for (const x of [f1, f2, f3]) { for (let i = 1; i < n; i++) if (x[i] === 0) x[i] = x[i - 1]; for (let i = n - 2; i >= 0; i--) if (x[i] === 0) x[i] = x[i + 1]; sm(x, 30); }
  sm(voiced, 12);
  // the pitch: a declining contour with a rise on the stressed syllables, jitter and a light vibrato
  const f0 = sig(n);
  const dur = t;
  for (let i = 0; i < n; i++) {
    const u = i / sr;
    const phrase = u < 1.5 ? u / 1.5 : (u - 1.5) / Math.max(0.5, dur - 1.5);
    const base = 175 - 45 * Math.min(1, Math.max(0, phrase)) + (u < 1.5 ? 18 * Math.sin(Math.PI * Math.min(1, u / 1.2)) : 10 * Math.sin(Math.PI * Math.min(1, (u - 1.6) / 1.2)));
    f0[i] = base * (1 + 0.008 * Math.sin(2 * Math.PI * 5.2 * u));
  }
  // the source: a band-limited saw tilted down (−12 dB/oct overall, like a glottal pulse), plus breath noise
  const src = sig(n);
  oscInto(src, sr, f0, "saw", 1);
  const tilted = lp1(src, sr, 700);
  const breath = svf(white(n, rng.fork(1)), sr, "bp", 1800, 0.5);
  for (let i = 0; i < n; i++) tilted[i] = (tilted[i] * 3 + breath[i] * 0.04) * voiced[i];
  // three resonances with their bandwidths (Q = f / bandwidth)
  const q = (f: Sig, bw: number) => { const o = sig(n); for (let i = 0; i < n; i++) o[i] = Math.max(0.5, f[i] / bw); return o; };
  const voice = sig(n);
  add(voice, svf(tilted, sr, "bp", f1, q(f1, 90)), 1);
  add(voice, svf(tilted, sr, "bp", f2, q(f2, 110)), 0.55);
  add(voice, svf(tilted, sr, "bp", f3, q(f3, 150)), 0.25);
  // consonants: plosive bursts, fricatives and aspiration
  for (const b of bursts) {
    const at = Math.round(b.at * sr);
    const len = secs(b.kind === "s" || b.kind === "sh" ? 0.11 : b.kind === "h" ? 0.07 : b.kind === "v" ? 0.06 : 0.025, sr);
    const nz = white(len, rng.fork(at));
    let x: Sig;
    if (b.kind === "s") x = svf(svf(nz, sr, "hp", 4800, 0.8), sr, "lp", 9500);
    else if (b.kind === "sh") x = svf(nz, sr, "bp", 2700, 1.4);
    else if (b.kind === "t") x = svf(nz, sr, "hp", 3200, 0.9);
    else if (b.kind === "k") x = svf(nz, sr, "bp", 1900, 2);
    else if (b.kind === "p" || b.kind === "d") x = svf(nz, sr, "lp", 1500, 0.8);
    else if (b.kind === "v") x = svf(nz, sr, "hp", 3000, 0.7);
    else x = svf(nz, sr, "bp", 1500, 0.6);
    const env = b.kind === "s" || b.kind === "sh" ? perc(len, sr, 0.03, 0.12, 0.03) : b.kind === "h" ? perc(len, sr, 0.01, 0.08) : perc(len, sr, 0.0008, 0.035);
    const lvl = b.kind === "s" ? 0.16 : b.kind === "sh" ? 0.22 : b.kind === "h" ? 0.06 : b.kind === "v" ? 0.05 : 0.3;
    add(noiseMix, mul(x, env), lvl, at);
  }
  add(voice, noiseMix, 1);
  const st: Stereo = [voice, Float64Array.from(voice)];
  normalise(st, sr, false, SAMPLE_LUFS);
  return toF32(st);
}

/** The sample of a kind (cached: they never change). */
const made = new Map<string, Float32Array[]>();
export function audioSample(kind: AudioSampleKind, sr = SAMPLE_RATE): Float32Array[] {
  const k = `${kind}@${sr}`;
  let s = made.get(k);
  if (!s) { s = kind === "music" ? musicLoop(sr) : voicePhrase(sr); made.set(k, s); }
  return s;
}

// ── which sample an effect plays ─────────────────────────────────────────────────────────────────────────

const VOICE_IDS = /deesser|speech|dialogue|voice|denoise|declick|declip|dehum|hiss|noise_print|dereverb|trim_silence|gate|expander|telephone|radio|megaphone|walkie|robot|chipmunk|deep_voice|alien|pitch|time_stretch|formant|next_room|reverb|echo|haas|doppler|center_extract|whisper|podcast|narrator|announcer|asmr|phone|trailer|youtube|small_room|concert_hall|church/;

/** Presets that are about music whatever their effects say. */
const MUSIC_IDS = /lofi|vinyl|car_radio|master|loud_clear|loudness_maximizer/;

/** The procedural sample that shows an effect (or a chain preset) best: voice tools on the voice, the rest on music. */
export function sampleKindFor(id: string, group = ""): AudioSampleKind {
  const g = group.toLowerCase(), k = id.toLowerCase();
  if (g === "voice" || g === "clean-up") return "voice";
  if (g === "music" || MUSIC_IDS.test(k)) return "music";
  return VOICE_IDS.test(k) ? "voice" : "music";
}

/** Peaks for a mini waveform (0..1, the loudest bucket at 1): the SFX library's own. */
export const peaks = (ch: ArrayLike<number>[], buckets = 64): number[] => peaksOf(ch, buckets);
