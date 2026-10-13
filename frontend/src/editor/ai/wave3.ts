/**
 * Pure document work for the wave 3 AI tools (docs/EDITOR.md §10): the transcript the tools read (caption tracks),
 * highlights as new 9:16 sequences, B-roll ideas matched against the bin, scenes for a mood per scene, mood markers,
 * and edit backups (what goes up, and how a restored copy merges with what is open). No React and no I/O, so
 * `node --test` runs it as written.
 */
import { uid } from "../model/ids.ts";
import { addGenerated, addMarker, addTrack, clipEnd, ctxOf, extract, lift, normalize, seqEnd, tracksOf } from "../model/ops.ts";
import { framesToSeconds, secondsToFrames } from "../model/time.ts";
import type { EditProject, MediaItem, Param, Sequence, TimelineClip } from "../model/types.ts";
import { titleSpec } from "./commands.ts";
import type { Highlight, Segment } from "./types.ts";

const r3 = (v: number) => Math.round(v * 1000) / 1000;

// ── moods (the studio's names; editor-looks' Moods share them, any other name works too) ──────────────

export const MOOD_NAMES: { id: string; label: string }[] = [
  "cinematic", "warm", "romantic", "joyful", "festive", "playful", "hopeful", "calm", "dreamy", "nostalgic", "melancholy",
  "tense", "suspense", "mysterious", "horror", "action", "epic", "energetic", "dramatic", "devotional", "noir", "gritty",
].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));

// ── the transcript ───────────────────────────────────────────────────────────

/** The caption track a tool reads: the first one made (lowest video track named "Captions…"), or null. */
export function captionTrackId(seq: Sequence): string | null {
  const t = tracksOf(seq, "video").find((x) => /^captions\b/i.test(x.name) && seq.clips.some((c) => c.trackId === x.id && c.source.type === "title"));
  return t?.id ?? null;
}

/** Caption cues (timeline frames) → transcript lines in sequence seconds, in order. */
export function cuesToSegments(cues: { start: number; end: number; text: string }[], fps: number): Segment[] {
  return cues.filter((c) => c.text.trim() && c.end > c.start).sort((a, b) => a.start - b.start)
    .map((c) => ({ start: r3(framesToSeconds(c.start, fps)), end: r3(framesToSeconds(c.end, fps)), text: c.text.trim().slice(0, 2000) }));
}

/** The sequence's transcript: its caption track's lines (title clips), else the given cues (the last captions made). */
export function transcriptOf(seq: Sequence, fallback?: { start: number; end: number; text: string }[] | null): Segment[] {
  const tid = captionTrackId(seq);
  if (tid) {
    const cues = seq.clips.filter((c) => c.trackId === tid && c.source.type === "title" && c.enabled)
      .map((c) => ({ start: c.start, end: clipEnd(c), text: c.source.type === "title" ? c.source.text.text : "" }));
    return cuesToSegments(cues, seq.fps);
  }
  return fallback?.length ? cuesToSegments(fallback, seq.fps) : [];
}

/** The transcript's words between two sequence frames (a scene's summary). */
export function textBetween(segments: Segment[], a: number, b: number, fps: number, limit = 600): string {
  const s = framesToSeconds(a, fps), e = framesToSeconds(b, fps);
  return segments.filter((x) => x.start < e && s < x.end).map((x) => x.text).join(" ").slice(0, limit);
}

// ── highlights → Shorts ──────────────────────────────────────────────────────

/** How much a picture of `pic` must be scaled (percent of "fitted") to cover a `to` frame: 100 when it already does. */
export function coverScale(pic: { width: number; height: number }, to: { width: number; height: number }): number {
  if (!(pic.width > 0 && pic.height > 0)) return 100;
  const sx = to.width / pic.width, sy = to.height / pic.height;
  return Math.round((Math.max(sx, sy) / Math.min(sx, sy)) * 1000) / 10;
}

const mapParam = <T>(p: Param<T>, f: (v: T) => T): Param<T> => ({ ...p, value: f(p.value), ...(p.keyframes ? { keyframes: p.keyframes.map((k) => ({ ...k, value: f(k.value) })) } : {}) });

