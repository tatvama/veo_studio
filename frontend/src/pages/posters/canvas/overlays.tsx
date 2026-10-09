/**
 * Editor-only drawings in screen space (never exported): safe areas, grid, hover and locked-selection outlines,
 * smart guides with equal-spacing hints, the marquee and the drop-target highlight. Nothing here listens to events.
 */
import { Group, Line, Rect, Shape, Text } from "react-konva";
import type { Box } from "../doc";
import type { Format } from "../formats";
import type { Layer } from "../types";
import type { CanvasColors } from "./colors";
import { rgba } from "./paint";
import type { GapHint, Guide } from "./snap";

export interface View { x: number; y: number; z: number }

export const toScreen = (v: View, x: number, y: number) => ({ x: v.x + x * v.z, y: v.y + y * v.z });

/** The four corners of a (rotated) layer box in screen space, as a flat points array. */
export function cornerPoints(v: View, l: Pick<Layer, "x" | "y" | "width" | "height" | "rotation">): number[] {
  const r = ((l.rotation || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [[0, 0], [l.width, 0], [l.width, l.height], [0, l.height]].flatMap(([px, py]) => {
    const p = toScreen(v, l.x + px * c - py * s, l.y + px * s + py * c);
    return [p.x, p.y];
  });
}

export function SafeArea({ view, W, H, safe, colors, label }: { view: View; W: number; H: number; safe: Format["safe"]; colors: CanvasColors; label: string }) {
  if (!safe) return null;
  const t = (safe.top ?? 0) * H, b = (safe.bottom ?? 0) * H, l = (safe.left ?? 0) * W, r = (safe.right ?? 0) * W;
  const p0 = toScreen(view, 0, 0), p1 = toScreen(view, W, H);
  const s0 = toScreen(view, l, t), s1 = toScreen(view, W - r, H - b);
  const shade = rgba(colors.safe, 0.1);
  return (
    <Group listening={false}>
      {t > 0 && <Rect x={p0.x} y={p0.y} width={p1.x - p0.x} height={s0.y - p0.y} fill={shade} />}
      {b > 0 && <Rect x={p0.x} y={s1.y} width={p1.x - p0.x} height={p1.y - s1.y} fill={shade} />}
      {l > 0 && <Rect x={p0.x} y={s0.y} width={s0.x - p0.x} height={s1.y - s0.y} fill={shade} />}
      {r > 0 && <Rect x={s1.x} y={s0.y} width={p1.x - s1.x} height={s1.y - s0.y} fill={shade} />}
      <Rect x={s0.x} y={s0.y} width={s1.x - s0.x} height={s1.y - s0.y} stroke={rgba(colors.safe, 0.85)} strokeWidth={1} dash={[5, 4]} />
      {s1.x - s0.x > 90 && s1.y - s0.y > 30 && (
        <Text x={s1.x - 126} y={s1.y - 16} width={120} align="right" text={label} fontSize={10} fontFamily="JetBrains Mono Variable, monospace"
          fill={rgba(colors.safe, 0.95)} letterSpacing={0.6} />
      )}
    </Group>
  );
}

const STEPS = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];

export function GridOverlay({ view, W, H, colors }: { view: View; W: number; H: number; colors: CanvasColors }) {
  const step = STEPS.find((s) => s * view.z >= 18) ?? 2000;
  return (
    <Shape
      listening={false} perfectDrawEnabled={false}
      sceneFunc={(ctx) => {
        const c = ctx._context;
        const p0 = toScreen(view, 0, 0), p1 = toScreen(view, W, H);
        c.save();
        c.beginPath();
        c.rect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
        c.clip();
        c.lineWidth = 1;
        c.strokeStyle = rgba(colors.accent, 0.16);
        c.beginPath();
        for (let x = step; x < W; x += step) { const sx = Math.round(view.x + x * view.z) + 0.5; c.moveTo(sx, p0.y); c.lineTo(sx, p1.y); }
        for (let y = step; y < H; y += step) { const sy = Math.round(view.y + y * view.z) + 0.5; c.moveTo(p0.x, sy); c.lineTo(p1.x, sy); }
        c.stroke();
        // rule of thirds, a little stronger
        c.strokeStyle = rgba(colors.accent, 0.42);
        c.setLineDash([4, 4]);
        c.beginPath();
        for (const f of [1 / 3, 2 / 3]) {
          const sx = Math.round(view.x + W * f * view.z) + 0.5, sy = Math.round(view.y + H * f * view.z) + 0.5;
          c.moveTo(sx, p0.y); c.lineTo(sx, p1.y); c.moveTo(p0.x, sy); c.lineTo(p1.x, sy);
        }
        c.stroke();
        c.restore();
      }}
    />
  );
}

export function Outline({ view, layer, color, dashed, width = 1.5 }: { view: View; layer: Layer; color: string; dashed?: boolean; width?: number }) {
  return <Line points={cornerPoints(view, layer)} closed stroke={color} strokeWidth={width} dash={dashed ? [4, 3] : undefined} listening={false} perfectDrawEnabled={false} />;
}

export function Guides({ view, guides, gaps, colors }: { view: View; guides: Guide[]; gaps: GapHint[]; colors: CanvasColors }) {
  return (
    <Group listening={false}>
      {guides.map((g, i) => {
        const pts = g.axis === "x"
          ? [view.x + g.pos * view.z, view.y + g.from * view.z, view.x + g.pos * view.z, view.y + g.to * view.z]
          : [view.x + g.from * view.z, view.y + g.pos * view.z, view.x + g.to * view.z, view.y + g.pos * view.z];
        return <Line key={`g${i}`} points={pts.map((p) => Math.round(p) + 0.5)} stroke={colors.guide} strokeWidth={1} perfectDrawEnabled={false} />;
      })}
      {gaps.flatMap((gh, i) => gh.segments.map((s, j) => {
        const horiz = gh.axis === "x";
        const a = horiz ? toScreen(view, s.a, s.at) : toScreen(view, s.at, s.a);
        const b = horiz ? toScreen(view, s.b, s.at) : toScreen(view, s.at, s.b);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const label = String(Math.round(gh.size));
        const lw = label.length * 6.2 + 8;
        return (
          <Group key={`s${i}-${j}`}>
            <Line points={[a.x, a.y, b.x, b.y]} stroke={colors.gap} strokeWidth={1} />
            <Line points={horiz ? [a.x, a.y - 4, a.x, a.y + 4] : [a.x - 4, a.y, a.x + 4, a.y]} stroke={colors.gap} strokeWidth={1} />
            <Line points={horiz ? [b.x, b.y - 4, b.x, b.y + 4] : [b.x - 4, b.y, b.x + 4, b.y]} stroke={colors.gap} strokeWidth={1} />
            <Rect x={mid.x - lw / 2} y={mid.y - 8} width={lw} height={16} cornerRadius={4} fill={colors.gap} />
            <Text x={mid.x - lw / 2} y={mid.y - 8} width={lw} height={16} text={label} align="center" verticalAlign="middle" fontSize={10}
              fontFamily="JetBrains Mono Variable, monospace" fill="#ffffff" />
          </Group>
        );
      }))}
    </Group>
  );
}

export function Marquee({ view, box, colors }: { view: View; box: Box; colors: CanvasColors }) {
  const p = toScreen(view, box.x, box.y);
  return <Rect x={p.x} y={p.y} width={box.width * view.z} height={box.height * view.z} fill={rgba(colors.accent, 0.08)} stroke={colors.accent} strokeWidth={1} listening={false} />;
}

export function DropTarget({ view, layer, colors }: { view: View; layer: Layer; colors: CanvasColors }) {
  return (
    <Group listening={false}>
      <Line points={cornerPoints(view, layer)} closed fill={rgba(colors.accent, 0.14)} stroke={colors.accent} strokeWidth={2}
        shadowColor={colors.accent} shadowBlur={14} shadowOpacity={0.8} perfectDrawEnabled={false} />
    </Group>
  );
}
