import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowRight, BookmarkPlus, CheckCircle2, CirclePause, Gauge, Loader2, Play, Rocket, Square, Wand2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { defaultStops } from "../../components/AutopilotPanel";
import { announce } from "../../components/Generate";
import { Alert, Button, Input, Modal, Select, Skeleton, Toggle, Tooltip } from "../../components/ui";
import { Money } from "../../components/kit/Money";
import { api } from "../../lib/api";
import { plainLabel, useBatchEstimate } from "../../lib/estimates";
import { QUALITY_INFO } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useSettings } from "../../lib/queries";
import { useBusyAction } from "../../lib/useBusyAction";
import type { AutopilotState, SubmitResult } from "../../lib/types";
import { useProjectCtx } from "./context";
import { choicesOf, produceBody, sameChoices, type MakeChoices, type Recipe } from "./drafts";

/** The built-in recipes and the team's own (GET /api/recipes). */
export const useRecipes = (enabled = true) =>
  useQuery({ queryKey: ["recipes"], queryFn: () => api.get<{ recipes: Recipe[] }>("/api/recipes"), enabled, staleTime: 60_000 });

/** The steps "Make it for me" runs once there are shots (the backend's produce steps, in order). */
export const PRODUCE_STEPS = ["cast", "keyframes", "videos", "extend", "voices", "sound", "music", "export"] as const;
export type ProduceStep = (typeof PRODUCE_STEPS)[number];

/** Each produce step in plain words: its name and what it makes. */
export function produceStepLabels(t: (s: string) => string): Record<ProduceStep, [string, string]> {
  return {
    cast: [t("Cast pictures & voices"), t("Pictures for characters and places that have none, and a voice for each speaker, so they look and sound the same in every scene")],
    keyframes: [t("Pictures"), t("A still picture per shot, using your characters' pictures")],
    videos: [t("Videos"), t("Each shot brought to life from its picture")],
    extend: [t("Longer clips"), t("Extra seconds for shots marked “Extend to”")],
    voices: [t("Voices & mouth sync"), t("Dialogue in each character's voice with matching lips; voice-over by the narrator")],
    sound: [t("Sound effects"), t("Each scene's background sound and each shot's effects, from your script's sound notes")],
    music: [t("Music"), t("Background music from each scene's mood, on one theme")],
    export: [t("Final film"), t("The finished video with captions")],
  };
}

/**
 * "Make it for me": the one way to let the studio do the work. With no shots yet it runs Autopilot through to the final
 * film, stopping where you ask; once there are shots it makes everything they still need (Produce all), only what is
 * missing. The price is shown before anything starts, and a running or paused run can be followed, continued or stopped.
 * The same dialog opens from the Next bar, the shot list and the Brief.
 * With shots it also offers "Quick draft first" (480p previews on the cheapest engine that makes them and a draft cut;
 * the Next bar then offers the final film) and recipes: saved choices, one click each (three built in, the team's own).
 */
