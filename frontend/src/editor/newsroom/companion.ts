/**
 * Both-ratio edits (docs/EDITOR.md §16.7). Pure.
 * The other ratio of a news sequence, made on the fly: the same clips; graphics use that ratio's design (the renderer
 * picks it from the frame size); slot clips follow that ratio's layout boxes (the composition asks slotMotion with the
 * new frame); other pictures are reframed to fill (formats.ts reframeSequence, following faces when given); graphics
 * whose `ratios` leave it out are dropped. Never saved: the monitor and the export build it each time. Clip, track and
 * transition ids stay the original's, so the preview keeps its loaded pictures between rebuilds.
 */
import type { EditProject, Sequence, TimelineClip, Transition } from "../model/types.ts";
import { formatById, formatOf, reframeSequence, type FaceSample } from "../templates/formats.ts";
import type { GfxRatio } from "./types.ts";

/** The companion sequence's id for a sequence and ratio. */
export const companionId = (seqId: string, ratio: GfxRatio) => `${seqId}~${ratio}`;

export function companionProject(p: EditProject, seqId: string, ratio: GfxRatio, faces: Record<string, FaceSample[]> = {}): { project: EditProject; sequenceId: string } {
  const s = p.sequences.find((x) => x.id === seqId);
  const f = formatById(ratio);
  if (!s || !f || formatOf(s)?.id === ratio) return { project: p, sequenceId: seqId };
  const ns = reframeSequence(p, seqId, f, faces, { fitTitles: true, name: `${s.name} · ${ratio}` }).sequence;
  // back to the original ids (tracks keep their order; a clip is its track and start)
  const trackBack = new Map(ns.tracks.map((t, i) => [t.id, s.tracks[i]?.id ?? t.id]));
  const byKey = new Map(s.clips.map((c) => [`${c.trackId}|${c.start}`, c]));
  const clipBack = new Map<string, string>();
  const clips: TimelineClip[] = [];
  for (const c of ns.clips) {
    const tid = trackBack.get(c.trackId) ?? c.trackId;
    const old = byKey.get(`${tid}|${c.start}`);
    if (!old) continue;
    if (old.source.type === "graphic" && old.source.gfx.ratios?.length && !old.source.gfx.ratios.includes(ratio)) continue;
    clipBack.set(c.id, old.id);
    const x: TimelineClip = { ...c, id: old.id, trackId: tid, effects: c.effects.map((e, i) => ({ ...e, id: old.effects[i]?.id ?? e.id })) };
    if (old.linkId) x.linkId = old.linkId; else delete x.linkId;
    clips.push(x);
  }
  const transitions: Transition[] = [];
  for (const t of ns.transitions) {
    const from = t.fromClipId ? clipBack.get(t.fromClipId) : undefined, to = t.toClipId ? clipBack.get(t.toClipId) : undefined;
    if ((t.fromClipId && !from) || (t.toClipId && !to)) continue;
    const trackId = trackBack.get(t.trackId) ?? t.trackId;
    const orig = s.transitions.find((o) => o.trackId === trackId && o.fromClipId === from && o.toClipId === to);
    const x: Transition = { ...t, id: orig?.id ?? t.id, trackId };
    if (from) x.fromClipId = from; else delete x.fromClipId;
    if (to) x.toClipId = to; else delete x.toClipId;
    transitions.push(x);
  }
  const seq: Sequence = {
    ...ns, id: companionId(s.id, ratio), tracks: ns.tracks.map((t, i) => ({ ...t, id: s.tracks[i]?.id ?? t.id })), clips, transitions,
    markers: s.markers.map((m) => ({ ...m })),
  };
  return { project: { ...p, sequences: [...p.sequences.filter((x) => x.id !== seq.id), seq] }, sequenceId: seq.id };
}
