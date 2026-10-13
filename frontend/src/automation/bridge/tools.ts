/**
 * The editor window's side of the assistant tools (docs/EDITOR.md §13.2): each tool call from the main process runs
 * here, on the open edit, through the store's commands, labelled "Assistant: <tool>" so the user sees it in History
 * and Ctrl+Z undoes it. Answers are short text for a model (times in seconds AND timecode) plus structured data.
 */
import { captionStyle, titleSpec } from "../../editor/ai/commands";
import { AUDIO_FX, audioFxDefaults, audioFxId, audioFxType } from "../../editor/audiofx/registry";
import { listTransitions } from "../../editor/engine";
import { makeEffect, videoEffects } from "../../editor/effects";
import { defaultTitle } from "../../editor/model/defaults";
import { uid } from "../../editor/model/ids";
import {
  addGenerated, addMarker, addTransition, clipEnd, clipsFromMedia, moveClips, placeClips, razor, removeClips, rippleDelete, seqEnd, setSpeed,
  targetTracks, tracksOf, trimClip, updateClips, updateSequence, withLinked, type Ctx,
} from "../../editor/model/ops";
import { withParam } from "../../editor/model/params";
import { framesToSeconds, secondsToFrames, toTimecode } from "../../editor/model/time";
import type { EditProject, Keyframe, MediaItem, Param, Sequence, TimelineClip, Track } from "../../editor/model/types";
import { applyMood } from "../../editor/moods/apply";
import { templateSpec, titleTemplates } from "../../editor/templates/titles";
import { resolveUrls, save } from "../../editor/session";
import { ed, exec, project, redo, seq, undo, urlFor } from "../../editor/store";
import { moodById, MOODS } from "../../lib/moods";
import type { AnalyzeMediaRef, AssistantCall, MediaAnalysis } from "../../lib/desktop";
import { buildAutoEdit, describePlan, planAutoEdit, type AutoEditOptions, type Plan, type PlanMedia } from "../autoedit";
import { renderProgramFrame } from "./frame";
import { runAiTool, aiToolsInfo } from "./ai";
import { captionClipIds, clearCaptionBand } from "./layout";


export interface PageReply { text: string; data?: Record<string, unknown>; image?: { data: string; mimeType: string } }
export interface PageEnv { navigate(url: string): void }
type Args = Record<string, unknown>;
type Tool = (a: Args, call: AssistantCall, env: PageEnv) => Promise<PageReply> | PageReply;

// ── helpers ──────────────────────────────────────────────────────────────────

