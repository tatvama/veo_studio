/** Page properties (nothing selected): size and format, background, document palette, status. */
import { ArrowLeftRight, Check, ChevronDown, Link2, Link2Off, Palette, Plus, Wand2, X } from "lucide-react";
import { useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Popover, Segmented } from "../../../../components/ui";
import { cn } from "../../../../lib/cn";
import { useT } from "../../../../lib/i18n";
import { FORMATS, FORMAT_GROUPS, formatOf, ratioLabel, type Format } from "../../formats";
import { useEditor } from "../../store";
import { applyPalette, templateOf } from "../../templates";
import type { Gradient, Paint } from "../../types";
import { IconToggle, NumberField, PaintField, PropSection, Row, Swatch, ToggleRow } from "../controls";
import { normColor } from "./color";

const MIN = 64, MAX = 8000;
const clampSide = (v: number) => Math.round(Math.min(MAX, Math.max(MIN, v)));

/** A small rectangle in the format's ratio. */
export function RatioGlyph({ w, h, size = 18, className }: { w: number; h: number; size?: number; className?: string }) {
  const k = size / Math.max(w, h);
  return (
    <span className={cn("grid shrink-0 place-items-center", className)} style={{ width: size, height: size }}>
      <span className="rounded-[2px] border border-current" style={{ width: Math.max(4, w * k), height: Math.max(4, h * k) }} />
    </span>
  );
}

