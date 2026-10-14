/**
 * Auto edit's data (docs/EDITOR.md §13.3): what the planner takes (media, their analysis, the options) and the plan it
 * gives (segments in seconds, transitions, titles, captions, music, mood, a summary). Pure types.
 */
import type { AutoEditStyle, MediaAnalysis } from "../../lib/desktop.ts";

export type { AutoEditStyle, MediaAnalysis };

export type Format = "16:9" | "9:16" | "1:1";
export type TransitionsChoice = "none" | "cuts" | "soft" | "style";
export type OrderChoice = "name" | "date" | "timecode" | "content";

export interface AutoEditOptions {
  style: AutoEditStyle;
  /** seconds; default per style */
  targetSeconds?: number;
  format?: Format;
  /** a media id of the music, "ai" (proposed after), or "none" */
  music?: string;
  /** a language code for captions (local Whisper transcripts), or "none" */
  captions?: string;
  /** a mood id (lib/moods.ts), or "none" */
  mood?: string;
  transitions?: TransitionsChoice;
  order?: OrderChoice;
  /** the hook / opening title */
  title?: string;
  /** the folder's name, for the sequence name */
  folder?: string;
  /** frame rate of the new sequence (default the edit's active one, else 25) */
  fps?: number;
  /** Additive (auto-sfx, docs/EDITOR.md §15.2): "Add sound effects" at this intensity once the sequence is built
   *  (editor/autosfx), or "none" (the default) */
  sfx?: "none" | "subtle" | "normal" | "punchy";
}

/** A media item as the planner sees it (seconds). */
export interface PlanMedia {
  id: string; name: string; kind: "video" | "audio" | "image"; duration: number; hasAudio: boolean; width: number; height: number;
  path?: string;
}

export interface Range { start: number; end: number }

export interface PlanSegment {
  mediaId: string;
  /** media seconds [in, out) */
  in: number; out: number;
  /** timeline seconds */
  at: number;
  /** timeline seconds (= (out - in) / speed) */
  duration: number;
  speed: number;
  /** keep the clip's own sound */
  sound: boolean;
  /** jump-cut punch-in: scale in % of fitted (100 = none) */
  scale?: number;
  /** fill the frame (a 16:9 picture in a 9:16 sequence: centre crop) */
  cover?: boolean;
  /** Ken Burns: scale and position (fractions of the frame from centre) at the start and the end */
  kenBurns?: { from: { scale: number; x: number; y: number }; to: { scale: number; x: number; y: number } };
  /** a speed ramp preset on this shot (montage) */
  ramp?: "slowmo_burst" | "ramp_down" | "ramp_up";
  /** J cut (the sound starts this many seconds before the picture) or L cut (the sound runs on after it) */
  soundLead?: number; soundTail?: number;
  /** why it's there (shown in the preview) */
  note?: string;
}

export interface PlanTransition { at: number; type: string; duration: number; track: "video" | "audio" }
export interface PlanTitle { text: string; at: number; duration: number; position: "top" | "center" | "lower_third" | "bottom"; kind: "hook" | "lower_third" }
export interface PlanCue { start: number; end: number; text: string }
export interface PlanAudioBed { mediaId: string; in: number; duration: number; at: number; gainDb: number; fadeIn: number; fadeOut: number; role: "music" | "ambience" }

export interface PlanSummary {
  clipsIn: number;
  clipsUsed: number;
  cuts: number;
  /** seconds of silence taken out */
  silenceRemoved: number;
  /** takes left out, and why */
  dropped: { mediaId: string; name: string; reason: string }[];
  /** seconds of bad parts cut out of kept takes (black, frozen, blurred, clipped sound) */
  badRemoved: number;
  /** the sequence's length, and of the material that went in */
  length: number;
  sourceLength: number;
  notes: string[];
}

export interface Plan {
  style: AutoEditStyle;
  /** "Auto edit · <folder> · <style>" */
  name: string;
  width: number; height: number; fps: number;
  segments: PlanSegment[];
  transitions: PlanTransition[];
  titles: PlanTitle[];
  captions: PlanCue[];
  beds: PlanAudioBed[];
  mood: string | null;
  markers: { at: number; name: string }[];
  /** audio effects on the clips' own sound (talking head: voice clean-up and level) */
  voiceFx: string[];
  /** set on the dialogue track (ducking: music under speech) */
  dialogue: boolean;
  /** what happens after (and isn't free): AI music to approve … */
  proposals: string[];
  summary: PlanSummary;
  /** Additive (auto-sfx): add sound effects at this intensity after building (editor/autosfx); unset = none */
  sfx?: "subtle" | "normal" | "punchy";
}
