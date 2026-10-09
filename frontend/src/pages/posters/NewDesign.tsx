/**
 * New design dialog. Step 1 picks the size (format tiles or a custom W×H); step 2 picks a template, the project and
 * brand kit, a title, and optionally a one-line brief that the AI turns into a full plan (template, copy, palette and a
 * background prompt the editor can paint later).
 */
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowLeftRight, ArrowRight, Check, LayoutTemplate, Plus, Sparkles, Square } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Field, Input, Modal, Select, Textarea } from "../../components/ui";
import { cn } from "../../lib/cn";
import { LANG_NAMES } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useBrandKits, useProjects } from "../../lib/queries";
import type { BrandKit } from "../../lib/types";
import { designsApi } from "./api";
import { DocPreview } from "./canvas/Preview";
import { emptyDoc } from "./doc";
import { FONTS } from "./fonts";
import { FORMATS, FORMAT_GROUPS, formatOf, ratioLabel, type Format } from "./formats";
import { imageSize } from "./panels/right/shared";
import { TEMPLATES, templateOf, type BrandInput, type Template } from "./templates";
import type { DesignDoc } from "./types";

export interface NewDesignInitial {
  /** a FORMATS key (opens on step 2) */
  format?: string;
  /** a TEMPLATES key (opens on step 2 at the template's best format unless `format` is given) */
  template?: string;
}

const MIN = 64, MAX = 8000;
const sideOk = (v: number) => Number.isInteger(v) && v >= MIN && v <= MAX;
type TemplatePick = "blank" | "auto" | string;

/** A brand kit's colours, fonts (matched to the bundled families) and copy, without the logo. */
export function brandBase(kit: BrandKit): BrandInput {
  const fam = (name?: string) => {
    if (!name) return undefined;
    const n = name.trim().toLowerCase();
    return FONTS.find((f) => f.family.toLowerCase() === n || f.label.toLowerCase() === n || f.family.toLowerCase() === `${n} variable`)?.family;
  };
  return {
    colors: kit.colors ?? [], headingFont: fam(kit.fonts?.heading), bodyFont: fam(kit.fonts?.body), logo: null,
    tagline: kit.tagline || undefined, cta: kit.cta || undefined,
  };
}

/** Everything templates take from a brand kit, including the logo at its real size. */
export async function brandInput(kit: BrandKit): Promise<BrandInput> {
  let logo: BrandInput["logo"] = null;
  if (kit.logo_url && kit.logo_path) {
    const size = await imageSize(kit.logo_url).catch(() => null);
    if (size) logo = { src: kit.logo_url, asset: kit.logo_path, width: size.width, height: size.height };
  }
  return { ...brandBase(kit), logo };
}

/** Templates ordered for a size: those made for the format first (in their own order of preference), then by shape. */
export function rankTemplates(formatKey: string, w: number, h: number): { tpl: Template; fit: boolean }[] {
  const r = Math.log(w / h);
  const shape = (tp: Template) => {
    const f = formatOf(tp.formats[0]);
    return f ? Math.abs(Math.log(f.width / f.height) - r) : 9;
  };
  return TEMPLATES.map((tpl) => ({ tpl, fit: tpl.formats.includes(formatKey), idx: tpl.formats.indexOf(formatKey), d: shape(tpl) }))
    .sort((a, b) => (a.fit !== b.fit ? (a.fit ? -1 : 1) : a.fit ? a.idx - b.idx : a.d - b.d))
    .map(({ tpl, fit }) => ({ tpl, fit: fit || shape(tpl) < 0.12 }));
}

function RatioTile({ w, h, active }: { w: number; h: number; active: boolean }) {
  const k = 48 / Math.max(w, h);
  return (
    <span className="grid h-14 place-items-center">
      <span className={cn("rounded-[3px] border-[1.5px] transition-colors", active ? "border-accent bg-accent/15 shadow-[0_0_14px_-4px_var(--color-accent)]" : "border-dim/60 bg-raised group-hover:border-mute")}
        style={{ width: Math.max(10, w * k), height: Math.max(10, h * k) }} />
    </span>
  );
}

