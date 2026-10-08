import type { Shot, Take } from "../../../lib/types";

/** Where one production stage of a shot stands. */
export type StageState = "done" | "todo" | "bad";

export interface ShotStages {
  kf: StageState;
  vid: StageState;
  /** null = this shot has no speech in the working language, so the stage doesn't apply. */
  voice: StageState | null;
  lip: StageState | null;
  /** The take a viewer sees by default (lip-sync → voice lock → raw video). */
  final: Take | null;
  lines: number;
}

export const qcFailed = (s: Shot) => s.video?.qc?.passed === false || s.lipsync?.qc?.passed === false;

export function shotStages(s: Shot, lang: string): ShotStages {
  const lines = s.dialogue?.[lang]?.length ?? 0;
  const narr = !!s.narration?.[lang];
  return {
    kf: s.keyframe ? "done" : "todo",
    vid: s.video ? "done" : "todo",
    voice: lines > 0 || narr ? (s.voice || s.narration_take ? "done" : "todo") : null,
    lip: lines > 0 ? (s.lipsync || s.voicelock ? "done" : "todo") : null,
    final: s.lipsync || s.voicelock || s.video,
    lines,
  };
}

/** Media a card / drawer shows for a shot: the final clip, a poster for it and the keyframe still. */
export function displayMedia(s: Shot) {
  const v = s.lipsync || s.voicelock || s.video;
  return { video: v, thumb: v?.thumb_url || s.keyframe?.thumb_url || s.keyframe?.url || "", still: s.keyframe?.url };
}

/** aspect-ratio value for a storyboard thumbnail: the project's ratio, but never taller than 9:14 so portrait cards stay compact. */
export function thumbRatio(aspect: string): string {
  const r = ratioOf(aspect);
  return String(Math.max(r.w / r.h, 9 / 14));
}

/** CSS aspect-ratio string for a project aspect ("16:9" → "16 / 9"). */
export function ratioOf(aspect: string): { w: number; h: number; css: string } {
  const [w, h] = aspect.split(":").map(Number);
  const W = w > 0 && h > 0 ? w : 16;
  const H = w > 0 && h > 0 ? h : 9;
  return { w: W, h: H, css: `${W} / ${H}` };
}
