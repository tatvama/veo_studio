/**
 * Moods on the timeline (docs/EDITOR.md §10, editor-looks): a mood's effect chain on the chosen clips (it replaces an
 * earlier mood, never stacks), its transitions at the cuts between them, its title style on the title clips, all in
 * one command. Mood effects are tagged by id ("mood:<mood>:<n>") so a new mood or "Remove mood" finds them. Pure.
 */
import { moodEffects, moodTransitionFrames, type MoodDef } from "../../lib/moods.ts";
import { uid } from "../model/ids.ts";
import { addTransition, clipEnd, normalize, tracksOf, type Ctx } from "../model/ops.ts";
import type { EffectInstance, Sequence, TimelineClip, TitleSpec } from "../model/types.ts";

export const MOOD_TAG = "mood:";
export const isMoodEffect = (e: EffectInstance) => e.id.startsWith(MOOD_TAG);
/** The mood a clip carries (its tagged effects), or null. */
export const clipMood = (c: TimelineClip): string | null => c.effects.find(isMoodEffect)?.id.split(":")[1] ?? null;

export type MoodScope = { kind: "clips"; ids: string[] } | { kind: "track"; trackId: string } | { kind: "sequence" } | { kind: "range"; from: number; to: number };

export interface MoodOptions {
  intensity: number;
  /** Also put the mood's transitions at the cuts between the chosen clips (replacing what is there). */
  transitions?: boolean;
  /** Also restyle the title clips in scope (font, colour, outline, shadow, background, animation). */
  titles?: boolean;
}

const VISUAL = new Set(["media", "nested", "color", "adjustment"]);

/** The clips a scope covers (video tracks only; titles only when asked). */
export function scopeClips(seq: Sequence, scope: MoodScope, withTitles = false): TimelineClip[] {
  const video = new Set(tracksOf(seq, "video").filter((t) => !t.locked).map((t) => t.id));
  const ok = (c: TimelineClip) => video.has(c.trackId) && (VISUAL.has(c.source.type) || (withTitles && c.source.type === "title"));
  switch (scope.kind) {
    case "clips": { const ids = new Set(scope.ids); return seq.clips.filter((c) => ids.has(c.id) && ok(c)); }
    case "track": return seq.clips.filter((c) => c.trackId === scope.trackId && ok(c));
    case "range": return seq.clips.filter((c) => ok(c) && c.start < scope.to && clipEnd(c) > scope.from);
    default: return seq.clips.filter(ok);
  }
}

/** The mood's effects as instances, tagged. */
export function moodInstances(m: MoodDef, intensity: number): EffectInstance[] {
  return moodEffects(m, intensity).map((e) => ({
    id: `${MOOD_TAG}${m.id}:${uid("e")}`, type: e.type, enabled: true,
    params: Object.fromEntries(Object.entries(e.params).map(([k, v]) => [k, { value: Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : v }])),
  }));
}

/** The title fields a mood sets. */
export function moodTitlePatch(m: MoodDef, seqHeight = 1080): Partial<TitleSpec> {
  const t = m.title;
  const k = seqHeight / 1080;
  const patch: Partial<TitleSpec> = { font: t.font, weight: t.weight, color: t.color, animIn: t.animIn ?? "fade", animOut: t.animOut ?? "fade",
    outline: t.outline ? { ...t.outline } : undefined, shadow: t.shadow ? { ...t.shadow } : undefined };
  if (t.background) patch.background = { ...t.background };
  void k;
  return patch;
}

/**
 * Applies a mood: on each clip in scope the earlier mood's effects go and this mood's chain comes first (the user's
 * own effects stay after it); with `transitions`, every cut between two clips in scope on one track gets the mood's
 * transition (its ids in turn); with `titles`, title clips in scope take the mood's title style (and karaoke
 * highlight colour). Returns the sequence and how many clips / cuts changed.
 */
export function applyMood(seq: Sequence, ctx: Ctx, m: MoodDef, scope: MoodScope, opts: MoodOptions): { seq: Sequence; clips: number; cuts: number; titles: number } {
  const targets = scopeClips(seq, scope, !!opts.titles);
  const ids = new Set(targets.filter((c) => c.source.type !== "title").map((c) => c.id));
  const titleIds = new Set(targets.filter((c) => c.source.type === "title").map((c) => c.id));
  const patch = moodTitlePatch(m, seq.height);
  let titles = 0;
  const clips = seq.clips.map((c) => {
    if (ids.has(c.id)) return { ...c, effects: [...moodInstances(m, opts.intensity), ...c.effects.filter((e) => !isMoodEffect(e))] };
    if (titleIds.has(c.id) && c.source.type === "title") {
      titles++;
      const text = { ...c.source.text, ...patch } as TitleSpec;
      if (!patch.background) delete text.background;
      if (!patch.outline) delete text.outline;
      if (!patch.shadow) delete text.shadow;
      if (text.karaoke) text.karaoke = { ...text.karaoke, highlightColor: m.title.highlight };
      return { ...c, source: { ...c.source, text } };
    }
    return c;
  });
  let s: Sequence = { ...seq, clips };
  let cuts = 0;
  if (opts.transitions && ids.size > 1) {
    const d = moodTransitionFrames(m, seq.fps);
    const chosen = s.clips.filter((c) => ids.has(c.id)).sort((a, b) => a.start - b.start);
    let n = 0;
    for (const a of chosen) {
      const b = chosen.find((x) => x.trackId === a.trackId && x.start === clipEnd(a));
      if (!b) continue;
      const type = m.transition.ids[n++ % m.transition.ids.length];
      const r = addTransition(s, ctx, a.trackId, b.start, type, d);
      if (r.id) {
        s = { ...r.seq, transitions: r.seq.transitions.map((t) => (t.id === r.id ? { ...t, easing: m.transition.easing } : t)) };
        cuts++;
      }
    }
  }
  return { seq: normalize(s, ctx), clips: ids.size, cuts, titles };
}

/** Takes the mood effects off the clips in scope. */
export function removeMood(seq: Sequence, ctx: Ctx, scope: MoodScope): { seq: Sequence; clips: number } {
  const ids = new Set(scopeClips(seq, scope).filter((c) => c.effects.some(isMoodEffect)).map((c) => c.id));
  if (!ids.size) return { seq, clips: 0 };
  return { seq: normalize({ ...seq, clips: seq.clips.map((c) => (ids.has(c.id) ? { ...c, effects: c.effects.filter((e) => !isMoodEffect(e)) } : c)) }, ctx), clips: ids.size };
}
