/**
 * The audio tools' commands (docs/EDITOR.md §15.4), each change one undo step: auto mix (measure → dry-run plan →
 * apply), room-tone fill and removal, the breath remover (detect → apply gain keyframes) and the visualiser (add from
 * an audio clip, change its settings). Importing this module also connects the visualiser's spectrum cache to the
 * desktop (or the page's own analysis) and redraws the program monitor when frames arrive.
 */
import { toast } from "sonner";
import { addGenerated, addTrack, clipById, clipEnd, removeClips, tracksOf, updateClips, updateSequence } from "../model/ops";
import { secondsToFrames } from "../model/time";
import type { Sequence, TimelineClip } from "../model/types";
import { readProgramFrame } from "../moods/programTap";
import { program } from "../playback/transport";
import { ed, exec, project, select, seq, seqExec, setUrls } from "../store";
import { analyzeBreaths, analyzeRoomTone, clipLoudness, clipRange, loadSpectrum } from "./analysis";
import { applyAutoMix, autoMixClips, planAutoMix, roleOf, type AutoMixPlan } from "./automix";
import type { BreathRange } from "./breaths";
import { breathGain, breathsInClip, removeRoomTone, roomToneFill, trackGaps } from "./edits";
import type { RoomTone } from "./roomtone";
import { onSpectra, requestSpectrum, setSpectrumLoader } from "./source";
import { makeVisualizerSource, visualizerSettings, type VisualizerSource } from "./visualizer";

// the visualiser's frames: from the desktop's sidecar (or decoded here), and a redraw when they arrive
setSpectrumLoader((r) => loadSpectrum(r.mediaId, r.fps, r.bands).catch(() => null));
let redrawQueued = false;
onSpectra(() => {
  if (redrawQueued) return;
  redrawQueued = true;
  // a fresh urls object makes the program monitor rebuild its composition and draw again
  window.setTimeout(() => { redrawQueued = false; setUrls({}); }, 30);
});

const selectedIds = () => new Set(ed().selection);

// ── auto mix ───────────────────────────────────────────────────────────────────────────────────────────────

/** Measures the clips (all audio clips, or the selected ones) and returns the dry run. */
export async function planMix(target: number, onlySelected: boolean, progress?: (done: number, total: number) => void): Promise<AutoMixPlan> {
  const s = seq();
  const sel = selectedIds();
  const clips = autoMixClips(s, onlySelected ? s.clips.filter((c) => sel.has(c.id)).map((c) => c.id) : undefined).filter((c) => roleOf(s, c));
  const measured: Record<string, number | null> = {};
  let done = 0;
  // the same stretch of the same media is measured once
  const memo = new Map<string, Promise<number | null>>();
  for (const c of clips) {
    const r = clipRange(c);
    const k = r ? `${r.media.id}|${r.in.toFixed(3)}|${r.out.toFixed(3)}` : c.id;
    let p = memo.get(k);
    if (!p) { p = clipLoudness(c).catch(() => null); memo.set(k, p); }
    measured[c.id] = await p;
    progress?.(++done, clips.length);
  }
  return planAutoMix(s, measured, { target, ids: onlySelected ? [...sel] : undefined });
}

export function applyMix(plan: AutoMixPlan) {
  if (!plan.rows.length) { toast.message("Nothing to change"); return; }
  seqExec(`Auto mix (${plan.target} LUFS)`, (s, c) => applyAutoMix(s, c, plan));
  toast.success(`Auto mix: ${plan.rows.length} clip${plan.rows.length > 1 ? "s" : ""} set${plan.ducking ? "; music ducks under the dialogue in the export" : ""}`);
}

// ── room tone ──────────────────────────────────────────────────────────────────────────────────────────────

/** The dialogue clip the room-tone and breath tools work on: the selected audio clip, else the first dialogue clip. */
export function dialogueClip(s: Sequence = seq()): TimelineClip | undefined {
  const sel = selectedIds();
  const audio = new Set(tracksOf(s, "audio").map((t) => t.id));
  const media = s.clips.filter((c) => audio.has(c.trackId) && c.source.type === "media" && !c.roomTone);
  return media.find((c) => sel.has(c.id)) ?? media.find((c) => roleOf(s, c) === "dialogue");
}

