/**
 * Edit by transcript (docs/EDITOR.md §10): transcripts are kept per media item in SOURCE seconds (local Whisper, the
 * AI captions tool), so they stay right however the clips are cut. `placeWords` puts each word where the timeline
 * shows it now; deleting words is a razor at the range edges and a ripple (extract) across the clip's linked A/V and
 * the sync-locked tracks, one range at a time from the end, in one command. Caption clips give a transcript of their
 * own (timeline-based). Pure.
 */
import { clipEnd, extract, normalize, sourceRate, tracksOf, withLinked, type Ctx } from "../model/ops.ts";
import { fpsExact, framesToSeconds, secondsToFrames } from "../model/time.ts";
import type { Sequence, TimelineClip, TitleSpec } from "../model/types.ts";

export interface TWord { start: number; end: number; text: string; speaker?: string }
export interface Transcript { mediaId: string; language?: string; words: TWord[]; source: "whisper" | "ai" | "captions" }

/** A word where the timeline shows it: [from, to) timeline frames. */
export interface PlacedWord { key: string; text: string; from: number; to: number; clipId: string; trackId: string; speaker?: string; mediaId?: string; filler: boolean }

/** Filler words in English and the studio's Indian languages (lower case, romanised and native script). */
export const FILLERS = [
  "um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "ahh", "hmm", "mm", "mhm", "like", "you know", "i mean", "basically", "actually", "so yeah",
  "matlab", "मतलब", "yaani", "यानी", "accha", "achha", "अच्छा", "haan", "हाँ", "हां", "toh", "तो", "bas", "बस", "na", "ना", "arre", "अरे",
  "ante", "అంటే", "adi", "అది", "andre", "ಅಂದ್ರೆ", "adu", "ಅದು", "vandhu", "வந்து", "athu", "அது", "enna", "என்ன",
];
const FILLER_SET = new Set(FILLERS.filter((f) => !f.includes(" ")));
const clean = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{M}\p{N}' ]+/gu, "").trim();
/** Single-word fillers (multi-word ones like "you know" are found by findFillers). */
export const isFiller = (w: string) => FILLER_SET.has(clean(w)) && clean(w) !== "like";

/** Keys of filler words, "you know" / "i mean" pairs included; "like" only on its own between pauses is left alone. */
export function findFillers(words: PlacedWord[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = clean(words[i].text);
    if (FILLER_SET.has(w) && w !== "like") out.push(words[i].key);
    const two = i + 1 < words.length ? `${w} ${clean(words[i + 1].text)}` : "";
    if (two === "you know" || two === "i mean") { out.push(words[i].key, words[i + 1].key); i++; }
  }
  return out;
}

/**
 * Words of the media transcripts where the timeline shows them. Clips on audio tracks first (their linked video half
 * is skipped); video clips with no sound clip of their own also count. A word shows when its middle is inside the clip.
 */
export function placeWords(seq: Sequence, ctx: Ctx, transcripts: Record<string, Transcript>, opts: { clipIds?: string[] } = {}): PlacedWord[] {
  const audio = new Set(tracksOf(seq, "audio").map((t) => t.id));
  const only = opts.clipIds ? new Set(withLinked(seq, opts.clipIds)) : null;
  const media = seq.clips.filter((c) => c.enabled && c.source.type === "media" && transcripts[c.source.mediaId] && (!only || only.has(c.id)));
  const audioLinks = new Set(media.filter((c) => audio.has(c.trackId) && c.linkId).map((c) => c.linkId!));
  const use = media.filter((c) => audio.has(c.trackId) || !(c.linkId && audioLinks.has(c.linkId)));
  const out: PlacedWord[] = [];
  for (const c of use) {
    if (c.source.type !== "media") continue;
    const m = ctx.media(c.source.mediaId);
    const tr = transcripts[c.source.mediaId];
    const r = sourceRate(c, seq, ctx);
    const mf = m && m.fps > 0 ? m.fps : seq.fps;
    // source seconds → timeline frames for this clip (reverse clips aren't transcribed)
    if (c.reverse) continue;
    const srcIn = c.source.in, srcFps = fpsExact(mf);
    const toFrame = (sec: number) => c.start + (sec * srcFps - srcIn) / r;
    tr.words.forEach((w, i) => {
      const mid = (w.start + w.end) / 2;
      const fm = toFrame(mid);
      if (fm < c.start || fm >= clipEnd(c)) return;
      const from = Math.max(c.start, Math.floor(toFrame(w.start) + 1e-6)), to = Math.min(clipEnd(c), Math.max(from + 1, Math.ceil(toFrame(w.end) - 1e-6)));
      out.push({ key: `${c.id}:${i}`, text: w.text, from, to, clipId: c.id, trackId: c.trackId, speaker: w.speaker, mediaId: c.source.type === "media" ? c.source.mediaId : undefined, filler: false });
    });
  }
  out.sort((a, b) => a.from - b.from || a.key.localeCompare(b.key));
  for (const k of findFillers(out)) { const w = out.find((x) => x.key === k); if (w) w.filler = true; }
  return out;
}

