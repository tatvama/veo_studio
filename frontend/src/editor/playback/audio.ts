/**
 * The sequence's sound in the preview (WebAudio, docs/EDITOR.md §11): one MediaElementAudioSourceNode per clip near
 * the playhead → the clip's audio effects (audiofx/graph.ts, keyframed) → its gain (level keyframes, fades, crossfades
 * with the transitions' acrossfade curves) and pan → its track's fader, pan, mute / solo and the track's effects →
 * the mix bus → the master effects → the meters (loudness, true peak, correlation, spectrum) → the monitoring level.
 * A clip with an effect WebAudio can't do the export's way plays the desktop's render of it (audiofx/cache.ts)
 * instead of its source. Generator clips (tone, noise, DTMF) play a buffer rendered here with the export's formulas.
 * Elements follow the program clock (re-seeked when they drift); a reversed clip plays a reversed copy of its decoded
 * sound. Shuttling backwards or faster than 4× plays silent. The context runs at 48 kHz like the export.
 */
import { audioCache } from "../audiofx/cache";
import { fxEnv, FxChain, type ChainItem, type FxEnv, type Values } from "../audiofx/graph";
import { generatorKey, renderGenerator } from "../audiofx/generators";
import { clipGainCurve, fxPlan, isCacheFx, sampleAt, valuesAt, type ClipFx, type FxPlan, type FxRef, type GeneratorClip } from "../audiofx/plan";
import { sampleKeys, type AudioClipPlan, type AudioMix } from "../model/toComposition";
import { project } from "../store";
import { ByteLru } from "./lru";

interface TrackNode { gain: GainNode; pan: StereoPannerNode; fx: FxChain; an: AnalyserNode }
interface Voice { el: HTMLAudioElement; src: MediaElementAudioSourceNode; fx: FxChain; gain: GainNode; pan: StereoPannerNode; url: string; cached: boolean; trackId: string; plan: AudioClipPlan; lastUse: number }

const dbToLin = (db: number) => (db <= -96 ? 0 : Math.pow(10, db / 20));

/** A reversed clip's sound: its span of the decoded file, backwards, and the node playing it now. */
interface RevVoice { buf: AudioBuffer | null; loading: boolean; key: string; node: AudioBufferSourceNode | null; startedAt: number; offset: number; rate: number;
  fx: FxChain; gain: GainNode; pan: StereoPannerNode; trackId: string; plan: AudioClipPlan }
/** A generator clip: its rendered sound and the node playing it now. */
interface GenVoice { buf: AudioBuffer | null; key: string; node: AudioBufferSourceNode | null; startedAt: number; offset: number; rate: number;
  fx: FxChain; gain: GainNode; pan: StereoPannerNode; trackId: string; g: GeneratorClip;
  /** The desktop's render of it (effects and level baked in) when it has "cache" effects. */
  cacheUrl: string | null }
const decoded = new Map<string, Promise<AudioBuffer | null>>();
const POOL = 24;
const MAX_GEN_S = 600;
/** Rendered generator sounds kept, in bytes (a 600 s mono buffer at 48 kHz is 115 MB; a count cap let 16 of them pile up). */
const GEN_BUDGET = 256 * 1024 * 1024;
const bufferBytes = (b: AudioBuffer) => b.length * b.numberOfChannels * 4;

/** The master meters: BS.1770 loudness (LUFS), true peak (dBTP), sample peak (dBFS) and phase correlation. */
export interface Loudness { m: number; s: number; i: number; tp: number; tpNow: number; peak: number; corr: number }

export class Mixer {
  ctx: AudioContext | null = null;
  private env: FxEnv | null = null;
  /** Tracks sum here; then the master effects, the meters and the monitoring level. */
  private bus: GainNode | null = null;
  private masterFx: FxChain | null = null;
  private post: GainNode | null = null;
  private master: GainNode | null = null;
  private masterAn: AnalyserNode | null = null;
  private spec: AnalyserNode | null = null;
  private meterNode: AudioWorkletNode | null = null;
  private tracks = new Map<string, TrackNode>();
  private voices = new Map<string, Voice>();
  private revs = new Map<string, RevVoice>();
  private gens = new Map<string, GenVoice>();
  private genBufs = new ByteLru<AudioBuffer>(GEN_BUDGET, bufferBytes);
  private mix: AudioMix | null = null;
  private fx: FxPlan = { fps: 25, clips: new Map(), tracks: new Map(), master: [], generators: [] };
  private seqId = "";
  private buf = new Float32Array(1024);
  private loudListeners = new Set<(l: Loudness) => void>();
  private lastT = 0;
  loud: Loudness | null = null;
  masterDb = 0;
  muted = false;