export async function findRoomToneFor(clipId: string): Promise<{ stretch: RoomTone | null; thresholdDb: number; gaps: number } | null> {
  const s = seq(), c = clipById(s, clipId);
  const r = c ? clipRange(c) : null;
  if (!c || !r) return null;
  const res = await analyzeRoomTone(r.media);
  if (!res) return null;
  return { ...res, gaps: trackGaps(s, c.trackId).length };
}

export function fillRoomTone(clipId: string, stretch: { start: number; end: number }) {
  const s = seq(), c = clipById(s, clipId);
  if (!c || c.source.type !== "media") return;
  const mediaId = c.source.mediaId;
  const gain = c.audio?.gain.keyframes?.length ? c.audio.gain.keyframes[0].value : c.audio?.gain.value ?? 0;
  let res: ReturnType<typeof roomToneFill> | null = null;
  seqExec("Room-tone fill", (sq, cx) => { res = roomToneFill(sq, cx, { trackId: c.trackId, mediaId, stretch, gainDb: gain }); return res.seq; });
  const r = res as ReturnType<typeof roomToneFill> | null;
  if (r?.error) toast.error(r.error);
  else if (r && !r.gaps) toast.message("No gaps between the cuts on that track");
  else if (r) toast.success(`Room tone in ${r.gaps} gap${r.gaps > 1 ? "s" : ""} (${r.clips} clip${r.clips > 1 ? "s" : ""})`);
}

export function clearRoomTone(trackId?: string) {
  const n = seq().clips.filter((c) => c.roomTone && (!trackId || c.trackId === trackId)).length;
  if (!n) { toast.message("There's no room tone to remove"); return; }
  seqExec("Remove room tone", (s, c) => removeRoomTone(s, c, trackId));
}

// ── breaths ────────────────────────────────────────────────────────────────────────────────────────────────

export async function detectBreathsFor(clipId: string, threshold: number) {
  const c = clipById(seq(), clipId);
  const r = c ? clipRange(c) : null;
  if (!c || !r) return null;
  return analyzeBreaths(r.media, { in: r.in, out: r.out }, threshold);
}

/** Lowers the breaths (media seconds) on the clip by `amount` dB (or mutes them): one undo step. `speech` (from the
 *  analysis) keeps the ramps off the words. */
export function applyBreaths(clipId: string, breaths: BreathRange[], amount: number | "mute", speech: { start: number; end: number }[] = []) {
  const s = seq(), c = clipById(s, clipId);
  const r = c ? clipRange(c) : null;
  if (!c || !r || !c.audio || !breaths.length) return;
  const ranges = breathsInClip(breaths, c, r.in, s.fps, speech);
  const ramp = Math.max(1, secondsToFrames(0.02, s.fps));
  seqExec(`Remove breaths (${breaths.length})`, (sq, cx) => updateClips(sq, cx, [clipId], (x) => (x.audio
    ? { ...x, audio: { ...x.audio, gain: breathGain(x.audio.gain, ranges, amount, x.duration, ramp) } } : x)));
  toast.success(`${breaths.length} breath${breaths.length > 1 ? "s" : ""} ${amount === "mute" ? "muted" : `lowered by ${Math.abs(amount)} dB`}`);
}

// ── visualiser ─────────────────────────────────────────────────────────────────────────────────────────────

/** The audio clip a new visualiser follows: the selected one, else the one under `frame` (lowest track first). */
export function visualizerAudio(frame = program.frame, s: Sequence = seq()): TimelineClip | undefined {
  const sel = selectedIds();
  const audio = tracksOf(s, "audio");
  const ok = (c: TimelineClip) => audio.some((t) => t.id === c.trackId) && c.source.type === "media" && !c.roomTone;
  const picked = s.clips.find((c) => sel.has(c.id) && ok(c));
  if (picked) return picked;
  for (const t of audio) {
    const c = s.clips.find((x) => x.trackId === t.id && ok(x) && x.start <= frame && frame < clipEnd(x));
    if (c) return c;
  }
  return s.clips.find(ok);
}

