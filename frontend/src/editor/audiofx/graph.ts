/**
 * The audio effects in WebAudio (docs/EDITOR.md §11): a builder per "realtime" effect of audiofx/registry.ts, made
 * with the same maths as its FFmpeg filter in the export (audiofx/ffmpegRef.ts lists the mapping it was measured
 * against), and `FxChain`, an ordered list of them between an input and an output node that rebuilds only when the
 * list's shape changes and otherwise moves parameters (keyframes) in place. Sample-level effects run in the worklet
 * (audiofx/worklet.ts); impulse responses come from the desktop (/__media/irs/<name>.wav) or the same recipe here.
 */
import workletUrl from "./worklet.ts?worker&url";
import { chromeCompressorMakeup, dbToLin, dopplerAt, shaperCurve } from "./dsp";
import { irUrl, makeIr } from "./ir";
import { audioFxDef, EQ_PARAM_BANDS, GRAPHIC_BANDS, GRAPHIC_Q, implId, type AudioParamValue } from "./registry";

export type Values = Record<string, AudioParamValue>;
/** When a value applies: `now` (context seconds), `local` (seconds into the clip, or the sequence for track / master
 *  chains), the clip's length, and `immediate` (offline renders: jump, don't glide). */
export interface Tick { now: number; local: number; duration: number; immediate?: boolean }
export interface Unit { input: AudioNode; output: AudioNode; update(v: Values, t: Tick): void; dispose(): void; timeVarying?: boolean }

// ── the per-context environment: worklets, impulse responses, noise ────────────────────────────────────────
export interface FxEnv {
  ctx: BaseAudioContext;
  worklets: boolean;
  ready: Promise<boolean>;
  ir(name: string): Promise<AudioBuffer | null>;
  /** Called once when the worklets become available (chains made before then rebuild). */
  onReady(cb: () => void): void;
}
const envs = new WeakMap<BaseAudioContext, FxEnv>();

export function fxEnv(ctx: BaseAudioContext): FxEnv {
  let e = envs.get(ctx);
  if (e) return e;
  const irs = new Map<string, Promise<AudioBuffer | null>>();
  const waiting: (() => void)[] = [];
  const env: FxEnv = {
    ctx, worklets: false,
    ready: Promise.resolve(false),
    ir(name) {
      let p = irs.get(name);
      if (!p) {
        p = fetch(irUrl(name), { credentials: "include" })
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
          .then((b) => ctx.decodeAudioData(b))
          .catch(() => {
            // no desktop (or no file yet): the same recipe here
            try {
              const ch = makeIr(name, ctx.sampleRate);
              const buf = ctx.createBuffer(ch.length, ch[0].length, ctx.sampleRate);
              ch.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
              return buf;
            } catch { return null; }
          });
        irs.set(name, p);
      }
      return p;
    },
    onReady(cb) { if (env.worklets) cb(); else waiting.push(cb); },
  };
  env.ready = (ctx.audioWorklet ? ctx.audioWorklet.addModule(workletUrl) : Promise.reject(new Error("no AudioWorklet")))
    .then(() => { env.worklets = true; for (const cb of waiting.splice(0)) cb(); return true; })
    .catch(() => false);
  envs.set(ctx, env);
  return env;
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────
const num = (v: AudioParamValue | undefined, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v: AudioParamValue | undefined, d: string) => (typeof v === "string" ? v : d);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
/** Headroom of the WaveShaper curves: inputs up to +12 dBFS map onto the curve. */
const HEAD = 4;

function setP(p: AudioParam, v: number, t: Tick, tc = 0.012) {
  if (!Number.isFinite(v)) return;
  const x = clamp(v, p.minValue, p.maxValue);
  if (t.immediate) { p.cancelScheduledValues(0); p.value = x; } else p.setTargetAtTime(x, t.now, tc);
}
const stereo = (ctx: BaseAudioContext, g = 1) => {
  const n = ctx.createGain();
  n.gain.value = g;
  n.channelCount = 2; n.channelCountMode = "explicit"; n.channelInterpretation = "speakers";
  return n;
};
const chain = (...nodes: AudioNode[]) => { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes; };
const biquad = (ctx: BaseAudioContext, type: BiquadFilterType, f: number, q = 1, g = 0) => {
  const b = ctx.createBiquadFilter();
  b.type = type; b.frequency.value = clamp(f, 1, ctx.sampleRate / 2 - 1); b.Q.value = q; b.gain.value = g;
  return b;
};
/** WebAudio's low/high-pass Q is in dB; FFmpeg's (t=q) is linear. */
const qDb = (q: number) => 20 * Math.log10(Math.max(1e-4, q));
const kill = (nodes: AudioNode[]) => { for (const n of nodes) { try { n.disconnect(); } catch { /* gone */ } if (n instanceof AudioScheduledSourceNode) { try { n.stop(); } catch { /* not started */ } } } };

/** A 2×2 channel matrix: L' = ll·L + rl·R, R' = lr·L + rr·R. */
function matrix(ctx: BaseAudioContext) {
  const input = stereo(ctx), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
  const g = [ctx.createGain(), ctx.createGain(), ctx.createGain(), ctx.createGain()]; // ll, rl, lr, rr
  input.connect(split);
  split.connect(g[0], 0); split.connect(g[1], 1); split.connect(g[2], 0); split.connect(g[3], 1);
  g[0].connect(merge, 0, 0); g[1].connect(merge, 0, 0); g[2].connect(merge, 0, 1); g[3].connect(merge, 0, 1);
  const nodes: AudioNode[] = [input, split, merge, ...g];
  return {
    input, output: merge as AudioNode, nodes,
    set(m: [number, number, number, number], t: Tick) { m.forEach((v, i) => setP(g[i].gain, v, t)); },
  };
}

/** A soft clipper: drive (dB) into the curve, `outDb` after it, with HEAD of input headroom. */
function clipper(ctx: BaseAudioContext, oversample: OverSampleType = "none") {
  const pre = ctx.createGain(); pre.gain.value = 1 / HEAD;
  const ws = ctx.createWaveShaper(); ws.oversample = oversample;
  pre.connect(ws);
  let key = "";
  return {
    input: pre as AudioNode, output: ws as AudioNode, nodes: [pre, ws] as AudioNode[],
    set(type: string, driveDb: number, outDb: number) {
      const k = `${type}|${driveDb.toFixed(2)}|${outDb.toFixed(2)}`;
      if (k === key) return;
      key = k;
      ws.curve = shaperCurve(type, dbToLin(driveDb) * HEAD, dbToLin(outDb)) as Float32Array<ArrayBuffer>;
    },
  };
}

/** An LFO: sin(2πft) (or cos) at amplitude 1. */
function lfo(ctx: BaseAudioContext, f: number, cos = false) {
  const o = ctx.createOscillator();
  if (cos) o.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0]), { disableNormalization: true }));
  else o.type = "sine";
  o.frequency.value = f;
  o.start();
  return o;
}

