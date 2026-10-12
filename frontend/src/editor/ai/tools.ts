/**
 * Every AI tool as one call the panel and the clip context menu share (docs/EDITOR.md §8). Paid tools run through
 * runFlow (price first, the studio's jobs, budgets and approvals) and then put their results into the edit through the
 * EditorHost; free tools run on this PC through the desktop bridge and change the edit in one undoable step.
 */
import { clipById, clipEnd, ctxOf, seqEnd, setSpeed, tracksOf, updateClips, withLinked } from "../model/ops";
import { framesToSeconds, secondsToFrames } from "../model/time";
import type { AnalyzeOptions } from "../../lib/desktop";
import { readBeats, readCuts, readLoudness, readSilences, type AnalyzeKind, type Loudness } from "./analysis";
import { ensureKey, importOutput, runFlow } from "./api";
import { bridgeMessage, editorBridge } from "./bridge";
import {
  addGain, addSequenceMarkers, applyCommands, brollSlot, captionCues, captionStyle, cutRanges, muteSound, normaliseGain, partFrames,
  partOf, sequenceDigest, silenceCuts, soundParts, splitClipAt, toSec, trackFree, videoParts, type CaptionStyle, type Cue, type SourcePart,
} from "./commands";
import type { EditorHost, EditProject, Sequence } from "./host-types";
import type { AiCommandRow, AiJob, AiResult, Output, VoiceRef } from "./types";

// ── small helpers ────────────────────────────────────────────────────────────

const fps = (host: EditorHost) => host.sequence().fps;

/** Puts the active sequence of `next` into the edit as one undoable step. */
export function commitSeq(host: EditorHost, label: string, next: EditProject): boolean {
  const sid = host.sequence().id;
  const before = host.project().sequences.find((s) => s.id === sid);
  const s = next.sequences.find((x) => x.id === sid);
  if (!s || s === before) return false;
  host.apply(label, (d) => { const i = d.sequences.findIndex((x) => x.id === sid); if (i >= 0) d.sequences[i] = s; });
  return true;
}

/** Changes clips of the active sequence (one undo step). */
function editClips(host: EditorHost, label: string, ids: string[], fn: (seq: Sequence, p: EditProject) => Sequence) {
  const p = host.project();
  const seq = host.sequence();
  if (!ids.length) return;
  commitSeq(host, label, { ...p, sequences: p.sequences.map((x) => (x.id === seq.id ? fn(x, p) : x)) });
}

/** The range the in/out marks set ([in, out + 1) frames), or null. */
export function inOutRange(host: EditorHost): [number, number] | null {
  const io = host.inOut();
  if (io.in === undefined && io.out === undefined) return null;
  const a = io.in ?? 0, b = (io.out ?? Math.max(seqEnd(host.sequence()) - 1, a)) + 1;
  return b > a ? [a, b] : null;
}

const firstOutput = (j: AiJob): Output => {
  const o = j.result.outputs[0];
  if (!o) throw new Error("The tool returned nothing");
  return o;
};

/** A result placed on a new audio track, timed like the part it replaces (same start, length and speed). */
async function placeAudioOver(host: EditorHost, o: Output, part: SourcePart, name: string): Promise<string> {
  const item = await importOutput(host, o);
  const len = part.tlEnd - part.tlStart;
  const id = host.placeClip({ mediaId: item.id, trackKind: "audio", at: part.tlStart, newTrack: true, name, duration: len, mode: "overwrite" });
  if (part.speed !== 1) editClips(host, `${name}: match the clip's speed`, [id], (s, p) => updateClips(setSpeed(s, ctxOf(p), [id], part.speed), ctxOf(p), [id], (c) => ({ ...c, duration: len })));
  return id;
}

// ── captions ─────────────────────────────────────────────────────────────────

export interface CaptionSet { language: string; cues: Cue[] }
let lastCaptions: CaptionSet | null = null;
export const getLastCaptions = () => lastCaptions;

