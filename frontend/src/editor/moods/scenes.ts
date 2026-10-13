/**
 * Mood per scene: a sequence imported from a studio episode (Sequence.source {pid, eid}) has one marker per scene
 * ("Scene 3: The storm", desktop editor-episode.ts); the episode's scenes (GET /api/episodes/{eid}) carry an
 * `emotion`. Each scene becomes a timeline range [its marker, the next scene's marker) with a suggested mood: the AI's
 * (`mood_suggest`) when it answered, else the mapping table in lib/moods.ts. Pure.
 */
import { moodById, moodForEmotion, type MoodDef } from "../../lib/moods.ts";
import { seqEnd } from "../model/ops.ts";
import type { Sequence } from "../model/types.ts";

export interface StudioScene { id: number; order: number; title?: string; emotion?: string; summary?: string; time_of_day?: string }
export interface SceneRange { scene: StudioScene; from: number; to: number; markerId?: string; suggested: MoodDef | null; why: string }

/** "Scene 3", "Scene 3: The storm" → 3. */
export const sceneOrderOf = (name: string): number | null => {
  const m = /^\s*scene\s+(\d+)\b/i.exec(name);
  return m ? Number(m[1]) : null;
};

/** The emotion text a scene is judged by (its emotion, else the time of day and summary give a hint). */
const emotionText = (s: StudioScene) => [s.emotion, s.time_of_day === "night" ? "night" : "", s.summary?.slice(0, 160)].filter(Boolean).join(" ");

/**
 * Scenes → timeline ranges by their markers, in timeline order. Without scene markers (an edit not made from an
 * episode, or markers deleted) the scenes split the sequence evenly in their order.
 */
export function sceneRanges(seq: Sequence, scenes: StudioScene[], suggestions: Record<number, { mood: string; why?: string }> = {}): SceneRange[] {
  const end = Math.max(1, seqEnd(seq));
  const sorted = [...scenes].sort((a, b) => a.order - b.order);
  const marks = seq.markers.map((m) => ({ m, order: sceneOrderOf(m.name) })).filter((x) => x.order !== null).sort((a, b) => a.m.frame - b.m.frame);
  const pick = (s: StudioScene): { mood: MoodDef | null; why: string } => {
    const ai = suggestions[s.id];
    const fromAi = ai ? moodById(ai.mood) : undefined;
    if (fromAi) return { mood: fromAi, why: ai!.why || "AI suggestion" };
    const m = moodForEmotion(emotionText(s));
    return { mood: m, why: m ? `“${s.emotion || "scene"}” → ${m.label}` : s.emotion ? `No mood matches “${s.emotion}”` : "The scene has no emotion set" };
  };
  if (marks.length) {
    const out: SceneRange[] = [];
    marks.forEach((x, i) => {
      const sc = sorted.find((s) => s.order === x.order) ?? { id: -(i + 1), order: x.order!, title: x.m.name.replace(/^\s*scene\s+\d+:?\s*/i, "") };
      const to = i + 1 < marks.length ? marks[i + 1].m.frame : end;
      if (to <= x.m.frame) return;
      const p = pick(sc);
      out.push({ scene: sc, from: x.m.frame, to, markerId: x.m.id, suggested: p.mood, why: p.why });
    });
    return out;
  }
  if (!sorted.length) return [];
  const step = end / sorted.length;
  return sorted.map((sc, i) => { const p = pick(sc); return { scene: sc, from: Math.round(i * step), to: Math.round((i + 1) * step), suggested: p.mood, why: p.why }; });
}
