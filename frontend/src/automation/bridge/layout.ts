/** Layout rules for the assistant's titles and captions (pure; tested in editor/__tests__/automation-layout.test.ts). */
import { captionStyle } from "../../editor/ai/commands.ts";
import { clipEnd } from "../../editor/model/ops.ts";
import type { Sequence } from "../../editor/model/types.ts";
/** Caption clips the assistant made: titles in the caption style's box (editor/ai/commands.ts captionStyle). */
export function captionClipIds(s: Sequence): Set<string> {
  const band = captionStyle(s).box!;
  return new Set(s.clips.filter((c) => c.source.type === "title" && c.source.text.box.every((v, i) => Math.abs(v - band[i]) < 1e-6)).map((c) => c.id));
}

/**
 * Lower thirds and bottom titles move up out of the caption band while captions show under them, so an assistant's
 * captions never cover its own lower third. Titles higher up, and the captions themselves, stay where they are.
 */
export function clearCaptionBand(s: Sequence, captions: Set<string>): Sequence {
  const caps = s.clips.filter((c) => captions.has(c.id));
  if (!caps.length) return s;
  const top = captionStyle(s).box![1] - 0.02;
  let changed = false;
  const clips = s.clips.map((c) => {
    if (captions.has(c.id) || c.source.type !== "title") return c;
    const b = c.source.text.box;
    const bottom = b[1] + b[3];
    if (bottom <= top || b[1] < 0.5 || !caps.some((k) => k.start < clipEnd(c) && c.start < clipEnd(k))) return c;
    changed = true;
    const box: [number, number, number, number] = [b[0], Math.max(0.05, b[1] - (bottom - top)), b[2], b[3]];
    return { ...c, source: { ...c.source, text: { ...c.source.text, box } } };
  });
  return changed ? { ...s, clips } : s;
}