export async function captions(host: EditorHost, opts: { clipIds?: string[]; range?: [number, number] | null; language?: string; words?: boolean;
  style?: CaptionStyle } = {}): Promise<CaptionSet | null> {
  const language = opts.language ?? "auto", words = opts.words ?? true, style = opts.style ?? "lines";
  let parts: SourcePart[] = [];
  const jobs = await runFlow(host, {
    title: "Captions",
    prepare: async (say, fresh) => {
      const p = host.project(), seq = host.sequence();
      parts = soundParts(p, seq, opts.clipIds?.length ? { clipIds: opts.clipIds } : { range: opts.range ?? inOutRange(host) ?? [0, seqEnd(seq)] });
      if (!parts.length) throw new Error("Select clips with sound, or set in and out around them");
      const calls = [];
      for (const part of parts) {
        say(`Sending ${part.name}`);
        const key = await ensureKey(host, part.mediaId, { fresh });
        calls.push({ tool: "transcribe" as const, params: { key, language, words: words || style === "phrases", start: part.srcStart, end: part.srcEnd }, what: part.name });
      }
      return calls;
    },
    apply: (js) => {
      const f = fps(host);
      const cues = js.flatMap((j, i) => captionCues(j.result.segments ?? [], parts[i], f, style)).sort((a, b) => a.start - b.start);
      const lang = js.find((j) => j.result.language)?.result.language || (language === "auto" ? "" : language);
      if (!cues.length) { host.toast("Captions: no speech found", "warn"); return; }
      host.addTitleTrack(`Captions${lang ? ` (${lang})` : ""}`, cues, captionStyle(host.sequence()));
      lastCaptions = { language: lang, cues };
      host.toast(`Captions: ${cues.length} lines added`, "ok");
    },
  });
  return jobs ? lastCaptions : null;
}

export async function translateCaptions(host: EditorHost, source: CaptionSet, targets: string[]): Promise<void> {
  const f = fps(host);
  await runFlow(host, {
    title: "Translate captions",
    prepare: async () => targets.map((t) => ({
      tool: "translate" as const, what: t,
      params: { target: t, source: source.language || "auto", segments: source.cues.map((c) => ({ start: toSec(c.start, f), end: toSec(c.end, f), text: c.text })) },
    })),
    apply: (js) => {
      js.forEach((j, i) => {
        const cues = (j.result.segments ?? []).map((s) => ({ start: secondsToFrames(s.start, f), end: secondsToFrames(s.end, f), text: s.text }));
        host.addTitleTrack(`Captions (${targets[i]})`, cues, captionStyle(host.sequence()));
      });
      host.toast(`Captions in ${targets.join(", ")} added`, "ok");
    },
  });
}

// ── voice ────────────────────────────────────────────────────────────────────

export async function voiceOver(host: EditorHost, opts: { text: string; language: string; voice: VoiceRef; style?: string }): Promise<void> {
  const at = host.playhead();
  await runFlow(host, {
    title: "AI voice-over",
    prepare: async () => [{ tool: "tts", params: { text: opts.text, language: opts.language, voice: opts.voice, style: opts.style ?? "" } }],
    apply: async (js) => {
      const item = await importOutput(host, firstOutput(js[0]));
      host.placeClip({ mediaId: item.id, trackKind: "audio", at, newTrack: true, name: "Voice-over", mode: "overwrite" });
      host.toast("Voice-over added at the playhead", "ok");
    },
  });
}

export async function dub(host: EditorHost, clipId: string, opts: { target: string; voice?: VoiceRef; sourceLang?: string }): Promise<void> {
  let part: SourcePart | undefined;
  await runFlow(host, {
    title: `Dub into ${opts.target}`,
    prepare: async (say, fresh) => {
      part = soundParts(host.project(), host.sequence(), { clipIds: [clipId] })[0];
      if (!part) throw new Error("Pick a clip with sound");
      say(`Sending ${part.name}`);
      const key = await ensureKey(host, part.mediaId, { fresh });
      return [{ tool: "dub", what: part.name, params: { key, target: opts.target, source_lang: opts.sourceLang ?? "auto", voice: opts.voice ?? {}, start: part.srcStart, end: part.srcEnd } }];
    },
    apply: async (js) => {
      if (!part) return;
      await placeAudioOver(host, firstOutput(js[0]), part, `Dub (${opts.target})`);
      const m = muteSound(host.project(), host.sequence().id, [clipId]);
      commitSeq(host, "Mute the original sound", m.project);
      host.toast(`Dub added on a new audio track${m.muted ? "; the original sound is muted (kept)" : ""}`, "ok");
    },
  });
}