const r2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: unknown, name: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
};
const optNum = (v: unknown) => (v === undefined || v === null ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const F = (s: Sequence, sec: number) => secondsToFrames(Math.max(0, sec), s.fps);
const S = (s: Sequence, f: number) => r2(framesToSeconds(f, s.fps));
const tc = (s: Sequence, f: number) => toTimecode(f, s.fps);
/** "12.48 s (00:00:12:12)" */
const at = (s: Sequence, f: number) => `${S(s, f)} s (${tc(s, f)})`;
/** "0–4.36 s (00:00:00:00–00:00:04:09)" */
const span = (s: Sequence, a: number, b: number) => `${S(s, a)}–${S(s, b)} s (${tc(s, a)}–${tc(s, b)})`;

const trackLabel = (t: Track) => `${t.kind === "video" ? "V" : "A"}${t.index + 1}`;
function trackRef(s: Sequence, ref: unknown, kind?: Track["kind"]): Track | undefined {
  if (typeof ref !== "string" || !ref) return undefined;
  const m = /^([va])(\d{1,2})$/i.exec(ref.trim());
  const t = m ? tracksOf(s, m[1].toLowerCase() === "v" ? "video" : "audio")[Number(m[2]) - 1] : s.tracks.find((x) => x.id === ref || x.name.toLowerCase() === ref.toLowerCase());
  if (!t) throw new Error(`No track ${ref} (tracks: ${s.tracks.map(trackLabel).join(", ")})`);
  if (kind && t.kind !== kind) throw new Error(`${ref} is a${t.kind === "audio" ? "n audio" : " video"} track`);
  return t;
}
function clipOf(s: Sequence, id: unknown): TimelineClip {
  const c = s.clips.find((x) => x.id === id);
  if (!c) throw new Error(`No clip ${String(id)} in "${s.name}" (get_timeline lists them)`);
  return c;
}
const mediaOf = (p: EditProject, id: unknown): MediaItem => {
  const m = p.media.find((x) => x.id === id);
  if (!m) throw new Error(`No media ${String(id)} in the edit (list_media lists them)`);
  return m;
};
const mediaSeconds = (m: MediaItem) => m.seconds ?? (m.fps > 0 ? m.duration / m.fps : 0);
const kindOfClip = (s: Sequence, c: TimelineClip) => s.tracks.find((t) => t.id === c.trackId)?.kind ?? "video";

/** One command on the active sequence, labelled for the History panel; `fn` may report back through closures. */
function onSeq(label: string, fn: (s: Sequence, c: Ctx) => Sequence): void {
  const id = project().activeSequenceId;
  exec(label, (p) => updateSequence(p, id, fn));
}

function describeClip(s: Sequence, p: EditProject, c: TimelineClip): string {
  const t = s.tracks.find((x) => x.id === c.trackId);
  const bits = [`${c.id} ${t ? trackLabel(t) : "?"} ${span(s, c.start, clipEnd(c))} "${c.name}"`];
  if (c.source.type === "media") {
    const m = p.media.find((x) => x.id === (c.source as { mediaId: string }).mediaId);
    const rate = m && m.fps > 0 ? m.fps : s.fps;
    const inS = c.source.in / rate;
    bits.push(`src ${r2(inS)}–${r2(inS + (framesToSeconds(c.duration, s.fps) * c.speed))} s`);
  } else bits.push(c.source.type === "title" ? `title "${c.source.text.text.slice(0, 50)}"` : c.source.type);
  if (c.speed !== 1) bits.push(`speed ${c.speed}${c.reverse ? " reversed" : ""}`);
  if (c.timeRemap) bits.push("speed ramp");
  if (!c.enabled) bits.push("disabled");
  if (c.effects.length) bits.push(`fx ${c.effects.map((e) => `${e.type}[${e.id}]`).join(", ")}`);
  if (c.motion.scale.value !== 100 || c.motion.scale.keyframes?.length) bits.push(`scale ${c.motion.scale.value}%${c.motion.scale.keyframes?.length ? " (keyframed)" : ""}`);
  if (c.audio && c.audio.gain.value) bits.push(`gain ${c.audio.gain.value} dB`);
  if (c.role) bits.push(`role ${c.role}`);
  return bits.join(" · ");
}

function timeline(a: Args): PageReply {
  const p = project();
  const id = str(a.sequence_id) ?? p.activeSequenceId;
  const s = p.sequences.find((x) => x.id === id);
  if (!s) throw new Error(`No sequence ${id}`);
  const from = a.from !== undefined ? F(s, num(a.from, "from")) : 0;
  const to = a.to !== undefined ? F(s, num(a.to, "to")) : Number.POSITIVE_INFINITY;
  const end = seqEnd(s);
  const clips = s.clips.filter((c) => clipEnd(c) > from && c.start < to).sort((x, y) => {
    const tx = s.tracks.find((t) => t.id === x.trackId)!, ty = s.tracks.find((t) => t.id === y.trackId)!;
    return (tx.kind === ty.kind ? tx.index - ty.index : tx.kind === "video" ? -1 : 1) || x.start - y.start;
  });
  const LIMIT = a.brief ? 0 : 150;
  const lines = [`"${s.name}" (${s.id}${s.id === p.activeSequenceId ? ", active" : ""}): ${s.width}×${s.height}, ${s.fps} fps, ${at(s, end)} long, ${s.clips.length} clips on ${tracksOf(s, "video").length} video + ${tracksOf(s, "audio").length} audio tracks; playhead ${at(s, ed().path ? Math.round(s.playhead) : 0)}.`];
  const others = p.sequences.filter((x) => x.id !== s.id);
  if (others.length) lines.push(`Other sequences: ${others.map((x) => `"${x.name}" (${x.id}, ${S(x, seqEnd(x))} s)`).join("; ")}.`);
  lines.push(`Tracks: ${s.tracks.map((t) => `${trackLabel(t)} ${t.name}${t.locked ? " (locked)" : ""}${t.muted ? " (muted)" : ""}${t.role ? ` [${t.role}]` : ""}`).join(", ")}.`);
  for (const c of clips.slice(0, LIMIT)) lines.push(describeClip(s, p, c));
  if (clips.length > LIMIT && LIMIT) lines.push(`…and ${clips.length - LIMIT} more clips: use from / to.`);
  if (s.transitions.length && LIMIT) lines.push(`Transitions: ${s.transitions.map((t) => `${t.type} at ${at(s, t.at)} on ${trackLabel(s.tracks.find((x) => x.id === t.trackId)!)} (${S(s, t.duration)} s) [${t.id}]`).join("; ")}.`);
  if (s.markers.length && LIMIT) lines.push(`Markers: ${s.markers.map((m) => `"${m.name}" at ${at(s, m.frame)}`).join("; ")}.`);
  const fx = (c: TimelineClip) => c.effects.map((e) => ({ id: e.id, type: e.type, enabled: e.enabled, ...(a.details ? { params: Object.fromEntries(Object.entries(e.params).map(([k, v]) => [k, v.keyframes?.length ? { value: v.value, keyframes: v.keyframes.map((x) => ({ at: S(s, c.start + x.frame), value: x.value })) } : v.value])) } : {}) }));
  return { text: lines.join("\n"), data: {
    sequence_id: s.id, name: s.name, width: s.width, height: s.height, fps: s.fps, duration: S(s, end), duration_tc: tc(s, end),
    tracks: s.tracks.map((t) => ({ id: t.id, ref: trackLabel(t), name: t.name, kind: t.kind, locked: t.locked, muted: t.muted, role: t.role ?? null })),
    clips: clips.slice(0, LIMIT || 0).map((c) => ({ id: c.id, track: trackLabel(s.tracks.find((t) => t.id === c.trackId)!), start: S(s, c.start), end: S(s, clipEnd(c)),
      start_tc: tc(s, c.start), end_tc: tc(s, clipEnd(c)), name: c.name, type: c.source.type, media_id: c.source.type === "media" ? c.source.mediaId : null,
      speed: c.speed, linked: c.linkId ?? null, effects: fx(c), ...(a.details ? { motion: { scale: c.motion.scale, position: c.motion.position, opacity: c.motion.opacity }, audio: c.audio ?? null } : {}) })),
    transitions: s.transitions.map((t) => ({ id: t.id, type: t.type, at: S(s, t.at), duration: S(s, t.duration) })),
    markers: s.markers.map((m) => ({ id: m.id, name: m.name, at: S(s, m.frame) })),
    sequences: p.sequences.map((x) => ({ id: x.id, name: x.name, duration: S(x, seqEnd(x)) })),
  } };
}

const mediaRef = (m: MediaItem): AnalyzeMediaRef => ({ id: m.id, path: m.path, name: m.name, kind: m.kind, hasAudio: m.hasAudio, seconds: mediaSeconds(m), width: m.width, height: m.height });
const planMedia = (m: MediaItem): PlanMedia => ({ id: m.id, name: m.name, kind: m.kind, duration: mediaSeconds(m), hasAudio: m.hasAudio, width: m.width, height: m.height, path: m.path });

/** Param values from an assistant: numbers, text, booleans, [r,g,b] / [x,y]. */
const asParam = (v: unknown): Param<unknown> => ({ value: Array.isArray(v) ? v.map(Number) : v });

function newEffect(type: string, kind: Track["kind"], params: Record<string, unknown>, videoDefs: Awaited<ReturnType<typeof videoEffects>>) {
  if (kind === "audio") {
    const id = audioFxId(type) ?? audioFxId(`audio:${type}`);
    if (!id) throw new Error(`No audio effect ${type}: list_catalog(audio_effects) lists them`);
    const defs = audioFxDefaults(id);
    const bad = Object.keys(params).filter((k) => !(k in defs));
    if (bad.length) throw new Error(`${id} has no ${bad.join(", ")} (it has ${Object.keys(defs).join(", ")})`);
    return { id: uid("e"), type: audioFxType(id), enabled: true, params: Object.fromEntries(Object.entries({ ...defs, ...params }).map(([k, v]) => [k, asParam(v)])) };
  }
  if (!videoDefs.some((d) => d.id === type)) throw new Error(`No video effect ${type}: list_catalog(effects) lists them`);
  const e = makeEffect(type, videoDefs);
  const bad = Object.keys(params).filter((k) => !(k in e.params));
  if (bad.length) throw new Error(`${type} has no ${bad.join(", ")} (it has ${Object.keys(e.params).join(", ") || "no parameters"})`);
  for (const [k, v] of Object.entries(params)) e.params[k] = asParam(v);
  return e;
}

/** The assistant's last change is on top of the history (undo never takes a change the user made). */
const topIsAssistant = () => { const h = ed().h; const e = h.past[h.past.length - 1]; return e ? e.label.startsWith("Assistant: ") : false; };

// ── the tools ────────────────────────────────────────────────────────────────

export const PAGE_TOOLS: Record<string, Tool> = {
  __media: (a) => {
    const want = Array.isArray(a.ids) ? new Set(strs(a.ids)) : null;
    const list = project().media.filter((m) => !m.path.startsWith("studio:") && !m.missing && (!want || want.has(m.id))).map(mediaRef);
    return { text: `${list.length} media`, data: { media: list } };
  },
  __caption_sources: (a) => {
    const s = seq();
    const want = Array.isArray(a.clip_ids) ? new Set(strs(a.clip_ids)) : null;
    const parts = s.clips.filter((c) => c.source.type === "media" && kindOfClip(s, c) === "audio" && (!want || want.has(c.id) || withLinked(s, [...want]).includes(c.id)))
      .map((c) => ({ clipId: c.id, mediaId: (c.source as { mediaId: string }).mediaId }));
    return { text: `${parts.length} sound clips`, data: { parts } };
  },

  save_edit: async () => {
    const ok = await save();
    const st = ed();
    if (!ok) throw new Error(st.saveError ?? "The edit couldn't be saved");
    return { text: `Saved ${project().name} (${st.savedAt ?? "now"}).`, data: { path: st.path, sequence_id: project().activeSequenceId, modified: st.savedAt } };
  },

  add_media: async (a, call) => {
    const items = (Array.isArray(a.items) ? a.items : []) as MediaItem[];
    const binName = str(a.bin);
    const p0 = project();
    const have = new Set(p0.media.map((m) => m.path.toLowerCase()));
    const fresh = items.filter((m) => m && typeof m.id === "string" && !have.has(String(m.path).toLowerCase()));
    if (fresh.length) {
      exec(call.label, (p) => {
        let bins = p.bins;
        let binId: string | null = null;
        if (binName) {
          const b = bins.find((x) => x.name === binName && !x.parentId);
          binId = b?.id ?? uid("b");
          if (!b) bins = [...bins, { id: binId, name: binName, parentId: null }];
        }
        return { ...p, bins, media: [...p.media, ...fresh.map((m) => ({ ...m, binId: m.binId ?? binId }))] };
      });
      void resolveUrls(fresh);
    }
    const s = seq();
    const lines = fresh.map((m) => `${m.name} [${m.id}] ${m.kind}, ${at(s, F(s, mediaSeconds(m)))}${m.kind === "video" ? `, ${m.width}×${m.height} ${m.fps} fps` : ""}${m.hasAudio ? ", sound" : ""}`);
    return { text: `Imported ${fresh.length} file${fresh.length === 1 ? "" : "s"}${binName ? ` into the bin "${binName}"` : ""}${items.length > fresh.length ? ` (${items.length - fresh.length} already there)` : ""}.\n${lines.join("\n")}`,
      data: { media: fresh.map((m) => ({ id: m.id, name: m.name, kind: m.kind, seconds: mediaSeconds(m), has_audio: m.hasAudio })) } };
  },

  list_media: (a) => {
    const p = project(), s = seq();
    const q = (str(a.search) ?? "").toLowerCase();
    const list = p.media.filter((m) => (!a.kind || m.kind === a.kind) && (!q || m.name.toLowerCase().includes(q)));
    const uses = (id: string) => p.sequences.reduce((n, x) => n + x.clips.filter((c) => c.source.type === "media" && c.source.mediaId === id).length, 0);
    const bin = (m: MediaItem) => p.bins.find((b) => b.id === m.binId)?.name ?? "";
    const lines = list.slice(0, 300).map((m) => `${m.id} ${m.kind} "${m.name}" ${at(s, F(s, mediaSeconds(m)))}${m.kind !== "audio" ? ` ${m.width}×${m.height}` : ""}${m.kind === "video" ? ` ${m.fps} fps` : ""}${m.hasAudio ? " sound" : ""}${bin(m) ? ` · bin ${bin(m)}` : ""} · used ${uses(m.id)}×${m.missing ? " · MISSING" : ""}`);
    return { text: list.length ? lines.join("\n") : "No media yet: import_media adds some.", data: { media: list.map((m) => ({ id: m.id, name: m.name, kind: m.kind, seconds: r2(mediaSeconds(m)),
      width: m.width, height: m.height, fps: m.fps, has_audio: m.hasAudio, bin: bin(m) || null, uses: uses(m.id), missing: Boolean(m.missing), path: m.path })) } };
  },

  get_timeline: (a) => timeline(a),

  open_sequence: (a, call) => {
    const id = str(a.sequence_id);
    const p = project();
    if (!p.sequences.some((s) => s.id === id)) throw new Error(`No sequence ${id}`);
    exec(call.label, (x) => ({ ...x, activeSequenceId: id! }));
    return timeline({ brief: true });
  },

  add_clip: (a, call) => {
    const p = project(), s0 = seq();
    const m = mediaOf(p, a.media_id);
    if (m.missing) throw new Error(`${m.name} is offline: relink it in the app first`);
    const track = trackRef(s0, a.track);
    const tg = targetTracks(s0);
    const vTrack = track?.kind === "video" ? track : tg.video ?? tracksOf(s0, "video")[0];
    const aTrack = track?.kind === "audio" ? track : (track?.kind === "video" ? tracksOf(s0, "audio")[track.index] : undefined) ?? tg.audio ?? tracksOf(s0, "audio")[0];
    const start = a.at !== undefined ? F(s0, num(a.at, "at")) : seqEnd(s0);
    const rate = m.fps > 0 ? m.fps : s0.fps;
    const range = m.kind === "image" ? undefined : { in: a.in !== undefined ? Math.round(num(a.in, "in") * rate) : undefined,
      out: a.out !== undefined ? Math.max(0, Math.round(num(a.out, "out") * rate) - 1) : undefined };
    const dur = m.kind === "image" && a.out !== undefined ? F(s0, num(a.out, "out") - (optNum(a.in) ?? 0)) : undefined;
    let ids: string[] = [];
    onSeq(call.label, (s, c) => {
      const cs = clipsFromMedia(s, m, start, { videoTrackId: vTrack?.id, audioTrackId: aTrack?.id, video: a.video !== false, audio: a.audio !== false, range, ...(dur ? { duration: dur } : {}) });
      ids = cs.map((x) => x.id);
      return placeClips(s, c, cs, a.mode === "insert" ? "insert" : "overwrite");
    });
    const s = seq();
    const placed = s.clips.filter((c) => ids.includes(c.id));
    if (!placed.length) throw new Error("Nothing was placed (a locked track, or the media has no picture / sound for those tracks)");
    return { text: `Added ${m.name}: ${placed.map((c) => describeClip(s, project(), c)).join("\n")}`, data: { clip_ids: ids, start: S(s, start), end: S(s, Math.max(...placed.map(clipEnd))) } };
  },

  move_clip: (a, call) => {
    const s0 = seq();
    const c0 = clipOf(s0, a.clip_id);
    const to = F(s0, num(a.to, "to"));
    const t0 = s0.tracks.find((t) => t.id === c0.trackId)!;
    const t1 = trackRef(s0, a.track, t0.kind) ?? t0;
    const steps = t1.index - t0.index;
    onSeq(call.label, (s, c) => moveClips(s, c, withLinked(s, [c0.id]), to - c0.start, t0.kind === "video" ? { video: steps, audio: 0 } : { video: 0, audio: steps }));
    const c1 = seq().clips.find((x) => x.id === c0.id);
    return { text: c1 ? `Moved: ${describeClip(seq(), project(), c1)}` : "Moved", data: { clip_id: c0.id, start: c1 ? S(seq(), c1.start) : null } };
  },

  trim_clip: (a, call) => {
    const s0 = seq();
    const c0 = clipOf(s0, a.clip_id);
    if (a.start === undefined && a.end === undefined) throw new Error("Give start and/or end");
    const ripple = Boolean(a.ripple);
    onSeq(call.label, (s, c) => {
      let x = s;
      if (a.start !== undefined) x = trimClip(x, c, c0.id, "start", F(s, num(a.start, "start")) - c0.start, { ripple, linked: true });
      const cur = x.clips.find((y) => y.id === c0.id) ?? c0;
      if (a.end !== undefined) x = trimClip(x, c, c0.id, "end", F(s, num(a.end, "end")) - clipEnd(cur), { ripple, linked: true });
      return x;
    });
    const c1 = seq().clips.find((x) => x.id === c0.id);
    return { text: c1 ? `Trimmed: ${describeClip(seq(), project(), c1)} (the media's length limits how far an edge goes)` : "Trimmed", data: { clip_id: c0.id,
      start: c1 ? S(seq(), c1.start) : null, end: c1 ? S(seq(), clipEnd(c1)) : null } };
  },

  split_at: (a, call) => {
    const s0 = seq();
    const f = F(s0, num(a.at, "at"));
    const trackIds = Array.isArray(a.tracks) ? strs(a.tracks).map((t) => trackRef(s0, t)!.id) : undefined;
    const ids = Array.isArray(a.clip_ids) ? strs(a.clip_ids) : undefined;
    const before = new Set(s0.clips.map((c) => c.id));
    onSeq(call.label, (s, c) => razor(s, c, f, { trackIds, ids, linked: true }));
    const made = seq().clips.filter((c) => !before.has(c.id));
    return { text: made.length ? `Cut at ${at(seq(), f)}: ${made.length} new clip${made.length === 1 ? "" : "s"} (${made.map((c) => c.id).join(", ")}).` : `Nothing to cut at ${at(seq(), f)}.`,
      data: { new_clip_ids: made.map((c) => c.id) } };
  },

  delete_clips: (a, call) => {
    const s0 = seq();
    const ids = strs(a.clip_ids);
    for (const id of ids) clipOf(s0, id);
    const all = withLinked(s0, ids);
    const before = seqEnd(s0);
    onSeq(call.label, (s, c) => (a.ripple ? rippleDelete(s, c, all) : removeClips(s, c, all)));
    return { text: `Deleted ${all.length} clip${all.length === 1 ? "" : "s"}${a.ripple ? ", gaps closed" : ""}; the sequence is now ${at(seq(), seqEnd(seq()))} (was ${at(s0, before)}).`, data: { deleted: all } };
  },

  set_speed: (a, call) => {
    const s0 = seq();
    const ids = strs(a.clip_ids);
    for (const id of ids) clipOf(s0, id);
    const speed = num(a.speed, "speed");
    onSeq(call.label, (s, c) => setSpeed(s, c, withLinked(s, ids), speed, { reverse: Boolean(a.reverse), ripple: a.ripple !== false }));
    const s = seq();
    return { text: ids.map((id) => s.clips.find((c) => c.id === id)).filter(Boolean).map((c) => describeClip(s, project(), c!)).join("\n"), data: { clip_ids: ids, speed } };
  },

  add_transition: async (a, call) => {
    const s0 = seq();
    const dur = F(s0, optNum(a.duration) ?? 1);
    let type = str(a.type) ?? "fade";
    const known = await listTransitions().catch(() => []);
    const spots: { trackId: string; at: number; side?: "from" | "to" }[] = [];
    if (a.clip_id) {
      const c = clipOf(s0, a.clip_id);
      const edge = str(a.edge) ?? "out";
      if (edge === "in" || edge === "both") spots.push({ trackId: c.trackId, at: c.start, side: "to" });
      if (edge === "out" || edge === "both") spots.push({ trackId: c.trackId, at: clipEnd(c), side: "from" });
    } else if (a.at !== undefined) {
      const t = trackRef(s0, a.track) ?? tracksOf(s0, "video")[0];
      const f = F(s0, num(a.at, "at"));
      // snap to the nearest cut on that track within half a second
      const cuts = s0.clips.filter((c) => c.trackId === t.id).flatMap((c) => [c.start, clipEnd(c)]);
      const near = cuts.sort((x, y) => Math.abs(x - f) - Math.abs(y - f))[0];
      spots.push({ trackId: t.id, at: near !== undefined && Math.abs(near - f) <= F(s0, 0.5) ? near : f });
    } else throw new Error("Give clip_id (and edge) or at (and track)");
    const kind = s0.tracks.find((t) => t.id === spots[0].trackId)!.kind;
    if (kind === "audio" && !type.startsWith("audio:")) type = "audio:constant_power";
    if (kind === "video" && known.length && !known.some((t) => t.id === type)) {
      const close = known.filter((t) => t.id.toLowerCase().includes(type.toLowerCase().replace(/^gl:/, ""))).slice(0, 6).map((t) => t.id);
      throw new Error(`No transition ${type}${close.length ? `; did you mean ${close.join(", ")}?` : ": list_catalog(transitions) lists them"}`);
    }
    const made: string[] = [];
    onSeq(call.label, (s, c) => {
      let x = s;
      for (const sp of spots) { const r = addTransition(x, c, sp.trackId, sp.at, type, dur, sp.side ? { side: sp.side } : {}); if (r.id) { x = r.seq; made.push(r.id); } }
      return x;
    });
    if (!made.length) throw new Error("No transition fits there: it needs a cut, or a clip edge, with media to spare on a track that isn't locked");
    const s = seq();
    const trs = s.transitions.filter((t) => made.includes(t.id));
    return { text: trs.map((t) => `${t.type} at ${at(s, t.at)}, ${S(s, t.duration)} s [${t.id}]`).join("\n"), data: { transition_ids: made } };
  },

  add_effect: async (a, call) => {
    const s0 = seq();
    const ids = strs(a.clip_ids);
    const clips = ids.map((id) => clipOf(s0, id));
    const type = str(a.effect) ?? "";
    const params = (a.params && typeof a.params === "object" ? a.params : {}) as Record<string, unknown>;
    const defs = await videoEffects();
    const audioType = type.startsWith("audio:") || AUDIO_FX.some((d) => d.id === type);
    const target = clips.filter((c) => (audioType ? kindOfClip(s0, c) === "audio" : kindOfClip(s0, c) === "video"));
    if (!target.length) throw new Error(audioType ? "That's an audio effect: give audio clips (A tracks)" : "That's a video effect: give video clips (V tracks)");
    const made = new Map<string, string>();
    const proto = newEffect(type, audioType ? "audio" : "video", params, defs); // checks the id and the params once
    onSeq(call.label, (s, c) => updateClips(s, c, target.map((x) => x.id), (x) => {
      const e = { ...structuredClone(proto), id: uid("e") };
      made.set(x.id, e.id);
      return { ...x, effects: [...x.effects, e] };
    }));
    return { text: `${proto.type} added to ${made.size} clip${made.size === 1 ? "" : "s"}: ${[...made].map(([c, e]) => `${c} → effect ${e}`).join(", ")}. Parameters: ${Object.entries(proto.params).map(([k, v]) => `${k}=${JSON.stringify(v.value)}`).join(", ") || "none"}.`,
      data: { effects: [...made].map(([clip_id, effect_id]) => ({ clip_id, effect_id, type: proto.type })) } };
  },

  set_effect_param: (a, call) => {
    const s0 = seq();
    const c0 = clipOf(s0, a.clip_id);
    const eid = str(a.effect_id) ?? "";
    const name = str(a.param) ?? "";
    const path = eid === "motion" ? `motion.${name}` : eid === "audio" ? `audio.${name}` : `fx.${eid}.${name}`;
    if (eid !== "motion" && eid !== "audio" && !c0.effects.some((e) => e.id === eid)) throw new Error(`Clip ${c0.id} has no effect ${eid} (its effects: ${c0.effects.map((e) => e.id).join(", ") || "none"})`);
    const kfs = Array.isArray(a.keyframes) ? (a.keyframes as { at: unknown; value: unknown; ease?: unknown }[]) : null;
    if (!kfs && a.value === undefined) throw new Error("Give value, or keyframes");
    let found = true;
    onSeq(call.label, (s, c) => updateClips(s, c, [c0.id], (x) => {
      const y = withParam(x, path, (p) => {
        if (!kfs) return { value: asParam(a.value).value };
        const keys: Keyframe<unknown>[] = kfs.map((k) => ({ frame: Math.max(0, Math.min(x.duration - 1, F(s, num(k.at, "keyframe at")) - x.start)), value: asParam(k.value).value,
          ease: (["linear", "ease_in", "ease_out", "ease_in_out", "hold"].includes(String(k.ease)) ? k.ease : "linear") as Keyframe<unknown>["ease"] })).sort((m, n) => m.frame - n.frame);
        return { value: keys[0]?.value ?? p.value, keyframes: keys };
      });
      if (y === x) found = false;
      return y;
    }));
    if (!found) throw new Error(`No parameter ${name} on ${eid === "motion" ? "the motion (position, scale, rotation, anchor, opacity)" : eid === "audio" ? "the clip's audio (gain, pan)" : `effect ${eid}`}`);
    return { text: `${c0.id} ${eid}.${name} = ${kfs ? `${kfs.length} keyframes from ${at(s0, F(s0, num(kfs[0].at, "at")))}` : JSON.stringify(a.value)}.`, data: { clip_id: c0.id, path } };
  },

  apply_mood: (a, call) => {
    const mood = moodById(str(a.mood) ?? "");
    if (!mood) throw new Error(`No mood ${String(a.mood)} (moods: ${MOODS.map((m) => m.id).join(", ")})`);
    const ids = Array.isArray(a.clip_ids) ? strs(a.clip_ids) : null;
    let r = { clips: 0, cuts: 0, titles: 0 };
    onSeq(call.label, (s, c) => {
      const out = applyMood(s, c, mood, ids ? { kind: "clips", ids } : { kind: "sequence" }, { intensity: optNum(a.intensity) ?? 1, transitions: Boolean(a.transitions), titles: Boolean(a.titles) });
      r = out;
      return out.seq;
    });
    return { text: `${mood.label}: ${r.clips} clips${r.cuts ? `, ${r.cuts} transitions` : ""}${r.titles ? `, ${r.titles} titles restyled` : ""}.`, data: { mood: mood.id, ...r } };
  },

  add_title: (a, call) => {
    const s0 = seq();
    const text = str(a.text) ?? "";
    const start = F(s0, num(a.at, "at"));
    const dur = Math.max(1, F(s0, optNum(a.duration) ?? 4));
    const pos = (["top", "center", "lower_third", "bottom"].includes(String(a.position)) ? a.position : "lower_third") as "top" | "center" | "lower_third" | "bottom";
    const tpl = str(a.template) ? titleTemplates().find((t) => t.id === a.template) : undefined;
    if (a.template && !tpl) throw new Error(`No title template ${String(a.template)}: list_catalog(title_templates) lists them`);
    const sub = str(a.subtitle) ?? "";
    let spec = tpl ? templateSpec(tpl, s0.height, { text, sub }) : titleSpec(text, s0, pos, optNum(a.size) ? Math.round(optNum(a.size)! * (s0.height / 1080)) : 0);
    // a template's sample second line ("Director, …") never reaches the picture: it shows only when given
    if (spec.look?.sub && !sub) { const { sub: _drop, ...look } = spec.look; void _drop; spec = { ...spec, look }; }
    if (str(a.color)) spec = { ...spec, color: str(a.color)! };
    let id = "";
    let track = "";
    onSeq(call.label, (s, c) => {
      // the lowest video track above the picture that's free there
      const vs = tracksOf(s, "video").filter((t) => !t.locked);
      const free = vs.slice(1).find((t) => !s.clips.some((x) => x.trackId === t.id && x.start < start + dur && start < clipEnd(x)));
      let x = s;
      let tid = free?.id;
      if (!tid) { const r = addTrackTop(x); x = r.seq; tid = r.trackId; }
      track = trackLabel(x.tracks.find((t) => t.id === tid)!);
      const r = addGenerated(x, c, tid, start, dur, { type: "title", text: spec }, text.slice(0, 40) || "Title");
      id = r.clipId;
      return clearCaptionBand(r.seq, captionClipIds(r.seq));
    });
    return { text: `Title "${text.slice(0, 60)}" on ${track} at ${span(seq(), start, start + dur)} [${id}].`, data: { clip_id: id, track } };
  },

  add_captions: (a, call) => {
    const s0 = seq();
    const p0 = project();
    let cues: { start: number; end: number; text: string }[] = [];
    if (Array.isArray(a.cues)) cues = (a.cues as { start: unknown; end: unknown; text: unknown }[]).map((c) => ({ start: F(s0, num(c.start, "start")), end: F(s0, num(c.end, "end")), text: String(c.text ?? "").trim() }));
    else if (Array.isArray(a.transcripts)) {
      // transcript lines (media seconds) → the timeline, under the clips that use that media
      const want = Array.isArray(a.clip_ids) ? new Set(withLinked(s0, strs(a.clip_ids))) : null;
      type Word = { start: number; end: number; text: string };
      for (const tr of a.transcripts as { mediaId: string; segments: { start: number; end: number; text: string; words?: Word[] }[] }[]) {
        const m = p0.media.find((x) => x.id === tr.mediaId);
        if (!m) continue;
        const rate = m.fps > 0 ? m.fps : s0.fps;
        for (const c of s0.clips.filter((x) => x.source.type === "media" && x.source.mediaId === tr.mediaId && kindOfClip(s0, x) === "audio" && (!want || want.has(x.id)))) {
          const inS = (c.source as { in: number }).in / rate, outS = inS + framesToSeconds(c.duration, s0.fps) * c.speed;
          for (const seg of tr.segments) {
            let a0 = Math.max(seg.start, inS), b0 = Math.min(seg.end, outS);
            if (b0 - a0 < 0.15 || !seg.text.trim()) continue;
            let text = seg.text.trim();
            if (seg.words?.length) {
              // a jump cut splits a line: only the words spoken inside this clip (by each word's middle), timed by them
              const ws = seg.words.filter((w) => { const m = (w.start + w.end) / 2; return m >= inS && m < outS; });
              if (!ws.length) continue;
              text = ws.map((w) => w.text.trim()).filter(Boolean).join(" ");
              a0 = Math.max(a0, ws[0].start); b0 = Math.min(b0, Math.max(ws[ws.length - 1].end, a0 + 0.3));
            }
            if (!text) continue;
            cues.push({ start: c.start + F(s0, (a0 - inS) / c.speed), end: c.start + F(s0, (b0 - inS) / c.speed), text });
          }
        }
      }
    }
    if (a.style === "phrases") cues = cues.flatMap((c) => { const w = c.text.split(/\s+/); const n = Math.ceil(w.length / 4); return Array.from({ length: n }, (_, i) => ({ start: c.start + Math.round(((c.end - c.start) * i) / n), end: c.start + Math.round(((c.end - c.start) * (i + 1)) / n), text: w.slice(i * 4, i * 4 + 4).join(" ") })); });
    cues = cues.filter((c) => c.text && c.end > c.start).sort((x, y) => x.start - y.start);
    if (!cues.length) throw new Error("No captions to add (no speech in those clips?)");
    let track = "";
    onSeq(call.label, (s, c) => {
      const r = addTrackTop(s, "Captions");
      let x = r.seq;
      track = trackLabel(x.tracks.find((t) => t.id === r.trackId)!);
      const style = captionStyle(x);
      for (const cue of cues) x = addGenerated(x, c, r.trackId, cue.start, Math.max(1, cue.end - cue.start), { type: "title", text: { ...defaultTitle(cue.text), ...style, text: cue.text } }, cue.text.slice(0, 40)).seq;
      return clearCaptionBand(x, captionClipIds(x));
    });
    const s = seq();
    return { text: `${cues.length} captions on ${track} (Captions), ${at(s, cues[0].start)} to ${at(s, cues[cues.length - 1].end)}.`, data: { captions: cues.length, track } };
  },

  add_marker: (a, call) => {
    const s0 = seq();
    const f = F(s0, num(a.at, "at"));
    let id = "";
    onSeq(call.label, (s) => {
      const markers = addMarker(s.markers, f, { name: str(a.name) ?? "Marker", ...(str(a.comment) ? { comment: str(a.comment) } : {}), color: str(a.color) ?? "#22d3ee",
        duration: a.duration !== undefined ? F(s, num(a.duration, "duration")) : 0 });
      id = markers.find((m) => !s.markers.some((x) => x.id === m.id))?.id ?? "";
      return { ...s, markers };
    });
    return { text: `Marker "${str(a.name) ?? "Marker"}" at ${at(seq(), f)} [${id}].`, data: { marker_id: id, at: S(seq(), f) } };
  },

  set_audio: (a, call) => {
    const s0 = seq();
    const done: string[] = [];
    if (a.track) {
      const t = trackRef(s0, a.track, "audio")!;
      onSeq(call.label, (s) => ({ ...s, tracks: s.tracks.map((x) => (x.id === t.id ? { ...x, ...(a.gain_db !== undefined ? { volume: num(a.gain_db, "gain_db") } : {}),
        ...(a.pan !== undefined ? { pan: num(a.pan, "pan") } : {}), ...(a.mute !== undefined ? { muted: Boolean(a.mute) } : {}), ...(a.role ? { role: a.role as Track["role"] } : {}) } : x)) }));
      done.push(trackLabel(t));
    }
    const ids = strs(a.clip_ids);
    if (ids.length) {
      for (const id of ids) clipOf(s0, id);
      const sound = withLinked(s0, ids).filter((id) => kindOfClip(s0, s0.clips.find((c) => c.id === id)!) === "audio");
      if (!sound.length) throw new Error("Those clips have no sound on an audio track");
      onSeq(call.label, (s, c) => updateClips(s, c, sound, (x) => {
        const au = x.audio ?? { gain: { value: 0 }, pan: { value: 0 }, fadeIn: 0, fadeOut: 0 };
        return { ...x, audio: { ...au, ...(a.gain_db !== undefined ? { gain: { value: num(a.gain_db, "gain_db") } } : {}), ...(a.pan !== undefined ? { pan: { value: num(a.pan, "pan") } } : {}),
          ...(a.fade_in !== undefined ? { fadeIn: F(s, num(a.fade_in, "fade_in")) } : {}), ...(a.fade_out !== undefined ? { fadeOut: F(s, num(a.fade_out, "fade_out")) } : {}) },
          ...(a.mute !== undefined ? { enabled: !a.mute } : {}), ...(a.role ? { role: a.role as TimelineClip["role"] } : {}) };
      }));
      done.push(...sound);
    }
    if (!done.length) throw new Error("Give clip_ids or a track");
    return { text: `Sound set on ${done.join(", ")}${a.role ? ` (role ${String(a.role)}: ${a.role === "music" || a.role === "ambience" ? "ducks under dialogue in the export" : "the export ducks music under it"})` : ""}.`, data: { changed: done } };
  },

  undo: (a) => {
    const n = Math.max(1, Math.min(20, optNum(a.steps) ?? 1));
    const taken: string[] = [];
    for (let i = 0; i < n; i++) {
      if (!topIsAssistant()) break;
      taken.push(ed().h.past[ed().h.past.length - 1].label);
      undo();
    }
    const next = ed().h.past[ed().h.past.length - 1];
    if (!taken.length) return { text: next ? `Not undone: the last change ("${next.label}") was the user's.` : "Nothing to undo.", data: { undone: [] } };
    return { text: `Undid ${taken.join(", ")}.`, data: { undone: taken } };
  },

  redo: (a) => {
    const n = Math.max(1, Math.min(20, optNum(a.steps) ?? 1));
    const done: string[] = [];
    for (let i = 0; i < n; i++) {
      const f = ed().h.future[0];
      if (!f || !f.label.startsWith("Assistant: ")) break;
      done.push(f.label);
      redo();
    }
    return { text: done.length ? `Redid ${done.join(", ")}.` : "Nothing of the assistant's to redo.", data: { redone: done } };
  },

  get_frame: async (a) => {
    const p = project(), s = seq();
    const t = num(a.at, "at");
    const urls = ed().urls;
    const r = await renderProgramFrame(p, s.id, t, optNum(a.width) ?? 960, { urlFor: (m) => urlFor(m), lutUrl: (look) => urls[look] });
    const f = F(s, t);
    const under = s.clips.filter((c) => c.start <= f && f < clipEnd(c) && kindOfClip(s, c) === "video").map((c) => `${c.id} "${c.name}"`);
    return { text: `Frame at ${at(s, f)} of "${s.name}", ${r.width}×${r.height} PNG.${under.length ? ` Showing: ${under.join(", ")}.` : " Nothing on the video tracks there."}${r.warnings.length ? ` Warnings: ${r.warnings.join("; ")}` : ""}`,
      data: { at: S(s, f), at_tc: tc(s, f), width: r.width, height: r.height, clips: under }, image: { data: r.data, mimeType: "image/png" } };
  },

  get_waveform_summary: (a) => {
    const p = project(), s = seq();
    let m: MediaItem;
    let from = 0, to = 1;
    if (a.clip_id) {
      const c = clipOf(s, a.clip_id);
      if (c.source.type !== "media") throw new Error("That clip has no media");
      m = mediaOf(p, c.source.mediaId);
      const sec = mediaSeconds(m) || 1;
      const rate = m.fps > 0 ? m.fps : s.fps;
      from = c.source.in / rate / sec;
      to = Math.min(1, from + (framesToSeconds(c.duration, s.fps) * c.speed) / sec);
    } else m = mediaOf(p, a.media_id);
    const peaks = m.peaks ?? [];
    if (!peaks.length) throw new Error(`${m.name} has no waveform (no sound, or not analysed)`);
    const n = Math.max(8, Math.min(200, optNum(a.buckets) ?? 40));
    const slice = peaks.slice(Math.floor(from * peaks.length), Math.max(Math.floor(from * peaks.length) + 1, Math.ceil(to * peaks.length)));
    const out = Array.from({ length: n }, (_, i) => { const a0 = Math.floor((i * slice.length) / n), b0 = Math.max(a0 + 1, Math.floor(((i + 1) * slice.length) / n)); return r2(Math.max(...slice.slice(a0, b0))); });
    const secs = (to - from) * (mediaSeconds(m) || 0);
    const quiet: string[] = [];
    let q0 = -1;
    out.forEach((v, i) => { if (v < 0.05 && q0 < 0) q0 = i; if ((v >= 0.05 || i === n - 1) && q0 >= 0) { const e = v >= 0.05 ? i : n; if (e - q0 >= 2) quiet.push(`${r2((q0 / n) * secs)}–${r2((e / n) * secs)} s`); q0 = -1; } });
    const bars = out.map((v) => " ▁▂▃▄▅▆▇█"[Math.min(8, Math.round(v * 8))]).join("");
    return { text: `${m.name}${a.clip_id ? ` (clip ${String(a.clip_id)})` : ""}, ${r2(secs)} s in ${n} buckets of ${r2(secs / n)} s:\n${bars}\nQuiet: ${quiet.join(", ") || "none"}.`,
      data: { media_id: m.id, seconds: r2(secs), buckets: out, quiet } };
  },

  auto_edit: (a, call) => {
    const p = project();
    const ids = strs(a.media_ids);
    const media = (ids.length ? ids.map((id) => p.media.find((m) => m.id === id)).filter((m): m is MediaItem => !!m) : p.media).filter((m) => !m.missing && !m.path.startsWith("studio:"));
    const analysis = (Array.isArray(a.analysis) ? a.analysis : []) as MediaAnalysis[];
    const music = str(a.music);
    const opts: AutoEditOptions = { style: a.style as AutoEditOptions["style"], targetSeconds: optNum(a.target_seconds), format: a.format as AutoEditOptions["format"],
      music, captions: str(a.captions), mood: str(a.mood), transitions: a.transitions as AutoEditOptions["transitions"], order: a.order as AutoEditOptions["order"],
      title: str(a.title), folder: str(a.folder) ?? (p.bins.find((b) => b.id === media[0]?.binId)?.name ?? p.name), fps: seq().fps };
    const all = [...media, ...(music && !media.some((m) => m.id === music) ? p.media.filter((m) => m.id === music) : [])];
    const plan = planAutoEdit(all.map(planMedia), analysis, opts);
    const text = describePlan(plan);
    const data = planData(plan);
    if (a.dry_run) return { text: `Plan (nothing changed yet): ${text}`, data: { ...data, dry_run: true } };
    if (!plan.segments.length) throw new Error(`Nothing to cut: ${text}`);
    let sid = "";
    exec(call.label, (x) => { const r = buildAutoEdit(x, plan); sid = r.sequenceId; return r.project; });
    return { text: `Made "${plan.name}" (${sid}), the active sequence now: ${text} Undo takes it all back.`, data: { ...data, sequence_id: sid, dry_run: false } };
  },

  watch_batch: (a, call) => {
    const p = project();
    const media = strs(a.media_ids).map((id) => p.media.find((m) => m.id === id)).filter((m): m is MediaItem => !!m);
    const newIds = new Set(strs(a.new_ids));
    const o = (a.options && typeof a.options === "object" ? a.options : {}) as Record<string, unknown>;
    const opts: AutoEditOptions = { style: a.style as AutoEditOptions["style"], folder: str(a.folder), fps: seq().fps, targetSeconds: optNum(o.target_seconds),
      format: o.format as AutoEditOptions["format"], mood: str(o.mood), transitions: o.transitions as AutoEditOptions["transitions"], order: o.order as AutoEditOptions["order"],
      music: str(o.music) && p.media.some((m) => m.id === o.music) ? str(o.music) : "none", captions: str(o.captions) ?? "none" };
    const analysis = (Array.isArray(a.analysis) ? a.analysis : []) as MediaAnalysis[];
    const name = planAutoEdit([], [], opts).name;
    const existing = p.sequences.find((s) => s.name === name);
    let plan: Plan;
    let sid = "";
    if (a.mode === "rebuild" || !existing) {
      plan = planAutoEdit(media.map(planMedia), analysis, opts);
      exec(call.label, (x) => { const r = buildAutoEdit(x, plan, { rebuild: true }); sid = r.sequenceId; return r.project; });
    } else {
      plan = planAutoEdit(media.filter((m) => newIds.has(m.id)).map(planMedia), analysis, opts);
      exec(call.label, (x) => { const r = buildAutoEdit(x, plan, { appendTo: existing.id }); sid = r.sequenceId; return r.project; });
    }
    // the new clips that made it into the cut (a file already in the edit, or a bad take, adds nothing)
    const added = new Set(plan.segments.filter((x) => newIds.has(x.mediaId)).map((x) => x.mediaId)).size;
    return { text: describePlan(plan), data: { sequence_id: sid, added, clips: plan.segments.length } };
  },

  list_catalog: async (a) => {
    const q = (str(a.search) ?? "").toLowerCase();
    const lim = Math.max(1, Math.min(400, optNum(a.limit) ?? 80));
    const hit = (...xs: (string | undefined)[]) => !q || xs.some((x) => (x ?? "").toLowerCase().includes(q));
    let rows: { id: string; label: string; group?: string; params?: string }[] = [];
    if (a.kind === "transitions") rows = (await listTransitions()).filter((t) => hit(t.id, t.label, t.group)).map((t) => ({ id: t.id, label: t.label, group: t.group }));
    else if (a.kind === "effects") rows = (await videoEffects()).filter((e) => hit(e.id, e.label, e.group)).map((e) => ({ id: e.id, label: e.label, group: e.group, params: e.params.map((x) => x.name).join(", ") }));
    else if (a.kind === "audio_effects") rows = AUDIO_FX.filter((e) => hit(e.id, e.label, e.group)).map((e) => ({ id: `audio:${e.id}`, label: e.label, group: e.group, params: e.params.map((x) => x.name).join(", ") }));
    else if (a.kind === "moods") rows = MOODS.filter((m) => hit(m.id, m.label, m.blurb)).map((m) => ({ id: m.id, label: m.label, group: m.blurb }));
    else rows = titleTemplates().filter((t) => hit(t.id, t.name, t.category)).map((t) => ({ id: t.id, label: t.name, group: t.category }));
    const shown = rows.slice(0, lim);
    return { text: `${rows.length} ${String(a.kind)}${q ? ` matching "${q}"` : ""}${rows.length > lim ? ` (first ${lim})` : ""}:\n${shown.map((r) => `${r.id} — ${r.label}${r.group ? ` [${r.group}]` : ""}${r.params ? ` (${r.params})` : ""}`).join("\n")}`,
      data: { total: rows.length, items: shown } };
  },

  ai_tools: () => aiToolsInfo(),
  run_ai_tool: (a, call) => runAiTool(a, call),
};

/** A new video track on top (for titles and captions), named. */
function addTrackTop(s: Sequence, name?: string): { seq: Sequence; trackId: string } {
  const vs = tracksOf(s, "video");
  const t: Track = { id: uid("v"), kind: "video", name: name ?? `V${vs.length + 1}`, index: vs.length, locked: false, hidden: false, muted: false, solo: false, targeted: false,
    syncLock: true, height: 56, volume: 0, pan: 0 };
  return { seq: { ...s, tracks: [...s.tracks, t] }, trackId: t.id };
}

/** The plan as structured content: the summary, and the segments in seconds and timecode. */
export function planData(plan: Plan): Record<string, unknown> {
  const fps = plan.fps;
  const tcs = (sec: number) => toTimecode(secondsToFrames(sec, fps), fps);
  return {
    name: plan.name, style: plan.style, width: plan.width, height: plan.height, fps, summary: plan.summary, mood: plan.mood, proposals: plan.proposals,
    segments: plan.segments.map((s) => ({ media_id: s.mediaId, in: s.in, out: s.out, at: s.at, at_tc: tcs(s.at), duration: s.duration, speed: s.speed,
      ...(s.scale ? { scale: s.scale } : {}), ...(s.ramp ? { ramp: s.ramp } : {}), ...(s.soundLead ? { j_cut: s.soundLead } : {}), ...(s.soundTail ? { l_cut: s.soundTail } : {}) })),
    transitions: plan.transitions, titles: plan.titles, captions: plan.captions.length, beds: plan.beds,
  };
}

