/**
 * Konva renderers for every layer type. Shared by the live editor, read-only previews and the exporter.
 * Each layer is an outer Group at (x, y) rotated around its origin, whose client rect is exactly its box (so the
 * Transformer and snapping see the layer's frame, not overflowing glyphs or shadows). Visual children never listen;
 * an invisible hit rect on top receives pointer events in the editor.
 * Nodes named "ui-only" (empty-slot placeholders, AI shimmers, loading tints) are hidden by the exporter.
 */
import Konva from "konva";
import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { Ellipse, Group, Image as KImage, Line, Rect, Shape } from "react-konva";
import { tr } from "../../../lib/i18n";
import type { AiKind, Background, EffectLayer, ImageFilters, ImageLayer, Layer, ShapeLayer, TextLayer } from "../types";
import { useCacheScale } from "./cacheScale";
import { imageFailed, useImage } from "./images";
import { compositeOf, isTransparent, konvaFill, linearPoints, rgba, roleLabel, roleTint, shadowProps, solidOf } from "./paint";
import { grainPattern, scanlinePattern } from "./patterns";
import { drawText, layoutText } from "./textLayout";

export type RenderMode = "edit" | "preview";
type IRect = { x: number; y: number; width: number; height: number };
type DragBound = (this: Konva.Node, pos: Konva.Vector2d) => Konva.Vector2d;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const TAU = Math.PI * 2;

export function reducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return document.documentElement.dataset.motion === "reduced" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

// ── layer frame ──────────────────────────────────────────

/** The layer's client rect is its box (boxW × boxH attrs), whatever its children draw. */
function boxRect(this: Konva.Group, cfg?: { skipTransform?: boolean; relativeTo?: Konva.Container }): IRect {
  const r = { x: 0, y: 0, width: Number(this.getAttr("boxW")) || 0, height: Number(this.getAttr("boxH")) || 0 };
  if (cfg?.skipTransform) return r;
  return (this as unknown as { _transformedRect(r: IRect, top?: Konva.Container): IRect })._transformedRect(r, cfg?.relativeTo);
}
/** Drag results are committed by the stage (one undo step for the whole selection); this only tells react-konva so. */
const handledByStage = () => {};

const patchFrame = (n: Konva.Group | null) => {
  if (n) (n as unknown as { getClientRect: typeof boxRect }).getClientRect = boxRect;
};

export interface LayerViewProps {
  layer: Layer;
  mode: RenderMode;
  fontsVersion: number;
  /** screen pixels per design pixel, for placeholder strokes and labels (pass 1 when unused, to keep memo hits) */
  zoom: number;
  hit?: boolean;
  draggable?: boolean;
  dragBound?: DragBound;
  /** the inline text editor is open over this layer */
  textHidden?: boolean;
  /** override the global cache resolution (previews) */
  cacheScale?: number;
  /** an empty slot covered by another: draw just its frame */
  quiet?: boolean;
}

export const LayerView = memo(function LayerView({ layer: l, mode, fontsVersion, zoom, hit, draggable, dragBound, textHidden, cacheScale, quiet }: LayerViewProps) {
  const w = Math.max(1, l.width), h = Math.max(1, l.height);
  let body: React.ReactNode = null;
  if (l.type === "image") body = <ImageView l={l} w={w} h={h} mode={mode} zoom={zoom} cacheScale={cacheScale} quiet={!!quiet} />;
  else if (l.type === "text") body = <TextView l={l} w={w} h={h} fontsVersion={fontsVersion} hidden={!!textHidden} />;
  else if (l.type === "shape") body = <ShapeView l={l} w={w} h={h} />;
  else if (l.type === "effect") body = <EffectView l={l} w={w} h={h} />;
  const flipped = l.flipX || l.flipY;
  return (
    <Group
      ref={patchFrame} id={l.id} name="layer" layerType={l.type} boxW={w} boxH={h}
      x={l.x} y={l.y} rotation={l.rotation || 0} opacity={clamp(l.opacity ?? 1, 0, 1)} visible={l.visible !== false}
      listening={!!hit} draggable={!!draggable} dragBoundFunc={dragBound} onDragEnd={draggable ? handledByStage : undefined}
    >
      {flipped ? (
        <Group x={l.flipX ? w : 0} y={l.flipY ? h : 0} scaleX={l.flipX ? -1 : 1} scaleY={l.flipY ? -1 : 1} listening={false}>{body}</Group>
      ) : body}
      {hit && <Rect name="hit" width={w} height={h} fill="rgba(0,0,0,0)" perfectDrawEnabled={false} />}
    </Group>
  );
});