/** Looped noise (mono): white ±1, or sparse crackle (FFmpeg aevalsrc: prob per sample, uniform ±amp/2), 4 s. */
function noiseBuffer(ctx: BaseAudioContext, kind: "white" | "pink" | "crackle", amount = 1, channels = 1): AudioBuffer {
  const n = ctx.sampleRate * 4;
  const b = ctx.createBuffer(channels, n, ctx.sampleRate);
  let s = 0x9e3779b9 ^ Math.round(amount * 1000);
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let c = 0; c < channels; c++) {
    const d = b.getChannelData(c);
    if (kind === "white") for (let i = 0; i < n; i++) d[i] = 2 * rnd() - 1;
    else if (kind === "pink") {
      // Paul Kellet's economy filter, scaled to anoisesrc's pink level (RMS ≈ 0.1975 at amplitude 1, measured)
      let b0 = 0, b1 = 0, b2 = 0, e = 0;
      for (let i = 0; i < n; i++) {
        const w = 2 * rnd() - 1;
        b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = b0 + b1 + b2 + w * 0.1848; e += d[i] * d[i];
      }
      const k = 0.1975 / Math.sqrt(e / n);
      for (let i = 0; i < n; i++) d[i] *= k;
    }
    else { const prob = 0.0004 * amount, amp = 0.5 * amount; for (let i = 0; i < n; i++) d[i] = rnd() < prob ? (rnd() - 0.5) * amp : 0; }
  }
  return b;
}
function loopSource(ctx: BaseAudioContext, buf: AudioBuffer) {
  const s = ctx.createBufferSource();
  s.buffer = buf; s.loop = true; s.start();
  return s;
}

function worklet(env: FxEnv, kind: string, params: Values): AudioWorkletNode | null {
  if (!env.worklets) return null;
  try {
    return new AudioWorkletNode(env.ctx, "tatvam-fx", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2,
      channelCountMode: "explicit", channelInterpretation: "speakers", processorOptions: { kind, params } });
  } catch { return null; }
}
/** A worklet effect (a passthrough until the worklet module is loaded: the chain rebuilds then). */
function wkUnit(env: FxEnv, kind: string, map: (v: Values) => Values, v0: Values): Unit {
  const node = worklet(env, kind, map(v0));
  if (!node) { const g = stereo(env.ctx); return { input: g, output: g, update() { /* waiting */ }, dispose: () => kill([g]) }; }
  let last = "";
  return {
    input: node, output: node,
    update(v) { const p = map(v); const k = JSON.stringify(p); if (k !== last) { last = k; node.port.postMessage({ params: p }); } },
    dispose() { node.port.postMessage({ stop: true }); kill([node]); },
  };
}

/** Units in series as one unit. */
function series(ctx: BaseAudioContext, units: Unit[]): Unit {
  const input = stereo(ctx), output = stereo(ctx);
  let head: AudioNode = input;
  for (const u of units) { head.connect(u.input); head = u.output; }
  head.connect(output);
  return {
    input, output, timeVarying: units.some((u) => u.timeVarying),
    update(v, t) { for (const u of units) u.update(v, t); },
    dispose() { for (const u of units) u.dispose(); kill([input, output]); },
  };
}
/** A plain node chain as a unit (`set` moves its params). */
function nodes(input: AudioNode, output: AudioNode, all: AudioNode[], set: (v: Values, t: Tick) => void, timeVarying = false): Unit {
  return { input, output, update: set, dispose: () => kill(all), timeVarying };
}

