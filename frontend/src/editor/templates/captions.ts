/**
 * Captions with karaoke (docs/EDITOR.md §8, §10): speech segments with word timings (the AI captions tool, local
 * Whisper) → caption cues of a few words each, every cue a title clip whose TitleSpec.karaoke holds its words (seconds
 * from the clip's start) so render/title.ts highlights each word as it's spoken.
 *
 *   const cues = captionTrackFromSegments(segments, { fps: seq.fps, height: seq.height, offset: clipStartSeconds, karaoke: "word" });
 *   addCaptionTrack(host, cues, "Captions");          // one undoable command: a new video track with the cues
 *
 * The cue maths is pure; addCaptionTrack goes through the EditorHost.
 */
import { defaultTitle } from "../model/defaults.ts";
import { addGenerated, addTrack, ctxOf } from "../model/ops.ts";
import { framesToSeconds, secondsToFrames } from "../model/time.ts";
import type { EditorHost, KaraokeSpec, TitleSpec } from "../model/types.ts";

export interface CaptionWord { start: number; end: number; text: string }
export interface CaptionSegment { start: number; end: number; text: string; words?: CaptionWord[]; speaker?: string }

export interface CaptionStyle {
  /** One of CAPTION_STYLES' ids, or none (plain white captions on a box). */
  preset?: string;
  fps: number;
  /** The sequence's height (sizes are at 1080 lines). */
  height?: number;
  /** Seconds added to every time: where the segments' zero is on the timeline. */
  offset?: number;
  /** Highlight mode; false = plain captions (no karaoke). Default: the preset's. */
  karaoke?: KaraokeSpec["mode"] | false;
  /** A cue holds at most this many words / characters. */
  maxWords?: number; maxChars?: number;
  color?: string; highlightColor?: string;
  /** Anything else for the title (font, size, box …). */
  spec?: Partial<TitleSpec>;
}

export interface CaptionCue { start: number; end: number; text: string; spec: TitleSpec; speaker?: string }

const CAPTION_BOX: [number, number, number, number] = [0.08, 0.76, 0.84, 0.16];

/** Caption looks for the Captions tab and the AI tool. Sizes at 1080 lines. */
export const CAPTION_STYLES: { id: string; label: string; karaoke: KaraokeSpec["mode"] | false; color: string; highlight: string; spec: Partial<TitleSpec> }[] = [
  { id: "karaoke-word", label: "Karaoke · word", karaoke: "word", color: "#ffffff", highlight: "#facc15",
    spec: { font: "Montserrat Variable", weight: 800, size: 68, outline: { color: "#000000", width: 5 }, shadow: { color: "#000000aa", blur: 10, x: 0, y: 3 } } },
  { id: "karaoke-fill", label: "Karaoke · fill", karaoke: "fill", color: "#ffffffcc", highlight: "#22d3ee",
    spec: { font: "Poppins", weight: 800, size: 64, outline: { color: "#0f172a", width: 4 } } },
  { id: "karaoke-bounce", label: "Karaoke · bounce", karaoke: "bounce", color: "#ffffff", highlight: "#fb7185",
    spec: { font: "Baloo 2 Variable", weight: 800, size: 72, outline: { color: "#000000", width: 6 } } },
  { id: "karaoke-box", label: "Karaoke · boxed", karaoke: "word", color: "#e5e7eb", highlight: "#ffffff",
    spec: { font: "Inter Variable", weight: 700, size: 58, background: { color: "#000000b3", padding: 16, radius: 10 }, shadow: undefined } },
  { id: "clean", label: "Clean", karaoke: false, color: "#ffffff", highlight: "#ffffff",
    spec: { font: "Inter Variable", weight: 600, size: 58, background: { color: "#000000a6", padding: 14, radius: 8 }, shadow: undefined } },
  { id: "bold-yellow", label: "Bold yellow", karaoke: false, color: "#fde047", highlight: "#fde047",
    spec: { font: "Anton", weight: 400, size: 76, outline: { color: "#000000", width: 6 } } },
  { id: "indic", label: "Indic (Anek)", karaoke: "word", color: "#ffffff", highlight: "#fbbf24",
    spec: { font: "Anek Devanagari Variable", weight: 700, size: 66, outline: { color: "#000000", width: 5 } } },
];

