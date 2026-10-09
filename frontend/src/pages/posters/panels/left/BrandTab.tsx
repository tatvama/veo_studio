/** Brand tab: pick a brand kit for this design, then apply its colours and fonts or drop in its logo, tagline, CTA and products. */
import { Check, ExternalLink, Image as ImageIcon, Megaphone, Package, Palette, PenLine, Type } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Badge, Button, Skeleton } from "../../../../components/ui";
import { cn } from "../../../../lib/cn";
import { tr, useT } from "../../../../lib/i18n";
import { useProject } from "../../../../lib/queries";
import type { BrandKit } from "../../../../lib/types";
import { newImage } from "../../doc";
import { familyStack, fontDef } from "../../fonts";
import { useEditor } from "../../store";
import { applyPalette } from "../../templates";
import type { DropPayload, ImageLayer, Layer } from "../../types";
import { applyBrandFonts, applyColour, textLayer } from "./actions";
import { useBrand } from "./brand";
import { DragItem, Hint, LazyMount, recordSize, Section, sizeOf } from "./ui";

/** Black or white text, whichever reads better on a colour. */
function inkOn(color: string): string {
  const m = /^#?([0-9a-f]{6})/i.exec(color);
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#0b0f17" : "#ffffff";
}

export default function BrandTab({ designId, projectId }: { designId: number; projectId: number | null }) {
  const t = useT();
  const { kits, kit, kitId, input, logoSize, choose } = useBrand(designId);
  const projectKit = useProject(projectId ?? 0).data?.brand_kit_id ?? null;

  if (kits.isLoading) {
    return <Section title={t("Brand kits")} icon={<Palette />}><div className="space-y-1.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div></Section>;
  }
  const list = kits.data ?? [];
  if (!list.length) {
    return (
      <Section title={t("Brand kits")} icon={<Palette />}>
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-4 py-8 text-center">
          <span className="grid size-10 place-items-center rounded-xl border border-line bg-raised text-dim"><Palette className="size-5" /></span>
          <p className="text-sm font-medium text-ink">{t("No brand kits yet")}</p>
          <p className="text-xs leading-relaxed text-mute">{t("A brand kit holds a logo, colours, fonts, a tagline and a call to action. Make one and every template comes out on-brand.")}</p>
          <Link to="/brand-kits" className="mt-1"><Button size="sm" variant="secondary" icon={<ExternalLink className="size-3.5" />}>{t("Create a brand kit")}</Button></Link>
        </div>
      </Section>
    );
  }

  return (
    <>
      <Section title={t("Brand kit")} icon={<Palette />} actions={<Link to="/brand-kits" className="text-2xs font-medium text-accent-ink hover:underline">{t("Manage")}</Link>}>
        <div className="space-y-1" role="radiogroup" aria-label={t("Brand kit for this design")}>
          {list.map((k) => (
            <KitRow key={k.id} k={k} on={k.id === kitId} project={k.id === projectKit} onPick={() => choose(k.id === kitId ? null : k.id)} />
          ))}
        </div>
        <Hint className="mt-2">{kit ? t("Templates and AI layouts now use this kit. Click it again to stop.") : t("Pick a kit to make templates and AI layouts come out on-brand.")}</Hint>
      </Section>
      {kit && <KitDetails kit={kit} heading={input?.headingFont} body={input?.bodyFont} logoSize={logoSize} />}
    </>
  );
}

function KitRow({ k, on, project, onPick }: { k: BrandKit; on: boolean; project: boolean; onPick: () => void }) {
  const t = useT();
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onPick}
      className={cn("flex w-full items-center gap-2.5 rounded-lg border px-2 py-1.5 text-left transition-colors",
        on ? "border-accent/60 bg-accent/10" : "border-line bg-raised hover:bg-hover")}>
      <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-[repeating-conic-gradient(var(--color-raised)_0_25%,var(--color-panel)_0_50%)] bg-[length:8px_8px]">
        {k.logo_url ? <img src={k.logo_url} alt="" className="max-h-full max-w-full object-contain p-0.5" /> : <Palette className="size-4 text-dim" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-ink">{k.name}</span>
          {project && <Badge tone="info">{t("Project")}</Badge>}
        </span>
        <span className="mt-1 flex gap-0.5">
          {(k.colors ?? []).slice(0, 6).map((c, i) => <span key={i} className="h-2 w-4 rounded-sm ring-1 ring-line" style={{ background: c }} />)}
        </span>
      </span>
      {on && <Check className="size-4 shrink-0 text-accent-ink" />}
    </button>
  );
}

