/**
 * Transports: one for the program monitor (sequence frames) and one for the source monitor (source frames). Each is
 * a clock that components subscribe to without re-rendering the editor: the playhead layer, the timecode readouts and
 * the monitors read it directly. Playback runs on the wall clock (requestAnimationFrame) at `rate`; J / K / L shuttle
 * through -8×…8×. `time` is the exact position in seconds while playing; `frame` is the whole frame shown.
 */
import { useSyncExternalStore } from "react";
import { framesToSeconds, fpsExact } from "../model/time";

type Listener = () => void;

export class Transport {
  private t = 0;            // seconds, exact
  private f = 0;            // frame shown
  fps = 25;
  /** Last frame + 1 (playback stops there). */
  end = 0;
  playing = false;
  rate = 1;
  /** Frames the last second of playback skipped (the dropped-frame readout). */
  dropped = 0;
  private raf = 0;
  private last = 0;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<Listener>();
  /** Called on every playback tick with the exact time (monitors draw from it). */
  private tickers = new Set<(t: number) => void>();
  /** Where play started (Premiere's "return to start on stop" isn't on; kept for loop playback later). */
  private stats = { frames: 0, skipped: 0, since: 0 };
  /** Optional range playback stops at (in → out). */
  stopAt: number | null = null;

  get frame() { return this.f; }
  get time() { return this.t; }

  subscribe = (cb: Listener) => { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; };
  subscribeState = (cb: Listener) => { this.stateListeners.add(cb); return () => { this.stateListeners.delete(cb); }; };
  onTick(cb: (t: number) => void) { this.tickers.add(cb); return () => { this.tickers.delete(cb); }; }
  getFrame = () => this.f;
  private stateVersion = 0;
  getState = () => this.stateVersion;

  private emit() { this.listeners.forEach((l) => l()); }
  private emitState() { this.stateVersion++; this.stateListeners.forEach((l) => l()); }

  configure(fps: number, end: number) {
    this.fps = fps; this.end = Math.max(0, end);
  }

  /** Jumps to a frame (clamped to 0..end). Stops shuttling backwards past 0. */
  seek(frame: number) {
    const f = Math.max(0, Math.round(frame));
    this.t = framesToSeconds(f, this.fps);
    if (f !== this.f) { this.f = f; this.emit(); }
    if (!this.playing) this.tickers.forEach((cb) => cb(this.t));
  }

  play(rate = 1) {
    if (this.end > 0 && rate > 0 && this.f >= this.end - 1) this.seek(0);
    this.rate = rate;
    if (!this.playing) {
      this.playing = true;
      this.last = performance.now();
      this.stats = { frames: 0, skipped: 0, since: this.last };
      this.raf = requestAnimationFrame(this.tick);
    }
    this.emitState();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.rate = 1;
    this.stopAt = null;
    this.emitState();
    this.tickers.forEach((cb) => cb(this.t));
  }

  toggle() { if (this.playing) this.pause(); else this.play(1); }

  /** L (dir 1) / J (dir -1): play, then each press doubles the speed in that direction (up to 8×); K stops. */
  shuttle(dir: 1 | -1) {
    if (!this.playing || Math.sign(this.rate) !== dir) { this.play(dir); return; }
    this.rate = Math.max(-8, Math.min(8, this.rate * 2));
    this.emitState();
  }

  step(frames: number) { this.pause(); this.seek(this.f + frames); }

  private tick = (now: number) => {
    if (!this.playing) return;
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    let t = this.t + dt * this.rate;
    const endT = framesToSeconds(this.stopAt ?? this.end, this.fps);
    if (this.rate > 0 && this.end > 0 && t >= endT) { t = endT - 1e-6; this.t = t; this.setFrame(Math.max(0, (this.stopAt ?? this.end) - 1)); this.pause(); return; }
    if (t <= 0 && this.rate < 0) { this.t = 0; this.setFrame(0); this.pause(); return; }
    this.t = t;
    const nf = Math.floor(t * fpsExact(this.fps) + 1e-6);
    // dropped frames: at 1× every frame should show; a tick that advances more than one frame skipped some
    if (Math.abs(this.rate) === 1) {
      const step = Math.abs(nf - this.f);
      if (step > 1) this.stats.skipped += step - 1;
      this.stats.frames += step;
    }
    if (now - this.stats.since > 1000) { this.dropped = this.stats.skipped; this.stats = { frames: 0, skipped: 0, since: now }; this.emitState(); }
    this.setFrame(nf);
    this.tickers.forEach((cb) => cb(t));
    this.raf = requestAnimationFrame(this.tick);
  };

  private setFrame(f: number) { if (f !== this.f) { this.f = f; this.emit(); } }
}

/** The sequence's transport (Program monitor, timeline playhead). */
export const program = new Transport();
/** The Source monitor's transport (the source clip's frames). */
export const source = new Transport();

/** Re-renders on every frame change: for tiny components only (timecode, playhead). */
export const useFrame = (tr: Transport) => useSyncExternalStore(tr.subscribe, tr.getFrame, tr.getFrame);
/** Re-renders when play state / rate / dropped frames change. */
export function usePlayState(tr: Transport) {
  useSyncExternalStore(tr.subscribeState, tr.getState, tr.getState);
  return { playing: tr.playing, rate: tr.rate, dropped: tr.dropped };
}
