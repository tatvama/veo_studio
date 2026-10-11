import { clsx } from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatTC } from "../../../components/review/utils";
import { Segmented } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import { useEpisode } from "../../../lib/queries";
import { useProjectCtx } from "../../project/context";
import { FPS } from "../../project/production/timeline/shared";
import { useFollowMedia, useProgramTarget } from "./follow";

type Mode = "all" | "waveform" | "parade" | "vectorscope" | "histogram";
/** Width the frame is analysed at (getImageData on a downscaled copy keeps this cheap at 10 fps). */
const AW = 320;
const WAVE_W = 320, WAVE_H = 256, VEC = 256, HIST_W = 256, HIST_H = 128;

/** Trace colours: channel data, not UI chrome (the frame itself is in RGB). */
const TRACE = { luma: [190, 255, 220], r: [255, 90, 90], g: [90, 255, 120], b: [100, 150, 255] } as const;

function accent(): [number, number, number] {
  const s = getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim();
  const m = s.match(/^#([0-9a-f]{6})$/i);
  if (!m) return [34, 211, 238];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Paints counts into an ImageData with a log curve (so faint areas still show). */
function paint(img: ImageData, acc: Uint32Array, w: number, x0: number, rgb: readonly number[], gain: number) {
  const d = img.data;
  const k = 1 / Math.log1p(gain);
  for (let i = 0; i < acc.length; i++) {
    const c = acc[i];
    if (!c) continue;
    const a = Math.min(1, Math.log1p(c) * k);
    const x = x0 + (i % w), y = Math.floor(i / w);
    const o = (y * img.width + x) * 4;
    d[o] = Math.min(255, d[o] + rgb[0] * a); d[o + 1] = Math.min(255, d[o + 1] + rgb[1] * a); d[o + 2] = Math.min(255, d[o + 2] + rgb[2] * a);
    d[o + 3] = 255;
  }
}

function grid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = "10px JetBrains Mono, monospace";
  ctx.lineWidth = 1;
  for (const p of [0, 25, 50, 75, 100]) {
    const y = Math.round(h - 1 - (p / 100) * (h - 1)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.fillText(String(p), 3, Math.max(10, y - 2));
  }
}

function drawWaveform(ctx: CanvasRenderingContext2D, px: Uint8ClampedArray, iw: number, ih: number, tone: readonly number[]) {
  const acc = new Uint32Array(WAVE_W * 256);
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
    const o = (y * iw + x) * 4;
    const l = Math.round(0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]);
    acc[(255 - l) * WAVE_W + Math.floor((x * WAVE_W) / iw)]++;
  }
  const img = ctx.createImageData(WAVE_W, WAVE_H);
  paint(img, acc, WAVE_W, 0, tone, ih / 3);
  ctx.putImageData(img, 0, 0);
  grid(ctx, WAVE_W, WAVE_H);
}

function drawParade(ctx: CanvasRenderingContext2D, px: Uint8ClampedArray, iw: number, ih: number) {
  const w = Math.floor(WAVE_W / 3);
  const accs = [new Uint32Array(w * 256), new Uint32Array(w * 256), new Uint32Array(w * 256)];
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
    const o = (y * iw + x) * 4;
    const col = Math.floor((x * w) / iw);
    accs[0][(255 - px[o]) * w + col]++;
    accs[1][(255 - px[o + 1]) * w + col]++;
    accs[2][(255 - px[o + 2]) * w + col]++;
  }
  const img = ctx.createImageData(WAVE_W, WAVE_H);
  paint(img, accs[0], w, 0, TRACE.r, ih / 3);
  paint(img, accs[1], w, w, TRACE.g, ih / 3);
  paint(img, accs[2], w, w * 2, TRACE.b, ih / 3);
  ctx.putImageData(img, 0, 0);
  grid(ctx, WAVE_W, WAVE_H);
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  for (const x of [w, w * 2]) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, WAVE_H); ctx.stroke(); }
}

