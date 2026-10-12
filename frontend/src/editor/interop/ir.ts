/**
 * What the importers read a foreign timeline into, before it becomes an edit (build.ts). Timeline positions are
 * frames at the IR sequence's fps; source positions are SECONDS of the media (or frames of a nested sequence), so the
 * builder can put them in each media item's own units. Pure types.
 */
import type { EffectInstance, Marker, Param, TimelineClip, Track, Transition } from "../model/types.ts";

export interface IrMedia {
  /** The format's own reference for the file (FCP file id, path, OTIO url …). */
  key: string;
  name: string;
  /** Absolute local path ("" when the file named nothing usable). */
  path: string;
  kind: "video" | "audio" | "image";
  /** Length of the whole file in seconds, when the format says. */
  seconds?: number;
  fps?: number; width?: number; height?: number; hasAudio?: boolean; channels?: number; sampleRate?: number;
  /** Media (clip) markers: `frame` and `duration` in SECONDS here. */
  markers?: IrMarker[];
}

export interface IrMarker { at: number; duration: number; name: string; color?: string; comment?: string; kind?: Marker["kind"] }

export interface IrClip {
  /** The format's id for the clip (transitions and links point at it). */
  ref: string;
  kind: "video" | "audio";
  /** 0-based track within its kind. */
  track: number;
  start: number; duration: number;
  name: string;
  enabled?: boolean; speed?: number; reverse?: boolean;
  /** Clips with the same link key are linked (A/V halves). */
  link?: string;
  media?: { key: string; in: number };
  nested?: { key: string; in: number };
  /** Titles, colour mattes, adjustment layers, generators: an editor source as it is. */
  source?: TimelineClip["source"];
  gain?: Param<number>; pan?: Param<number>; opacity?: Param<number>;
  blend?: TimelineClip["motion"]["blend"];
  effects?: EffectInstance[];
  /** Extra clip fields restored from Tatvam data (motion, timeRemap, colorLabel, role …). */
  extra?: Partial<TimelineClip>;
  /** Effects the format had that the editor doesn't: they become markers on the clip's media. */
  notes?: { name: string; comment?: string }[];
}

export interface IrTransition {
  kind: "video" | "audio"; track: number;
  at: number; duration: number; alignment: Transition["alignment"];
  type: string; params?: Record<string, unknown>; easing?: Transition["easing"];
  from?: string; to?: string;
}

export interface IrTrack { kind: "video" | "audio"; index: number; name?: string; enabled?: boolean; locked?: boolean; extra?: Partial<Track> }

export interface IrSequence {
  key: string; name: string; fps: number; width: number; height: number;
  tracks: IrTrack[]; clips: IrClip[]; transitions: IrTransition[];
  /** Sequence markers: frames. */
  markers: IrMarker[];
  masterEffects?: EffectInstance[];
}

export interface IrDoc {
  name?: string;
  sequences: IrSequence[];
  /** The sequence to open. */
  main: string;
  media: IrMedia[];
  warnings: string[];
}
