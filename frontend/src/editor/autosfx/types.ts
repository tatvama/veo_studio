/**
 * Auto SFX's data (docs/EDITOR.md §15.2): the rules, the options the planner takes and the plan it gives. Pure types.
 */

/** Each rule maps one kind of edit event to sounds; each can be switched off. */
export type SfxRule =
  | "transitions" | "stingers" | "titles" | "stickers" | "countdowns" | "punch_ins"
  | "speed_ramps" | "freeze_frames" | "shake" | "glitch" | "beats";

export type SfxIntensity = "subtle" | "normal" | "punchy";

/** Frames of the sequence, [from, to). */
export interface FrameRange { from: number; to: number }

export interface AutoSfxOptions {
  /** Default "normal". */
  intensity?: SfxIntensity;
  /** Rules switched on or off; unset = the default (every rule on except beats). */
  rules?: Partial<Record<SfxRule, boolean>>;
  /** "all" (default), "inout" (the sequence's in/out marks, else all) or a frame range. */
  range?: "all" | "inout" | FrameRange;
  /** Where speech plays (sequence frames): from the silence analysis of the dialogue clips. Unset: the dialogue
   *  clips' extents. */
  speech?: FrameRange[];
  /** The SFX library to choose from (default the built-in SFX_PRESETS). */
  catalog?: CatalogPreset[];
}

/** What the planner needs of an SFX preset (editor/sfx SfxPreset). */
export interface CatalogPreset {
  id: string; name: string; category?: string; tags: string[]; duration: number;
  params: { name: string; min: number; max: number; default: number }[];
  /** A seamless loop (ambiences, tick-tock): never a one-shot's pick when there is a one-shot. */
  loop?: boolean;
}

/** One sound to place. Times are sequence frames. */
export interface SfxPlacement {
  /** The event part this sound is for: stable across runs ("<rule>:<source id>:<part>"). */
  id: string;
  rule: SfxRule;
  /** The clip, transition or marker that made it. */
  sourceId: string;
  /** Where the sound's clip starts (may be before 0: the head is trimmed). */
  at: number;
  /** The moment it is for (the cut, the title's entrance, the beat …): what the preview shows. */
  hit: number;
  /** Clip length in frames (planned from the preset; the rendered file's length wins when it is placed). */
  duration: number;
  /** How the sound lines up with `hit` (kept when the rendered length differs from the plan). */
  align: "start" | "centre" | "end";
  /** Cut at `duration` (typing bursts, ticks); otherwise the whole sound plays. */
  trim: boolean;
  presetId: string;
  /** The preset's parameters (only the ones that differ from its defaults matter, but all set ones are kept). */
  values: Record<string, number>;
  /** The render seed (from the sequence id plus the event id). */
  seed: number;
  /** Clip gain in dB (the intensity's level, the rule's offset, minus 6 dB under speech). */
  gainDb: number;
  /** Frames. */
  fadeIn: number; fadeOut: number;
  /** True when the gain was lowered for speech. */
  ducked: boolean;
  /** The sound, for people ("Whoosh · Air soft"). */
  label: string;
  /** Why it's there ("Transition gl:cube at the cut"). */
  reason: string;
}

export interface SfxSkipped { id: string; rule: SfxRule; sourceId: string; hit: number; reason: string }

export interface AutoSfxPlan {
  sequenceId: string;
  fps: number;
  intensity: SfxIntensity;
  range: FrameRange;
  rules: Record<SfxRule, boolean>;
  placements: SfxPlacement[];
  skipped: SfxSkipped[];
  /** Sounds per rule that this plan places. */
  counts: Record<SfxRule, number>;
  /** Events per rule found in the edit (a rule switched off still counts what it would place). */
  found: Record<SfxRule, number>;
  /** Earlier auto SFX clips in the range that this plan replaces. */
  replaces: number;
}