export function BackgroundView({ bg, W, H }: { bg: Background; W: number; H: number }) {
  const paint = bg.gradient && bg.gradient.stops?.length ? bg.gradient : bg.color;
  return <Rect name="page-bg" width={W} height={H} {...konvaFill(paint, W, H)} listening={false} perfectDrawEnabled={false} />;
}

// ── images ───────────────────────────────────────────────

type KFilter = (this: Konva.Node, imageData: ImageData) => void;

function activeFilters(f: ImageFilters): KFilter[] {
  const F = Konva.Filters;
  const out: KFilter[] = [];
  if (f.blur && f.blur > 0) out.push(F.Blur);
  if (f.brightness) out.push(F.Brighten);
  if (f.contrast) out.push(F.Contrast);
  if (f.saturation || f.hue || f.luminance) out.push(F.HSL);
  if (f.grayscale) out.push(F.Grayscale);
  if (f.sepia) out.push(F.Sepia);
  if (f.invert) out.push(F.Invert);
  if (f.noise && f.noise > 0) out.push(F.Noise);
  if (f.pixelate && f.pixelate > 1) out.push(F.Pixelate);
  return out;
}

/** Filter attributes; pixel-sized ones scale with the cache resolution so they look the same at any zoom or export size. */
function filterValues(f: ImageFilters, ratio: number): Record<string, number> {
  return {
    blurRadius: Math.round((f.blur ?? 0) * ratio), brightness: f.brightness ?? 0, contrast: f.contrast ?? 0,
    saturation: f.saturation ?? 0, hue: f.hue ?? 0, luminance: f.luminance ?? 0, noise: f.noise ?? 0,
    pixelSize: Math.max(1, Math.round((f.pixelate ?? 1) * ratio)),
  };
}

function fadeFill(mask: ImageLayer["mask"], h: number) {
  const top = mask === "fade-top";
  return {
    fillLinearGradientStartPoint: { x: 0, y: top ? h : 0 }, fillLinearGradientEndPoint: { x: 0, y: top ? 0 : h },
    fillLinearGradientColorStops: [0, "rgba(0,0,0,1)", 0.5, "rgba(0,0,0,1)", 0.78, "rgba(0,0,0,0.5)", 1, "rgba(0,0,0,0)"],
  };
}

/** Where the bitmap lands in the box for each fit mode (with the focus point steering the crop or the alignment). */
export function imageGeometry(l: ImageLayer, nw: number, nh: number, w: number, h: number) {
  const fx = clamp(l.focusX ?? 0.5, 0, 1), fy = clamp(l.focusY ?? 0.5, 0, 1);
  if (l.fit === "cover") {
    const s = Math.max(w / nw, h / nh);
    const cw = w / s, ch = h / s;
    return { crop: { x: (nw - cw) * fx, y: (nh - ch) * fy, width: cw, height: ch }, dx: 0, dy: 0, dw: w, dh: h, density: 1 / s };
  }
  if (l.fit === "contain") {
    const s = Math.min(w / nw, h / nh);
    const dw = nw * s, dh = nh * s;
    return { crop: undefined, dx: (w - dw) * fx, dy: (h - dh) * fy, dw, dh, density: 1 / s };
  }
  return { crop: undefined, dx: 0, dy: 0, dw: w, dh: h, density: Math.max(nw / w, nh / h) };
}

