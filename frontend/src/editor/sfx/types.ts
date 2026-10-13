/**
 * The SFX engine's types (docs/EDITOR.md §15.1). Pure types and constants: no runtime dependencies.
 */
import type { Rng, Sig, Stereo } from "./dsp.ts";

export type SfxCategory =
  | "whoosh" | "riser" | "downlifter" | "impact" | "sub_drop" | "braam" | "hit" | "pop" | "ui" | "typing"
  | "camera" | "bell" | "glitch" | "tape" | "reverse" | "tick" | "cash" | "heartbeat" | "ambience" | "crowd";

/** The tags auto SFX (§15.2) picks sounds by. Every preset's tags come from this list. */
export const SFX_TAGS = [
  "whoosh", "swish", "riser", "downlifter", "impact", "boom", "sub_drop", "hit", "pop", "click", "typing", "shutter", "ding", "glitch",
  "static", "tape_stop", "scratch", "reverse", "tick", "countdown", "braam", "cash", "heartbeat", "wind", "rain", "applause",
] as const;
export type SfxTag = (typeof SFX_TAGS)[number];

export interface SfxParam { name: string; label: string; min: number; max: number; default: number; step?: number; unit?: string }

export interface SfxPreset {
  /** "whoosh.air_soft", "impact.boom_deep" …: stable, never renamed. */
  id: string;
  name: string; category: SfxCategory;
  /** Drive auto SFX: values from SFX_TAGS. */
  tags: string[];
  /** Seconds at the default params. */
  duration: number;
  params: SfxParam[];
  /** False: a centred sound (both channels the same). */
  stereo: boolean;
  /** Additive: a seamless loop (ambiences, tick-tock, heartbeats, crackle). */
  loop?: boolean;
}

export type Values = Record<string, number>;
export interface RenderCtx {
  sr: number;
  /** Samples to render (a loop's overhang included). */
  n: number;
  rng: Rng;
  /** A loop's own length in samples (events of a "wrap" loop start inside it; their tails may run past it). */
  loopN?: number;
}

/** A preset with its recipe (internal to the engine). */
export interface SfxDef {
  id: string; name: string; category: SfxCategory; tags: SfxTag[]; params: SfxParam[]; stereo: boolean;
  /** "xfade": a continuous texture, its overhang cross-fades into the start; "wrap": events on a grid, the overhang
   *  (decaying tails) adds onto the start. */
  loop?: "xfade" | "wrap";
  /** A "wrap" loop: seconds its events may ring past the loop's end (default 1.5). */
  overhang?: number;
  /** Seconds for these values (the loop length, for a loop). */
  len(v: Values): number;
  render(v: Values, c: RenderCtx): Sig | Stereo;
}
