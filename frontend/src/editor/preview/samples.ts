/**
 * The preview sample library (docs/EDITOR.md §15, preview-polish): the studio's own six AI showreel stills
 * (frontend/public/showcase, the user's own pictures, no download) as "sample clips", each with a gentle procedural
 * Ken Burns move over 3 s so motion effects and transitions read. Which sample an item shows (a mood, a look, a
 * transition's A and B), the crop of a still at a time, and which of the user's clips wins over the samples.
 * Pure: no DOM, so the node tests run it as written.
 */
import { clipEnd, tracksOf } from "../model/ops.ts";
import type { Sequence, TimelineClip } from "../model/types.ts";

export type SampleId = "holi" | "backwaters" | "dance" | "lamp" | "monsoon" | "nightshoot";

export interface Sample {
  id: SampleId; label: string;
  /** 1920 wide, and the 720 wide copy the thumbnails use. */
  url: string; smUrl: string;
  /** The Ken Burns move: zoom from z0 to z1 while the crop centre goes from (x0, y0) to (x1, y1) (fractions). */
  kb: { z0: number; z1: number; x0: number; y0: number; x1: number; y1: number };
}

const S = (id: SampleId, label: string, kb: Sample["kb"]): Sample => ({ id, label, url: `/showcase/${id}.webp`, smUrl: `/showcase/${id}-sm.webp`, kb });

export const SAMPLES: Sample[] = [
  S("holi", "Colours of Holi", { z0: 1, z1: 1.09, x0: 0.5, y0: 0.5, x1: 0.46, y1: 0.47 }),
  S("backwaters", "Backwaters at dawn", { z0: 1.02, z1: 1.1, x0: 0.44, y0: 0.5, x1: 0.56, y1: 0.48 }),
  S("dance", "Temple dance", { z0: 1, z1: 1.1, x0: 0.5, y0: 0.52, x1: 0.5, y1: 0.42 }),
  S("lamp", "The lamp", { z0: 1, z1: 1.12, x0: 0.5, y0: 0.5, x1: 0.38, y1: 0.62 }),
  S("monsoon", "Monsoon rooftop", { z0: 1.08, z1: 1, x0: 0.54, y0: 0.46, x1: 0.5, y1: 0.5 }),
  S("nightshoot", "Night shoot", { z0: 1.02, z1: 1.1, x0: 0.58, y0: 0.5, x1: 0.42, y1: 0.5 }),
];
export const SAMPLE_IDS = SAMPLES.map((s) => s.id);
export const sampleById = (id: string): Sample | undefined => SAMPLES.find((s) => s.id === id);

/** The Ken Burns period: one way in 3 s, then back (a ping-pong, so a loop never jumps). */
export const KB_SECONDS = 3;

/** A stable 32-bit hash of a string (FNV-1a). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// ── which sample an item shows ─────────────────────────────────────────────────────────────────────────

/** Moods by id (docs: the brief's mapping, then the rest of lib/moods.ts that have an obvious picture). */
const BY_ID: Record<string, SampleId> = {
  horror: "lamp", thriller: "nightshoot",
  romantic: "backwaters", dreamy: "backwaters",
  devotional: "lamp",
  festival: "holi", joyful: "holi",
  epic: "monsoon",
  dance: "dance", music_video: "dance",
  noir: "nightshoot", mystery: "lamp", cyberpunk: "nightshoot", action: "nightshoot",
  monsoon: "monsoon", melancholy: "monsoon",
  summer: "holi", comedy: "holi",
  nostalgic: "backwaters", inspiring: "backwaters", documentary: "nightshoot",
};

/** Words in an item's id, name or description → the sample that fits (first match wins, in this order). */
const BY_WORD: [RegExp, SampleId][] = [
  [/horror|scary|haunt|creep|ghost|candle|spirit|devot|temple|divine|golden|prayer|mystic|mystery|secret/, "lamp"],
  [/thrill|noir|crime|night|neon|cyber|street|city|urban|rain ?street|action|spy|tension|steel|gritty|documentary|news|vhs|glitch|retro|gaming|arcade|pixel/, "nightshoot"],
  [/music|dance|club|party|concert|beat|groove|rhythm|stage/, "dance"],
  [/festiv|joy|holi|celebr|colou?r|vivid|summer|comedy|bright|pop|fun|food|kids|happy|saturat|travel/, "holi"],
  [/epic|monsoon|storm|heroic|trailer|blockbuster|teal|orange|bleach|cold|melanchol|grey|gray|moody|wet|fitness|sport/, "monsoon"],
  [/roman|dream|wedding|love|soft|pastel|dawn|haze|bloom|warm|vintage|film|nostalg|calm|nature|real estate|corporate|education|podcast|quote/, "backwaters"],
];

