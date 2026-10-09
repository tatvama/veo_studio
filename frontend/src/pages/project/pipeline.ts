import { useMemo } from "react";
import { tr } from "../../lib/i18n";
import type { Episode, Project } from "../../lib/types";

export type StageState = "done" | "progress" | "todo" | "none";
export interface Stage { state: StageState; hint?: string }

/** Tabs that count toward the "N of M steps" summary. */
export const TRACKED = ["brief", "story", "scenes", "bible", "storyboard", "timeline", "export"] as const;

/**
 * Where each workspace step stands, derived from data the project already has.
 * done = finished, progress = started, todo = not started, none = not a step (Review, Activity).
 */
export function computePipeline(project: Project | undefined, ep: Episode | undefined): Record<string, Stage> {
  const out: Record<string, Stage> = { review: { state: "none" }, activity: { state: "none" }, dashboard: { state: "none" },
                                       world: { state: "none" }, campaign: { state: "none" } };
  if (!project) return out;

  const brief = project.brief ?? {};
  const filled = Object.values(brief).filter((v) => (typeof v === "string" ? v.trim() : v)).length;
  out.brief = { state: filled >= 4 ? "done" : filled > 0 ? "progress" : "todo" };

  const hasScript = !!ep?.script?.scenes?.length;
  const hookPicked = ep?.selected_hook !== null && ep?.selected_hook !== undefined;
  out.story = hasScript && hookPicked
    ? { state: "done", hint: tr("Script written") }
    : { state: hasScript || !!ep?.hooks?.length ? "progress" : "todo", hint: hasScript ? tr("Script written") : ep?.hooks?.length ? tr("Hooks written") : undefined };

  const cards = (ep?.scenes ?? []) as { approved?: boolean }[];
  const approved = cards.filter((s) => s.approved).length;
  out.scenes = !cards.length ? { state: "todo" }
    : approved === cards.length ? { state: "done", hint: tr("{n} scenes approved", { n: approved }) }
    : { state: "progress", hint: tr("{a} of {n} scenes approved", { a: approved, n: cards.length }) };

  const cast = (project.cast ?? []) as { locked?: boolean }[];
  const locked = cast.filter((c) => c.locked).length;
  out.bible = !cast.length ? { state: "todo" }
    : locked === cast.length ? { state: "done", hint: tr("{n} characters locked", { n: locked }) }
    : { state: "progress", hint: tr("{a} of {n} characters locked", { a: locked, n: cast.length }) };

  const shots = (ep?.shots ?? []).filter((s) => s.include);
  const videos = shots.filter((s) => s.video).length;
  const keyframes = shots.filter((s) => s.keyframe).length;
  out.storyboard = !shots.length ? { state: "todo" }
    : videos === shots.length ? { state: "done", hint: tr("{a}/{n} videos", { a: videos, n: shots.length }) }
    : { state: keyframes || videos ? "progress" : "progress", hint: tr("{a}/{n} videos", { a: videos, n: shots.length }) };

  out.timeline = ep?.music?.length ? { state: "done", hint: tr("Music added") } : { state: videos ? "progress" : "todo" };

  const renders = (ep?.exports ?? []).filter((x) => x.kind === "final");
  const ready = renders.filter((x) => x.status === "ready").length;
  out.export = ready ? { state: "done", hint: tr("{n} renders ready", { n: ready }) } : { state: renders.length ? "progress" : "todo" };
  return out;
}

/**
 * A step's state from the pages it tracks: done once every one is done, started once any is, "none" when it tracks nothing
 * (an optional step). The hint joins the pages' hints ("Script written · 3 of 5 scenes approved").
 */
export function stepStage(stages: Record<string, Stage>, tracked: readonly string[]): Stage {
  const list = tracked.map((k) => stages[k]).filter((s): s is Stage => !!s && s.state !== "none");
  if (!list.length) return { state: "none" };
  const hint = list.map((s) => s.hint).filter(Boolean).join(" · ") || undefined;
  if (list.every((s) => s.state === "done")) return { state: "done", hint };
  return { state: list.some((s) => s.state !== "todo") ? "progress" : "todo", hint };
}

export function usePipeline(project: Project | undefined, ep: Episode | undefined) {
  return useMemo(() => {
    const stages = computePipeline(project, ep);
    const done = TRACKED.filter((k) => stages[k]?.state === "done").length;
    return { stages, done, total: TRACKED.length };
  }, [project, ep]);
}
