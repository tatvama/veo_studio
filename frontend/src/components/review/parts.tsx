/**
 * Small presentational pieces shared by the review workspace: tooltip buttons with keyboard hints, the timecode chip and
 * the drawing thumbnail. No state, no maths beyond mapping stored strokes onto a small canvas.
 */
import { clsx } from "clsx";
import { cn } from "../../lib/cn";
import { Clock } from "lucide-react";
import { Fragment, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import type { Stroke } from "../../lib/types";
import { Kbd, Tooltip } from "../ui";
import { formatTC } from "./utils";

/** "Pause (Space)" becomes ["Pause", "Space"]: the existing (translated) label stays the accessible name, the hint becomes keys. */
export function splitHint(label: string): [string, string | null] {
  const m = /^(.*?)\s*\(([^()]{1,14})\)\s*$/.exec(label);
  return m && m[1] ? [m[1], m[2]] : [label, null];
}

/** "Ctrl+Z" renders as two keycaps, "←" as one. */
export function HintKeys({ hint }: { hint: string }) {
  const parts = hint.split("+").map((p) => p.trim()).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{i > 0 && <span aria-hidden className="text-2xs text-dim">+</span>}<Kbd>{p}</Kbd></Fragment>
      ))}
    </>
  );
}

const BASE = "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg text-mute transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-45";
const SIZE = { md: "h-8 min-w-8 max-sm:h-10 max-sm:min-w-10", sm: "h-7 min-w-7 max-sm:h-9 max-sm:min-w-9" };
/** Hit area of every transport / tool button: 40 px on phones, 32 px with a mouse. */
export const BTN = `${BASE} ${SIZE.md}`;
/** Lit state of a toggle button (loop, waveform, draw): accent tint, never a heavy fill. */
export const BTN_ON = "bg-accent/12 text-accent-ink hover:bg-accent/20 hover:text-accent-ink";

/**
 * Compact icon button with a tooltip that shows the label and, when the label ends in "(Key)", the key as a keycap.
 * `label` is also the aria-label, so existing translated strings keep working.
 */
export function BarButton({ label, active, side = "top", size = "md", className, children, disabled, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> & {
  label: string; active?: boolean; side?: "top" | "bottom" | "left" | "right"; size?: "md" | "sm"; children: ReactNode;
}) {
  const [text, hint] = splitHint(label);
  return (
    <Tooltip content={text} shortcut={hint ? <HintKeys hint={hint} /> : undefined} side={side} disabled={disabled}>
      <button type="button" aria-label={label} disabled={disabled} className={cn(BASE, SIZE[size], active && BTN_ON, className)} {...rest}>{children}</button>
    </Tooltip>
  );
}

/** Mono timecode pill. With `onClick` it is a button (seek there); without, a plain readout. */
export function TimecodeChip({ tc, fps, onClick, title, pressed, muted, className, icon = true }: {
  tc: number; fps: number; onClick?: (e: React.MouseEvent) => void; title?: string; pressed?: boolean; muted?: boolean; className?: string; icon?: boolean;
}) {
  const cls = clsx(
    "mono inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 text-2xs font-semibold leading-none transition-colors",
    onClick ? "h-7 max-sm:h-10" : "h-6 max-sm:h-8",
    muted ? "border-line bg-raised text-dim line-through" : "border-accent/25 bg-accent/10 text-accent-ink",
    onClick && (muted ? "hover:bg-hover hover:text-mute" : "hover:bg-accent/20"),
    className,
  );
  const body = <>{icon && <Clock className="size-3" aria-hidden />}{formatTC(tc, fps, true)}</>;
  return onClick
    ? <button type="button" onClick={onClick} title={title} aria-pressed={pressed} className={cls}>{body}</button>
    : <span title={title} className={cls}>{body}</span>;
}

/**
 * Thumbnail of a comment's drawing: the stored strokes (points normalised 0-1, width in thousandths of the frame width)
 * redrawn on a dark tile that has the frame's shape. Pen colours are user data, so they stay inline values.
 */
export function DrawingThumb({ strokes, ratio = 16 / 9, className }: { strokes: Stroke[]; ratio?: number; className?: string }) {
  const t = useT();
  const r = Number.isFinite(ratio) && ratio > 0.2 && ratio < 6 ? ratio : 16 / 9;
  const h = 1000 / r;
  const boxH = 36;
  const boxW = Math.round(Math.min(64, Math.max(24, boxH * r)));
  return (
    <span role="img" aria-label={t("Has a drawing")} title={t("Has a drawing")}
      className={clsx("relative block shrink-0 overflow-hidden rounded-md border border-line bg-black", className)} style={{ width: boxW, height: boxH }}>
      <svg viewBox={`0 0 1000 ${h}`} preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden>
        {strokes.map((s, i) => {
          const pts = s.points ?? [];
          if (!pts.length) return null;
          const colour = s.color || "currentColor";
          const lw = Math.max(26, (s.width ?? 4) * 5);
          if (pts.length === 1) return <circle key={i} cx={pts[0][0] * 1000} cy={pts[0][1] * h} r={lw / 2} fill={colour} />;
          const d = pts.map((p, j) => `${j ? "L" : "M"}${(p[0] * 1000).toFixed(1)} ${(p[1] * h).toFixed(1)}`).join("");
          return <path key={i} d={d} fill="none" stroke={colour} strokeWidth={lw} strokeLinecap="round" strokeLinejoin="round" />;
        })}
      </svg>
    </span>
  );
}