export async function cleanVoice(host: EditorHost, clipIds: string[]): Promise<void> {
  let parts: SourcePart[] = [];
  await runFlow(host, {
    title: "Clean up voice",
    prepare: async (say, fresh) => {
      parts = soundParts(host.project(), host.sequence(), { clipIds });
      if (!parts.length) throw new Error("Select clips with sound");
      const calls = [];
      for (const part of parts) {
        say(`Sending ${part.name}`);
        calls.push({ tool: "clean_voice" as const, what: part.name, params: { key: await ensureKey(host, part.mediaId, { fresh }), start: part.srcStart, end: part.srcEnd } });
      }
      return calls;
    },
    apply: async (js) => {
      for (let i = 0; i < js.length; i++) await placeAudioOver(host, firstOutput(js[i]), parts[i], `${parts[i].name} (clean voice)`);
      commitSeq(host, "Mute the original sound", muteSound(host.project(), host.sequence().id, parts.map((p) => p.clipId)).project);
      host.toast("Clean voice added; the original sound is muted (kept)", "ok");
    },
  });
}

// ── sound ────────────────────────────────────────────────────────────────────

export async function soundEffect(host: EditorHost, opts: { prompt: string; seconds: number }): Promise<void> {
  const at = host.playhead();
  await runFlow(host, {
    title: "Sound effect",
    prepare: async () => [{ tool: "sfx", params: { prompt: opts.prompt, seconds: opts.seconds } }],
    apply: async (js) => {
      const o = firstOutput(js[0]);
      const item = await importOutput(host, o);
      host.placeClip({ mediaId: item.id, trackKind: "audio", at, newTrack: true, name: o.name, mode: "overwrite" });
    },
  });
}

/** The top video clip under the playhead and the media second it shows there. */
export function pictureAtPlayhead(host: EditorHost): { part: SourcePart; at: number } | null {
  const p = host.project(), seq = host.sequence(), f = host.playhead();
  const ctx = ctxOf(p);
  for (const t of tracksOf(seq, "video").reverse()) {
    if (t.hidden) continue;
    const c = seq.clips.find((x) => x.trackId === t.id && x.start <= f && f < clipEnd(x) && x.source.type === "media" && x.enabled);
    const m = c && c.source.type === "media" ? ctx.media(c.source.mediaId) : undefined;
    if (!c || !m || m.kind === "audio") continue;
    const part = partOf(seq, ctx, c);
    if (!part) continue;
    const at = m.kind === "image" ? 0 : part.srcStart + framesToSeconds(f - c.start, seq.fps) * part.speed;
    return { part, at: Math.round(at * 1000) / 1000 };
  }
  return null;
}

export async function suggestSounds(host: EditorHost): Promise<string[]> {
  const pic = pictureAtPlayhead(host);
  if (!pic) { host.toast("Put the playhead over a picture first", "warn"); return []; }
  const jobs = await runFlow(host, {
    title: "Sound ideas from the picture",
    prepare: async (_say, fresh) => [{ tool: "sfx_suggest", what: pic.part.name, params: { key: await ensureKey(host, pic.part.mediaId, { fresh }), at: pic.at } }],
    apply: () => undefined,
  });
  return jobs?.[0]?.result.suggestions ?? [];
}

export async function music(host: EditorHost, opts: { prompt: string; seconds: number; at: number; volumeDb: number }): Promise<void> {
  await runFlow(host, {
    title: "Music",
    note: "The track is placed on a new audio track, under the dialogue at the volume you set.",
    prepare: async () => [{ tool: "music", params: { prompt: opts.prompt, seconds: Math.max(5, Math.min(300, opts.seconds)) } }],
    apply: async (js) => {
      const o = firstOutput(js[0]);
      const item = await importOutput(host, o);
      const id = host.placeClip({ mediaId: item.id, trackKind: "audio", at: opts.at, newTrack: true, name: o.name, mode: "overwrite" });
      if (opts.volumeDb) commitSeq(host, "Music volume", addGain(host.project(), host.sequence().id, [id], opts.volumeDb));
    },
  });
}

