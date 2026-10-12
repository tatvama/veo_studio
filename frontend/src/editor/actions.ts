/**
 * Every user-level edit (keys, menus, buttons, context menus) as one named, undoable command on the store. Panels
 * call these; nothing else writes to the document.
 */
import { toast } from "sonner";
import { defaultMotion, defaultTitle, DEFAULT_STILL_S, newSequence as newSeq, now } from "./model/defaults";
import { uid } from "./model/ids";
import * as O from "./model/ops";
import { secondsToFrames } from "./model/time";
import type { Bin, EditProject, EffectInstance, Marker, MediaItem, Sequence, TimelineClip, TitleSpec, Track } from "./model/types";
import { program, source } from "./playback/transport";
import { clearSelection, ed, exec, project, replaceProject, select, seq, seqExec, setClipboard, setSource, setView } from "./store";

const fr = (s: number) => secondsToFrames(s, seq().fps);

// ── defaults (Effects panel: right-click → Set as default) ───────────────────

const LS_VT = "tatvam-editor:default-video-transition", LS_AT = "tatvam-editor:default-audio-transition";
const lsGet = (k: string, d: string) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
export const defaultVideoTransition = () => lsGet(LS_VT, "fade");
export const defaultAudioTransition = () => lsGet(LS_AT, "audio:constant_power");
export function setDefaultTransition(kind: "video" | "audio", id: string) {
  try { localStorage.setItem(kind === "video" ? LS_VT : LS_AT, id); } catch { /* storage blocked */ }
  toast.message(`Default ${kind} transition set`);
}

// ── selection helpers ────────────────────────────────────────────────────────

export const selectedClips = (): TimelineClip[] => { const s = seq(); const ids = new Set(ed().selection); return s.clips.filter((c) => ids.has(c.id)); };
const range = (): [number, number] | null => O.markedRange(seq());

// ── edits from the source monitor / project ──────────────────────────────────

/** Insert (",") or overwrite (".") the Source monitor's clip at the playhead, between its in and out. */
export function sourceEdit(mode: "insert" | "overwrite", opts: { video?: boolean; audio?: boolean; mediaId?: string; at?: number } = {}) {
  const id = opts.mediaId ?? ed().sourceId;
  const m = id ? project().media.find((x) => x.id === id) : undefined;
  if (!m) { toast.message("Open a clip in the Source monitor first"); return; }
  if (m.missing || m.offline) { toast.error(`${m.name} is offline — relink it first`); return; }
  const at = opts.at ?? (seq().inPoint ?? program.frame);
  const before = O.seqEnd(seq());
  seqExec(mode === "insert" ? "Insert" : "Overwrite", (s, c) => O.editMedia(s, c, m, at, mode, { video: opts.video, audio: opts.audio }));
  const added = seq().clips.filter((c) => c.source.type === "media" && c.source.mediaId === m.id && c.start === at);
  if (added.length) {
    select(added.map((c) => c.id));
    program.seek(at + added[0].duration);
  } else if (O.seqEnd(seq()) === before) toast.message("Nothing to place: check the targeted tracks aren't locked");
}

/** Drop of media onto the timeline at a frame and track. */
export function dropMedia(items: { mediaId: string; video?: boolean; audio?: boolean }[], at: number, vTrackId: string | undefined, aTrackId: string | undefined, mode: "insert" | "overwrite") {
  const p = project();
  let t = at;
  const s0 = seq();
  const clips: TimelineClip[] = [];
  for (const it of items) {
    const m = p.media.find((x) => x.id === it.mediaId);
    if (!m) continue;
    const cs = O.clipsFromMedia(s0, m, t, { videoTrackId: vTrackId, audioTrackId: aTrackId, video: it.video, audio: it.audio });
    clips.push(...cs);
    if (cs.length) t += cs[0].duration;
  }
  if (!clips.length) return;
  seqExec(mode === "insert" ? "Insert" : "Overwrite", (s, c) => O.placeClips(s, c, clips, mode));
  select(clips.map((c) => c.id));
}

