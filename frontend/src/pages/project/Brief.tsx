import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowRight, Check, Clapperboard, Eye, FileText, Layers, Mic, Rocket, Sparkles, Speech, Star, Target, Tv, Users, Wallet, Wand2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { defaultStops } from "../../components/AutopilotPanel";
import { useGenerate } from "../../components/Generate";
import { MissionLaunch } from "../../components/room/MissionLaunch";
import { Counter, Fact, FloatingSaveBar, RField, RoomHeader, RoomPage, SaveStatus, type SaveState } from "../../components/room/kit";
import { PronunciationTable, toPronDict, toPronRows, type PronRow } from "../../components/room/PronunciationTable";
import { radioKeys, useSaveShortcut } from "../../components/room/util";
import { TrendScout, type BriefField } from "../../components/room/TrendScout";
import { Outline, StatStrip, WorkPanel, Workspace, scrollToSection, type OutlineItem } from "../../components/room/workspace";
import { Button, Input, Meter, Select, Skeleton, Textarea, Toggle, Tooltip } from "../../components/ui";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { LANG_NAMES, LANG_SHORT, QUALITY_INFO, usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useSettings } from "../../lib/queries";
import type { Project, Trends } from "../../lib/types";
import { useProjectCtx } from "./context";

const FIELD_LABEL: Record<BriefField, string> = { tone: "Tone", notes: "Notes", key_message: "Key message" };

const ASPECTS = [
  { value: "9:16", label: "9:16 vertical", sub: "Shorts · Reels · Status", w: 15, h: 26 },
  { value: "16:9", label: "16:9 wide", sub: "YouTube · TV", w: 30, h: 17 },
  { value: "1:1", label: "1:1", sub: "Feed posts", w: 22, h: 22 },
] as const;
const LENGTHS = [15, 30, 60, 120, 300];
/** v3 field on the project payload (GET /api/projects/{id}); patched with the Brief. */
type ProjectV3 = Project & { pronunciations?: Record<string, string> | null };

