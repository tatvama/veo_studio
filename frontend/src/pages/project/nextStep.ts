import { tr } from "../../lib/i18n";
import type { AutopilotCatalog, AutopilotState, Episode, Project } from "../../lib/types";

/**
 * Work a step can start right here, with its price shown first:
 * cast — pictures and voices for the cast (Make it for me with only the cast step) · all — Make it for me ·
 * watch — the running or paused Make it for me run (continue it) · import — read your own script.
 */
export type Make = "cast" | "all" | "watch" | "import";

export interface NextStep {
  tab: string;
  text: string;
  action: string;
  tone: "accent" | "info" | "warn" | "ok";
  /** The primary button starts this instead of opening `tab`. */
  make?: Make;
  secondary?: { tab: string; label: string; make?: Make };
}

/** The produce body a `make` runs (what its price on the button is for). */
export function makeBody(make: Make | undefined): Record<string, unknown> | null {
  if (make === "cast") return { action: "produce", steps: ["cast"] };
  if (make === "all") {
    return { action: "produce", steps: ["cast", "keyframes", "videos", "extend", "voices", "sound", "music", "export"], link_scenes: "auto", music_per_scene: true };
  }
  return null;
}

/**
 * The one thing to do next for this episode, in plain words, from what it already has. Drives the Next bar at the bottom
 * of every project screen and the Overview, so there is always an obvious way forward.
 */
export function nextStep(project: Project, ep: Episode | undefined, ap: AutopilotState, cat?: AutopilotCatalog): NextStep | null {
  if (!ep) return null;
  const label = (stage?: string) => (stage && cat?.labels[stage]) || stage || "";
  if (ap.status === "running" && (!ap.episode_id || ap.episode_id === ep.id)) {
    return { tab: "brief", tone: "info", make: "watch", text: tr("Making it for you: {stage}", { stage: tr(label(ap.stage)) }), action: tr("See progress") };
  }
  if (ap.status === "paused" && (!ap.episode_id || ap.episode_id === ep.id)) {
    const m = cat?.milestones.find((x) => x.id === ap.paused_after);
    return {
      tab: m?.tab ?? "brief", tone: "warn", text: tr("Ready for you to check: {m}. Then carry on.", { m: tr(m?.label ?? "") }),
      action: tr("Check {m}", { m: tr(m?.label ?? "") }), secondary: { tab: "brief", label: tr("Carry on"), make: "watch" },
    };
  }
  const shots = (ep.shots ?? []).filter((s) => s.include);
  const hasScript = !!ep.script?.scenes?.length;
  const ideaFlow = !!(project.brief || {}).key_message;
  if (!shots.length && !hasScript) {
    return ideaFlow
      ? { tab: "story", tone: "accent", text: tr("Start with the story: write the script, or let the studio make it all"), action: tr("Write the script"),
          secondary: { tab: "shots", label: tr("Use my own script"), make: "import" } }
      : { tab: "shots", tone: "accent", make: "import", text: tr("Bring your script: paste it or upload a file, and check the story we read"), action: tr("Import script"),
          secondary: { tab: "shots", label: tr("Build shot by shot") } };
  }
  if (!shots.length) {
    return { tab: "story", tone: "accent", text: tr("Script done. Next: plan the shots"), action: tr("Plan the shots"),
      secondary: { tab: "bible", label: tr("Cast") } };
  }
  const videos = shots.filter((s) => s.video).length;
  const faceless = (project.cast ?? []).filter((c) => !c.avatar_url).length;
  if (!videos && faceless && !shots.some((s) => s.keyframe)) {
    return { tab: "bible", tone: "accent", make: "cast",
      text: faceless === 1 ? tr("Next: make the cast, so 1 person looks and sounds the same in every shot")
        : tr("Next: make the cast, so {n} people look and sound the same in every shot", { n: faceless }),
      action: tr("Make the cast"), secondary: { tab: "bible", label: tr("Add my own photos") } };
  }
  if (videos < shots.length) {
    return { tab: "shots", tone: "accent", make: "all",
      text: videos ? tr("{a} of {n} shots have video. Next: make the rest", { a: videos, n: shots.length }) : tr("Next: make the pictures, videos, voices, sound and music"),
      action: tr("Make it for me"), secondary: { tab: "storyboard", label: tr("Do it shot by shot") } };
  }
  const renders = (ep.exports ?? []).filter((x) => x.kind === "final");
  if (!ep.music?.length && !renders.length) {
    return { tab: "timeline", tone: "accent", text: tr("All shots have video. Next: music, sound and the cut"), action: tr("Open the edit"),
      secondary: { tab: "export", label: tr("Skip to export") } };
  }
  if (!renders.some((x) => x.status === "ready")) {
    return { tab: "export", tone: "accent", text: tr("Next: render the final video"), action: tr("Export") };
  }
  return { tab: "review", tone: "ok", text: tr("Your video is ready: review it and share it"), action: tr("Review") };
}