/** A sequence dropped onto the timeline becomes a nested clip. */
export function dropSequence(seqId: string, at: number, vTrackId: string | undefined, aTrackId: string | undefined, mode: "insert" | "overwrite") {
  const p = project();
  const inner = p.sequences.find((x) => x.id === seqId);
  if (!inner || seqId === p.activeSequenceId) { toast.message("A sequence can't be nested in itself"); return; }
  const len = Math.max(1, O.seqEnd(inner));
  const s0 = seq();
  const lid = vTrackId && aTrackId ? uid("l") : undefined;
  const mk = (trackId: string) => {
    const t = s0.tracks.find((x) => x.id === trackId)!;
    const c: TimelineClip = { ...O.clipsFromMedia(s0, { id: "", binId: null, name: inner.name, kind: "video", path: "", duration: 0, fps: 0, width: inner.width, height: inner.height, hasAudio: false, markers: [] }, at, { videoTrackId: trackId, duration: len })[0] };
    c.source = { type: "nested", sequenceId: seqId, in: 0 };
    if (t.kind === "audio") c.audio = { gain: { value: 0 }, pan: { value: 0 }, fadeIn: 0, fadeOut: 0 };
    if (lid) c.linkId = lid;
    return c;
  };
  const clips = [vTrackId && mk(vTrackId), aTrackId && mk(aTrackId)].filter(Boolean) as TimelineClip[];
  seqExec("Nest sequence", (s, c) => O.placeClips(s, c, clips, mode));
}

// ── clip edits ───────────────────────────────────────────────────────────────

export function deleteSelection(ripple = false) {
  const st = ed();
  if (st.selTransition) { const id = st.selTransition; seqExec("Delete transition", (s) => O.removeTransitions(s, [id])); return; }
  if (st.selMarker) { const id = st.selMarker; seqExec("Delete marker", (s) => ({ ...s, markers: O.removeMarker(s.markers, id) })); return; }
  const ids = st.selection;
  if (!ids.length) return;
  const before = seq();
  seqExec(ripple ? "Ripple delete" : "Clear", (s, c) => (ripple ? O.rippleDelete(s, c, ids) : O.removeClips(s, c, ids)));
  if (ripple) {
    const after = seq();
    const end = Math.max(...before.clips.filter((c) => ids.includes(c.id)).map(O.clipEnd));
    const moved = after.clips.some((c) => { const b = before.clips.find((x) => x.id === c.id); return b && b.start >= end && b.start !== c.start; });
    const anyAfter = before.clips.some((c) => !ids.includes(c.id) && c.start >= end);
    if (anyAfter && !moved) toast.message("The gap stays: a clip on a sync-locked track is in the way (turn off its sync lock to close it)");
  }
  clearSelection();
}

/** Lift (;) / Extract ('): the in / out range on the targeted tracks, else the selected clips. */
export function liftExtract(kind: "lift" | "extract") {
  const r = range();
  if (r) {
    seqExec(kind === "lift" ? "Lift" : "Extract", (s, c) => (kind === "lift" ? O.lift(s, c, r[0], r[1]) : O.extract(s, c, r[0], r[1])));
    if (kind === "extract") program.seek(r[0]);
    return;
  }
  if (ed().selection.length) { deleteSelection(kind === "extract"); return; }
  toast.message("Mark an in and out point, or select clips");
}

/** Add Edit (Ctrl+K): razor at the playhead on the targeted tracks (or the selected clips); all tracks with Shift. */
export function addEdit(allTracks = false) {
  const f = program.frame;
  const sel = ed().selection;
  seqExec("Add edit", (s, c) => O.razor(s, c, f, allTracks ? { trackIds: s.tracks.filter((t) => !t.locked).map((t) => t.id) } : sel.length ? { ids: sel } : { trackIds: O.targetedTrackIds(s) }));
}

/** Razor tool click: splits the clips (and their linked halves unless `alone`) at `frame`; no ids = every unlocked track. */
export function addEditAt(frame: number, ids?: string[], alone = false) {
  seqExec("Razor", (s, c) => O.razor(s, c, frame, ids ? { ids, linked: !alone } : { trackIds: s.tracks.filter((t) => !t.locked).map((t) => t.id) }));
}

export function rippleTrimTo(side: "prev" | "next") {
  const f = program.frame;
  const s0 = seq();
  const tracks = O.targetedTrackIds(s0);
  const edit = side === "prev" ? O.prevEdit(s0, f + 1, tracks) : O.nextEdit(s0, f - 1, tracks);
  seqExec(side === "prev" ? "Ripple trim previous edit to playhead" : "Ripple trim next edit to playhead", (s, c) => O.rippleTrimToPlayhead(s, c, f, side));
  if (side === "prev" && edit !== null) program.seek(edit);
}

