import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowRight, BookOpen, Check, CheckCheck, LayoutGrid, Sparkles, SquareKanban } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ContinuityPanel } from "../../components/room/Continuity";
import { Fact, LoadError, RoomHeader, RoomPage } from "../../components/room/kit";
import { SceneCardView } from "../../components/room/SceneCard";
import { AnimatedNumber, Button, Empty, Modal, ProgressRing, Skeleton, Tooltip, rise } from "../../components/ui";
import { api } from "../../lib/api";
import { tr, useT } from "../../lib/i18n";
import { useCharacters, useEpisode, useLocations } from "../../lib/queries";
import type { SceneCard } from "../../lib/types";
import { useProjectCtx } from "./context";

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

  if (isError && !ep) return <RoomPage width="full"><LoadError what={t("Couldn't load the scene cards")} onRetry={() => refetch()} /></RoomPage>;
  if (isLoading || !ep) return <ScenesSkeleton />;
  const scenes = ((ep.scenes ?? []) as SceneCard[]).slice().sort((a, b) => a.order - b.order);
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

  return (
    <RoomPage width="full">
      <RoomHeader icon={<SquareKanban />} title={t("Scene cards")}
        description={t("Plan every scene before shots: what each character wants, what's in the way, what turns, and how to cover it.")}
        actions={canEdit && scriptScenes > 0 && !empty && (
          <Button loading={busy === "plan"} disabled={!!busy} icon={<Sparkles className="size-4" />}
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
        <div className="grid items-start gap-5 @5xl:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="min-w-0 space-y-4">
            {/* approval progress + the two actions that depend on it */}
            <div {...rise(1)} className={clsx("z-10 [@media(min-height:640px)]:sticky [@media(min-height:640px)]:top-2", rise(1).className)}>
              <div className="rounded-xl border border-line bg-panel/95 p-3 shadow-card backdrop-blur-md @md:p-3.5">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                  <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
                    <ProgressRing value={approved / scenes.length} size={44} stroke={4} tone={allApproved ? "var(--color-ok)" : "var(--color-accent)"}>
                      {allApproved ? <Check className="size-4 text-ok" strokeWidth={3} /> : <><AnimatedNumber value={approved} duration={0.5} />/{scenes.length}</>}
                    </ProgressRing>
                    <div className="min-w-0 flex-1">
                      <p className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                        <span className={clsx(allApproved && "text-green-300")}>{t("{a}/{n} approved", { a: approved, n: scenes.length })}</span>
                        {scriptScenes > 0 && scriptScenes !== scenes.length && (
                          <Fact tone="warn">{t("Script has {n} scenes — re-plan to sync", { n: scriptScenes })}</Fact>
                        )}
                        {shotCount > 0 && <Fact>{t("{n} shots planned", { n: shotCount })}</Fact>}
                      </p>
                      <div className="flex gap-1" role="list" aria-label={t("Scene approval progress")}>
                        {scenes.map((s, i) => (
                          <Tooltip key={s.id} content={`SC${String(i + 1).padStart(2, "0")} · ${s.title || t("Untitled scene")}${s.approved ? "" : ` · ${t("not approved")}`}`}>
                            <button type="button" role="listitem" onClick={() => jump(s)} aria-label={`SC${String(i + 1).padStart(2, "0")} ${s.title || ""}`}
                              className="group/seg relative h-6 min-w-1 flex-1">
                              <span className={clsx("absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full transition-all group-hover/seg:h-2.5",
                                s.approved ? "bg-ok" : "bg-line group-hover/seg:bg-dim/60")} />
                            </button>
                          </Tooltip>
                        ))}
                      </div>
                    </div>
                  </div>
                  {canEdit && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button loading={busy === "approve"} disabled={!!busy || allApproved} icon={<CheckCheck className="size-4" />} onClick={approveAll}>
                        {t("Approve all")}
                      </Button>
                      <Button variant={allApproved ? "primary" : "secondary"} loading={busy === "shots"} disabled={!!busy || !allApproved}
                        icon={<LayoutGrid className="size-4" />} iconRight={<ArrowRight className="size-4" />}
                        onClick={() => (shotCount ? setConfirm("breakdown") : breakdown())}>
                        {t("Break into shots")}
                      </Button>
                    </div>
                  )}
                </div>
                {canEdit && !allApproved && <p className="mt-2 text-2xs text-dim">{t("Approve every scene card first")}</p>}
              </div>
            </div>

            <LayoutGroup>
              <motion.div layout className="grid items-start gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,22rem),1fr))]">
                <AnimatePresence initial={false}>
                  {scenes.map((s, i) => (
                    <SceneCardView key={s.id} scene={s} index={i} cast={cast ?? []} locations={locs ?? []} canEdit={canEdit}
                      expanded={expanded === s.id} onToggle={() => setExpanded(expanded === s.id ? null : s.id)} />
                  ))}
                </AnimatePresence>
              </motion.div>
            </LayoutGroup>
          </div>

          <aside className="min-w-0 space-y-4 @5xl:sticky @5xl:top-2">
            <ContinuityPanel index={2} eid={eid} report={ep.continuity} canRun={canEdit} compact
              hint={shotCount ? undefined : t("Checks props, wardrobe and time of day across scene cards. Re-run after shots are planned to check shots too.")} />
            <div {...rise(3)} className={clsx("rounded-xl border border-line bg-panel p-4", rise(3).className)}>
              <h2 className="mb-3 text-sm font-semibold tracking-tight">{t("How this flows")}</h2>
              <ol className="space-y-3">
                {flow.map((s, i) => (
                  <li key={i} className="relative flex gap-3">
                    {i < flow.length - 1 && <span aria-hidden className="absolute bottom-[-0.75rem] left-[0.6875rem] top-6 w-px bg-line" />}
                    <span className={clsx("relative z-[1] grid size-[1.375rem] shrink-0 place-items-center rounded-full border text-2xs font-semibold tabular-nums transition-colors",
                      s.done ? "border-ok/50 bg-ok/15 text-ok" : "border-line bg-raised text-mute")}>
                      {s.done ? <Check className="size-3" strokeWidth={3.25} /> : i + 1}
                    </span>
                    <span className={clsx("pt-px text-xs leading-relaxed", s.done ? "text-mute" : "text-ink")}>{s.text}</span>
                  </li>
                ))}
              </ol>
            </div>
          </aside>
        </div>
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

function ScenesSkeleton() {
  return (
    <RoomPage width="full">
      <div className="mb-5 flex items-center gap-3">
        <Skeleton className="size-10 !rounded-xl" />
        <div className="space-y-2"><Skeleton className="h-5 w-32" /><Skeleton className="h-3 w-80 max-w-[60vw]" /></div>
      </div>
      <div className="grid items-start gap-5 @5xl:grid-cols-[minmax(0,1fr)_21rem]" aria-busy="true">
        <div className="space-y-4">
          <Skeleton className="h-[4.5rem] !rounded-xl" />
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,22rem),1fr))]">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="rounded-xl border border-line bg-panel p-4">
                <div className="mb-3 flex items-center gap-2"><Skeleton className="h-5 w-10" /><Skeleton className="h-4 flex-1" /><Skeleton className="h-7 w-20 !rounded-full" /></div>
                <Skeleton className="mb-3 h-3 w-40" />
                <div className="space-y-2"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-5/6" /><Skeleton className="h-3 w-3/4" /></div>
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