/** Caption clips (title clips on a captions track, karaoke words or their text spread over the clip) as words. */
export function captionWords(seq: Sequence): PlacedWord[] {
  const video = new Set(tracksOf(seq, "video").map((t) => t.id));
  const out: PlacedWord[] = [];
  for (const c of seq.clips) {
    if (!video.has(c.trackId) || c.source.type !== "title" || !c.enabled) continue;
    const spec: TitleSpec = c.source.text;
    const words = spec.karaoke?.words.length ? spec.karaoke.words.map((w) => ({ start: w.start, end: w.end, text: w.text }))
      : spreadWords(spec.text, framesToSeconds(c.duration, seq.fps));
    words.forEach((w, i) => {
      const from = c.start + Math.max(0, Math.floor(secondsToFrames(w.start, seq.fps)));
      const to = Math.min(clipEnd(c), Math.max(from + 1, c.start + secondsToFrames(w.end, seq.fps)));
      if (from >= clipEnd(c)) return;
      out.push({ key: `${c.id}:${i}`, text: w.text, from, to, clipId: c.id, trackId: c.trackId, filler: false });
    });
  }
  out.sort((a, b) => a.from - b.from || a.key.localeCompare(b.key));
  for (const k of findFillers(out)) { const w = out.find((x) => x.key === k); if (w) w.filler = true; }
  return out;
}

function spreadWords(text: string, seconds: number): { start: number; end: number; text: string }[] {
  const parts = text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((n, p) => n + p.length + 1, 0) || 1;
  let t = 0;
  return parts.map((p) => { const d = (seconds * (p.length + 1)) / total; const w = { start: t, end: t + d, text: p }; t += d; return w; });
}

/** Ranges to remove: the selected words merged (touching or within `join` frames) per clip, widened by `pad`. */
export function wordRanges(words: PlacedWord[], selected: Iterable<string>, opts: { pad?: number; join?: number } = {}): { from: number; to: number; clipIds: string[] }[] {
  const sel = new Set(selected);
  const pad = Math.max(0, opts.pad ?? 0), join = Math.max(0, opts.join ?? 1);
  const picked = words.filter((w) => sel.has(w.key)).map((w) => ({ from: Math.max(0, w.from - pad), to: w.to + pad, clipIds: [w.clipId] })).sort((a, b) => a.from - b.from);
  const out: { from: number; to: number; clipIds: string[] }[] = [];
  for (const r of picked) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + join) { last.to = Math.max(last.to, r.to); for (const id of r.clipIds) if (!last.clipIds.includes(id)) last.clipIds.push(id); }
    else out.push({ ...r, clipIds: [...r.clipIds] });
  }
  return out;
}

/**
 * Removes the ranges: each is extracted (cut at both edges and the gap closed) on the tracks of its clips and their
 * linked halves, plus the sync-locked tracks — from the last range to the first so earlier ones don't move. With
 * `allTracks` (caption transcripts) every unlocked track is cut.
 */
export function cutRanges(seq: Sequence, ctx: Ctx, ranges: { from: number; to: number; clipIds: string[] }[], opts: { allTracks?: boolean } = {}): Sequence {
  let s = seq;
  for (const r of [...ranges].sort((a, b) => b.from - a.from)) {
    if (r.to <= r.from) continue;
    const tracks = opts.allTracks ? s.tracks.filter((t) => !t.locked).map((t) => t.id)
      : [...new Set(withLinked(s, r.clipIds).map((id) => s.clips.find((c) => c.id === id)?.trackId).filter((x): x is string => !!x))];
    if (!tracks.length) continue;
    s = extract(s, ctx, r.from, r.to, tracks);
  }
  return normalize(s, ctx);
}

/** Word timings (source seconds) from whatever a transcriber returned: words, else segments' words, else segment text spread. */
export function wordsFromSegments(segments: { start: number; end: number; text: string; speaker?: string; words?: { start: number; end: number; text: string }[] }[]): TWord[] {
  const out: TWord[] = [];
  for (const s of segments) {
    if (s.words?.length) { for (const w of s.words) if (w.text.trim()) out.push({ start: w.start, end: w.end, text: w.text.trim(), ...(s.speaker ? { speaker: s.speaker } : {}) }); }
    else for (const w of spreadWords(s.text, Math.max(0.05, s.end - s.start))) out.push({ start: s.start + w.start, end: s.start + w.end, text: w.text, ...(s.speaker ? { speaker: s.speaker } : {}) });
  }
  return out.sort((a, b) => a.start - b.start);
}

export type { TimelineClip };
