/**
 * Auto SFX, the edit (docs/EDITOR.md §15.2): a plan plus its rendered sounds → the sequence with the sounds on the
 * SFX track (role "sfx", made when missing; a sound that would overlap another goes on "SFX 2", "SFX 3" …, so nothing
 * is ever cut or overwritten). Earlier auto SFX clips in the plan's range go first; the user's own clips are never
 * touched. Pure: the caller runs it inside ONE undo command.
 */
import { mediaSpan } from "../model/defaults.ts";
import { addTrack, clipEnd, clipsFromMedia, ctxOf, normalize, trackById, tracksOf } from "../model/ops.ts";
import type { EditProject, MediaItem, Sequence, TimelineClip, Track } from "../model/types.ts";
import { isRecordedId, sfxClipFrames } from "../sfx/index.ts";
import { contentEnd } from "./planner.ts";
import type { AutoSfxPlan, FrameRange, SfxPlacement } from "./types.ts";

/** The most SFX lanes auto SFX makes. */
export const MAX_LANES = 4;
/** A sound keeps this much after its moment before the next sound on its lane may cut its tail (with a fade). */
export const KEEP_TAIL_S = 1;
export const SFX_TRACK = "SFX";

/** One rendered file per preset, values and seed. */
export const sfxKey = (p: Pick<SfxPlacement, "presetId" | "values" | "seed">) =>
  `${p.presetId}|${Object.keys(p.values).sort().map((k) => `${k}=${p.values[k]}`).join(",")}|${p.seed}`;

export const isAutoSfx = (c: TimelineClip) => !!c.autoSfx;

const LANE_NAME = /^SFX(\s*\d+)?$/i;
/** An SFX lane: an audio track named SFX (or SFX 2 …) with role "sfx" (or no role yet). */
const isLane = (t: Track) => t.kind === "audio" && (t.role === "sfx" || !t.role) && LANE_NAME.test(t.name.trim());

/** The SFX lanes of a sequence that auto SFX may use (unlocked), lowest first. */
export function sfxLanes(seq: Sequence): Track[] {
  return tracksOf(seq, "audio").filter((t) => isLane(t) && !t.locked);
}

function newLane(seq: Sequence, n: number): { seq: Sequence; track: Track } {
  const r = addTrack(seq, "audio");
  const name = n === 0 ? SFX_TRACK : `${SFX_TRACK} ${n + 1}`;
  const s = { ...r.seq, tracks: r.seq.tracks.map((t) => (t.id === r.trackId ? { ...t, name, role: "sfx" as const, targeted: false } : t)) };
  return { seq: s, track: trackById(s, r.trackId)! };
}

/** Removes auto SFX clips (in a range, else all) from a sequence; locked tracks keep theirs. */
export function removeAutoSfxFrom(seq: Sequence, range?: FrameRange): { seq: Sequence; removed: number } {
  const gone = seq.clips.filter((c) => c.autoSfx && !trackById(seq, c.trackId)?.locked && (!range || (c.start < range.to && clipEnd(c) > range.from)));
  if (!gone.length) return { seq, removed: 0 };
  const ids = new Set(gone.map((c) => c.id));
  return { seq: { ...seq, clips: seq.clips.filter((c) => !ids.has(c.id)) }, removed: gone.length };
}

export function removeAutoSfx(project: EditProject, sequenceId: string, range?: FrameRange): { project: EditProject; removed: number } {
  const s = project.sequences.find((x) => x.id === sequenceId);
  if (!s) return { project, removed: 0 };
  const r = removeAutoSfxFrom(s, range);
  if (!r.removed) return { project, removed: 0 };
  const seq = normalize(r.seq, ctxOf(project));
  return { project: { ...project, sequences: project.sequences.map((x) => (x.id === seq.id ? seq : x)) }, removed: r.removed };
}

export interface BuildResult { project: EditProject; placed: number; removed: number; skipped: { id: string; reason: string }[]; trackIds: string[] }

/**
 * Places a plan's sounds. `mediaFor` gives each placement's rendered MediaItem (already in `project.media`); `only`
 * keeps just those placement ids (the dialog's checkboxes).
 */
