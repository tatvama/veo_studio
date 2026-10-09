/** Elements tab: shapes, badges and stickers, effects and gradient overlays. Everything drags onto the canvas or adds by click. */
import { Blend, Shapes, Stamp, Wallpaper } from "lucide-react";
import { useMemo, type CSSProperties } from "react";
import { useT } from "../../../../lib/i18n";
import { newEffect } from "../../doc";
import { useEditor } from "../../store";
import type { EffectKind, Layer } from "../../types";
import { EFFECTS, GRADIENTS, gradientCss, gradientLayer, SHAPES, shapeLayer, STICKERS, stickerLayers, type GradientItem, type StickerItem } from "./elements";
import { MiniLayers } from "./mini";
import { DragItem, Hint, LazyMount, Section } from "./ui";

const page = () => useEditor.getState();

export default function ElementsTab() {
  const t = useT();
  return (
    <>
      <Section title={t("Shapes")} icon={<Shapes />}>
        <div className="grid grid-cols-5 gap-1.5">
          {SHAPES.map((s) => <ShapeTile key={s.key} item={s} />)}
        </div>
      </Section>

      <Section title={t("Badges & stickers")} icon={<Stamp />}>
        <div className="grid grid-cols-2 gap-1.5">
          {STICKERS.map((s) => <StickerTile key={s.key} item={s} />)}
        </div>
      </Section>

      <Section title={t("Effects")} icon={<Blend />}>
        <div className="grid grid-cols-2 gap-1.5">
          {EFFECTS.map((e) => (
            <DragItem key={e.effect} label={t(e.label)} tip={t(e.description)} payload={() => ({ kind: "effect", effect: e.effect })}
              className="group overflow-hidden rounded-lg border border-line bg-raised text-left transition-colors hover:border-accent/40">
              <div data-ghost className="relative h-16 overflow-hidden bg-cover bg-center" style={{ backgroundImage: "url(/showcase/lamp-sm.webp)" }}>
                <div className="absolute inset-0" style={effectCss(e.effect)} />
              </div>
              <div className="px-2 py-1.5">
                <p className="truncate text-xs font-medium text-ink">{t(e.label)}</p>
                <p className="line-clamp-2 text-2xs leading-snug text-dim">{t(e.description)}</p>
              </div>
            </DragItem>
          ))}
        </div>
        <Hint className="mt-2">{t("Effects cover the whole page and sit where you drop them in the stack. Tune them in the properties panel.")}</Hint>
      </Section>

      <Section title={t("Gradient overlays")} icon={<Wallpaper />}>
        <div className="grid grid-cols-3 gap-1.5">
          {GRADIENTS.map((g) => <GradientTile key={g.key} item={g} />)}
        </div>
        <Hint className="mt-2">{t("Added as a full-page layer at partial opacity. Use the button on a swatch to make it the page background instead.")}</Hint>
      </Section>
    </>
  );
}

function ShapeTile({ item }: { item: (typeof SHAPES)[number] }) {
  const t = useT();
  // preview at a fixed reference size, painted in the UI ink colour so it reads in both themes
  const preview = useMemo<Layer[]>(() => {
    const l = shapeLayer(item, 300, 300);
    const height = l.shape === "line" ? Math.max(l.height, Math.round(l.width * 0.07)) : l.height;
    return [{ ...l, height, fill: l.fill ? "currentColor" : null, stroke: l.stroke ? { ...l.stroke, color: "currentColor" } : null }];
  }, [item]);
  return (
    <DragItem label={t(item.label)} tip={t(item.label)} tipSide="top"
      payload={() => {
        const { width: W, height: H } = page();
        // the plain shapes travel as a shape payload (dropped where you let go); variants carry their tweaks as layers
        return item.asLayers ? { kind: "layers", layers: [shapeLayer(item, W, H)] } : { kind: "shape", shape: item.shape, name: t(item.label) };
      }}
      className="grid aspect-square place-items-center rounded-lg border border-line bg-raised text-mute transition-colors hover:border-accent/40 hover:bg-hover hover:text-accent-ink">
      <div data-ghost className="grid size-9 place-items-center">
        <MiniLayers layers={preview} className="size-full overflow-visible" pad={0.04} />
      </div>
    </DragItem>
  );
}

function StickerTile({ item }: { item: StickerItem }) {
  const t = useT();
  const preview = useMemo(() => item.build(1000, 1000), [item]);
  return (
    <DragItem label={t(item.label)} tip={t(item.label)} tipSide="top"
      payload={() => { const { width: W, height: H } = page(); return { kind: "layers", layers: stickerLayers(item, W, H) }; }}
      className="grid h-[68px] place-items-center rounded-lg border border-line bg-[repeating-conic-gradient(var(--color-raised)_0_25%,var(--color-panel)_0_50%)] bg-[length:12px_12px] px-2 transition-colors hover:border-accent/40">
      <LazyMount className="grid size-full place-items-center">
        <div data-ghost className="grid h-12 w-full place-items-center">
          <MiniLayers layers={preview} className="h-full max-w-full" />
        </div>
      </LazyMount>
    </DragItem>
  );
}

function GradientTile({ item }: { item: GradientItem }) {
  const t = useT();
  const css = gradientCss(item.gradient);
  return (
    <div className="group relative">
      <DragItem label={t("Add {name}", { name: t(item.label) })} tip={t(item.label)} tipSide="top"
        payload={() => { const { width: W, height: H } = page(); return { kind: "layers", layers: [gradientLayer(item, W, H)] }; }}
        className="block overflow-hidden rounded-lg border border-line transition-colors hover:border-accent/40">
        <div data-ghost className="h-12 w-full bg-[repeating-conic-gradient(var(--color-raised)_0_25%,var(--color-panel)_0_50%)] bg-[length:10px_10px]">
          <div className="size-full" style={{ background: css }} />
        </div>
        <p className="truncate border-t border-line bg-raised px-1.5 py-1 text-2xs text-mute">{t(item.label)}</p>
      </DragItem>
      <button type="button" title={t("Use as the page background")} aria-label={t("Use {name} as the page background", { name: t(item.label) })}
        onClick={() => {
          const last = item.gradient.stops[item.gradient.stops.length - 1]?.color ?? "#000000";
          page().setBackground({ color: last.length === 9 ? last.slice(0, 7) : last, gradient: item.gradient });
        }}
        className="absolute right-1 top-1 rounded border border-line bg-panel/85 px-1 text-2xs font-medium text-mute opacity-0 backdrop-blur transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100">
        {t("Page")}
      </button>
    </div>
  );
}

/** A CSS impression of each effect over a sample still. */
function effectCss(e: EffectKind): CSSProperties {
  const d = newEffect(e, 100, 100);
  switch (e) {
    case "vignette": return { background: `radial-gradient(ellipse at center, transparent 35%, ${d.color} 110%)` };
    case "fade": return { background: `linear-gradient(180deg, transparent 30%, ${d.color} 95%)` };
    case "grain": return {
      backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.2' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='80' height='80' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E\")",
      mixBlendMode: "overlay",
    };
    case "light-leak": return { background: `radial-gradient(circle at 100% 0%, ${d.color} 0%, transparent 65%)`, mixBlendMode: "screen", opacity: 0.9 };
    case "glow": return { background: `radial-gradient(circle at 50% 55%, ${d.color}aa 0%, transparent 70%)`, mixBlendMode: "screen" };
    case "scanlines": return { background: "repeating-linear-gradient(0deg, rgba(0,0,0,0.45) 0 1px, transparent 1px 3px)" };
    case "frame": return { inset: "6px", border: `2px solid ${d.color}` };
  }
}