export function nudge(frames: number) {
  const ids = ed().selection;
  if (!ids.length) return;
  seqExec("Nudge", (s, c) => O.moveClips(s, c, ids, frames), "nudge");
}

export function toggleEnabled() { const ids = ed().selection; if (ids.length) seqExec("Enable", (s, c) => O.setEnabled(s, c, ids)); }
export function linkSelection() {
  const ids = ed().selection;
  if (ids.length < 2) { toast.message("Select two or more clips to link"); return; }
  const cs = selectedClips();
  if (cs.every((c) => c.linkId && c.linkId === cs[0].linkId)) { seqExec("Unlink", (s, c) => O.unlink(s, c, ids)); return; }
  seqExec("Link", (s, c) => O.link(s, c, ids));
}
export function unlinkSelection() { const ids = ed().selection; if (ids.length) seqExec("Unlink", (s, c) => O.unlink(s, c, ids)); }
export const groupSelection = () => { const ids = ed().selection; if (ids.length > 1) seqExec("Group", (s, c) => O.link(s, c, ids)); };

export function copy(cut = false) {
  const s = seq();
  const cb = O.copyClips(s, ed().selection);
  if (!cb) return;
  setClipboard(cb);
  if (cut) deleteSelection(false);
}
export function paste(mode: "overwrite" | "insert") {
  const cb = ed().clipboard;
  if (!cb) { toast.message("Nothing copied yet"); return; }
  let ids: string[] = [];
  const at = program.frame;
  seqExec(mode === "insert" ? "Paste insert" : "Paste", (s, c) => { const r = O.pasteClips(s, c, cb, at, mode); ids = r.ids; return r.seq; });
  if (ids.length) { select(ids, "set", { linked: false }); program.seek(at + cb.span); }
}
export function pasteAttributes() {
  const cb = ed().clipboard;
  const ids = ed().selection;
  if (!cb?.clips.length || !ids.length) { toast.message("Copy a clip, then select the clips to paste its attributes onto"); return; }
  const src = cb.clips[0];
  seqExec("Paste attributes", (s, c) => O.pasteAttributes(s, c, src, ids));
}

export function nest() {
  const ids = ed().selection;
  if (!ids.length) { toast.message("Select clips to nest"); return; }
  const n = project().sequences.length;
  exec("Nest", (p) => O.nestClips(p, p.activeSequenceId, ids, `Nested Sequence ${String(n).padStart(2, "0")}`).project);
  clearSelection();
}

export function setSpeed(ids: string[], speed: number, opts: { reverse?: boolean; ripple?: boolean }) {
  seqExec("Speed / duration", (s, c) => O.setSpeed(s, c, ids, speed, opts));
}

export function resetMotion(id: string) {
  const p = project();
  seqExec("Reset motion", (s, c) => O.updateClips(s, c, [id], (x) => {
    const m = x.source.type === "media" ? p.media.find((y) => y.id === (x.source as { mediaId: string }).mediaId) : undefined;
    return { ...x, motion: { ...defaultMotion(s, m && m.width ? { width: m.width, height: m.height } : undefined), opacity: x.motion.opacity, blend: x.motion.blend } };
  }));
}
export function setAudioFade(id: string, which: "fadeIn" | "fadeOut", frames: number) {
  seqExec(which === "fadeIn" ? "Fade in" : "Fade out", (s, c) => O.updateClips(s, c, [id], (x) => (x.audio ? { ...x, audio: { ...x.audio, [which]: Math.max(0, frames) } } : x)), `fade:${id}:${which}`);
}

export function renameClip(id: string, name: string) { seqExec("Rename clip", (s, c) => O.updateClips(s, c, [id], (x) => ({ ...x, name }))); }
export function labelClips(ids: string[], colorLabel: string | undefined) {
  seqExec("Label", (s, c) => O.updateClips(s, c, ids, (x) => { const y = { ...x }; if (colorLabel) y.colorLabel = colorLabel; else delete y.colorLabel; return y; }));
}
export function swapSelection() {
  const ids = ed().selection.filter((id) => { const c = seq().clips.find((x) => x.id === id); return c && !c.linkId; });
  const cs = selectedClips();
  const pick = cs.length === 2 ? cs : ids.length === 2 ? cs.filter((c) => ids.includes(c.id)) : [];
  if (pick.length !== 2) { toast.message("Select two clips to swap"); return; }
  seqExec("Swap clips", (s, c) => O.swapClips(s, c, pick[0].id, pick[1].id));
}