/** BT.709 colour difference, -127.5..127.5. */
const cbOf = (r: number, g: number, b: number) => -0.1146 * r - 0.3854 * g + 0.5 * b;
const crOf = (r: number, g: number, b: number) => 0.5 * r - 0.4542 * g - 0.0458 * b;

function drawVectorscope(ctx: CanvasRenderingContext2D, px: Uint8ClampedArray, n: number, tone: readonly number[]) {
  const acc = new Uint32Array(VEC * VEC);
  const c = VEC / 2;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const x = Math.round(c + cbOf(px[o], px[o + 1], px[o + 2]));
    const y = Math.round(c - crOf(px[o], px[o + 1], px[o + 2]));
    if (x >= 0 && x < VEC && y >= 0 && y < VEC) acc[y * VEC + x]++;
  }
  const img = ctx.createImageData(VEC, VEC);
  paint(img, acc, VEC, 0, tone, n / 60);
  ctx.putImageData(img, 0, 0);
  // graticule: the outer circle, the axes, 75 % colour targets and the skin-tone line
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(c, c, c - 1, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(c, 4); ctx.lineTo(c, VEC - 4); ctx.moveTo(4, c); ctx.lineTo(VEC - 4, c); ctx.stroke();
  ctx.font = "10px JetBrains Mono, monospace";
  const targets: [string, number, number, number][] = [["R", 191, 0, 0], ["G", 0, 191, 0], ["B", 0, 0, 191], ["Cy", 0, 191, 191], ["Mg", 191, 0, 191], ["Yl", 191, 191, 0]];
  for (const [l, r, g, b] of targets) {
    const x = c + cbOf(r, g, b), y = c - crOf(r, g, b);
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.strokeRect(x - 5, y - 5, 10, 10);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText(l, x + 7, y + 3);
  }
  const skin = (123 * Math.PI) / 180;
  ctx.strokeStyle = "rgba(255,200,150,0.35)";
  ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Math.cos(skin) * (c - 2), c - Math.sin(skin) * (c - 2)); ctx.stroke();
}

function drawHistogram(ctx: CanvasRenderingContext2D, px: Uint8ClampedArray, n: number, tone: readonly number[]) {
  const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    bins[0][px[o]]++; bins[1][px[o + 1]]++; bins[2][px[o + 2]]++;
    bins[3][Math.round(0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2])]++;
  }
  ctx.clearRect(0, 0, HIST_W, HIST_H);
  ctx.fillStyle = "rgb(0 0 0)";
  ctx.fillRect(0, 0, HIST_W, HIST_H);
  let max = 1;
  for (const b of bins) for (let i = 1; i < 255; i++) max = Math.max(max, b[i]);  // ignore the clipped ends for the scale
  const colors = [TRACE.r, TRACE.g, TRACE.b, tone];
  ctx.globalCompositeOperation = "lighter";
  bins.forEach((b, k) => {
    const [r, g, bl] = colors[k];
    ctx.fillStyle = `rgba(${r},${g},${bl},${k === 3 ? 0.28 : 0.45})`;
    ctx.beginPath();
    ctx.moveTo(0, HIST_H);
    for (let i = 0; i < 256; i++) ctx.lineTo(i, HIST_H - Math.min(HIST_H, (b[i] / max) * (HIST_H - 4)));
    ctx.lineTo(255, HIST_H);
    ctx.closePath();
    ctx.fill();
  });
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  for (const x of [64, 128, 192]) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, HIST_H); ctx.stroke(); }
}

/**
 * Scopes for the program picture: luma waveform, RGB parade, vectorscope and histogram, about ten times a second. The
 * frame comes from a hidden copy of the program's current file, kept on the program's time (and look) over the bus.
 */
