/**
 * The audio effect commands (one undo step each) the AudioEffects, Audio Mixer, Effects and Essential Sound panels
 * run: edit a clip's / track's / the master's effect stack, chain presets, generator clips (and dropping them on the
 * timeline), Match loudness, Learn noise, auto-duck, remix to length and the Essential Sound roles.
 */
import { toast } from "sonner";
import { editorBridge } from "../../lib/desktop";
import { clipById, kindOf, seqEnd, tracksOf, updateClips, updateSequence } from "../model/ops";
import type { EffectInstance, Sequence, TimelineClip } from "../model/types";
import { program } from "../playback/transport";
import { ed, exec, project, select, seq, seqExec } from "../store";
import { dialogueIntervals, duckKeyframes, remixClips, remixPlan, setControl } from "./essential";
import { measureLoudness } from "./loudness";
import { CHAIN_PRESETS, type AudioParamValue, type GeneratorKind, type SoundRole } from "./registry";
import { addGeneratorClip, fx, GENERATOR_NAMES, makeAudioFx, withFx, type FxTarget } from "./stack";

/** One undoable edit of a target's effect list. */
export function editStack(t: FxTarget, label: string, fn: (list: EffectInstance[]) => EffectInstance[], coalesce?: string) {
  seqExec(label, (s, c) => withFx(s, c, t, fn), coalesce);
}
export const addFx = (t: FxTarget, id: string, values?: Record<string, AudioParamValue>) => {
  const e = makeAudioFx(id, values);
  editStack(t, "Add audio effect", (l) => fx.add(l, e));
  return e.id;
};
export function applyChainPreset(t: FxTarget, presetId: string) {
  const p = CHAIN_PRESETS.find((x) => x.id === presetId);
  if (!p) return;
  editStack(t, `Preset: ${p.name}`, (l) => p.effects.reduce((acc, e) => fx.add(acc, makeAudioFx(e.id, e.values)), l));
}

/** The audio clips among the selection (generator clips included). */
export function selectedAudioClips(s: Sequence = seq()): TimelineClip[] {
  const ids = new Set(ed().selection);
  return s.clips.filter((c) => ids.has(c.id) && kindOf(s, c) === "audio" && (c.source.type === "media" || c.source.type === "generate"));
}

// ── generators ──────────────────────────────────────────────────────────────────────────────────────────
export function addGenerator(kind: GeneratorKind, at = program.frame, trackId?: string) {
  let id: string | null = null;
  exec(`New ${GENERATOR_NAMES[kind].toLowerCase()} clip`, (p) => updateSequence(p, p.activeSequenceId, (s, c) => {
    const r = addGeneratorClip(s, c, kind, at, trackId);
    id = r.clipId;
    return r.seq;
  }));
  if (id) select([id]); else toast.message("Add an audio track first");
  return id;
}

export const GEN_MIME = "application/x-tatvam-generator";
let dropInstalled = false;
/** Generators dragged from the Effects panel land on an audio track lane of the timeline as a new clip. */
export function installGeneratorDrop() {
  if (dropInstalled || typeof window === "undefined") return;
  dropInstalled = true;
  const laneOf = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(GEN_MIME)) return null;
    const lane = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(".tl-lane[data-track]");
    const t = lane ? seq().tracks.find((x) => x.id === lane.dataset.track) : undefined;
    return lane && t?.kind === "audio" && !t.locked ? { lane, track: t } : null;
  };
  window.addEventListener("dragover", (e) => { if (laneOf(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; } });
  window.addEventListener("drop", (e) => {
    const hit = laneOf(e);
    if (!hit) return;
    e.preventDefault();
    const kind = e.dataTransfer?.getData(GEN_MIME) as GeneratorKind;
    const s = ed();
    const frame = Math.max(0, Math.round((e.clientX - hit.lane.getBoundingClientRect().left + s.scroll) / s.zoom));
    addGenerator(kind, frame, hit.track.id);
  });
}

