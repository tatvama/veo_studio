/** Colour, gradient, shadow and blend helpers that turn document values into Konva / canvas 2D settings. */
import type { Blend, Gradient, Paint, Role, Shadow } from "../types";

export const isGradient = (p: Paint | null | undefined): p is Gradient => !!p && typeof p === "object";

/** Parse #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() into [r, g, b, a(0..1)]. Unknown strings → null. */
export function parseColor(c: string): [number, number, number, number] | null {
  const s = c.trim().toLowerCase();
  if (s === "transparent") return [0, 0, 0, 0];
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const v = h.split("").map((x) => parseInt(x + x, 16));
      return [v[0], v[1], v[2], h.length === 4 ? v[3] / 255 : 1];
    }
    if (h.length === 6 || h.length === 8) {
      const v = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2) || "ff", 16));
      return [v[0], v[1], v[2], h.length === 8 ? v[3] / 255 : 1];
    }
    return null;
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => (x.endsWith("%") ? (parseFloat(x) / 100) * 255 : parseFloat(x)));
    if (p.length < 3) return null;
    const a = p.length > 3 ? (m[1].includes("%") && p[3] > 1 ? p[3] / 255 : p[3]) : 1;
    return [p[0], p[1], p[2], Math.max(0, Math.min(1, a))];
  }
  return null;
}

export function rgba(c: string, alpha: number): string {
  const p = parseColor(c);
  if (!p) return c;
  return `rgba(${Math.round(p[0])},${Math.round(p[1])},${Math.round(p[2])},${+(p[3] * alpha).toFixed(4)})`;
}

export function isTransparent(p: Paint | null | undefined): boolean {
  if (!p) return true;
  if (isGradient(p)) return p.stops.every((s) => (parseColor(s.color)?.[3] ?? 1) === 0);
  return (parseColor(p)?.[3] ?? 1) === 0;
}

/** A representative solid colour for a paint (first stop of a gradient). */
export function solidOf(p: Paint | null | undefined, fallback = "#ffffff"): string {
  if (!p) return fallback;
  return isGradient(p) ? (p.stops[0]?.color ?? fallback) : p;
}

export function sortedStops(g: Gradient) {
  return [...g.stops].sort((a, b) => a.offset - b.offset).map((s) => ({ offset: Math.max(0, Math.min(1, s.offset)), color: s.color }));
}

/** Start/end points of a linear gradient at `angle` (0 = left→right, 90 = top→bottom) spanning a w×h box at (ox, oy). */
export function linearPoints(angle: number, w: number, h: number, ox = 0, oy = 0) {
  const a = (angle * Math.PI) / 180;
  const dx = Math.cos(a), dy = Math.sin(a);
  const half = Math.abs((w / 2) * dx) + Math.abs((h / 2) * dy);
  const cx = ox + w / 2, cy = oy + h / 2;
  return { start: { x: cx - dx * half, y: cy - dy * half }, end: { x: cx + dx * half, y: cy + dy * half } };
}

/**
 * Konva fill attributes for a paint over a w×h box whose top-left is at (ox, oy) in the shape's local space
 * (ellipses have their origin at the centre, so they pass ox = -w/2, oy = -h/2).
 */
export function konvaFill(p: Paint | null | undefined, w: number, h: number, ox = 0, oy = 0): Record<string, unknown> {
  if (!p) return { fill: undefined, fillEnabled: false };
  if (!isGradient(p)) return { fill: p };
  const stops = sortedStops(p).flatMap((s) => [s.offset, s.color]);
  if (p.type === "radial") {
    const c = { x: ox + w / 2, y: oy + h / 2 };
    return {
      fillPriority: "radial-gradient", fillRadialGradientStartPoint: c, fillRadialGradientEndPoint: c,
      fillRadialGradientStartRadius: 0, fillRadialGradientEndRadius: Math.max(w, h) / 2, fillRadialGradientColorStops: stops,
    };
  }
  const { start, end } = linearPoints(p.angle, w, h, ox, oy);
  return { fillPriority: "linear-gradient", fillLinearGradientStartPoint: start, fillLinearGradientEndPoint: end, fillLinearGradientColorStops: stops };
}

/** A canvas 2D fill style for a paint over the box (0,0)-(w,h). */
export function canvasPaint(ctx: CanvasRenderingContext2D, p: Paint, w: number, h: number, ox = 0, oy = 0): string | CanvasGradient {
  if (!isGradient(p)) return p;
  let g: CanvasGradient;
  if (p.type === "radial") {
    g = ctx.createRadialGradient(ox + w / 2, oy + h / 2, 0, ox + w / 2, oy + h / 2, Math.max(w, h) / 2);
  } else {
    const { start, end } = linearPoints(p.angle, w, h, ox, oy);
    g = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
  }
  for (const s of sortedStops(p)) {
    try { g.addColorStop(s.offset, s.color); } catch { /* bad colour string */ }
  }
  return g;
}

/** CSS background for a paint (text editor, swatches). */
export function cssPaint(p: Paint): string {
  if (!isGradient(p)) return p;
  const stops = sortedStops(p).map((s) => `${s.color} ${Math.round(s.offset * 100)}%`).join(", ");
  return p.type === "radial" ? `radial-gradient(circle, ${stops})` : `linear-gradient(${p.angle + 90}deg, ${stops})`;
}

export function shadowProps(s: Shadow | null | undefined): Record<string, unknown> {
  if (!s || (s.opacity <= 0)) return { shadowEnabled: false };
  return {
    shadowEnabled: true, shadowColor: s.color, shadowBlur: Math.max(0, s.blur), shadowOffsetX: s.x, shadowOffsetY: s.y,
    shadowOpacity: Math.max(0, Math.min(1, s.opacity)), shadowForStrokeEnabled: false,
  };
}

export function compositeOf(b: Blend | undefined): GlobalCompositeOperation {
  return !b || b === "normal" ? "source-over" : (b as GlobalCompositeOperation);
}

/** Tint for empty slots and AI placeholders, by role (design content, not UI chrome). */
export function roleTint(role: Role | undefined): string {
  switch (role) {
    case "background": return "#818cf8";
    case "character": return "#a78bfa";
    case "product": return "#f59e0b";
    case "logo": return "#34d399";
    case "photo": return "#22d3ee";
    default: return "#94a3b8";
  }
}

export function roleLabel(role: Role | undefined): string {
  switch (role) {
    case "background": return "Background";
    case "character": return "Character";
    case "product": return "Product";
    case "logo": return "Logo";
    case "photo": return "Photo";
    default: return "Image";
  }
}
