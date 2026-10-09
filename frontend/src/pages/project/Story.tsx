import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight, AtSign, BookOpen, Brain, Gauge, Headphones, History, Languages, LayoutGrid, ListChecks, MessagesSquare, Save, ScanSearch, ScrollText,
  Sparkles, SquareKanban, Users, X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ContinuityPanel } from "../../components/room/Continuity";
import { CriticPanel } from "../../components/room/Critic";
import { HookSection } from "../../components/room/Hooks";
import { LanguagesPanel } from "../../components/room/Languages";
import { ActionBar, LoadError, RoomHeader, RoomPage, SaveStatus, type SaveState } from "../../components/room/kit";
import { scoreTone, spokenSeconds, useSaveShortcut } from "../../components/room/util";
import { ScriptEditor } from "../../components/room/ScriptEditor";
import { SOURCE, ScriptVersionsDrawer } from "../../components/room/ScriptVersions";
import { TableReadPanel } from "../../components/room/TableRead";
import { StatStrip, ViewSwitch, WorkPanel, Workspace, pad } from "../../components/room/workspace";
import { Badge, Button, Empty, IconButton, Modal, Skeleton, Tooltip, rise } from "../../components/ui";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { ago, LANG_NAMES } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useEpisode, useScriptVersions, useSettings } from "../../lib/queries";
import type { Episode, Script } from "../../lib/types";
import { resolveMentions } from "../../lib/v3";
import { useProjectCtx } from "./context";

type RoomTab = "critic" | "table" | "continuity" | "languages";
/** Script intelligence: a changed dialogue line updated the shot that speaks it (PATCH /episodes response). */
interface ScriptChange { shot_id: number; code: string; old: string; new: string; stale_takes: number[] }

