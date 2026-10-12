/**
 * One clip on a lane: label colour, name strip with badges, a filmstrip (video) or waveform (audio) drawn into a
 * canvas covering only the visible part, and the keyframe line (opacity / volume) the Pen tool edits. Memoised: the
 * timeline re-renders only the clips whose data, position or selection changed.
 */
import { clsx } from "clsx";
import { memo, useEffect, useRef } from "react";
import { LABEL_COLORS } from "../model/defaults";
import { getParam, valueAt } from "../model/params";
import { hasRamp } from "../model/remap";
import type { MediaItem, Param, TimelineClip } from "../model/types";
import { drawFilmstrip, drawWaveform, loadImage, peaksFor, type StripGeom } from "./draw";

export const NAME_H = 16;
export const BAND_MIN_H = 34;

/** Keyframe line value ↔ 0..1 from the top of the band. */
export const bandOf = (audio: boolean) => audio
  ? { path: "audio.gain", toY: (v: number) => Math.max(0, Math.min(1, (6 - v) / 54)), fromY: (y: number) => Math.round((6 - y * 54) * 10) / 10, lo: -96, hi: 6, speed: false }
  : { path: "motion.opacity", toY: (v: number) => Math.max(0, Math.min(1, 1 - v / 100)), fromY: (y: number) => Math.round((1 - y) * 1000) / 10, lo: 0, hi: 100, speed: false };
/** The speed curve lane of a ramped clip (0 – 400 %; 100 % sits a quarter down). */
export const SPEED_BAND = { path: "timeRemap", toY: (v: number) => Math.max(0, Math.min(1, 1 - v / 400)), fromY: (y: number) => Math.round(Math.max(0, (1 - y) * 400)), lo: 0, hi: 1000, speed: true };
/** The keyframe line a clip shows: its speed ramp when it has one, else opacity (picture) or volume (sound). */
export const bandFor = (c: TimelineClip, audio: boolean) => (c.timeRemap ? SPEED_BAND : bandOf(audio));

export interface ClipViewProps {
  clip: TimelineClip; media?: MediaItem; url?: string;
  /** Lane pixels of the clip's start and its width. */
  x: number; w: number; laneW: number; height: number;
  audio: boolean; selected: boolean; zoom: number; rate: number; band: boolean; drop: boolean; missing: boolean;
  /** A keyframe the pen tool is dragging (highlighted). */
  activeKf?: number | null;
}

function ClipViewImpl(p: ClipViewProps) {
  const { clip: c, media: m, x, w, laneW, height, audio, selected, zoom } = p;
  const canvas = useRef<HTMLCanvasElement>(null);
  const vx0 = Math.max(0, -x), vx1 = Math.min(w, laneW - x);
  const visW = Math.max(0, vx1 - vx0);
  const kind = c.source.type === "title" ? "title" : c.source.type === "color" || c.source.type === "adjustment" ? "matte" : c.source.type === "nested" ? "nested" : audio ? "audio" : "video";
  const contentTop = audio ? NAME_H : NAME_H;
  const contentH = Math.max(0, height - contentTop - 2);
  const srcIn = c.source.type === "media" || c.source.type === "nested" ? c.source.in : 0;

  // the picture: filmstrip / waveform, redrawn when the visible part or the source changes
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !m || visW <= 0 || contentH < 6) return;
    let alive = true;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.min(8192, Math.ceil(visW * dpr)), H = Math.ceil(contentH * dpr);
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const g = cv.getContext("2d");
    if (!g) return;
    const geom: StripGeom = { x0: vx0, x1: vx1, height: contentH, zoom, srcIn, rate: p.rate, reverse: c.reverse, duration: c.duration, mediaFrames: m.duration || 1 };
    if (audio) {
      void peaksFor(m, p.url).then((pk) => {
        if (!alive || !pk) return;
        g.clearRect(0, 0, W, H);
        const css = getComputedStyle(cv).color || "rgba(255,255,255,0.7)";
        drawWaveform(g, pk.peaks, pk.duration, m.fps || 1, geom, css, dpr);
      });
    } else {
      const src = m.filmstrip || m.thumb;
      if (!src) return;
      void loadImage(src).then((img) => {
        if (!alive || !img) return;
        g.clearRect(0, 0, W, H);
        const aspect = m.width > 0 && m.height > 0 ? m.width / m.height : 16 / 9;
        drawFilmstrip(g, img, !!m.filmstrip, geom, aspect, dpr);
      });
    }
    return () => { alive = false; };
  }, [m, p.url, vx0, vx1, visW, contentH, zoom, srcIn, p.rate, c.reverse, c.duration, audio]);

  const label = c.colorLabel ? LABEL_COLORS.find((l) => l.id === c.colorLabel)?.css : undefined;
  const speed = Math.round(c.speed * 100);
  const ramp = hasRamp(c);
  return (
    <div data-clip={c.id}
      className={clsx("tl-clip", kind !== "video" && kind, selected && "sel", !c.enabled && "off", p.missing && "missing", p.drop && "drop", c.connectedTo && "connected", c.multicam && "multicam")}
      style={{ left: x, width: Math.max(1, w), ...(label ? { ["--ed-clip" as string]: `color-mix(in srgb, ${label} 62%, var(--color-panel))` } : {}) }}>
      {w > 6 && (
        <div className="tl-clip-name" style={{ paddingLeft: vx0 + 5 }}>
          {c.multicam && <span className="fx" title="Multicam clip: the angle shown">{audio ? `♪${(c.multicam.audioAngle ?? c.multicam.angle) + 1}` : `A${c.multicam.angle + 1}`}</span>}
          {ramp && <span className="fx" title="Speed ramp (time remapping)">{c.timeRemap && !c.timeRemap.keyframes?.length && c.timeRemap.value === 0 ? "hold" : "ramp"}</span>}
          {c.effects.some((e) => e.enabled) && <span className="fx">fx</span>}
          {speed !== 100 && <span className="fx">{speed}%{c.reverse ? " ↺" : ""}</span>}
          {c.reverse && speed === 100 && <span className="fx">↺</span>}
          <span className="truncate">{c.name}</span>
        </div>
      )}
      {m && visW > 0 && contentH >= 6 && (
        <canvas ref={canvas} className={audio ? "text-white/70" : "opacity-90"} style={{ left: vx0, width: visW, top: contentTop, height: contentH }} />
      )}
      {c.source.type === "title" && w > 30 && height > 30 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 top-4 truncate px-1.5 pt-1 text-2xs italic text-white/80" style={{ paddingLeft: vx0 + 6 }}>“{c.source.text.text}”</div>
      )}
      {p.band && height >= BAND_MIN_H && w > 8 && <Band clip={c} audio={audio} vx0={vx0} vx1={vx1} height={height} zoom={zoom} active={p.activeKf} />}
    </div>
  );
}