/**
 * One highlight as its own sequence: the source sequence's frames [a, b) (every track, starting at 0), in a vertical
 * frame (1080×1920 by default). Full-frame pictures are scaled to fill it (centre crop), picture-in-picture keeps its
 * size; positions keep their place. The hook goes on top as a title inside the safe area (clear of the platform's
 * buttons and captions). Ids are new.
 */
export function highlightSequence(p: EditProject, src: Sequence, range: [number, number], opts: { name: string; width?: number; height?: number;
  hook?: string; hookSeconds?: number } = { name: "Short" }): Sequence {
  const ctx = ctxOf(p);
  const W = opts.width ?? 1080, H = opts.height ?? 1920;
  const [a, b] = [Math.max(0, Math.round(range[0])), Math.max(Math.round(range[0]) + 1, Math.round(range[1]))];
  let s: Sequence = { ...structuredClone(src), tracks: src.tracks.map((t) => ({ ...t, locked: false, syncLock: true })) };
  const all = s.tracks.map((t) => t.id);
  const end = seqEnd(s);
  if (b < end) s = lift(s, ctx, b, end + 1, all);
  if (a > 0) s = extract(s, ctx, 0, a, all);
  // fresh ids (two sequences never share a track, clip or link id)
  const tmap = new Map(s.tracks.map((t) => [t.id, uid(t.kind === "video" ? "v" : "a")]));
  const cmap = new Map(s.clips.map((c) => [c.id, uid("c")]));
  const lmap = new Map<string, string>();
  const link = (l?: string) => (l ? (lmap.get(l) ?? (lmap.set(l, uid("l")), lmap.get(l)!)) : undefined);
  const media = new Map(p.media.map((m) => [m.id, m]));
  const fit = (c: TimelineClip): TimelineClip => {
    const out: TimelineClip = { ...c, id: cmap.get(c.id)!, trackId: tmap.get(c.trackId)!, linkId: link(c.linkId) };
    if (!out.linkId) delete out.linkId;
    const kind = s.tracks.find((t) => t.id === c.trackId)?.kind;
    if (kind !== "video") return out;
    const m = c.source.type === "media" ? media.get(c.source.mediaId) : undefined;
    const pic = m && m.kind !== "audio" && m.width > 0 ? { width: m.width, height: m.height } : { width: src.width, height: src.height };
    // a picture that filled the frame fills the vertical one (centre crop); a picture-in-picture keeps its size
    const sc = c.motion.scale;
    const full = c.source.type !== "title" && Math.max(sc.value, ...(sc.keyframes ?? []).map((x) => x.value)) >= 99;
    const k = full ? coverScale(pic, { width: W, height: H }) / 100 : 1;
    return { ...out, motion: { ...c.motion,
      position: mapParam(c.motion.position, ([x, y]) => [r3((x / src.width) * W), r3((y / src.height) * H)] as [number, number]),
      scale: mapParam(c.motion.scale, (v) => r3(v * k)) } };
  };
  s = {
    ...s, id: uid("s"), name: opts.name.slice(0, 120), width: W, height: H, playhead: 0, inPoint: undefined, outPoint: undefined,
    workArea: { zoom: 0, scroll: 0 },
    tracks: s.tracks.map((t) => ({ ...t, id: tmap.get(t.id)! })),
    clips: s.clips.map(fit),
    transitions: s.transitions.map((t) => ({ ...t, id: uid("t"), trackId: tmap.get(t.trackId) ?? t.trackId,
      ...(t.fromClipId ? { fromClipId: cmap.get(t.fromClipId) ?? t.fromClipId } : {}), ...(t.toClipId ? { toClipId: cmap.get(t.toClipId) ?? t.toClipId } : {}) })),
    markers: src.markers.filter((m) => m.frame >= a && m.frame < b).map((m) => ({ ...m, id: uid("m"), frame: m.frame - a })),
  };
  delete s.inPoint;
  delete s.outPoint;
  delete s.source;
  if (opts.hook?.trim()) {
    const len = Math.min(b - a, Math.max(1, secondsToFrames(opts.hookSeconds ?? 3, s.fps)));
    const r = addTrack(s, "video");
    s = { ...r.seq, tracks: r.seq.tracks.map((t) => (t.id === r.trackId ? { ...t, name: "Hook" } : t)) };
    const spec = { ...titleSpec(opts.hook.trim().slice(0, 140), s, "top"), box: [0.08, 0.12, 0.84, 0.14] as [number, number, number, number],
      size: Math.round(H * 0.04), background: { color: "#000000a0", padding: 18, radius: 12 }, animIn: "pop" as const, animOut: "fade" as const };
    s = addGenerated(s, ctx, r.trackId, 0, len, { type: "title", text: spec }, "Hook").seq;
  }
  return normalize(s, ctx);
}