// band-limiting for the creative voices: two high-passes, two low-passes (FFmpeg p=2, Q 0.7071)
function band(ctx: BaseAudioContext, lo: number, hi: number, stages: 1 | 2 = 2) {
  const hp = Array.from({ length: stages }, () => biquad(ctx, "highpass", lo, qDb(0.7071)));
  const lp = Array.from({ length: stages }, () => biquad(ctx, "lowpass", hi, qDb(0.7071)));
  const f = [...hp, ...lp];
  chain(...f);
  return { input: f[0] as AudioNode, output: f[f.length - 1] as AudioNode, nodes: f as AudioNode[],
    set(l: number, h: number, t: Tick) { for (const x of hp) setP(x.frequency, l, t); for (const x of lp) setP(x.frequency, h, t); } };
}

/** Compressor without WebAudio's automatic make-up (acompressor has none): threshold / ratio / knee dB / s. */
function compressor(ctx: BaseAudioContext) {
  const c = ctx.createDynamicsCompressor(), mk = ctx.createGain();
  c.connect(mk);
  return {
    input: c as AudioNode, output: mk as AudioNode, nodes: [c, mk] as AudioNode[],
    set(th: number, ratio: number, knee: number, att: number, rel: number, makeupDb: number, t: Tick) {
      // acompressor's knee is centred on the threshold (WebAudio's starts there): move it down by half
      const K = clamp(knee, 0, 40), T = clamp(th - K / 2, -100, 0), R = clamp(ratio, 1, 20);
      setP(c.threshold, T, t); setP(c.knee, K, t); setP(c.ratio, R, t); setP(c.attack, clamp(att, 0, 1), t); setP(c.release, clamp(rel, 0, 1), t);
      setP(mk.gain, dbToLin(makeupDb) / chromeCompressorMakeup(T, K, R), t);
    },
  };
}

// ── the builders ──────────────────────────────────────────────────────────────────────────────────────────
type Builder = (env: FxEnv, v: Values) => Unit;