/** The opacity / volume line with its keyframes (clip-local, visible part only). */
function Band({ clip, audio, vx0, vx1, height, zoom, active }: { clip: TimelineClip; audio: boolean; vx0: number; vx1: number; height: number; zoom: number; active?: number | null }) {
  const b = bandFor(clip, audio);
  const param = getParam(clip, b.path) as Param<number> | undefined;
  if (!param) return null;
  const top = NAME_H + 2, bh = height - top - 4;
  const y = (v: number) => top + b.toY(v) * bh;
  const ks = param.keyframes ?? [];
  const pts: string[] = [];
  const X = (f: number) => f * zoom - vx0;
  const W = vx1 - vx0;
  if (!ks.length) { pts.push(`0,${y(param.value)}`, `${W},${y(param.value)}`); }
  else {
    pts.push(`${Math.min(0, X(ks[0].frame))},${y(ks[0].value)}`);
    for (let i = 0; i < ks.length; i++) {
      const k = ks[i], n = ks[i + 1];
      pts.push(`${X(k.frame)},${y(k.value)}`);
      if (n && k.ease !== "linear") {
        const steps = k.ease === "hold" ? 1 : Math.max(10, Math.min(60, Math.round(((n.frame - k.frame) * zoom) / 4)));
        if (k.ease === "hold") pts.push(`${X(n.frame)},${y(k.value)}`);
        else for (let s = 1; s < steps; s++) {
          const f = k.frame + ((n.frame - k.frame) * s) / steps;
          pts.push(`${X(f)},${y(valueAt(param, f))}`);
        }
      }
    }
    pts.push(`${Math.max(W, X(ks[ks.length - 1].frame))},${y(ks[ks.length - 1].value)}`);
  }
  const line = pts.join(" ");
  return (
    <svg className="band" style={{ left: vx0, width: W }} width={W} height={height}>
      {b.speed && <line x1={0} x2={W} y1={y(100)} y2={y(100)} stroke="rgb(125 211 252 / .35)" strokeDasharray="3 3" />}
      <polyline points={line} fill="none" stroke={b.speed ? "rgb(125 211 252 / .95)" : "rgb(255 214 102 / .95)"} strokeWidth={1.25} />
      <polyline className="hit" data-band={b.path} points={line} fill="none" stroke="transparent" strokeWidth={9} />
      {ks.map((k) => {
        const kx = X(k.frame);
        if (kx < -6 || kx > W + 6) return null;
        return (
          <rect key={k.frame} className="kf" data-kf={k.frame} data-band={b.path} x={kx - 4} y={y(k.value) - 4} width={8} height={8}
            transform={`rotate(45 ${kx} ${y(k.value)})`} fill={active === k.frame ? "var(--color-accent)" : b.speed ? "rgb(125 211 252)" : "rgb(255 214 102)"} stroke="rgb(0 0 0 / .6)" strokeWidth={1}>
            {b.speed && <title>{`${k.value}%`}</title>}
          </rect>
        );
      })}
    </svg>
  );
}

export const ClipView = memo(ClipViewImpl);
