import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { fxFilter, fxTransform, transitionFrame } from "../../../../lib/fx";
import type { Clip } from "./shared";
import type { Transport } from "./transport";

/** The transition window the playhead is in: clip i blends in over clip i-1, p = progress 0→1. */
function windowAt(clips: Clip[], t: number): { i: number; p: number } | null {
  for (let i = 1; i < clips.length; i++) {
    const c = clips[i];
    if (c.overlap > 0 && t >= c.start && t < c.start + c.overlap) return { i, p: (t - c.start) / c.overlap };
  }
  return null;
}

const STYLE_KEYS = ["opacity", "transform", "clipPath", "maskImage", "webkitMaskImage", "filter"] as const;

function applyStyle(el: HTMLElement | null, s: Record<string, any>, z: number) {
  if (!el) return;
  for (const k of STYLE_KEYS) (el.style as any)[k] = "";
  for (const [k, v] of Object.entries(s)) {
    const key = k === "WebkitMaskImage" ? "webkitMaskImage" : k;
    if (v !== undefined) (el.style as any)[key] = typeof v === "number" && key !== "opacity" ? `${v}px` : String(v);
  }
  el.style.zIndex = String(z);
}

/**
 * Live transition blend in the sequence player. The transport keeps playing one shot (it hands over half-way through
 * the transition); during the overlap this layer shows (and plays) the other shot in sync: both pictures follow the same
 * transition shapes as the Effects preview (the export uses FFmpeg's own, so a few look slightly different) and their
 * sound crossfades.
 */
export function BlendLayer({ tp, clips, mainRef, frameRef }: {
  tp: Transport; clips: Clip[]; mainRef: RefObject<HTMLDivElement | null>; frameRef: RefObject<HTMLDivElement | null>;
}) {
  const [comp, setComp] = useState<Clip | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const vidRef = useRef<HTMLVideoElement>(null);
  const live = useRef({ clips, idx: tp.idx, playing: tp.playing, comp: null as Clip | null });
  live.current.clips = clips;
  live.current.idx = tp.idx;
  live.current.playing = tp.playing;

  const updateRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const update = () => {
      const { clips: cs, idx } = live.current;
      const t = tp.clock.get();
      const w = windowAt(cs, t);
      const mv = tp.vref.current;
      if (!w) {
        if (mv && mv.volume !== 1) mv.volume = 1;
        if (live.current.comp) { live.current.comp = null; setComp(null); }
        applyStyle(mainRef.current, {}, 1);
        if (frameRef.current) frameRef.current.style.background = "";
        return;
      }
      const out = cs[w.i - 1], inc = cs[w.i];
      const mainIsIncoming = idx === w.i;
      const other = mainIsIncoming ? out : inc;
      if (live.current.comp?.shot.id !== other.shot.id) { live.current.comp = other; setComp(other); }
      const f = transitionFrame(inc.shot.fx?.transition?.type ?? "fade", w.p);
      // a = outgoing picture, b = incoming picture
      const aZ = f.bTop ? 1 : 2, bZ = f.bTop ? 2 : 1;
      applyStyle(mainRef.current, mainIsIncoming ? f.b : f.a, mainIsIncoming ? bZ : aZ);
      applyStyle(layerRef.current, mainIsIncoming ? f.a : f.b, mainIsIncoming ? aZ : bZ);
      if (frameRef.current) frameRef.current.style.background = f.bg ?? "#000";
      const v = vidRef.current;
      // sound: the outgoing shot fades down as the incoming one comes up (linear, like the export's acrossfade)
      const outVol = 1 - w.p, inVol = w.p;
      if (mv) mv.volume = Math.max(0, Math.min(1, mainIsIncoming ? inVol : outVol));
      if (v) v.volume = Math.max(0, Math.min(1, mainIsIncoming ? outVol : inVol));
      if (v && other.src && v.readyState >= 1) {
        const want = other.trimIn + Math.max(0, Math.min(t - other.start, other.duration)) * other.speed;
        if (Math.abs(v.currentTime - want) > (live.current.playing ? 0.3 : 0.04)) v.currentTime = want;
      }
    };
    updateRef.current = update;
    update();
    return tp.clock.subscribe(update);
  }, [tp.clock, mainRef, frameRef]);
  // the other shot's layer just mounted (or the playing shot changed): style both now, not on the next tick
  useLayoutEffect(() => { updateRef.current(); }, [comp?.shot.id, tp.idx]);

  // the companion plays along while the sequence plays
  useEffect(() => {
    const v = vidRef.current;
    if (!v || !comp?.src) return;
    v.playbackRate = Math.max(0.1, tp.rate * (comp.speed || 1));
    if (tp.playing && tp.rate > 0) void v.play().catch(() => undefined);
    else v.pause();
  }, [tp.playing, tp.rate, comp?.shot.id]);

  if (!comp) return null;
  const look = { filter: fxFilter(comp.shot.fx, 0.6) || undefined, transform: fxTransform(comp.shot.fx) || undefined };
  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0" aria-hidden>
      {comp.src ? <video ref={vidRef} src={comp.src} playsInline preload="auto" className="h-full w-full object-contain" style={look} />
        : comp.still ? <img src={comp.still} alt="" className="h-full w-full object-contain" style={look} /> : null}
    </div>
  );
}
