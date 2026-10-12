/** Shared test fixtures: a 25 fps project with two video files (with sound), one music file and one still. */
import { newProject } from "../model/defaults.ts";
import { seedIds } from "../model/ids.ts";
import { ctxOf, clipsFromMedia, placeClips, tracksOf } from "../model/ops.ts";
import type { EditProject, MediaItem, Sequence, TimelineClip } from "../model/types.ts";

export function media(id: string, over: Partial<MediaItem> = {}): MediaItem {
  return { id, binId: null, name: id, kind: "video", path: `C:/m/${id}.mp4`, url: `/__media/${id}`, duration: 250, fps: 25, width: 1920, height: 1080,
    hasAudio: true, markers: [], ...over };
}

export function project(): EditProject {
  seedIds(7);
  const p = newProject("Test", { width: 1920, height: 1080, fps: 25 });
  p.media = [media("m1"), media("m2"), media("music", { kind: "audio", hasAudio: true, width: 0, height: 0, duration: 1500 }), media("still", { kind: "image", hasAudio: false, duration: 0, width: 1000, height: 1000 })];
  return p;
}

export const seqOf = (p: EditProject) => p.sequences[0];
export const V = (s: Sequence, i: number) => tracksOf(s, "video")[i];
export const A = (s: Sequence, i: number) => tracksOf(s, "audio")[i];

/** Puts m at `at` on V1/A1 (or the given tracks) with source in/out, overwrite. */
export function put(p: EditProject, s: Sequence, mediaId: string, at: number, range?: { in?: number; out?: number }, vi = 0, ai = 0, audio = true): Sequence {
  const m = p.media.find((x) => x.id === mediaId)!;
  const cs = clipsFromMedia(s, m, at, { videoTrackId: V(s, vi).id, audioTrackId: audio ? A(s, ai).id : undefined, range });
  return placeClips(s, ctxOf(p), cs, "overwrite");
}

export const on = (s: Sequence, trackId: string): TimelineClip[] => s.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
export const spans = (s: Sequence, trackId: string) => on(s, trackId).map((c) => [c.start, c.start + c.duration]);