// ── picture ──────────────────────────────────────────────────────────────────

export interface BrollOpts { prompt: string; quality: "saver" | "balanced" | "hero"; route?: string; useFrame: boolean; seconds?: number }

/** Where B-roll would go now: the in/out range, else the gap at the playhead, else 5 s from the playhead. */
export function brollTarget(host: EditorHost, seconds?: number): { trackId: string | null; start: number; end: number } {
  const seq = host.sequence();
  const io = inOutRange(host);
  if (io) {
    const t = tracksOf(seq, "video").find((x) => !x.locked && trackFree(seq, x.id, io[0], io[1]));
    return { trackId: t?.id ?? null, start: io[0], end: io[1] };
  }
  const slot = brollSlot(seq, host.playhead(), secondsToFrames(seconds ?? 5, seq.fps));
  return seconds ? { ...slot, end: slot.start + secondsToFrames(seconds, seq.fps) } : slot;
}

export async function broll(host: EditorHost, opts: BrollOpts): Promise<void> {
  const seq = host.sequence();
  const slot = brollTarget(host, opts.seconds);
  const seconds = Math.max(1, Math.min(30, Math.round(framesToSeconds(slot.end - slot.start, seq.fps) * 10) / 10));
  const pic = opts.useFrame ? pictureAtPlayhead(host) : null;
  if (opts.useFrame && !pic) { host.toast("No picture under the playhead to start from", "warn"); return; }
  await runFlow(host, {
    title: "Generate B-roll",
    prepare: async (_say, fresh) => [{
      tool: "video", what: opts.prompt.slice(0, 40),
      params: {
        prompt: opts.prompt, seconds, aspect: seq.width >= seq.height ? "16:9" : "9:16", quality: opts.quality, route: opts.route || null,
        ...(pic ? { first_frame_key: await ensureKey(host, pic.part.mediaId, { fresh }), first_frame_at: pic.at } : {}),
      },
    }],
    apply: async (js) => {
      const o = firstOutput(js[0]);
      const item = await importOutput(host, o);
      const len = Math.min(slot.end - slot.start, Math.max(1, secondsToFrames(o.duration, seq.fps)));
      host.placeClip({ mediaId: item.id, trackKind: "video", at: slot.start, trackId: slot.trackId ?? undefined, newTrack: !slot.trackId,
        name: "B-roll", duration: len, mode: "overwrite" });
      host.toast(`B-roll added (${js[0].result.engine_label ?? "video"})`, "ok");
    },
  });
}

export async function extendClip(host: EditorHost, clipId: string, opts: { seconds: number; prompt?: string; quality?: BrollOpts["quality"]; route?: string }): Promise<void> {
  const part = videoParts(host.project(), host.sequence(), [clipId])[0];
  if (!part) { host.toast("Pick a video clip to extend", "warn"); return; }
  const f = fps(host);
  await runFlow(host, {
    title: "Extend clip",
    prepare: async (_say, fresh) => [{ tool: "extend", what: part.name, params: {
      key: await ensureKey(host, part.mediaId, { fresh }), seconds: opts.seconds, prompt: opts.prompt ?? "", quality: opts.quality ?? "saver",
      route: opts.route || null, at: Math.max(0, part.srcEnd - 1 / f) } }],
    apply: async (js) => {
      const o = firstOutput(js[0]);
      const item = await importOutput(host, o);
      const seq = host.sequence();
      const c = clipById(seq, clipId);
      const at = c ? clipEnd(c) : part.tlEnd;
      const len = Math.max(1, secondsToFrames(o.duration, seq.fps));
      const free = c && trackFree(seq, c.trackId, at, at + len);
      host.placeClip({ mediaId: item.id, trackKind: "video", at, trackId: free ? c!.trackId : undefined, newTrack: !free, name: `${part.name} (extended)`, mode: "overwrite" });
    },
  });
}

