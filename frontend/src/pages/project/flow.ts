import { useEffect, useState } from "react";
import { areaOf, getProjectSteps, getProjectTabs, type ProjectStep, type ProjectTab, type StepId } from "../../components/shell/nav";
import type { Episode, Project } from "../../lib/types";
import { stepStage, type Stage } from "./pipeline";

type T = (s: string, v?: Record<string, string | number>) => string;

/** Projects made from the user's own material: shot by shot, or an imported script. */
export const isOwnMaterial = (p: Project) => p.workflow === "shots" || p.workflow === "script";

/**
 * Whether a sub-page shows in its step for this project. Own-material projects hide the pages about writing from a concept
 * (hooks & script, scenes, props & wardrobe) until they have something in them. The open page always shows, and every page
 * stays reachable by its URL and the command palette.
 */
export function tabApplies(tab: ProjectTab, project: Project, ep: Episode | undefined, current?: string): boolean {
  if (!tab.ownHidden || tab.to === current || !isOwnMaterial(project)) return true;
  if (tab.to === "story") return !!(ep?.hooks?.length || ep?.script?.scenes?.length);
  return !!ep?.scenes?.length;
}

/** A step as the project header and the Overview show it: its sub-pages for this project, where it stands, and where its link goes. */
export interface StepView extends ProjectStep {
  tabs: ProjectTab[];
  /** The pages whose progress counts toward this step (see pipeline.ts). */
  tracked: string[];
  stage: Stage;
  /** The sub-page the step's link opens: the last one used in this project, else the step's default. */
  to: string;
}

function defaultTab(id: StepId, tabs: ProjectTab[], project: Project, ep: Episode | undefined): string {
  // own-material projects work in the Studio once they have shots (and start on the shot list), as before
  if (id === "shots" && isOwnMaterial(project)) return (ep?.shots ?? []).length ? "studio" : "shots";
  return tabs[0]?.to ?? "dashboard";
}

export function buildSteps(t: T, project: Project, ep: Episode | undefined, stages: Record<string, Stage>,
  opts: { current?: string; last?: Record<string, string> } = {}): StepView[] {
  const all = getProjectTabs(t);
  const own = isOwnMaterial(project);
  return getProjectSteps(t).map((s) => {
    const tabs = all.filter((x) => x.area === s.id && tabApplies(x, project, ep, opts.current));
    // an own-material project needs no brief, so it only counts once it has been started
    const tracked = tabs.map((x) => x.to).filter((k) => stages[k] && stages[k].state !== "none" && !(own && k === "brief" && stages[k].state === "todo"));
    const pick = opts.last?.[s.id];
    const to = pick && tabs.some((x) => x.to === pick) ? pick : defaultTab(s.id, tabs, project, ep);
    return { ...s, tabs, tracked, stage: stepStage(stages, tracked), to };
  });
}

const fullKey = (pid: number) => `veo:fullFlow:${pid}`;

/**
 * Own-material projects leave the Story step out of the header until it has writing in it. This remembers a project
 * someone asked to show it for (the "⋯" menu), and the switch back.
 */
export function useFullFlow(pid: number): [boolean, (v: boolean) => void] {
  const read = () => { try { return localStorage.getItem(fullKey(pid)) === "1"; } catch { return false; } };
  const [full, setFull] = useState(read);
  useEffect(() => setFull(read()), [pid]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (v: boolean) => {
    setFull(v);
    try { if (v) localStorage.setItem(fullKey(pid), "1"); else localStorage.removeItem(fullKey(pid)); } catch { /* storage blocked */ }
  };
  return [full, set];
}

const lastKey = (pid: number) => `veo:stepTabs:${pid}`;

/** Remembers the sub-page last used in each step of a project, so a step's link returns to it. */
export function useLastTabs(pid: number, tab: string): Record<string, string> {
  const [last, setLast] = useState<Record<string, string>>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(lastKey(pid)) || "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch { return {}; }
  });
  useEffect(() => {
    const area = areaOf(tab);
    if (!area || area === "home" || area === "log" || last[area] === tab) return;
    const next = { ...last, [area]: tab };
    setLast(next);
    try { localStorage.setItem(lastKey(pid), JSON.stringify(next)); } catch { /* storage blocked */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, tab]);
  return last;
}
