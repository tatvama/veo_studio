/**
 * Live video source (preview): one muted <video> per clip. While playing it runs on its own and is kept within
 * half a frame of the timeline by nudging playbackRate (a hard seek past 0.3 s of drift); paused or scrubbing, it
 * seeks to the wanted time (one seek at a time, the latest wins). A new picture is counted with
 * requestVideoFrameCallback where the browser has it, so unchanged frames aren't uploaded again.
 */
import type { Frame, FrameSource } from "./source";

const sameOrigin = (url: string) => {
  try { return new URL(url, location.href).origin === location.origin; } catch { return true; }
};

/** A playbackRate the element accepts (Chrome refuses anything outside 1/16 .. 16). */
const okRate = (r: number) => Math.min(16, Math.max(0.0625, r));
/** How long an exact seek waits for the picture before going on with what the element has. */
const SEEK_TIMEOUT_MS = 4000;

/**
 * Waits for one of the `ok` events on `target`: resolves "ok"; rejects (with `message(ev)`) on one of the `fail`
 * events; resolves "timeout" after `ms` (0: no timeout). Whichever comes first, every listener and the timer are
 * removed, so a media element that errors mid-seek never leaves an export hanging on "seeked".
 */
export function waitFor(target: EventTarget, ok: string[], fail: string[], ms: number, message: (ev: Event) => string = () => "the media element failed"): Promise<"ok" | "timeout"> {
  return new Promise<"ok" | "timeout">((res, rej) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = () => {
      for (const n of ok) target.removeEventListener(n, onOk);
      for (const n of fail) target.removeEventListener(n, onFail);
      if (timer !== null) { clearTimeout(timer); timer = null; }
    };
    const onOk = () => { off(); res("ok"); };
    const onFail = (ev: Event) => { off(); rej(new Error(message(ev))); };
    for (const n of ok) target.addEventListener(n, onOk);
    for (const n of fail) target.addEventListener(n, onFail);
    if (ms > 0 && Number.isFinite(ms)) timer = setTimeout(() => { off(); res("timeout"); }, ms);
  });
}

export class LiveVideo implements FrameSource {
  readonly kind = "video" as const;
  readonly ready: Promise<void>;
  readonly el: HTMLVideoElement;
  private version = 0;
  private rvfc: boolean;
  private want: number | null = null;
  private half: number;
  private disposed = false;
  private url: string;

  constructor(url: string, fps = 24) {
    this.url = url;
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.preload = "auto";
    if (!sameOrigin(url)) el.crossOrigin = "anonymous";
    el.disableRemotePlayback = true;
    this.el = el;
    this.half = 0.5 / fps;
    this.rvfc = "requestVideoFrameCallback" in el;
    const bump = () => { this.version++; };
    if (this.rvfc) {
      const loop = () => { if (this.disposed) return; bump(); el.requestVideoFrameCallback(loop); };
      el.requestVideoFrameCallback(loop);
    }
    el.addEventListener("seeked", () => {
      bump();
      if (this.want !== null && Math.abs(el.currentTime - this.want) > this.half) { const w = this.want; this.want = null; this.seek(w); } else this.want = null;
    });
    el.addEventListener("loadeddata", bump);
    this.ready = new Promise<void>((res, rej) => {
      el.addEventListener("loadeddata", () => res(), { once: true });
      el.addEventListener("error", () => rej(new Error(`${url}: ${el.error?.message || "can't play this video"}`)), { once: true });
    });
    this.ready.catch(() => undefined);
    el.src = url;
  }

  private seek(t: number) {
    const el = this.el;
    if (el.seeking) { this.want = t; return; }
    el.currentTime = Math.max(0, t);
  }

  live(t: number, playing: boolean, rate: number): Frame | null {
    const el = this.el;
    if (el.readyState < 1) return null;
    // slower than the element can play (a freeze, the slow end of a ramp): hold the frame, seeking as t moves
    if (rate < 0.0625) playing = false;
    rate = Math.min(rate, 16);
    if (playing && rate > 0) {
      const drift = el.currentTime - t;
      if (el.paused) {
        if (Math.abs(drift) > this.half) this.seek(t);
        el.playbackRate = okRate(rate);
        void el.play().catch(() => undefined);
      } else if (Math.abs(drift) > 0.3) this.seek(t);
      else el.playbackRate = okRate(Math.abs(drift) > this.half ? rate * (1 - Math.max(-0.12, Math.min(0.12, drift * 1.5))) : rate);
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - t) > this.half) this.seek(t);
    }
    if (el.readyState < 2 || !el.videoWidth) return null;
    return { image: el, width: el.videoWidth, height: el.videoHeight, version: this.rvfc ? this.version : performance.now() };
  }

  /** Seek and wait for the picture (the exact mode's fallback when WebCodecs can't decode the file). */
  async exact(t: number): Promise<Frame | null> {
    await this.ready;
    const el = this.el;
    if (!el.paused) el.pause();
    if (Math.abs(el.currentTime - t) > 1e-3 || el.seeking) {
      // seeked, or the element erroring mid-seek (rejects), or a seek that never lands (goes on with what it has)
      const seeked = waitFor(el, ["seeked"], ["error"], SEEK_TIMEOUT_MS, () => `${this.url}: ${el.error?.message || "the video failed while seeking"}`);
      el.currentTime = Math.max(0, t);
      const r = await seeked;
      if (r === "timeout" && el.error) throw new Error(`${this.url}: ${el.error.message || "the video failed while seeking"}`);
      if (r === "ok" && this.rvfc) await new Promise<void>((res) => { el.requestVideoFrameCallback(() => res()); setTimeout(res, 120); });
    }
    if (el.readyState < 2) await new Promise<void>((res) => { el.addEventListener("canplay", () => res(), { once: true }); setTimeout(res, 2000); });
    this.version++;
    return el.videoWidth ? { image: el, width: el.videoWidth, height: el.videoHeight, version: this.version } : null;
  }

  idle(): void { if (!this.el.paused) this.el.pause(); }

  dispose(): void {
    this.disposed = true;
    this.el.pause();
    this.el.removeAttribute("src");
    this.el.load();
  }
}
