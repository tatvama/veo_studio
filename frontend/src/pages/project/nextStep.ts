import { tr } from "../../lib/i18n";
import type { AutopilotCatalog, AutopilotState, Episode, Project } from "../../lib/types";

export interface NextStep {
  tab: string;
  text: string;
  action: string;
  tone: "accent" | "info" | "warn" | "ok";
  secondary?: { tab: string; label: string };
}

/**
 * The one thing to do next for this episode, from what it already has. Drives the "Next step" bar and the tab a
 * project opens on, so there is always an obvious way forward.
 */
export function nextStep(project: Project, ep: Episode | undefined, ap: AutopilotState, cat?: AutopilotCatalog): NextStep | null {
  if (!ep) return null;
  const label = (stage?: string) => (stage && cat?.labels[stage]) || stage || "";
  if (ap.status === "running" && (!ap.episode_id || ap.episode_id === ep.id)) {
    return { tab: "brief", tone: "info", text: tr("Autopilot is working on: {stage}", { stage: tr(label(ap.stage)) }), action: tr("Watch progress") };
  }
  if (ap.status === "paused" && (!ap.episode_id || ap.episode_id === ep.id)) {
    const m = cat?.milestones.find((x) => x.id === ap.paused_after);
    return {
      tab: m?.tab ?? "brief", tone: "warn", text: tr("Autopilot paused: review the {m}, then continue", { m: tr(m?.label ?? "") }),
      action: tr("Review {m}", { m: tr(m?.label ?? "") }), secondary: { tab: "brief", label: tr("Continue Autopilot") },
    };
  }
  const shots = (ep.shots ?? []).filter((s) => s.include);
  const hasScript = !!ep.script?.scenes?.length;
  const ideaFlow = !!(project.brief || {}).key_message;
  if (!shots.length && !hasScript) {
    return ideaFlow
      ? { tab: "story", tone: "accent", text: tr("Start with the story: pick a hook and write the script"), action: tr("Write the script"),
          secondary: { tab: "shots", label: tr("Import my own script") } }
      : { tab: "shots", tone: "accent", text: tr("Import your script, or build the shot list yourself"), action: tr("Open shot list") };
  }
  if (!shots.length) {
    return { tab: "scenes", tone: "accent", text: tr("Script done. Next: plan the scenes and shots, and cast the characters"), action: tr("Plan scenes"),
      secondary: { tab: "bible", label: tr("Cast characters") } };
  }
  const videos = shots.filter((s) => s.video).length;
  if (videos < shots.length) {
    return { tab: "shots", tone: "accent", text: tr("{a} of {n} shots have video. Next: produce the rest", { a: videos, n: shots.length }),
      action: tr("Produce shots"), secondary: { tab: "storyboard", label: tr("See takes") } };
  }
  const renders = (ep.exports ?? []).filter((x) => x.kind === "final");
  if (!ep.music?.length && !renders.length) {
    return { tab: "timeline", tone: "accent", text: tr("All shots have video. Next: music, sound and the cut"), action: tr("Open timeline"),
      secondary: { tab: "export", label: tr("Skip to export") } };
  }
  if (!renders.some((x) => x.status === "ready")) {
    return { tab: "export", tone: "accent", text: tr("Next: render the final video"), action: tr("Export") };
  }
  return { tab: "review", tone: "ok", text: tr("Your video is ready: review it and share it"), action: tr("Review") };
}
