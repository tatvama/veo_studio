/**
 * The time ruler: ticks and timecode on a canvas, the work area (in → out), sequence markers (click to go there,
 * drag to move, double-click to edit), and scrubbing the playhead (snaps to cuts and markers when snapping is on).
 */
import { clsx } from "clsx";
import { memo, useEffect, useRef } from "react";
import * as A from "../actions";
import { updateMarker } from "../model/ops";
import { snapFrame, snapPoints } from "../model/snapping";
import { toTimecode } from "../model/time";
import type { Sequence } from "../model/types";
import { program } from "../playback/transport";
import { ed, gesture, selectMarker } from "../store";
import { openMenu } from "../ui";
import { tickStep } from "./geometry";

function RulerImpl({ seq, zoom, scroll, width, selMarker, onEditMarker }: {
  seq: Sequence; zoom: number; scroll: number; width: number; selMarker: string | null; onEditMarker: (id: string) => void;
}) {
  const cv = useRef<HTMLCanvasElement>(null);
  const fps = seq.fps;
  useEffect(() => {
    const c = cv.current;
    if (!c || width <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const H = 34;
    c.width = Math.round(width * dpr); c.height = H * dpr;
    c.style.width = `${width}px`; c.style.height = `${H}px`;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, H);
    const css = getComputedStyle(c);
    const dim = css.getPropertyValue("--color-dim").trim() || "#74829b";
    const mute = css.getPropertyValue("--color-mute").trim() || "#9ba8bd";
    const accent = css.getPropertyValue("--color-accent").trim() || "#22d3ee";
    // work area
    if (seq.inPoint !== undefined || seq.outPoint !== undefined) {
      const a = (seq.inPoint ?? 0) * zoom - scroll, b = ((seq.outPoint ?? Math.max(0, seq.clips.reduce((m, x) => Math.max(m, x.start + x.duration), 0) - 1)) + 1) * zoom - scroll;
      g.fillStyle = accent; g.globalAlpha = 0.22; g.fillRect(a, 26, Math.max(1, b - a), 8); g.globalAlpha = 1;
      g.fillStyle = accent;
      if (seq.inPoint !== undefined) g.fillRect(a, 22, 2, 12);
      if (seq.outPoint !== undefined) g.fillRect(b - 2, 22, 2, 12);
    }
    const { major, minor } = tickStep(zoom, fps);
    const f1 = (scroll + width) / zoom;
    g.font = "10px JetBrains Mono Variable, ui-monospace, monospace";
    g.textBaseline = "top";
    g.strokeStyle = dim; g.globalAlpha = 0.5;
    g.beginPath();
    for (let f = Math.max(0, Math.floor(scroll / zoom / minor) * minor); f <= f1; f += minor) {
      const x = Math.round(f * zoom - scroll) + 0.5;
      g.moveTo(x, 21); g.lineTo(x, 26);
    }
    g.stroke();
    g.globalAlpha = 1;
    g.strokeStyle = mute; g.fillStyle = mute;
    g.beginPath();
    for (let f = Math.max(0, Math.floor(scroll / zoom / major) * major); f <= f1; f += major) {
      const x = Math.round(f * zoom - scroll) + 0.5;
      g.moveTo(x, 13); g.lineTo(x, 26);
      g.fillText(toTimecode(f, fps), x + 3, 2);
    }
    g.stroke();
  }, [seq.inPoint, seq.outPoint, seq.clips, zoom, scroll, width, fps]);

  const frameAt = (clientX: number, el: HTMLElement) => (clientX - el.getBoundingClientRect().left + scroll) / zoom;

  return (
    <div className="tl-ruler" style={{ width }}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("[data-marker]")) return;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const pts = ed().snapping ? snapPoints(seq) : [];
        const go = (cx: number, shift: boolean) => {
          let f = Math.max(0, Math.round(frameAt(cx, el)));
          if (pts.length && !shift) { const s = snapFrame(f, pts, zoom, 6); if (s) f = s.frame; }
          program.pause();
          program.seek(f);
        };
        go(e.clientX, e.shiftKey);
        const move = (ev: PointerEvent) => go(ev.clientX, ev.shiftKey);
        const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
        el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const f = Math.round(frameAt(e.clientX, e.currentTarget));
        openMenu(e, [
          { label: "Add marker here", shortcut: "M", onClick: () => A.addSeqMarker(f) },
          { label: "Mark in here", shortcut: "I", onClick: () => A.markIn(f) },
          { label: "Mark out here", shortcut: "O", onClick: () => A.markOut(f) },
          { label: "Clear in and out", shortcut: "Ctrl+Shift+X", onClick: () => A.clearInOut() },
        ]);
      }}>
      <canvas ref={cv} />
      {seq.markers.map((m) => {
        const x = m.frame * zoom - scroll;
        if (x < -20 || x > width + 20) return null;
        return (
          <div key={m.id}>
            {m.duration > 0 && <div className="tl-marker-range" style={{ left: x, width: m.duration * zoom, background: m.color }} />}
            <div data-marker={m.id} className={clsx("tl-marker", selMarker === m.id && "sel")} style={{ left: x, background: m.color }} title={`${m.name || "Marker"} · ${toTimecode(m.frame, fps)}${m.comment ? `\n${m.comment}` : ""}`}
              onDoubleClick={() => onEditMarker(m.id)}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e, [
                { label: "Edit marker…", onClick: () => onEditMarker(m.id) },
                { label: "Delete marker", danger: true, onClick: () => A.removeSeqMarker(m.id) },
              ]); }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation(); e.preventDefault();
                selectMarker(m.id);
                const x0 = e.clientX, f0 = m.frame;
                let moved = false;
                const move = (ev: PointerEvent) => {
                  const df = Math.round((ev.clientX - x0) / zoom);
                  if (!moved && Math.abs(ev.clientX - x0) < 3) return;
                  if (!moved) { moved = true; gesture.begin("Move marker"); }
                  gesture.previewSeq((s) => ({ ...s, markers: updateMarker(s.markers, m.id, { frame: Math.max(0, f0 + df) }) }));
                };
                const up = () => {
                  window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
                  if (moved) gesture.commit(); else program.seek(m.frame);
                };
                window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
              }} />
          </div>
        );
      })}
    </div>
  );
}

export const Ruler = memo(RulerImpl);