// ── loudness ────────────────────────────────────────────────────────────────────────────────────────────
/** Integrated loudness of a clip's source region: the desktop's analysis (whole media), else decoded here. */
async function clipLoudness(c: TimelineClip): Promise<number | null> {
  const src = c.source;
  if (src.type !== "media") return null;
  const p = project(), m = p.media.find((x) => x.id === src.mediaId);
  if (!m) return null;
  const b = editorBridge(), path = ed().path;
  // the clip's own stretch of the media (seconds; out exclusive)
  const mfps = m.fps > 0 ? m.fps : seq().fps;
  const range = { in: src.in / mfps, out: src.in / mfps + (c.duration / seq().fps) * (c.speed > 0 ? c.speed : 1) };
  if (b && path) {
    try { const r = await b.analyze(path, m.id, "loudness", range); if (r.kind === "loudness" && r.lufs !== null && Number.isFinite(r.lufs)) return r.lufs; } catch { /* decode here */ }
  }
  const url = ed().urls[`audio:${m.id}`] ?? ed().urls[m.id] ?? m.url;
  if (!url || url.startsWith("demo:")) return null;
  try {
    const buf = await (await fetch(url, { credentials: "include" })).arrayBuffer();
    const ctx = new OfflineAudioContext(2, 48000, 48000);
    const a = await ctx.decodeAudioData(buf);
    const from = Math.floor(range.in * a.sampleRate), len = Math.min(a.length - from, Math.ceil((range.out - range.in) * a.sampleRate));
    if (len <= 0) return null;
    const ch = Array.from({ length: Math.min(2, a.numberOfChannels) }, (_, i) => a.getChannelData(i).slice(from, from + len));
    const r = measureLoudness(ch.length === 1 ? [ch[0], ch[0]] : ch, a.sampleRate);
    return Number.isFinite(r.lufs) ? r.lufs : null;
  } catch { return null; }
}

/** Sets every clip's level so it measures `target` LUFS: one undo step. Returns how many were changed. */
export async function matchLoudness(clips: TimelineClip[], target: number): Promise<number> {
  const media = clips.filter((c) => c.source.type === "media");
  if (!media.length) { toast.message("Select audio clips first"); return 0; }
  const t = toast.loading(`Measuring ${media.length} clip${media.length > 1 ? "s" : ""}…`);
  const gains = new Map<string, number>();
  for (const c of media) {
    const l = await clipLoudness(c);
    if (l !== null && l > -70) gains.set(c.id, Math.max(-40, Math.min(30, Math.round((target - l) * 10) / 10)));
  }
  toast.dismiss(t);
  if (!gains.size) { toast.error("Couldn't measure the loudness of those clips"); return 0; }
  seqExec(`Match loudness (${target} LUFS)`, (s, cx) => updateClips(s, cx, [...gains.keys()], (c) => {
    if (!c.audio) return c;
    const g = gains.get(c.id)!;
    const ks = c.audio.gain.keyframes;
    // keyframed levels move together, keeping their shape around the new level
    const d = g - (ks?.length ? ks[0].value : c.audio.gain.value);
    return { ...c, audio: { ...c.audio, gain: ks?.length ? { value: c.audio.gain.value + d, keyframes: ks.map((k) => ({ ...k, value: k.value + d })) } : { value: g } } };
  }));
  toast.success(`${gains.size} clip${gains.size > 1 ? "s" : ""} set to ${target} LUFS`);
  return gains.size;
}

// ── noise print ─────────────────────────────────────────────────────────────────────────────────────────
/** Stores the Source monitor's in / out marks of the clip's media (the noise) on a noise_print effect. */
export function learnNoise(t: FxTarget, effectId: string) {
  const s = seq();
  const c = t.kind === "clip" ? clipById(s, t.clipId) : undefined;
  const m = c && c.source.type === "media" ? project().media.find((x) => x.id === (c.source as { mediaId: string }).mediaId) : undefined;
  if (!m || m.inPoint === undefined || m.outPoint === undefined || m.outPoint <= m.inPoint) {
    toast.message("Open the clip in the Source monitor and mark in and out around a stretch of noise only (I / O), then Learn noise");
    return;
  }
  const fps = m.fps > 0 ? m.fps : s.fps;
  const a = Math.round((m.inPoint / fps) * 1000) / 1000, b = Math.round(((m.outPoint + 1) / fps) * 1000) / 1000;
  editStack(t, "Learn noise", (l) => fx.preset(l, effectId, { noiseStart: a, noiseEnd: b }));
  toast.success(`Noise learned from ${a.toFixed(2)}–${b.toFixed(2)} s of the source`);
}

