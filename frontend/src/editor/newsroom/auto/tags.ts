/**
 * News Room automation (docs/EDITOR.md §16.10): graphics placed by the automatic tools carry a tag in their values
 * (`values._auto = "speaker" | "ai-label"`), so running a tool again replaces its own graphics and never touches the
 * ones placed by hand. Template fields never use the "_auto" id, so the tag is not shown or drawn. Pure.
 */
import type { EditProject, Sequence, TimelineClip } from "../../model/types.ts";
import { builtinTemplates } from "../templates/index.ts";
import type { GfxInstance, GfxTemplate } from "../types.ts";

export const AUTO_KEY = "_auto";
export type AutoTag = "speaker" | "ai-label";
export type GraphicClip = TimelineClip & { source: { type: "graphic"; gfx: GfxInstance } };

export const isGraphicClip = (c: TimelineClip): c is GraphicClip => c.source.type === "graphic";
/** The automatic tool that placed a graphic, if any. */
export const autoTagOf = (c: TimelineClip): AutoTag | undefined =>
  isGraphicClip(c) ? (c.source.gfx.values[AUTO_KEY] as AutoTag | undefined) ?? undefined : undefined;
/** Graphic clips of a sequence placed by a tool. */
export const autoClips = (seq: Sequence, tag: AutoTag): GraphicClip[] => seq.clips.filter((c): c is GraphicClip => isGraphicClip(c) && autoTagOf(c) === tag);

/** Templates to choose from: the edit's copies first, then the built-ins. */
export function templatePool(p: EditProject): GfxTemplate[] {
  const own = Object.values(p.newsroom?.templates ?? {});
  const ids = new Set(own.map((t) => t.id));
  return [...own, ...builtinTemplates().filter((t) => !ids.has(t.id))];
}

/** The AI-content label strap (the built-in "AI-generated label", else any strap that says it is one). */
export function aiLabelTemplate(p: EditProject): GfxTemplate | undefined {
  const pool = templatePool(p);
  const words = (t: GfxTemplate) => [t.id, t.kind ?? "", t.name, ...(t.tags ?? [])].join(" ").toLowerCase();
  return pool.find((t) => ["nr.straps.ai_label", "nr.straps.ai_generated", "nr.straps.ai"].includes(t.id))
    ?? pool.find((t) => t.kind === "ai_label" || t.kind === "ai")
    ?? pool.find((t) => (t.role === "strap" || t.role === "bug") && /\bai[-_ ]?(generated|label|made|content)\b|ai-generated/.test(words(t)));
}

/** True when a clip is an AI-content label (placed by the tool or by hand). */
export function isAiLabelClip(p: EditProject, c: TimelineClip): boolean {
  if (!isGraphicClip(c)) return false;
  if (autoTagOf(c) === "ai-label") return true;
  const t = aiLabelTemplate(p);
  return !!t && c.source.gfx.template === t.id;
}
