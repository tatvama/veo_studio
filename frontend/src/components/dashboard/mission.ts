import { tr } from "../../lib/i18n";
import type { Episode, Project } from "../../lib/types";
import type { EpisodeDashboard } from "../../lib/v3";
import type { NextStep } from "../../pages/project/nextStep";
import type { Stage } from "../../pages/project/pipeline";
import { isQcFailedShot } from "./shotState";
import type { Tone } from "./tone";

/** 0..1 credit a page's stage earns toward overall completion: done is 1, started is a real ratio where the data has one. */
export function stageCredit(key: string, st: Stage | undefined, project: Project, ep: Episode | undefined): number {
  if (!st || st.state === "none" || st.state === "todo") return 0;
  if (st.state === "done") return 1;
  const clamp = (v: number) => Math.max(0.08, Math.min(0.92, v));
  switch (key) {
    case "brief": {
      const filled = Object.values(project.brief ?? {}).filter((v) => (typeof v === "string" ? v.trim() : v)).length;
      return clamp(filled / 4);
    }
    case "scenes": {
      const cards = (ep?.scenes ?? []) as { approved?: boolean }[];
      return cards.length ? clamp(cards.filter((s) => s.approved).length / cards.length) : 0.5;
    }
    case "bible": {
      const cast = (project.cast ?? []) as { locked?: boolean }[];
      return cast.length ? clamp(cast.filter((c) => c.locked).length / cast.length) : 0.5;
    }
    case "storyboard": {
      const shots = (ep?.shots ?? []).filter((s) => s.include);
      return shots.length ? clamp(shots.filter((s) => s.video).length / shots.length) : 0.5;
    }
    default: return 0.5;
  }
}

export type ActionGo =
  | { kind: "tab"; tab: string }
  | { kind: "path"; to: string }
  | { kind: "shot"; shotId: number }
  | { kind: "anchor"; id: string };

export interface MissionAction {
  tone: Extract<Tone, "accent" | "info" | "warn" | "ok" | "ai">;
  /** short mono label above the sentence ("Autopilot", "Quality", "Next step") */
  kicker: string;
  text: string;
  label: string;
  go: ActionGo;
  secondary?: { label: string; go: ActionGo };
}

/**
 * The one thing to do next. Things that block the work come first (money waiting on a decision, a failed quality check,
 * takes that are out of date); otherwise the pipeline's own next step, with the review queue as the secondary link.
 */
export function missionAction(a: {
  pid: number; episode: Episode | undefined; d: EpisodeDashboard | undefined; step: NextStep | null; canProduce: boolean; canReview: boolean;
}): MissionAction | null {
  const { step, d, episode } = a;
  if (!episode) return null;
  const tab = (t: string): ActionGo => ({ kind: "tab", tab: t });

  // Autopilot is working or waiting: that is the headline.
  if (step && (step.tone === "info" || step.tone === "warn")) {
    return {
      tone: step.tone === "info" ? "ai" : "warn", kicker: tr("Autopilot"), text: step.text, label: step.action, go: tab(step.tab),
      secondary: step.secondary ? { label: step.secondary.label, go: tab(step.secondary.tab) } : undefined,
    };
  }
  if (a.canProduce && d && d.queue.pending_approvals > 0) {
    const n = d.queue.pending_approvals;
    return {
      tone: "warn", kicker: tr("Approvals"), go: { kind: "path", to: "/approvals" }, label: tr("Open approvals"),
      text: n === 1 ? tr("1 spend request is waiting for a producer's decision") : tr("{n} spend requests are waiting for a producer's decision", { n }),
    };
  }
  const failed = (episode.shots ?? []).filter((s) => s.include && s.status !== "approved" && isQcFailedShot(s));
  if (failed.length) {
    return {
      tone: "warn", kicker: tr("Quality"), go: { kind: "shot", shotId: failed[0].id }, label: tr("Open {code}", { code: failed[0].code }),
      text: failed.length === 1 ? tr("{code} failed the quality check. Fix it or regenerate it", { code: failed[0].code }) : tr("{n} shots failed the quality check. Start with {code}", { n: failed.length, code: failed[0].code }),
    };
  }
  if (d && d.footage.stale_takes > 0) {
    const n = d.footage.stale_takes;
    return {
      tone: "warn", kicker: tr("Change impact"), go: { kind: "anchor", id: "mission-impact" }, label: tr("Review change impact"),
      text: n === 1 ? tr("1 take is out of date because its shot changed") : tr("{n} takes are out of date because their shots changed", { n }),
    };
  }
  if (!step) return null;
  const waiting = d?.shots.in_review ?? 0;
  const secondary = step.secondary ? { label: step.secondary.label, go: tab(step.secondary.tab) }
    : waiting > 0 && a.canReview ? { label: waiting === 1 ? tr("Review 1 shot") : tr("Review {n} shots", { n: waiting }), go: tab("storyboard") } : undefined;
  return {
    tone: step.tone === "ok" ? "ok" : "accent", kicker: step.tone === "ok" ? tr("Ready") : tr("Next step"), text: step.text, label: step.action, go: tab(step.tab), secondary,
  };
}