/** Words of a segment: its own timings, else its text spread over its time by length. */
export function segmentWords(s: CaptionSegment): CaptionWord[] {
  const own = (s.words ?? []).flatMap((w) => {
    const parts = w.text.trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return parts.length ? [{ start: w.start, end: Math.max(w.end, w.start), text: parts[0] }] : [];
    const span = Math.max(0, w.end - w.start), total = parts.reduce((n, p) => n + p.length, 0);
    let t = w.start;
    return parts.map((p) => { const d = (span * p.length) / total; const x = { start: t, end: t + d, text: p }; t += d; return x; });
  });
  if (own.length) return own;
  const parts = s.text.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const span = Math.max(0.05, s.end - s.start), total = parts.reduce((n, p) => n + p.length + 1, 0);
  let t = s.start;
  return parts.map((p) => { const d = (span * (p.length + 1)) / total; const x = { start: t, end: t + d, text: p }; t += d; return x; });
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Segments (seconds) → caption cues (timeline frames) of at most `maxWords` words / `maxChars` characters, never across
 * a segment (or speaker) boundary. A cue lasts from its first word to its last (at least 0.4 s), holds through short
 * pauses (under 0.3 s) to the next cue, and never overlaps it. With karaoke each cue's spec carries its words, timed
 * from the cue's first frame.
 */
export function captionTrackFromSegments(segments: CaptionSegment[], style: CaptionStyle): CaptionCue[] {
  const preset = CAPTION_STYLES.find((x) => x.id === (style.preset ?? "karaoke-word")) ?? CAPTION_STYLES[0];
  const mode = style.karaoke === undefined ? preset.karaoke : style.karaoke;
  const fps = style.fps, off = style.offset ?? 0, k = (style.height ?? 1080) / 1080;
  const maxWords = Math.max(1, style.maxWords ?? 6), maxChars = Math.max(8, style.maxChars ?? 38);
  const groups: { words: CaptionWord[]; speaker?: string }[] = [];
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    let cur: CaptionWord[] = [];
    for (const w of segmentWords(s)) {
      const len = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
      if (cur.length && (cur.length >= maxWords || len > maxChars)) { groups.push({ words: cur, speaker: s.speaker }); cur = []; }
      cur.push(w);
    }
    if (cur.length) groups.push({ words: cur, speaker: s.speaker });
  }
  const scaled: Partial<TitleSpec> = { ...preset.spec, ...style.spec };
  if (scaled.size) scaled.size = Math.round(scaled.size * k);
  if (scaled.outline) scaled.outline = { ...scaled.outline, width: Math.round(scaled.outline.width * k * 10) / 10 };
  const base: TitleSpec = { ...defaultTitle(""), box: CAPTION_BOX, animIn: "none", animOut: "none", ...scaled, color: style.color ?? preset.color };
  const cues: CaptionCue[] = [];
  groups.forEach((g, i) => {
    const a = secondsToFrames(g.words[0].start + off, fps);
    let b = Math.max(a + Math.max(1, secondsToFrames(0.4, fps)), secondsToFrames(g.words[g.words.length - 1].end + off, fps));
    const next = groups[i + 1];
    if (next) {
      const n = secondsToFrames(next.words[0].start + off, fps);
      if (n - b < secondsToFrames(0.3, fps)) b = Math.max(b, n);
      b = Math.min(b, n);
    }
    if (b <= a) b = a + 1;
    const text = g.words.map((w) => w.text).join(" ");
    const t0 = framesToSeconds(a, fps) - off;
    const spec: TitleSpec = { ...base, text };
    if (mode) spec.karaoke = { mode, color: style.color ?? preset.color, highlightColor: style.highlightColor ?? preset.highlight,
      words: g.words.map((w) => ({ start: r3(Math.max(0, w.start - t0)), end: r3(Math.max(0, w.end - t0)), text: w.text })) };
    cues.push({ start: a, end: b, text, spec, ...(g.speaker ? { speaker: g.speaker } : {}) });
  });
  return cues;
}

/**
 * Puts caption cues on a new video track at the top of the active sequence, in one undoable command. Returns the
 * track id (or null when there was nothing to add).
 */
export function addCaptionTrack(host: Pick<EditorHost, "apply">, cues: CaptionCue[], name = "Captions"): string | null {
  if (!cues.length) return null;
  let made: string | null = null;
  host.apply(`Add ${name}`, (draft) => {
    const i = Math.max(0, draft.sequences.findIndex((s) => s.id === draft.activeSequenceId));
    const ctx = ctxOf(draft);
    const r = addTrack(draft.sequences[i], "video");
    let s = { ...r.seq, tracks: r.seq.tracks.map((t) => (t.id === r.trackId ? { ...t, name } : t)) };
    for (const c of cues) s = addGenerated(s, ctx, r.trackId, c.start, Math.max(1, c.end - c.start), { type: "title", text: c.spec }, c.text.slice(0, 40) || "Caption").seq;
    draft.sequences[i] = s;
    made = r.trackId;
  });
  return made;
}

/** Re-styles caption clips (a preset) keeping their text and word timings. */
export function restyleCaption(spec: TitleSpec, presetId: string, height = 1080): TitleSpec {
  const p = CAPTION_STYLES.find((x) => x.id === presetId);
  if (!p) return spec;
  const k = height / 1080;
  const next: TitleSpec = { ...spec, ...p.spec, color: p.color, text: spec.text, box: spec.box };
  if (p.spec.size) next.size = Math.round(p.spec.size * k);
  if (!p.spec.background) delete next.background;
  if (!p.spec.outline) delete next.outline;
  if (p.karaoke && spec.karaoke) next.karaoke = { ...spec.karaoke, mode: p.karaoke, color: p.color, highlightColor: p.highlight };
  else if (!p.karaoke) delete next.karaoke;
  return next;
}
