import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, Clapperboard, Eye, FileText, Mic, Rocket, Sparkles, Star, Tv, Wallet } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { AutopilotPanel, defaultStops } from "../../components/AutopilotPanel";
import { useGenerate } from "../../components/Generate";
import { Counter, Fact, FloatingSaveBar, RField, RoomHeader, RoomPage, SaveStatus, SectionCard, type SaveState } from "../../components/room/kit";
import { radioKeys, useSaveShortcut } from "../../components/room/util";
import { TrendScout, type BriefField } from "../../components/room/TrendScout";
import { Button, Field, Input, Select, Skeleton, Textarea, Toggle, Tooltip, rise } from "../../components/ui";
import { api } from "../../lib/api";
import { LANG_NAMES, LANG_SHORT, QUALITY_INFO } from "../../lib/format";
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

export default function BriefPage() {
  const t = useT();
  const { project, eid, canEdit, canProduce, setEpisode } = useProjectCtx();
  const qc = useQueryClient();
  const { generate } = useGenerate();
  const { data: settings } = useSettings();
  const [params, setParams] = useSearchParams();
  const [p, setP] = useState<Project>(project);
  const [brief, setBrief] = useState<Record<string, any>>(project.brief || {});
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
  const narrator = brief.narrator || { provider: "gemini", voice_id: "Charon", style: "warm, clear storyteller" };

  const save = async () => {
    setBusy("save");
    try {
      const body: Record<string, any> = {
        concept: p.concept, aspect: p.aspect, languages: p.languages, primary_language: p.primary_language,
        quality_mode: p.quality_mode, agent_mode: p.agent_mode, brief,
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

  return (
    <RoomPage width="wide">
      <RoomHeader icon={<FileText />} title={t("Brief")}
        description={t("The goal, audience and limits every writer and agent works from.")}
        status={canEdit ? <SaveStatus state={state} /> : <Fact icon={<Eye />}>{t("View only")}</Fact>}
        actions={canEdit && (
          <Button size="sm" variant="outline" className="@4xl:hidden" icon={<Rocket className="size-3.5" />}
            onClick={() => document.getElementById("autopilot")?.scrollIntoView({ behavior: "smooth", block: "start" })}>{t("Autopilot")}</Button>
        )} />

      <div className="flex flex-col gap-5 @4xl:grid @4xl:grid-cols-[minmax(0,1fr)_320px] @4xl:items-start">
        <div className="min-w-0 space-y-5">
          {/* ── the brief itself ─────────────────────────────────────────────── */}
          <div {...rise(1)} className={clsx("@container relative divide-y divide-line rounded-xl border border-line bg-panel", rise(1).className)}>
            <FormSection n={1} title={t("Concept")} description={t("One or two sentences. Everything else is written from this.")}>
              <Textarea id="brief-concept" aria-label={t("Concept")} value={p.concept} onChange={(e) => set("concept", e.target.value)} disabled={!canEdit} rows={3}
                placeholder={t("A young temple priest discovers that the brass lamp moves by itself every night…")} />
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                {canEdit ? (
                  <Button size="sm" onClick={aiBrief} loading={writing} disabled={!p.concept.trim()} icon={<Sparkles className="size-3.5" />}>{t("AI fill from concept")}</Button>
                ) : <span />}
                <Counter value={p.concept.length} />
              </div>
              {canEdit && <p className="-mt-2 text-2xs leading-snug text-dim">{t("Writes audience, tone, platform, length, key message and CTA.")}</p>}
            </FormSection>

            <FormSection n={2} title={t("Audience & platform")} description={t("Who it is for and where it will play. Drives pacing, hooks and framing.")}>
              <div className="grid gap-4 @3xl:grid-cols-2">
                <RField label={t("Audience")} htmlFor="brief-audience">
                  <Input id="brief-audience" value={brief.audience || ""} onChange={(e) => setB("audience", e.target.value)} disabled={!canEdit}
                    placeholder={t("Indian audience, 18–45, mobile-first")} />
                </RField>
                <RField label={t("Platform")} htmlFor="brief-platform">
                  <Input id="brief-platform" value={brief.platform || ""} onChange={(e) => setB("platform", e.target.value)} disabled={!canEdit}
                    placeholder={t("YouTube Shorts / Instagram Reels")} />
                </RField>
              </div>
            </FormSection>

            <FormSection n={3} title={t("Tone & key message")} description={t("How it should feel, and the one thing the viewer must take away.")}>
              <RField label={t("Tone")} htmlFor="brief-tone">
                <Input id="brief-tone" value={brief.tone || ""} onChange={(e) => setB("tone", e.target.value)} disabled={!canEdit} placeholder={t("emotional, suspenseful")} />
              </RField>
              <RField label={t("Key message")} htmlFor="brief-key" right={<Counter value={String(brief.key_message || "").length} limit={140} />}
                hint={t("Short enough to say in one breath.")}>
                <Textarea id="brief-key" rows={2} value={brief.key_message || ""} onChange={(e) => setB("key_message", e.target.value)} disabled={!canEdit} className="min-h-0" />
              </RField>
              <RField label={t("Notes")} htmlFor="brief-notes" right={<Counter value={String(brief.notes || "").length} />}>
                <Textarea id="brief-notes" rows={2} value={brief.notes || ""} onChange={(e) => setB("notes", e.target.value)} disabled={!canEdit} className="min-h-0"
                  placeholder={t("Anything the writers should know: references, taboos, must-have moments.")} />
              </RField>
            </FormSection>

            <FormSection n={4} title={t("Length & call to action")} description={t("How long it runs, and what you want people to do next.")}>
              <div className="grid gap-4 @3xl:grid-cols-2">
                <RField label={t("Target length (seconds)")} htmlFor="brief-length" hint={seconds >= 60 && !LENGTHS.includes(seconds) ? `≈ ${formatLength(seconds, t)}` : undefined}>
                  <div className="space-y-2">
                    <Input id="brief-length" type="number" min={8} value={brief.duration_s || ""} onChange={(e) => setB("duration_s", Number(e.target.value))} disabled={!canEdit} />
                    <div className="flex flex-wrap gap-1" role="group" aria-label={t("Common lengths")}>
                      {LENGTHS.map((s) => (
                        <button key={s} type="button" disabled={!canEdit} onClick={() => setB("duration_s", s)} aria-pressed={seconds === s}
                          className={clsx("h-6 rounded-md border px-2 text-2xs font-medium tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-60",
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
            </FormSection>

            {/* shimmer while the AI is writing the brief */}
            <AnimatePresence>
              {writing && (
                <motion.div key="writing" aria-hidden initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
                  className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl bg-panel/60 backdrop-blur-[1px]">
                  <div className="shimmer absolute inset-0" />
                  <div className="absolute inset-x-0 top-6 flex justify-center">
                    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-raised px-3 py-1.5 text-xs font-medium shadow-pop">
                      <Sparkles className="size-3.5 animate-pulse text-accent-ink" />{t("Writing your brief…")}
                    </span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <TrendScout index={2} trends={brief.trends as Partial<Trends> | undefined} brief={brief} onAdd={addToBrief}
            onScouted={(tr_) => setBrief((b) => ({ ...b, trends: tr_ }))} />

          {/* ── format, languages, quality ───────────────────────────────────── */}
          <SectionCard index={3} icon={<Clapperboard />} title={t("Format, languages & quality")}
            description={t("Applies to every episode. Change quality per shot later in the Storyboard.")} bodyClassName="space-y-6">
            <FieldGroup label={t("Aspect")}>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("Aspect")} onKeyDown={radioKeys}>
                {ASPECTS.map((a) => {
                  const on = p.aspect === a.value;
                  return (
                    <button key={a.value} type="button" role="radio" aria-checked={on} disabled={!canEdit} onClick={() => canEdit && set("aspect", a.value)}
                      className={clsx("flex min-w-[8.5rem] items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed",
                        on ? "border-accent/60 bg-accent/10" : "border-line hover:border-dim/60 hover:bg-hover/50")}>
                      <span className="grid h-8 w-9 shrink-0 place-items-center">
                        <span className={clsx("rounded-[3px] border-2 transition-colors", on ? "border-accent bg-accent/20" : "border-dim/60")} style={{ width: a.w, height: a.h }} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{t(a.label)}</span>
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
                    <div key={l} className={clsx("flex items-stretch overflow-hidden rounded-lg border transition-colors", on ? "border-accent/60 bg-accent/10" : "border-line hover:border-dim/60")}>
                      <button type="button" aria-pressed={on} disabled={!canEdit} onClick={() => canEdit && toggleLang(l)} title={LANG_NAMES[l]}
                        className="flex items-center gap-2 px-2.5 py-1.5 text-left disabled:cursor-not-allowed">
                        <span className={clsx("grid size-4 shrink-0 place-items-center rounded border transition-colors", on ? "border-accent bg-accent text-black" : "border-dim/50")}>
                          {on && <Check className="size-3" strokeWidth={3.25} />}
                        </span>
                        <span className={clsx("text-sm font-semibold", !on && "text-mute")}>{LANG_SHORT[l]}</span>
                        <span className="hidden text-xs text-mute @md:inline">{LANG_NAMES[l]}</span>
                      </button>
                      {on && (
                        <Tooltip content={primary ? t("Primary language") : t("Make primary")}>
                          <button type="button" disabled={!canEdit || primary} onClick={() => canEdit && set("primary_language", l)} aria-label={primary ? t("Primary language") : t("Make primary")}
                            aria-pressed={primary}
                            className={clsx("grid w-8 place-items-center border-l border-accent/25 transition-colors disabled:cursor-default", primary ? "text-accent-ink" : "text-dim hover:bg-accent/10 hover:text-ink")}>
                            <Star className={clsx("size-3.5", primary && "fill-current")} />
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
                {Object.entries(QUALITY_INFO).map(([k, v]) => {
                  const on = p.quality_mode === k;
                  return (
                    <button key={k} type="button" role="radio" aria-checked={on} disabled={!canEdit} onClick={() => set("quality_mode", k)}
                      className={clsx("relative rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed", on ? "border-accent/60 bg-accent/10" : "border-line hover:border-dim/60 hover:bg-hover/50")}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <span className={clsx("grid size-4 shrink-0 place-items-center rounded-full border transition-colors", on ? "border-accent bg-accent text-black" : "border-dim/50")}>
                            {on && <Check className="size-3" strokeWidth={3.25} />}
                          </span>
                          {t(v.label)}
                        </span>
                        <span className="text-xs font-medium tabular-nums text-accent-ink">{v.price}</span>
                      </div>
                      <p className="mt-1.5 text-xs leading-snug text-mute">{t(v.desc)}</p>
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
                  <Wallet aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-dim" />
                  <Input id="brief-budget" type="number" min={0} step="0.5" className="pl-8" disabled={!canProduce} placeholder={t("No cap")}
                    value={p.budget_cap_usd ?? ""} onChange={(e) => set("budget_cap_usd", e.target.value === "" ? null : Number(e.target.value))} />
                </div>
              </RField>
            </div>
          </SectionCard>

          {/* ── narrator ─────────────────────────────────────────────────────── */}
          <SectionCard index={4} icon={<Mic />} title={t("Narrator voice")}
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
          </SectionCard>

          {/* ── season plan ──────────────────────────────────────────────────── */}
          {project.type === "series" && (
            <SectionCard index={5} icon={<Tv />} title={t("Season plan")} description={t("Plan the arc once; pick an episode to work on it.")}
              actions={canEdit && (
                <div className="flex items-center gap-2">
                  <Input type="number" min={1} max={30} className="h-8! w-20!" aria-label={t("Episodes")} value={episodes} onChange={(e) => setEpisodes(Number(e.target.value))} />
                  <Button size="sm" onClick={planSeason} loading={busy === "arc"} icon={<Sparkles className="size-3.5" />}>{t("Plan season")}</Button>
                </div>
              )}>
              {(story.logline || story.arc) && (
                <dl className="mb-4 space-y-2 rounded-lg border border-line bg-bg/40 p-3 text-sm">
                  {story.logline && <div><dt className="text-2xs font-semibold uppercase tracking-wide text-dim">{t("Logline")}</dt><dd className="mt-0.5">{story.logline}</dd></div>}
                  {story.arc && <div><dt className="text-2xs font-semibold uppercase tracking-wide text-dim">{t("Arc")}</dt><dd className="mt-0.5 text-mute">{story.arc}</dd></div>}
                </dl>
              )}
              <ol className="space-y-1.5">
                {project.episodes.filter((e) => e.kind !== "cutdown").map((e) => {
                  const current = e.id === eid;
                  return (
                    <li key={e.id}>
                      <button type="button" onClick={() => setEpisode(e.id)} aria-current={current ? "true" : undefined}
                        className={clsx("flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:border-accent/50",
                          current ? "border-accent/60 bg-accent/8" : "border-line")}>
                        <span className="mt-0.5 shrink-0 rounded-md bg-raised px-1.5 py-0.5 font-mono text-2xs font-semibold text-mute">E{String(e.number).padStart(2, "0")}</span>
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
            </SectionCard>
          )}
        </div>

        {/* ── side rail: autopilot + cost notes ───────────────────────────────── */}
        <aside className="min-w-0 space-y-5 @4xl:[@media(min-height:840px)]:sticky @4xl:[@media(min-height:840px)]:top-4">
          <div {...rise(2)}>
            <AutopilotPanel project={project} eid={eid} canEdit={canEdit} />
          </div>

          <div {...rise(3)} className={clsx("rounded-xl border border-line bg-panel p-5", rise(3).className)}>
            <h2 className="mb-3 text-sm font-semibold tracking-tight">{t("How costs stay low")}</h2>
            <ul className="space-y-2.5 text-xs leading-relaxed text-mute">
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
          </div>
        </aside>
      </div>

      <FloatingSaveBar show={canEdit && (dirty || busy === "save")} state={state} saving={busy === "save"} disabled={writing} onSave={save} onDiscard={discard} />
    </RoomPage>
  );
}

/** One titled block of the brief: heading + purpose on the left (wide cards), fields on the right. */
function FormSection({ n, title, description, children }: { n: number; title: string; description: string; children: ReactNode }) {
  return (
    <section className="grid gap-x-8 gap-y-4 px-4 py-5 @md:px-5 @2xl:grid-cols-[13.5rem_minmax(0,1fr)]">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span className="grid size-5 shrink-0 place-items-center rounded-md bg-raised text-2xs font-semibold tabular-nums text-mute">{n}</span>
          <span className="min-w-0">{title}</span>
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-mute @2xl:pr-2">{description}</p>
      </div>
      <div className="min-w-0 space-y-4">{children}</div>
    </section>
  );
}

/** Like <Field>, but a plain div: a <label> would forward clicks on its text to the first button inside. */
function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <span className="block text-xs font-medium text-mute">{label}</span>
      {children}
    </div>
  );
}

function formatLength(s: number, t: (k: string, v?: Record<string, string | number>) => string) {
  if (s < 60) return t("{n}s", { n: s });
  const m = s / 60;
  return Number.isInteger(m) ? t("{n} min", { n: m }) : t("{m} min {s}s", { m: Math.floor(m), s: s % 60 });
}