// ── generated clips ──────────────────────────────────────────────────────────

/** A free stretch on the lowest unlocked video track above the clips at `at` (or the targeted one) for a new title. */
function titleTrack(s: Sequence, at: number, len: number): string | null {
  const vts = O.tracksOf(s, "video").filter((t) => !t.locked);
  for (const t of [...vts].reverse()) {
    if (!s.clips.some((c) => c.trackId === t.id && c.start < at + len && O.clipEnd(c) > at)) return t.id;
  }
  return null;
}

export function newTitle(opts: { at?: number; trackId?: string; text?: string; spec?: Partial<TitleSpec> } = {}): string | null {
  const at = opts.at ?? program.frame;
  const len = fr(DEFAULT_STILL_S);
  let id: string | null = null;
  exec("New title", (p) => O.updateSequence(p, p.activeSequenceId, (s, c) => {
    let sq = s;
    let tid = opts.trackId ?? titleTrack(sq, at, len);
    if (!tid) { const r = O.addTrack(sq, "video"); sq = r.seq; tid = r.trackId; }
    const r = O.addGenerated(sq, c, tid, at, len, { type: "title", text: { ...defaultTitle(opts.text ?? "Title"), ...opts.spec } }, opts.text ?? "Title");
    id = r.clipId;
    return r.seq;
  }));
  if (id) select([id]);
  return id;
}

export function newMatte(kind: "color" | "adjustment", color = "#000000") {
  const at = program.frame;
  const len = fr(DEFAULT_STILL_S);
  let id: string | null = null;
  exec(kind === "color" ? "New colour matte" : "New adjustment layer", (p) => O.updateSequence(p, p.activeSequenceId, (s, c) => {
    let sq = s;
    let tid = kind === "color" ? (O.targetTracks(sq).video?.id ?? null) : titleTrack(sq, at, len);
    if (!tid) { const r = O.addTrack(sq, "video"); sq = r.seq; tid = r.trackId; }
    const r = O.addGenerated(sq, c, tid, at, len, kind === "color" ? { type: "color", color } : { type: "adjustment" }, kind === "color" ? "Colour matte" : "Adjustment layer");
    id = r.clipId;
    return r.seq;
  }));
  if (id) select([id]);
}

// ── effects and transitions ──────────────────────────────────────────────────

export function applyEffect(ids: string[], make: () => EffectInstance, label = "Add effect") {
  if (!ids.length) { toast.message("Select a clip first"); return; }
  seqExec(label, (s, c) => O.addEffect(s, c, ids, make));
}

export function addTransitionAt(trackId: string, at: number, type: string, side?: "from" | "to") {
  const s0 = seq();
  const d = fr(1);
  let id: string | null = null;
  seqExec("Add transition", (s, c) => { const r = O.addTransition(s, c, trackId, at, type, d, { side }); id = r.id; return r.seq; });
  if (!id) toast.message(s0.tracks.find((t) => t.id === trackId)?.locked ? "The track is locked" : "Drop transitions on a cut or a clip's edge");
}

/** A transition on both edges of the selected clips of that kind, or at the edit nearest the playhead. */
export function applyTransition(kind: "video" | "audio", type: string, label = "Apply transition") {
  const f = program.frame;
  const ids = ed().selection;
  seqExec(label, (s, c) => O.applyDefaultTransition(s, c, kind, type, fr(1), f, ids));
}
export function defaultTransitions(kind: "video" | "audio") {
  applyTransition(kind, kind === "video" ? defaultVideoTransition() : defaultAudioTransition(), kind === "video" ? "Apply default transition" : "Apply default audio crossfade");
}

// ── markers and in / out ─────────────────────────────────────────────────────

const MARKER_DEFAULT = "#22d3ee";

export function addSeqMarker(frame = program.frame, patch: Partial<Marker> = {}) {
  seqExec("Add marker", (s) => ({ ...s, markers: O.addMarker(s.markers, frame, { color: MARKER_DEFAULT, ...patch }) }));
}
export function updateSeqMarker(id: string, patch: Partial<Marker>, coalesce?: string) {
  seqExec("Edit marker", (s) => ({ ...s, markers: O.updateMarker(s.markers, id, patch) }), coalesce);
}
export function removeSeqMarker(id: string) { seqExec("Delete marker", (s) => ({ ...s, markers: O.removeMarker(s.markers, id) })); }
export function gotoMarker(dir: 1 | -1) {
  const m = dir > 0 ? O.nextMarker(seq().markers, program.frame) : O.prevMarker(seq().markers, program.frame);
  if (m) program.seek(m.frame);
}