/** A video track free over [at, at + len), above V1 when there is one (new track else). */
function freeVideoTrack(s: Sequence, at: number, len: number): { seq: Sequence; trackId: string } {
  const vs = tracksOf(s, "video");
  const free = (id: string) => !s.clips.some((c) => c.trackId === id && c.start < at + len && clipEnd(c) > at);
  const t = vs.filter((x) => x.index > 0 && !x.locked).find((x) => free(x.id)) ?? (vs.length === 1 && free(vs[0].id) && !vs[0].locked ? vs[0] : undefined);
  if (t) return { seq: s, trackId: t.id };
  const r = addTrack(s, "video");
  return { seq: r.seq, trackId: r.trackId };
}

/**
 * Adds a visualiser that follows an audio clip, over that clip's length (from `at` when given: a drop), on a free
 * video track (or `trackId`). The spectrum is computed first, so the preview has its frames. Returns the clip id.
 */
export async function addVisualizer(opts: { audioClipId?: string; at?: number; trackId?: string; style?: VisualizerSource["style"]; colors?: string[] } = {}): Promise<string | null> {
  const s0 = seq();
  const a = opts.audioClipId ? clipById(s0, opts.audioClipId) : visualizerAudio(opts.at ?? program.frame, s0);
  if (!a || a.source.type !== "media") { toast.message("Add or select an audio clip first: the visualiser draws its sound"); return null; }
  const mediaId = a.source.mediaId;
  const t = toast.loading("Analysing the sound for the visualiser…");
  const spec = await requestSpectrum(mediaId, s0.fps, visualizerSettings({}).bands).catch(() => null);
  toast.dismiss(t);
  if (!spec) toast.message("The visualiser's frames aren't ready: it will draw once they are");
  const at = Math.max(0, opts.at ?? a.start);
  const len = Math.max(1, (opts.at !== undefined ? clipEnd(a) - at : a.duration) || secondsToFrames(10, s0.fps));
  const src = makeVisualizerSource({ audioClipId: a.id, ...(opts.style ? { style: opts.style } : {}), ...(opts.colors ? { colors: opts.colors } : {}) });
  let id: string | null = null;
  exec("Add audio visualiser", (p) => updateSequence(p, p.activeSequenceId, (s, c) => {
    const tr = opts.trackId && s.tracks.some((x) => x.id === opts.trackId && x.kind === "video") ? { seq: s, trackId: opts.trackId } : freeVideoTrack(s, at, len);
    // a generated clip placed with overwrite, like the editor's titles and mattes
    const r = addGenerated(tr.seq, c, tr.trackId, at, len, src, "Audio visualiser");
    id = r.clipId;
    return r.seq;
  }));
  if (id) select([id]);
  return id;
}

/** Changes a visualiser's settings (drags of one control coalesce into one undo step). */
export function updateVisualizer(clipId: string, patch: Partial<Omit<VisualizerSource, "type">>, coalesce?: string) {
  seqExec("Visualiser settings", (s, c) => updateClips(s, c, [clipId], (x) => (x.source.type === "visualizer" ? { ...x, source: { ...x.source, ...patch } } : x)), coalesce);
}

export const removeClip = (id: string) => seqExec("Delete clip", (s, c) => removeClips(s, c, [id]));
export const projectMedia = (id: string) => project().media.find((m) => m.id === id);

// automation (QA drivers over CDP), opt-in per browser profile like the editor's own `__tatvamEditor`
try {
  if (typeof window !== "undefined" && localStorage.getItem("tatvam-editor:debug") === "1") {
    (window as unknown as Record<string, unknown>).__tatvamAudioTools = {
      planMix, applyMix, dialogueClip, findRoomToneFor, fillRoomTone, clearRoomTone, detectBreathsFor, applyBreaths, addVisualizer, updateVisualizer,
      requestSpectrum, readProgramFrame,
    };
  }
} catch { /* storage blocked */ }
