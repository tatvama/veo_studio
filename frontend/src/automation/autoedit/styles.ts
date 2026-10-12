/**
 * The five auto edit styles (docs/EDITOR.md §13.3): their names, one-line descriptions for the style cards, and the
 * defaults each one starts from. Pure.
 */
import type { AutoEditStyle, Format, TransitionsChoice } from "./types.ts";

export interface StyleDef {
  id: AutoEditStyle;
  name: string;
  /** one line for the card */
  blurb: string;
  /** what it does, in a few more words */
  does: string;
  format: Format;
  /** default target seconds (0 = everything that is good) */
  target: number;
  maxTarget?: number;
  transitions: TransitionsChoice;
  music: "none" | "wanted" | "needed";
  captions: boolean;
  defaultMood: string | null;
}

export const STYLES: StyleDef[] = [
  { id: "talking_head", name: "Talking head / vlog", blurb: "Cuts the pauses and bad takes, punch-ins on long takes, captions, clean voice.",
    does: "Silences and bad takes out, jump-cut punch-ins, captions, voice clean-up and loudness", format: "16:9", target: 0, transitions: "cuts",
    music: "none", captions: true, defaultMood: null },
  { id: "montage", name: "Montage / music video", blurb: "Cuts on the music's beats with the liveliest moments, ramps and a mood.",
    does: "Cuts and transitions on the beats, the liveliest parts of each clip, speed ramps, a mood", format: "16:9", target: 30, transitions: "style",
    music: "needed", captions: false, defaultMood: "action" },
  { id: "documentary", name: "Documentary", blurb: "Scene order, J/L cuts, an ambience bed and lower thirds.",
    does: "Scenes in order, long pauses trimmed, J/L cuts, ambience under it, lower thirds", format: "16:9", target: 0, transitions: "soft",
    music: "wanted", captions: false, defaultMood: "documentary" },
  { id: "highlights", name: "Highlights / Short", blurb: "A 9:16 Short of the best moments, with a hook title and captions.",
    does: "9:16, the best moments by speech, loudness and motion, a hook title, captions", format: "9:16", target: 30, maxTarget: 60,
    transitions: "cuts", music: "none", captions: true, defaultMood: null },
  { id: "slideshow", name: "Slideshow", blurb: "Photos with a slow Ken Burns move, timed to music.",
    does: "Stills with Ken Burns, on the beats when there is music, crossfades", format: "16:9", target: 0, transitions: "soft",
    music: "wanted", captions: false, defaultMood: null },
];

export const styleById = (id: AutoEditStyle): StyleDef => STYLES.find((s) => s.id === id) ?? STYLES[0];

/** The sequence size of a format (1080 on the short side). */
export function formatSize(f: Format): { width: number; height: number } {
  return f === "9:16" ? { width: 1080, height: 1920 } : f === "1:1" ? { width: 1080, height: 1080 } : { width: 1920, height: 1080 };
}