export function markIn(frame = program.frame) { seqExec("Mark in", (s) => O.setInOut(s, { inPoint: frame })); }
export function markOut(frame = program.frame) { seqExec("Mark out", (s) => O.setInOut(s, { outPoint: frame })); }
export function clearInOut(which: "in" | "out" | "both" = "both") {
  seqExec(which === "both" ? "Clear in and out" : which === "in" ? "Clear in" : "Clear out", (s) => O.setInOut(s, { inPoint: which !== "out" ? null : undefined, outPoint: which !== "in" ? null : undefined }));
}
export function markClip() { const f = program.frame; const ids = ed().selection; seqExec("Mark clip", (s) => O.markClip(s, f, ids)); }

// source monitor marks (on the media item). The Source monitor counts in display frames: a video's own frames,
// sequence frames for audio (whose source positions are samples) and stills.
export const displayFps = (m: MediaItem) => (m.kind === "video" && m.fps > 0 ? m.fps : seq().fps);
const srcFps = (m: MediaItem) => (m.fps > 0 ? m.fps : seq().fps);
export const displayToSrc = (m: MediaItem, f: number) => (m.kind === "video" ? f : Math.round((f * srcFps(m)) / displayFps(m)));
export const srcToDisplay = (m: MediaItem, f: number) => (m.kind === "video" ? f : Math.round((f * displayFps(m)) / srcFps(m)));
/** Length of a media item in display frames (stills: the default still length). */
export const displayLength = (m: MediaItem) => (m.kind === "image" || !(m.duration > 0) ? fr(DEFAULT_STILL_S) : srcToDisplay(m, m.duration));

/** Opens a media item in the Source monitor at a source frame. */
export function openInSource(mediaId: string, srcFrame?: number) {
  const m = project().media.find((x) => x.id === mediaId);
  if (!m) return;
  setSource(mediaId);
  source.configure(displayFps(m), displayLength(m));
  source.pause();
  source.seek(srcFrame !== undefined ? srcToDisplay(m, srcFrame) : m.inPoint !== undefined ? srcToDisplay(m, m.inPoint) : 0);
  window.dispatchEvent(new CustomEvent("ed:panel", { detail: "source" }));
}

export function updateMediaItem(id: string, fn: (m: MediaItem) => MediaItem, label: string, coalesce?: string) {
  exec(label, (p) => O.updateMedia(p, id, fn), coalesce);
}
export function sourceMark(which: "in" | "out" | "clear") {
  const id = ed().sourceId;
  const m0 = id ? project().media.find((x) => x.id === id) : undefined;
  if (!id || !m0) return;
  const f = displayToSrc(m0, source.frame);
  updateMediaItem(id, (m) => {
    const x = { ...m };
    if (which === "in") { x.inPoint = f; if (x.outPoint !== undefined && x.outPoint < f) delete x.outPoint; }
    else if (which === "out") { x.outPoint = f; if (x.inPoint !== undefined && x.inPoint > f) delete x.inPoint; }
    else { delete x.inPoint; delete x.outPoint; }
    return x;
  }, which === "clear" ? "Clear source in and out" : which === "in" ? "Mark source in" : "Mark source out");
}
export function sourceMarker() {
  const id = ed().sourceId;
  const m0 = id ? project().media.find((x) => x.id === id) : undefined;
  if (!id || !m0) return;
  const f = displayToSrc(m0, source.frame);
  updateMediaItem(id, (m) => ({ ...m, markers: O.addMarker(m.markers, f, { color: MARKER_DEFAULT }) }), "Add source marker");
}

// ── navigation ───────────────────────────────────────────────────────────────

export function gotoEdit(dir: 1 | -1) {
  const tracks = O.targetedTrackIds(seq());
  const f = dir > 0 ? O.nextEdit(seq(), program.frame, tracks) : O.prevEdit(seq(), program.frame, tracks);
  if (f !== null) program.seek(f);
}
export function gotoInOut(which: "in" | "out") {
  const s = seq();
  const f = which === "in" ? s.inPoint : s.outPoint;
  if (f !== undefined) program.seek(f);
}