function ImageView({ l, w, h, mode, zoom, cacheScale, quiet }: { l: ImageLayer; w: number; h: number; mode: RenderMode; zoom: number; cacheScale?: number; quiet: boolean }) {
  const img = useImage(l.src || null);
  const loading = !!l.src && !img && !imageFailed(l.src);
  return (
    <>
      {img && <ImageBody l={l} img={img} w={w} h={h} cacheScale={cacheScale} />}
      {!l.src && !l.pending && <EmptySlot l={l} w={w} h={h} zoom={zoom} mode={mode} quiet={quiet} />}
      {l.src && !img && !l.pending && (
        <Rect name="ui-only" width={w} height={h} fill={rgba(roleTint(l.role), loading ? 0.1 : 0.18)} listening={false} />
      )}
      {l.pending && <PendingView l={l} w={w} h={h} mode={mode} hasImage={!!img} />}
    </>
  );
}

function ImageBody({ l, img, w, h, cacheScale }: { l: ImageLayer; img: HTMLImageElement; w: number; h: number; cacheScale?: number }) {
  const globalScale = useCacheScale();
  const nw = img.naturalWidth || l.naturalWidth || w, nh = img.naturalHeight || l.naturalHeight || h;
  const { crop, dx, dy, dw, dh, density } = imageGeometry(l, nw, nh, w, h);
  const circle = l.mask === "circle";
  const fade = l.mask === "fade-bottom" || l.mask === "fade-top";
  const f = l.filters ?? {};
  const filters = activeFilters(f);
  const cached = fade || filters.length > 0;
  const gco = compositeOf(l.blend);
  const cr = circle ? 0 : clamp(l.cornerRadius ?? 0, 0, Math.min(dw, dh) / 2);
  const maxRatio = Math.min(Math.max(1, density), Math.sqrt(24e6 / Math.max(1, w * h)));
  const ratio = clamp(cacheScale ?? globalScale, 0.1, Math.max(0.1, maxRatio));
  const group = useRef<Konva.Group>(null);
  const shadowKey = JSON.stringify(l.shadow ?? null), filterKey = JSON.stringify(f);
  const cropKey = crop ? `${crop.x}|${crop.y}|${crop.width}|${crop.height}` : "";

  useLayoutEffect(() => {
    const g = group.current;
    if (!g) return;
    if (!cached) {
      if (g.isCached()) g.clearCache();
      return;
    }
    try {
      g.cache({ pixelRatio: ratio });
    } catch { /* zero-size node */ }
    g.getLayer()?.batchDraw();
  }, [cached, ratio, img, w, h, dx, dy, dw, dh, cropKey, cr, circle, l.mask, shadowKey, filterKey, gco]);

  const stroke = l.stroke && l.stroke.width > 0 ? l.stroke : null;
  const sh = shadowProps(l.shadow);
  return (
    <>
      {circle && l.fit !== "contain" && l.shadow && (
        <Ellipse x={w / 2} y={h / 2} radiusX={w / 2} radiusY={h / 2} fill="#000" {...sh} globalCompositeOperation={gco} listening={false} />
      )}
      <Group
        ref={group} listening={false}
        clipFunc={circle ? (ctx: Konva.Context) => { ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, TAU, false); } : undefined}
        filters={cached && filters.length ? filters : undefined} {...(cached ? filterValues(f, ratio) : {})}
        globalCompositeOperation={cached ? gco : undefined}
      >
        <KImage
          image={img} x={dx} y={dy} width={dw} height={dh} crop={crop} cornerRadius={cr} {...(circle ? {} : sh)}
          globalCompositeOperation={cached ? undefined : gco} perfectDrawEnabled={false} listening={false}
        />
        {fade && <Rect width={w} height={h} {...fadeFill(l.mask, h)} globalCompositeOperation="destination-in" listening={false} />}
      </Group>
      {stroke && (circle
        ? <Ellipse x={w / 2} y={h / 2} radiusX={w / 2} radiusY={h / 2} stroke={stroke.color} strokeWidth={stroke.width} listening={false} />
        : <Rect x={dx} y={dy} width={dw} height={dh} cornerRadius={cr} stroke={stroke.color} strokeWidth={stroke.width} listening={false} perfectDrawEnabled={false} />)}
    </>
  );
}

function roundRectPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