export function buildAutoSfx(project: EditProject, plan: AutoSfxPlan, mediaFor: (p: SfxPlacement) => MediaItem | undefined, only?: Iterable<string>): BuildResult {
  const s0 = project.sequences.find((x) => x.id === plan.sequenceId);
  if (!s0) return { project, placed: 0, removed: 0, skipped: [{ id: "", reason: "The sequence isn't in the edit any more" }], trackIds: [] };
  const want = only ? new Set(only) : null;
  const ctx = ctxOf(project);
  const fps = s0.fps;
  const r = removeAutoSfxFrom(s0, plan.range);
  let seq = r.seq;
  const end = Math.max(1, contentEnd(seq));
  const skipped: BuildResult["skipped"] = [];
  const used = new Set<string>();
  let lanes = sfxLanes(seq);
  const added: TimelineClip[] = [];
  /** Where each placed sound's body ends: after that only its tail plays, which a later sound may cut. */
  const bodyEnd = new Map<string, number>();
  const busy = (t: Track, a: number, b: number) => [...seq.clips, ...added].some((c) => c.trackId === t.id && c.start < b && a < clipEnd(c));
  /** The auto sounds on a lane whose tails a sound at [a, b) would cut, or null when something else is in the way. */
  const tailsIn = (t: Track, a: number, b: number): TimelineClip[] | null => {
    if (seq.clips.some((c) => c.trackId === t.id && c.start < b && a < clipEnd(c))) return null;     // the user's own, or kept
    const hit = added.filter((c) => c.trackId === t.id && c.start < b && a < clipEnd(c));
    return hit.every((c) => c.start < a && (bodyEnd.get(c.id) ?? clipEnd(c)) <= a) ? hit : null;
  };
  const list = plan.placements.filter((p) => !want || want.has(p.id)).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  for (const p of list) {
    const m = mediaFor(p);
    if (!m) { skipped.push({ id: p.id, reason: "Its sound wasn't made" }); continue; }
    // a recording plays to its end: its length rounded up to whole frames (the procedural sounds keep their span)
    const real = isRecordedId(p.presetId) ? sfxClipFrames(m, fps, true) : mediaSpan(m, fps, 0, undefined).frames;
    let dur = p.trim ? Math.min(p.duration, real) : real;
    // lined up by the planned sound (a whoosh's `length`), not its file: a reverb tail after it doesn't move it
    const body = Math.max(1, Math.min(p.duration, dur));
    let start = p.align === "start" ? p.hit : p.align === "centre" ? p.hit - Math.floor(body / 2) : p.hit - body;
    let head = 0;
    if (start < 0) { head = -start; start = 0; dur -= head; }
    if (dur < 1) { skipped.push({ id: p.id, reason: "It would start before the sequence does" }); continue; }
    // never past the end of the edit's own content (a boom's tail doesn't make the sequence longer): cut with a fade
    let endFade = 0;
    if (start + dur > end) { dur = end - start; endFade = Math.min(Math.floor(dur / 2), Math.round(0.3 * fps)); }
    if (dur < 1) { skipped.push({ id: p.id, reason: "It starts where the sequence ends" }); continue; }
    let lane = lanes.find((t) => !busy(t, start, start + dur));
    if (!lane) {
      // a lane where only the tails of earlier sounds are in the way: they end where this one starts, with a fade
      for (const t of lanes) {
        const tails = tailsIn(t, start, start + dur);
        if (!tails) continue;
        for (const c of tails) {
          const i = added.indexOf(c), d = Math.max(1, start - c.start);
          added[i] = { ...c, duration: d, audio: { ...c.audio!, fadeOut: Math.min(Math.floor(d / 2), Math.max(c.audio!.fadeOut, Math.round(0.25 * fps))) } };
          bodyEnd.set(c.id, Math.min(bodyEnd.get(c.id) ?? clipEnd(added[i]), clipEnd(added[i])));
        }
        lane = t;
        break;
      }
    }
    if (!lane) {
      const n = tracksOf(seq, "audio").filter(isLane).length;
      if (n >= MAX_LANES) { skipped.push({ id: p.id, reason: `Every SFX track is busy there (${MAX_LANES} at most)` }); continue; }
      const made = newLane(seq, n);
      seq = made.seq;
      lanes = sfxLanes(seq);
      lane = made.track;
    }
    const srcRate = m.fps > 0 ? m.fps : fps;
    const cs = clipsFromMedia(seq, m, start, { audioTrackId: lane.id, video: false, audio: true, duration: dur, name: `SFX · ${p.label}`,
      range: { in: Math.round((head * srcRate) / fps) } });
    if (!cs.length) { skipped.push({ id: p.id, reason: "Its sound has no audio" }); continue; }
    const half = Math.floor(dur / 2);
    const c: TimelineClip = { ...cs[0], role: "sfx", autoSfx: { rule: p.rule, sourceId: p.sourceId },
      audio: { ...(cs[0].audio ?? { gain: { value: 0 }, pan: { value: 0 }, fadeIn: 0, fadeOut: 0 }), gain: { value: p.gainDb },
        fadeIn: Math.min(half, head ? Math.max(1, p.fadeIn) : p.fadeIn), fadeOut: Math.min(half, Math.max(p.fadeOut, endFade)) } };
    added.push(c);
    bodyEnd.set(c.id, Math.min(clipEnd(c), p.align === "start" ? Math.max(start, p.hit) + Math.round(KEEP_TAIL_S * fps)
      : Math.max(p.hit, start + body) + Math.round(0.3 * fps)));
    used.add(lane.id);
  }
  seq = normalize({ ...seq, clips: [...seq.clips, ...added] }, ctx);
  return { project: { ...project, sequences: project.sequences.map((x) => (x.id === seq.id ? seq : x)) }, placed: added.length, removed: r.removed, skipped,
    trackIds: [...used] };
}
