/**
 * Audio waveforms. Renders use the backend's pre-computed peaks (Export.peaks); timeline tracks (voice, narration,
 * music, SFX takes) have no stored peaks, so they are decoded in the browser with WebAudio, downsampled to 100 peaks/s
 * and memoised per URL.
 */
import { clsx } from "clsx";
import { useEffect, useRef, useState } from "react";

export interface PeakData { peaks: Float32Array; rate: number; duration: number }

const PEAK_RATE = 100;
const MAX_CACHE = 120;
const cache = new Map<string, Promise<PeakData | null>>();
let running = 0;
const waiting: (() => void)[] = [];

function limited<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const go = () => {
      running++;
      fn().then(resolve, reject).finally(() => {
        running--;
        waiting.shift()?.();
      });
    };
    if (running < 3) go(); else waiting.push(go);
  });
}

/** Fetch + decode an audio (or video) file once and return its peaks. Never rejects; null when undecodable. */
export function decodePeaks(url: string): Promise<PeakData | null> {
  const hit = cache.get(url);
  if (hit) return hit;
  const job = limited(async () => {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(String(res.status));
    const buf = await res.arrayBuffer();
    const Ctx = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    const ctx: OfflineAudioContext = new Ctx(1, 1, 8000);
    const audio = await ctx.decodeAudioData(buf);
    const bucket = Math.max(1, Math.floor(audio.sampleRate / PEAK_RATE));
    const n = Math.ceil(audio.length / bucket);
    const out = new Float32Array(n);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const data = audio.getChannelData(c);
      for (let i = 0; i < n; i++) {
        let m = out[i];
        const end = Math.min(data.length, (i + 1) * bucket);
        for (let j = i * bucket; j < end; j++) {
          const v = data[j] < 0 ? -data[j] : data[j];
          if (v > m) m = v;
        }
        out[i] = m;
      }
    }
    return { peaks: out, rate: audio.sampleRate / bucket, duration: audio.duration } as PeakData;
  }).catch(() => null);
  cache.set(url, job);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
  return job;
}

/** Decoded peaks for a set of URLs; entries fill in as they finish (undefined = loading, null = failed). */
export function usePeaks(urls: string[]): Record<string, PeakData | null | undefined> {
  const [map, setMap] = useState<Record<string, PeakData | null>>({});
  const key = [...new Set(urls.filter(Boolean))].sort().join("|");
  useEffect(() => {
    let alive = true;
    for (const u of key ? key.split("|") : []) {
      decodePeaks(u).then((d) => { if (alive) setMap((m) => (u in m ? m : { ...m, [u]: d })); });
    }
    return () => { alive = false; };
  }, [key]);
  return map;
}

/** Backend peaks (0–1 list over the whole render) → PeakData. */
export function peaksFromList(list: number[] | undefined, duration: number): PeakData | null {
  if (!list?.length || !duration) return null;
  return { peaks: Float32Array.from(list), rate: list.length / duration, duration };
}

export interface WaveSeg { start: number; dur: number; data: PeakData; offset?: number; loop?: boolean }

/** Draws segments for the time window [t0, t0 + width/pps]. Colour comes from the canvas' CSS `color` (theme token). */
function draw(canvas: HTMLCanvasElement, segs: WaveSeg[], t0: number, pps: number, w: number, h: number, mirror: boolean) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(w * dpr));
  const H = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = getComputedStyle(canvas).color;
  const mid = mirror ? h / 2 : h;
  const amp = mirror ? h / 2 - 1 : h - 1;
  for (const s of segs) {
    const { peaks, rate, duration } = s.data;
    if (!peaks.length || !duration) continue;
    const x0 = Math.max(0, Math.floor((s.start - t0) * pps));
    const x1 = Math.min(w, Math.ceil((s.start + s.dur - t0) * pps));
    for (let x = x0; x < x1; x++) {
      let lt = t0 + x / pps - s.start + (s.offset ?? 0);
      if (s.loop) lt %= duration;
      if (lt < 0 || lt >= duration) continue;
      const a = Math.floor(lt * rate);
      const b = Math.max(a + 1, Math.floor((lt + 1 / pps) * rate));
      let m = 0;
      for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
      const v = Math.max(0.5, Math.min(1, m * 1.15) * amp);
      ctx.fillRect(x, mid - v, 1, mirror ? v * 2 : v);
    }
  }
}

/** Redraw when the theme switches (class / data-theme / style on <html>). */
function useThemeTick(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setN((x) => x + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const h = () => setN((x) => x + 1);
    mq?.addEventListener?.("change", h);
    return () => { mo.disconnect(); mq?.removeEventListener?.("change", h); };
  }, []);
  return n;
}

/**
 * Canvas waveform. Either give `pps` + `t0` + `width` (windowed timeline lane), or nothing and it stretches the
 * segments over its own measured width (`duration` seconds wide).
 */
export function WaveCanvas({ segs, t0 = 0, pps, width, duration, height, className, mirror = true, style }: {
  segs: WaveSeg[]; t0?: number; pps?: number; width?: number; duration?: number; height: number; className?: string;
  mirror?: boolean; style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [measured, setMeasured] = useState(0);
  const theme = useThemeTick();
  useEffect(() => {
    if (width !== undefined || !ref.current) return;
    const el = ref.current;
    const ro = new ResizeObserver(() => setMeasured(el.clientWidth));
    ro.observe(el);
    setMeasured(el.clientWidth);
    return () => ro.disconnect();
  }, [width]);
  const w = width ?? measured;
  const scale = pps ?? (duration && w ? w / duration : 0);
  useEffect(() => {
    if (ref.current && w > 0 && scale > 0) draw(ref.current, segs, t0, scale, w, height, mirror);
  }, [segs, t0, scale, w, height, mirror, theme]);
  return (
    <canvas ref={ref} aria-hidden className={clsx("pointer-events-none block", className)}
      style={{ height, width: width !== undefined ? width : "100%", ...style }} />
  );
}