function slotPath(c: CanvasRenderingContext2D, l: ImageLayer, w: number, h: number) {
  if (l.mask === "circle") {
    c.beginPath();
    c.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, TAU);
    c.closePath();
  } else roundRectPath(c, 0, 0, w, h, l.cornerRadius ?? 0);
}

function imageIcon(c: CanvasRenderingContext2D, cx: number, cy: number, s: number, color: string) {
  const lw = Math.max(s * 0.07, 0.5);
  c.save();
  c.strokeStyle = color;
  c.lineWidth = lw;
  c.lineJoin = "round";
  c.lineCap = "round";
  roundRectPath(c, cx - s / 2, cy - s * 0.4, s, s * 0.8, s * 0.13);
  c.stroke();
  c.beginPath();
  c.arc(cx + s * 0.2, cy - s * 0.13, s * 0.085, 0, TAU);
  c.stroke();
  c.beginPath();
  c.moveTo(cx - s * 0.42, cy + s * 0.3);
  c.lineTo(cx - s * 0.12, cy - s * 0.02);
  c.lineTo(cx + s * 0.1, cy + s * 0.2);
  c.lineTo(cx + s * 0.24, cy + s * 0.07);
  c.lineTo(cx + s * 0.42, cy + s * 0.27);
  c.stroke();
  c.restore();
}

const UI_FONT = `"Inter Variable", "Inter", system-ui, sans-serif`;
const MONO_FONT = `"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace`;

function EmptySlot({ l, w, h, zoom, mode, quiet }: { l: ImageLayer; w: number; h: number; zoom: number; mode: RenderMode; quiet: boolean }) {
  const tint = roleTint(l.role);
  const px = 1 / Math.max(0.01, zoom);
  return (
    <Shape
      name="ui-only" listening={false} width={w} height={h} perfectDrawEnabled={false}
      sceneFunc={(ctx) => {
        const c = ctx._context;
        c.save();
        slotPath(c, l, w, h);
        c.fillStyle = rgba(tint, quiet ? 0.07 : 0.1);
        c.fill();
        c.setLineDash([6 * px, 4 * px]);
        c.lineWidth = 1.5 * px;
        c.strokeStyle = rgba(tint, 0.85);
        c.stroke();
        c.setLineDash([]);
        const edit = mode === "edit";
        // role chip in the top-left corner, so stacked slots stay identifiable
        if (edit && w > 96 * px && h > 44 * px && l.mask !== "circle") {
          const fs = 10 * px;
          c.font = `600 ${fs}px ${MONO_FONT}`;
          const label = tr(roleLabel(l.role)).toUpperCase();
          const tw = Math.min(c.measureText(label).width, w - 28 * px);
          roundRectPath(c, 8 * px, 8 * px, tw + 12 * px, fs + 8 * px, 4 * px);
          c.fillStyle = rgba(tint, 0.2);
          c.fill();
          c.fillStyle = rgba(tint, 1);
          c.textAlign = "left";
          c.textBaseline = "middle";
          c.fillText(label, 14 * px, 8 * px + (fs + 8 * px) / 2, w - 28 * px);
        }
        if (!quiet) {
          const showText = edit && w > 170 * px && h > 90 * px;
          const s = clamp(Math.min(w, h) * 0.16, 16 * px, 52 * px);
          const cy = showText ? h / 2 - s * 0.3 : h / 2;
          imageIcon(c, w / 2, cy, s, rgba(tint, 0.95));
          if (showText) {
            const fs = clamp(Math.min(w, h) * 0.032, 11 * px, 15 * px);
            c.textAlign = "center";
            c.textBaseline = "top";
            c.font = `500 ${fs}px ${UI_FONT}`;
            c.fillStyle = rgba(tint, 0.95);
            c.fillText(tr("Drop an image or generate with AI"), w / 2, cy + s * 0.62, w - 16 * px);
          }
        }
        c.restore();
      }}
    />
  );
}