export default function BriefPage() {
  const t = useT();
  const { project, eid, canEdit, canProduce, setEpisode } = useProjectCtx();
  const qc = useQueryClient();
  const { generate } = useGenerate();
  const { data: settings } = useSettings();
  const [params, setParams] = useSearchParams();
  const [p, setP] = useState<Project>(project);
  const [brief, setBrief] = useState<Record<string, any>>(project.brief || {});
  const [pron, setPron] = useState<PronRow[]>(() => toPronRows((project as ProjectV3).pronunciations));
  const [busy, setBusy] = useState("");
  const [episodes, setEpisodes] = useState(5);
  const [dirty, setDirty] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const dirtyRef = useRef(false);
  const lastId = useRef(project.id);

  // Pull server changes in, but never throw away unsaved local edits (e.g. when Trend scout updates the project).
  useEffect(() => {
    const switched = lastId.current !== project.id;
    lastId.current = project.id;
    if (dirtyRef.current && !switched) {
      setBrief((b) => ({ ...b, trends: project.brief?.trends ?? b.trends }));
      return;
    }
    dirtyRef.current = false;
    setDirty(false);
    setP(project);
    setBrief(project.brief || {});
    setPron(toPronRows((project as ProjectV3).pronunciations));
  }, [project.id, project.updated_at, JSON.stringify(project.brief?.trends ?? null)]);

  // Started from Home with "Make it for me": run to the chosen milestone, stopping for approval at each one before it.
  useEffect(() => {
    const want = params.get("autopilot");
    if (!want || !settings) return;
    setParams({}, { replace: true });
    const ms = settings.catalog.autopilot?.milestones ?? [];
    const target = ms.some((m) => m.id === want) ? want : "final";
    generate(eid, { action: "autopilot", through: target, pause_after: defaultStops(ms, target) },
      tr("Autopilot → {m}", { m: tr(ms.find((m) => m.id === target)?.label ?? target) }));
  }, [settings]);

  useEffect(() => {
    if (!justSaved) return;
    const id = window.setTimeout(() => setJustSaved(false), 2200);
    return () => window.clearTimeout(id);
  }, [justSaved]);

  const markDirty = () => { dirtyRef.current = true; setDirty(true); setJustSaved(false); };
  const set = (k: keyof Project, v: any) => { setP({ ...p, [k]: v }); markDirty(); };
  const setB = (k: string, v: any) => { setBrief((b) => ({ ...b, [k]: v })); markDirty(); };
  const setPronRows = (rows: PronRow[]) => { setPron(rows); markDirty(); };
  const narrator = brief.narrator || { provider: "gemini", voice_id: "Charon", style: "warm, clear storyteller" };

  const save = async () => {
    setBusy("save");
    try {
      const body: Record<string, any> = {
        concept: p.concept, aspect: p.aspect, languages: p.languages, primary_language: p.primary_language,
        quality_mode: p.quality_mode, agent_mode: p.agent_mode, brief, pronunciations: toPronDict(pron),
      };
      if (canProduce) {
        if (p.budget_cap_usd === null || Number.isNaN(p.budget_cap_usd)) body.clear_budget_cap = true;
        else body.budget_cap_usd = p.budget_cap_usd;
      }
      await api.patch(`/api/projects/${project.id}`, body);
      dirtyRef.current = false;
      setDirty(false);
      setJustSaved(true);
      qc.invalidateQueries({ queryKey: ["project", project.id] });
      toast.success(tr("Saved"));
    } catch { /* api toasts */ } finally { setBusy(""); }
  };

  const discard = () => {
    dirtyRef.current = false;
    setDirty(false);
    setP(project);
    setBrief(project.brief || {});
    setPron(toPronRows((project as ProjectV3).pronunciations));
  };

  useSaveShortcut(canEdit && dirty && busy !== "save", save);

  const aiBrief = async () => {
    setBusy("brief");
    try {
      await api.patch(`/api/projects/${project.id}`, { concept: p.concept });
      const b = await api.post<Record<string, any>>(`/api/projects/${project.id}/brief/generate`);
      setBrief(b);
      markDirty();
      qc.invalidateQueries({ queryKey: ["project", project.id] });
      toast.success(tr("Brief written"));
    } catch { /* api toasts */ } finally { setBusy(""); }
  };

  const planSeason = async () => {
    setBusy("arc");
    try {
      await api.post(`/api/projects/${project.id}/arc/generate`, { episodes });
      qc.invalidateQueries({ queryKey: ["project", project.id] });
      toast.success(tr("Season planned"));
    } catch { /* api toasts */ } finally { setBusy(""); }
  };

  const toggleLang = (l: string) => {
    const cur = p.languages;
    const next = cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l];
    if (!next.length || (l === p.primary_language && cur.includes(l))) return;
    set("languages", next);
  };

  const addToBrief = (field: BriefField, text: string) => {
    const cur = String(brief[field] || "").trim();
    if (cur.includes(text)) return;
    setB(field, cur ? `${cur.replace(/[;.]\s*$/, "")}; ${text}` : text);
    toast.success(tr("Added to {field} — save to keep it", { field: tr(FIELD_LABEL[field]).toLowerCase() }));
  };

  const ap = project.autopilot || {};
  const story = project.story || {};
  const state: SaveState = busy === "save" ? "saving" : dirty ? "dirty" : justSaved ? "saved" : "clean";
  const writing = busy === "brief";
  const seconds = Number(brief.duration_s) || 0;

  // ── completeness: the seven things every writer and agent reads ─────────────
  const has = (v: unknown) => String(v ?? "").trim().length > 0;
  const checks = [
    { key: "concept", label: t("Concept"), ok: has(p.concept), to: "sec-concept" },
    { key: "audience", label: t("Audience"), ok: has(brief.audience), to: "sec-audience" },
    { key: "platform", label: t("Platform"), ok: has(brief.platform), to: "sec-audience" },
    { key: "length", label: t("Length"), ok: seconds > 0, to: "sec-length" },
    { key: "cta", label: t("Call to action"), ok: has(brief.cta), to: "sec-length" },
    { key: "tone", label: t("Tone"), ok: has(brief.tone), to: "sec-tone" },
    { key: "key", label: t("Key message"), ok: has(brief.key_message), to: "sec-tone" },
  ];
  const done = checks.filter((c) => c.ok).length;
  const pct = Math.round((done / checks.length) * 100);
  const missing = checks.filter((c) => !c.ok);
  const complete = done === checks.length;
  const hasTrends = !!(brief.trends && ((brief.trends as Partial<Trends>).trends?.length || (brief.trends as Partial<Trends>).hook_patterns?.length));
  const arc = project.episodes.filter((e) => e.kind !== "cutdown");
  const cap = p.budget_cap_usd;
  const q = QUALITY_INFO[p.quality_mode];

  const outline: OutlineItem[] = [
    { id: "sec-concept", label: t("Concept"), state: checks[0].ok ? "done" : "todo" },
    { id: "sec-audience", label: t("Audience & platform"), state: checks[1].ok && checks[2].ok ? "done" : "todo" },
    { id: "sec-length", label: t("Length & CTA"), state: checks[3].ok && checks[4].ok ? "done" : "todo" },
    { id: "sec-tone", label: t("Tone & message"), state: checks[5].ok && checks[6].ok ? "done" : "todo" },
    { id: "trends", label: t("Trend scout"), state: hasTrends ? "done" : "none" },
    { id: "sec-format", label: t("Format & quality"), state: "done" },
    { id: "sec-narrator", label: t("Narrator voice"), state: "none" },
    { id: "sec-pron", label: t("Pronunciation"), state: "none", meta: pron.length || undefined },
    ...(project.type === "series" ? [{ id: "sec-season", label: t("Season plan"), state: (arc.length ? "done" : "todo") as OutlineItem["state"], meta: arc.length || undefined }] : []),
    { id: "autopilot", label: t("Autopilot"), state: "none", meta: ap.status === "running" ? "RUN" : ap.status === "paused" ? "WAIT" : undefined },
  ];

  return (
    <RoomPage width="wide">
      <RoomHeader icon={<FileText />} title={t("Brief")}
        description={t("The goal, audience and limits every writer and agent works from.")}
        status={canEdit ? <SaveStatus state={state} /> : <Fact icon={<Eye />}>{t("View only")}</Fact>}
        actions={canEdit && (
          <Button size="sm" variant="outline" icon={<Rocket className="size-3.5" />} onClick={() => scrollToSection("autopilot")}>{t("Autopilot")}</Button>
        )} />

      <StatStrip index={1} className="mb-6" cells={[
        {
          key: "complete", label: t("Brief completeness"), value: pct, unit: "%", tone: complete ? "ok" : "accent", wide: true,
          sub: complete ? <span className="text-ok">{t("Ready for the writers")}</span> : (
            <span className="flex flex-wrap items-center gap-1">
              <AlertTriangle aria-hidden className="size-3 text-warn" />
              {missing.slice(0, 3).map((m) => (
                <button key={m.key} type="button" onClick={() => scrollToSection(m.to)}
                  className="rounded border border-line bg-raised/60 px-1 py-px text-2xs text-mute transition-colors hover:border-accent/50 hover:text-ink">{m.label}</button>
              ))}
              {missing.length > 3 && <span className="mono">+{missing.length - 3}</span>}
            </span>
          ),
          visual: <Meter filled={done} total={checks.length} tone={complete ? "ok" : "accent"} />,
        },
        { key: "runtime", label: t("Runtime"), value: seconds || "—", unit: seconds ? "s" : undefined, sub: seconds >= 60 ? `≈ ${formatLength(seconds, t)}` : p.aspect },
        { key: "langs", label: t("Languages"), value: p.languages.length, sub: p.languages.map((l) => LANG_SHORT[l] ?? l).join(" · ") },
        { key: "quality", label: t("Video quality"), value: q ? t(q.label) : p.quality_mode, sub: q ? <span className="mono text-money">{q.price}</span> : undefined },
        { key: "spend", label: t("Spend"), value: usd(project.spent_usd), tone: "money", sub: cap != null ? t("of {cap} cap", { cap: usd(cap) }) : t("no cap") },
      ]} />

      <Workspace rail={<Outline title={t("Brief outline")} summary={`${done}/${checks.length}`} items={outline} />}>
        {/* ── the brief itself ───────────────────────────────────────────────── */}
        <div className="relative space-y-6" aria-busy={writing || undefined}>
          <WorkPanel id="sec-concept" index={2} n={1} kicker={t("Input")} icon={<Wand2 />} title={t("Concept")}
            description={t("One or two sentences. Everything else is written from this.")}>
            <div className="space-y-3">
              <Textarea id="brief-concept" aria-label={t("Concept")} value={p.concept} onChange={(e) => set("concept", e.target.value)} disabled={!canEdit} rows={3}
                placeholder={t("A young temple priest discovers that the brass lamp moves by itself every night…")} />
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                {canEdit ? (
                  <Button size="sm" onClick={aiBrief} loading={writing} disabled={!p.concept.trim()} icon={<Sparkles className="size-3.5 text-ai" />}>{t("AI fill from concept")}</Button>
                ) : <span />}
                <Counter value={p.concept.length} />
              </div>
              {canEdit && <p className="-mt-1 text-2xs leading-snug text-dim">{t("Writes audience, tone, platform, length, key message and CTA.")}</p>}
            </div>
          </WorkPanel>

          <div className="grid gap-6 @3xl:grid-cols-2">
            <WorkPanel id="sec-audience" index={3} n={2} kicker={t("Audience")} icon={<Users />} title={t("Audience & platform")}
              description={t("Who it is for and where it will play. Drives pacing, hooks and framing.")}>
              <div className="space-y-4">
                <RField label={t("Audience")} htmlFor="brief-audience">
                  <Input id="brief-audience" value={brief.audience || ""} onChange={(e) => setB("audience", e.target.value)} disabled={!canEdit}
                    placeholder={t("Indian audience, 18–45, mobile-first")} />
                </RField>
                <RField label={t("Platform")} htmlFor="brief-platform">
                  <Input id="brief-platform" value={brief.platform || ""} onChange={(e) => setB("platform", e.target.value)} disabled={!canEdit}
                    placeholder={t("YouTube Shorts / Instagram Reels")} />
                </RField>
              </div>
            </WorkPanel>

            <WorkPanel id="sec-length" index={4} n={3} kicker={t("Runtime")} icon={<Target />} title={t("Length & call to action")}
              description={t("How long it runs, and what you want people to do next.")}>
              <div className="space-y-4">
                <RField label={t("Target length (seconds)")} htmlFor="brief-length" hint={seconds >= 60 && !LENGTHS.includes(seconds) ? `≈ ${formatLength(seconds, t)}` : undefined}>
                  <div className="space-y-2">
                    <Input id="brief-length" type="number" min={8} value={brief.duration_s || ""} onChange={(e) => setB("duration_s", Number(e.target.value))} disabled={!canEdit} className="mono" />
                    <div className="flex flex-wrap gap-1" role="group" aria-label={t("Common lengths")}>
                      {LENGTHS.map((s) => (
                        <button key={s} type="button" disabled={!canEdit} onClick={() => setB("duration_s", s)} aria-pressed={seconds === s}
                          className={cn("mono h-6 rounded-md border px-2 text-2xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                            seconds === s ? "border-accent/50 bg-accent/12 text-accent-ink" : "border-line text-mute hover:border-dim/50 hover:text-ink")}>
                          {formatLength(s, t)}
                        </button>
                      ))}
                    </div>
                  </div>
                </RField>
                <RField label={t("Call to action")} htmlFor="brief-cta" right={<Counter value={String(brief.cta || "").length} limit={60} />}>
                  <Input id="brief-cta" value={brief.cta || ""} onChange={(e) => setB("cta", e.target.value)} disabled={!canEdit} placeholder={t("Follow for part 2")} />
                </RField>
              </div>
            </WorkPanel>
          </div>

          <WorkPanel id="sec-tone" index={5} n={4} kicker={t("Voice")} icon={<Speech />} title={t("Tone & key message")}
            description={t("How it should feel, and the one thing the viewer must take away.")}>
            <div className="grid gap-x-6 gap-y-4 @2xl:grid-cols-2">
              <RField label={t("Tone")} htmlFor="brief-tone">
                <Input id="brief-tone" value={brief.tone || ""} onChange={(e) => setB("tone", e.target.value)} disabled={!canEdit} placeholder={t("emotional, suspenseful")} />
              </RField>
              <RField label={t("Key message")} htmlFor="brief-key" right={<Counter value={String(brief.key_message || "").length} limit={140} />}
                hint={t("Short enough to say in one breath.")}>
                <Textarea id="brief-key" rows={2} value={brief.key_message || ""} onChange={(e) => setB("key_message", e.target.value)} disabled={!canEdit} className="min-h-0" />
              </RField>
              <RField className="@2xl:col-span-2" label={t("Notes")} htmlFor="brief-notes" right={<Counter value={String(brief.notes || "").length} />}>
                <Textarea id="brief-notes" rows={2} value={brief.notes || ""} onChange={(e) => setB("notes", e.target.value)} disabled={!canEdit} className="min-h-0"
                  placeholder={t("Anything the writers should know: references, taboos, must-have moments.")} />
              </RField>
            </div>
          </WorkPanel>

          {/* shimmer while the AI is writing the brief */}
          <AnimatePresence>
            {writing && (
              <motion.div key="writing" aria-hidden initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
                className="pointer-events-none absolute -inset-1 z-[2] !m-0 overflow-hidden rounded-xl bg-bg/55 backdrop-blur-[1px]">
                <div className="shimmer absolute inset-0" />
                <div className="absolute inset-x-0 top-8 flex justify-center">
                  <span className="inline-flex items-center gap-2 rounded-full border border-ai/30 bg-raised px-3 py-1.5 text-xs font-medium shadow-pop">
                    <Sparkles className="size-3.5 animate-pulse text-ai" />{t("Writing your brief…")}
                  </span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <TrendScout index={6} n={5} trends={brief.trends as Partial<Trends> | undefined} brief={brief} onAdd={addToBrief}
          onScouted={(tr_) => setBrief((b) => ({ ...b, trends: tr_ }))} />

        {/* ── format, languages, quality ─────────────────────────────────────── */}
        <WorkPanel id="sec-format" index={7} n={6} kicker={t("Format")} icon={<Clapperboard />} title={t("Format, languages & quality")}
          description={t("Applies to every episode. Change quality per shot later in the Storyboard.")} bodyClassName="space-y-6">
          <FieldGroup label={t("Aspect")}>
            <div className="grid gap-2 @lg:grid-cols-3" role="radiogroup" aria-label={t("Aspect")} onKeyDown={radioKeys}>
              {ASPECTS.map((a) => {
                const on = p.aspect === a.value;
                return (
                  <button key={a.value} type="button" role="radio" aria-checked={on} disabled={!canEdit} onClick={() => canEdit && set("aspect", a.value)}
                    className={cn("flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed",
                      on ? "border-accent/60 bg-accent/10" : "border-line hover:border-dim/60 hover:bg-hover/50")}>
                    <span className="grid h-9 w-10 shrink-0 place-items-center">
                      <span className={cn("rounded-[3px] border-2 transition-colors", on ? "border-accent bg-accent/20 shadow-[0_0_10px_-2px_var(--color-accent)]" : "border-dim/60")} style={{ width: a.w, height: a.h }} />
                    </span>
                    <span className="min-w-0">
                      <span className="mono block text-sm font-medium">{a.value}</span>
                      <span className="block truncate text-2xs text-dim">{t(a.sub)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </FieldGroup>

          <FieldGroup label={t("Languages (click ★ to make primary)")}>
            <div className="flex flex-wrap gap-2">
              {Object.keys(LANG_NAMES).map((l) => {
                const on = p.languages.includes(l);
                const primary = p.primary_language === l;
                return (
                  <div key={l} className={cn("flex items-stretch overflow-hidden rounded-lg border transition-colors", on ? "border-accent/60 bg-accent/10" : "border-line hover:border-dim/60")}>
                    <button type="button" aria-pressed={on} disabled={!canEdit} onClick={() => canEdit && toggleLang(l)} title={LANG_NAMES[l]}
                      className="flex items-center gap-2 px-2.5 py-1.5 text-left disabled:cursor-not-allowed">
                      <span className={cn("grid size-4 shrink-0 place-items-center rounded border transition-colors", on ? "border-accent bg-accent text-[color:var(--on-accent)]" : "border-dim/50")}>
                        {on && <Check className="size-3" strokeWidth={3.25} />}
                      </span>
                      <span className={cn("mono text-sm font-semibold", !on && "text-mute")}>{LANG_SHORT[l]}</span>
                      <span className="hidden text-xs text-mute @md:inline">{LANG_NAMES[l]}</span>
                    </button>
                    {on && (
                      <Tooltip content={primary ? t("Primary language") : t("Make primary")}>
                        <button type="button" disabled={!canEdit || primary} onClick={() => canEdit && set("primary_language", l)} aria-label={primary ? t("Primary language") : t("Make primary")}
                          aria-pressed={primary}
                          className={cn("grid w-8 place-items-center border-l border-accent/25 transition-colors disabled:cursor-default", primary ? "text-accent-ink" : "text-dim hover:bg-accent/10 hover:text-ink")}>
                          <Star className={cn("size-3.5", primary && "fill-current")} />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                );
              })}
            </div>
          </FieldGroup>

          <FieldGroup label={t("Video quality")}>
            <div className="grid gap-2 @lg:grid-cols-3" role="radiogroup" aria-label={t("Video quality")} onKeyDown={radioKeys}>
              {Object.entries(QUALITY_INFO).map(([k, v], i, all) => {
                const on = p.quality_mode === k;
                return (
                  <button key={k} type="button" role="radio" aria-checked={on} disabled={!canEdit} onClick={() => set("quality_mode", k)}
                    className={cn("relative rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed", on ? "border-accent/60 bg-accent/10" : "border-line hover:border-dim/60 hover:bg-hover/50")}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <span className={cn("grid size-4 shrink-0 place-items-center rounded-full border transition-colors", on ? "border-accent bg-accent text-[color:var(--on-accent)]" : "border-dim/50")}>
                          {on && <Check className="size-3" strokeWidth={3.25} />}
                        </span>
                        {t(v.label)}
                      </span>
                      <span className="mono text-xs font-medium text-money">{v.price}</span>
                    </div>
                    <Meter filled={i + 1} total={all.length} tone={on ? "accent" : "neutral"} className="mt-2.5 max-w-24" />
                    <p className="mt-2 text-xs leading-snug text-mute">{t(v.desc)}</p>
                  </button>
                );
              })}
            </div>
          </FieldGroup>

          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-t border-line pt-5">
            <div className="space-y-1">
              <Toggle checked={p.agent_mode === "autopilot"} onChange={(v) => set("agent_mode", v ? "autopilot" : "copilot")} disabled={!canEdit}
                label={<span>{t("Director chat approvals:")} <b>{p.agent_mode === "autopilot" ? t("Auto-approve within budget") : t("Ask me first")}</b></span>} />
              <p className="max-w-xs pl-[3.125rem] text-2xs leading-snug text-dim">
                {p.agent_mode === "autopilot"
                  ? t("When you ask the Director for something paid, it starts right away (within the budget).")
                  : t("When you ask the Director for something paid, it shows the cost and waits for your OK.")}
              </p>
            </div>
            <RField label={t("Project budget cap ($)")} htmlFor="brief-budget" hint={canProduce ? t("Blank = no project cap") : t("Producers can change this")}>
              <div className="relative w-40">
                <Wallet aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-money" />
                <Input id="brief-budget" type="number" min={0} step="0.5" className="mono pl-8 text-money" disabled={!canProduce} placeholder={t("No cap")}
                  value={p.budget_cap_usd ?? ""} onChange={(e) => set("budget_cap_usd", e.target.value === "" ? null : Number(e.target.value))} />
              </div>
            </RField>
          </div>
        </WorkPanel>

        {/* ── narrator ───────────────────────────────────────────────────────── */}
        <WorkPanel id="sec-narrator" index={8} n={7} kicker={t("Voice-over")} icon={<Mic />} title={t("Narrator voice")}
          description={t("Used for voice-over lines (explainers, devotional stories, ads). Character voices live in the Bible.")}>
          <div className="grid gap-4 @lg:grid-cols-3">
            <RField label={t("Provider")} htmlFor="narr-provider">
              <Select id="narr-provider" value={narrator.provider} disabled={!canEdit} onChange={(e) => setB("narrator", { ...narrator, provider: e.target.value })}>
                <option value="gemini">Gemini TTS</option><option value="elevenlabs">ElevenLabs</option><option value="sarvam">{t("Sarvam (Indian)")}</option>
              </Select>
            </RField>
            <RField label={t("Voice")} htmlFor="narr-voice">
              {narrator.provider === "elevenlabs" ? (
                <Input id="narr-voice" value={narrator.voice_id} disabled={!canEdit} placeholder={t("ElevenLabs voice ID")} onChange={(e) => setB("narrator", { ...narrator, voice_id: e.target.value })} />
              ) : !settings ? (
                <Skeleton className="h-9 w-full" />
              ) : narrator.provider === "sarvam" ? (
                <Select id="narr-voice" value={narrator.voice_id} disabled={!canEdit} onChange={(e) => setB("narrator", { ...narrator, voice_id: e.target.value })}>
                  {Object.entries(settings.catalog.sarvam_speakers ?? {}).flatMap(([g, l]) => l.map((s) => <option key={s} value={s}>{s} ({g})</option>))}
                </Select>
              ) : (
                <Select id="narr-voice" value={narrator.voice_id} disabled={!canEdit} onChange={(e) => setB("narrator", { ...narrator, voice_id: e.target.value })}>
                  {settings.catalog.gemini_voices.map(([n, d]) => <option key={n} value={n}>{n} — {d}</option>)}
                </Select>
              )}
            </RField>
            <RField label={t("Delivery style")} htmlFor="narr-style">
              <Input id="narr-style" value={narrator.style} disabled={!canEdit} onChange={(e) => setB("narrator", { ...narrator, style: e.target.value })} />
            </RField>
          </div>
        </WorkPanel>

        {/* ── pronunciation dictionary ───────────────────────────────────────── */}
        <WorkPanel id="sec-pron" index={9} n={8} kicker={t("Dictionary")} icon={<Speech />} title={t("Pronunciation")}
          badge={pron.length > 0 ? <span className="mono rounded bg-raised px-1.5 text-2xs font-medium text-dim">{pron.length}</span> : undefined}
          description={t("How names and special words should be said. Applied before every voice line, narrator and characters alike, in every language.")}>
          <PronunciationTable rows={pron} onChange={setPronRows} disabled={!canEdit} />
          <p className="mt-3 text-2xs leading-snug text-dim">
            {t("Write it the way you would spell it out for a newsreader (“Shree Raa-ma”). Each character also has its own name pronunciation in the Bible.")}
          </p>
        </WorkPanel>

        {/* ── season plan ────────────────────────────────────────────────────── */}
        {project.type === "series" && (
          <WorkPanel id="sec-season" index={10} n={9} kicker={t("Season")} icon={<Tv />} title={t("Season plan")} description={t("Plan the arc once; pick an episode to work on it.")}
            actions={canEdit && (
              <div className="flex items-center gap-2">
                <Input type="number" min={1} max={30} className="mono h-8! w-20!" aria-label={t("Episodes")} value={episodes} onChange={(e) => setEpisodes(Number(e.target.value))} />
                <Button size="sm" onClick={planSeason} loading={busy === "arc"} icon={<Sparkles className="size-3.5 text-ai" />}>{t("Plan season")}</Button>
              </div>
            )}>
            {(story.logline || story.arc) && (
              <dl className="mb-4 grid gap-3 rounded-lg border border-line bg-bg/40 p-3.5 text-sm @2xl:grid-cols-2">
                {story.logline && <div><dt className="eyebrow">{t("Logline")}</dt><dd className="mt-1.5">{story.logline}</dd></div>}
                {story.arc && <div><dt className="eyebrow">{t("Arc")}</dt><dd className="mt-1.5 text-mute">{story.arc}</dd></div>}
              </dl>
            )}
            <ol className="overflow-hidden rounded-lg border border-line">
              {arc.map((e) => {
                const current = e.id === eid;
                return (
                  <li key={e.id} className="border-b border-line last:border-b-0">
                    <button type="button" onClick={() => setEpisode(e.id)} aria-current={current ? "true" : undefined}
                      className={cn("relative flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-hover/50", current && "bg-accent/6")}>
                      {current && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent shadow-[0_0_10px_var(--color-accent)]" />}
                      <span className="mono mt-0.5 shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-2xs font-semibold text-mute">E{String(e.number).padStart(2, "0")}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{e.title}</span>
                        {e.outline && <span className="mt-0.5 line-clamp-2 block text-xs text-mute">{e.outline}</span>}
                      </span>
                      {current && <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-2xs font-semibold text-accent-ink"><Check className="size-3" strokeWidth={3} />{t("Working on")}</span>}
                    </button>
                  </li>
                );
              })}
            </ol>
          </WorkPanel>
        )}

        {/* ── launch ─────────────────────────────────────────────────────────── */}
        <MissionLaunch project={project} eid={eid} canEdit={canEdit} index={11} />

        <WorkPanel index={12} n={11} kicker={t("Cost guardrails")} tone="money" icon={<Layers />} title={t("How costs stay low")}>
          <ul className="grid gap-x-6 gap-y-3 text-xs leading-relaxed text-mute @2xl:grid-cols-2">
            {[
              t("Keyframes (a few cents) are approved before any video."),
              t("The animatic previews timing with voices + music — no video cost."),
              t("Saver mode animates approved keyframes with Veo 3.1 Lite."),
              t("Dubbing reuses the same video; only voice + lip-sync are redone."),
            ].map((line) => (
              <li key={line} className="flex gap-2.5">
                <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-ok/12 text-ok"><Check className="size-2.5" strokeWidth={3.5} /></span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 flex items-center gap-1.5 text-2xs text-dim"><ArrowRight aria-hidden className="size-3" />{t("Budget cap and approvals are set under Format, languages & quality.")}</p>
        </WorkPanel>
      </Workspace>

      <FloatingSaveBar show={canEdit && (dirty || busy === "save")} state={state} saving={busy === "save"} disabled={writing} onSave={save} onDiscard={discard} />
    </RoomPage>
  );
}

/** Like <Field>, but a plain div: a <label> would forward clicks on its text to the first button inside. */
function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <span className="eyebrow block">{label}</span>
      {children}
    </div>
  );
}

function formatLength(s: number, t: (k: string, v?: Record<string, string | number>) => string) {
  if (s < 60) return t("{n}s", { n: s });
  const m = s / 60;
  return Number.isInteger(m) ? t("{n} min", { n: m }) : t("{m} min {s}s", { m: Math.floor(m), s: s % 60 });
}
