/**
 * News Room edits on a draft project (docs/EDITOR.md §16.5). Owner: nr-core. PLACEHOLDER signatures. Pure: UI code calls
 * them inside one undo step, `host.apply("Add name strap", (d) => addGraphic(d, …))`.
 */
import type { EditProject, Sequence, TimelineClip } from "../model/types.ts";
import type { GfxInstance, GfxRole, GfxTemplate, GfxValue, NewsroomDoc } from "./types.ts";

export type GraphicClip = TimelineClip & { source: { type: "graphic"; gfx: GfxInstance } };

/** The edit's News Room document, created with defaults when missing. */
export function ensureNewsroom(_p: EditProject): NewsroomDoc { throw new Error("nr-core: not built yet"); }
/** The graphics track for a role (created above the video tracks in role order when missing); returns its id. */
export function ensureGfxTrack(_p: EditProject, _seqId: string, _role: GfxRole): string { throw new Error("nr-core: not built yet"); }
/** Copies a template (built-in or the library's) into the edit, so it opens and exports the same anywhere. */
export function useTemplate(_p: EditProject, _t: GfxTemplate): void {}
/** The template of a graphic clip or id in this edit (its copy first, then the built-ins). */
export function templateOf(_p: EditProject, _idOrClip: string | TimelineClip): GfxTemplate | undefined { return undefined; }
export interface AddGraphicOptions {
  /** Sequence frame. */ at: number;
  /** Frames; default from the template's hold (auto / fill / until-next / its seconds). */ duration?: number;
  values?: Record<string, GfxValue>; trackId?: string; look?: string;
  /** Default: the active sequence. */ seqId?: string;
}
/** Adds a graphic clip (on its role's track, overwriting what's there in that range); returns the clip id. */
export function addGraphic(_p: EditProject, _template: GfxTemplate | string, _o: AddGraphicOptions): string { throw new Error("nr-core: not built yet"); }
export function setGraphicValues(_p: EditProject, _clipId: string, _values: Record<string, GfxValue>): void {}
/** Swaps a graphic's template, keeping the values whose field ids match. */
export function replaceGraphicTemplate(_p: EditProject, _clipId: string, _templateId: string): void {}
/** Makes a look the edit's look (copied in); every graphic without its own look follows. */
export function applyLook(_p: EditProject, _lookId: string): void {}
/** Seconds a graphic should hold to be read (its fields' words at `readSpeed` words/s, 4..12 s), or the template's length. */
export function autoHold(_t: GfxTemplate, _values: Record<string, GfxValue>, _readSpeed = 3): number { return 6; }
/** Graphic clips of a sequence (optionally of one role), by start. */
export function graphicClips(_seq: Sequence, _role?: GfxRole): GraphicClip[] { return []; }
