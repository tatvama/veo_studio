/**
 * One design of the template drawn live (docs/EDITOR.md §16.8): the renderer's picture at the preview time, the safe
 * area (and in 9:16 the zones Reels and Shorts cover), the selected layer with resize handles, and snap lines while
 * moving. Click to select (the topmost unlocked layer), drag to move, handles to resize; Ctrl / ⌘ while dragging turns
 * snapping off, Shift keeps the shape (or one axis when moving), Alt resizes from the centre.
 */
import { clsx } from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor, useProject } from "../../store";
import { drawGraphic, ensureGraphicAssets } from "../render";
import { onAssets } from "../render/images";
import type { GfxRenderInput } from "../render/contract";
import { DESIGN } from "../templates/kit";
import type { Box, GfxRatio } from "../types";
import { setBox } from "./doc";
import { guidesFor, HANDLES, hitLayer, resizeBox, roundBox, safeBox, snapMove, snapResize, type Handle } from "./geometry";
import { change, clock, ds, gestureKey, previewLength, select, useDesigner } from "./state";

/** mediaId → URL of every picture in the edit (photos, a logo from the bin). */
export function useImages(): Record<string, string> {
  const p = useProject();
  const urls = useEditor((s) => s.urls);
  return useMemo(() => {
    const out: Record<string, string> = {};
    for (const m of p.media) { const u = urls[m.id] ?? m.url ?? m.thumb; if (m.kind === "image" && u) out[m.id] = u; }
    return out;
  }, [p.media, urls]);
}

const BG = {
  dark: "linear-gradient(160deg, #1c2333 0%, #0d1018 60%, #151b28 100%)",
  checker: "repeating-conic-gradient(#2a2f3a 0% 25%, #1d212a 0% 50%) 50% / 24px 24px",
  light: "linear-gradient(160deg, #dfe5ee 0%, #b9c3d2 100%)",
};

type Drag =
  | { kind: "move"; id: string; start: Box; px: number; py: number; key: string }
  | { kind: "resize"; id: string; start: Box; px: number; py: number; handle: Handle; key: string };

