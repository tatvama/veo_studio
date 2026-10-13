/**
 * A studio episode as GET /api/episodes/3?lang=kn returns it (trimmed to what the editor import reads), its layers
 * and its project. Three shots in the cut and one left out:
 *   41  lip-sync for kn (4 s), a sound effect at 1 s, a fade-in and a title
 *   42  a 6 s video trimmed 1 s / 0.5 s at 1.5× (3 s on the cut) with a gl:cube transition of 1 s, a kn voice laid over
 *   43  no video yet: the keyframe still for 3 s, narration, a 0.5 s fade transition
 */
import type { StudioEpisode, StudioLayers } from "../../src/main/editor-episode.ts";

export const PROJECT = { id: 1, title: "Kaali", aspect: "16:9", primary_language: "kn", languages: ["kn", "en"] };

const line = [{ line: "ನಮಸ್ಕಾರ" }];

export const EPISODE: StudioEpisode = {
  id: 3, project_id: 1, number: 2, season: 1, title: "The river", settings: { music_volume_db: -18 },
  scenes: [{ id: 9, order: 1, title: "Dawn" }, { id: 10, order: 2, title: "Night" }],
  shots: [
    { id: 44, order: 4, code: "E02-SH04", scene_id: 10, include: false, duration_s: 4, video: { id: 244, kind: "video", path: "projects/1/shots/44/video/v44.mp4", duration_s: 4 } },
    {
      id: 41, order: 1, code: "E02-SH01", scene_id: 9, include: true, duration_s: 4, trim_in: 0, trim_out: 0,
      fx: { fade_in: 0.5, look: "teal_orange" }, dialogue: { kn: line }, effective_voice_mode: "lipsync",
      video: { id: 241, kind: "video", path: "projects/1/shots/41/video/v41.mp4", duration_s: 4 },
      lipsync: { id: 141, kind: "lipsync", path: "projects/1/shots/41/lipsync/l41.mp4", duration_s: 4 },
      sfx_track: { path: "projects/1/sfx/s41.wav", start: 1, volume_db: -8 },
      overlays: [{ text: "The river", start: 0.5, end: 2.5, kind: "title" }],
    },
    {
      id: 42, order: 2, code: "E02-SH02", scene_id: 9, include: true, duration_s: 6, trim_in: 1, trim_out: 0.5,
      fx: { speed: 1.5, transition: { type: "gl:cube", duration: 1, easing: "ease_in_out" } }, dialogue: { kn: line }, effective_voice_mode: "tts",
      video: { id: 242, kind: "video", path: "projects/1/shots/42/video/v42.mp4", duration_s: 6 },
      voice: { id: 342, kind: "voice", path: "projects/1/shots/42/voice/kn42.wav", duration_s: 2.5 },
    },
    {
      id: 43, order: 3, code: "E02-SH03", scene_id: 10, include: true, duration_s: 3,
      fx: { transition: { type: "fade", duration: 0.5 } },
      keyframe: { id: 443, kind: "keyframe", path: "projects/1/shots/43/keyframe/k43.png" },
      narration_take: { id: 543, kind: "narration", path: "projects/1/shots/43/narration/n43.wav", duration_s: 2 },
    },
  ],
  music: [{ id: 5, path: "projects/1/music/m5.mp3", selected: false, duration_s: 4 }, { id: 6, path: "projects/1/music/m6.mp3", selected: true, duration_s: 4 }],
};

export const LAYERS: StudioLayers = {
  rev: 4,
  video: [{ id: "lv1", name: "Logo", clips: [{ id: "c1", src: "projects/1/layers/logo.png", kind: "image", name: "logo.png", start: 1, in: 0, dur: 3,
    x: 0.8, y: 0.2, scale: 0.2, opacity: 0.8, fade_in: 0.5, fade_out: 0, gain_db: 0, keyframes: [{ t: 0, scale: 0.2 }, { t: 2, scale: 0.3 }] }] }],
  audio: [{ id: "la1", name: "Ambience", gain_db: -3, clips: [{ id: "c2", src: "projects/1/layers/amb.wav", kind: "audio", name: "amb.wav", start: 0, in: 1, dur: 5,
    gain_db: -2, fade_in: 1, fade_out: 1 }] }],
};
