/**
 * The graphics playlist (docs/EDITOR.md §16.8): up to twelve ready graphics on F1–F12, like a channel's graphics
 * operator. The list order is the keys: the first entry is F1. Pure: these return a new list.
 */
import type { GfxValue, NewsroomDoc } from "../types.ts";

export type PlaylistEntry = NonNullable<NewsroomDoc["playlist"]>[number];
export const PLAYLIST_KEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);
export const PLAYLIST_MAX = PLAYLIST_KEYS.length;

/** Keys given again in list order (F1, F2 …), extra entries dropped. */
export const rekey = (list: PlaylistEntry[]): PlaylistEntry[] => list.slice(0, PLAYLIST_MAX).map((e, i) => (e.key === PLAYLIST_KEYS[i] ? e : { ...e, key: PLAYLIST_KEYS[i] }));

/** Adds an entry on the next free key; null when all twelve are taken. */
export function addEntry(list: PlaylistEntry[] | undefined, e: { template: string; values: Record<string, GfxValue>; name?: string }): PlaylistEntry[] | null {
  const l = list ?? [];
  if (l.length >= PLAYLIST_MAX) return null;
  return rekey([...l, { key: "", template: e.template, values: structuredClone(e.values), ...(e.name ? { name: e.name } : {}) }]);
}
export const removeEntry = (list: PlaylistEntry[], i: number) => rekey(list.filter((_, j) => j !== i));
export function moveEntry(list: PlaylistEntry[], from: number, to: number): PlaylistEntry[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x);
  return rekey(out);
}
export const renameEntry = (list: PlaylistEntry[], i: number, name: string) => list.map((e, j) => (j === i ? { ...e, name } : e));
/** The entry on a key ("F3"). */
export const entryOn = (list: PlaylistEntry[] | undefined, key: string) => (list ?? []).find((e) => e.key === key);
