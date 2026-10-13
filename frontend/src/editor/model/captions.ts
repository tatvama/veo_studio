/**
 * Karaoke word timings (TitleSpec.karaoke, seconds from the clip's start) through edits, the way keyframes go: a
 * trimmed start or a slip moves them (words outside the clip stay, like keyframes and media handles, so trimming back
 * brings them back), a speed change scales them, and a split gives each half its own words — a word goes to the side
 * holding its middle and is cut at the edit — measured from that half's start. Pure.
 */
import type { KaraokeSpec, TimelineClip } from "./types.ts";

type Word = KaraokeSpec["words"][number];
const R = (v: number) => Math.round(v * 1e6) / 1e6;

export const hasWords = (c: TimelineClip) => c.source.type === "title" && !!c.source.text.karaoke?.words?.length;

function mapWords(c: TimelineClip, fn: (w: Word) => Word | null): TimelineClip {
  if (c.source.type !== "title" || !c.source.text.karaoke?.words?.length) return c;
  const k = c.source.text.karaoke;
  const words = k.words.map(fn).filter((w): w is Word => !!w);
  return { ...c, source: { ...c.source, text: { ...c.source.text, karaoke: { ...k, words } } } };
}

/** Every word `ds` seconds later (negative: earlier). */
export const shiftWords = (c: TimelineClip, ds: number): TimelineClip =>
  (!ds ? c : mapWords(c, (w) => ({ ...w, start: R(w.start + ds), end: R(w.end + ds) })));

/** Word times multiplied by `k` (the clip got k times longer). */
export const scaleWords = (c: TimelineClip, k: number): TimelineClip =>
  (k === 1 ? c : mapWords(c, (w) => ({ ...w, start: R(w.start * k), end: R(w.end * k) })));

/** One half of a split at `cut` seconds: the words whose middle is on that side, cut at the edit (the right half's
 *  times start from the cut). */
export function splitWords(c: TimelineClip, cut: number, side: "left" | "right"): TimelineClip {
  return mapWords(c, (w) => {
    const mid = (w.start + w.end) / 2;
    if (side === "left") return mid < cut ? { ...w, end: R(Math.min(w.end, cut)) } : null;
    return mid >= cut ? { ...w, start: R(Math.max(w.start, cut) - cut), end: R(w.end - cut) } : null;
  });
}
