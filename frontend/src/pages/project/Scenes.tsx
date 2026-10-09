import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, Check, CheckCheck, Columns2, Globe, LayoutGrid, Rows3, Sparkles, SquareKanban } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ContinuityPanel } from "../../components/room/Continuity";
import { Fact, LoadError, RoomHeader, RoomPage } from "../../components/room/kit";
import { SceneCardView, type SceneCardV3 } from "../../components/room/SceneCard";
import { ViewSwitch, WorkPanel, Workspace, pad, sceneCode } from "../../components/room/workspace";
import { AnimatedNumber, Button, Empty, Modal, Skeleton, Tooltip, rise } from "../../components/ui";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { tr, useT } from "../../lib/i18n";
import { useCharacters, useEpisode, useLocations } from "../../lib/queries";
import type { SceneCard } from "../../lib/types";
import { useProjectCtx } from "./context";

type View = "grid" | "lanes";
const VIEW_KEY = "veo:scenesView";
const readView = (): View => { try { return localStorage.getItem(VIEW_KEY) === "lanes" ? "lanes" : "grid"; } catch { return "grid"; } };

export default function ScenesPage() {
  const t = useT();
  const { project, eid, canEdit } = useProjectCtx();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data: ep, isLoading, isError, refetch } = useEpisode(eid);
  const { data: cast } = useCharacters(project.id);
  const { data: locs } = useLocations(project.id);
  const [busy, setBusy] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<"replan" | "breakdown" | null>(null);
  const [view, setViewState] = useState<View>(readView);
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } };

  if (isError && !ep) return <RoomPage width="full"><LoadError what={t("Couldn't load the scene cards")} onRetry={() => refetch()} /></RoomPage>;
  if (isLoading || !ep) return <ScenesSkeleton />;
  const scenes = ((ep.scenes ?? []) as SceneCardV3[]).slice().sort((a, b) => a.order - b.order);
  const scriptScenes = ep.script?.scenes?.length ?? 0;
  const approved = scenes.filter((s) => s.approved).length;
  const allApproved = scenes.length > 0 && approved === scenes.length;
  const hasCards = scenes.some((s) => s.goal || s.conflict || s.coverage?.length);
  const shotCount = (ep.shots ?? []).filter((s) => s.include).length;
  const refresh = () => qc.invalidateQueries({ queryKey: ["episode", eid] });

  const plan = async () => {
    setBusy("plan");
    try {
      const r = await api.post<SceneCard[]>(`/api/episodes/${eid}/scenes/plan`);
      await refresh();
      toast.success(tr("{n} scene cards planned", { n: r.length }));
      setConfirm(null);
    } catch { /* api toasts */ } finally { setBusy(""); }
  };

  const approveAll = async () => {
    const todo = scenes.filter((s) => !s.approved);
    if (!todo.length) return;
    setBusy("approve");
    try {
      await Promise.all(todo.map((s) => api.patch(`/api/scenes/${s.id}`, { approved: true })));
      await refresh();
      toast.success(tr("{n} scenes approved", { n: todo.length }));
    } catch { /* api toasts */ } finally { setBusy(""); }
  };

  const breakdown = async () => {
    setBusy("shots");
    try {
      const shots = await api.post<unknown[]>(`/api/episodes/${eid}/shots/breakdown`);
      await refresh();
      toast.success(tr("{n} shots planned from the scene cards", { n: shots.length }));
      setConfirm(null);
      nav(`/p/${project.id}/storyboard`);
    } catch { /* api toasts */ } finally { setBusy(""); }
  };

  const jump = (s: SceneCard) => {
    document.getElementById(`scene-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const empty = !scenes.length;
  const flow = [
    { done: !empty, text: t("Plan scenes from the script.") },
    { done: allApproved, text: t("Edit goals, coverage and wardrobe; approve each card.") },
    { done: shotCount > 0, text: t("Break into shots — the shot planner follows the approved coverage, blocking and wardrobe.") },
  ];
  const indexOf = new Map(scenes.map((s, i) => [s.id, i]));
  const card = (s: SceneCardV3) => (
    <SceneCardView key={s.id} scene={s} index={indexOf.get(s.id) ?? 0} cast={cast ?? []} locations={locs ?? []} canEdit={canEdit} projectId={project.id}
      expanded={expanded === s.id} onToggle={() => setExpanded(expanded === s.id ? null : s.id)} />
  );

  return (
    <RoomPage width="full">
      <RoomHeader icon={<SquareKanban />} title={t("Scene cards")}
        description={t("Plan every scene before shots: what each character wants, what's in the way, what turns, and how to cover it.")}
        actions={canEdit && scriptScenes > 0 && !empty && (
          <Button loading={busy === "plan"} disabled={!!busy} icon={<Sparkles className="size-4 text-ai" />}
            variant="secondary" onClick={() => (hasCards ? setConfirm("replan") : plan())}>
            {hasCards ? t("Re-plan scenes") : t("Plan scenes")}
          </Button>
        )} />

      {!scriptScenes && empty ? (
        <Empty icon={<BookOpen className="size-7" />} title={t("Write the script first")}
          sub={t("Scene cards are planned from the episode script.")}
          action={<Button variant="primary" onClick={() => nav(`/p/${project.id}/story`)}>{t("Go to Story")}</Button>} />
      ) : empty ? (
        <Empty icon={<SquareKanban className="size-7" />} title={t("No scene cards yet")}
          sub={t("The planner writes one card per script scene: goal, conflict, turn, emotion, props, wardrobe, blocking and a coverage plan.")}
          action={canEdit ? <Button variant="primary" loading={busy === "plan"} icon={<Sparkles className="size-4" />} onClick={plan}>{t("Plan scenes")}</Button> : undefined} />
      ) : (
        <Workspace railKind="panel" rail={
          <>
            <ContinuityPanel index={2} n={2} eid={eid} report={ep.continuity} canRun={canEdit} compact
              hint={shotCount ? undefined : t("Checks props, wardrobe and time of day across scene cards. Re-run after shots are planned to check shots too.")} />
            <WorkPanel index={3} n={3} kicker={t("Pipeline")} icon={<Rows3 />} title={t("How this flows")}>
              <ol className="relative">
                {flow.map((s, i) => (
                  <li key={i} className="relative flex gap-3 pb-3.5 last:pb-0">
                    {i < flow.length - 1 && <span aria-hidden className="rm-rule-y absolute bottom-0 left-[0.6875rem] top-6 w-px" />}
                    <span className={cn("mono relative z-[1] grid size-[1.375rem] shrink-0 place-items-center rounded-full border text-2xs font-semibold transition-colors",
                      s.done ? "border-ok/50 bg-ok/15 text-ok" : "border-line bg-raised text-mute")}>
                      {s.done ? <Check className="size-3" strokeWidth={3.25} /> : i + 1}
                    </span>
                    <span className={cn("pt-px text-xs leading-relaxed", s.done ? "text-mute" : "text-ink")}>{s.text}</span>
                  </li>
                ))}
              </ol>
            </WorkPanel>
            <WorkPanel index={4} n={4} kicker={t("Cast")} icon={<Globe />} title={t("Props, wardrobe & end states")}>
              <p className="text-xs leading-relaxed text-mute">{t("Props with reference images, the wardrobe timeline and every scene's end state live under Cast, in Props & wardrobe.")}</p>
              <Link to={`/p/${project.id}/world`} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent-ink hover:underline">{t("Open Props & wardrobe")}<ArrowRight className="size-3.5" /></Link>
            </WorkPanel>
          </>
        }>
          {/* the instrument strip: approvals as a segmented meter, the two actions that depend on it, and the layout switch */}
          <div {...rise(1)} className={cn("z-10 [@media(min-height:640px)]:sticky [@media(min-height:640px)]:top-2", rise(1).className)}>
            <div className="hud relative rounded-xl border border-line bg-panel/95 shadow-card backdrop-blur-md">
              <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px opacity-70" />
              <div className="flex flex-wrap items-center gap-x-5 gap-y-3 p-3 @md:p-3.5">
                <div className="flex min-w-0 flex-1 basis-72 items-center gap-4">
                  <div className="shrink-0">
                    <p className="eyebrow">{t("Approved")}</p>
                    <p className={cn("mono mt-1.5 flex items-baseline gap-1 text-[1.65rem] font-medium leading-none tracking-tight", allApproved && "text-ok")}>
                      <AnimatedNumber value={approved} duration={0.5} /><span className="text-sm font-normal text-dim">/ {scenes.length}</span>
                    </p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex gap-[3px]" role="list" aria-label={t("Scene approval progress")}>
                      {scenes.map((s, i) => (
                        <Tooltip key={s.id} content={`${sceneCode(i)} · ${s.title || t("Untitled scene")}${s.approved ? "" : ` · ${t("not approved")}`}`}>
                          <button type="button" role="listitem" onClick={() => jump(s)} aria-label={`${sceneCode(i)} ${s.title || ""}`}
                            className="group/seg relative h-6 min-w-1 flex-1">
                            <span className={cn("absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-[2px] transition-all group-hover/seg:h-2.5",
                              s.approved ? "bg-ok shadow-[0_0_6px_-1px_var(--color-ok)]" : "bg-line group-hover/seg:bg-dim/60")} />
                          </button>
                        </Tooltip>
                      ))}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      {scriptScenes > 0 && scriptScenes !== scenes.length && (
                        <Fact tone="warn">{t("Script has {n} scenes — re-plan to sync", { n: scriptScenes })}</Fact>
                      )}
                      {shotCount > 0 && <Fact>{t("{n} shots planned", { n: shotCount })}</Fact>}
                      {canEdit && !allApproved && <span className="text-2xs text-dim">{t("Approve every scene card first")}</span>}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ViewSwitch size="sm" value={view} onChange={setView} label={t("Scene layout")} items={[
                    { value: "grid", label: t("Grid"), icon: <LayoutGrid /> },
                    { value: "lanes", label: t("Lanes"), icon: <Columns2 /> },
                  ]} />
                  {canEdit && (
                    <>
                      <Button loading={busy === "approve"} disabled={!!busy || allApproved} icon={<CheckCheck className="size-4" />} onClick={approveAll}>
                        {t("Approve all")}
                      </Button>
                      <Button variant={allApproved ? "primary" : "secondary"} loading={busy === "shots"} disabled={!!busy || !allApproved}
                        icon={<LayoutGrid className="size-4" />} iconRight={<ArrowRight className="size-4" />}
                        onClick={() => (shotCount ? setConfirm("breakdown") : breakdown())}>
                        {t("Break into shots")}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          <LayoutGroup>
            {view === "grid" ? (
              <motion.div layout className="grid items-start gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,24rem),1fr))]">
                <AnimatePresence initial={false}>{scenes.map(card)}</AnimatePresence>
              </motion.div>
            ) : (
              <div className="grid items-start gap-4 @3xl:grid-cols-2">
                <Lane tone="accent" title={t("In progress")} count={scenes.length - approved} empty={t("Every scene is approved.")}>
                  <AnimatePresence initial={false}>{scenes.filter((s) => !s.approved).map(card)}</AnimatePresence>
                </Lane>
                <Lane tone="ok" title={t("Approved")} count={approved} empty={t("Approved scenes land here.")}>
                  <AnimatePresence initial={false}>{scenes.filter((s) => s.approved).map(card)}</AnimatePresence>
                </Lane>
              </div>
            )}
          </LayoutGroup>
        </Workspace>
      )}

      <Modal open={confirm === "replan"} onClose={() => setConfirm(null)} title={t("Re-plan scene cards?")}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(null)}>{t("Cancel")}</Button>
          <Button variant="primary" loading={busy === "plan"} icon={<Sparkles className="size-4" />} onClick={plan}>{t("Re-plan")}</Button>
        </>}>
        <p className="text-sm text-mute">{t("The planner rewrites goal, conflict, turn, emotion, characters, props, wardrobe, blocking and coverage on every card from the current script. Your edits to those fields will be replaced.")}</p>
      </Modal>

      <Modal open={confirm === "breakdown"} onClose={() => setConfirm(null)} title={t("Replace the shot list?")}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(null)}>{t("Cancel")}</Button>
          <Button variant="primary" loading={busy === "shots"} icon={<LayoutGrid className="size-4" />} onClick={breakdown}>{t("Break into shots")}</Button>
        </>}>
        <p className="text-sm text-mute">{t("This episode already has {n} shots. Breaking down again replaces them; shots that already have takes are kept aside (marked OLD) so nothing paid for is lost.", { n: shotCount })}</p>
      </Modal>
    </RoomPage>
  );
}

/** One swim-lane of the lane view: a mono header with its count and a hairline, then the cards. */
function Lane({ tone, title, count, empty, children }: { tone: "accent" | "ok"; title: string; count: number; empty: string; children: ReactNode }) {
  return (
    <section className="min-w-0" aria-label={title}>
      <header className="mb-3 flex items-center gap-2">
        <span aria-hidden className={cn("size-2 rounded-full", tone === "ok" ? "bg-ok" : "bg-accent shadow-[0_0_8px_var(--color-accent)]")} />
        <h2 className={cn("eyebrow", tone === "ok" ? "!text-ok" : "!text-accent-ink")}>{title}</h2>
        <span className="mono text-2xs text-dim">{pad(count)}</span>
        <span aria-hidden className="h-px flex-1 bg-line" />
      </header>
      {count === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-mute">{empty}</p>
      ) : (
        <motion.div layout className="grid gap-3">{children}</motion.div>
      )}
    </section>
  );
}

function ScenesSkeleton() {
  return (
    <RoomPage width="full">
      <div className="mb-5 flex items-center gap-3">
        <Skeleton className="size-10 !rounded-xl" />
        <div className="space-y-2"><Skeleton className="h-5 w-32" /><Skeleton className="h-3 w-80 max-w-[60vw]" /></div>
      </div>
      <div className="grid items-start gap-5 @5xl:grid-cols-[minmax(0,1fr)_21rem]" aria-busy="true">
        <div className="space-y-4">
          <Skeleton className="h-[4.75rem] !rounded-xl" />
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,24rem),1fr))]">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="rounded-xl border border-line bg-panel p-4">
                <div className="mb-3 flex items-center gap-2"><Skeleton className="h-5 w-10" /><Skeleton className="h-4 flex-1" /><Skeleton className="h-7 w-20 !rounded-md" /></div>
                <Skeleton className="mb-3 h-3 w-40" />
                <Skeleton className="h-16 !rounded-lg" />
                <div className="mt-4 flex items-center gap-2"><Skeleton className="size-6 !rounded-full" /><Skeleton className="size-6 !rounded-full" /><Skeleton className="h-5 w-24" /></div>
              </div>
            ))}
          </div>
        </div>
        <Skeleton className="hidden h-64 !rounded-xl @5xl:block" />
      </div>
    </RoomPage>
  );
}