/**
 * The sample an item shows: moods by id (the brief's mapping), then by the words of its id, name and description,
 * else a stable choice per item (a hash of its id), so the same item always shows the same picture.
 */
export function sampleFor(id: string, text = ""): SampleId {
  const key = id.toLowerCase();
  const bare = key.replace(/^(mood|look|lut)[.:]/, "");
  if (BY_ID[bare]) return BY_ID[bare];
  const words = `${bare.replace(/[._:-]+/g, " ")} ${text.toLowerCase()}`;
  for (const [re, s] of BY_WORD) if (re.test(words)) return s;
  return SAMPLE_IDS[hash32(key) % SAMPLE_IDS.length];
}

/** A transition's A and B: two different samples, stable per id. */
export function samplePair(id: string): [SampleId, SampleId] {
  const h = hash32(id);
  const a = h % SAMPLE_IDS.length;
  const b = (a + 1 + ((h >>> 8) % (SAMPLE_IDS.length - 1))) % SAMPLE_IDS.length;
  return [SAMPLE_IDS[a], SAMPLE_IDS[b]];
}

// ── the move and the crop ──────────────────────────────────────────────────────────────────────────────

const smooth = (u: number) => u * u * (3 - 2 * u);

/** Where the Ken Burns move is at `t` seconds: 0 at t = 0, 1 at KB_SECONDS, back to 0 at twice that (eased). */
export function kbPhase(t: number, period = KB_SECONDS): number {
  if (!(period > 0) || !Number.isFinite(t)) return 0;
  const k = ((t / period) % 2 + 2) % 2;
  return smooth(k <= 1 ? k : 2 - k);
}

/** The crop of a still at `t`: zoom (≥ 1) and the crop centre (fractions of the picture). */
export function kenBurns(kb: Sample["kb"], t: number, period = KB_SECONDS): { zoom: number; cx: number; cy: number } {
  const u = kbPhase(t, period);
  return { zoom: kb.z0 + (kb.z1 - kb.z0) * u, cx: kb.x0 + (kb.x1 - kb.x0) * u, cy: kb.y0 + (kb.y1 - kb.y0) * u };
}

/**
 * The source rectangle that covers a dstW × dstH frame from a srcW × srcH picture, zoomed in by `zoom` around
 * (cx, cy), kept inside the picture.
 */
export function coverCrop(srcW: number, srcH: number, dstW: number, dstH: number, zoom = 1, cx = 0.5, cy = 0.5): { sx: number; sy: number; sw: number; sh: number } {
  const sa = srcW / Math.max(1, srcH), da = dstW / Math.max(1, dstH);
  let sw = sa > da ? srcH * da : srcW, sh = sa > da ? srcH : srcW / da;
  const z = Math.max(1, zoom);
  sw /= z; sh /= z;
  const sx = Math.min(srcW - sw, Math.max(0, cx * srcW - sw / 2)), sy = Math.min(srcH - sh, Math.max(0, cy * srcH - sh / 2));
  return { sx, sy, sw, sh };
}

// ── the user's own clip wins ───────────────────────────────────────────────────────────────────────────

const isPicture = (s: Sequence, c: TimelineClip, vids: Set<string>) => c.source.type === "media" && vids.has(c.trackId);

/**
 * The user's clip the previews show instead of the samples: the selected video clip, else the V1 clip under the
 * playhead, else the first V1 clip (then any video track, in the same order). Null when the edit has no video clip.
 */
export function pickUserClip(s: Sequence, selection: readonly string[], frame: number): TimelineClip | null {
  const vts = tracksOf(s, "video");
  const vids = new Set(vts.map((t) => t.id));
  const pics = s.clips.filter((c) => isPicture(s, c, vids));
  if (!pics.length) return null;
  const sel = pics.find((c) => selection.includes(c.id));
  if (sel) return sel;
  const byStart = (a: TimelineClip, b: TimelineClip) => a.start - b.start;
  for (const t of vts) {
    const on = pics.filter((c) => c.trackId === t.id).sort(byStart);
    if (!on.length) continue;
    return on.find((c) => c.start <= frame && frame < clipEnd(c)) ?? on[0];
  }
  return pics.sort(byStart)[0] ?? null;
}

/** The clip after `c` on its track (a transition's B side), or null. */
export function nextClipOnTrack(s: Sequence, c: TimelineClip): TimelineClip | null {
  return s.clips.filter((x) => x.trackId === c.trackId && x.id !== c.id && x.start >= clipEnd(c) && x.source.type === "media").sort((a, b) => a.start - b.start)[0] ?? null;
}