const B: Record<string, Builder> = {
  gain(env) {
    const g = stereo(env.ctx);
    return nodes(g, g, [g], (v, t) => setP(g.gain, dbToLin(num(v.gain)), t));
  },
  silence(env) {
    const g = stereo(env.ctx, 0);
    return nodes(g, g, [g], () => undefined);
  },
  compressor(env) {
    const c = compressor(env.ctx);
    return nodes(c.input, c.output, c.nodes, (v, t) => c.set(num(v.threshold, -24), num(v.ratio, 4), num(v.knee, 2.8), num(v.attack, 0.01), num(v.release, 0.25), num(v.makeup), t));
  },
  limiter(env) {
    const c = compressor(env.ctx);
    return nodes(c.input, c.output, c.nodes, (v, t) => c.set(num(v.ceiling, -1), 20, 0, 0.002, num(v.release, 0.05), 0, t));
  },
  loudness_maximizer(env) {
    const g = stereo(env.ctx), c = compressor(env.ctx);
    g.connect(c.input);
    return nodes(g, c.output, [g, ...c.nodes], (v, t) => { setP(g.gain, dbToLin(num(v.boost, 6)), t); c.set(num(v.ceiling, -1), 20, 0, 0.002, num(v.release, 0.05), 0, t); });
  },
  tube_compressor(env) {
    const c = compressor(env.ctx), sh = clipper(env.ctx);
    c.output.connect(sh.input);
    return nodes(c.input, sh.output, [...c.nodes, ...sh.nodes], (v, t) => {
      const d = num(v.drive, 6);
      // the export runs acompressor's default knee (2.82843 → 9.03 dB wide)
      c.set(num(v.threshold, -18), num(v.ratio, 3), 9.03, num(v.attack, 0.01), num(v.release, 0.2), num(v.makeup), t);
      sh.set("tanh", d, -d);
    });
  },
  gate: (env, v0) => wkUnit(env, "gate", (v) => ({ threshold: num(v.threshold, -50), range: num(v.range, -40), attack: num(v.attack, 0.005), release: num(v.release, 0.12), ratio: num(v.ratio, 10), knee: 2.828427, detection: "peak" }), v0),
  expander: (env, v0) => wkUnit(env, "expander", (v) => ({ threshold: num(v.threshold, -40), ratio: num(v.ratio, 2), attack: num(v.attack, 0.01), release: num(v.release, 0.1) }), v0),
  dc_offset(env) {
    const f = biquad(env.ctx, "highpass", 5, qDb(0.7071));
    return nodes(f, f, [f], (v, t) => setP(f.frequency, num(v.frequency, 5), t));
  },
  eq3(env) {
    const ctx = env.ctx, lo = biquad(ctx, "lowshelf", 200), mid = biquad(ctx, "peaking", 1000, 0.8), hi = biquad(ctx, "highshelf", 4000);
    chain(lo, mid, hi);
    return nodes(lo, hi, [lo, mid, hi], (v, t) => {
      setP(lo.frequency, num(v.lowFreq, 200), t); setP(lo.gain, num(v.low), t);
      setP(mid.frequency, num(v.midFreq, 1000), t); setP(mid.Q, num(v.midQ, 0.8), t); setP(mid.gain, num(v.mid), t);
      setP(hi.frequency, num(v.highFreq, 4000), t); setP(hi.gain, num(v.high), t);
    });
  },
  eq_graphic(env) {
    const f = GRAPHIC_BANDS.map(([, hz]) => biquad(env.ctx, "peaking", hz, GRAPHIC_Q));
    chain(...f);
    return nodes(f[0], f[f.length - 1], f, (v, t) => GRAPHIC_BANDS.forEach(([k], i) => setP(f[i].gain, num(v[k]), t)));
  },
  eq_param(env) {
    const f = Array.from({ length: EQ_PARAM_BANDS }, () => biquad(env.ctx, "peaking", 1000));
    chain(...f);
    return nodes(f[0], f[f.length - 1], f, (v, t) => {
      for (let i = 0; i < EQ_PARAM_BANDS; i++) {
        const k = i + 1, type = str(v[`type${k}`], "off"), b = f[i];
        const fq = num(v[`freq${k}`], 1000), g = num(v[`gain${k}`]), q = num(v[`q${k}`], 1);
        const wt: BiquadFilterType = type === "peak" ? "peaking" : type === "lowshelf" || type === "highshelf" || type === "lowpass" || type === "highpass" || type === "notch" || type === "bandpass" ? type : "peaking";
        if (b.type !== wt) b.type = wt;
        setP(b.frequency, fq, t);
        setP(b.Q, wt === "lowpass" || wt === "highpass" ? qDb(q) : q, t);
        setP(b.gain, type === "off" ? 0 : g, t);
      }
    });
  },
  highpass: (env) => filter(env, "highpass", 80, 0.707),
  lowpass: (env) => filter(env, "lowpass", 12000, 0.707),
  bandpass: (env) => filter(env, "bandpass", 1000, 0.707),
  notch: (env) => filter(env, "notch", 1000, 10),
  dehum(env) {
    const f = Array.from({ length: 8 }, () => biquad(env.ctx, "peaking", 50, 30, 0));
    chain(...f);
    return nodes(f[0], f[7], f, (v, t) => {
      const base = num(v.frequency, 50), h = Math.round(num(v.harmonics, 4)), q = num(v.q, 30);
      f.forEach((b, i) => {
        const on = i < h && base * (i + 1) < env.ctx.sampleRate / 2 - 100;
        const wt: BiquadFilterType = on ? "notch" : "peaking";
        if (b.type !== wt) b.type = wt;
        setP(b.frequency, base * (i + 1), t); setP(b.Q, q, t); setP(b.gain, 0, t);
      });
    });
  },
  tilt(env) {
    // FFmpeg tiltshelf: a high shelf of `gain`, scaled so the lows go down by half of it and the highs up by half
    const hs = biquad(env.ctx, "highshelf", 1000), g = env.ctx.createGain();
    hs.connect(g);
    return nodes(hs, g, [hs, g], (v, t) => { const db = num(v.gain); setP(hs.frequency, num(v.frequency, 1000), t); setP(hs.gain, db, t); setP(g.gain, dbToLin(-db / 2), t); });
  },
  reverb: (env, v0) => reverb(env, v0),
  echo(env) {
    // e(t) = x(t − d) + fb·e(t − d) (aecho's taps k·d at wet·fb^(k−1)). A delay inside a WebAudio cycle runs one render
    // quantum (128 frames) late per trip, so the loop's delay is d minus a quantum; the first tap has its own delay.
    const ctx = env.ctx, input = stereo(ctx), out = stereo(ctx), d1 = ctx.createDelay(2.5), sum = stereo(ctx), loop = ctx.createDelay(2.5), fb = ctx.createGain(), wet = ctx.createGain();
    input.connect(out); input.connect(d1); d1.connect(sum); sum.connect(loop); loop.connect(fb); fb.connect(sum); sum.connect(wet); wet.connect(out);
    const q = 128 / ctx.sampleRate;
    return nodes(input, out, [input, out, d1, sum, loop, fb, wet], (v, t) => {
      const d = num(v.delay, 300) / 1000;
      setP(d1.delayTime, d, t, 0.05); setP(loop.delayTime, Math.max(q, d - q), t, 0.05); setP(fb.gain, num(v.feedback, 0.4), t); setP(wet.gain, num(v.wet, 0.5), t);
    });
  },
  stereo_widen(env) {
    // FFmpeg stereowiden: L' = dry·L − cross·R − fb·R(t − d), R' = dry·R − cross·L − fb·L(t − d)
    const ctx = env.ctx, m = matrix(ctx), d = ctx.createDelay(0.2), sp = ctx.createChannelSplitter(2), gl = ctx.createGain(), gr = ctx.createGain();
    m.input.connect(d); d.connect(sp); sp.connect(gr, 1); sp.connect(gl, 0);
    gr.connect(m.output as ChannelMergerNode, 0, 0); gl.connect(m.output as ChannelMergerNode, 0, 1);
    return nodes(m.input, m.output, [...m.nodes, d, sp, gl, gr], (v, t) => {
      const dry = num(v.drymix, 0.8), x = num(v.crossfeed, 0.3), f = num(v.feedback, 0.3);
      m.set([dry, -x, -x, dry], t); setP(d.delayTime, num(v.delay, 20) / 1000, t, 0.05); setP(gl.gain, -f, t); setP(gr.gain, -f, t);
    });
  },
  haas(env) {
    const ctx = env.ctx, input = stereo(ctx), sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2), dl = ctx.createDelay(0.1), dr = ctx.createDelay(0.1);
    input.connect(sp); sp.connect(dl, 0); sp.connect(dr, 1); dl.connect(mg, 0, 0); dr.connect(mg, 0, 1);
    return nodes(input, mg, [input, sp, mg, dl, dr], (v, t) => {
      const ms = num(v.delay, 15) / 1000, right = str(v.channel, "right") !== "left";
      setP(dl.delayTime, right ? 0 : ms, t, 0.05); setP(dr.delayTime, right ? ms : 0, t, 0.05);
    });
  },
  mono(env) {
    const m = matrix(env.ctx);
    return nodes(m.input, m.output, m.nodes, (v, t) => { const a = num(v.amount, 1); m.set([1 - a / 2, a / 2, a / 2, 1 - a / 2], t); });
  },
  center_extract(env) {
    const m = matrix(env.ctx);
    return nodes(m.input, m.output, m.nodes, (v, t) => {
      // the export's stereotools keeps at least 1/64 of the reduced part
      const a = Math.min(num(v.amount, 1), 1 - 1 / 64), k = str(v.mode, "remove") === "keep" ? 1 : -1;
      m.set([1 - a / 2, (k * a) / 2, (k * a) / 2, 1 - a / 2], t);
    });
  },
  channel_swap(env) { const m = matrix(env.ctx); return nodes(m.input, m.output, m.nodes, (_v, t) => m.set([0, 1, 1, 0], t)); },
  left_only(env) { const m = matrix(env.ctx); return nodes(m.input, m.output, m.nodes, (_v, t) => m.set([1, 0, 1, 0], t)); },
  right_only(env) { const m = matrix(env.ctx); return nodes(m.input, m.output, m.nodes, (_v, t) => m.set([0, 1, 0, 1], t)); },
  invert_polarity(env) {
    const m = matrix(env.ctx);
    return nodes(m.input, m.output, m.nodes, (v, t) => { const c = str(v.channel, "both"); m.set([c === "right" ? 1 : -1, 0, 0, c === "left" ? 1 : -1], t); });
  },
  mono_to_stereo(env) {
    // M = (L + R) / 2; L' = M + w·M(t − d), R' = M − w·M(t − d)
    const ctx = env.ctx, m = matrix(ctx), d = ctx.createDelay(0.1), sp = ctx.createChannelSplitter(2), wl = ctx.createGain(), wr = ctx.createGain();
    const out = stereo(ctx), mg = ctx.createChannelMerger(2);
    // the matrix makes M on both channels; the delayed copy is added on the left and subtracted on the right
    m.output.connect(out); m.output.connect(d); d.connect(sp); sp.connect(wl, 0); sp.connect(wr, 0);
    wl.connect(mg, 0, 0); wr.connect(mg, 0, 1); mg.connect(out);
    return nodes(m.input, out, [...m.nodes, d, sp, wl, wr, mg, out], (v, t) => {
      const w = num(v.width, 0.5);
      m.set([0.5, 0.5, 0.5, 0.5], t); setP(d.delayTime, num(v.delay, 12) / 1000, t, 0.05); setP(wl.gain, w, t); setP(wr.gain, -w, t);
    });
  },
  delay_sync(env) {
    const d = env.ctx.createDelay(1);
    d.channelCount = 2; d.channelCountMode = "explicit";
    return nodes(d, d, [d], (v, t) => setP(d.delayTime, num(v.delay) / 1000, t, 0.05));
  },
  auto_pan(env, v0) {
    // FFmpeg apulsator (sine, offsets 0 / 0.5): gL = 1 − d/2 + (d/2)·sin 2πft, gR = 1 − d/2 − (d/2)·sin 2πft
    const ctx = env.ctx, input = stereo(ctx), sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2), gl = ctx.createGain(), gr = ctx.createGain();
    const o = lfo(ctx, num(v0.rate, 2)), al = ctx.createGain(), ar = ctx.createGain();
    input.connect(sp); sp.connect(gl, 0); sp.connect(gr, 1); gl.connect(mg, 0, 0); gr.connect(mg, 0, 1);
    o.connect(al); o.connect(ar); al.connect(gl.gain); ar.connect(gr.gain);
    return nodes(input, mg, [input, sp, mg, gl, gr, o, al, ar], (v, t) => {
      const d = num(v.depth, 1);
      setP(o.frequency, num(v.rate, 2), t); setP(gl.gain, 1 - d / 2, t); setP(gr.gain, 1 - d / 2, t); setP(al.gain, d / 2, t); setP(ar.gain, -d / 2, t);
    });
  },
  tremolo(env, v0) {
    // FFmpeg tremolo: (1 − d/2) + (d/2)·cos 2πft
    const ctx = env.ctx, g = stereo(ctx), o = lfo(ctx, num(v0.rate, 5), true), a = ctx.createGain();
    o.connect(a); a.connect(g.gain);
    return nodes(g, g, [g, o, a], (v, t) => { const d = num(v.depth, 0.5); setP(o.frequency, num(v.rate, 5), t); setP(g.gain, 1 - d / 2, t); setP(a.gain, d / 2, t); });
  },
  vibrato: (env, v0) => wkUnit(env, "vibrato", (v) => ({ rate: num(v.rate, 5), depth: num(v.depth, 0.5) }), v0),
  // chorus = FFmpeg's flanger with the chorus's base delay, no feedback, mix as its width, then (1 + mix) back up:
  // out = in + mix·in(t − delay − depth·(1 + sin)/2), the two channels a quarter period apart (FFmpeg's chorus filter
  // only modulates 0…depth ms, whatever its delay)
  chorus(env, v0) {
    const f = wkUnit(env, "flanger", (v) => ({ delay: num(v.delay, 25), depth: num(v.depth, 2), regen: 0, width: num(v.mix, 0.5) * 100, speed: num(v.rate, 0.5) }), v0);
    const g = stereo(env.ctx);
    return series(env.ctx, [f, nodes(g, g, [g], (v, t) => setP(g.gain, 1 + num(v.mix, 0.5), t))]);
  },
  flanger: (env, v0) => wkUnit(env, "flanger", (v) => ({ delay: num(v.delay, 0), depth: num(v.depth, 2), regen: num(v.regen, 0), width: num(v.width, 71), speed: num(v.speed, 0.5) }), v0),
  phaser: (env, v0) => wkUnit(env, "phaser", (v) => ({ inGain: num(v.inGain, 0.4), outGain: num(v.outGain, 0.74), delay: num(v.delay, 3), decay: num(v.decay, 0.4), speed: num(v.speed, 0.5), type: str(v.type, "t") }), v0),
  bitcrusher: (env, v0) => wkUnit(env, "crusher", (v) => ({ bits: num(v.bits, 8), samples: num(v.samples, 1), mix: num(v.mix, 1) }), v0),
  distortion(env) {
    const sh = clipper(env.ctx);
    return nodes(sh.input, sh.output, sh.nodes, (v) => sh.set(str(v.type, "tanh"), num(v.drive, 12), num(v.output)));
  },
  lofi(env, v0) {
    const cr = wkUnit(env, "crusher", (v) => ({ bits: num(v.bits, 10), samples: num(v.samples, 3), mix: 1 }), v0);
    const lp = biquad(env.ctx, "lowpass", 5000, qDb(0.7071));
    return series(env.ctx, [cr, nodes(lp, lp, [lp], (v, t) => setP(lp.frequency, num(v.cutoff, 5000), t))]);
  },
  telephone(env) {
    const b = band(env.ctx, 300, 3400);
    return nodes(b.input, b.output, b.nodes, (v, t) => b.set(num(v.low, 300), num(v.high, 3400), t));
  },
  radio: (env) => voiceFx(env, { lo: 200, hi: 5000, stages: 1, clip: "atan", drive: 6, noise: -50, colour: "pink" }),
  megaphone: (env) => voiceFx(env, { lo: 500, hi: 3500, stages: 1, clip: "hard", drive: 12, peak: 6 }),
  walkie_talkie: (env) => voiceFx(env, { lo: 400, hi: 2800, stages: 2, clip: "hard", drive: 18, noise: -40, colour: "white" }),
  underwater(env, v0) {
    const ctx = env.ctx, a = biquad(ctx, "lowpass", 600, qDb(0.7071)), b = biquad(ctx, "lowpass", 600, qDb(0.7071));
    a.connect(b);
    const lp = nodes(a, b, [a, b], (v, t) => { setP(a.frequency, num(v.cutoff, 600), t); setP(b.frequency, num(v.cutoff, 600), t); });
    const wob = wkUnit(env, "vibrato", (v) => ({ rate: 1.2, depth: num(v.wobble, 0.3) * 0.5 }), v0);
    return series(ctx, [lp, wob]);
  },
  next_room(env, v0) {
    const ctx = env.ctx, a = biquad(ctx, "lowpass", 400, qDb(0.7071)), b = biquad(ctx, "lowpass", 400, qDb(0.7071)), lvl = stereo(ctx);
    a.connect(b);
    const lp = nodes(a, b, [a, b], (v, t) => { setP(a.frequency, num(v.cutoff, 400), t); setP(b.frequency, num(v.cutoff, 400), t); });
    const rv = reverb(env, { preset: "room", mix: num(v0.room, 0.35), width: 1, predelay: 0 }, (v) => ({ preset: "room", mix: num(v.room, 0.35), width: 1, predelay: 0 }));
    const out = nodes(lvl, lvl, [lvl], (v, t) => setP(lvl.gain, dbToLin(num(v.level, -6)), t));
    return series(ctx, [lp, rv, out]);
  },
  vinyl(env, v0) {
    const ctx = env.ctx;
    const wow = wkUnit(env, "vibrato", (v) => ({ rate: 0.55, depth: 0.02 + 0.12 * num(v.wow, 0.3) }), v0);
    // crackle: sparse clicks (both channels independent), high-passed at 900 Hz, mixed in
    const input = stereo(ctx), out = stereo(ctx), chp = biquad(ctx, "highpass", 900, qDb(0.7071));
    let src: AudioBufferSourceNode | null = null, amt = -1;
    input.connect(out); chp.connect(out);
    const crackle = nodes(input, out, [input, out, chp], (v) => {
      const c = Math.round(num(v.crackle, 0.5) * 20) / 20;
      if (c === amt) return;
      amt = c;
      if (src) { kill([src]); src = null; }
      if (c > 0) { src = loopSource(ctx, noiseBuffer(ctx, "crackle", c, 2)); src.connect(chp); }
    });
    const disposeCr = crackle.dispose;
    crackle.dispose = () => { if (src) kill([src]); disposeCr(); };
    return series(ctx, [wow, crackle]);
  },
  guitar_amp(env, v0) {
    const ctx = env.ctx;
    // as the export: drive into the clipper, then the tone stack, then the cabinet, then the level
    const bass = biquad(ctx, "lowshelf", 120), mid = biquad(ctx, "peaking", 800, 0.8), treb = biquad(ctx, "highshelf", 3200);
    const sh = clipper(ctx), conv = ctx.createConvolver(), dry = ctx.createGain(), wet = ctx.createGain(), lvl = stereo(ctx);
    conv.normalize = false;
    chain(sh.output, bass, mid, treb);
    treb.connect(conv); conv.connect(wet); wet.connect(lvl); treb.connect(dry); dry.connect(lvl);
    let cab = "";
    return nodes(sh.input, lvl, [bass, mid, treb, ...sh.nodes, conv, dry, wet, lvl], (v, t) => {
      setP(bass.gain, num(v.bass), t); setP(mid.gain, num(v.mid), t); setP(treb.gain, num(v.treble), t);
      sh.set(str(v.type, "tanh"), num(v.drive, 24), 0);
      setP(lvl.gain, dbToLin(num(v.level, -12)), t);
      const c = str(v.cabinet, String(v0.cabinet ?? "cab_4x12"));
      if (c !== cab) {
        cab = c;
        const none = c === "none";
        setP(dry.gain, none ? 1 : 0, t); setP(wet.gain, none ? 0 : 1, t);
        if (!none) void env.ir(c).then((b) => { if (b && cab === c) try { conv.buffer = b; } catch { /* rate */ } });
      }
    });
  },
  doppler(env) {
    // a delay line follows the distance (that is the pitch change), then a constant-power pan of the mono sum
    const ctx = env.ctx, m = matrix(ctx), d = ctx.createDelay(4), g = ctx.createGain();
    m.output.connect(d); d.connect(g);
    return nodes(m.input, g, [...m.nodes, d, g], (v, t) => {
      const p = dopplerAt({ path: str(v.path, "pass_lr"), speed: num(v.speed, 20), distance: num(v.distance, 3), center: num(v.center, 0.5) }, t.local, t.duration);
      const th = ((p.pan + 1) * Math.PI) / 4, l = Math.cos(th) * Math.SQRT2 * 0.5, r = Math.sin(th) * Math.SQRT2 * 0.5;
      m.set([l, l, r, r], t); setP(d.delayTime, Math.min(3.9, p.delay), t, 0.02); setP(g.gain, p.gain, t, 0.02);
    }, true);
  },
};
B.invert = B.invert_polarity;