function KitDetails({ kit, heading, body, logoSize }: { kit: BrandKit; heading?: string; body?: string; logoSize: { w: number; h: number } | null }) {
  const t = useT();
  const colors = (kit.colors ?? []).filter(Boolean);
  const headingWanted = kit.fonts?.heading?.trim() ?? "";
  const bodyWanted = kit.fonts?.body?.trim() ?? "";

  const logoLayers = (): Layer[] | null => {
    if (!kit.logo_url || !logoSize) return null;
    const { width: W, height: H } = useEditor.getState();
    const S = Math.min(W, H), box = S * 0.14, k = Math.min(box / logoSize.w, box / logoSize.h), m = S * 0.05;
    const w = Math.round(logoSize.w * k), h = Math.round(logoSize.h * k);
    const l: ImageLayer = { ...newImage(kit.logo_url, logoSize.w, logoSize.h, W, H, { asset: kit.logo_path || undefined, role: "logo", name: `${kit.name} logo` }),
      x: Math.round(W - w - m), y: Math.round(m), width: w, height: h };
    return [l];
  };
  const taglineLayer = () => [textLayer("tagline", { text: kit.tagline, ...(body ? { fontFamily: body } : {}) })];
  const ctaLayer = () => {
    const bg = colors[1] ?? colors[0] ?? "#22d3ee";
    const l = textLayer("cta", { text: kit.cta, ...(heading ? { fontFamily: heading } : {}) });
    return [{ ...l, fill: inkOn(bg), background: l.background ? { ...l.background, color: bg } : l.background }];
  };

  const applyColours = () => {
    if (!colors.length) return;
    const st = useEditor.getState();
    st.replaceDoc(applyPalette(st.doc, colors), st.width, st.height);
    toast.success(tr("Brand colours applied"));
  };
  const applyFonts = () => {
    const n = applyBrandFonts(heading, body);
    toast[n ? "success" : "info"](n ? tr("Brand fonts on {n} text layer(s)", { n }) : tr("The text already uses the brand fonts"));
  };

  return (
    <>
      <Section title={t("Apply")} icon={<PenLine />}>
        <div className="grid grid-cols-2 gap-1.5">
          <ActionTile icon={<Palette />} label={t("Apply colours")} sub={t("Background, buttons, shapes")} onClick={applyColours} disabled={!colors.length} />
          <ActionTile icon={<Type />} label={t("Apply fonts")} sub={t("Headings and body text")} onClick={applyFonts} disabled={!heading && !body} />
          <DragTile icon={<ImageIcon />} label={t("Add logo")} sub={t("Top-right corner")} disabled={!kit.logo_url || !logoSize}
            payload={() => { const l = logoLayers(); return l ? { kind: "layers", layers: l } : null; }} />
          <DragTile icon={<Type />} label={t("Add tagline")} sub={kit.tagline || t("No tagline in the kit")} disabled={!kit.tagline}
            payload={() => ({ kind: "layers", layers: taglineLayer() })} />
          <DragTile icon={<Megaphone />} label={t("Add CTA")} sub={kit.cta || t("No call to action in the kit")} disabled={!kit.cta}
            payload={() => ({ kind: "layers", layers: ctaLayer() })} />
        </div>
      </Section>

      <Section title={t("Colours")} icon={<Palette />} actions={<span className="mono text-2xs text-dim">{colors.length}</span>}>
        {colors.length ? (
          <>
            <div className="grid grid-cols-6 gap-1.5">
              {colors.map((c, i) => (
                <DragItem key={`${c}-${i}`} label={t("Use colour {c}", { c })} tip={<span className="mono">{c.toUpperCase()}</span>} tipSide="top"
                  payload={() => ({ kind: "shape", shape: "rect", fill: c, name: "Colour block" })}
                  onAdd={() => { if (applyColour(c) === "none") toast.info(tr("Select text or a shape to colour it, or nothing to colour the page.")); }}
                  className="group">
                  <span data-ghost className="block aspect-square w-full rounded-lg ring-1 ring-line transition-transform group-hover:scale-105" style={{ background: c }} />
                </DragItem>
              ))}
            </div>
            <Hint className="mt-2">{t("Click: colour the selected text or shapes (or the page when nothing is selected). Drag: a colour block.")}</Hint>
          </>
        ) : <Hint>{t("This kit has no colours yet.")}</Hint>}
      </Section>

      <Section title={t("Fonts")} icon={<Type />}>
        <FontRow role={t("Heading")} big wanted={headingWanted} family={heading} sample="Aa Bb · THE LAST LIGHT" />
        <FontRow role={t("Body")} wanted={bodyWanted} family={body} sample="Credits, details and captions" />
      </Section>

      {kit.logo_url && (
        <Section title={t("Logo")} icon={<ImageIcon />}>
          <DragItem label={t("Add logo")} payload={() => { const l = logoLayers(); return l ? { kind: "layers", layers: l } : null; }}
            className="grid h-24 place-items-center rounded-lg border border-line bg-[repeating-conic-gradient(var(--color-raised)_0_25%,var(--color-panel)_0_50%)] bg-[length:12px_12px] p-3 transition-colors hover:border-accent/40">
            <img data-ghost src={kit.logo_url} alt={t("{name} logo", { name: kit.name })} draggable={false} className="max-h-full max-w-full object-contain" />
          </DragItem>
        </Section>
      )}

      {(kit.product_urls ?? []).length > 0 && (
        <Section title={t("Products")} icon={<Package />} actions={<span className="mono text-2xs text-dim">{kit.product_urls.length}</span>}>
          <div className="grid grid-cols-3 gap-1.5">
            {kit.product_urls.map((p) => (
              <DragItem key={p.path} label={t("Add {name}", { name: p.label || t("product") })} tip={p.label || undefined} tipSide="top"
                payload={(): DropPayload => {
                  const d = sizeOf(p.url) ?? { w: 1024, h: 1024 };
                  return { kind: "image", src: p.url, asset: p.path, width: d.w, height: d.h, role: "product", name: p.label || "Product" };
                }}
                className="block aspect-square overflow-hidden rounded-lg border border-line bg-[repeating-conic-gradient(var(--color-raised)_0_25%,var(--color-panel)_0_50%)] bg-[length:10px_10px] transition-colors hover:border-accent/40">
                <LazyMount className="size-full">
                  <img data-ghost src={p.url} alt={p.label} loading="lazy" draggable={false} onLoad={recordSize(p.url)} className="size-full object-contain p-1" />
                </LazyMount>
              </DragItem>
            ))}
          </div>
          <Hint className="mt-2">{t("Also offered as references in the AI tab's Product mode.")}</Hint>
        </Section>
      )}
    </>
  );
}

