/**
 * The auto edit styles as the `list_auto_edit_styles` tool tells a model about them (the planner itself is in
 * frontend/src/automation/autoedit; docs/EDITOR.md §13.3). Pure data.
 */
import type { AutoEditStyle } from "../../shared/types.ts";

export const STYLE_INFO: { id: AutoEditStyle; name: string; does: string; defaults: string; bestFor: string }[] = [
  { id: "talking_head", name: "Talking head / vlog", bestFor: "someone speaking to camera, interviews, tutorials",
    does: "Cuts the silences and the bad takes (black, frozen, blurred, too short, clipped sound), adds jump-cut punch-ins on long takes, captions (local Whisper when it's installed), voice clean-up and loudness.",
    defaults: "target length = all the good speech; 16:9; no music; light cuts" },
  { id: "montage", name: "Montage / music video", bestFor: "b-roll, travel, events, product shots with a music track",
    does: "Cuts on the beats of the chosen music (a file, the library, or AI music after approval), picks the liveliest parts of each clip, adds speed ramps on some cuts, transitions on the beats and a mood.",
    defaults: "target length = the music's length (or 30 s); 16:9; a cut every 2 beats" },
  { id: "documentary", name: "Documentary", bestFor: "interviews with b-roll, field footage, a story in scene order",
    does: "Keeps scene order, trims each scene's silences, makes J/L cuts (the sound leads or trails the picture), lays an ambience bed under it and lower thirds with each clip's name.",
    defaults: "target length = every good scene; 16:9; dissolves between scenes" },
  { id: "highlights", name: "Highlights / Short", bestFor: "a long recording to turn into a vertical Short or Reel",
    does: "9:16, picks the best moments by speech, loudness and motion, opens with a hook title, adds captions, keeps it under the target length.",
    defaults: "target length 30 s (max 60); 9:16; punchy cuts" },
  { id: "slideshow", name: "Slideshow", bestFor: "photos (and short clips) to music",
    does: "Stills with a Ken Burns move (slow zoom and pan), timed to the music's beats when there is music, soft crossfades.",
    defaults: "4 s per photo (or the beats); 16:9; crossfades" },
];
