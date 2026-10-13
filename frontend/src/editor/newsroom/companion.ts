/**
 * Both-ratio edits (docs/EDITOR.md §16.7). Owner: nr-core. PLACEHOLDER signature. Pure.
 * The other ratio of a news sequence, made on the fly: the same clips; graphics use that ratio's design; slot clips
 * follow that ratio's layout boxes; other pictures are reframed to fill (formats.ts reframeSequence, faces if known);
 * graphics whose `ratios` leave it out are dropped. Never saved: the monitor and the export build it each time.
 */
import type { EditProject } from "../model/types.ts";
import type { GfxRatio } from "./types.ts";

export function companionProject(p: EditProject, seqId: string, _ratio: GfxRatio): { project: EditProject; sequenceId: string } {
  return { project: p, sequenceId: seqId };
}
