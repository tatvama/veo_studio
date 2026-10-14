/**
 * AI-content labels (docs/EDITOR.md §16.10, India IT Rules 2026): while studio-made media (AI shots, `MediaItem.path`
 * "studio:<key>") is on screen, the "AI-generated" label strap is shown over it. Ranges come from enabled clips on
 * visible picture tracks (nested sequences are looked into), and ranges that touch or nearly touch are merged. Labels go
 * on their own "AI label" track (a strap track above Straps), so name straps are never overwritten; labels placed by
 * hand are kept and the ranges they cover are left out. `aiLabels` is the dry run, `applyAiLabels` replaces the earlier
 * automatic labels on a draft (one undo step). Pure.
 */
import { addTrack, ctxOf, removeClips, trackById, updateTrack } from "../../model/ops.ts";
import { secondsToFrames } from "../../model/time.ts";
import type { EditProject, MediaItem, Sequence } from "../../model/types.ts";
import { addGraphic, ensureGfxTrack } from "../commands.ts";
import { AUTO_KEY, aiLabelTemplate, autoClips, isAiLabelClip } from "./tags.ts";

export const AI_LABEL_TRACK = "AI label";
export interface FrameRange { from: number; to: number }
export interface AiRange extends FrameRange { mediaIds: string[] }

/** Studio-made (AI) media. */
export const isAiMedia = (m: Pick<MediaItem, "path">) => /^studio:/i.test(m.path ?? "");

/** Ranges sorted and merged when they overlap or are at most `join` frames apart. */
export function mergeRanges<R extends FrameRange & { mediaIds?: string[] }>(rs: R[], join = 0): R[] {
  const out: R[] = [];
  for (const r of [...rs].sort((a, b) => a.from - b.from)) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + join) {
      last.to = Math.max(last.to, r.to);
      if (last.mediaIds && r.mediaIds) for (const m of r.mediaIds) if (!last.mediaIds.includes(m)) last.mediaIds.push(m);
    } else out.push({ ...r, ...(r.mediaIds ? { mediaIds: [...r.mediaIds] } : {}) });
  }
  return out;
}

/** `rs` minus the spans in `cut`. */
export function subtractRanges<R extends FrameRange>(rs: R[], cut: FrameRange[]): R[] {
  let out = rs.map((r) => ({ ...r }));
  for (const c of cut) {
    out = out.flatMap((r) => {
      if (c.to <= r.from || c.from >= r.to) return [r];
      const parts: R[] = [];
      if (c.from > r.from) parts.push({ ...r, to: c.from });
      if (c.to < r.to) parts.push({ ...r, from: c.to });
      return parts;
    });
  }
  return out.filter((r) => r.to > r.from);
}

function collect(p: EditProject, seq: Sequence, depth: number): AiRange[] {
  const media = new Map(p.media.map((m) => [m.id, m]));
  const shown = new Set(seq.tracks.filter((t) => t.kind === "video" && !t.hidden && !t.gfxRole).map((t) => t.id));
  const out: AiRange[] = [];
  for (const c of seq.clips) {
    if (!c.enabled || !shown.has(c.trackId)) continue;
    const end = c.start + c.duration;
    if (c.source.type === "media") {
      const m = media.get(c.source.mediaId);
      if (m && m.kind !== "audio" && isAiMedia(m)) out.push({ from: c.start, to: end, mediaIds: [m.id] });
    } else if (c.source.type === "nested" && depth < 4) {
      const nestedId = c.source.sequenceId;
      const inner = p.sequences.find((s) => s.id === nestedId);
      if (!inner) continue;
      const k = (c.speed || 1) * (inner.fps / seq.fps);
      const srcIn = c.source.in;
      for (const r of collect(p, inner, depth + 1)) {
        const from = c.reverse ? c.start : Math.max(c.start, Math.floor(c.start + (r.from - srcIn) / k));
        const to = c.reverse ? end : Math.min(end, Math.ceil(c.start + (r.to - srcIn) / k));
        if (to > from) out.push({ from, to, mediaIds: r.mediaIds });
      }
    }
  }
  return out;
}

/** Where AI-made media is on screen in a sequence (frames), merged across gaps of up to `join` seconds (default 0.5). */
export function aiRanges(p: EditProject, seqId: string, o: { join?: number } = {}): AiRange[] {
  const seq = p.sequences.find((s) => s.id === seqId);
  if (!seq) return [];
  return mergeRanges(collect(p, seq, 0), secondsToFrames(o.join ?? 0.5, seq.fps));
}

/** Spans of the AI-content labels in a sequence (automatic and placed by hand). */
export function labelSpans(p: EditProject, seq: Sequence, o: { manualOnly?: boolean } = {}): FrameRange[] {
  return seq.clips.filter((c) => c.enabled && isAiLabelClip(p, c) && !(o.manualOnly && (c.source.type === "graphic" && c.source.gfx.values[AUTO_KEY] === "ai-label")))
    .map((c) => ({ from: c.start, to: c.start + c.duration }));
}

export interface AiLabelPlan {
  ranges: AiRange[];
  /** Labels to place (ranges not already covered by a label placed by hand). */
  items: FrameRange[];
  /** Earlier automatic labels that are replaced. */ replaced: string[];
  /** The label template (missing: nothing can be placed). */ template?: string;
}

/** The dry run (see the module header). */
export function aiLabels(p: EditProject, seqId: string, o: { join?: number } = {}): AiLabelPlan {
  const seq = p.sequences.find((s) => s.id === seqId);
  if (!seq) return { ranges: [], items: [], replaced: [] };
  const ranges = aiRanges(p, seqId, o);
  const t = aiLabelTemplate(p);
  const items = subtractRanges(ranges.map(({ from, to }) => ({ from, to })), labelSpans(p, seq, { manualOnly: true }));
  return { ranges, items, replaced: autoClips(seq, "ai-label").map((c) => c.id), ...(t ? { template: t.id } : {}) };
}

/** The "AI label" track (made above the Straps track when missing); returns its id. */
export function ensureLabelTrack(p: EditProject, seqId: string): string {
  const i = p.sequences.findIndex((s) => s.id === seqId);
  const have = p.sequences[i].tracks.find((t) => t.kind === "video" && t.gfxRole === "strap" && t.name === AI_LABEL_TRACK);
  if (have) return have.id;
  const straps = ensureGfxTrack(p, seqId, "strap");
  const seq = p.sequences[i];
  const st = trackById(seq, straps);
  const r = addTrack(seq, "video", st ? st.index + 1 : undefined);
  p.sequences[i] = updateTrack(r.seq, r.trackId, { name: AI_LABEL_TRACK, gfxRole: "strap" });
  return r.trackId;
}

/** Places a plan's labels on a draft (earlier automatic labels removed first); returns the new clip ids. */
export function applyAiLabels(p: EditProject, seqId: string, plan: AiLabelPlan): string[] {
  const i = p.sequences.findIndex((s) => s.id === seqId);
  if (i < 0) return [];
  const old = autoClips(p.sequences[i], "ai-label").map((c) => c.id);
  if (old.length) p.sequences[i] = removeClips(p.sequences[i], ctxOf(p), old);
  if (!plan.template || !plan.items.length) return [];
  const trackId = ensureLabelTrack(p, seqId);
  return plan.items.map((r) => addGraphic(p, plan.template!, { at: r.from, duration: r.to - r.from, values: { [AUTO_KEY]: "ai-label" }, trackId, seqId }));
}
