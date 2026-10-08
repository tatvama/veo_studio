/** Shot-to-shot continuity (Film Map links) and the cheap local checks the shot nodes and outline show as badges. */
import type { Shot } from "../../../lib/types";
import type { ShotV3Fields, TakeV3 } from "../../../lib/v3";

export type LinkMode = "last_frame" | "extend";
/** A shot as the v3 backend returns it (continuity link, props). */
export type ShotV3 = Shot & ShotV3Fields;

export interface ShotLink { fromId: number; mode: LinkMode }
/** The explicit Film Map link of a shot: which shot it continues from, and how. */
export function linkOf(shot: Shot): ShotLink | null {
  const s = shot as ShotV3;
  if (!s.continuity_from_shot_id) return null;
  return { fromId: s.continuity_from_shot_id, mode: s.continuity_mode === "extend" ? "extend" : "last_frame" };
}

export interface LinkFrom { id: number; code: string; mode: LinkMode }
/** The shot this one continues from (looked up in `byId`) with its code, for labels and tooltips. */
export function linkFromOf(shot: Shot, byId: Map<number, Shot>): LinkFrom | null {
  const l = linkOf(shot);
  const src = l ? byId.get(l.fromId) : undefined;
  return l && src ? { id: src.id, code: src.code, mode: l.mode } : null;
}

/** Words that fit in a clip before the engine rushes or cuts the line (same table as the backend's MAX_WORDS_PER_CLIP). */
export const WORD_CAPS: Record<number, number> = { 4: 10, 6: 16, 8: 22 };

export interface DialogueIssues { words: number; cap: number; speakers: number }
/** Local version of GET /shots/{id}/dialogue-check: too many words for the clip length, or two speakers in one clip. */
export function dialogueIssues(shot: Shot, lang: string): DialogueIssues | null {
  const lines = shot.dialogue?.[lang] ?? [];
  if (!lines.length) return null;
  const words = lines.reduce((a, l) => a + (l.line || "").trim().split(/\s+/).filter(Boolean).length, 0);
  const cap = WORD_CAPS[shot.duration_s] ?? 22;
  const speakers = new Set(lines.map((l) => String(l.character_id))).size;
  return words > cap || speakers > 1 ? { words, cap, speakers } : null;
}

const TAKE_SLOTS = ["keyframe", "video", "lipsync", "voice", "voicelock", "narration_take"] as const;
/** Takes of the shot that an edit since made stale, each with the reason the backend recorded. */
export function staleTakes(shot: Shot): { kind: string; reason: string }[] {
  const out: { kind: string; reason: string }[] = [];
  for (const k of TAKE_SLOTS) {
    const t = shot[k] as TakeV3 | null;
    if (t?.stale) out.push({ kind: t.kind || k, reason: t.stale_reason || "" });
  }
  return out;
}

/** QC outcome once it has run on the video (and the lip-sync take, if any); null before QC ran. `flags` are English keys for t(). */
export function qcState(shot: Shot): { passed: boolean; flags: string[] } | null {
  const v = shot.video;
  if (!v || typeof v.qc?.passed !== "boolean") return null;
  const failed = [v.qc, shot.lipsync?.qc].filter((q): q is Record<string, any> => !!q && q.passed === false);
  const flags = new Set<string>();
  for (const q of failed) {
    if (typeof q.reason === "string" && q.reason) flags.add(q.reason);
    if (q.identity_ok === false) flags.add("identity");
    if (q.lipsync_ok === false) flags.add("lip-sync");
    if (q.words_ok === false) flags.add("words");
    if (q.outfit_ok === false) flags.add("outfit");
    if (q.extra_people) flags.add("extra people");
    if (q.text_artifacts) flags.add("text in the picture");
  }
  return { passed: failed.length === 0, flags: [...flags] };
}
