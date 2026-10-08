import { DEFAULT_FPS } from "../../../../components/review/utils";
import type { Shot } from "../../../../lib/types";

/** One shot placed on the video track. */
/**
 * A shot on the main track. `duration` is on the cut's timeline (after trims and the speed effect); `overlap` is how
 * much it starts over the end of the previous shot (its transition), the same maths the export uses. `hold` is a
 * freeze of the last frame kept after the clip ("hold" trim mode) — preview only until the exporter supports it.
 */
export interface Clip {
  shot: Shot; src: string; still: string; duration: number; start: number; kind: string;
  overlap: number; speed: number; raw: number; trimIn: number; trimOut: number; hold: number;
}

/** A trim being dragged (saved on release). */
export interface TrimDraft { id: number; trim_in: number; trim_out: number }
/** {shot id: seconds} freezes after shots (stored with the episode's layers). */
export type Holds = Record<string, number>;
/** How trimming moves the rest of the cut: "ripple" closes the gap (clips always sit back to back), "hold" keeps the
 *  following clips where they are by freezing the trimmed clip's last frame for the time taken away. */
export type TrimMode = "ripple" | "hold";
/** Longest freeze the timeline keeps (matches backend layers.MAX_HOLD_S). */
export const MAX_HOLD = 10;

/** Lay the shots out like the export does: trims, speed, transitions overlapping the previous shot, plus holds. */
export function layoutClips(shots: Shot[], drafts?: TrimDraft | TrimDraft[] | null, trDraft?: { id: number; duration: number } | null,
  holds?: Holds | null, holdDraft?: Holds | null): Clip[] {
  const dmap = new Map((drafts ? ([] as TrimDraft[]).concat(drafts) : []).map((d) => [d.id, d]));
  let prevStart = 0, prevDur = 0, prevHold = 0;
  return shots.map((s, i) => {
    const v = s.lipsync || s.voicelock || s.video;
    const raw = v?.duration_s || s.duration_s;
    const d = dmap.get(s.id);
    const ti = d ? d.trim_in : s.trim_in || 0;
    const to = d ? d.trim_out : s.trim_out || 0;
    const speed = v ? s.fx?.speed ?? 1 : 1;
    const duration = v ? Math.max(raw - ti - to, 0.5) / speed : s.duration_s;
    const tr = s.fx?.transition;
    const want = trDraft?.id === s.id ? trDraft.duration : tr?.duration ?? 0;
    const overlap = i > 0 && tr ? Math.max(0.1, Math.min(want, duration / 2, prevDur / 2)) : 0;
    const start = i === 0 ? 0 : prevStart + prevDur + prevHold - overlap;
    const hold = Math.max(0, Math.min(MAX_HOLD, holdDraft?.[s.id] ?? holds?.[s.id] ?? 0));
    prevStart = start;
    prevDur = duration;
    prevHold = hold;
    return { shot: s, src: v?.url || "", still: s.keyframe?.url || "", duration, start, overlap, speed, raw, trimIn: ti, trimOut: to, hold,
      kind: v ? (s.lipsync ? "lipsync" : s.voicelock ? "voicelock" : "video") : "still" };
  });
}

/** When the picture switches from clip i-1 to clip i (half-way through their transition). */
export const switchTime = (c: Clip) => c.start + c.overlap / 2;
/** Where the clip's picture ends (before its freeze). */
export const clipEnd = (c: Clip) => c.start + c.duration;
/** Where the clip really stops occupying the timeline (after its freeze). */
export const clipTail = (c: Clip) => c.start + c.duration + c.hold;
export type Overlay = Shot["overlays"][number];
export interface Span { start: number; end: number; text: string }

/** Width of the sticky track-label column. */
export const LABEL_W = 132;
export const MIN_PPS = 4;
export const MAX_PPS = 240;
export const SNAP_PX = 8;
export const FPS = DEFAULT_FPS;
/** Row heights (px): the video track carries thumbnails so it is taller than the audio / text tracks. */
export const VIDEO_H = 52;
export const TRACK_H = 38;
export const RULER_H = 30;
/** backend generation.sfx_spec: 0.002 $/s × 6 s per shot when ElevenLabs is live */
export const SFX_USD_PER_SHOT = 0.012;
/** Speed presets offered on a clip (backend fx accepts 0.25–4×). */
export const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2];
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

export const ppsToSlider = (pps: number) => (Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 100;
export const sliderToPps = (v: number) => MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v / 100);
export const spansOf = (s: Shot) => ((s.voice?.params?.spans ?? []) as Span[]).filter((sp) => sp.end > sp.start);
export const mediaUrl = (path?: string) => (path ? `/media/${path}` : "");
export const round2 = (v: number) => Math.round(v * 100) / 100;
