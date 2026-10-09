import { Check, CircleDashed, Film, History, Image as ImageIcon, Loader, TriangleAlert, type LucideIcon } from "lucide-react";
import type { Shot } from "../../lib/types";
import type { TakeV3 } from "../../lib/v3";

/** Where one shot stands, for the shot map. Priority: generating, stale, QC failed, approved, video, keyframe, draft. */
export type ShotState = "draft" | "keyframe" | "video" | "approved" | "stale" | "generating" | "qcfail";

/** Legend order. */
export const SHOT_STATES: ShotState[] = ["approved", "video", "keyframe", "draft", "generating", "stale", "qcfail"];

type T = (s: string) => string;

export function stateLabel(t: T, s: ShotState): string {
  switch (s) {
    case "draft": return t("Draft");
    case "keyframe": return t("Keyframe ready");
    case "video": return t("Video ready");
    case "approved": return t("Approved");
    case "stale": return t("Stale");
    case "generating": return t("Generating");
    case "qcfail": return t("QC failed");
  }
}

export const isStaleShot = (s: Shot): boolean =>
  [s.keyframe, s.video, s.lipsync, s.voicelock, s.voice, s.narration_take].some((x) => !!(x as TakeV3 | null | undefined)?.stale);

export const isQcFailedShot = (s: Shot): boolean => s.video?.qc?.passed === false || s.lipsync?.qc?.passed === false;

export function shotState(s: Shot): ShotState {
  if (s.generating || (s.active_jobs?.length ?? 0) > 0) return "generating";
  if (isStaleShot(s)) return "stale";
  if (s.status !== "approved" && isQcFailedShot(s)) return "qcfail";
  if (s.status === "approved") return "approved";
  if (s.status === "video_ready" || s.video) return "video";
  if (s.status === "keyframe_ready" || s.keyframe) return "keyframe";
  return "draft";
}

export interface StateStyle {
  /** the cell in the mosaic */
  cell: string;
  /** a segment of the stacked bar / a legend swatch */
  bar: string;
  icon: LucideIcon;
}

export const STATE_STYLE: Record<ShotState, StateStyle> = {
  draft: { cell: "border-dashed border-dim/50 bg-transparent text-dim", bar: "bg-dim/45", icon: CircleDashed },
  keyframe: { cell: "border-info/40 bg-info/10 text-info", bar: "bg-info", icon: ImageIcon },
  video: { cell: "border-accent/50 bg-accent/12 text-accent-ink", bar: "bg-accent", icon: Film },
  approved: { cell: "border-ok/50 bg-ok/16 text-ok", bar: "bg-ok", icon: Check },
  stale: { cell: "border-warn/60 bg-warn/12 text-warn", bar: "bg-warn", icon: History },
  generating: { cell: "gen-ring border-accent/60 bg-accent/10 text-accent-ink", bar: "bg-gradient-to-r from-accent to-accent-2", icon: Loader },
  qcfail: { cell: "border-bad/60 bg-bad/12 text-bad", bar: "bg-bad", icon: TriangleAlert },
};
