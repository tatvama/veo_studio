/** Shape and effect layer properties. */
import { useT } from "../../../../lib/i18n";
import type { EffectKind, EffectLayer, Paint, ShapeKind, ShapeLayer } from "../../types";
import { AngleField, ColorField, MiniSelect, NumberField, PaintField, PropSection, Row, SliderRow, ToggleRow } from "../controls";
import { effectLabels, shapeLabels, useLayerPatch, usePalette } from "./shared";

const SHAPES: ShapeKind[] = ["rect", "ellipse", "triangle", "polygon", "star", "burst", "ring", "line", "arrow"];
const EFFECTS: EffectKind[] = ["vignette", "fade", "grain", "light-leak", "glow", "scanlines", "frame"];

export function ShapeProps({ layer }: { layer: ShapeLayer }) {
  const t = useT();
  const patch = useLayerPatch(layer.id);
  const palette = usePalette();
  const labels = shapeLabels(t);
  const s = layer.stroke;
  const k = layer.shape;
  const dashed = !!layer.dash?.length;
  const dashFor = (w: number) => [Math.max(2, w * 3), Math.max(2, w * 2)];
  return (
    <>
      <PropSection id="shape" title={t("Shape")}>
        <Row label={t("Kind")}>
          <MiniSelect aria-label={t("Shape kind")} value={k} options={SHAPES.map((v) => ({ value: v, label: labels[v] }))}
            onChange={(shape) => {
              // keep a custom name; rename one that just said what the shape was
              const generic = layer.name === labels[k] || layer.name.toLowerCase() === k;
              patch({ shape, ...(generic ? { name: labels[shape] } : {}) });
            }} />
        </Row>
        {k === "rect" && (
          <NumberField label={t("Corner radius")} value={layer.cornerRadius ?? 0} min={0} max={Math.round(Math.min(layer.width, layer.height) / 2)}
            onChange={(cornerRadius) => patch({ cornerRadius }, "radius")} />
        )}
        {k === "polygon" && (
          <SliderRow label={t("Sides")} value={layer.sides ?? 6} min={3} max={12} step={1} defaultValue={6} onChange={(sides) => patch({ sides }, "sides")} />
        )}
        {(k === "star" || k === "burst") && (
          <>
            <SliderRow label={t("Points")} value={layer.points ?? 5} min={3} max={40} step={1} defaultValue={k === "burst" ? 16 : 5}
              onChange={(points) => patch({ points }, "points")} />
            <SliderRow label={t("Inner size")} value={layer.innerRatio ?? 0.45} min={0.1} max={0.95} step={0.01} scale={100} suffix="%" defaultValue={k === "burst" ? 0.82 : 0.45}
              onChange={(innerRatio) => patch({ innerRatio }, "inner")} />
          </>
        )}
        {k === "ring" && (
          <SliderRow label={t("Thickness")} value={1 - (layer.innerRatio ?? 0.78)} min={0.01} max={0.9} step={0.01} scale={100} suffix="%" defaultValue={0.22}
            onChange={(v) => patch({ innerRatio: +(1 - v).toFixed(3) }, "inner")} />
        )}
      </PropSection>

      <PropSection id="shape-fill" title={t("Fill")}>
        <PaintField value={layer.fill} onChange={(fill: Paint | null) => patch({ fill }, "fill")} allowNone palette={palette} />
      </PropSection>

      <PropSection id="shape-stroke" title={t("Outline")}
        toggle={{ checked: !!s, onChange: (on) => patch(on ? { stroke: { color: palette[1] ?? "#ffffff", width: Math.max(2, Math.round(Math.min(layer.width, layer.height) * 0.02)) } } : { stroke: null, dash: undefined }) }}>
        {s && (
          <>
            <div className="flex items-center gap-1.5">
              <ColorField value={s.color} onChange={(color) => patch({ stroke: { ...s, color } }, "stroke.color")} palette={palette} className="flex-1" />
              <NumberField label="W" title={t("Outline width")} value={s.width} min={0} max={400} step={0.5} className="w-[4.5rem]"
                onChange={(width) => patch({ stroke: { ...s, width }, ...(dashed ? { dash: dashFor(width) } : {}) }, "stroke.width")} />
            </div>
            <ToggleRow label={t("Dashed")} checked={dashed} onChange={(on) => patch({ dash: on ? dashFor(s.width) : undefined })} />
          </>
        )}
      </PropSection>
    </>
  );
}

export function EffectProps({ layer }: { layer: EffectLayer }) {
  const t = useT();
  const patch = useLayerPatch(layer.id);
  const palette = usePalette();
  const labels = effectLabels(t);
  const angled = layer.effect === "fade" || layer.effect === "light-leak";
  const hints: Record<EffectKind, string> = {
    vignette: t("Darkens the corners to pull the eye to the centre."),
    fade: t("Fades the picture into a colour from one edge: a base for titles."),
    grain: t("Film grain over everything; keep it subtle."),
    "light-leak": t("A warm burst of light entering from one side."),
    glow: t("A soft coloured bloom from the centre."),
    scanlines: t("Fine horizontal lines, for a screen or retro look."),
    frame: t("A border inset from the page edge."),
  };
  return (
    <PropSection id="effect" title={t("Effect")}>
      <Row label={t("Kind")}>
        <MiniSelect aria-label={t("Effect kind")} value={layer.effect} onChange={(effect) => patch({ effect, name: layer.name === labels[layer.effect] ? labels[effect] : layer.name })}
          options={EFFECTS.map((v) => ({ value: v, label: labels[v] }))} />
      </Row>
      <p className="text-2xs leading-snug text-dim">{hints[layer.effect]}</p>
      <Row label={t("Colour")}>
        <ColorField value={layer.color} onChange={(color) => patch({ color }, "color")} palette={palette} className="flex-1" />
      </Row>
      <SliderRow label={t("Intensity")} value={layer.intensity} min={0} max={1} step={0.01} scale={100} suffix="%" defaultValue={0.5}
        onChange={(intensity) => patch({ intensity }, "intensity")} />
      {angled && (
        <Row label={layer.effect === "fade" ? t("From") : t("Direction")}>
          <AngleField value={layer.angle ?? (layer.effect === "fade" ? 90 : 315)} mode="unsigned" onChange={(angle) => patch({ angle }, "angle")} className="flex-1" />
        </Row>
      )}
    </PropSection>
  );
}
