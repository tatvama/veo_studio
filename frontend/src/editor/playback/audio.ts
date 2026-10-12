/**
 * The sequence's sound in the preview (WebAudio): one MediaElementAudioSourceNode per clip near the playhead →
 * the clip's effects (gain, 3-band EQ, compressor, limiter) → its gain (level keyframes, fades, crossfades) and pan →
 * its track's fader, pan, mute / solo → the master. Elements follow the program clock (re-seeked when they drift);
 * AnalyserNodes feed the Audio Mixer's peak meters. Reverse and shuttle faster than 4× play silent.
 */
import { clipGainAt, sampleKeys, type AudioClipPlan, type AudioMix } from "../model/toComposition";

interface TrackNode { gain: GainNode; pan: StereoPannerNode; an: AnalyserNode }
interface Voice { el: HTMLAudioElement; src: MediaElementAudioSourceNode; head: AudioNode; gain: GainNode; pan: StereoPannerNode; fx: AudioNode[]; fxKey: string; url: string; trackId: string; plan: AudioClipPlan; lastUse: number }

const dbToLin = (db: number) => (db <= -96 ? 0 : Math.pow(10, db / 20));
const POOL = 24;

export class Mixer {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterAn: AnalyserNode | null = null;
  private tracks = new Map<string, TrackNode>();
  private voices = new Map<string, Voice>();
  private mix: AudioMix | null = null;
  private buf = new Float32Array(1024);
  masterDb = 0;
  muted = false;

