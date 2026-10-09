/**
 * Right side of the editor: "Design" shows the properties of the selection (or the page when nothing is selected),
 * "Layers" lists the stack. Every edit goes through the editor store; continuous edits are coalesced into one undo step.
 */
import { useShallow } from "zustand/react/shallow";
import { Skeleton, Tabs } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import { useEditor } from "../store";
import type { Layer } from "../types";
import { ArrangeSection, LayerHeader, ShadowSection, TransformSection } from "./right/CommonProps";
import { ImageProps } from "./right/ImageProps";
import { LayersList } from "./right/LayersList";
import { MultiProps } from "./right/MultiProps";
import { PageProps } from "./right/PageProps";
import { EffectProps, ShapeProps } from "./right/ShapeEffectProps";
import { TextProps } from "./right/TextProps";

function LayerProps({ layer, designId }: { layer: Layer; designId: number }) {
  return (
    <>
      <LayerHeader layer={layer} />
      {layer.type === "text" && <TextProps layer={layer} />}
      {layer.type === "image" && <ImageProps layer={layer} designId={designId} />}
      {layer.type === "shape" && <ShapeProps layer={layer} />}
      {layer.type === "effect" && <EffectProps layer={layer} />}
      <TransformSection layer={layer} />
      {layer.type !== "effect" && <ShadowSection layer={layer} />}
      <ArrangeSection layer={layer} />
    </>
  );
}

function DesignTab({ designId }: { designId: number }) {
  const selected = useEditor(useShallow((s) => s.doc.layers.filter((l) => s.selection.includes(l.id))));
  if (!selected.length) return <PageProps />;
  if (selected.length > 1) return <MultiProps layers={selected} />;
  // keyed by layer so per-layer UI state (aspect lock, picker tabs) starts fresh
  return <LayerProps key={selected[0].id} layer={selected[0]} designId={designId} />;
}

/** Right side of the editor: properties of the selection (or the page) and the layers list. */
export default function RightPanel({ designId }: { designId: number }) {
  const t = useT();
  const { tab, setTab, count, ready, selCount } = useEditor(useShallow((s) => ({
    tab: s.rightTab, setTab: s.setRightTab, count: s.doc.layers.length, ready: !!s.design, selCount: s.selection.length,
  })));
  return (
    <aside data-design={designId} aria-label={t("Properties and layers")}
      className="relative flex w-80 shrink-0 flex-col border-l border-line bg-panel">
      <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px opacity-50" />
      <Tabs
        value={tab}
        onChange={setTab}
        className="shrink-0 px-2"
        tabs={[
          { value: "design", label: t("Design"), count: selCount > 1 ? selCount : undefined },
          { value: "layers", label: t("Layers"), count },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-gutter:stable]">
        {!ready ? (
          <div className="space-y-3 p-3">
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-7 w-2/3" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : tab === "design" ? <DesignTab designId={designId} /> : <LayersList />}
      </div>
    </aside>
  );
}