function FormatMenu({ current, onPick }: { current: string; onPick: (f: Format) => void }) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { width, height } = useEditor(useShallow((s) => ({ width: s.width, height: s.height })));
  const f = formatOf(current);
  const matches = f && f.width === width && f.height === height;
  return (
    <>
      <button ref={ref} type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
        className={cn("flex h-8 w-full min-w-0 items-center gap-2 rounded-md border bg-raised px-2 text-left text-xs outline-none transition-colors hover:border-dim/40 focus-visible:border-accent/70",
          open ? "border-accent/70" : "border-line")}>
        <RatioGlyph w={width} h={height} className="text-accent-ink" />
        <span className="min-w-0 flex-1 truncate font-medium text-ink">{matches ? t(f.label) : t("Custom size")}</span>
        <span className="mono shrink-0 text-2xs text-dim">{ratioLabel(width, height)}</span>
        <ChevronDown className="size-3.5 shrink-0 text-dim" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="left-start" width={288}>
        <div className="max-h-[min(32rem,80vh)] overflow-y-auto overscroll-contain p-1" role="menu">
          {FORMAT_GROUPS.map((g) => (
            <div key={g} className="pb-1">
              <div className="eyebrow px-2 pb-1 pt-2">{t(g)}</div>
              {FORMATS.filter((x) => x.group === g).map((x) => {
                const on = x.width === width && x.height === height;
                return (
                  <button key={x.key} type="button" role="menuitem" onClick={() => { setOpen(false); onPick(x); }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover">
                    <RatioGlyph w={x.width} h={x.height} size={20} className={on ? "text-accent-ink" : "text-dim"} />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-xs font-medium", on ? "text-accent-ink" : "text-ink")}>{t(x.label)}</span>
                      <span className="block truncate text-2xs text-dim">{t(x.hint)}</span>
                    </span>
                    <span className="mono shrink-0 text-right text-2xs text-dim">{x.width}×{x.height}<br />{ratioLabel(x.width, x.height)}</span>
                    {on && <Check className="size-3.5 shrink-0 text-accent-ink" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}

function SizeSection() {
  const t = useT();
  const { width, height, design, resize } = useEditor(useShallow((s) => ({ width: s.width, height: s.height, design: s.design, resize: s.resize })));
  const [smart, setSmart] = useState(true);
  const [lock, setLock] = useState(false);
  const formatKey = (w: number, h: number) => FORMATS.find((f) => f.width === w && f.height === h)?.key ?? "custom";
  const apply = (w: number, h: number) => {
    const W = clampSide(w), H = clampSide(h);
    if (W === width && H === height) return;
    resize(W, H, { smart, format: formatKey(W, H) });
  };
  const ratio = width / height;
  return (
    <PropSection id="page-size" title={t("Size")}>
      <FormatMenu current={design?.format ?? "custom"} onPick={(f) => resize(f.width, f.height, { smart, format: f.key })} />
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-1">
        <NumberField label="W" title={t("Width in pixels")} value={width} min={MIN} max={MAX} live={false}
          onChange={(w) => apply(w, lock ? w / ratio : height)} />
        <IconToggle title={lock ? t("Unlock aspect ratio") : t("Lock aspect ratio")} active={lock} onClick={() => setLock(!lock)}>
          {lock ? <Link2 /> : <Link2Off />}
        </IconToggle>
        <NumberField label="H" title={t("Height in pixels")} value={height} min={MIN} max={MAX} live={false}
          onChange={(h) => apply(lock ? h * ratio : width, h)} />
        <IconToggle title={t("Swap width and height")} onClick={() => apply(height, width)}><ArrowLeftRight /></IconToggle>
      </div>
      <ToggleRow label={t("Re-layout content")} hint={smart ? t("Layers move and scale to fit the new size") : t("Layers stay where they are")}
        checked={smart} onChange={setSmart} />
    </PropSection>
  );
}

function BackgroundSection() {
  const t = useT();
  const { background, setBackground, palette } = useEditor(useShallow((s) => ({ background: s.doc.background, setBackground: s.setBackground, palette: s.doc.meta?.palette })));
  const value: Paint = background.gradient ?? background.color;
  const change = (p: Paint | null) => {
    if (p == null) return;
    if (typeof p === "string") setBackground({ color: p, gradient: null }, "page:bg");
    else setBackground({ gradient: p as Gradient, color: background.color }, "page:bg");
  };
  return (
    <PropSection id="page-bg" title={t("Background")}>
      <PaintField value={value} onChange={change} palette={palette} />
    </PropSection>
  );
}

function PaletteSection() {
  const t = useT();
  const { palette, background, setBackground, commit } = useEditor(useShallow((s) => ({
    palette: s.doc.meta?.palette, background: s.doc.background, setBackground: s.setBackground, commit: s.commit,
  })));
  const list = palette ?? [];
  const setPalette = (next: string[]) => commit((d) => { d.meta = { ...(d.meta ?? {}), palette: next }; });
  const add = () => {
    const c = normColor(background.gradient ? background.gradient.stops[0]?.color ?? background.color : background.color);
    if (c && !list.some((x) => normColor(x) === c) && list.length < 10) setPalette([...list, c]);
  };
  return (
    <PropSection id="page-palette" title={t("Document colours")}
      actions={list.length > 1 ? (
        <IconToggle title={t("Recolour the design with this palette")} onClick={() => commit((d) => applyPalette(d, list))}><Wand2 /></IconToggle>
      ) : undefined}>
      {list.length ? (
        <div className="flex flex-wrap gap-1.5">
          {list.map((c, i) => (
            <div key={`${c}-${i}`} className="group relative">
              <button type="button" title={`${c} · ${t("click to use as the background")}`} onClick={() => setBackground({ color: c, gradient: null })}
                className="rounded-md outline-none ring-offset-1 ring-offset-panel transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-accent">
                <Swatch color={c} className="size-8" />
              </button>
              <button type="button" aria-label={t("Remove colour")} onClick={() => setPalette(list.filter((_, k) => k !== i))}
                className="absolute -right-1 -top-1 hidden size-4 place-items-center rounded-full border border-line bg-raised text-dim hover:text-bad group-hover:grid group-focus-within:grid">
                <X className="size-2.5" />
              </button>
            </div>
          ))}
          {list.length < 10 && (
            <button type="button" onClick={add} title={t("Add the background colour")}
              className="grid size-8 place-items-center rounded-md border border-dashed border-line text-dim transition-colors hover:border-dim/50 hover:text-ink">
              <Plus className="size-3.5" />
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-2xs text-dim">
          <Palette className="size-3.5 shrink-0" />
          <span className="flex-1">{t("No palette yet. Templates, brand kits and AI plans add one.")}</span>
          <button type="button" onClick={add} className="shrink-0 font-medium text-accent-ink hover:underline">{t("Start one")}</button>
        </div>
      )}
      {list.length > 0 && <p className="text-2xs text-dim">{t("Click a colour to paint the background. Select a layer to use these in its colour pickers.")}</p>}
    </PropSection>
  );
}

function StatusSection() {
  const t = useT();
  const { design, setMeta, count, revision } = useEditor(useShallow((s) => ({ design: s.design, setMeta: s.setMeta, count: s.doc.layers.length, revision: s.design?.revision })));
  if (!design) return null;
  const tpl = templateOf(design.template);
  return (
    <PropSection id="page-status" title={t("Status")}>
      <Segmented size="sm" value={design.status} onChange={(status) => setMeta({ status })} className="w-full [&>button]:flex-1" aria-label={t("Status")}
        options={[{ value: "draft", label: t("Draft") }, { value: "approved", label: <span className="inline-flex items-center gap-1"><Check className="size-3" />{t("Approved")}</span> }]} />
      <Row label={t("Layers")}><span className="mono text-xs text-ink">{count}</span></Row>
      {tpl && <Row label={t("Template")}><span className="truncate text-xs text-ink">{t(tpl.label)}</span></Row>}
      <Row label={t("Revision")}><span className="mono text-xs text-ink">{revision ?? 0}</span></Row>
    </PropSection>
  );
}

export function PageProps() {
  const t = useT();
  return (
    <>
      <div className="border-b border-line px-3 py-2.5">
        <div className="eyebrow">{t("Page")}</div>
        <p className="mt-1 text-2xs leading-snug text-dim">{t("Nothing selected. Click a layer on the canvas or in Layers to edit it.")}</p>
      </div>
      <SizeSection />
      <BackgroundSection />
      <PaletteSection />
      <StatusSection />
    </>
  );
}