/** Highlights (sequence seconds) → frame ranges inside the sequence. */
export function highlightRange(h: Highlight, seq: Sequence): [number, number] | null {
  const end = seqEnd(seq);
  const a = Math.max(0, secondsToFrames(h.start, seq.fps)), b = Math.min(end, secondsToFrames(h.end, seq.fps));
  return b > a ? [a, b] : null;
}

/** Each picked highlight as a new vertical sequence, named after the source and the title. */
export function shortsFrom(p: EditProject, seq: Sequence, picks: Highlight[], size = { width: 1080, height: 1920 }): Sequence[] {
  const out: Sequence[] = [];
  picks.forEach((h, i) => {
    const r = highlightRange(h, seq);
    if (r) out.push(highlightSequence(p, seq, r, { name: `${seq.name} · Short ${i + 1}${h.title ? `: ${h.title}` : ""}`, ...size, hook: h.hook || h.title }));
  });
  return out;
}

// ── B-roll ideas ─────────────────────────────────────────────────────────────

const STOP = new Set(["the", "and", "with", "from", "into", "over", "under", "slow", "shot", "close", "wide", "cinematic", "natural",
  "light", "push", "camera", "cutaway", "illustrating", "a", "an", "of", "on", "in", "at", "to", "for", "this", "that", "its"]);
const tokens = (t: string) => (t.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w));

/** Media in the bin that may already show an idea: its name, comment or bin name share words with the prompt. */
export function findInBin(p: EditProject, prompt: string, limit = 6): { item: MediaItem; score: number }[] {
  const want = new Set(tokens(prompt));
  if (!want.size) return [];
  const bins = new Map(p.bins.map((b) => [b.id, b.name]));
  return p.media.filter((m) => m.kind !== "audio" && !m.missing)
    .map((m) => {
      const have = new Set(tokens(`${m.name.replace(/\.[a-z0-9]{2,4}$/i, "")} ${m.comment ?? ""} ${m.binId ? bins.get(m.binId) ?? "" : ""}`));
      let score = 0;
      for (const w of want) if (have.has(w) || [...have].some((h) => h.length > 4 && (h.startsWith(w) || w.startsWith(h)))) score++;
      return { item: m, score };
    })
    .filter((x) => x.score > 0).sort((x, y) => y.score - x.score || x.item.name.localeCompare(y.item.name)).slice(0, limit);
}

// ── a mood per scene ─────────────────────────────────────────────────────────

export interface SceneRange { id: string; title: string; emotion: string; summary: string; start: number; end: number }

/** The studio scenes of an imported episode on the sequence (their shots' clips are named after the shot codes). */
export function scenesFromEpisode(seq: Sequence, scenes: { id: number | string; title: string; emotion: string; summary: string; shot_codes: string[] }[]): SceneRange[] {
  const vids = new Set(tracksOf(seq, "video").map((t) => t.id));
  const out: SceneRange[] = [];
  for (const sc of scenes) {
    const codes = new Set(sc.shot_codes);
    const cs = seq.clips.filter((c) => vids.has(c.trackId) && codes.has(c.name));
    if (!cs.length) continue;
    out.push({ id: String(sc.id), title: sc.title, emotion: sc.emotion, summary: sc.summary,
      start: Math.min(...cs.map((c) => c.start)), end: Math.max(...cs.map(clipEnd)) });
  }
  return out.sort((x, y) => x.start - y.start);
}