// ── tracks ───────────────────────────────────────────────────────────────────

export function addTrack(kind: Track["kind"], index?: number) { seqExec(`Add ${kind} track`, (s) => O.addTrack(s, kind, index).seq); }
export function removeTrack(id: string) {
  const s = seq();
  const t = s.tracks.find((x) => x.id === id);
  if (!t) return;
  if (O.tracksOf(s, t.kind).length <= 1) { toast.message(`An edit keeps at least one ${t.kind} track`); return; }
  const n = s.clips.filter((c) => c.trackId === id).length;
  if (n && !window.confirm(`Delete ${t.name} and its ${n} clip${n === 1 ? "" : "s"}?`)) return;
  seqExec("Delete track", (sq, c) => O.removeTrack(sq, c, id));
}
export function updateTrack(id: string, patch: Partial<Omit<Track, "id" | "kind" | "index">>, label = "Track", coalesce?: string) {
  seqExec(label, (s) => O.updateTrack(s, id, patch), coalesce);
}

// ── project, bins, media ─────────────────────────────────────────────────────

export function addMedia(items: MediaItem[], binId: string | null = null): MediaItem[] {
  const have = new Set(project().media.map((m) => m.path.toLowerCase()));
  const fresh = items.filter((m) => !have.has(m.path.toLowerCase())).map((m) => ({ ...m, binId: m.binId ?? binId }));
  if (fresh.length) exec(fresh.length === 1 ? `Import ${fresh[0].name}` : `Import ${fresh.length} files`, (p) => ({ ...p, media: [...p.media, ...fresh] }));
  if (items.length > fresh.length) toast.message(`${items.length - fresh.length} file${items.length - fresh.length === 1 ? " is" : "s are"} already in the project`);
  return fresh;
}

export function newBin(name = "New bin", parentId: string | null = null): string {
  const b: Bin = { id: uid("b"), name, parentId };
  exec("New bin", (p) => ({ ...p, bins: [...p.bins, b] }));
  return b.id;
}
export function renameBin(id: string, name: string) { exec("Rename bin", (p) => ({ ...p, bins: p.bins.map((b) => (b.id === id ? { ...b, name } : b)) })); }
export function deleteBin(id: string) {
  exec("Delete bin", (p) => {
    const kill = new Set<string>([id]);
    let grew = true;
    while (grew) { grew = false; for (const b of p.bins) if (b.parentId && kill.has(b.parentId) && !kill.has(b.id)) { kill.add(b.id); grew = true; } }
    return { ...p, bins: p.bins.filter((b) => !kill.has(b.id)), media: p.media.map((m) => (m.binId && kill.has(m.binId) ? { ...m, binId: null } : m)) };
  });
}
export function moveToBin(mediaIds: string[], binId: string | null) {
  exec("Move to bin", (p) => ({ ...p, media: p.media.map((m) => (mediaIds.includes(m.id) ? { ...m, binId } : m)) }));
}

export function removeMedia(ids: string[]) {
  const p = project();
  const uses = p.sequences.reduce((n, s) => n + s.clips.filter((c) => c.source.type === "media" && ids.includes(c.source.mediaId)).length, 0);
  if (uses && !window.confirm(`The ${ids.length === 1 ? "clip is" : "clips are"} used ${uses} time${uses === 1 ? "" : "s"} in your sequences. Remove ${ids.length === 1 ? "it" : "them"} and those uses?`)) return;
  exec(ids.length === 1 ? "Remove media" : `Remove ${ids.length} media`, (pp: EditProject) => {
    const c = O.ctxOf(pp);
    return {
      ...pp, media: pp.media.filter((m) => !ids.includes(m.id)),
      sequences: pp.sequences.map((s) => O.normalize({ ...s, clips: s.clips.filter((x) => !(x.source.type === "media" && ids.includes(x.source.mediaId))) }, c)),
    };
  });
  if (ed().sourceId && ids.includes(ed().sourceId!)) setSource(null);
}

export function newSequence(name: string, preset: { width: number; height: number; fps: number }) {
  const n = newSeq(name, preset);
  exec("New sequence", (p) => ({ ...p, sequences: [...p.sequences, n], activeSequenceId: n.id }));
  clearSelection();
  program.seek(0);
}