function FontRow({ role, wanted, family, sample, big }: { role: string; wanted: string; family?: string; sample: string; big?: boolean }) {
  const t = useT();
  const def = family ? fontDef(family) : undefined;
  return (
    <div className="mb-2 rounded-lg border border-line bg-raised px-2.5 py-2 last:mb-0">
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow">{role}</span>
        <span className="truncate text-2xs text-mute">{wanted || t("Not set")}</span>
      </div>
      {family ? (
        <p className="mt-1 truncate text-ink" style={{ fontFamily: familyStack(family), fontSize: big ? 20 : 14, fontWeight: def?.weights.includes(600) ? 600 : def?.weights[0] }}>
          {sample}
        </p>
      ) : wanted ? (
        <Hint className="mt-1">{t("{font} isn't one of the bundled poster fonts, so text keeps its current font.", { font: wanted })}</Hint>
      ) : null}
    </div>
  );
}

function ActionTile({ icon, label, sub, onClick, disabled }: { icon: ReactNode; label: string; sub: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="flex min-w-0 items-start gap-2 rounded-lg border border-line bg-raised px-2 py-2 text-left transition-colors hover:border-accent/40 hover:bg-hover disabled:pointer-events-none disabled:opacity-45">
      <span className="mt-0.5 shrink-0 text-accent-ink [&>svg]:size-4">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-ink">{label}</span>
        <span className="block truncate text-2xs text-dim">{sub}</span>
      </span>
    </button>
  );
}

function DragTile({ icon, label, sub, payload, disabled }: { icon: ReactNode; label: string; sub: string; payload: () => DropPayload | null; disabled?: boolean }) {
  return (
    <DragItem label={label} payload={payload} disabled={disabled}
      className="flex min-w-0 items-start gap-2 rounded-lg border border-line bg-raised px-2 py-2 text-left transition-colors hover:border-accent/40 hover:bg-hover">
      <span className="mt-0.5 shrink-0 text-accent-ink [&>svg]:size-4">{icon}</span>
      <span data-ghost className="min-w-0">
        <span className="block truncate text-xs font-medium text-ink">{label}</span>
        <span className="block truncate text-2xs text-dim">{sub}</span>
      </span>
    </DragItem>
  );
}
