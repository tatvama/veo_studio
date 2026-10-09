/** Templates tab: "describe your poster" (AI brief → full layout + background) and the template gallery. */
import { LayoutTemplate, Palette, Sparkles } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge, Button, Segmented, Textarea } from "../../../../components/ui";
import { cn } from "../../../../lib/cn";
import { usd } from "../../../../lib/format";
import { tr, useT } from "../../../../lib/i18n";
import { useProject } from "../../../../lib/queries";
import type { Project } from "../../../../lib/types";
import { designsApi, runAi } from "../../api";
import { DocPreview } from "../../canvas/Preview";
import { formatOf } from "../../formats";
import { useEditor } from "../../store";
import { TEMPLATE_CATEGORIES, TEMPLATES, templateOf, type BrandInput, type Template, type TemplateCtx } from "../../templates";
import { finishTemplateDoc } from "./actions";
import { useBrand } from "./brand";
import { useLeft } from "./state";
import { Chip, confirmReplace, Hint, LazyMount, Section } from "./ui";

export const LANG_OPTIONS = [
  { value: "en", label: "EN", title: "English" }, { value: "hi", label: "HI", title: "Hindi" }, { value: "kn", label: "KN", title: "Kannada" },
  { value: "te", label: "TE", title: "Telugu" }, { value: "ta", label: "TA", title: "Tamil" },
];

/** One short line from a project logline, for a tagline (undefined when there isn't a short one). */
function shortLine(s: string | undefined | null): string | undefined {
  const first = (s ?? "").trim().split(/(?<=[.!?।])\s+/)[0]?.trim();
  return first && first.length <= 72 ? first : undefined;
}

type CardCopy = Pick<TemplateCtx, "title" | "tagline" | "cta">;

export const projectCopy = (p: Project | undefined): Pick<TemplateCtx, "title" | "tagline"> =>
  ({ title: p?.title?.trim() || undefined, tagline: shortLine(p?.concept) });