export async function editWithWords(host: EditorHost, clipId: string, instruction: string, route?: string): Promise<void> {
  const part = videoParts(host.project(), host.sequence(), [clipId])[0];
  if (!part) { host.toast("Pick a video clip", "warn"); return; }
  await runFlow(host, {
    title: "Edit with words",
    prepare: async (_say, fresh) => [{ tool: "edit_words", what: part.name, params: {
      key: await ensureKey(host, part.mediaId, { fresh }), instruction, start: part.srcStart, end: part.srcEnd, route: route || null } }],
    apply: async (js) => {
      const item = await importOutput(host, firstOutput(js[0]));
      const len = part.tlEnd - part.tlStart;
      const id = host.placeClip({ mediaId: item.id, trackKind: "video", at: part.tlStart, newTrack: true, name: `${part.name} (${instruction.slice(0, 24)})`, duration: len, mode: "overwrite" });
      if (part.speed !== 1) editClips(host, "Match the clip's speed", [id], (s, p) => setSpeed(s, ctxOf(p), withLinked(s, [id]), part.speed));
      host.toast("The edited clip is on a new track above the original", "ok");
    },
  });
}

/** Cloud upscale (Topaz on fal) of edit media: the clip then plays the upscaled file. */
export async function upscale(host: EditorHost, clipIds: string[], targetH: number): Promise<void> {
  let parts: SourcePart[] = [];
  await runFlow(host, {
    title: `AI upscale to ${targetH >= 2160 ? "4K" : targetH >= 1440 ? "2K" : `${targetH}p`}`,
    note: "Upscaling on this PC (Real-ESRGAN, free) works for studio takes in the finishing room; for edit media it runs in the cloud.",
    prepare: async (say, fresh) => {
      parts = videoParts(host.project(), host.sequence(), clipIds);
      if (!parts.length) throw new Error("Select video clips");
      const calls = [];
      for (const part of parts) {
        say(`Sending ${part.name}`);
        calls.push({ tool: "upscale" as const, what: part.name, params: { key: await ensureKey(host, part.mediaId, { fresh }), target_h: targetH, start: part.srcStart, end: part.srcEnd } });
      }
      return calls;
    },
    apply: async (js) => {
      for (let i = 0; i < js.length; i++) {
        const item = await importOutput(host, firstOutput(js[i]));
        editClips(host, `Use the upscaled ${parts[i].name}`, [parts[i].clipId], (s, p) =>
          updateClips(s, ctxOf(p), [parts[i].clipId], (c) => ({ ...c, source: { type: "media", mediaId: item.id, in: 0 } })));
      }
      host.toast("Upscaled clips are in place", "ok");
    },
  });
}

// ── the edit assistant ───────────────────────────────────────────────────────

export async function askAssistant(host: EditorHost, instruction: string, history: { role: "user" | "assistant"; text: string }[],
  vocabulary: { effects?: string[]; transitions?: string[] } = {}): Promise<AiResult | null> {
  const jobs = await runFlow(host, {
    title: "Edit assistant",
    prepare: async () => [{ tool: "assistant", params: {
      instruction, history: history.slice(-10).map((t) => ({ role: t.role, text: t.text.slice(0, 4000) })),
      sequence_digest: sequenceDigest(host.project(), host.sequence(), host.selection().clipIds, vocabulary) } }],
    apply: () => undefined,
  });
  return jobs?.[0]?.result ?? null;
}

/** The picked commands: the document ones together as one undo step, then each paid one with its own price. */
export async function applyAssistant(host: EditorHost, rows: AiCommandRow[]): Promise<{ applied: number; skipped: { id: string; reason: string }[] }> {
  const docs = rows.filter((r) => !r.paid);
  const r = applyCommands(host.project(), host.sequence().id, docs);
  if (r.applied.length) commitSeq(host, `Edit assistant: ${r.applied.length} change${r.applied.length === 1 ? "" : "s"}`, r.project);
  const f = fps(host);
  for (const row of rows.filter((x) => x.paid)) {
    if (row.op === "add_music") await music(host, { prompt: row.prompt, seconds: row.end - row.start, at: secondsToFrames(row.start, f), volumeDb: row.volume_db });
    else if (row.op === "add_captions") await captions(host, { clipIds: row.clip_ids, language: row.language, words: row.words });
  }
  return { applied: r.applied.length, skipped: r.skipped };
}