/** Empty slots whose centre is covered by another empty slot above them draw only their frame (no duplicate prompts). */
export function quietSlots(layers: Layer[]): Set<string> {
  const empty = layers.filter((l): l is ImageLayer => l.type === "image" && !l.src && !l.pending && l.visible !== false);
  const out = new Set<string>();
  empty.forEach((l, i) => {
    const cx = l.x + l.width / 2, cy = l.y + l.height / 2;
    const over = empty.slice(i + 1).some((o) => Math.abs(o.x + o.width / 2 - cx) < o.width / 2 + l.width * 0.15
      && Math.abs(o.y + o.height / 2 - cy) < o.height / 2 + l.height * 0.15);
    if (over) out.add(l.id);
  });
  return out;
}

export const PENDING_LABEL: Record<AiKind, string> = {
  background: "Painting the background", character: "Casting the character", element: "Painting the element",
  product: "Shooting the product", harmonize: "Relighting the poster", restyle: "Restyling",
};

/** The shimmer over a layer an AI job is painting (its label is an HTML badge drawn by the editor, above everything). */
function PendingView({ l, w, h, mode, hasImage }: { l: ImageLayer; w: number; h: number; mode: RenderMode; hasImage: boolean }) {
  const ref = useRef<Konva.Shape>(null);
  const tint = roleTint(l.role);
  useEffect(() => {
    if (mode !== "edit" || reducedMotion()) return;
    const id = window.setInterval(() => {
      const n = ref.current;
      if (!n) return;
      n.setAttr("phase", ((Number(n.getAttr("phase")) || 0) + 0.018) % 1);
      n.getLayer()?.batchDraw();
    }, 40);
    return () => window.clearInterval(id);
  }, [mode]);
  return (
    <Shape
      ref={ref} name="ui-only" listening={false} width={w} height={h} perfectDrawEnabled={false}
      sceneFunc={(ctx, shape) => {
        const c = ctx._context;
        const phase = Number(shape.getAttr("phase")) || 0.35;
        c.save();
        slotPath(c, l, w, h);
        c.clip();
        c.fillStyle = rgba(tint, hasImage ? 0.16 : 0.22);
        c.fillRect(0, 0, w, h);
        const band = Math.max(w, h) * 0.55;
        const bx = -band + phase * (w + band * 2);
        const g = c.createLinearGradient(bx, 0, bx + band, h * 0.35);
        g.addColorStop(0, "rgba(255,255,255,0)");
        g.addColorStop(0.5, "rgba(255,255,255,0.22)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        c.fillStyle = g;
        c.fillRect(0, 0, w, h);
        c.restore();
      }}
    />
  );
}

// ── text ─────────────────────────────────────────────────

function TextView({ l, w, h, fontsVersion, hidden }: { l: TextLayer; w: number; h: number; fontsVersion: number; hidden: boolean }) {
  const lay = layoutText(l, w, h, fontsVersion);
  const gco = compositeOf(l.blend);
  const bg = l.background && !isTransparent(l.background.color) ? l.background : null;
  return (
    <>
      {bg && lay.pill && (
        <Rect
          {...lay.pill} fill={bg.color} cornerRadius={clamp(bg.radius, 0, Math.min(lay.pill.width, lay.pill.height) / 2)}
          globalCompositeOperation={gco} listening={false} perfectDrawEnabled={false}
        />
      )}
      <Shape
        name="text-glyphs" visible={!hidden} width={w} height={h} listening={false} perfectDrawEnabled={false}
        {...shadowProps(l.shadow)} globalCompositeOperation={gco}
        sceneFunc={(ctx) => drawText(ctx._context, l, lay, w, h)}
      />
    </>
  );
}

// ── shapes ───────────────────────────────────────────────

/** Fit a closed polygon's points exactly into the w×h box. */
function fitPoints(pts: [number, number][], w: number, h: number): number[] {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sx = w / (x1 - x0 || 1), sy = h / (y1 - y0 || 1);
  return pts.flatMap(([x, y]) => [(x - x0) * sx, (y - y0) * sy]);
}

export function shapePoints(l: ShapeLayer, w: number, h: number): number[] {
  switch (l.shape) {
    case "triangle": return [w / 2, 0, w, h, 0, h];
    case "polygon": {
      const n = clamp(Math.round(l.sides ?? 6), 3, 24);
      return fitPoints(Array.from({ length: n }, (_, i) => { const a = -Math.PI / 2 + (i * TAU) / n; return [Math.cos(a), Math.sin(a)] as [number, number]; }), w, h);
    }
    case "star":
    case "burst": {
      const n = clamp(Math.round(l.points ?? (l.shape === "burst" ? 16 : 5)), 3, 64);
      const r = clamp(l.innerRatio ?? (l.shape === "burst" ? 0.82 : 0.45), 0.05, 0.98);
      return fitPoints(Array.from({ length: n * 2 }, (_, i) => {
        const a = -Math.PI / 2 + (i * Math.PI) / n, k = i % 2 ? r : 1;
        return [Math.cos(a) * k, Math.sin(a) * k] as [number, number];
      }), w, h);
    }
    case "arrow": {
      const head = Math.min(w * 0.45, h * 1.6), shaft = h * 0.36, m = h / 2;
      return [0, m - shaft / 2, w - head, m - shaft / 2, w - head, 0, w, m, w - head, h, w - head, m + shaft / 2, 0, m + shaft / 2];
    }
    default: return [];
  }
}

function ShapeView({ l, w, h }: { l: ShapeLayer; w: number; h: number }) {
  const gco = compositeOf(l.blend);
  const stroke = l.stroke && l.stroke.width > 0 ? { stroke: l.stroke.color, strokeWidth: l.stroke.width } : {};
  const common = { ...shadowProps(l.shadow), ...stroke, dash: l.dash?.length ? l.dash : undefined, globalCompositeOperation: gco,
    listening: false, perfectDrawEnabled: false };
  const fill = konvaFill(l.fill, w, h);
  switch (l.shape) {
    case "rect":
      return <Rect width={w} height={h} cornerRadius={clamp(l.cornerRadius ?? 0, 0, Math.min(w, h) / 2)} {...fill} {...common} />;
    case "ellipse":
      return <Ellipse x={w / 2} y={h / 2} radiusX={w / 2} radiusY={h / 2} {...konvaFill(l.fill, w, h, -w / 2, -h / 2)} {...common} />;
    case "ring": {
      const r = clamp(l.innerRatio ?? 0.78, 0.05, 0.98);
      return (
        <Shape
          width={w} height={h} {...fill} {...common}
          sceneFunc={(ctx, shape) => {
            const c = ctx._context;
            c.beginPath();
            c.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, TAU, false);
            c.moveTo(w / 2 + (w / 2) * r, h / 2);
            c.ellipse(w / 2, h / 2, (w / 2) * r, (h / 2) * r, 0, 0, TAU, true);
            c.closePath();
            ctx.fillStrokeShape(shape);
          }}
        />
      );
    }
    case "line": {
      const color = l.fill ? solidOf(l.fill) : l.stroke?.color ?? "#ffffff";
      return (
        <Line
          points={[0, h / 2, w, h / 2]} stroke={color} strokeWidth={h} lineCap="butt" dash={l.dash?.length ? l.dash : undefined}
          {...shadowProps(l.shadow)} globalCompositeOperation={gco} listening={false} perfectDrawEnabled={false}
        />
      );
    }
    default:
      return <Line points={shapePoints(l, w, h)} closed {...fill} {...common} />;
  }
}