  constructor() {
    // a render finished (or started): the voices of those clips switch source
    audioCache.subscribe(() => { if (this.mix) this.setMix(this.mix); });
  }

  /** Creates (or resumes) the AudioContext: call from a user gesture (play). */
  wake() {
    if (!this.ctx) {
      try {
        try { this.ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 }); } catch { this.ctx = new AudioContext({ latencyHint: "interactive" }); }
        const ctx = this.ctx;
        this.env = fxEnv(ctx);
        this.bus = ctx.createGain();
        this.masterFx = new FxChain(this.env);
        this.post = ctx.createGain();
        this.master = ctx.createGain();
        this.masterAn = ctx.createAnalyser();
        this.masterAn.fftSize = 1024;
        this.spec = ctx.createAnalyser();
        this.spec.fftSize = 8192; this.spec.smoothingTimeConstant = 0.55; this.spec.minDecibels = -110; this.spec.maxDecibels = 0;
        this.bus.connect(this.masterFx.input);
        this.masterFx.output.connect(this.post);
        this.post.connect(this.spec);
        this.post.connect(this.master);
        this.master.connect(this.masterAn);
        this.masterAn.connect(ctx.destination);
        this.master.gain.value = dbToLin(this.masterDb);
        void this.env.ready.then((ok) => { if (ok) this.startMeter(); });
        if (this.mix) this.setMix(this.mix);
      } catch { this.ctx = null; return; }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  private startMeter() {
    if (!this.ctx || !this.post || this.meterNode) return;
    try {
      const n = new AudioWorkletNode(this.ctx, "tatvam-meter", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: "explicit" });
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      this.post.connect(n); n.connect(sink); sink.connect(this.ctx.destination);
      n.port.onmessage = (e: MessageEvent<Loudness>) => { this.loud = e.data; for (const l of this.loudListeners) l(e.data); };
      this.meterNode = n;
    } catch { /* no worklet */ }
  }
  /** Loudness readings, ten a second while the context runs. */
  onLoudness(cb: (l: Loudness) => void) { this.loudListeners.add(cb); return () => { this.loudListeners.delete(cb); }; }
  /** Starts the integrated loudness (and the true-peak hold) again. */
  resetLoudness() { this.meterNode?.port.postMessage({ reset: true }); }
  /** The spectrum analyser on the mix (after the master effects, before the monitoring level). */
  analyser(): AnalyserNode | null { return this.spec; }

  setMaster(db: number) { this.masterDb = db; if (this.master && this.ctx) this.master.gain.setTargetAtTime(dbToLin(db), this.ctx.currentTime, 0.02); }

  /** Where a clip's sound comes from now: the render cache when it has effects that need it and the render is ready. */
  private source(p: AudioClipPlan): { url: string; cached: boolean; duration?: number } {
    const info = this.fx.clips.get(p.clipId);
    if (info?.cache) {
      const e = audioCache.want(p.clipId, info.key, this.seqId);
      if (e.status === "ready" && e.url) return { url: e.url, cached: true, duration: e.duration };
    }
    return { url: p.url, cached: false };
  }

  setMix(mix: AudioMix) {
    this.mix = mix;
    const p = project();
    this.seqId = p.activeSequenceId;
    this.fx = fxPlan(p, this.seqId);
    const ids = new Set(mix.clips.map((c) => c.clipId));
    for (const [id, r] of this.revs) {
      const plan = mix.clips.find((c) => c.clipId === id);
      if (!plan || !plan.reverse || plan.trackId !== r.trackId || this.source(plan).cached) this.dropRev(id); else r.plan = plan;
    }
    for (const [id, v] of this.voices) {
      const plan = mix.clips.find((c) => c.clipId === id);
      const src = plan ? this.source(plan) : null;
      if (!ids.has(id) || !plan || !src || src.url !== v.url || plan.trackId !== v.trackId) this.drop(id);
      else v.plan = plan;
    }
    const gids = new Set(this.fx.generators.map((g) => g.clipId));
    for (const [id, g] of this.gens) {
      const ng = this.fx.generators.find((x) => x.clipId === id);
      if (!gids.has(id) || !ng || ng.trackId !== g.trackId) this.dropGen(id); else g.g = ng;
    }
    for (const t of mix.tracks) this.track(t.id);
    if (this.ctx) this.applyTrackFx(this.lastT, true);
  }

  private track(id: string): TrackNode | null {
    if (!this.ctx || !this.bus || !this.env) return null;
    let t = this.tracks.get(id);
    if (!t) {
      const gain = this.ctx.createGain(), pan = this.ctx.createStereoPanner(), fx = new FxChain(this.env), an = this.ctx.createAnalyser();
      an.fftSize = 1024;
      gain.connect(pan); pan.connect(fx.input); fx.output.connect(an); an.connect(this.bus);
      t = { gain, pan, fx, an };
      this.tracks.set(id, t);
    }
    return t;
  }

  /** The chain items of a list of effects at a frame (realtime ones; "cache" ones are the render's). */
  private items(fx: FxRef[], frame: number): ChainItem[] {
    return fx.filter((r) => !isCacheFx(r)).map((r) => ({ key: r.key, id: r.id, values: valuesAt(r.effect, r.id, frame) as Values }));
  }

  private applyTrackFx(t: number, immediate = false) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime, frame = Math.round(t * this.fx.fps);
    const tick = { now, local: t, duration: this.mix?.duration ?? 0, immediate };
    for (const [id, n] of this.tracks) n.fx.set(this.items(this.fx.tracks.get(id) ?? [], frame), tick);
    this.masterFx?.set(this.items(this.fx.master, frame), tick);
  }

  /** A clip voice's effects at `local` seconds into its plan. */
  private clipFx(chain: FxChain, info: ClipFx | undefined, p: { start: number; duration: number }, local: number, cached: boolean) {
    if (!this.ctx) return;
    const pre = info ? Math.max(0, info.startS - p.start) : 0;
    const lc = local - pre;
    const items = cached || !info ? [] : this.items(info.fx, Math.round(lc * this.fx.fps));
    chain.set(items, { now: this.ctx.currentTime, local: lc, duration: p.duration - pre });
  }

  private voice(plan: AudioClipPlan): Voice | null {
    if (!this.ctx || !this.env) return null;
    let v = this.voices.get(plan.clipId);
    if (v) { v.lastUse = performance.now(); return v; }
    const t = this.track(plan.trackId);
    if (!t) return null;
    if (this.voices.size >= POOL) {
      const old = [...this.voices.entries()].sort((a, b) => a[1].lastUse - b[1].lastUse)[0];
      if (old) this.drop(old[0]);
    }
    const s = this.source(plan);
    const el = new Audio();
    el.preload = "auto";
    el.crossOrigin = "use-credentials";
    el.src = s.url;
    let src: MediaElementAudioSourceNode;
    try { src = this.ctx.createMediaElementSource(el); } catch { return null; }
    const fx = new FxChain(this.env), gain = this.ctx.createGain(), pan = this.ctx.createStereoPanner();
    gain.gain.value = 0;
    src.connect(fx.input); fx.output.connect(gain); gain.connect(pan); pan.connect(t.gain);
    v = { el, src, fx, gain, pan, url: s.url, cached: s.cached, trackId: plan.trackId, plan, lastUse: performance.now() };
    this.voices.set(plan.clipId, v);
    return v;
  }

  private drop(id: string) {
    const v = this.voices.get(id);
    if (!v) return;
    try { v.el.pause(); v.el.removeAttribute("src"); v.el.load(); } catch { /* gone */ }
    try { v.src.disconnect(); v.gain.disconnect(); v.pan.disconnect(); v.fx.dispose(); } catch { /* gone */ }
    this.voices.delete(id);
  }

  private decode(url: string): Promise<AudioBuffer | null> {
    let p = decoded.get(url);
    if (!p && this.ctx) {
      const ctx = this.ctx;
      p = fetch(url, { credentials: "include" }).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))).then((b) => ctx.decodeAudioData(b)).catch(() => null);
      decoded.set(url, p);
      if (decoded.size > 12) decoded.delete(decoded.keys().next().value as string);
    }
    return p ?? Promise.resolve(null);
  }

  /** The reversed copy of [in, in + duration·rate] source seconds (built once per span). */
  private rev(p: AudioClipPlan): RevVoice | null {
    if (!this.ctx || !this.env) return null;
    const t = this.track(p.trackId);
    if (!t) return null;
    const key = `${p.url}|${p.in.toFixed(3)}|${(p.duration * p.rate).toFixed(3)}`;
    let r = this.revs.get(p.clipId);
    if (r && r.key !== key) { this.dropRev(p.clipId); r = undefined; }
    if (!r) {
      const fx = new FxChain(this.env), gain = this.ctx.createGain(), pan = this.ctx.createStereoPanner();
      gain.gain.value = 0; fx.output.connect(gain); gain.connect(pan); pan.connect(t.gain);
      r = { buf: null, loading: true, key, node: null, startedAt: 0, offset: 0, rate: 1, fx, gain, pan, trackId: p.trackId, plan: p };
      this.revs.set(p.clipId, r);
      const rv = r;
      void this.decode(p.url).then((src) => {
        if (!src || !this.ctx || this.revs.get(p.clipId) !== rv) { rv.loading = false; return; }
        const a = Math.max(0, Math.floor(p.in * src.sampleRate)), n = Math.max(1, Math.min(src.length - a, Math.ceil(p.duration * p.rate * src.sampleRate)));
        const out = this.ctx.createBuffer(src.numberOfChannels, n, src.sampleRate);
        for (let ch = 0; ch < src.numberOfChannels; ch++) {
          const from = src.getChannelData(ch), to = out.getChannelData(ch);
          for (let i = 0; i < n; i++) to[i] = from[a + n - 1 - i] ?? 0;
        }
        rv.buf = out; rv.loading = false;
      });
    }
    return r;
  }
  private stopNode(r: { node: AudioBufferSourceNode | null }) { if (r.node) { try { r.node.stop(); } catch { /* ended */ } r.node.disconnect(); r.node = null; } }
  private dropRev(id: string) { const r = this.revs.get(id); if (!r) return; this.stopNode(r); try { r.gain.disconnect(); r.pan.disconnect(); r.fx.dispose(); } catch { /* gone */ } this.revs.delete(id); }

  /** A generator clip's voice (its sound rendered once per settings and length). */
  private gen(g: GeneratorClip): GenVoice | null {
    if (!this.ctx || !this.env) return null;
    const t = this.track(g.trackId);
    if (!t) return null;
    const secs = Math.min(MAX_GEN_S, g.duration);
    const info = this.fx.clips.get(g.clipId);
    const entry = info?.cache ? audioCache.want(g.clipId, info.key, this.seqId) : null;
    const cacheUrl = entry?.status === "ready" && entry.url ? entry.url : null;
    const key = cacheUrl ? `cache|${cacheUrl}` : generatorKey(g.generator, g.values, secs);
    let v = this.gens.get(g.clipId);
    if (v && v.key !== key) { this.stopNode(v); v.buf = null; v.key = key; v.cacheUrl = cacheUrl; }
    if (!v) {
      const fx = new FxChain(this.env), gain = this.ctx.createGain(), pan = this.ctx.createStereoPanner();
      gain.gain.value = 0; fx.output.connect(gain); gain.connect(pan); pan.connect(t.gain);
      v = { buf: null, key, node: null, startedAt: 0, offset: 0, rate: 1, fx, gain, pan, trackId: g.trackId, g, cacheUrl };
      this.gens.set(g.clipId, v);
    }
    if (!v.buf && v.cacheUrl) {
      const gv = v, url = v.cacheUrl;
      void this.decode(url).then((b) => { if (b && gv.cacheUrl === url) gv.buf = b; });
    } else if (!v.buf) {
      let b = this.genBufs.get(key);
      if (!b) {
        const data = renderGenerator(g.generator, g.values, this.ctx.sampleRate, secs);
        b = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
        b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
        this.genBufs.set(key, b);
      }
      v.buf = b;
    }
    return v;
  }
  private dropGen(id: string) { const g = this.gens.get(id); if (!g) return; this.stopNode(g); try { g.gain.disconnect(); g.pan.disconnect(); g.fx.dispose(); } catch { /* gone */ } this.gens.delete(id); }

  /** Plays (or keeps playing) a buffer voice at `want` seconds and `speed`, restarting it when it drifts. */
  private playBuffer(r: { buf: AudioBuffer | null; node: AudioBufferSourceNode | null; startedAt: number; offset: number; rate: number; fx: FxChain }, want: number, speed: number) {
    if (!this.ctx || !r.buf) return;
    const now = this.ctx.currentTime;
    const pos = r.node ? r.offset + (now - r.startedAt) * r.rate : -1;
    if (!r.node || Math.abs(pos - want) > 0.12 || Math.abs(r.rate - speed) > 1e-3) {
      this.stopNode(r);
      const node = this.ctx.createBufferSource();
      node.buffer = r.buf; node.playbackRate.value = speed; node.connect(r.fx.input);
      node.start(0, Math.max(0, Math.min(r.buf.duration - 0.01, want)));
      r.node = node; r.startedAt = now; r.offset = want; r.rate = speed;
    }
  }

  /** The gain of a clip at `local` seconds into its plan, with its transitions' curves. */
  private gainOf(p: AudioClipPlan, local: number): number {
    const info = this.fx.clips.get(p.clipId);
    if (!info) return clipGainCurve(p, local, p.xIn?.curve === "gain" ? "tri" : "qsin", p.xOut?.curve === "gain" ? "tri" : "qsin");
    return clipGainCurve(p, local, info.curveIn, info.curveOut, p.xIn ? "tri" : info.curveIn, p.xOut ? "tri" : info.curveOut);
  }

  /** Follows the program clock: `t` seconds on the sequence. */
  sync(t: number, playing: boolean, rate: number) {
    const mix = this.mix;
    if (!mix || !this.ctx) return;
    this.lastT = t;
    const now = this.ctx.currentTime;
    const audibleRate = playing && rate > 0 && rate <= 4 && !this.muted;
    for (const tr of mix.tracks) {
      const n = this.track(tr.id);
      if (!n) continue;
      n.gain.gain.setTargetAtTime(tr.audible ? dbToLin(tr.volume) : 0, now, 0.02);
      n.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, tr.pan)), now, 0.02);
    }
    this.applyTrackFx(t);
    for (const p of mix.clips) {
      const local = t - p.start;
      const info = this.fx.clips.get(p.clipId);
      const src = this.source(p);
      if (p.reverse && !src.cached) {
        const inside = local >= 0 && local < p.duration;
        const r = inside || this.revs.has(p.clipId) ? this.rev(p) : null;
        if (!r) continue;
        const want = local * p.rate;  // seconds into the reversed copy
        const speed = Math.max(0.0625, Math.min(16, rate * p.rate));
        if (audibleRate && inside && r.buf) {
          this.playBuffer(r, want, speed);
          this.clipFx(r.fx, info, p, local, false);
          r.gain.gain.setTargetAtTime(this.gainOf(p, local), now, 0.012);
          r.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, sampleKeys(p.pan, local))), now, 0.02);
        } else { this.stopNode(r); r.gain.gain.setTargetAtTime(0, now, 0.01); }
        continue;
      }
      const near = local > -1.2 && local < p.duration + 0.2;
      const v = near ? this.voice(p) : this.voices.get(p.clipId);
      if (!v) continue;
      this.clipFx(v.fx, info, p, local, v.cached);
      const el = v.el;
      // a cached render starts at the clip's own start (no crossfade handle) with the speed baked in
      const pre = info ? Math.max(0, info.startS - p.start) : 0;
      const inside = v.cached ? local >= pre && local < p.duration && local - pre < (src.duration ?? Infinity) : local >= 0 && local < p.duration;
      const want = v.cached ? Math.max(0, local - pre) : Math.max(0, p.in + Math.max(0, Math.min(p.duration, local)) * p.rate);
      if (audibleRate && inside) {
        el.playbackRate = Math.max(0.0625, Math.min(16, rate * (v.cached ? 1 : p.rate)));
        if (Math.abs(el.currentTime - want) > 0.12) { try { el.currentTime = want; } catch { /* not seekable yet */ } }
        if (el.paused) void el.play().catch(() => undefined);
        v.gain.gain.setTargetAtTime(this.gainOf(p, local), now, 0.012);
        v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, sampleKeys(p.pan, local))), now, 0.02);
      } else {
        if (!el.paused) el.pause();
        v.gain.gain.setTargetAtTime(0, now, 0.01);
        if (Math.abs(el.currentTime - want) > 0.05 && el.readyState > 0) { try { el.currentTime = want; } catch { /* fine */ } }
      }
    }
    const tracks = new Map(mix.tracks.map((x) => [x.id, x]));
    for (const g of this.fx.generators) {
      const local = t - g.start;
      const inside = local >= 0 && local < g.duration;
      if (!inside && !this.gens.has(g.clipId)) continue;
      if (!tracks.has(g.trackId)) continue;
      const v = this.gen(g);
      if (!v) continue;
      if (audibleRate && inside && local < MAX_GEN_S) {
        this.playBuffer(v, local, Math.max(0.0625, Math.min(16, rate)));
        // the desktop's render has the effects and the level in it
        const fxi = v.cacheUrl ? [] : this.items(g.fx, Math.round(local * this.fx.fps));
        v.fx.set(fxi, { now, local, duration: g.duration });
        const lvl = v.cacheUrl ? 1 : Math.pow(10, Math.max(-90, Math.min(0, sampleAt(g.level, local))) / 20);
        v.gain.gain.setTargetAtTime(lvl * clipGainCurve({ duration: g.duration, gain: g.gain, fadeIn: g.fadeIn, fadeOut: g.fadeOut }, local), now, 0.012);
        v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, sampleAt(g.pan, local))), now, 0.02);
      } else { this.stopNode(v); v.gain.gain.setTargetAtTime(0, now, 0.01); }
    }
  }

  stopAll() {
    for (const v of this.voices.values()) { v.el.pause(); if (this.ctx) v.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01); }
    for (const r of this.revs.values()) this.stopNode(r);
    for (const g of this.gens.values()) this.stopNode(g);
  }

  private peak(an: AnalyserNode): number {
    an.getFloatTimeDomainData(this.buf);
    let m = 0;
    for (let i = 0; i < this.buf.length; i++) { const a = Math.abs(this.buf[i]); if (a > m) m = a; }
    return m;
  }
  /** Peak levels (linear 0..1+) per track and of the master, right now. */
  meters(): { tracks: Record<string, number>; master: number } {
    const out: Record<string, number> = {};
    for (const [id, t] of this.tracks) out[id] = this.peak(t.an);
    return { tracks: out, master: this.masterAn ? this.peak(this.masterAn) : 0 };
  }

  /** How a clip's sound is previewed now (the AudioEffects panel's badge). */
  clipPreview(clipId: string): "live" | "cache" | "rendering" | "unavailable" | "error" | "none" {
    const info = this.fx.clips.get(clipId);
    if (!info?.cache) return info?.fx.length ? "live" : "none";
    const e = audioCache.get(clipId);
    return !e ? "rendering" : e.status === "ready" ? "cache" : e.status === "waiting" || e.status === "rendering" ? "rendering" : e.status;
  }

  dispose() {
    for (const id of [...this.voices.keys()]) this.drop(id);
    for (const id of [...this.revs.keys()]) this.dropRev(id);
    for (const id of [...this.gens.keys()]) this.dropGen(id);
    for (const t of this.tracks.values()) t.fx.dispose();
    this.masterFx?.dispose();
    try { this.meterNode?.port.postMessage({ stop: true }); void this.ctx?.close(); } catch { /* closed */ }
    this.ctx = null; this.env = null; this.bus = null; this.masterFx = null; this.post = null; this.master = null; this.masterAn = null; this.spec = null; this.meterNode = null;
    this.tracks.clear();
  }
}

/** The program's mixer (one per window). */
export const mixer = new Mixer();

// measurements (QA drivers over CDP): the offline renderer of the preview's effect chain, opt-in per browser profile
if (typeof window !== "undefined") {
  try {
    if (localStorage.getItem("tatvam-editor:debug") === "1") {
      void Promise.all([import("../audiofx/offline"), import("../audiofx/registry"), import("../audiofx/loudness"), import("../audiofx/actions"), import("../audiofx/stack")])
        .then(([off, reg, loud, actions, stack]) => {
          (window as unknown as Record<string, unknown>).__tatvamAudio = { mixer, renderOffline: off.renderOffline, registry: reg, loudness: loud, actions, stack };
        });
    }
  } catch { /* storage blocked */ }
}