// ── Essential Sound ─────────────────────────────────────────────────────────────────────────────────────
export function setRole(ids: string[], role: SoundRole | undefined) {
  if (!ids.length) return;
  seqExec(role ? `Tag as ${role}` : "Clear sound tag", (s, c) => updateClips(s, c, ids, (x) => {
    const y = { ...x };
    if (role) y.role = role; else delete y.role;
    return y;
  }));
}
export function setRoleControl(clipIds: string[], key: string, v: number | string, coalesce?: string) {
  seqExec("Essential Sound", (s, c) => updateClips(s, c, clipIds, (x) => ({ ...x, effects: setControl(x.effects, key, v) })), coalesce);
}

/** Level keyframes ducking the clips under the dialogue. */
export function autoDuck(clipIds: string[], amountDb: number, fadeMs: number) {
  const s = seq();
  const fade = Math.max(1, Math.round((fadeMs / 1000) * s.fps));
  let n = 0;
  seqExec("Auto-duck", (sq, c) => updateClips(sq, c, clipIds, (x) => {
    if (!x.audio) return x;
    const ivs = dialogueIntervals(sq, x.id);
    if (!ivs.length) return x;
    n++;
    const base = x.audio.gain.keyframes?.length ? x.audio.gain.keyframes[0].value : x.audio.gain.value;
    return { ...x, audio: { ...x.audio, gain: duckKeyframes(x, base, ivs, amountDb, fade) } };
  }));
  if (!n) toast.message("No dialogue to duck under: tag the dialogue clips (or name the track Dialogue / Voice)");
}

/** Cuts a music clip on its beats (editor.analyze "beats") so it ends with the sequence. */
export async function remixToLength(clipId: string) {
  const s = seq(), c = clipById(s, clipId);
  if (!c || c.source.type !== "media") return;
  const m = project().media.find((x) => x.id === (c.source as { mediaId: string }).mediaId);
  const b = editorBridge(), path = ed().path;
  if (!m) return;
  if (!b || !path) { toast.message("Remix to length uses the beat analysis of Tatvam Desktop"); return; }
  const t = toast.loading("Finding the beats…");
  try {
    const r = await b.analyze(path, m.id, "beats");
    toast.dismiss(t);
    if (r.kind !== "beats" || r.beats.length < 8) { toast.error("Not enough beats found in that music"); return; }
    const fps = m.fps > 0 ? m.fps : s.fps;
    const srcIn = c.source.in / fps;
    const srcEnd = m.seconds ?? (m.duration / fps);
    const others = { ...s, clips: s.clips.filter((x) => x.id !== c.id && (!c.linkId || x.linkId !== c.linkId)) };
    const end = Math.max(seqEnd(others), c.start + 1);
    const target = (end - c.start) / s.fps;
    const pieces = remixPlan(r.beats, srcIn, srcEnd, target);
    if (!pieces.length) return;
    seqExec("Remix to length", (sq, cx) => remixClips(sq, cx, c.id, pieces, fps, end));
    toast.success(`Remixed into ${pieces.length} part${pieces.length > 1 ? "s" : ""} at ${r.bpm.toFixed(0)} BPM, ending with the sequence`);
  } catch (e) { toast.dismiss(t); toast.error(String((e as Error)?.message ?? e)); }
}

/** The audio tracks (the AudioEffects panel's track picker). */
export const audioTracks = () => tracksOf(seq(), "audio");
