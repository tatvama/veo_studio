/**
 * A graphic clip → what the renderer draws (docs/EDITOR.md §16.3). Owner: nr-core. PLACEHOLDER signature. Pure: the
 * composition (model/toComposition.ts), thumbnails and the Fill in preview use it.
 */
import type { EditProject, MediaItem, Sequence, TimelineClip } from "../model/types.ts";
import type { GfxRenderInput } from "./render/contract.ts";

export interface ResolveOptions {
  urlFor?(m: MediaItem): string | undefined;
  /** A language version ("hi"): the graphic's `langs[lang]` values win. */
  lang?: string;
}
export function renderInputFor(_p: EditProject, _seq: Sequence, _clip: TimelineClip, _o: ResolveOptions = {}): GfxRenderInput | null { return null; }