export default function StoryPage() {
  const t = useT();
  const { project, eid, canEdit } = useProjectCtx();
  const qc = useQueryClient();
  const nav = useNavigate();
  const location = useLocation();
  const { data: ep, isLoading, isError, refetch } = useEpisode(eid);
  const { data: versions } = useScriptVersions(eid);
  const { data: settings } = useSettings();
  const [busy, setBusy] = useState("");
  const [confirmShots, setConfirmShots] = useState(false);
  const [angle, setAngle] = useState<string>(() => (location.state as { angle?: string } | null)?.angle ?? "");
  const [custom, setCustom] = useState("");
  const [instructions, setInstructions] = useState("");
  const [script, setScript] = useState<Script>({});
  const [dirty, setDirty] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versionFocus, setVersionFocus] = useState<number | null>(null);
  const [room, setRoom] = useState<RoomTab>("critic");
  const [optSel, setOptSel] = useState<number | null>(null);
  const instructionsRef = useRef<HTMLInputElement>(null);

  const scriptKey = JSON.stringify(ep?.script);
  useEffect(() => { if (ep) { setScript(ep.script || {}); setDirty(false); } }, [ep?.id, scriptKey]);
  // New drafts / critic passes / restores create versions server-side — keep the history fresh.
  useEffect(() => { qc.invalidateQueries({ queryKey: ["script-versions", eid] }); }, [eid, scriptKey, ep?.critic?.at, qc]);

  // An angle handed over from the Brief's Trend scout arrives as navigation state; clear it so reloads don't re-apply it.
  useEffect(() => {
    if ((location.state as { angle?: string } | null)?.angle) {
      toast.message(tr("Hook angle set from Trend scout"));
      nav(location.pathname, { replace: true, state: null });
    }
  }, []);

  // The hook you just clicked stays selected while the server round trip finishes.
  useEffect(() => { if (optSel !== null && ep?.selected_hook === optSel) setOptSel(null); }, [optSel, ep?.selected_hook]);
  useEffect(() => {
    if (!justSaved) return;
    const id = window.setTimeout(() => setJustSaved(false), 2200);
    return () => window.clearTimeout(id);
  }, [justSaved]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["episode", eid] });
    qc.invalidateQueries({ queryKey: ["project", project.id] });
  };
  const run = async (key: string, fn: () => Promise<any>, ok: string): Promise<boolean> => {
    setBusy(key);
    try { await fn(); refresh(); toast.success(ok); return true; } catch { return false; /* api toasts */ } finally { setBusy(""); }
  };

  // Seed the editor from a server copy of the script (saves and resolves hand back known @names as tokens).
  const seed = (s: Script | undefined | null) => { setScript(s || {}); setDirty(false); setJustSaved(true); };

  const saveScript = async () => {
    setBusy("save");
    try {
      const res = await api.patch<Episode & { script_changes?: ScriptChange[] }>(`/api/episodes/${eid}`, { script });
      seed(res.script);
      refresh();
      toast.success(tr("Script saved"));
      const changes = res.script_changes ?? [];
      if (changes.length) {
        const stale = changes.reduce((n, c) => n + (c.stale_takes?.length ?? 0), 0);
        const shots = changes.length === 1 ? tr("1 shot updated") : tr("{n} shots updated", { n: changes.length });
        const takes = stale === 1 ? tr("1 take marked stale") : tr("{n} takes marked stale", { n: stale });
        toast.message(`${shots}, ${takes}`, {
          description: tr("The dialogue you changed was copied into its shots."),
          duration: 8000,
          action: { label: tr("See impact"), onClick: () => nav(`/p/${project.id}/dashboard`) },
        });
      }
    } catch { /* api toasts */ } finally { setBusy(""); }
  };
  useSaveShortcut(canEdit && dirty && busy !== "save", saveScript);

  // Bare @Names → tokens; unknown names become cast members. Unsaved edits are saved first so nothing is lost.
  const resolveNames = async () => {
    setBusy("resolve");
    try {
      if (dirty) await api.patch(`/api/episodes/${eid}`, { script });
      const r = await resolveMentions(eid, true);
      seed(r.script as Script);
      refresh();
      qc.invalidateQueries({ queryKey: ["characters"] });
      qc.invalidateQueries({ queryKey: ["mentions", project.id] });
      const n = r.created.length;
      toast.success(n === 0 ? tr("Every @name is already linked") : n === 1 ? tr("1 new cast member created from @names") : tr("{n} new cast members created from @names", { n }),
        n ? { description: r.created.map((c) => c.name).join(", ") } : undefined);
    } catch { /* api toasts */ } finally { setBusy(""); }
  };

  if (isError && !ep) return <RoomPage width="default"><LoadError what={t("Couldn't load the story")} onRetry={() => refetch()} /></RoomPage>;
  if (isLoading || !ep) return <StorySkeleton />;

  const hooks = ep.hooks || [];
  const critic = ep.critic;
  const issues = ep.continuity?.issues?.length ?? 0;
  const checked = !!ep.continuity?.at || ep.continuity?.ok !== undefined;
  const reads = Object.keys(ep.table_read ?? {}).length;
  const hasScript = !!script.scenes?.length;
  const selected = optSel ?? ep.selected_hook;
  const state: SaveState = busy === "save" ? "saving" : dirty ? "dirty" : justSaved ? "saved" : "clean";
  const bar = Number(settings?.settings.critic_min_score ?? 7.5);
  const lineCount = (script.scenes ?? []).reduce((n, s) => n + (s.lines?.length ?? 0), 0);
  const spoken = spokenSeconds(script);
  const hookScore = selected !== null && selected !== undefined ? hooks[selected]?.total : undefined;
  const criticScore = typeof critic?.overall === "number" ? critic.overall : undefined;

  const onScript = (next: Script) => { setScript(next); setDirty(true); setJustSaved(false); };

  const selectHook = async (i: number) => {
    setOptSel(i);
    const ok = await run("sel", () => api.post(`/api/episodes/${eid}/hooks/select`, { index: i }), tr("Hook selected"));
    if (!ok) setOptSel(null);
  };
  const writeScript = () => run("script", () => api.post(`/api/episodes/${eid}/script/generate`, { instructions }), tr("Script written"));
  const doPlanShots = async () => {
    setConfirmShots(false);
    if (await run("shots", () => api.post(`/api/episodes/${eid}/shots/breakdown`), tr("Shots planned"))) nav(`/p/${project.id}/shots`);
  };
  // re-planning replaces the shot list: ask first when there is one
  const planShots = () => ((ep?.shots ?? []).some((s) => s.include) ? setConfirmShots(true) : void doPlanShots());
  const buildBible = () => run("bible", () => api.post(`/api/projects/${project.id}/bible/propose`, { episode_id: eid }), tr("Bible updated"));

  const applyNotes = (notes: string) => {
    setInstructions(notes);
    instructionsRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => instructionsRef.current?.focus(), 350);
    toast.message(tr("Critic notes added to the writer's instructions — press Rewrite when ready"));
  };
  const openVersions = (id: number | null = null) => { setVersionFocus(id); setVersionsOpen(true); };

  const actionBar = canEdit ? (
    <ActionBar width="wide">
      <div className="flex min-w-0 flex-1 basis-64 items-center gap-2 rounded-lg border border-line bg-panel pl-3 pr-1 transition-[border-color,box-shadow] hover:border-dim/40 focus-within:border-ai/60 focus-within:ring-[3px] focus-within:ring-ai/15">
        <Sparkles aria-hidden className="size-4 shrink-0 text-ai" />
        <input ref={instructionsRef} value={instructions} onChange={(e) => setInstructions(e.target.value)} aria-label={t("Instructions for the writer")}
          placeholder={t("Instructions for the writer (optional): make Meera braver, end on a cliffhanger…")}
          className="h-9 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-dim" />
        {instructions && <IconButton title={t("Clear")} onClick={() => setInstructions("")} className="size-7"><X className="size-3.5" /></IconButton>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <AnimatePresence initial={false}>
          {dirty && (
            <motion.div key="save" initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }} transition={{ duration: 0.16 }}>
              <Button variant="primary" loading={busy === "save"} icon={<Save className="size-4" />} onClick={saveScript}>{t("Save edits")}</Button>
            </motion.div>
          )}
        </AnimatePresence>
        <Button variant={hasScript ? "secondary" : "primary"} loading={busy === "script"} icon={<Sparkles className="size-4" />} onClick={writeScript}>
          {hasScript ? t("Rewrite") : t("Write script")}
        </Button>
        {hasScript && (
          <Button variant={dirty ? "secondary" : "primary"} loading={busy === "shots"} icon={<LayoutGrid className="size-4" />} iconRight={<ArrowRight className="size-4" />} onClick={planShots}>
            {t("Plan shots")}
          </Button>
        )}
      </div>
    </ActionBar>
  ) : undefined;

  const recent = (versions ?? []).slice(0, 4);

  return (
    <RoomPage width="wide" footer={actionBar}>
      <RoomHeader icon={<BookOpen />} title={t("Story")} description={t("Pick a hook, write the script, then let the writers' room tighten it.")}
        status={canEdit ? <SaveStatus state={state} /> : undefined}
        actions={canEdit && hasScript ? (
          <Tooltip content={t("Link every @Name in the script to the cast, locations and props. Unknown names become new characters.")}>
            <Button size="sm" variant="outline" loading={busy === "resolve"} icon={<AtSign className="size-3.5" />} onClick={resolveNames}>{t("Resolve @names")}</Button>
          </Tooltip>
        ) : undefined} />

      <div className="space-y-4">
        <StatStrip index={1} cells={[
          { key: "scenes", label: t("Scenes"), value: script.scenes?.length ?? 0, sub: t("{n} lines", { n: lineCount }) },
          { key: "spoken", label: t("Spoken"), value: spoken || "—", unit: spoken ? "s" : undefined, sub: t("≈ of dialogue") },
          { key: "hook", label: t("Hook"), value: hookScore ? hookScore.toFixed(1) : "—", unit: hookScore ? "/10" : undefined,
            tone: hookScore ? scoreTone(hookScore) : "neutral", sub: hookScore ? t("selected opening") : t("none picked yet") },
          { key: "critic", label: t("Critic"), value: criticScore !== undefined ? criticScore.toFixed(1) : "—", unit: criticScore !== undefined ? "/10" : undefined,
            tone: criticScore !== undefined ? scoreTone(criticScore, bar) : "neutral", sub: criticScore === undefined ? t("not run yet") : criticScore >= bar ? t("clears the bar") : t("below the bar") },
          { key: "issues", label: t("Continuity"), value: checked ? issues : "—", tone: !checked ? "neutral" : issues ? "warn" : "ok", sub: !checked ? t("not checked") : issues ? t("issues to review") : t("no issues") },
          { key: "reads", label: t("Table read"), value: reads || "—", sub: reads ? t("languages") : t("not recorded") },
        ]} />

        <HookSection index={2} n={1} eid={eid} hooks={hooks} selected={selected} canEdit={canEdit} busy={busy}
          angle={angle} onAngle={setAngle} custom={custom} onCustom={setCustom}
          onWrite={() => run("hooks", () => api.post(`/api/episodes/${eid}/hooks/generate`, { n: 6, angle }), tr("Hooks written"))}
          onSelect={selectHook}
          onUseCustom={() => run("custom", () => api.post(`/api/episodes/${eid}/hooks/select`, { text: custom }).then(() => setCustom("")), tr("Hook added"))}
          onInsight={(h) => { setAngle(tr("Similar to: “{hook}”", { hook: h.hook })); toast.message(tr("Angle set — write hooks to use it")); }} />

        <Workspace railKind="wide" rail={
          <>
            {/* writers' room: critic, table read, continuity, localization behind one switch */}
            <WorkPanel id="room" index={3} n={3} kicker={t("Writers' room")} tone="ai" icon={<MessagesSquare />} flush
              description={undefined} bodyClassName="pb-1">
              <div className="px-4 pb-3 pt-3.5 @md:px-5">
                <ViewSwitch size="sm" value={room} onChange={setRoom} label={t("Writers' room")} className="w-full" items={[
                  { value: "critic", label: t("Critic"), icon: <Gauge />, count: criticScore !== undefined ? criticScore.toFixed(1) : undefined },
                  { value: "table", label: t("Read"), icon: <Headphones />, count: reads > 0 ? reads : undefined },
                  { value: "continuity", label: t("Continuity"), icon: <ScanSearch />, count: issues > 0 ? issues : undefined, warn: issues > 0 },
                  { value: "languages", label: t("Localize"), icon: <Languages /> },
                ]} />
              </div>
              <div className="border-t border-line p-4 @md:p-5">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div key={room} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16, ease: "easeOut" }}>
                    {room === "critic" && <CriticPanel ep={ep} onUseNotes={applyNotes} />}
                    {room === "table" && <TableReadPanel ep={ep} />}
                    {room === "continuity" && (
                      <ContinuityPanel eid={eid} report={ep.continuity} canRun={canEdit} bare compact
                        hint={(ep.shots ?? []).length ? undefined : t("Works best after scene cards or shots are planned — it compares props, wardrobe and time of day across them.")} />
                    )}
                    {room === "languages" && <LanguagesPanel ep={ep} />}
                  </motion.div>
                </AnimatePresence>
              </div>
            </WorkPanel>

            {/* script history */}
            <WorkPanel index={4} n={4} kicker={t("History")} icon={<History />} title={t("Versions")}
              badge={!!versions?.length ? <span className="mono rounded bg-raised px-1.5 text-2xs font-medium leading-4 text-dim">{versions.length}</span> : undefined}
              actions={<Button size="sm" variant="ghost" icon={<History className="size-3.5" />} onClick={() => openVersions()}>{t("Open history")}</Button>}>
              {!recent.length ? (
                <p className="text-xs text-dim">{t("No versions yet. A version is saved every time the script is written, edited, critiqued or restored.")}</p>
              ) : (
                <ol className="-mx-1.5">
                  {recent.map((v, i) => {
                    const src = SOURCE[v.source] ?? { label: v.source, tone: "neutral" as const, dot: "bg-dim" };
                    const score = v.critic?.overall;
                    return (
                      <li key={v.id}>
                        <button type="button" onClick={() => openVersions(v.id)}
                          className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-hover">
                          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", src.dot)} />
                          <span className="mono w-8 shrink-0 text-xs font-semibold">v{v.version}</span>
                          <Badge tone={src.tone}>{t(src.label)}</Badge>
                          {i === 0 && <Badge tone="ok">{t("Latest")}</Badge>}
                          <span className="mono ml-auto shrink-0 text-2xs text-dim" title={new Date(v.created_at).toLocaleString()}>{ago(v.created_at)}</span>
                          {typeof score === "number" && <span className={cn("mono w-7 shrink-0 text-right text-xs font-semibold", score >= bar ? "text-ok" : "text-warn")}>{score.toFixed(1)}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
            </WorkPanel>
          </>
        }>
          <WorkPanel id="script" index={5} n={2} kicker={t("Screenplay")} icon={<ScrollText />} flush
            title={project.type === "series" ? t("Script — Episode {n}", { n: ep.number }) : t("Script")}
            description={t("Dialogue in {lang}. Other languages are created later by dubbing.", { lang: LANG_NAMES[project.primary_language] ?? project.primary_language })}
            actions={
              <Button size="sm" variant="ghost" icon={<History className="size-3.5" />} onClick={() => openVersions()}>
                {t("Versions")}{!!versions?.length && <span className="mono ml-0.5 rounded bg-raised px-1.5 py-px text-2xs font-semibold text-mute">{versions.length}</span>}
              </Button>
            }>
            {!hasScript ? (
              <div className="p-4 @md:p-5">
                <Empty icon={<ScrollText className="size-7" />} title={t("No script yet")} sub={t("Pick a hook, then write the script.")}
                  action={canEdit ? <Button variant="primary" loading={busy === "script"} icon={<Sparkles className="size-4" />} onClick={writeScript}>{t("Write script")}</Button> : undefined} />
              </div>
            ) : (
              <div className="mt-4 border-t border-line">
                <ScriptEditor script={script} onChange={onScript} canEdit={canEdit} pid={project.id} eid={eid} />
              </div>
            )}
          </WorkPanel>

          {hasScript && canEdit && (
            <WorkPanel index={6} n={5} kicker={t("Hand-off")} icon={<ListChecks />} title={t("What's next")} description={t("Next: create the cast & look from this script, plan scene cards, then break it into shots.")}>
              <ol className="grid gap-3 @2xl:grid-cols-3">
                <Step n={1} icon={<Users />} title={t("Cast & look")} text={t("Create the characters, locations and style this script needs.")}>
                  <Button loading={busy === "bible"} icon={<Users className="size-4" />} onClick={buildBible}>{t("Build bible")}</Button>
                </Step>
                <Step n={2} icon={<SquareKanban />} title={t("Scene cards")} text={t("Plan the goal, conflict and coverage of every scene.")}>
                  <Button icon={<SquareKanban className="size-4" />} onClick={() => nav(`/p/${project.id}/scenes`)}>{t("Scene cards")}</Button>
                </Step>
                <Step n={3} icon={<LayoutGrid />} title={t("Shots")} text={t("Break the script into a shot list for the storyboard.")} last>
                  <Button loading={busy === "shots"} icon={<LayoutGrid className="size-4" />} iconRight={<ArrowRight className="size-4" />} onClick={planShots}>{t("Plan shots")}</Button>
                </Step>
              </ol>
            </WorkPanel>
          )}

          {project.type === "series" && (
            <WorkPanel index={7} n={6} kicker={t("Continuity")} tone="ai" icon={<Brain />} title={t("Series memory")} description={t("The next episode's writer reads this summary to stay consistent.")}
              actions={canEdit && <Button size="sm" loading={busy === "sum"} icon={<Sparkles className="size-3.5 text-ai" />} onClick={() => run("sum", () => api.post(`/api/episodes/${eid}/summary/generate`), tr("Summary saved"))}>{t("Summarize for next episode")}</Button>}>
              {ep.summary_for_next
                ? <p className="whitespace-pre-wrap text-sm leading-relaxed text-mute">{ep.summary_for_next}</p>
                : <p className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-sm text-mute">{t("Not summarised yet. The next episode's writer reads this to stay consistent.")}</p>}
            </WorkPanel>
          )}
        </Workspace>
      </div>

      <ScriptVersionsDrawer open={versionsOpen} onClose={() => setVersionsOpen(false)} eid={eid} current={ep.script} canEdit={canEdit} hasUnsaved={dirty} focusId={versionFocus} />
      <Modal open={confirmShots} onClose={() => setConfirmShots(false)} size="sm" title={t("Replace the shot list?")}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirmShots(false)}>{t("Cancel")}</Button>
          <Button variant="danger" loading={busy === "shots"} onClick={() => void doPlanShots()}>{t("Re-plan shots")}</Button>
        </>}>
        <p className="text-sm text-mute">
          {t("This episode already has {n} shots. Planning again replaces the shot list (shots with paid takes are kept out of the cut, not deleted). To change a few shots, edit them in the Shot list instead.",
            { n: (ep.shots ?? []).filter((s) => s.include).length })}
        </p>
      </Modal>
    </RoomPage>
  );
}

/** One hand-off step: a mono numeral, what it does and the button that does it; arrows join the steps on wide panels. */
function Step({ n, icon, title, text, children, last }: { n: number; icon: ReactNode; title: string; text: string; children: ReactNode; last?: boolean }) {
  const r = rise(n);
  return (
    <li className={cn("relative flex flex-col rounded-lg border border-line bg-bg/40 p-3.5", r.className)} style={r.style}>
      <div className="mb-2 flex items-center gap-2.5">
        <span className="grid size-7 place-items-center rounded-md bg-accent/12 text-accent-ink [&>svg]:size-4">{icon}</span>
        <span className="min-w-0">
          <span className="eyebrow block">{pad(n)}</span>
          <span className="mt-1 block truncate text-sm font-semibold leading-tight">{title}</span>
        </span>
      </div>
      <p className="mb-3 flex-1 text-xs leading-relaxed text-mute">{text}</p>
      <div className="flex">{children}</div>
      {!last && <ArrowRight aria-hidden className="absolute -right-[1.05rem] top-1/2 z-[1] hidden size-4 -translate-y-1/2 text-dim @2xl:block" />}
    </li>
  );
}

/** Same silhouette as the loaded page: header, strip, hook cards, script + rail. */
function StorySkeleton() {
  return (
    <RoomPage width="wide">
      <div className="mb-5 flex items-center gap-3">
        <Skeleton className="size-10 !rounded-xl" />
        <div className="space-y-2"><Skeleton className="h-5 w-24" /><Skeleton className="h-3 w-72 max-w-[60vw]" /></div>
      </div>
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-[5.5rem] !rounded-xl" />
        <div className="rounded-xl border border-line bg-panel p-5">
          <Skeleton className="mb-1 h-3 w-24" /><Skeleton className="mb-4 h-4 w-56" />
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,16.5rem),1fr))]">
            {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-44 !rounded-xl" />)}
          </div>
        </div>
        <div className="grid gap-4 @5xl:grid-cols-[minmax(0,1fr)_25rem]">
          <div className="rounded-xl border border-line bg-panel p-5">
            <Skeleton className="mb-1 h-3 w-24" /><Skeleton className="mb-4 h-4 w-40" />
            <Skeleton className="mb-3 h-16 !rounded-xl" /><Skeleton className="h-56 !rounded-xl" />
          </div>
          <Skeleton className="hidden h-72 !rounded-xl @5xl:block" />
        </div>
      </div>
    </RoomPage>
  );
}