export default function ScopesPanel() {
  const t = useT();
  const { eid, lang } = useProjectCtx();
  const { data: ep } = useEpisode(eid, lang);
  const target = useProgramTarget(eid, lang);
  const vid = useRef<HTMLVideoElement>(null);
  const work = useRef<HTMLCanvasElement | null>(null);
  const wave = useRef<HTMLCanvasElement>(null);
  const parade = useRef<HTMLCanvasElement>(null);
  const vector = useRef<HTMLCanvasElement>(null);
  const hist = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<Mode>("all");
  const [err, setErr] = useState<string | null>(null);
  const filter = useRef<string | undefined>(undefined);
  filter.current = target?.filter;
  const tone = useRef<readonly number[]>(TRACE.luma);
  useEffect(() => { tone.current = accent(); }, []);
  const last = useRef(0);

  const draw = useCallback(() => {
    const v = vid.current;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    const now = performance.now();
    if (now - last.current < 90) return;
    last.current = now;
    const w = AW, h = Math.max(1, Math.round((AW * v.videoHeight) / v.videoWidth));
    const c = (work.current ??= document.createElement("canvas"));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const x = c.getContext("2d", { willReadFrequently: true });
    if (!x) return;
    let px: Uint8ClampedArray;
    try {
      x.filter = filter.current || "none";
      x.drawImage(v, 0, 0, w, h);
      px = x.getImageData(0, 0, w, h).data;
      if (err) setErr(null);
    } catch {
      setErr(t("The browser won't let the scopes read this file (it is served from another address)."));
      return;
    }
    const n = w * h;
    const ctx = (r: React.RefObject<HTMLCanvasElement | null>) => r.current?.getContext("2d") ?? null;
    const lw = ctx(wave), lp = ctx(parade), lv = ctx(vector), lh = ctx(hist);
    if (lw) drawWaveform(lw, px, w, h, TRACE.luma);
    if (lp) drawParade(lp, px, w, h);
    if (lv) drawVectorscope(lv, px, n, tone.current);
    if (lh) drawHistogram(lh, px, n, tone.current);
  }, [err, t]);

  useFollowMedia(vid, target, draw);
  useEffect(() => {
    if (!target?.playing) { draw(); return; }
    const h = window.setInterval(draw, 100);
    return () => window.clearInterval(h);
  }, [target?.playing, draw]);
  useEffect(() => { last.current = 0; draw(); }, [mode]);

  const code = target?.shotId ? ep?.shots?.find((s) => s.id === target.shotId)?.code : undefined;
  const show = (m: Mode) => mode === "all" || mode === m;
  const tile = (m: Mode, label: string, ref: React.RefObject<HTMLCanvasElement | null>, w: number, h: number) => (
    <figure className={clsx("flex min-h-0 min-w-0 flex-col gap-1", !show(m) && "hidden")}>
      <figcaption className="eyebrow">{label}</figcaption>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-line bg-black">
        <canvas ref={ref} width={w} height={h} className="absolute inset-0 h-full w-full object-contain" />
      </div>
    </figure>
  );

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented size="sm" value={mode} onChange={setMode} aria-label={t("Scope")}
          options={[{ value: "all", label: t("All") }, { value: "waveform", label: t("Waveform") }, { value: "parade", label: t("Parade") },
            { value: "vectorscope", label: t("Vectorscope") }, { value: "histogram", label: t("Histogram") }]} />
        <span className="flex-1" />
        <span className="mono text-2xs text-dim">
          {target ? `${code ?? ""}${code ? " · " : ""}${formatTC(target.time, FPS)}${target.playing ? ` · ${t("live")}` : ""}` : t("Waiting for the program…")}
        </span>
      </div>
      {err && <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">{err}</p>}
      <div className={clsx("grid min-h-0 flex-1 gap-2", mode === "all" ? "grid-cols-2 grid-rows-2" : "grid-cols-1 grid-rows-1")}>
        {tile("waveform", t("Luma waveform"), wave, WAVE_W, WAVE_H)}
        {tile("parade", t("RGB parade"), parade, WAVE_W, WAVE_H)}
        {tile("vectorscope", t("Vectorscope"), vector, VEC, VEC)}
        {tile("histogram", t("Histogram"), hist, HIST_W, HIST_H)}
      </div>
      <video ref={vid} muted playsInline preload="auto" className="hidden" aria-hidden />
    </div>
  );
}
