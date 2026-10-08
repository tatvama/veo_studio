import { clsx } from "clsx";
import { Check, PenLine, Trash2, Undo2 } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef } from "react";
import { useT } from "../../lib/i18n";
import type { Stroke } from "../../lib/types";
import { Button, IconButton } from "../ui";

/** Pen colours are user data (stored with the comment), so they are plain values rather than theme tokens. */
export const PEN_COLORS = ["#ef4444", "#f59e0b", "#facc15", "#22c55e", "#38bdf8", "#a855f7", "#ffffff"];
/** Stroke width is stored in thousandths of the frame width, so drawings look the same at any player size. */
export const PEN_SIZES = [3, 6, 11];
const MAX_POINTS = 600;

function paint(ctx: CanvasRenderingContext2D, s: Stroke, w: number, h: number) {
  const pts = s.points;
  if (!pts?.length) return;
  const lw = Math.max(1.5, ((s.width ?? 4) * w) / 1000);
  ctx.strokeStyle = s.color || PEN_COLORS[0];
  ctx.fillStyle = s.color || PEN_COLORS[0];
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0] * w, pts[0][1] * h, lw / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = ((pts[i][0] + pts[i + 1][0]) / 2) * w;
    const my = ((pts[i][1] + pts[i + 1][1]) / 2) * h;
    ctx.quadraticCurveTo(pts[i][0] * w, pts[i][1] * h, mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0] * w, last[1] * h);
  ctx.stroke();
}

/**
 * Frame annotation layer. Sits exactly over the visible picture (the parent passes the letterboxed content rect),
 * stores points normalised to 0–1 so drawings line up at any size, fullscreen included.
 */
export function DrawCanvas({ width, height, strokes, editable = false, color = PEN_COLORS[0], size = PEN_SIZES[1], onStroke }: {
  width: number; height: number; strokes: Stroke[]; editable?: boolean; color?: string; size?: number;
  onStroke?: (s: Stroke) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef<Stroke | null>(null);
  const raf = useRef(0);

  const redraw = () => {
    const c = ref.current;
    if (!c || width <= 0 || height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(width * dpr);
    const H = Math.round(height * dpr);
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 3;
    for (const s of strokes) paint(ctx, s, width, height);
    if (live.current) paint(ctx, live.current, width, height);
  };

  useEffect(redraw, [strokes, width, height]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const point = (e: React.PointerEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    return [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000];
  };
  const schedule = () => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(redraw);
  };

  return (
    <canvas
      ref={ref}
      className={clsx("absolute inset-0 touch-none", editable ? "cursor-crosshair" : "pointer-events-none")}
      style={{ width, height }}
      onPointerDown={(e) => {
        if (!editable || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        live.current = { color, width: size, points: [point(e)] };
        schedule();
      }}
      onPointerMove={(e) => {
        const s = live.current;
        if (!s) return;
        const p = point(e);
        const last = s.points[s.points.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.002 || s.points.length >= MAX_POINTS) return;
        s.points.push(p);
        schedule();
      }}
      onPointerUp={(e) => {
        const s = live.current;
        live.current = null;
        if (!s) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        onStroke?.(s);
      }}
      onPointerCancel={() => { live.current = null; schedule(); }}
      onClick={(e) => editable && e.stopPropagation()}
    />
  );
}

/**
 * Pen toolbar. Docks between the picture and the player controls (so it never covers the frame being annotated and
 * stays usable on a phone, where it wraps onto two lines).
 */
export function DrawToolbar({ color, setColor, size, setSize, count, onUndo, onClear, onDone }: {
  color: string; setColor: (c: string) => void; size: number; setSize: (s: number) => void; count: number;
  onUndo: () => void; onClear: () => void; onDone: () => void;
}) {
  const t = useT();
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="shrink-0 overflow-hidden border-t border-accent/30 bg-accent/[0.06]"
      role="toolbar"
      aria-label={t("Drawing tools")}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3 py-1.5">
        <PenLine className="size-4 shrink-0 text-accent-ink" aria-hidden />
        <div className="flex items-center" role="radiogroup" aria-label={t("Pen colour")}>
          {PEN_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={`${t("Pen colour")} ${c}`} onClick={() => setColor(c)}
              className={clsx("grid size-7 place-items-center rounded-full transition-transform hover:scale-110 max-sm:size-9")}>
              <span className={clsx("block size-4 rounded-full border border-black/30 shadow-sm transition-[box-shadow,transform]",
                color === c && "scale-110 ring-2 ring-accent ring-offset-2 ring-offset-panel")} style={{ background: c }} />
            </button>
          ))}
        </div>
        <span className="hidden h-5 w-px bg-line sm:block" />
        <div className="flex items-center" role="radiogroup" aria-label={t("Pen size")}>
          {PEN_SIZES.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={size === s} aria-label={`${t("Pen size")} ${s}`} onClick={() => setSize(s)}
              className={clsx("grid size-7 place-items-center rounded-md transition-colors hover:bg-hover max-sm:size-9", size === s && "bg-hover ring-1 ring-inset ring-line")}>
              <span className="rounded-full bg-ink" style={{ width: 3 + s * 0.8, height: 3 + s * 0.8 }} />
            </button>
          ))}
        </div>
        <span className="hidden h-5 w-px bg-line sm:block" />
        <div className="flex items-center">
          <IconButton title={t("Undo (Ctrl+Z)")} disabled={!count} onClick={onUndo} className="!size-7 max-sm:!size-9"><Undo2 className="size-4" /></IconButton>
          <IconButton title={t("Clear drawing")} disabled={!count} onClick={onClear} className="!size-7 max-sm:!size-9"><Trash2 className="size-4" /></IconButton>
        </div>
        <div className="flex-1" />
        <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={onDone} title={t("Done (D)")}>{t("Done")}</Button>
      </div>
    </motion.div>
  );
}
