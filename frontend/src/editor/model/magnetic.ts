/**
 * Magnetic timeline (editor-motion, the Final Cut way). With `Sequence.magnetic` on, V1 is the primary storyline:
 * after every edit its clips close up from frame 0 (no gaps), and every clip on another track is connected to a V1
 * clip (`connectedTo` + `connectOffset`): when that clip moves, the connected clip moves with it. A clip the edit
 * itself moved (or a new one) connects to the V1 clip under its start. The A/V halves of a V1 clip move with it.
 * A connected clip that lands on a busy stretch of its track goes up to the next free track of its kind (a new track
 * when none is free). The store runs `magnetizeProject` after every command and drag step. Pure.
 */
import { addTrack, byStart, clipEnd, normalize, tracksOf, type Ctx } from "./ops.ts";
import type { EditProject, Sequence, TimelineClip } from "./types.ts";

/** The primary storyline's track (V1). */
export const primaryTrackId = (seq: Sequence): string | undefined => tracksOf(seq, "video")[0]?.id;

/** The V1 clip a clip at `frame` hangs from: the one covering it, else the last one before it, else the first. */
function parentAt(primary: TimelineClip[], frame: number): TimelineClip | undefined {
  if (!primary.length) return undefined;
  let best: TimelineClip | undefined;
  for (const v of primary) {
    if (v.start <= frame && frame < clipEnd(v)) return v;
    if (v.start <= frame) best = v;
  }
  return best ?? primary[0];
}

/**
 * The sequence after an edit, made magnetic: `before` is the sequence the edit started from (undefined when the mode
 * was just turned on), `after` what the edit made.
 */
export function magnetize(before: Sequence | undefined, after: Sequence, ctx: Ctx): Sequence {
  if (!after.magnetic) return after;
  const P = primaryTrackId(after);
  if (!P) return after;
  const prev = new Map((before?.clips ?? []).map((c) => [c.id, c]));
  const primary = after.clips.filter((c) => c.trackId === P).sort(byStart);
  const pIds = new Set(primary.map((c) => c.id));
  // the halves of V1 clips (same link, same start): they move with their V1 clip
  const halfOf = new Map<string, string>();
  for (const v of primary) {
    if (!v.linkId) continue;
    for (const c of after.clips) if (!pIds.has(c.id) && c.linkId === v.linkId && c.start === v.start) halfOf.set(c.id, v.id);
  }
  // 1. close the storyline up from 0
  const packed = new Map<string, number>();
  let t = 0;
  for (const v of primary) { packed.set(v.id, t); t += v.duration; }
  const startOf = (id: string) => packed.get(id)!;
  // 2. where every other clip goes
  const target = new Map<string, { start: number; parent?: string; offset?: number }>();
  for (const c of after.clips) {
    if (pIds.has(c.id)) continue;
    const h = halfOf.get(c.id);
    if (h) { target.set(c.id, { start: startOf(h) }); continue; }
    const was = prev.get(c.id);
    const untouched = !!was && was.start === c.start && was.trackId === c.trackId;
    const keep = untouched && c.connectedTo && pIds.has(c.connectedTo) ? c.connectedTo : undefined;
    if (keep) {
      // the edit left it alone: it rides with its V1 clip (offset as stored, else as it was before the edit)
      const pb = prev.get(keep);
      const off = c.connectOffset ?? (pb ? c.start - pb.start : c.start - after.clips.find((x) => x.id === keep)!.start);
      target.set(c.id, { start: Math.max(0, startOf(keep) + off), parent: keep });
      continue;
    }
    const par = parentAt(primary, c.start);
    if (!par) { target.set(c.id, { start: c.start }); continue; }
    target.set(c.id, { start: Math.max(0, startOf(par.id) + (c.start - par.start)), parent: par.id });
  }
  let seq: Sequence = after;
  const clips: TimelineClip[] = after.clips.map((c) => {
    if (pIds.has(c.id)) { const s = startOf(c.id); const x = s === c.start ? c : { ...c, start: s }; return strip(x); }
    const tg = target.get(c.id)!;
    const x: TimelineClip = { ...c, start: tg.start };
    if (tg.parent) { x.connectedTo = tg.parent; x.connectOffset = tg.start - startOf(tg.parent); } else { delete x.connectedTo; delete x.connectOffset; }
    return halfOf.has(c.id) ? strip(x) : x;
  });
  seq = { ...seq, clips };
  // 3. two clips on one stretch of a track: the one that moved (never a V1 clip's half) goes up to a free track
  const was = new Map(after.clips.map((c) => [c.id, c.start]));
  const moved = (c: TimelineClip) => c.start !== was.get(c.id);
  for (let guard = 0; guard < 500; guard++) {
    let clash: [TimelineClip, TimelineClip] | null = null;
    for (const tk of seq.tracks) {
      if (tk.id === P) continue;
      const cs = seq.clips.filter((c) => c.trackId === tk.id).sort(byStart);
      for (let i = 1; i < cs.length && !clash; i++) if (cs[i].start < clipEnd(cs[i - 1])) clash = [cs[i - 1], cs[i]];
      if (clash) break;
    }
    if (!clash) break;
    const [x, y] = clash;
    const rank = (c: TimelineClip) => (halfOf.has(c.id) ? 0 : moved(c) ? 2 : 1);
    const c = rank(y) >= rank(x) ? y : x;
    const tk = seq.tracks.find((t) => t.id === c.trackId)!;
    const free = (trackId: string) => !seq.clips.some((o) => o.id !== c.id && o.trackId === trackId && o.start < clipEnd(c) && c.start < clipEnd(o));
    let dest = tracksOf(seq, tk.kind).find((t) => t.index > tk.index && !t.locked && t.id !== P && free(t.id));
    if (!dest) { const r = addTrack(seq, tk.kind); seq = r.seq; dest = seq.tracks.find((t) => t.id === r.trackId)!; }
    const did = dest.id;
    seq = { ...seq, clips: seq.clips.map((o) => (o.id === c.id ? { ...o, trackId: did } : o)) };
  }
  return normalize(seq, ctx);
}

function strip(c: TimelineClip): TimelineClip {
  if (c.connectedTo === undefined && c.connectOffset === undefined) return c;
  const x = { ...c };
  delete x.connectedTo; delete x.connectOffset;
  return x;
}

/** magnetize() for every magnetic sequence a command changed. */
export function magnetizeProject(before: EditProject, after: EditProject, ctx: Ctx): EditProject {
  if (!after.sequences.some((s) => s.magnetic)) return after;
  let changed = false;
  const sequences = after.sequences.map((s) => {
    if (!s.magnetic) return s;
    const b = before.sequences.find((x) => x.id === s.id);
    if (b === s) return s;
    const n = magnetize(b?.magnetic ? b : undefined, s, ctx);
    if (n !== s) changed = true;
    return n;
  });
  return changed ? { ...after, sequences } : after;
}

/** True when the clip moves with a V1 clip (for the timeline's connection marks). */
export const isConnected = (c: TimelineClip) => !!c.connectedTo;