export function openSequence(id: string) {
  if (project().activeSequenceId === id) return;
  const cur = seq();
  const ph = program.frame;
  const { zoom, scroll } = ed();
  // the playhead and view of the sequence being left are kept on it (no undo step)
  const p = project();
  const next: EditProject = { ...p, activeSequenceId: id, sequences: p.sequences.map((s) => (s.id === cur.id ? { ...s, playhead: ph, workArea: { zoom, scroll } } : s)) };
  replaceProject(next);
  const to = next.sequences.find((s) => s.id === id)!;
  clearSelection();
  setView({ zoom: to.workArea?.zoom || zoom, scroll: to.workArea?.scroll ?? 0 });
  program.seek(to.playhead);
}

export function renameSequence(id: string, name: string) {
  exec("Rename sequence", (p) => ({ ...p, sequences: p.sequences.map((s) => (s.id === id ? { ...s, name } : s)) }));
}

/** A copy of a sequence with fresh ids for its tracks, clips, links and transitions. */
export function duplicateSequence(id: string) {
  exec("Duplicate sequence", (p) => {
    const s = p.sequences.find((x) => x.id === id);
    if (!s) return p;
    const tid = new Map(s.tracks.map((t) => [t.id, uid(t.kind === "video" ? "v" : "a")]));
    const cid = new Map(s.clips.map((c) => [c.id, uid("c")]));
    const lid = new Map<string, string>();
    const copy: Sequence = {
      ...s, id: uid("s"), name: `${s.name} copy`,
      tracks: s.tracks.map((t) => ({ ...t, id: tid.get(t.id)! })),
      clips: s.clips.map((c) => {
        const x: TimelineClip = { ...c, id: cid.get(c.id)!, trackId: tid.get(c.trackId)!, effects: c.effects.map((e) => ({ ...e, id: uid("e") })) };
        if (c.linkId) x.linkId = lid.get(c.linkId) ?? (lid.set(c.linkId, uid("l")), lid.get(c.linkId)!);
        return x;
      }),
      transitions: s.transitions.map((t) => ({ ...t, id: uid("t"), trackId: tid.get(t.trackId)!, fromClipId: t.fromClipId ? cid.get(t.fromClipId) : undefined, toClipId: t.toClipId ? cid.get(t.toClipId) : undefined }))
        .map((t) => { const x = { ...t }; if (!x.fromClipId) delete x.fromClipId; if (!x.toClipId) delete x.toClipId; return x; }),
      markers: s.markers.map((m) => ({ ...m, id: uid("m") })),
    };
    return { ...p, sequences: [...p.sequences, copy] };
  });
}

export function deleteSequence(id: string) {
  const p = project();
  if (p.sequences.length <= 1) { toast.message("An edit keeps at least one sequence"); return; }
  if (p.sequences.some((s) => s.clips.some((c) => c.source.type === "nested" && c.source.sequenceId === id))) { toast.error("That sequence is nested in another one"); return; }
  exec("Delete sequence", (pp) => {
    const sequences = pp.sequences.filter((s) => s.id !== id);
    return { ...pp, sequences, activeSequenceId: pp.activeSequenceId === id ? sequences[0].id : pp.activeSequenceId };
  });
}

export function sequenceFromClip(mediaId: string) {
  const m = project().media.find((x) => x.id === mediaId);
  if (!m) return;
  exec("New sequence from clip", (p) => O.sequenceFromMedia(p, m).project);
  clearSelection();
  program.seek(0);
}

export function renameProject(name: string) { exec("Rename edit", (p) => ({ ...p, name, modified: now() })); }

/** Zoom the timeline: factor around a frame (default: the playhead). */
export function zoomBy(factor: number, aroundFrame = program.frame, laneWidth?: number) {
  const { zoom, scroll } = ed();
  const nz = Math.max(0.002, Math.min(60, zoom * factor));
  const x = aroundFrame * zoom - scroll;
  const inView = laneWidth === undefined || (x >= 0 && x <= laneWidth);
  const anchorX = inView ? x : (laneWidth ?? 0) / 2;
  setView({ zoom: nz, scroll: Math.max(0, aroundFrame * nz - anchorX) });
}
export function zoomToFit(laneWidth: number) {
  const len = Math.max(O.seqEnd(seq()), fr(10));
  setView({ zoom: Math.max(0.002, (laneWidth - 24) / len), scroll: 0 });
}
