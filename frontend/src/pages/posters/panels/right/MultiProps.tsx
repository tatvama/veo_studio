/** Several layers selected: align to each other, distribute, shared opacity, order, duplicate, delete, lock. */
import {
  AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter, ArrowDown, ArrowUp, BringToFront, Copy, Eye, EyeOff, Lock, LockOpen, SendToBack, Trash2,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "../../../../components/ui";
import { useT } from "../../../../lib/i18n";
import { useEditor } from "../../store";
import type { Layer } from "../../types";
import { IconToggle, PropSection, SliderRow } from "../controls";
import { alignButtons } from "./CommonProps";
import { LayerGlyph } from "./shared";

export function MultiProps({ layers }: { layers: Layer[] }) {
  const t = useT();
  const st = useEditor(useShallow((s) => ({
    alignSelected: s.alignSelected, distributeSelected: s.distributeSelected, patchLayers: s.patchLayers, duplicate: s.duplicate,
    removeLayers: s.removeLayers, order: s.order, select: s.select,
  })));
  const ids = layers.map((l) => l.id);
  const movable = layers.filter((l) => !l.locked);
  const allLocked = layers.every((l) => l.locked);
  const allHidden = layers.every((l) => !l.visible);
  const opacities = layers.map((l) => l.opacity);
  const same = opacities.every((o) => o === opacities[0]);
  const opacity = same ? opacities[0] : opacities.reduce((a, b) => a + b, 0) / opacities.length;
  const patchAll = (p: Partial<Layer>, key?: string) => st.patchLayers(Object.fromEntries(ids.map((id) => [id, p])), key ? `multi:${key}` : undefined);
  const counts = layers.reduce<Record<string, number>>((a, l) => ({ ...a, [l.type]: (a[l.type] ?? 0) + 1 }), {});
  const typeName: Record<string, string> = { text: t("text"), image: t("image"), shape: t("shape"), effect: t("effect") };

  return (
    <>
      <div className="space-y-2 border-b border-line px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold tracking-tight text-ink">{t("{n} layers", { n: layers.length })}</span>
          <span className="truncate text-2xs text-dim">{Object.entries(counts).map(([k, n]) => `${n} ${typeName[k] ?? k}`).join(" · ")}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {layers.slice(0, 12).map((l) => (
            <button key={l.id} type="button" title={t("Select only this layer")} onClick={() => st.select([l.id])}
              className="inline-flex max-w-[8.5rem] items-center gap-1 rounded-md border border-line bg-raised px-1.5 py-0.5 text-2xs text-mute transition-colors hover:bg-hover hover:text-ink">
              <LayerGlyph layer={l} className="size-3" /><span className="truncate">{l.name}</span>
            </button>
          ))}
          {layers.length > 12 && <span className="mono px-1 text-2xs text-dim">+{layers.length - 12}</span>}
        </div>
        {movable.length < layers.length && (
          <p className="text-2xs text-dim">{t("{n} locked layer(s) won't move when aligning.", { n: layers.length - movable.length })}</p>
        )}
      </div>

      <PropSection id="multi-align" title={t("Align & distribute")}>
        <div className="flex items-center gap-0.5">
          {alignButtons(t).map((b) => (
            <IconToggle key={b.mode} title={b.title} disabled={movable.length < 2} onClick={() => st.alignSelected(b.mode)}><b.icon /></IconToggle>
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          <IconToggle title={t("Distribute horizontally")} disabled={movable.length < 3} onClick={() => st.distributeSelected("h")}><AlignHorizontalDistributeCenter /></IconToggle>
          <IconToggle title={t("Distribute vertically")} disabled={movable.length < 3} onClick={() => st.distributeSelected("v")}><AlignVerticalDistributeCenter /></IconToggle>
          {movable.length < 3 && <span className="ml-1 text-2xs text-dim">{t("Distribute needs 3 or more")}</span>}
        </div>
      </PropSection>

      <PropSection id="multi-look" title={t("Appearance")}>
        <SliderRow label={same ? t("Opacity") : t("Opacity (mixed)")} value={opacity} min={0} max={1} step={0.01} scale={100} suffix="%" defaultValue={1}
          onChange={(o) => patchAll({ opacity: o }, "opacity")} />
        <div className="flex items-center gap-0.5">
          <IconToggle title={allHidden ? t("Show all") : t("Hide all")} active={allHidden} onClick={() => patchAll({ visible: allHidden })}>
            {allHidden ? <EyeOff /> : <Eye />}
          </IconToggle>
          <IconToggle title={allLocked ? t("Unlock all") : t("Lock all")} active={allLocked} onClick={() => patchAll({ locked: !allLocked })}>
            {allLocked ? <Lock /> : <LockOpen />}
          </IconToggle>
          <span className="mx-1 h-4 w-px bg-line" />
          <IconToggle title={t("Bring to front")} onClick={() => st.order("front")}><BringToFront /></IconToggle>
          <IconToggle title={t("Bring forward")} onClick={() => st.order("forward")}><ArrowUp /></IconToggle>
          <IconToggle title={t("Send backward")} onClick={() => st.order("backward")}><ArrowDown /></IconToggle>
          <IconToggle title={t("Send to back")} onClick={() => st.order("back")}><SendToBack /></IconToggle>
        </div>
      </PropSection>

      <div className="grid grid-cols-2 gap-1.5 px-3 py-3">
        <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => st.duplicate()}>{t("Duplicate")}</Button>
        <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} disabled={allLocked} onClick={() => st.removeLayers()}>{t("Delete")}</Button>
      </div>
    </>
  );
}