export function MakeItForMe({ open, onClose, hasShots, beforeRun, steps: only }: {
  open: boolean; onClose: () => void;
  /** Whether the episode has shots: Autopilot from the idea when it has none, Produce all when it has. */
  hasShots: boolean;
  /** Runs first (e.g. saving the shot list); false stops the run. */
  beforeRun?: () => Promise<boolean>;
  /** Only these produce steps (e.g. ["cast"] for "Make the cast"); the others start switched off. */
  steps?: ProduceStep[];
}) {
  const t = useT();
  const qc = useQueryClient();
  const { project, eid, canEdit } = useProjectCtx();
  const { data: settings } = useSettings();
  const milestones = settings?.catalog.autopilot?.milestones ?? [];
  const stageLabels = settings?.catalog.autopilot?.labels ?? {};
  const ap = (project.autopilot || {}) as AutopilotState;
  const mine = !ap.episode_id || ap.episode_id === eid;
  const running = mine && ap.status === "running";
  const paused = mine && ap.status === "paused";
  const pausedAt = milestones.find((m) => m.id === ap.paused_after);
  const { busy, run: guard } = useBusyAction();

  // ── Autopilot (no shots yet) ──
  const [target, setTarget] = useState("final");
  const [stops, setStops] = useState<string[] | null>(null);
  const chosenStops = (stops ?? defaultStops(milestones, target)).filter((s) => s !== target);
  const targetIdx = milestones.findIndex((m) => m.id === target);

  // ── Produce all (there are shots) ──
  const [on, setOn] = useState<Record<string, boolean> | null>(null);
  const picked = on ?? Object.fromEntries(PRODUCE_STEPS.map((s) => [s, !only || only.includes(s)]));
  const [quality, setQuality] = useState("");
  const [review, setReview] = useState(true);
  const [link, setLink] = useState(true);
  const [perScene, setPerScene] = useState(true);  // music: one piece per scene (off: one score for the episode)
  const [draft, setDraft] = useState(false);  // "Quick draft first": 480p previews and a draft cut, the final film after
  const steps = PRODUCE_STEPS.filter((s) => picked[s]);
  const label = produceStepLabels(t);
  const choices: MakeChoices = { steps: [...steps], quality: quality || null, draft, review_looks: review, link_scenes: link ? "auto" : "never",
    music_per_scene: perScene };
  const applyRecipe = (r: MakeChoices) => {
    const c = choicesOf(r);
    setOn(Object.fromEntries(PRODUCE_STEPS.map((s) => [s, c.steps.includes(s)])));
    setQuality(c.quality ?? "");
    setDraft(c.draft);
    setReview(c.review_looks);
    setLink(c.link_scenes === "auto");
    setPerScene(c.music_per_scene);
  };

  const mode: "watch" | "autopilot" | "produce" = running || paused ? "watch" : hasShots ? "produce" : "autopilot";
  const body = useMemo<Record<string, unknown> | null>(() => {
    if (mode === "watch") return paused ? { action: "autopilot", resume: true } : null;
    if (mode === "autopilot") return { action: "autopilot", through: target, pause_after: chosenStops };
    return produceBody(choices);
  }, [mode, paused, target, chosenStops.join(","), steps.join(","), quality, review, link, perScene, draft]); // eslint-disable-line react-hooks/exhaustive-deps
  const shotsKey = project.updated_at;
  const { data: est, isFetching, isError, error } = useBatchEstimate(eid, open ? body : null, [shotsKey]);
  const errorText = isError && error instanceof Error && error.message ? error.message : "";
  const nothing = !!est && est.count === 0;
  const blocked = !!est && !est.budget.ok && !est.budget.needs_role;

  const start = () => guard("start", async () => {
    if (!body) return;
    if (beforeRun && !(await beforeRun())) return;
    const what = mode === "watch" ? tr("Make it for me: continue") : mode === "produce" && draft ? tr("Quick draft") : tr("Make it for me");
    const r = await api.post<SubmitResult>(`/api/episodes/${eid}/generate`, body);
    announce(r, what);
    for (const k of ["jobs", "episode", "project", "board", "estimate"]) qc.invalidateQueries({ queryKey: [k] });
    onClose();
  });
  const stop = () => guard("stop", async () => {
    if (!ap.job_id) return;
    await api.post(`/api/jobs/${ap.job_id}/cancel`, {});
    toast.info(tr("Stopping after the current step"));
    qc.invalidateQueries({ queryKey: ["project", project.id] });
  });

  const price = est && !nothing ? <Money v={est.total_usd} /> : null;
  const startLabel = !est ? (isError ? t("Can't start yet") : t("Pricing…"))
    : nothing ? t("Nothing left to make")
    : blocked ? t("Over your limit")
    : !est.budget.ok ? t("Ask for approval")
    : mode === "watch" ? t("Continue")
    : mode === "produce" && draft && picked.videos ? t("Make the draft")
    : t("Start");

  return (
    <Modal open={open} onClose={() => !busy && onClose()} closable={!busy} size="md"
      title={<span className="flex items-center gap-2"><Wand2 className="size-4 text-ai" />{t("Make it for me")}</span>}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={!!busy}>{t("Close")}</Button>
        {running ? (
          canEdit && <Button variant="outline" icon={<Square className="size-3.5" />} loading={busy === "stop"} disabled={!!busy} onClick={stop}>{t("Stop after this step")}</Button>
        ) : canEdit && (
          <Button variant="primary" data-autofocus icon={mode === "watch" ? <Play className="size-4" /> : <Rocket className="size-4" />}
            loading={busy === "start"} disabled={!!busy || !est || nothing || blocked || !body} onClick={start}>
            {startLabel}{price && <span className="mono">· {price}</span>}
          </Button>
        )}
      </>}>
      <div className="space-y-4">
        {mode === "watch" && (running ? (
          <div className="rounded-xl border border-ai/30 bg-ai/8 p-3.5">
            <p className="flex items-center gap-2 text-sm font-semibold"><Loader2 className="size-4 animate-spin text-ai" />{t("Working on it")}</p>
            <p className="mt-1 text-xs text-mute">
              {t("Now: {stage}", { stage: t(stageLabels[ap.stage ?? ""] ?? ap.stage ?? "") })}
              {ap.through ? ` · ${t("until {m}", { m: t(milestones.find((m) => m.id === ap.through)?.label ?? ap.through) })}` : ""}
            </p>
            <p className="mt-2 text-2xs text-dim">{t("You can close this: the work carries on, and the bar at the bottom shows how far it got.")}</p>
          </div>
        ) : (
          <div className="rounded-xl border border-warn/40 bg-warn/8 p-3.5">
            <p className="flex items-center gap-2 text-sm font-semibold"><CirclePause className="size-4 text-warn" />
              {t("{m} is ready for you to check", { m: t(pausedAt?.label ?? "") })}</p>
            <p className="mt-1 text-xs text-mute">{t("Change anything you like, then continue. Nothing is made twice.")}</p>
            {pausedAt && (
              <Link to={`/p/${project.id}/${pausedAt.tab}`} onClick={onClose} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent-ink hover:underline">
                {t("Check {m}", { m: t(pausedAt.label) })}<ArrowRight className="size-3.5" />
              </Link>
            )}
          </div>
        ))}

        {mode === "autopilot" && (
          <>
            <p className="text-sm text-mute">{t("From your idea to the finished film: the script, the shots, the cast, pictures and videos, voices, sound and music. It stops where you ask, so you can check before it spends more.")}</p>
            {!settings ? <Skeleton className="h-40" /> : (
              <ol className="overflow-hidden rounded-xl border border-line">
                {milestones.map((m, i) => {
                  const inRun = i <= targetIdx;
                  const gate = i < targetIdx;
                  return (
                    <li key={m.id} className={clsx("flex items-start gap-3 border-b border-line px-3 py-2.5 last:border-b-0", inRun ? "bg-accent/5" : "opacity-60")}>
                      <button type="button" onClick={() => { setTarget(m.id); setStops(null); }} aria-pressed={m.id === target}
                        title={t("Go as far as {m}", { m: t(m.label) })}
                        className={clsx("mono mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border text-2xs font-semibold transition-colors",
                          inRun ? "border-accent/40 bg-accent/10 text-accent-ink" : "border-line text-dim hover:border-accent/40")}>{i + 1}</button>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{t(m.label)}{m.id === target && <span className="ml-2 text-2xs font-normal text-accent-ink">{t("goes this far")}</span>}</p>
                        <p className="text-2xs leading-snug text-dim">{t(m.description)}</p>
                      </div>
                      {gate && (
                        <Toggle checked={chosenStops.includes(m.id)} onChange={(v) => setStops(v ? [...chosenStops, m.id] : chosenStops.filter((x) => x !== m.id))}
                          label={<span className="text-2xs text-mute">{t("Stop to check")}</span>} />
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        )}

        {mode === "produce" && (
          <>
            <p className="text-sm text-mute">{t("Makes everything your shots still need, in order, and only what is missing: nothing is made twice.")}</p>
            <Recipes current={choices} onApply={applyRecipe} canSave={canEdit} />
            <ol className="overflow-hidden rounded-xl border border-line">
              {PRODUCE_STEPS.map((s, i) => {
                const waits = draft && s === "extend";  // a draft is never extended: the longer clips come with the final film
                const on = !!picked[s] && !waits;
                return (
                  <li key={s} className={clsx("flex items-start gap-3 border-b border-line px-3 py-2.5 transition-colors last:border-b-0", on && "bg-accent/5")}>
                    <span className={clsx("mono mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border text-2xs font-semibold transition-colors",
                      on ? "border-accent/40 bg-accent/10 text-accent-ink" : "border-line text-dim")}>{String(i + 1).padStart(2, "0")}</span>
                    <div className="min-w-0 flex-1">
                      <p className={clsx("text-sm font-medium", !on && "text-mute")}>{label[s][0]}</p>
                      <p className="text-2xs leading-snug text-dim">
                        {waits ? t("Waits for the final film: a draft isn't extended")
                          : draft && s === "videos" ? t("A 480p draft of each shot with no clip yet, on the cheapest engine that makes one")
                          : draft && s === "voices" ? t("The voices now; the mouth sync comes with the final film")
                          : draft && s === "export" ? t("A draft cut of the 480p clips, to check the story and timing")
                          : label[s][1]}
                      </p>
                      {s === "music" && picked[s] && (
                        <div className="mt-2"><Toggle checked={perScene} onChange={setPerScene} label={<span className="text-xs text-mute">{t("One piece per scene (follows each scene's mood)")}</span>} /></div>
                      )}
                    </div>
                    <Toggle checked={on} disabled={waits} onChange={(v) => setOn({ ...picked, [s]: v })} label={<span className="sr-only">{label[s][0]}</span>} />
                  </li>
                );
              })}
            </ol>
            <div className="flex flex-col items-start gap-2.5 rounded-xl border border-line px-3 py-2.5">
              <div>
                <Toggle checked={draft} onChange={setDraft} disabled={!picked.videos}
                  label={<span className="inline-flex items-center gap-1.5 text-sm"><Gauge className="size-3.5 text-ai" />{t("Quick draft first (480p, cheaper)")}</span>} />
                {draft && <p className="mt-1 pl-[3.375rem] text-2xs leading-snug text-dim">{t("Check the cut before paying for the finished clips. Then the bar at the bottom offers “Make the final film”, with its price.")}</p>}
              </div>
              <Toggle checked={review} onChange={setReview} disabled={!picked.cast}
                label={<span className="text-sm">{t("Stop after new cast pictures & voices so I can check them first")}</span>} />
              <Toggle checked={link} onChange={setLink} disabled={!picked.videos}
                label={<span className="text-sm">{t("A scene that picks up straight from the last starts on its last frame")}</span>} />
            </div>
            <label className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-sm">
              <span className="font-medium">{t("Video quality")}</span>
              <Select value={quality} onChange={(e) => setQuality(e.target.value)} className="w-full sm:w-64" aria-label={t("Video quality")}>
                <option value="">{t("Project default ({q})", { q: t(QUALITY_INFO[project.quality_mode]?.label ?? project.quality_mode) })}</option>
                {Object.entries(QUALITY_INFO).map(([k, v]) => <option key={k} value={k}>{t(v.label)} · {v.price}</option>)}
              </Select>
            </label>
          </>
        )}

        {/* the price, before anything starts */}
        {body && (
          <div className="rounded-xl border border-line bg-raised/40 px-4 py-3" aria-busy={isFetching || undefined}>
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="eyebrow">{mode === "autopilot" ? t("Price, at most") : t("Price")}</p>
                <p className="mt-0.5 text-xs text-mute">
                  {isError ? (errorText || t("Add or import shots first.")) : nothing ? t("Everything is already made.") : est ? (est.count === 1 && est.items.length <= 1 ? t("1 run") : t("{n} items", { n: est.items.length || est.count })) : t("Working out the price…")}
                </p>
              </div>
              <p className="mono text-2xl font-semibold leading-none tracking-tight text-money">{est && !nothing ? <Money v={est.total_usd} /> : "—"}</p>
            </div>
            {est && mode === "produce" && est.items.length > 1 && (
              <ul className="mt-2.5 space-y-1 border-t border-line pt-2.5 text-xs">
                {est.items.map((it) => (
                  <li key={it.label} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-mute">{plainLabel(it.label)}</span><span className="mono shrink-0 text-money">{it.usd ? <Money v={it.usd} /> : t("free")}</span>
                  </li>
                ))}
              </ul>
            )}
            {est?.warnings?.map((w) => <Alert key={w} tone="warn" className="mt-2.5">{w}</Alert>)}
            {est && !nothing && (est.budget.ok
              ? <p className="mt-2.5 flex items-center gap-1.5 text-xs text-ok"><CheckCircle2 className="size-3.5" />{t("Within your limits.")}</p>
              : <p className={clsx("mt-2.5 text-xs", blocked ? "text-bad" : "text-warn")}>{est.budget.reason}{est.budget.needs_role ? ` ${t("A {role} will be asked to approve.", { role: est.budget.needs_role })}` : ""}</p>)}
            {mode === "autopilot" && <p className="mt-2 text-2xs text-dim">{t("One approval for the whole run; it stops by itself if spending goes 50% over this.")}</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * Recipes: saved Make it for me choices as one-click chips (three built in: "Reels draft", "Full film, Hero quality",
 * "Storyboard first"; the team's own after them). A chip only fills the dialog: the price still shows before anything
 * starts. "Save as recipe" keeps the current choices for the whole team.
 */
function Recipes({ current, onApply, canSave }: { current: MakeChoices; onApply: (r: MakeChoices) => void; canSave: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useRecipes();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const { busy, run: guard } = useBusyAction();
  const list = data?.recipes ?? [];
  const save = () => guard("save", async () => {
    const r = await api.post<Recipe>("/api/recipes", { ...current, name: name.trim() });
    toast.success(tr("Saved “{name}”: one click in Make it for me for the whole team", { name: r.name }));
    setNaming(false);
    setName("");
    qc.invalidateQueries({ queryKey: ["recipes"] });
  });
  const remove = (r: Recipe) => guard(`del-${r.id}`, async () => {
    await api.del(`/api/recipes/${encodeURIComponent(r.id)}`);
    toast.message(tr("Recipe “{name}” deleted", { name: r.name }));
    qc.invalidateQueries({ queryKey: ["recipes"] });
  });
  return (
    <div className="rounded-xl border border-line px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="eyebrow">{t("Recipes")}</p>
        {canSave && !naming && (
          <button type="button" onClick={() => setNaming(true)} className="inline-flex items-center gap-1 text-2xs font-medium text-accent-ink hover:underline">
            <BookmarkPlus className="size-3.5" />{t("Save these choices")}
          </button>
        )}
      </div>
      {isLoading ? <Skeleton className="mt-2 h-7" /> : (
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t("Recipes")}>
          {list.map((r) => {
            const lit = sameChoices(r, current);
            return (
              <span key={r.id} className={clsx("inline-flex h-7 items-center rounded-lg border text-xs transition-colors",
                lit ? "border-accent/60 bg-accent/10 text-accent-ink" : "border-line bg-raised/60 text-ink hover:border-accent/40")}>
                <Tooltip content={r.about || t("Steps: {steps}", { steps: r.steps.join(", ") })}>
                  <button type="button" aria-pressed={lit} onClick={() => onApply(r)} className="h-full px-2 font-medium">
                    {r.draft && <span className="mono mr-1 text-2xs text-ai">480p</span>}{r.name}
                  </button>
                </Tooltip>
                {!r.builtin && canSave && (
                  <button type="button" aria-label={t("Delete the recipe {name}", { name: r.name })} disabled={!!busy}
                    onClick={() => void remove(r)} className="grid h-full w-6 place-items-center rounded-r-lg text-dim hover:bg-hover hover:text-ink">
                    <X className="size-3" />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}
      {naming && (
        <form className="mt-2 flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void save(); }}>
          <Input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={t("Name, e.g. Ad cut, Hindi reels")}
            aria-label={t("Recipe name")} className="h-8 flex-1 text-xs" />
          <Button size="sm" type="submit" variant="primary" loading={busy === "save"} disabled={!name.trim() || !current.steps.length}>{t("Save")}</Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => { setNaming(false); setName(""); }}>{t("Cancel")}</Button>
        </form>
      )}
    </div>
  );
}