function filter(env: FxEnv, type: BiquadFilterType, f0: number, q0: number): Unit {
  const b = biquad(env.ctx, type, f0, type === "lowpass" || type === "highpass" ? qDb(q0) : q0);
  return nodes(b, b, [b], (v, t) => {
    setP(b.frequency, num(v.frequency, f0), t);
    const q = num(v.q, q0);
    setP(b.Q, type === "lowpass" || type === "highpass" ? qDb(q) : q, t);
  });
}

/** reverb: dry·(1 − mix) + mix · width(convolve(predelay(x), IR)). */
function reverb(env: FxEnv, v0: Values, map: (v: Values) => Values = (v) => v): Unit {
  const ctx = env.ctx, input = stereo(ctx), out = stereo(ctx), dry = ctx.createGain(), pre = ctx.createDelay(0.5), conv = ctx.createConvolver(), w = matrix(ctx), wet = ctx.createGain();
  conv.normalize = false;
  input.connect(dry); dry.connect(out);
  input.connect(pre); pre.connect(conv); conv.connect(w.input); w.output.connect(wet); wet.connect(out);
  let preset = "";
  return nodes(input, out, [input, out, dry, pre, conv, ...w.nodes, wet], (raw, t) => {
    const v = map(raw);
    const mix = num(v.mix, 0.3), width = num(v.width, 1);
    setP(dry.gain, 1 - mix, t); setP(wet.gain, mix, t); setP(pre.delayTime, num(v.predelay) / 1000, t, 0.05);
    w.set([(1 + width) / 2, (1 - width) / 2, (1 - width) / 2, (1 + width) / 2], t);
    const p = str(v.preset, String(v0.preset ?? "room"));
    if (p !== preset) {
      preset = p;
      void env.ir(p).then((b) => { if (b && preset === p) try { conv.buffer = b; } catch { /* rate */ } });
    }
  });
}