function FormatStep({ formatKey, setFormatKey, cw, ch, setCw, setCh, onNext }: {
  formatKey: string; setFormatKey: (k: string) => void; cw: string; ch: string; setCw: (v: string) => void; setCh: (v: string) => void; onNext: () => void;
}) {
  const t = useT();
  const w = Number(cw), h = Number(ch);
  const bad = formatKey === "custom" && (!sideOk(w) || !sideOk(h));
  return (
    <div className="space-y-5">
      {FORMAT_GROUPS.map((g) => (
        <section key={g}>
          <div className="eyebrow mb-2">{t(g)}</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {FORMATS.filter((f) => f.group === g).map((f: Format) => {
              const on = formatKey === f.key;
              return (
                <button key={f.key} type="button" onClick={() => setFormatKey(f.key)} onDoubleClick={() => { setFormatKey(f.key); onNext(); }} aria-pressed={on}
                  className={cn("group hud relative rounded-xl border p-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50",
                    on ? "border-accent/50 bg-accent/8" : "border-line bg-panel hover:border-dim/40 hover:bg-hover/50")}>
                  <RatioTile w={f.width} h={f.height} active={on} />
                  <span className="mt-1.5 block truncate text-sm font-medium text-ink">{t(f.label)}</span>
                  <span className="mono block text-2xs text-dim">{f.width}×{f.height} · {ratioLabel(f.width, f.height)}</span>
                  <span className="mt-0.5 line-clamp-1 block text-2xs text-mute">{t(f.hint)}</span>
                  {on && <Check className="absolute right-2 top-2 size-4 text-accent-ink" />}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      <section>
        <div className="eyebrow mb-2">{t("Custom")}</div>
        <div className={cn("hud flex flex-wrap items-center gap-3 rounded-xl border p-3 transition-colors",
          formatKey === "custom" ? "border-accent/50 bg-accent/8" : "border-line bg-panel")} onClick={() => setFormatKey("custom")}>
          <RatioTile w={sideOk(w) ? w : 1} h={sideOk(h) ? h : 1} active={formatKey === "custom"} />
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-mute">W
              <Input value={cw} onChange={(e) => setCw(e.target.value.replace(/[^\d]/g, ""))} onFocus={() => setFormatKey("custom")} inputMode="numeric"
                className="mono h-8 w-24" aria-label={t("Width in pixels")} aria-invalid={formatKey === "custom" && !sideOk(w)} />
            </label>
            <button type="button" title={t("Swap")} aria-label={t("Swap width and height")} onClick={(e) => { e.stopPropagation(); setCw(ch); setCh(cw); setFormatKey("custom"); }}
              className="grid size-8 place-items-center rounded-lg text-mute hover:bg-hover hover:text-ink"><ArrowLeftRight className="size-4" /></button>
            <label className="flex items-center gap-1.5 text-xs text-mute">H
              <Input value={ch} onChange={(e) => setCh(e.target.value.replace(/[^\d]/g, ""))} onFocus={() => setFormatKey("custom")} inputMode="numeric"
                className="mono h-8 w-24" aria-label={t("Height in pixels")} aria-invalid={formatKey === "custom" && !sideOk(h)} />
            </label>
            <span className="text-xs text-dim">px</span>
          </div>
          <span className={cn("text-2xs", bad ? "text-bad" : "text-dim")}>
            {bad ? t("Each side must be a whole number from {min} to {max} px.", { min: MIN, max: MAX }) : sideOk(w) && sideOk(h) ? ratioLabel(w, h) : ""}
          </span>
        </div>
      </section>
    </div>
  );
}

function TemplateCard({ label, sub, active, onClick, children, badge }: {
  label: string; sub?: string; active: boolean; onClick: () => void; children: ReactNode; badge?: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} aria-label={sub ? `${label}, ${sub}` : label}
      className={cn("group hud relative flex flex-col rounded-xl border p-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50",
        active ? "border-accent/50 bg-accent/8" : "border-line bg-panel hover:border-dim/40")}>
      <span className="grid h-32 place-items-center overflow-hidden rounded-lg bg-raised">{children}</span>
      <span className="mt-1.5 flex items-center gap-1 px-1">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{label}</span>
        {badge}
      </span>
      {sub && <span className="block truncate px-1 pb-0.5 text-2xs text-dim">{sub}</span>}
      {active && <span className="absolute right-2.5 top-2.5 grid size-5 place-items-center rounded-full bg-accent text-black"><Check className="size-3" /></span>}
    </button>
  );
}

export default function NewDesignDialog({ open, onClose, projectId, initial }: {
  open: boolean; onClose: () => void; projectId?: number | null; initial?: NewDesignInitial;
}) {
  const t = useT();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: kits } = useBrandKits();
  const { data: projects } = useProjects();
  const [step, setStep] = useState<1 | 2>(1);
  const [formatKey, setFormatKey] = useState("film_poster");
  const [cw, setCw] = useState("1080");
  const [ch, setCh] = useState("1350");
  const [template, setTemplate] = useState<TemplatePick>("blank");
  const [pid, setPid] = useState<number | null>(projectId ?? null);
  const [kitId, setKitId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [briefOn, setBriefOn] = useState(false);
  const [brief, setBrief] = useState("");
  const [language, setLanguage] = useState("en");
  const [busy, setBusy] = useState<"" | "plan" | "create">("");

  // fresh state each time it opens; quick-starts land straight on step 2
  useEffect(() => {
    if (!open) return;
    const tpl = templateOf(initial?.template);
    const fmt = initial?.format ?? tpl?.formats[0];
    setFormatKey(formatOf(fmt) ? fmt! : "film_poster");
    setStep(fmt ? 2 : 1);
    setTemplate(tpl ? tpl.key : "blank");
    setPid(projectId ?? null);
    // a project's brand kit and language are the natural defaults
    const p = projects?.find((x) => x.id === projectId);
    setKitId(p?.brand_kit_id ?? null);
    setLanguage(p && LANG_NAMES[p.primary_language] ? p.primary_language : "en");
    setTitle("");
    setBriefOn(false);
    setBrief("");
    setBusy("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pickProject = (id: number | null) => {
    setPid(id);
    const p = projects?.find((x) => x.id === id);
    if (p?.brand_kit_id && kitId === null) setKitId(p.brand_kit_id);
    if (p && LANG_NAMES[p.primary_language]) setLanguage(p.primary_language);
  };
  const toggleBrief = (on: boolean) => {
    setBriefOn(on);
    if (on && template === "blank") setTemplate("auto");
    if (!on && template === "auto") setTemplate("blank");
  };

  const fmt = formatKey === "custom" ? null : formatOf(formatKey);
  const W = fmt ? fmt.width : Number(cw), H = fmt ? fmt.height : Number(ch);
  const sizeOk = sideOk(W) && sideOk(H);
  const kit = kits?.find((k) => k.id === kitId) ?? null;

  // previews at the chosen size, in the brand's colours and fonts (the logo is added on create)
  const ranked = useMemo(() => (sizeOk ? rankTemplates(formatKey, W, H) : []), [formatKey, W, H, sizeOk]);
  const previews = useMemo(() => {
    if (!sizeOk || step !== 2) return new Map<string, DesignDoc>();
    const brand = kit ? brandBase(kit) : null;
    return new Map(ranked.map(({ tpl }) => [tpl.key, tpl.build({ width: W, height: H, brand })]));
  }, [ranked, W, H, sizeOk, step, kit]);
  const blankDoc = useMemo(() => emptyDoc(kit?.colors?.[0]), [kit]);

  const defaultTitle = (template !== "blank" && template !== "auto" ? templateOf(template)?.label : undefined) ?? fmt?.label ?? t("Custom design");
  const usingBrief = briefOn && brief.trim().length >= 3;

  const create = async () => {
    if (!sizeOk || busy) return;
    try {
      setBusy(usingBrief ? "plan" : "create");
      const brand = kit ? await brandInput(kit) : null;
      let doc: DesignDoc;
      let tplKey = template === "blank" || template === "auto" ? "" : template;
      let name = title.trim();
      if (usingBrief) {
        const plan = await designsApi.aiBrief({ brief: brief.trim(), format: formatKey, project_id: pid, language });
        const tpl = templateOf(tplKey) ?? templateOf(plan.template) ?? ranked[0]?.tpl ?? TEMPLATES[0];
        doc = tpl.build({
          width: W, height: H, title: plan.title || undefined, tagline: plan.tagline || undefined, credits: plan.credits || undefined,
          cta: plan.cta || undefined, badge: plan.badge || undefined, palette: !brand?.colors.length && plan.palette?.length ? plan.palette : undefined, brand,
        });
        doc = { ...doc, meta: { ...(doc.meta ?? {}), brief: plan.background_prompt || undefined } };
        tplKey = tpl.key;
        name ||= plan.title;
        setBusy("create");
      } else if (tplKey) {
        doc = templateOf(tplKey)!.build({ width: W, height: H, brand });
      } else {
        doc = emptyDoc(brand?.colors?.[0]);
        if (brand?.colors.length) doc.meta = { palette: brand.colors };
      }
      const d = await designsApi.create({
        title: (name || defaultTitle).slice(0, 200), format: formatKey, width: W, height: H, project_id: pid, template: tplKey, brand_kit_id: kitId, doc,
      });
      qc.invalidateQueries({ queryKey: ["designs"] });
      onClose();
      nav(`/posters/${d.id}`);
    } catch {
      /* the API client has shown the error */
    } finally {
      setBusy("");
    }
  };

  const sub = fmt ? `${t(fmt.label)} · ${W}×${H}` : sizeOk ? `${W}×${H} · ${ratioLabel(W, H)}` : "";
  const footer = step === 1 ? (
    <>
      <Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
      <Button variant="primary" disabled={!sizeOk} iconRight={<ArrowRight className="size-4" />} onClick={() => setStep(2)}>{t("Next")}</Button>
    </>
  ) : (
    <>
      <Button variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={() => setStep(1)} disabled={!!busy} className="mr-auto">{t("Size")}</Button>
      <Button variant="ghost" onClick={onClose} disabled={!!busy}>{t("Cancel")}</Button>
      <Button variant="primary" loading={!!busy} disabled={!sizeOk} onClick={create} icon={usingBrief ? <Sparkles className="size-4" /> : <Plus className="size-4" />}>
        {busy === "plan" ? t("Planning with AI…") : busy === "create" ? t("Creating…") : usingBrief ? t("Plan with AI & create") : t("Create design")}
      </Button>
    </>
  );

  return (
    <Modal open={open} onClose={() => !busy && onClose()} size="xl" footer={footer}
      title={<span className="flex items-center gap-2"><LayoutTemplate className="size-4 text-accent-ink" />{t("New design")}
        <span className="mono text-2xs font-normal text-dim">{step}/2 · {step === 1 ? t("Size") : sub}</span></span>}>
      {step === 1 ? (
        <FormatStep formatKey={formatKey} setFormatKey={setFormatKey} cw={cw} ch={ch} setCw={setCw} setCh={setCh} onNext={() => sizeOk && setStep(2)} />
      ) : (
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_17rem]">
          <section className="min-w-0">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span className="eyebrow">{t("Template")}</span>
              <span className="truncate text-2xs text-dim">{t("Best fits for this size first. Every template works at any size.")}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {briefOn && (
                <TemplateCard label={t("AI picks")} sub={t("Chosen from your brief")} active={template === "auto"} onClick={() => setTemplate("auto")}>
                  <span className="grid size-12 place-items-center rounded-xl border border-ai/30 bg-ai/10 text-ai"><Sparkles className="size-5" /></span>
                </TemplateCard>
              )}
              {!briefOn && (
                <TemplateCard label={t("Blank")} sub={t("Start from an empty page")} active={template === "blank"} onClick={() => setTemplate("blank")}>
                  {sizeOk ? <DocPreview doc={blankDoc} width={W} height={H} maxSize={112} className="rounded-sm shadow-card" /> : <Square className="size-6 text-dim" />}
                </TemplateCard>
              )}
              {ranked.map(({ tpl, fit }) => (
                <TemplateCard key={tpl.key} label={t(tpl.label)} sub={t(tpl.category)} active={template === tpl.key} onClick={() => setTemplate(tpl.key)}
                  badge={fit ? <Badge tone="accent" className="!px-1 !py-px text-[10px]">{t("Fits")}</Badge> : undefined}>
                  {previews.get(tpl.key) && <DocPreview doc={previews.get(tpl.key)!} width={W} height={H} maxSize={112} className="rounded-sm shadow-card" />}
                </TemplateCard>
              ))}
            </div>
          </section>
          <section className="space-y-4">
            <Field label={t("Title")}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={defaultTitle} maxLength={200} data-autofocus />
            </Field>
            <Field label={t("Project")} hint={projectId ? undefined : t("Optional. A project's designs can use its locked characters.")}>
              <Select value={pid ?? ""} onChange={(e) => pickProject(e.target.value ? Number(e.target.value) : null)}>
                <option value="">{t("No project")}</option>
                {(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </Select>
            </Field>
            <Field label={t("Brand kit")} hint={t("Optional. Recolours the template and adds the logo.")}>
              <Select value={kitId ?? ""} onChange={(e) => setKitId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">{t("None")}</option>
                {(kits ?? []).map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              </Select>
              {kit && kit.colors?.length > 0 && (
                <span className="mt-1.5 flex gap-1">{kit.colors.slice(0, 8).map((c, i) => <span key={i} className="size-4 rounded ring-1 ring-inset ring-line" style={{ background: c }} />)}</span>
              )}
            </Field>
            <div className={cn("rounded-xl border p-3 transition-colors", briefOn ? "border-ai/35 bg-ai/6" : "border-line")}>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" checked={briefOn} onChange={(e) => toggleBrief(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-ai)]" />
                <span>
                  <span className="flex items-center gap-1.5 text-sm font-medium text-ink"><Sparkles className="size-3.5 text-ai" />{t("Describe it and let AI plan it")}</span>
                  <span className="block text-2xs leading-snug text-dim">{t("Writes the title, tagline and credits, picks a layout and colours, and drafts a background prompt.")}</span>
                </span>
              </label>
              {briefOn && (
                <div className="mt-3 space-y-2">
                  <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={3000} rows={4} autoFocus
                    placeholder={t("e.g. Poster for our Kannada horror short about a temple lamp that relights itself. Dark, gold light, release 14 Nov.")} />
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-mute">{t("Text in")}</span>
                    <Select value={language} onChange={(e) => setLanguage(e.target.value)} className="h-8 flex-1 text-xs">
                      {Object.entries(LANG_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </Select>
                  </div>
                  {brief.trim().length > 0 && brief.trim().length < 3 && <p className="text-2xs text-warn">{t("Write a little more.")}</p>}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
}
