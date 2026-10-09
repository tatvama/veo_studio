/** Properties every layer has: name, geometry, opacity, blend, flip, lock, visibility, shadow, order and alignment. */
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, ArrowDown,
  ArrowUp, BringToFront, Eye, EyeOff, FlipHorizontal2, FlipVertical2, Link2, Link2Off, Lock, LockOpen, SendToBack,
} from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useT } from "../../../../lib/i18n";
import type { AlignMode } from "../../doc";
import { useEditor } from "../../store";
import type { Layer, Role, Shadow } from "../../types";
import {
  AngleField, ColorField, IconToggle, MiniSelect, NumberField, PropSection, Row, SliderRow, miniInput,
} from "../controls";
import { LayerGlyph, blendGroups, roleLabels, rotateAboutCentre, typeLabel, useLayerPatch, usePalette, useShortSide } from "./shared";

export function alignButtons(t: (s: string) => string): { mode: AlignMode; title: string; icon: typeof AlignStartVertical }[] {
  return [
    { mode: "left", title: t("Align left"), icon: AlignStartVertical },
    { mode: "hcenter", title: t("Align centre"), icon: AlignCenterVertical },
    { mode: "right", title: t("Align right"), icon: AlignEndVertical },
    { mode: "top", title: t("Align top"), icon: AlignStartHorizontal },
    { mode: "vcenter", title: t("Align middle"), icon: AlignCenterHorizontal },
    { mode: "bottom", title: t("Align bottom"), icon: AlignEndHorizontal },
  ];
}

/** Name, visibility and lock: the header of a layer's properties. */
export function LayerHeader({ layer }: { layer: Layer }) {
  const t = useT();
  const patch = useLayerPatch(layer.id);
  const roles = roleLabels(t);
  return (
    <div className="space-y-2 border-b border-line px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-md border border-line bg-raised"><LayerGlyph layer={layer} /></span>
        <input value={layer.name} onChange={(e) => patch({ name: e.target.value }, "name")} aria-label={t("Layer name")} spellCheck={false}
          className={`${miniInput} font-medium`} maxLength={120} />
        <IconToggle title={layer.visible ? t("Hide") : t("Show")} active={!layer.visible} onClick={() => patch({ visible: !layer.visible })}>
          {layer.visible ? <Eye /> : <EyeOff />}
        </IconToggle>
        <IconToggle title={layer.locked ? t("Unlock") : t("Lock")} active={layer.locked} onClick={() => patch({ locked: !layer.locked })}>
          {layer.locked ? <Lock /> : <LockOpen />}
        </IconToggle>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="eyebrow shrink-0">{typeLabel(t, layer)}</span>
        <span className="h-px flex-1 bg-line" />
        <MiniSelect<Role | "">
          aria-label={t("Role")}
          value={layer.role ?? ""}
          onChange={(v) => patch({ role: v || undefined })}
          options={[{ value: "", label: t("No role") }, ...(Object.entries(roles) as [Role, string][]).map(([value, label]) => ({ value, label }))]}
          className="h-6 w-auto max-w-[9rem] text-2xs"
        />
      </div>
      {layer.locked && <p className="text-2xs leading-snug text-dim">{t("Locked: it can't be moved or picked on the canvas. Its properties still change here.")}</p>}
    </div>
  );
}

/** Position, size, rotation, flip, opacity and blend. */
export function TransformSection({ layer }: { layer: Layer }) {
  const t = useT();
  const patch = useLayerPatch(layer.id);
  const [lockRatio, setLockRatio] = useState(layer.type === "image" && layer.role !== "background");
  const ratio = layer.width / Math.max(1, layer.height);
  const setW = (w: number) => patch(lockRatio ? { width: w, height: Math.max(1, Math.round(w / ratio)) } : { width: w }, "size");
  const setH = (h: number) => patch(lockRatio ? { height: h, width: Math.max(1, Math.round(h * ratio)) } : { height: h }, "size");
  return (
    <PropSection id="transform" title={t("Layout")}>
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField label="X" title={t("Left")} value={Math.round(layer.x * 10) / 10} onChange={(x) => patch({ x }, "pos")} step={1} />
        <NumberField label="Y" title={t("Top")} value={Math.round(layer.y * 10) / 10} onChange={(y) => patch({ y }, "pos")} step={1} />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1">
        <NumberField label="W" title={t("Width")} value={Math.round(layer.width * 10) / 10} min={1} max={20000} onChange={setW} />
        <IconToggle title={lockRatio ? t("Unlock aspect ratio") : t("Lock aspect ratio")} active={lockRatio} onClick={() => setLockRatio(!lockRatio)}>
          {lockRatio ? <Link2 /> : <Link2Off />}
        </IconToggle>
        <NumberField label="H" title={t("Height")} value={Math.round(layer.height * 10) / 10} min={1} max={20000} onChange={setH} />
      </div>
      <div className="flex items-center gap-1">
        <AngleField value={Math.round((layer.rotation || 0) * 10) / 10} onChange={(deg) => patch(rotateAboutCentre(layer, deg), "rotate")} className="flex-1" />
        <IconToggle title={t("Flip horizontally")} active={!!layer.flipX} onClick={() => patch({ flipX: !layer.flipX })}><FlipHorizontal2 /></IconToggle>
        <IconToggle title={t("Flip vertically")} active={!!layer.flipY} onClick={() => patch({ flipY: !layer.flipY })}><FlipVertical2 /></IconToggle>
      </div>
      <SliderRow label={t("Opacity")} value={layer.opacity} min={0} max={1} step={0.01} scale={100} suffix="%" defaultValue={1}
        onChange={(opacity) => patch({ opacity }, "opacity")} />
      <Row label={t("Blend")}>
        <MiniSelect value={layer.blend ?? "normal"} onChange={(blend) => patch({ blend }, "blend")} groups={blendGroups(t)} aria-label={t("Blend mode")} />
      </Row>
    </PropSection>
  );
}