/** radio / megaphone / walkie-talkie, as the export: band-limit (1 or 2 stages), a presence bump, drive into a clipper
 *  and half of it back, static (anoisesrc at `noise` dBFS amplitude). */
function voiceFx(env: FxEnv, d: { lo: number; hi: number; stages: 1 | 2; clip: string; drive: number; noise?: number; peak?: number; colour?: "white" | "pink" }): Unit {
  const ctx = env.ctx, b = band(ctx, d.lo, d.hi, d.stages), pk = biquad(ctx, "peaking", 1800, 1, d.peak ?? 0), sh = clipper(ctx), out = stereo(ctx), ng = ctx.createGain();
  b.output.connect(pk); pk.connect(sh.input); sh.output.connect(out);
  let src: AudioBufferSourceNode | null = null;
  if (d.noise !== undefined) { src = loopSource(ctx, noiseBuffer(ctx, d.colour ?? "white")); src.connect(ng); ng.connect(out); }
  return nodes(b.input, out, [...b.nodes, pk, ...sh.nodes, out, ng, ...(src ? [src] : [])], (v, t) => {
    b.set(num(v.low, d.lo), num(v.high, d.hi), t);
    const dr = num(v.drive, d.drive);
    sh.set(d.clip, dr, -dr / 2);
    if (src) setP(ng.gain, num(v.noise, d.noise ?? -90) <= -90 ? 0 : dbToLin(num(v.noise, d.noise ?? -60)), t);
  });
}