export default function TemplatesTab({ designId, projectId }: { designId: number; projectId: number | null }) {
  const t = useT();
  const W = useEditor((s) => s.width);
  const H = useEditor((s) => s.height);
  const format = useEditor((s) => s.design?.format ?? "");
  const current = useEditor((s) => s.design?.template ?? "");
  const project = useProject(projectId ?? 0).data;
  const { input: brand, kit } = useBrand(designId);
  const category = useLeft((s) => s.category);
  const setCategory = useLeft((s) => s.setCategory);
  // copy for the layouts: the project's title and logline first, then the brand kit's tagline and call to action
  const copy = useMemo<CardCopy>(() => {
    const p = projectCopy(project);
    return { title: p.title, tagline: p.tagline ?? brand?.tagline, cta: brand?.cta };
  }, [project, brand]);

  const list = useMemo(() => {
    const l = TEMPLATES.filter((x) => category === "All" || x.category === category);
    return [...l].sort((a, b) => Number(b.formats.includes(format)) - Number(a.formats.includes(format)));
  }, [category, format]);
  const counts = useMemo(() => Object.fromEntries(TEMPLATE_CATEGORIES.map((c) => [c, TEMPLATES.filter((x) => x.category === c).length])), []);

  const wide = W / H > 1.25;
  // DocPreview fits the design into a square of maxSize: pick it so the preview fills the column width
  const grid = useRef<HTMLDivElement>(null);
  const [gridW, setGridW] = useState(0);
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => { const w = Math.round(e.contentRect.width); if (w > 0) setGridW(w); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const colW = gridW ? (wide ? gridW : Math.floor((gridW - 8) / 2)) : wide ? 290 : 140;
  const maxSize = Math.floor((colW - 2) * (Math.max(W, H) / W));

  const ctxRef = useRef({ copy, brand });
  ctxRef.current = { copy, brand };
  // stable, so the memoised cards don't re-render when the tab does
  const apply = useCallback(async (tpl: Template) => {
    if (!(await confirmReplace(tr("The “{name}” template", { name: tpl.label })))) return;
    const st = useEditor.getState();
    const { copy: c, brand: b } = ctxRef.current;
    const built = finishTemplateDoc(tpl.build({ width: st.width, height: st.height, ...c, brand: b }), st.doc);
    st.replaceDoc(built, st.width, st.height);
    st.setMeta({ template: tpl.key });
  }, []);

  return (
    <>
      <BriefBox designId={designId} projectId={projectId} project={project} brand={brand} />
      <Section title={t("Templates")} icon={<LayoutTemplate />}
        actions={<span className="mono text-2xs text-dim">{list.length}</span>}>
        <div className="flex flex-wrap gap-1">
          <Chip on={category === "All"} onClick={() => setCategory("All")}>{t("All")} <span className="mono text-2xs opacity-70">{TEMPLATES.length}</span></Chip>
          {TEMPLATE_CATEGORIES.map((c) => (
            <Chip key={c} on={category === c} onClick={() => setCategory(c)}>{t(c)} <span className="mono text-2xs opacity-70">{counts[c]}</span></Chip>
          ))}
        </div>
        {kit && (
          <p className="mt-2.5 flex items-center gap-1.5 text-2xs text-mute">
            <Palette className="size-3.5 shrink-0 text-dim" />
            <span className="truncate">{t("On-brand with {kit}", { kit: kit.name })}</span>
            <span className="ml-auto flex shrink-0 -space-x-1">
              {kit.colors.slice(0, 5).map((c, i) => <span key={i} className="size-3 rounded-full ring-1 ring-line" style={{ background: c }} />)}
            </span>
          </p>
        )}
        <div ref={grid} className={cn("mt-3 grid gap-2", wide ? "grid-cols-1" : "grid-cols-2")}>
          {list.map((tpl) => (
            <TemplateCard key={tpl.key} tpl={tpl} W={W} H={H} copy={copy} brand={brand} maxSize={maxSize} active={current === tpl.key}
              fits={tpl.formats.includes(format)} onApply={apply} />
          ))}
        </div>
        {!list.length && <Hint className="py-6 text-center">{t("No templates in this category yet.")}</Hint>}
      </Section>
    </>
  );
}

const TemplateCard = memo(function TemplateCard({ tpl, W, H, copy, brand, maxSize, active, fits, onApply }: {
  tpl: Template; W: number; H: number; copy: CardCopy; brand: BrandInput | null; maxSize: number;
  active: boolean; fits: boolean; onApply: (t: Template) => void;
}) {
  const t = useT();
  const best = tpl.formats.slice(0, 3).map((k) => formatOf(k)?.label).filter(Boolean).join(", ");
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("Use the {name} template", { name: tpl.label })}
      onClick={() => onApply(tpl)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onApply(tpl); } }}
      className={cn("group hud relative cursor-pointer overflow-hidden rounded-xl border bg-raised text-left transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-accent/50",
        active ? "border-accent/60 shadow-[0_0_0_1px_var(--color-accent)]" : "border-line hover:border-accent/40")}
    >
      <div className="relative w-full overflow-hidden" style={{ aspectRatio: `${W} / ${H}` }}>
        <LazyMount className="pointer-events-none absolute inset-0 grid place-items-center"
          placeholder={<div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${tpl.swatch[0]}, ${tpl.swatch[1]})` }} />}>
          <BuiltPreview tpl={tpl} W={W} H={H} copy={copy} brand={brand} maxSize={maxSize} />
        </LazyMount>
        <div className="absolute left-1.5 top-1.5 flex gap-1">
          {active && <Badge tone="accent">{t("In use")}</Badge>}
        </div>
        {fits && (
          <span title={t("Made for this size")} className="absolute right-1.5 top-1.5 rounded-md border border-line bg-panel/85 px-1 py-0.5 text-2xs font-medium text-ok backdrop-blur">
            {t("Fits")}
          </span>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-full border-t border-line bg-panel/92 p-2 opacity-0 backdrop-blur-md transition-[transform,opacity] duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
          <p className="text-2xs leading-snug text-ink">{t(tpl.description)}</p>
          {best && <p className="mt-1 text-2xs leading-snug text-dim">{t("Best for")}: {best}</p>}
        </div>
      </div>
      <div className="flex items-center justify-between gap-1 border-t border-line px-2 py-1.5">
        <span className="truncate text-xs font-medium text-ink">{t(tpl.label)}</span>
        <span className="eyebrow shrink-0">{t(tpl.category)}</span>
      </div>
    </div>
  );
});

function BuiltPreview({ tpl, W, H, copy, brand, maxSize }: {
  tpl: Template; W: number; H: number; copy: CardCopy; brand: BrandInput | null; maxSize: number;
}) {
  const doc = useMemo(() => tpl.build({ width: W, height: H, ...copy, brand }), [tpl, W, H, copy, brand]);
  return <DocPreview doc={doc} width={W} height={H} maxSize={maxSize} />;
}

// ── AI brief ─────────────────────────────────────────────

function BriefBox({ designId, projectId, project, brand }: { designId: number; projectId: number | null; project: Project | undefined; brand: BrandInput | null }) {
  const t = useT();
  const [brief, setBrief] = useState("");
  const [lang, setLang] = useState<string>(() => (["en", "hi", "kn", "te", "ta"].includes(project?.primary_language ?? "") ? project!.primary_language : "en"));
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    const text = brief.trim();
    if (text.length < 3 || busy) return;
    if (!(await confirmReplace(tr("An AI layout")))) return;
    setBusy(true);
    try {
      const st0 = useEditor.getState();
      const plan = await designsApi.aiBrief({ brief: text, format: st0.design?.format || "custom", project_id: projectId, language: lang });
      const tpl = templateOf(plan.template) ?? templateOf("film_onesheet")!;
      const st = useEditor.getState();
      const built = finishTemplateDoc(tpl.build({
        width: st.width, height: st.height, title: plan.title || undefined, tagline: plan.tagline || undefined, credits: plan.credits || undefined,
        cta: plan.cta || brand?.cta || undefined, badge: plan.badge || undefined, palette: !brand && plan.palette?.length ? plan.palette : undefined, brand,
      }), st.doc, { skipSlots: ["background"] });
      built.meta = { ...(built.meta ?? {}), brief: text };
      st.replaceDoc(built, st.width, st.height);
      st.setMeta({ template: tpl.key });
      useLeft.getState().setBriefPlan(designId, { prompt: plan.background_prompt, style: plan.style });
      const bg = built.layers.find((l) => l.type === "image" && l.slot === "background");
      if (bg && plan.background_prompt) {
        const ok = await runAi(designId, { kind: "background", layerId: bg.id, prompt: plan.background_prompt, style: plan.style });
        toast.success(tr("Laid out as “{name}”", { name: tpl.label }), { description: ok ? tr("Painting the background now…") : undefined });
      } else {
        toast.success(tr("Laid out as “{name}”", { name: tpl.label }));
      }
    } catch {
      /* the API already said what went wrong */
    } finally {
      setBusy(false);
    }
  };

  const fromProject = project ? [project.title, project.concept].filter(Boolean).join(": ") : "";

  return (
    <Section title={t("Describe your poster")} icon={<Sparkles />} tone="ai">
      <Textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void generate(); } }}
        rows={3}
        maxLength={3000}
        placeholder={t("A dark thriller one-sheet: a priest holding a brass lamp in a flooded temple at night. Release 14 Nov.")}
        className="min-h-[84px] text-sm"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <Segmented size="sm" aria-label={t("Language of the poster text")} value={lang} options={LANG_OPTIONS} onChange={setLang} />
        <Button size="sm" variant="primary" icon={<Sparkles className="size-3.5" />} loading={busy} disabled={brief.trim().length < 3}
          onClick={() => void generate()}>
          {t("Generate")}
        </Button>
      </div>
      {fromProject && !brief && (
        <button type="button" onClick={() => setBrief(fromProject)} className="mt-2 text-left text-2xs font-medium text-accent-ink hover:underline">
          {t("Start from the project's logline")}
        </button>
      )}
      <Hint className="mt-2">
        {t("Picks a layout, writes the copy and colours, then paints the background")} (<span className="mono text-money">~{usd(0.07)}</span>).
      </Hint>
    </Section>
  );
}
