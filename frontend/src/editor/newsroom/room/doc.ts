/**
 * The News Room room (docs/EDITOR.md §16.8): small immutable updates of the edit's News Room document (stories,
 * people, places, the playlist) and of one graphic clip. Immutable so a field being typed into can preview each key
 * from the same base (one undo step per field focus, room/live.ts). Pure.
 */
import { clearRange, ctxOf } from "../../model/ops.ts";
import type { EditProject, Sequence, TimelineClip } from "../../model/types.ts";
import type { GfxInstance, NewsroomDoc, Person, Place, RundownStory } from "../types.ts";

/** The project with its News Room document changed (unchanged when the edit has none). */
export function withNewsroom(p: EditProject, fn: (nr: NewsroomDoc) => NewsroomDoc): EditProject {
  if (!p.newsroom) return p;
  const nr = fn(p.newsroom);
  return nr === p.newsroom ? p : { ...p, newsroom: nr };
}

const patchIn = <T extends { id: string }>(list: T[], id: string, patch: Partial<T>): T[] => list.map((x) => (x.id === id ? { ...x, ...patch } : x));

export const updateStory = (p: EditProject, id: string, patch: Partial<RundownStory>) =>
  withNewsroom(p, (nr) => ({ ...nr, rundown: patchIn(nr.rundown, id, patch) }));
export const updatePerson = (p: EditProject, id: string, patch: Partial<Person>) =>
  withNewsroom(p, (nr) => ({ ...nr, people: patchIn(nr.people ?? [], id, patch) }));
export const updatePlace = (p: EditProject, id: string, patch: Partial<Place>) =>
  withNewsroom(p, (nr) => ({ ...nr, places: patchIn(nr.places ?? [], id, patch) }));

/** Moves an item of a list from one place to another. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x);
  return out;
}

/** A graphic clip changed (any sequence). */
export function updateGraphic(p: EditProject, clipId: string, fn: (g: GfxInstance, c: TimelineClip) => GfxInstance | null, rename?: (c: TimelineClip, g: GfxInstance) => string | undefined): EditProject {
  let hit = false;
  const sequences = p.sequences.map((s) => {
    if (!s.clips.some((c) => c.id === clipId)) return s;
    return { ...s, clips: s.clips.map((c) => {
      if (c.id !== clipId || c.source.type !== "graphic") return c;
      const g = fn(c.source.gfx, c);
      if (!g || g === c.source.gfx) return c;
      hit = true;
      const name = rename?.(c, g);
      return { ...c, ...(name ? { name } : {}), source: { type: "graphic" as const, gfx: g } };
    }) };
  });
  return hit ? { ...p, sequences } : p;
}

/** A clip by id in any sequence (with its sequence). */
export function findClip(p: EditProject, clipId: string) {
  for (const s of p.sequences) { const c = s.clips.find((x) => x.id === clipId); if (c) return { seq: s, clip: c }; }
  return null;
}

/** "2026-10-14T19:42:00" — now (or a date) rounded to the minute, local time, as the clocks' air time. */
export function airTimeOf(d = new Date()): string {
  const x = new Date(d.getTime() + 30_000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${two(x.getMonth() + 1)}-${two(x.getDate())}T${two(x.getHours())}:${two(x.getMinutes())}:00`;
}

/** Frames from a graphic's start to the next graphic on its track (null when it's the last). */
export function untilNext(s: Sequence, clipId: string): number | null {
  const c = s.clips.find((x) => x.id === clipId);
  if (!c) return null;
  const next = s.clips.filter((x) => x.trackId === c.trackId && x.start > c.start).sort((a, b) => a.start - b.start)[0];
  return next ? next.start - c.start : null;
}

/** Sets a clip's length on a draft, overwriting what it now covers on its track (at least one frame). */
export function setClipLength(p: EditProject, clipId: string, frames: number): boolean {
  const i = p.sequences.findIndex((s) => s.clips.some((c) => c.id === clipId));
  if (i < 0) return false;
  let s = p.sequences[i];
  const c = s.clips.find((x) => x.id === clipId)!;
  const len = Math.max(1, Math.round(frames));
  if (len === c.duration) return false;
  if (len > c.duration) s = clearRange(s, ctxOf(p), c.trackId, c.start + c.duration, c.start + len, { except: new Set([c.id]) });
  p.sequences[i] = { ...s, clips: s.clips.map((x) => (x.id === clipId ? { ...x, duration: len } : x)) };
  return true;
}
