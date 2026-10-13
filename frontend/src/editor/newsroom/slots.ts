/**
 * Screen layouts' video boxes (docs/EDITOR.md §16.6). Owner: nr-layouts. PLACEHOLDER signatures. Pure.
 * A clip with `slot` is placed in box `slot.index` of the layout graphic on screen at that frame (the highest graphic
 * clip whose template has "slot" layers), in the frame's ratio. When the layout changes, boxes glide from the old to
 * the new place during the new layout's in phase (layout morph).
 */
import type { EditProject, Param, Sequence, TimelineClip } from "../model/types.ts";
import type { Box } from "./types.ts";

export interface SlotPlacement {
  position: Param<[number, number]>;
  scale: Param<number>;
  /** Crop effect params, % of the picture. */
  crop: { left: Param<number>; right: Param<number>; top: Param<number>; bottom: Param<number> };
}

/** Slot boxes as frame fractions [x, y, w, h] at a sequence frame for a W×H frame (`hole`: the layout is see-through there). */
export function slotsAt(_p: EditProject, _seq: Sequence, _frame: number, _W: number, _H: number): { index: number; box: Box; hole: boolean }[] { return []; }
/**
 * Motion and crop for a slot clip in a W×H frame (keyframed over the clip where layouts change or morph), for a
 * picture of pic.w × pic.h. null = no layout on screen during the clip (it keeps its own motion).
 */
export function slotMotion(_p: EditProject, _seq: Sequence, _clip: TimelineClip, _W: number, _H: number, _pic: { w: number; h: number }): SlotPlacement | null { return null; }
