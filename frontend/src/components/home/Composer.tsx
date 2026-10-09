import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { FileText, LayoutTemplate, Lightbulb, PenLine, Shuffle, Sparkles, Star, Wand2, X } from "lucide-react";
import { AnimatePresence, motion, useAnimate } from "motion/react";
import { forwardRef, useId, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { LANG_NAMES, LANG_SHORT, QUALITY_INFO } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useSettings } from "../../lib/queries";
import type { Project } from "../../lib/types";
import { MOD } from "../shell/keys";
import type { ProjectTemplate } from "../shell/templates";
import { Badge, Button, Kbd, Panel, ScrollStrip, Segmented, Select } from "../ui";
import { Eyebrow } from "./Chips";
import { type Aspect, DEFAULT_ASPECT, useExamples, useProjectKinds, type ProjectKind } from "./kinds";

export interface ComposerHandle {
  /** Scroll the composer into view and put the cursor in the concept box. */
  focus: () => void;
  /** Pre-fill every field from a template. */
  applyTemplate: (tpl: ProjectTemplate) => void;
}

const SPRING = { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } as const;

/** Small outlined rectangle that previews the frame shape. */
function FrameGlyph({ w, h }: { w: number; h: number }) {
  return <span className="rounded-[2px] border-[1.5px] border-current" style={{ width: w, height: h }} />;
}

/** One format (Short, Series, Ad…) as a compact radio tile: icon, name and its default frame. */
function KindChip({ kind, selected, hint, layoutId, onSelect }: {
  kind: ProjectKind; selected: boolean; hint: string; layoutId: string; onSelect: () => void;
}) {
  const Icon = kind.icon;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-active={selected}
      onClick={onSelect}
      className={clsx(
        "group relative flex h-12 w-40 shrink-0 items-center gap-2.5 rounded-lg border px-2.5 text-left transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.98] @3xl:w-auto @3xl:min-w-0",
        selected ? "border-transparent" : "border-line bg-panel hover:border-dim/50 hover:bg-hover",
      )}
    >
      {selected && (
        <motion.span layoutId={layoutId} transition={SPRING} className="absolute inset-0 rounded-lg border border-accent bg-accent/10 shadow-[0_0_14px_-4px_var(--color-accent)]" />
      )}
      <span className={clsx("relative grid size-7 shrink-0 place-items-center rounded-md transition-colors duration-200",
        selected ? "bg-accent text-[color:var(--on-accent)]" : "bg-raised text-mute group-hover:text-ink")}>
        <Icon className="size-4" />
      </span>
      <span className="relative min-w-0 flex-1">
        <span className="block truncate text-xs font-medium leading-tight">{kind.label}</span>
        <span className="mono mt-1 block text-2xs leading-none text-dim">{hint}</span>
      </span>
    </button>
  );
}

function Cell({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("min-w-0", className)}>
      <Eyebrow className="mb-2 flex items-baseline gap-1.5">
        {label}
        {hint && <span className="font-sans text-2xs font-normal normal-case tracking-normal text-dim">{hint}</span>}
      </Eyebrow>
      {children}
    </div>
  );
}

/**
 * The "New production" console: concept box, template rail, format / frame / languages / look / quality, autopilot and Start.
 * Parents drive it through the ref (templates, deep links and empty states all call applyTemplate / focus). `rail` is
 * rendered between the concept and the options (the Command Center puts its template cards there).
 */