export function Stage({ ratio, readOnly, compact }: { ratio: GfxRatio; readOnly?: boolean; compact?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const t = useDesigner((s) => s.h.present);
  const look = useDesigner((s) => s.look);
  const values = useDesigner((s) => s.values);
  const sel = useDesigner((s) => s.sel);
  const active = useDesigner((s) => s.ratio === ratio);
  const zoom = useDesigner((s) => (s.view === "single" ? s.zoom : 1));
  const bg = useDesigner((s) => s.bg);
  const images = useImages();
  const [lines, setLines] = useState<{ x?: number; y?: number }>({});
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const D = DESIGN[ratio];
  const own = !!t.designs[ratio];
  const layers = t.designs[ratio]?.layers ?? [];
  const pad = compact ? 12 : 28;
  const fit = Math.max(0.05, Math.min((size.w - pad * 2) / D.w, (size.h - pad * 2 - 18) / D.h));
  const scale = fit * zoom;
  const cssW = Math.max(1, Math.round(D.w * scale)), cssH = Math.max(1, Math.round(D.h * scale));
  const dur = previewLength(t);

  const input = useMemo<GfxRenderInput>(() => ({ template: t, values, look, images, seed: 7, fps: 25, ratio }), [t, values, look, images, ratio]);
  const draw = useRef<() => void>(() => undefined);
  draw.current = () => {
    const c = cv.current;
    if (!c || !look) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const g = c.getContext("2d");
    if (!g) return;
    try { drawGraphic(g, input, W, H, clock.getState().t, dur); } catch (e) { console.warn("designer draw", e); }
  };
  useEffect(() => { draw.current(); }, [input, cssW, cssH, dur]);
  useEffect(() => { let alive = true; void ensureGraphicAssets(input).then(() => { if (alive) draw.current(); }).catch(() => undefined); return () => { alive = false; }; }, [input]);
  useEffect(() => clock.subscribe((s, p) => { if (s.t !== p.t) draw.current(); }), []);
  useEffect(() => onAssets(() => draw.current()), []);

  const overlay = useRef<HTMLDivElement>(null);
  /** A pointer position in design px. */
  const pointFrom = (e: { clientX: number; clientY: number }) => {
    const r = overlay.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale] as const;
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const [px, py] = pointFrom(e);
    const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined;
    const st = ds();
    if (handle && st.sel) {
      const l = layers.find((x) => x.id === st.sel);
      if (!l || readOnly) return;
      drag.current = { kind: "resize", id: l.id, start: l.box, px, py, handle, key: gestureKey(`resize:${l.id}`) };
    } else {
      const hit = hitLayer(layers, px, py, 3 / scale);
      select(hit?.id ?? null, ratio);
      if (!hit || readOnly || !own) return;
      drag.current = { kind: "move", id: hit.id, start: hit.box, px, py, key: gestureKey(`move:${hit.id}`) };
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const [px, py] = pointFrom(e);
    const d = drag.current;
    if (!d) {
      const h = hitLayer(layers, px, py, 3 / scale);
      if ((h?.id ?? null) !== hover) setHover(h?.id ?? null);
      return;
    }
    let dx = px - d.px, dy = py - d.py;
    const snapOn = !(e.ctrlKey || e.metaKey);
    const g = guidesFor(ratio, { layers, safe: t.designs[ratio]?.safe }, new Set([d.id]));
    const th = 7 / scale;
    let box: Box, found: { x?: number; y?: number } = {};
    if (d.kind === "move") {
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      box = [d.start[0] + dx, d.start[1] + dy, d.start[2], d.start[3]];
      if (snapOn) { const s = snapMove(box, g, th); box = s.box; found = s.lines; }
    } else {
      box = resizeBox(d.start, d.handle, dx, dy, { keepAspect: e.shiftKey, fromCenter: e.altKey, min: 4 });
      if (snapOn && !e.shiftKey && !e.altKey) { const s = snapResize(box, d.handle, g, th); box = s.box; found = s.lines; }
    }
    setLines(found);
    const id = d.id;
    change((tt) => setBox(tt, ratio, id, roundBox(box)), d.key);
  };
  const onUp = () => { drag.current = null; setLines({}); };

  const S = safeBox(ratio, t.designs[ratio]);
  const selLayer = sel ? layers.find((l) => l.id === sel) : undefined;
  const hovLayer = hover && hover !== sel ? layers.find((l) => l.id === hover) : undefined;
  const boxStyle = (b: Box, rot?: number): React.CSSProperties => ({
    left: b[0] * scale, top: b[1] * scale, width: b[2] * scale, height: b[3] * scale, transform: rot ? `rotate(${rot}deg)` : undefined,
  });

  return (
    <div ref={wrap} className={clsx("relative min-h-0 min-w-0 flex-1", zoom > 1 ? "overflow-auto" : "overflow-hidden")}>
      <div className="flex min-h-full min-w-full items-center justify-center" style={{ padding: pad, width: zoom > 1 ? cssW + pad * 2 : undefined, height: zoom > 1 ? cssH + pad * 2 + 18 : undefined }}>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-2xs text-dim">
            <span className={clsx("font-medium", active ? "text-accent-ink" : "text-mute")}>{ratio === "16:9" ? "16:9 · TV and YouTube" : ratio === "9:16" ? "9:16 · Reels and Shorts" : ratio}</span>
            {!own && <span className="rounded bg-warn/15 px-1.5 text-warn">automatic: use Make vertical to edit it</span>}
          </div>
          <div className={clsx("relative rounded-sm shadow-[0_8px_40px_-12px_rgb(0_0_0/.7)]", active ? "ring-1 ring-accent/60" : "ring-1 ring-line")}
            style={{ width: cssW, height: cssH, background: BG[bg] }}>
            <canvas ref={cv} className="absolute inset-0" style={{ width: cssW, height: cssH }} />
            <div ref={overlay} className={clsx("absolute inset-0", !readOnly && own && "cursor-default")}
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
              onPointerLeave={() => { if (!drag.current) setHover(null); }}
              onDoubleClick={() => { if (selLayer) window.dispatchEvent(new CustomEvent("nr-designer:focus-text")); }}>
              {/* the safe area, and where Reels and Shorts draw their buttons */}
              <div className="pointer-events-none absolute border border-dashed border-white/25" style={boxStyle(S)} />
              {ratio === "9:16" && (
                <>
                  <div className="pointer-events-none absolute inset-x-0 top-0 bg-white/[0.04]" style={{ height: S[1] * scale }} />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 grid place-items-center bg-white/[0.04] text-[10px] text-white/30" style={{ height: (D.h - S[1] - S[3]) * scale }}>
                    {!compact || cssW > 200 ? "Reels and Shorts put their buttons here" : ""}
                  </div>
                  <div className="pointer-events-none absolute right-0 bg-white/[0.04]" style={{ top: S[1] * scale, height: S[3] * scale, width: (D.w - S[0] - S[2]) * scale }} />
                </>
              )}
              {hovLayer && <div className="pointer-events-none absolute outline outline-1 outline-accent/50" style={boxStyle(hovLayer.box, hovLayer.rotation)} />}
              {selLayer && (
                <div className={clsx("pointer-events-none absolute outline", active ? "outline-[1.5px] outline-accent" : "outline-1 outline-dashed outline-white/60")} style={boxStyle(selLayer.box, selLayer.rotation)}>
                  {active && !readOnly && own && HANDLES.map((h) => (
                    <span key={h} data-handle={h} className="pointer-events-auto absolute size-[9px] rounded-[2px] border border-accent bg-white shadow"
                      style={{
                        left: h.includes("w") ? -5 : h.includes("e") ? "calc(100% - 4px)" : "calc(50% - 4.5px)",
                        top: h.includes("n") ? -5 : h.includes("s") ? "calc(100% - 4px)" : "calc(50% - 4.5px)",
                        cursor: `${h}-resize`,
                      }} />
                  ))}
                </div>
              )}
              {lines.x !== undefined && <div className="pointer-events-none absolute inset-y-0 w-px bg-warn shadow-[0_0_4px_var(--color-warn)]" style={{ left: lines.x * scale }} />}
              {lines.y !== undefined && <div className="pointer-events-none absolute inset-x-0 h-px bg-warn shadow-[0_0_4px_var(--color-warn)]" style={{ top: lines.y * scale }} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
