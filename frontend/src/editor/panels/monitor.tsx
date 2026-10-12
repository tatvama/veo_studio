/** Pieces both monitors share: the scrub bar (in / out range, markers, playhead) and the transport buttons. */
import { ChevronFirst, ChevronLast, Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Marker } from "../model/types";
import { usePlayState, type Transport } from "../playback/transport";
import { IBtn } from "../ui";

/** A thin scrub bar for a monitor: click / drag to seek. Draws the playhead through a ref (no render per frame). */
export function ScrubBar({ tr, length, inPoint, outPoint, markers }: { tr: Transport; length: number; inPoint?: number; outPoint?: number; markers: Marker[] }) {
  const el = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const len = Math.max(1, length);
  useEffect(() => {
    const place = () => { if (head.current) head.current.style.left = `${Math.min(100, (tr.frame / len) * 100)}%`; };
    place();
    return tr.subscribe(place);
  }, [tr, len]);
  const seekAt = (clientX: number) => {
    const r = el.current!.getBoundingClientRect();
    tr.pause();
    tr.seek(Math.round(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (len - 1)));
  };
  const a = inPoint ?? 0, b = outPoint !== undefined ? outPoint + 1 : len;
  return (
    <div ref={el} className="mon-scrub" onPointerDown={(e) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      seekAt(e.clientX);
      const move = (ev: PointerEvent) => seekAt(ev.clientX);
      const t = e.currentTarget;
      const up = () => { t.removeEventListener("pointermove", move); t.removeEventListener("pointerup", up); };
      t.addEventListener("pointermove", move); t.addEventListener("pointerup", up);
    }}>
      <div className="track" />
      {(inPoint !== undefined || outPoint !== undefined) && <div className="range" style={{ left: `${(a / len) * 100}%`, width: `${((b - a) / len) * 100}%` }} />}
      {markers.map((m) => <div key={m.id} className="mk" title={m.name} style={{ left: `${(m.frame / len) * 100}%`, background: m.color }} />)}
      <div ref={head} className="head" />
    </div>
  );
}

/** Go to in, step back, play / pause, step forward, go to out. */
export function TransportButtons({ tr, onPlay, onIn, onOut, onPrevEdit, onNextEdit }: {
  tr: Transport; onPlay: () => void; onIn: () => void; onOut: () => void; onPrevEdit?: () => void; onNextEdit?: () => void;
}) {
  const { playing, rate } = usePlayState(tr);
  return (
    <div className="flex items-center gap-0.5">
      <IBtn title="Go to in" shortcut="Shift+I" side="top" onClick={onIn}><ChevronFirst className="size-4" /></IBtn>
      {onPrevEdit && <IBtn title="Previous edit" shortcut="Up" side="top" onClick={onPrevEdit}><SkipBack className="size-3.5" /></IBtn>}
      <IBtn title="Step back one frame" shortcut="Left" side="top" onClick={() => tr.step(-1)}><StepBack className="size-4" /></IBtn>
      <IBtn title={playing ? "Pause" : "Play"} shortcut="Space" side="top" className="!size-8" onClick={onPlay}>
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </IBtn>
      <IBtn title="Step forward one frame" shortcut="Right" side="top" onClick={() => tr.step(1)}><StepForward className="size-4" /></IBtn>
      {onNextEdit && <IBtn title="Next edit" shortcut="Down" side="top" onClick={onNextEdit}><SkipForward className="size-3.5" /></IBtn>}
      <IBtn title="Go to out" shortcut="Shift+O" side="top" onClick={onOut}><ChevronLast className="size-4" /></IBtn>
      {playing && rate !== 1 && <span className="mono ml-1 rounded bg-hover px-1 text-2xs text-accent-ink">{rate > 0 ? "▶" : "◀"} {Math.abs(rate)}×</span>}
    </div>
  );
}

/** Fits a w×h picture inside a box (or shows it at `scale`). */
export function fitSize(boxW: number, boxH: number, w: number, h: number, mode: "fit" | number): { w: number; h: number } {
  if (!(w > 0 && h > 0)) return { w: 0, h: 0 };
  if (mode === "fit") { const k = Math.min(boxW / w, boxH / h); return { w: Math.max(1, Math.floor(w * k)), h: Math.max(1, Math.floor(h * k)) }; }
  return { w: Math.round(w * mode), h: Math.round(h * mode) };
}
