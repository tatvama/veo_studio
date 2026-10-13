/**
 * React hooks for the News Room panels (docs/EDITOR.md §16.8), on the editor store: the edit's News Room document,
 * one graphic clip, the edit's look, and "the graphic you're working on" (the selected graphic clip, else the topmost
 * graphic under the playhead, re-rendering only when that changes, not on every frame).
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { activeSequence } from "../model/ops";
import type { Sequence } from "../model/types";
import { program } from "../playback/transport";
import { useEditor, useProject, useSequence } from "../store";
import { graphicsAt, isGraphic, templateOf, type GraphicClip } from "./commands";
import { resolveLook } from "./looks";
import type { ChannelLook, GfxTemplate, NewsroomDoc } from "./types";

/** The edit's News Room document, or null before the first graphic / news edit. */
export const useNewsroom = (): NewsroomDoc | null => useEditor((s) => s.h.present.newsroom ?? null);

/** A graphic clip of the active sequence by id (null when it isn't one). */
export function useGraphicClip(clipId: string | null | undefined): GraphicClip | null {
  return useEditor((s) => {
    if (!clipId) return null;
    const c = activeSequence(s.h.present)?.clips.find((x) => x.id === clipId);
    return c && isGraphic(c) ? c : null;
  });
}

/** The look a graphic draws in: its own (`lookId`), else the edit's, else the default. */
export function useLook(lookId?: string): ChannelLook {
  const p = useProject();
  const nr = p.newsroom;
  return useMemo(() => resolveLook(p, lookId), [nr?.look, nr?.looks, lookId]);  // eslint-disable-line react-hooks/exhaustive-deps
}

/** The template of a graphic clip (the edit's copy, else the built-in). */
export function useTemplateOf(clip: GraphicClip | null): GfxTemplate | null {
  const p = useProject();
  const nr = p.newsroom;
  return useMemo(() => (clip ? templateOf(p, clip) ?? null : null), [clip?.source.gfx.template, nr?.templates]);  // eslint-disable-line react-hooks/exhaustive-deps
}

/** The topmost graphic clip at a frame (bug and wipe tracks are skipped unless nothing else is there). */
export function topGraphicAt(seq: Sequence, frame: number): GraphicClip | null {
  const list = graphicsAt(seq, frame);
  const roles = new Map(seq.tracks.map((t) => [t.id, t.gfxRole]));
  const main = list.filter((c) => { const r = roles.get(c.trackId); return r !== "bug" && r !== "wipe" && r !== "background"; });
  return (main.length ? main : list)[(main.length ? main : list).length - 1] ?? null;
}

/** The selected graphic clip, else the topmost graphic under the playhead. */
export function useSelectedGraphic(): GraphicClip | null {
  const seq = useSequence();
  const selection = useEditor((s) => s.selection);
  const picked = useMemo(() => {
    for (const id of selection) { const c = seq?.clips.find((x) => x.id === id); if (c && isGraphic(c)) return c; }
    return null;
  }, [selection, seq]);
  const underId = useCallback(() => (seq ? topGraphicAt(seq, program.frame)?.id ?? "" : ""), [seq]);
  const id = useSyncExternalStore(program.subscribe, underId, underId);
  return useMemo(() => {
    if (picked) return picked;
    const c = id ? seq?.clips.find((x) => x.id === id) : undefined;
    return c && isGraphic(c) ? c : null;
  }, [picked, id, seq]);
}