// ── free tools on this PC ────────────────────────────────────────────────────

/** One analysis of a part's media (the bridge reads the whole file; the readers keep what falls inside the part). */
async function analyze(host: EditorHost, part: SourcePart, kind: AnalyzeKind, opts: AnalyzeOptions = {}): Promise<unknown> {
  const b = editorBridge();
  if (!b?.analyze) throw new Error("This runs on your PC: open the edit in Tatvam Desktop");
  try {
    return await b.analyze(host.path(), part.mediaId, kind, opts);
  } catch (e) {
    throw new Error(bridgeMessage(e));
  }
}

export interface SilenceOpts { thresholdDb: number; minMs: number; padMs: number }

export async function findSilences(host: EditorHost, clipIds: string[], o: SilenceOpts): Promise<[number, number][]> {
  const parts = soundParts(host.project(), host.sequence(), clipIds.length ? { clipIds } : { range: inOutRange(host) ?? [0, seqEnd(host.sequence())] });
  if (!parts.length) throw new Error("Select clips with sound");
  const out: [number, number][] = [];
  for (const part of parts) {
    const raw = await analyze(host, part, "silence", { noiseDb: o.thresholdDb, minMs: o.minMs });
    out.push(...silenceCuts(part, readSilences(raw), fps(host), o.padMs, o.minMs));
  }
  return out;
}

export function cutSilences(host: EditorHost, ranges: [number, number][]): boolean {
  return commitSeq(host, `Remove ${ranges.length} silence${ranges.length === 1 ? "" : "s"}`, cutRanges(host.project(), host.sequence().id, ranges));
}

export async function findScenes(host: EditorHost, clipId: string, threshold = 0.3): Promise<number[]> {
  const part = videoParts(host.project(), host.sequence(), [clipId])[0];
  if (!part) throw new Error("Pick a video clip");
  return partFrames(part, readCuts(await analyze(host, part, "scenes", { threshold })), fps(host));
}

export function applyScenes(host: EditorHost, clipId: string, frames: number[], mode: "split" | "markers"): boolean {
  const p = host.project(), sid = host.sequence().id;
  return commitSeq(host, mode === "split" ? `Split at ${frames.length} scene cuts` : `${frames.length} scene markers`,
    mode === "split" ? splitClipAt(p, sid, clipId, frames) : addSequenceMarkers(p, sid, frames, "Scene {n}", "#a78bfa"));
}

export async function beatMarkers(host: EditorHost, clipId: string): Promise<number> {
  const part = soundParts(host.project(), host.sequence(), { clipIds: [clipId] })[0];
  if (!part) throw new Error("Pick a clip with sound (music)");
  const frames = partFrames(part, readBeats(await analyze(host, part, "beats")), fps(host));
  if (frames.length) commitSeq(host, `${frames.length} beat markers`, addSequenceMarkers(host.project(), host.sequence().id, frames, "Beat", "#fbbf24"));
  return frames.length;
}

export interface LoudnessRow { clipId: string; name: string; value: Loudness | null }

export async function measureLoudness(host: EditorHost, clipIds: string[]): Promise<LoudnessRow[]> {
  const parts = soundParts(host.project(), host.sequence(), { clipIds });
  if (!parts.length) throw new Error("Select clips with sound");
  const rows: LoudnessRow[] = [];
  for (const part of parts) rows.push({ clipId: part.clipId, name: part.name, value: readLoudness(await analyze(host, part, "loudness")) });
  return rows;
}

export function normaliseLoudness(host: EditorHost, rows: LoudnessRow[], target = -14): number {
  let p = host.project();
  let n = 0;
  for (const r of rows) {
    if (!r.value) continue;
    const g = normaliseGain(r.value.lufs, r.value.peak, target);
    if (!g) continue;
    p = addGain(p, host.sequence().id, [r.clipId], g);
    n++;
  }
  if (n) commitSeq(host, `Normalise loudness to ${target} LUFS`, p);
  return n;
}
