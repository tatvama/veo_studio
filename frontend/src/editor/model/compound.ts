/**
 * Compound clips (editor-motion): ops.nestClips makes one; un-nest (break apart) puts its sequence's clips back in
 * its place — the part inside the clip's window, video tracks stacked up from the clip's track and audio tracks down
 * from its linked sound's track (tracks are added when needed), with the transitions between them. The nested clip's
 * own effects carry over to every clip. Pure.
 */
import { uid } from "./ids.ts";
import { addTrack, clipEnd, clipById, ctxOf, normalize, placeClips, sourceRate, tracksOf, trackById, trimEndBy, trimStartBy } from "./ops.ts";
import type { EditProject, Sequence, TimelineClip, Transition } from "./types.ts";

export function unnestClip(p: EditProject, seqId: string, clipId: string): { project: EditProject; clipIds: string[] } {
  const seq = p.sequences.find((s) => s.id === seqId);
  const c = seq ? clipById(seq, clipId) : undefined;
  if (!seq || !c || c.source.type !== "nested" || trackById(seq, c.trackId)?.locked) return { project: p, clipIds: [] };
  const ns = p.sequences.find((s) => s.id === (c.source as { sequenceId: string }).sequenceId);
  if (!ns) return { project: p, clipIds: [] };
  const ctx = ctxOf(p);
  // the nested clip and its linked sound (same sequence, same place)
  const halves = seq.clips.filter((x) => x.id === c.id || (c.linkId && x.linkId === c.linkId && x.source.type === "nested" && x.source.sequenceId === ns.id && x.start === c.start));
  const vHalf = halves.find((x) => trackById(seq, x.trackId)?.kind === "video"), aHalf = halves.find((x) => trackById(seq, x.trackId)?.kind === "audio");
  const a = Math.round(c.source.in), b = a + c.duration;
  let s: Sequence = { ...seq, clips: seq.clips.filter((x) => !halves.includes(x)) };
  const inner = (kind: "video" | "audio") => tracksOf(ns, kind).filter((t) => ns.clips.some((x) => x.trackId === t.id && clipEnd(x) > a && x.start < b));
  const placed: TimelineClip[] = [];
  const idMap = new Map<string, string>();
  const links = new Map<string, string>();
  for (const [kind, half] of [["video", vHalf], ["audio", aHalf]] as const) {
    const used = inner(kind);
    if (!used.length) continue;
    const baseIdx = half ? trackById(seq, half.trackId)!.index : 0;
    const k0 = used[0].index;
    for (const t of used) {
      const want = baseIdx + (t.index - k0);
      while (tracksOf(s, kind).length <= want) s = addTrack(s, kind).seq;
      const dest = tracksOf(s, kind)[want];
      for (const x0 of ns.clips) {
        if (x0.trackId !== t.id || clipEnd(x0) <= a || x0.start >= b) continue;
        const r = sourceRate(x0, ns, ctx);
        let x = x0;
        if (x.start < a) x = trimStartBy(x, a - x.start, r, ns.fps);
        if (clipEnd(x) > b) x = trimEndBy(x, b - clipEnd(x), r);
        const from = half ?? c;
        const y: TimelineClip = { ...x, id: uid("c"), trackId: dest.id, start: c.start + (x.start - a), effects: [...x.effects, ...from.effects.map((e) => ({ ...e, id: uid("e") }))] };
        if (x.linkId) y.linkId = links.get(x.linkId) ?? (links.set(x.linkId, uid("l")), links.get(x.linkId)!);
        delete y.connectedTo; delete y.connectOffset;
        idMap.set(x0.id, y.id);
        placed.push(y);
      }
    }
  }
  s = placeClips(s, ctx, placed, "overwrite");
  const trackOf = new Map(placed.map((y) => [y.id, y.trackId]));
  const trs: Transition[] = ns.transitions.filter((t) => (!t.fromClipId || idMap.has(t.fromClipId)) && (!t.toClipId || idMap.has(t.toClipId)) && (t.fromClipId || t.toClipId))
    .map((t) => {
      const tr: Transition = { ...t, id: uid("t"), at: c.start + (t.at - a), trackId: trackOf.get(idMap.get((t.toClipId ?? t.fromClipId)!)!)! };
      if (t.fromClipId) tr.fromClipId = idMap.get(t.fromClipId); else delete tr.fromClipId;
      if (t.toClipId) tr.toClipId = idMap.get(t.toClipId); else delete tr.toClipId;
      return tr;
    });
  s = normalize({ ...s, transitions: [...s.transitions, ...trs] }, ctx);
  return { project: { ...p, sequences: p.sequences.map((x) => (x.id === seqId ? s : x)) }, clipIds: placed.map((y) => y.id) };
}
