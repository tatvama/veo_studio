/**
 * A tiny SVG renderer for shape and text layers: the previews of shapes, badges and stickers in the left panel. It draws
 * the very layers the item will add, so the preview matches, without mounting a canvas per tile. Images and effects
 * are not drawn (items that need them use CSS previews).
 */
import { useId, type ReactNode } from "react";
import { boundsOf, displayText, unionBox } from "../../doc";
import { familyStack } from "../../fonts";
import type { Layer, Paint, ShapeLayer, TextLayer } from "../../types";

function paint(p: Paint | null | undefined, id: string, defs: ReactNode[]): string {
  if (!p) return "none";
  if (typeof p === "string") return p;
  const stops = p.stops.map((s, i) => <stop key={i} offset={s.offset} stopColor={s.color} />);
  if (p.type === "radial") defs.push(<radialGradient key={id} id={id}>{stops}</radialGradient>);
  else defs.push(<linearGradient key={id} id={id} gradientTransform={`rotate(${p.angle} 0.5 0.5)`}>{stops}</linearGradient>);
  return `url(#${id})`;
}

const pts = (arr: [number, number][]) => arr.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

/** Fit a closed polygon exactly into the layer's box (as the canvas does). */
function fit(raw: [number, number][], l: ShapeLayer): string {
  const xs = raw.map((p) => p[0]), ys = raw.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sx = l.width / (x1 - x0 || 1), sy = l.height / (y1 - y0 || 1);
  return pts(raw.map(([x, y]) => [l.x + (x - x0) * sx, l.y + (y - y0) * sy]));
}

function starPoints(l: ShapeLayer): string {
  const burst = l.shape === "burst";
  const n = Math.min(64, Math.max(3, Math.round(l.points ?? (burst ? 16 : 5))));
  const inner = Math.min(0.98, Math.max(0.05, l.innerRatio ?? (burst ? 0.82 : 0.45)));
  return fit(Array.from({ length: n * 2 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / n, r = i % 2 ? inner : 1;
    return [Math.cos(a) * r, Math.sin(a) * r] as [number, number];
  }), l);
}

function polygonPoints(l: ShapeLayer): string {
  const n = Math.min(24, Math.max(3, Math.round(l.sides ?? 6)));
  return fit(Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [Math.cos(a), Math.sin(a)] as [number, number];
  }), l);
}

function shape(l: ShapeLayer, fill: string, key: string): ReactNode {
  const common = {
    fill, stroke: l.stroke?.color, strokeWidth: l.stroke?.width, strokeDasharray: l.dash?.join(" "), opacity: l.opacity,
    transform: l.rotation ? `rotate(${l.rotation} ${l.x} ${l.y})` : undefined,
  };
  const { x, y, width: w, height: h } = l;
  switch (l.shape) {
    case "rect": return <rect key={key} x={x} y={y} width={w} height={h} rx={l.cornerRadius ?? 0} {...common} />;
    case "ellipse": return <ellipse key={key} cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />;
    case "triangle": return <polygon key={key} points={pts([[x + w / 2, y], [x + w, y + h], [x, y + h]])} {...common} />;
    case "star":
    case "burst": return <polygon key={key} points={starPoints(l)} {...common} />;
    case "polygon": return <polygon key={key} points={polygonPoints(l)} {...common} />;
    case "ring": {
      const cx = x + w / 2, cy = y + h / 2, k = l.innerRatio ?? 0.78;
      const ell = (rx: number, ry: number) => `M ${cx - rx} ${cy} a ${rx} ${ry} 0 1 0 ${rx * 2} 0 a ${rx} ${ry} 0 1 0 ${-rx * 2} 0 Z`;
      return <path key={key} d={`${ell(w / 2, h / 2)} ${ell((w / 2) * k, (h / 2) * k)}`} fillRule="evenodd" {...common} />;
    }
    case "line": return <rect key={key} x={x} y={y} width={w} height={h} {...common} />;
    case "arrow": {
      const head = Math.min(w * 0.45, h * 1.6), shaft = h * 0.36, m = y + h / 2;
      return <polygon key={key} points={pts([[x, m - shaft / 2], [x + w - head, m - shaft / 2], [x + w - head, y], [x + w, m], [x + w - head, y + h],
        [x + w - head, m + shaft / 2], [x, m + shaft / 2]])} {...common} />;
    }
  }
}

function text(l: TextLayer, fill: string, key: string): ReactNode {
  const lines = displayText(l).split("\n");
  const lh = l.fontSize * l.lineHeight;
  const anchor = l.align === "left" ? "start" : l.align === "right" ? "end" : "middle";
  const tx = l.align === "left" ? l.x : l.align === "right" ? l.x + l.width : l.x + l.width / 2;
  const top = l.y + l.height / 2 - (lines.length * lh) / 2 + lh / 2;
  const rot = l.rotation ? `rotate(${l.rotation} ${l.x} ${l.y})` : undefined;
  return (
    <g key={key} opacity={l.opacity} transform={rot}>
      {l.background && <rect x={l.x} y={l.y} width={l.width} height={l.height} rx={l.background.radius} fill={l.background.color} />}
      <text fill={fill} fontFamily={familyStack(l.fontFamily)} fontSize={l.fontSize} fontWeight={l.fontWeight} fontStyle={l.fontStyle}
        letterSpacing={l.letterSpacing} textAnchor={anchor} dominantBaseline="central"
        stroke={l.stroke?.color} strokeWidth={l.stroke ? l.stroke.width * 2 : undefined} paintOrder="stroke" strokeLinejoin="round">
        {lines.map((ln, i) => <tspan key={i} x={tx} y={top + i * lh}>{ln}</tspan>)}
      </text>
    </g>
  );
}

/** Draws shape and text layers into an SVG that fits its box (keeps aspect ratio). */
export function MiniLayers({ layers, className, pad = 0.06, ghost }: { layers: Layer[]; className?: string; pad?: number; ghost?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const box = unionBox(layers.map(boundsOf)) ?? { x: 0, y: 0, width: 1, height: 1 };
  const m = Math.max(box.width, box.height) * pad;
  const defs: ReactNode[] = [];
  const body = layers.map((l, i) => {
    const key = `${uid}_${i}`;
    if (l.type === "shape") return shape(l, paint(l.fill, `g${key}`, defs), key);
    if (l.type === "text") return text(l, paint(l.fill, `g${key}`, defs), key);
    return null;
  });
  return (
    <svg viewBox={`${box.x - m} ${box.y - m} ${box.width + m * 2} ${box.height + m * 2}`} preserveAspectRatio="xMidYMid meet"
      className={className} aria-hidden data-ghost={ghost ? "" : undefined}>
      {defs.length > 0 && <defs>{defs}</defs>}
      {body}
    </svg>
  );
}