/** The WebAudio unit of a realtime effect id (null: a "cache" effect, or not an audio effect). */
export function buildUnit(env: FxEnv, typeOrId: string, values: Values): Unit | null {
  const def = audioFxDef(typeOrId);
  if (!def || def.preview !== "realtime") return null;
  const b = B[implId(def.id)] ?? B[def.id];
  if (!b) return null;
  return b(env, values);
}
export const hasRealtime = (id: string) => !!B[implId(id)] || !!B[id];

// ── a chain of effects ──────────────────────────────────────────────────────────────────────────────────────
export interface ChainItem { key: string; id: string; values: Values }

/** An ordered list of effects between `input` and `output` (stereo). */
export class FxChain {
  readonly input: GainNode; readonly output: GainNode;
  private units: { key: string; id: string; unit: Unit; last: string }[] = [];
  private shape = "";
  private items: ChainItem[] = [];
  private lastTick: Tick | null = null;
  constructor(private env: FxEnv) {
    this.input = stereo(env.ctx); this.output = stereo(env.ctx);
    this.input.connect(this.output);
    if (!env.worklets) env.onReady(() => { this.shape = ""; if (this.lastTick) this.set(this.items, this.lastTick); });
  }
  get size() { return this.units.length; }
  /** Rebuilds when the effect list's shape changes; then applies the values (only the ones that changed, unless an
   *  effect moves with time). */
  set(items: ChainItem[], t: Tick) {
    this.items = items; this.lastTick = t;
    const live = items.filter((i) => hasRealtime(i.id));
    const shape = live.map((i) => `${i.key}:${i.id}`).join("|") + (this.env.worklets ? "+w" : "");
    if (shape !== this.shape) {
      this.shape = shape;
      try { this.input.disconnect(); } catch { /* none */ }
      for (const u of this.units) u.unit.dispose();
      this.units = [];
      let head: AudioNode = this.input;
      for (const it of live) {
        const unit = buildUnit(this.env, it.id, it.values);
        if (!unit) continue;
        head.connect(unit.input);
        head = unit.output;
        this.units.push({ key: it.key, id: it.id, unit, last: "" });
      }
      head.connect(this.output);
    }
    const imm = { ...t };
    for (const u of this.units) {
      const it = live.find((x) => x.key === u.key);
      if (!it) continue;
      const sig = JSON.stringify(it.values);
      if (sig !== u.last || u.unit.timeVarying) {
        u.unit.update(it.values, u.last ? t : { ...imm, immediate: true });
        u.last = sig;
      }
    }
  }
  dispose() {
    for (const u of this.units) u.unit.dispose();
    this.units = [];
    kill([this.input, this.output]);
  }
}
