/**
 * What the core renderer adds to a kind's LayerRenderContext (docs/EDITOR.md §16.3) for the core's own kinds
 * (render/kinds/basic.ts): the layer's box as drawn this frame, and the step a text layer animates part by part. Other
 * kinds may read these too (optional). Pure types and one guard.
 */
import type { AnimStep, Box } from "../types.ts";
import type { LayerRenderContext } from "./contract.ts";

export interface PartAnim { step: AnimStep; /** seconds into the step */ local: number; dur: number; leaving: boolean }

export interface CoreRenderContext extends LayerRenderContext {
  /** The layer's box this frame (design px): after plate growth (p.grow) and grow / unfold animations. */
  box: Box;
  /** Text kinds: the in / out step to apply per line / word / letter (the core leaves the layer still). */
  parts?: { in?: PartAnim; out?: PartAnim };
  /** The canvas transform's scale (design px → canvas px) for hairlines. */
  pixel: number;
}

export const isCore = (rc: LayerRenderContext): rc is CoreRenderContext => Array.isArray((rc as CoreRenderContext).box);