/** Stacking order and alignment to the page. */
export function ArrangeSection({ layer }: { layer: Layer }) {
  const t = useT();
  const { order, alignSelected } = useEditor(useShallow((s) => ({ order: s.order, alignSelected: s.alignSelected })));
  const { index, count } = useEditor(useShallow((s) => ({ index: s.doc.layers.findIndex((l) => l.id === layer.id), count: s.doc.layers.length })));
  const top = index === count - 1, bottom = index === 0;
  return (
    <PropSection id="arrange" title={t("Arrange")}>
      <div className="flex items-center gap-0.5">
        {alignButtons(t).map((b) => (
          <IconToggle key={b.mode} title={`${b.title} ${t("to page")}`} disabled={layer.locked} onClick={() => alignSelected(b.mode)}><b.icon /></IconToggle>
        ))}
      </div>
      <div className="flex items-center gap-0.5">
        <IconToggle title={t("Bring to front")} disabled={top} onClick={() => order("front", [layer.id])}><BringToFront /></IconToggle>
        <IconToggle title={t("Bring forward")} disabled={top} onClick={() => order("forward", [layer.id])}><ArrowUp /></IconToggle>
        <IconToggle title={t("Send backward")} disabled={bottom} onClick={() => order("backward", [layer.id])}><ArrowDown /></IconToggle>
        <IconToggle title={t("Send to back")} disabled={bottom} onClick={() => order("back", [layer.id])}><SendToBack /></IconToggle>
        <span className="mono ml-auto text-2xs text-dim">{count - index} / {count}</span>
      </div>
    </PropSection>
  );
}

export function defaultShadow(short: number): Shadow {
  return { color: "#000000", blur: Math.max(4, Math.round(short * 0.02)), x: 0, y: Math.max(2, Math.round(short * 0.008)), opacity: 0.5 };
}

/** Drop shadow (toggle + colour, blur, offset, opacity). */
export function ShadowSection({ layer }: { layer: Layer }) {
  const t = useT();
  const patch = useLayerPatch(layer.id);
  const palette = usePalette();
  const short = useShortSide();
  const s = layer.shadow;
  const set = (p: Partial<Shadow>, key: string) => s && patch({ shadow: { ...s, ...p } }, `shadow.${key}`);
  return (
    <PropSection id="shadow" title={t("Shadow")} toggle={{ checked: !!s, onChange: (on) => patch({ shadow: on ? defaultShadow(short) : null }) }}>
      {s && (
        <>
          <ColorField value={s.color} onChange={(color) => set({ color }, "color")} palette={palette} allowTransparent={false} />
          <div className="grid grid-cols-3 gap-1.5">
            <NumberField label={t("Blur")} value={s.blur} min={0} max={400} onChange={(blur) => set({ blur }, "blur")} />
            <NumberField label="X" title={t("Offset X")} value={s.x} min={-1000} max={1000} onChange={(x) => set({ x }, "x")} />
            <NumberField label="Y" title={t("Offset Y")} value={s.y} min={-1000} max={1000} onChange={(y) => set({ y }, "y")} />
          </div>
          <SliderRow label={t("Strength")} value={s.opacity} min={0} max={1} step={0.01} scale={100} suffix="%" defaultValue={0.5}
            onChange={(opacity) => set({ opacity }, "opacity")} />
        </>
      )}
    </PropSection>
  );
}