/** Scenes from the sequence's markers (each runs to the next marker), else from the clips on V1. */
export function scenesFromTimeline(seq: Sequence, transcript: Segment[] = []): SceneRange[] {
  const end = seqEnd(seq);
  if (!end) return [];
  const ms = [...seq.markers].filter((m) => m.frame < end).sort((a, b) => a.frame - b.frame);
  let rows: { start: number; end: number; title: string; note: string }[];
  if (ms.length) {
    const starts = ms[0].frame > 0 ? [{ frame: 0, name: "Opening", comment: "" }, ...ms] : ms;
    rows = starts.map((m, i) => ({ start: m.frame, end: i + 1 < starts.length ? starts[i + 1].frame : end, title: m.name || `Scene ${i + 1}`, note: m.comment ?? "" }));
  } else {
    const v1 = tracksOf(seq, "video")[0];
    rows = seq.clips.filter((c) => c.trackId === v1?.id).sort((a, b) => a.start - b.start)
      .map((c) => ({ start: c.start, end: clipEnd(c), title: c.name || "Clip", note: "" }));
  }
  return rows.filter((r) => r.end > r.start).slice(0, 200).map((r, i) => ({
    id: `scene_${i + 1}`, title: r.title.slice(0, 200), emotion: "", start: r.start, end: r.end,
    summary: [r.note, textBetween(transcript, r.start, r.end, seq.fps)].filter(Boolean).join(" · ").slice(0, 2000),
  }));
}

/** "Mood: <name>" markers at each scene's start (the why in the comment). */
export function moodMarkers(p: EditProject, seqId: string, scenes: SceneRange[], picks: { scene_id: string; mood: string; why: string }[]): EditProject {
  const seq = p.sequences.find((s) => s.id === seqId);
  if (!seq) return p;
  let markers = seq.markers;
  for (const pick of picks) {
    const sc = scenes.find((x) => x.id === pick.scene_id);
    if (!sc) continue;
    markers = addMarker(markers.filter((m) => !(m.frame === sc.start && m.name.startsWith("Mood: "))), sc.start,
      { name: `Mood: ${pick.mood}`, color: "#a78bfa", kind: "scene", ...(pick.why ? { comment: pick.why.slice(0, 300) } : {}) });
  }
  return { ...p, sequences: p.sequences.map((s) => (s.id === seqId ? { ...s, markers } : s)) };
}

// ── backups ──────────────────────────────────────────────────────────────────

const RUNTIME_MEDIA = ["url", "proxyUrl"] as const;

/** The edit as it is backed up: runtime-only links left out. */
export function backupDoc(p: EditProject): EditProject {
  return { ...p, media: p.media.map((m) => { const x = { ...m }; for (const k of RUNTIME_MEDIA) delete x[k]; return x; }) };
}

/**
 * A restored copy over the open edit: its content, with the open edit's id, studio project and the links of media
 * still in it (so what's on this PC keeps playing).
 */
export function restoredProject(current: EditProject, restored: EditProject): EditProject {
  const have = new Map(current.media.map((m) => [m.id, m]));
  const media = restored.media.map((m) => {
    const h = have.get(m.id);
    if (!h || h.path !== m.path) return m;
    return { ...m, url: h.url, proxyUrl: h.proxyUrl, thumb: h.thumb ?? m.thumb, filmstrip: h.filmstrip ?? m.filmstrip, peaks: h.peaks ?? m.peaks };
  });
  const seqIds = new Set(restored.sequences.map((s) => s.id));
  return { ...restored, id: current.id, studioProjectId: current.studioProjectId ?? restored.studioProjectId, media,
    activeSequenceId: seqIds.has(restored.activeSequenceId) ? restored.activeSequenceId : restored.sequences[0]?.id ?? current.activeSequenceId };
}
