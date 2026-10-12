/**
 * The mini-map: the whole sequence in one strip (clips as thin bars per track, markers, in / out) with the visible
 * window as a box you drag; click anywhere to jump there. It is also the horizontal scroll bar.
 */
import { memo, useEffect, useRef } from "react";
import { seqEnd, tracksOf } from "../model/ops";
import type { Sequence } from "../model/types";
import { setView } from "../store";

function MiniMapImpl({ seq, zoom, scroll, width }: { seq: Sequence; zoom: number; scroll: number; width: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const total = Math.max(seqEnd(seq), Math.ceil((scroll + width) / zoom), 1) * 1.04;
  const k = width / total;  // minimap px per frame
  useEffect(() => {
    const c = cv.current;
    if (!c || width <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const H = 21;
    c.width = Math.round(width * dpr); c.height = H * dpr;
    c.style.width = `${width}px`; c.style.height = `${H}px`;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, H);
    const css = getComputedStyle(c);
    const vcol = css.getPropertyValue("--color-accent-2").trim() || "#818cf8";
    const acol = css.getPropertyValue("--color-ok").trim() || "#34d399";
    const vts = [...tracksOf(seq, "video")].reverse(), ats = tracksOf(seq, "audio");
    const rows = [...vts, ...ats];
    const rh = Math.max(1, Math.min(3, (H - 4) / Math.max(1, rows.length)));
    const top = (H - rh * rows.length) / 2;
    rows.forEach((t, i) => {
      g.fillStyle = t.kind === "video" ? vcol : acol;
      g.globalAlpha = t.hidden || t.muted ? 0.3 : 0.85;
      for (const cl of seq.clips) if (cl.trackId === t.id) g.fillRect(cl.start * k, top + i * rh, Math.max(1, cl.duration * k), Math.max(1, rh - 0.5));
    });
    g.globalAlpha = 1;
    for (const m of seq.markers) { g.fillStyle = m.color; g.fillRect(m.frame * k, 0, 1.5, 4); }
  }, [seq, width, k]);
  const winX = (scroll / zoom) * k, winW = Math.max(8, (width / zoom) * k);
  const toScroll = (clientX: number, el: HTMLElement, grab: number) => {
    const x = clientX - el.getBoundingClientRect().left - grab;
    setView({ scroll: Math.max(0, (x / k) * zoom) });
  };
  return (
    <div className="tl-mini" style={{ width }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const inWin = (e.target as HTMLElement).classList.contains("win");
        const grab = inWin ? e.clientX - el.getBoundingClientRect().left - winX : winW / 2;
        toScroll(e.clientX, el, grab);
        const move = (ev: PointerEvent) => toScroll(ev.clientX, el, grab);
        const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
        el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
      }}>
      <canvas ref={cv} />
      <div className="win" style={{ left: winX, width: winW }} />
    </div>
  );
}

export const MiniMap = memo(MiniMapImpl);