export const Composer = forwardRef<ComposerHandle, { onTemplateChange?: (tpl: ProjectTemplate | null) => void; rail?: ReactNode; index?: number }>(function Composer({ onTemplateChange, rail, index }, ref) {
  const t = useT();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data: settings } = useSettings();
  const kinds = useProjectKinds();
  const examples = useExamples();
  const ringId = useId();
  const [concept, setConcept] = useState("");
  const [type, setType] = useState("short");
  const [aspect, setAspect] = useState<Aspect>("9:16");
  const [langs, setLangs] = useState<string[]>(["en"]);
  const [primary, setPrimary] = useState("en");
  const [style, setStyle] = useState("");
  const [quality, setQuality] = useState("");
  /** "" = step by step; otherwise Autopilot runs to this milestone, stopping for approval after each one before it. */
  const [autopilot, setAutopilot] = useState<"" | "script" | "storyboard" | "final">("");
  const [busy, setBusy] = useState<"" | "idea" | "import" | "manual">("");
  const [applied, setApplied] = useState<ProjectTemplate | null>(null);
  const [ideaPage, setIdeaPage] = useState(0);
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const flash = useRef<HTMLSpanElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const qualityLabel: Record<string, string> = { saver: t("Saver"), balanced: t("Balanced"), hero: t("Hero") };

  const focusConcept = () => {
    scope.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => {
      const el = area.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    }, 250);
  };

  const applyTemplate = (tpl: ProjectTemplate) => {
    setConcept(tpl.concept);
    setType(tpl.type);
    setAspect(tpl.aspect);
    setLangs(tpl.languages);
    setPrimary(tpl.primary);
    setStyle(tpl.style);
    setQuality(tpl.quality ?? "");
    setApplied(tpl);
    onTemplateChange?.(tpl);
    if (flash.current) void animate(flash.current, { opacity: [1, 0] }, { duration: 1.1, ease: "easeOut" });
    focusConcept();
  };

  useImperativeHandle(ref, () => ({ focus: focusConcept, applyTemplate }));

  const clearTemplate = () => {
    setApplied(null);
    onTemplateChange?.(null);
  };

  const pickKind = (v: string) => {
    setType(v);
    setAspect(DEFAULT_ASPECT[v] ?? "9:16");
  };

  const toggleLang = (l: string) => {
    const next = langs.includes(l) ? langs.filter((x) => x !== l) : [...langs, l];
    if (!next.length) return;
    setLangs(next);
    if (!next.includes(primary)) setPrimary(next[0]);
  };

  /** idea: the Director writes it · import: bring your own script · manual: build the shot list yourself. */
  const create = async (mode: "idea" | "import" | "manual" = "idea") => {
    const own = mode !== "idea";
    if (!own && concept.trim().length < 3) {
      toast.error(tr("Describe your idea first"));
      area.current?.focus();
      if (scope.current) void animate(scope.current, { x: [0, -7, 7, -4, 4, 0] }, { duration: 0.35 });
      return;
    }
    setBusy(mode);
    try {
      const fallback = mode === "import" ? tr("Imported script") : tr("Shot-by-shot project");
      const p = await api.post<Project>("/api/projects", {
        concept: concept.trim().length >= 3 ? concept : fallback, title: own && concept.trim().length < 3 ? fallback : "",
        type, aspect, languages: langs, primary_language: primary, style_preset: style || null, quality_mode: quality || null,
        agent_mode: "copilot", auto_brief: !own, workflow: mode === "manual" ? "shots" : mode === "import" ? "script" : "director",
      });
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success(tr("Project \"{title}\" created", { title: p.title }));
      nav(own ? `/p/${p.id}/shots${mode === "import" ? "?import=1" : ""}` : `/p/${p.id}/${autopilot ? `brief?autopilot=${autopilot}` : "story"}`);
    } catch {
      /* the api helper already showed the error */
    } finally {
      setBusy("");
    }
  };

  const showIdeas = !concept.trim() || examples.includes(concept);
  const chars = concept.trim().length;
  const first = (ideaPage * 2) % examples.length;
  const ideas = [examples[first], examples[(first + 1) % examples.length]];

  return (
    <div ref={scope} className="relative">
      <span ref={flash} aria-hidden className="pointer-events-none absolute -inset-1 z-10 rounded-[0.875rem] opacity-0 ring-4 ring-accent/45" />

      <Panel
        index={index}
        tone="ai"
        flush
        bodyClassName="pt-3"
        eyebrow={<span className="text-ai">{t("New production")}</span>}
        icon={<Wand2 className="text-ai" />}
        className="transition-[border-color,box-shadow] duration-300 focus-within:border-accent/50 focus-within:shadow-glow"
        actions={<span className="hidden items-center gap-1 text-2xs text-dim sm:flex"><Kbd>{MOD}</Kbd><Kbd>↵</Kbd>{t("to start")}</span>}
      >
        <div className="@container overflow-hidden rounded-b-xl">
          {/* ── concept ─────────────────────────────────────────────────── */}
          <div className="px-4">
            <AnimatePresence initial={false}>
              {applied && (
                <motion.div key="tpl" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18 }} className="overflow-hidden">
                  <div className="mb-2 flex items-center gap-1.5">
                    <Badge tone="accent"><LayoutTemplate className="size-3" />{t("Template")}: {applied.label}</Badge>
                    <button type="button" onClick={clearTemplate} aria-label={t("Clear template")}
                      className="grid size-6 place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-ink">
                      <X className="size-3.5" />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <textarea
              ref={area}
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void create(); } }}
              aria-label={t("Your concept")}
              placeholder={t("e.g. A young temple priest discovers the brass lamp moves by itself at night…")}
              rows={2}
              className="block max-h-72 min-h-[4.5rem] w-full resize-none bg-transparent text-base leading-relaxed text-ink [field-sizing:content] placeholder:text-dim focus:outline-none @xl:text-lg"
            />
            <div className="flex items-center justify-between gap-3 pb-3 pt-1 text-2xs text-dim">
              <span className="mono">{chars > 0 ? t("{n} chars", { n: chars }) : t("One or two sentences is enough.")}</span>
            </div>
          </div>

          <AnimatePresence initial={false}>
            {showIdeas && (
              <motion.div key="ideas" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }} className="overflow-hidden">
                <div className="px-4 pb-4">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <Eyebrow className="flex items-center gap-1.5"><Lightbulb className="size-3.5" />{t("Need a spark? Try one")}</Eyebrow>
                    <button type="button" onClick={() => setIdeaPage((n) => n + 1)}
                      className="-my-1 inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-2xs font-medium text-mute transition-colors hover:bg-hover hover:text-ink active:scale-95">
                      <Shuffle className="size-3" />{t("More ideas")}
                    </button>
                  </div>
                  <div key={ideaPage} className="anim-fade grid gap-2 @2xl:grid-cols-2">
                    {ideas.map((ex, i) => {
                      const on = concept === ex;
                      return (
                        <button key={ex} type="button" onClick={() => setConcept(ex)} aria-pressed={on}
                          className={clsx(
                            "group/idea items-start gap-2 rounded-lg border px-3 py-2.5 text-left text-xs leading-relaxed transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.99]",
                            i > 0 ? "hidden @2xl:flex" : "flex",
                            on ? "border-accent/60 bg-accent/10 text-ink" : "border-line bg-raised/50 text-mute hover:border-accent/40 hover:bg-raised hover:text-ink",
                          )}>
                          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-ai transition-transform duration-200 group-hover/idea:scale-110" />
                          <span className="min-w-0">{ex}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── template rail ───────────────────────────────────────────── */}
          {rail && <div className="border-t border-line px-4 py-3">{rail}</div>}

          {/* ── options ─────────────────────────────────────────────────── */}
          <div className="space-y-4 border-t border-line bg-raised/30 px-4 py-4">
            <Cell label={t("Format")}>
              <ScrollStrip role="radiogroup" aria-label={t("Format")} className="-mx-4 -my-1">
                <div className="flex gap-2 px-4 py-1 @3xl:grid @3xl:grid-cols-5">
                  {kinds.map((k) => (
                    <KindChip key={k.value} kind={k} selected={type === k.value} layoutId={`kind-${ringId}`} hint={DEFAULT_ASPECT[k.value] ?? "9:16"} onSelect={() => pickKind(k.value)} />
                  ))}
                </div>
              </ScrollStrip>
            </Cell>

            <div className="grid gap-x-5 gap-y-4 @xl:grid-cols-2">
              <Cell label={t("Frame")}>
                <Segmented<Aspect>
                  aria-label={t("Frame")}
                  value={aspect}
                  onChange={setAspect}
                  options={[
                    { value: "9:16", label: <span className="mono flex items-center gap-1.5"><FrameGlyph w={8} h={14} />9:16</span>, title: t("Vertical — Shorts, Reels") },
                    { value: "16:9", label: <span className="mono flex items-center gap-1.5"><FrameGlyph w={14} h={8} />16:9</span>, title: t("Widescreen — YouTube, web") },
                    { value: "1:1", label: <span className="mono flex items-center gap-1.5"><FrameGlyph w={10} h={10} />1:1</span>, title: t("Square — feeds") },
                  ]}
                />
              </Cell>

              <Cell label={t("Languages")} hint={t("(★ = written first)")}>
                <div role="group" aria-label={t("Languages")} className="flex flex-wrap gap-1.5">
                  {Object.keys(LANG_NAMES).map((l) => {
                    const on = langs.includes(l);
                    const isPrimary = on && primary === l;
                    const canPick = on && langs.length > 1 && !isPrimary;
                    return (
                      <span key={l} className={clsx("mono inline-flex h-9 items-stretch overflow-hidden rounded-lg border text-xs font-medium transition-colors",
                        on ? "border-accent/60 bg-accent/10 text-ink" : "border-line bg-panel text-mute hover:border-dim/50 hover:bg-hover hover:text-ink")}>
                        <button type="button" aria-pressed={on} onClick={() => toggleLang(l)} onDoubleClick={() => on && setPrimary(l)}
                          title={t("{lang} — double-click to make primary", { lang: LANG_NAMES[l] })}
                          className="px-2.5 transition-transform active:scale-95">
                          {LANG_SHORT[l]}
                        </button>
                        {on && (canPick ? (
                          <button type="button" onClick={() => setPrimary(l)} aria-label={t("Write {lang} first", { lang: LANG_NAMES[l] })} title={t("Write {lang} first", { lang: LANG_NAMES[l] })}
                            className="grid w-7 place-items-center border-l border-accent/25 text-dim transition-colors hover:bg-accent/15 hover:text-accent-ink">
                            <Star className="size-3.5" />
                          </button>
                        ) : (
                          <span className={clsx("grid w-6 place-items-center", isPrimary ? "text-accent-ink" : "hidden")} aria-hidden>
                            <Star className="size-3.5 fill-current" />
                          </span>
                        ))}
                      </span>
                    );
                  })}
                </div>
              </Cell>

              <Cell label={t("Look")}>
                <Select value={style} onChange={(e) => setStyle(e.target.value)} aria-label={t("Look")}>
                  <option value="">{t("Let the Director decide")}</option>
                  {settings?.catalog.style_presets.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                </Select>
              </Cell>

              <Cell label={t("Quality")}>
                <Select value={quality} onChange={(e) => setQuality(e.target.value)} aria-label={t("Quality")}>
                  <option value="">{t("Team default")}</option>
                  {Object.entries(QUALITY_INFO).map(([k, v]) => <option key={k} value={k}>{qualityLabel[k] ?? v.label} · {v.price}</option>)}
                </Select>
              </Cell>
            </div>
          </div>

          {/* ── footer: autopilot + start ───────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line bg-raised/50 px-4 py-3">
            <div className="flex min-w-0 flex-1 basis-72 flex-wrap items-center gap-x-3 gap-y-1">
              <label htmlFor="ai-reach" className="text-sm font-medium">{t("How far should AI take it?")}</label>
              <Select id="ai-reach" value={autopilot} onChange={(e) => setAutopilot(e.target.value as typeof autopilot)} className="!w-auto min-w-[13rem] max-w-full">
                <option value="">{t("Step by step — I guide each step")}</option>
                <option value="script">{t("Write the script for me")}</option>
                <option value="storyboard">{t("Up to the storyboard (keyframes)")}</option>
                <option value="final">{t("The whole video")}</option>
              </Select>
              {autopilot && <span className="min-w-0 text-xs text-dim">{t("Autopilot · asks once for budget, stops for your approval at each milestone")}</span>}
            </div>
            <Button variant="primary" size="lg" loading={busy === "idea"} disabled={!!busy && busy !== "idea"} onClick={() => void create()} icon={<Wand2 className="size-4" />} className="w-full sm:w-auto sm:min-w-32">
              {t("Start")}
            </Button>
          </div>

          {/* ── bring your own script / full manual control ─────────────── */}
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
            <span className="min-w-0 flex-1 basis-52 text-xs text-mute">{t("Already have a script, or want to direct every shot yourself? No AI writing, no co-pilot.")}</span>
            <Button variant="outline" loading={busy === "import"} disabled={!!busy && busy !== "import"} icon={<FileText className="size-4" />} onClick={() => void create("import")}>
              {t("Import my script")}
            </Button>
            <Button variant="outline" loading={busy === "manual"} disabled={!!busy && busy !== "manual"} icon={<PenLine className="size-4" />} onClick={() => void create("manual")}>
              {t("Build shot by shot")}
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
});