  /** Creates (or resumes) the AudioContext: call from a user gesture (play). */
  wake() {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ latencyHint: "interactive" });
        this.master = this.ctx.createGain();
        this.masterAn = this.ctx.createAnalyser();
        this.masterAn.fftSize = 1024;
        this.master.connect(this.masterAn);
        this.masterAn.connect(this.ctx.destination);
        this.master.gain.value = dbToLin(this.masterDb);
      } catch { this.ctx = null; return; }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setMaster(db: number) { this.masterDb = db; if (this.master && this.ctx) this.master.gain.setTargetAtTime(dbToLin(db), this.ctx.currentTime, 0.02); }

  setMix(mix: AudioMix) {
    this.mix = mix;
    const ids = new Set(mix.clips.map((c) => c.clipId));
    for (const [id, v] of this.voices) {
      const plan = mix.clips.find((c) => c.clipId === id);
      if (!ids.has(id) || !plan || plan.url !== v.url || plan.trackId !== v.trackId) this.drop(id);
      else v.plan = plan;
    }
    for (const t of mix.tracks) this.track(t.id);
  }

  private track(id: string): TrackNode | null {
    if (!this.ctx || !this.master) return null;
    let t = this.tracks.get(id);
    if (!t) {
      const gain = this.ctx.createGain(), pan = this.ctx.createStereoPanner(), an = this.ctx.createAnalyser();
      an.fftSize = 1024;
      gain.connect(pan); pan.connect(an); an.connect(this.master);
      t = { gain, pan, an };
      this.tracks.set(id, t);
    }
    return t;
  }

  private fxChain(v: Voice) {
    const ctx = this.ctx!;
    const key = JSON.stringify(v.plan.effects);
    if (key === v.fxKey) return;
    v.src.disconnect();
    for (const n of v.fx) n.disconnect();
    v.fx = [];
    let head: AudioNode = v.src;
    for (const e of v.plan.effects) {
      const p = e.params as Record<string, number>;
      if (e.type === "audio:gain") { const g = ctx.createGain(); g.gain.value = dbToLin(p.gain ?? 0); v.fx.push(g); }
      else if (e.type === "audio:eq") {
        const lo = ctx.createBiquadFilter(); lo.type = "lowshelf"; lo.frequency.value = 200; lo.gain.value = p.low ?? 0;
        const mid = ctx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 0.8; mid.gain.value = p.mid ?? 0;
        const hi = ctx.createBiquadFilter(); hi.type = "highshelf"; hi.frequency.value = 4000; hi.gain.value = p.high ?? 0;
        v.fx.push(lo, mid, hi);
      } else if (e.type === "audio:compressor" || e.type === "audio:limiter") {
        const c = ctx.createDynamicsCompressor();
        if (e.type === "audio:limiter") { c.threshold.value = p.ceiling ?? -1; c.ratio.value = 20; c.attack.value = 0.002; c.release.value = 0.1; c.knee.value = 0; }
        else { c.threshold.value = p.threshold ?? -24; c.ratio.value = p.ratio ?? 4; c.attack.value = p.attack ?? 0.01; c.release.value = p.release ?? 0.25; }
        v.fx.push(c);
      }
    }
    for (const n of v.fx) { head.connect(n); head = n; }
    head.connect(v.gain);
    v.head = head;
    v.fxKey = key;
  }

  private voice(plan: AudioClipPlan): Voice | null {
    if (!this.ctx) return null;
    let v = this.voices.get(plan.clipId);
    if (v) { v.lastUse = performance.now(); return v; }
    const t = this.track(plan.trackId);
    if (!t) return null;
    if (this.voices.size >= POOL) {
      const old = [...this.voices.entries()].sort((a, b) => a[1].lastUse - b[1].lastUse)[0];
      if (old) this.drop(old[0]);
    }
    const el = new Audio();
    el.preload = "auto";
    el.crossOrigin = "use-credentials";
    el.src = plan.url;
    let src: MediaElementAudioSourceNode;
    try { src = this.ctx.createMediaElementSource(el); } catch { return null; }
    const gain = this.ctx.createGain(), pan = this.ctx.createStereoPanner();
    gain.gain.value = 0;
    src.connect(gain); gain.connect(pan); pan.connect(t.gain);
    v = { el, src, head: src, gain, pan, fx: [], fxKey: "[]", url: plan.url, trackId: plan.trackId, plan, lastUse: performance.now() };
    this.voices.set(plan.clipId, v);
    this.fxChain(v);
    return v;
  }

  private drop(id: string) {
    const v = this.voices.get(id);
    if (!v) return;
    try { v.el.pause(); v.el.removeAttribute("src"); v.el.load(); } catch { /* gone */ }
    try { v.src.disconnect(); v.gain.disconnect(); v.pan.disconnect(); for (const n of v.fx) n.disconnect(); } catch { /* gone */ }
    this.voices.delete(id);
  }

  /** Follows the program clock: `t` seconds on the sequence. */
  sync(t: number, playing: boolean, rate: number) {
    const mix = this.mix;
    if (!mix || !this.ctx) return;
    const now = this.ctx.currentTime;
    const audibleRate = playing && rate > 0 && rate <= 4 && !this.muted;
    for (const tr of mix.tracks) {
      const n = this.track(tr.id);
      if (!n) continue;
      n.gain.gain.setTargetAtTime(tr.audible ? dbToLin(tr.volume) : 0, now, 0.02);
      n.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, tr.pan)), now, 0.02);
    }
    for (const p of mix.clips) {
      const local = t - p.start;
      const near = local > -1.2 && local < p.duration + 0.2;
      const v = near ? this.voice(p) : this.voices.get(p.clipId);
      if (!v) continue;
      this.fxChain(v);
      const el = v.el;
      const inside = local >= 0 && local < p.duration;
      const want = Math.max(0, p.in + Math.max(0, Math.min(p.duration, local)) * p.rate);
      if (audibleRate && inside && !p.reverse) {
        el.playbackRate = Math.max(0.0625, Math.min(16, rate * p.rate));
        if (Math.abs(el.currentTime - want) > 0.12) { try { el.currentTime = want; } catch { /* not seekable yet */ } }
        if (el.paused) void el.play().catch(() => undefined);
        v.gain.gain.setTargetAtTime(clipGainAt(p, local), now, 0.012);
        v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, sampleKeys(p.pan, local))), now, 0.02);
      } else {
        if (!el.paused) el.pause();
        v.gain.gain.setTargetAtTime(0, now, 0.01);
        if (Math.abs(el.currentTime - want) > 0.05 && el.readyState > 0) { try { el.currentTime = want; } catch { /* fine */ } }
      }
      if (!near && !inside) { /* kept in the pool until evicted */ }
    }
  }

  stopAll() { for (const v of this.voices.values()) { v.el.pause(); if (this.ctx) v.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01); } }

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

  dispose() {
    for (const id of [...this.voices.keys()]) this.drop(id);
    try { void this.ctx?.close(); } catch { /* closed */ }
    this.ctx = null; this.master = null; this.masterAn = null; this.tracks.clear();
  }
}

/** The program's mixer (one per window). */
export const mixer = new Mixer();