// ── effects ──────────────────────────────────────────────

function EffectView({ l, w, h }: { l: EffectLayer; w: number; h: number }) {
  const k = clamp(l.intensity ?? 0.5, 0, 1);
  const gco = compositeOf(l.blend);
  const base = { width: w, height: h, listening: false, perfectDrawEnabled: false, globalCompositeOperation: gco };
  const color = l.color || "#000000";
  if (l.effect === "grain") {
    const s = Math.max(0.5, Math.min(w, h) / 1080);
    return <Rect {...base} opacity={k} fillPatternImage={grainPattern(color) as unknown as HTMLImageElement} fillPatternRepeat="repeat" fillPatternScale={{ x: s, y: s }} />;
  }
  if (l.effect === "scanlines") {
    const period = Math.max(2, Math.round(Math.min(w, h) / 240)) * 2;
    return <Rect {...base} opacity={k} fillPatternImage={scanlinePattern(color, period) as unknown as HTMLImageElement} fillPatternRepeat="repeat" />;
  }
  return (
    <Shape
      {...base}
      sceneFunc={(ctx) => {
        const c = ctx._context;
        c.save();
        if (l.effect === "vignette") {
          c.translate(w / 2, h / 2);
          c.scale(1, h / w);
          const R = (w / 2) * Math.SQRT2;
          const inner = 0.62 - 0.32 * k;
          const edge = Math.min(1, 0.25 + 0.85 * k);
          const g = c.createRadialGradient(0, 0, 0, 0, 0, R);
          g.addColorStop(0, rgba(color, 0));
          g.addColorStop(inner, rgba(color, 0));
          g.addColorStop(inner + (1 - inner) * 0.5, rgba(color, edge * 0.45));
          g.addColorStop(1, rgba(color, edge));
          c.fillStyle = g;
          c.fillRect(-w / 2, -w / 2, w, w);
        } else if (l.effect === "fade") {
          const { start, end } = linearPoints(l.angle ?? 90, w, h);
          const g = c.createLinearGradient(end.x, end.y, start.x, start.y);
          const span = 0.3 + 0.5 * k, edge = Math.min(1, k * 1.08);
          for (const t of [0, 0.2, 0.4, 0.6, 0.8, 1]) g.addColorStop(t * span, rgba(color, edge * Math.pow(1 - t, 1.6)));
          g.addColorStop(1, rgba(color, 0));
          c.fillStyle = g;
          c.fillRect(0, 0, w, h);
        } else if (l.effect === "light-leak") {
          const a = ((l.angle ?? 315) * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
          const half = Math.abs((w / 2) * dx) + Math.abs((h / 2) * dy);
          const px = w / 2 + dx * half, py = h / 2 + dy * half;
          const R = Math.hypot(w, h) * (0.45 + 0.35 * k);
          const g = c.createRadialGradient(px, py, 0, px, py, R);
          g.addColorStop(0, rgba(color, Math.min(1, 0.95 * k + 0.05)));
          g.addColorStop(0.35, rgba(color, 0.45 * k));
          g.addColorStop(1, rgba(color, 0));
          c.fillStyle = g;
          c.fillRect(0, 0, w, h);
          const qx = px - dx * R * 0.3 - dy * R * 0.22, qy = py - dy * R * 0.3 + dx * R * 0.22, R2 = R * 0.45;
          const g2 = c.createRadialGradient(qx, qy, 0, qx, qy, R2);
          g2.addColorStop(0, `rgba(255,236,214,${(0.45 * k).toFixed(3)})`);
          g2.addColorStop(1, "rgba(255,236,214,0)");
          c.fillStyle = g2;
          c.fillRect(0, 0, w, h);
        } else if (l.effect === "glow") {
          c.translate(w / 2, h / 2);
          c.scale(1, h / w);
          const R = (w / 2) * 1.15;
          const g = c.createRadialGradient(0, 0, 0, 0, 0, R);
          g.addColorStop(0, rgba(color, k));
          g.addColorStop(0.4, rgba(color, k * 0.5));
          g.addColorStop(1, rgba(color, 0));
          c.fillStyle = g;
          c.fillRect(-w / 2, -w / 2, w, w);
        } else if (l.effect === "frame") {
          const S = Math.min(w, h), m = S * 0.035, t = Math.max(1, S * (0.004 + 0.012 * k));
          c.strokeStyle = color;
          c.lineWidth = t;
          c.strokeRect(m + t / 2, m + t / 2, w - 2 * m - t, h - 2 * m - t);
          const t2 = Math.max(0.75, t * 0.35), m2 = m + t + S * 0.012;
          c.lineWidth = t2;
          c.strokeRect(m2 + t2 / 2, m2 + t2 / 2, w - 2 * m2 - t2, h - 2 * m2 - t2);
        }
        c.restore();
      }}
    />
  );
}
