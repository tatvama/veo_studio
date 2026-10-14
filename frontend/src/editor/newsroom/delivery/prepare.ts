/**
 * What a news export draws (docs/EDITOR.md §16.11), made from the saved edit in the GPU render window
 * (delivery/window.ts) so the export goes through `buildComposition` like the preview:
 *  1. a language version: each graphic's `langs[lang]` values over its own;
 *  2. the other ratio: `companionProject` (newsroom/companion.ts);
 *  3. graphics only: the graphics tracks (of some roles, or some clips), nothing else, no sound.
 * Also the straight-alpha matte from a black and a white render (the fallback when the engine can't draw on
 * transparency). Pure.
 */
import type { EditProject, Sequence } from "../../model/types.ts";
import { companionProject } from "../companion.ts";
import type { GfxRatio, GfxValue } from "../types.ts";

/** The window's options (desktop/src/shared/types.ts NewsGpuOptions). */
export interface NewsGpuOptions {
  alpha?: boolean;
  only?: "graphics" | "all";
  roles?: string[]; clipIds?: string[];
  ratio?: GfxRatio;
  lang?: string;
  background?: string;
}

/** The ratio a frame size is closest to. */
export function seqRatio(w: number, h: number): GfxRatio {
  const a = w / h;
  return a > 1.3 ? "16:9" : a < 0.7 ? "9:16" : a < 0.9 ? "4:5" : "1:1";
}

const mapSeq = (p: EditProject, id: string, fn: (s: Sequence) => Sequence): EditProject =>
  ({ ...p, sequences: p.sequences.map((s) => (s.id === id ? fn(s) : s)) });

/** Every graphic's values for one language (its `langs[lang]` win; graphics without that language stay as they are). */
export function withLanguage(p: EditProject, lang: string): EditProject {
  let changed = false;
  const sequences = p.sequences.map((s) => {
    let hit = false;
    const clips = s.clips.map((c) => {
      if (c.source.type !== "graphic") return c;
      const own = c.source.gfx.langs?.[lang];
      if (!own || !Object.keys(own).length) return c;
      hit = true;
      const values: Record<string, GfxValue> = { ...c.source.gfx.values, ...own };
      return { ...c, source: { ...c.source, gfx: { ...c.source.gfx, values } } };
    });
    if (!hit) return s;
    changed = true;
    return { ...s, clips };
  });
  return changed ? { ...p, sequences } : p;
}

/** Languages the edit has versions in: `newsroom.langs`, then any graphic's `langs` keys. */
export function editLanguages(p: EditProject): string[] {
  const out = new Set<string>(p.newsroom?.langs ?? []);
  for (const s of p.sequences) for (const c of s.clips) if (c.source.type === "graphic") for (const k of Object.keys(c.source.gfx.langs ?? {})) out.add(k);
  return [...out];
}

/** Only the graphics tracks of a sequence (of `roles`; only `clipIds` when given): pictures, titles and sound go. */
export function graphicsOnly(p: EditProject, seqId: string, o: { roles?: string[]; clipIds?: string[] } = {}): EditProject {
  return mapSeq(p, seqId, (s) => {
    const roles = o.roles?.length ? new Set(o.roles) : null;
    const ids = o.clipIds?.length ? new Set(o.clipIds) : null;
    const tracks = new Set(s.tracks.filter((t) => t.kind === "video" && t.gfxRole && (!roles || roles.has(t.gfxRole))).map((t) => t.id));
    const clips = s.clips.filter((c) => tracks.has(c.trackId) && (!ids || ids.has(c.id)));
    const kept = new Set(clips.map((c) => c.id));
    const transitions = s.transitions.filter((tr) => tracks.has(tr.trackId) && (!tr.fromClipId || kept.has(tr.fromClipId)) && (!tr.toClipId || kept.has(tr.toClipId)));
    return { ...s, clips, transitions, masterEffects: undefined };
  });
}

/** Language → ratio → graphics only, as the window's options say. */
export function prepareNewsProject(p: EditProject, seqId: string, o: NewsGpuOptions): { project: EditProject; sequenceId: string } {
  let project = o.lang ? withLanguage(p, o.lang) : p;
  let sequenceId = seqId;
  const seq = project.sequences.find((s) => s.id === seqId);
  if (o.ratio && seq && seqRatio(seq.width, seq.height) !== o.ratio) ({ project, sequenceId } = companionProject(project, seqId, o.ratio));
  if (o.only === "graphics") project = graphicsOnly(project, sequenceId, o);
  return { project, sequenceId };
}

/** "#rrggbb" → [r, g, b] in 0..1 (black when it isn't a colour). */
export function hexRgb(hex: string | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Straight RGBA from the same frame drawn over black and over white (8-bit RGBA each): over black a pixel is
 * colour·alpha, over white colour·alpha + (1 − alpha), so alpha = 1 − (white − black) and colour = black / alpha.
 * Exact for normal blending; `out` may be `black`.
 */
export function matteFromPair(black: Uint8Array, white: Uint8Array, out = new Uint8Array(black.length)): Uint8Array {
  for (let i = 0; i < black.length; i += 4) {
    const d = (white[i] - black[i] + white[i + 1] - black[i + 1] + white[i + 2] - black[i + 2]) / 3;
    const a = Math.max(0, Math.min(255, Math.round(255 - d)));
    if (a === 0) { out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0; continue; }
    const k = 255 / a;
    out[i] = Math.min(255, Math.round(black[i] * k));
    out[i + 1] = Math.min(255, Math.round(black[i + 1] * k));
    out[i + 2] = Math.min(255, Math.round(black[i + 2] * k));
    out[i + 3] = a;
  }
  return out;
}
