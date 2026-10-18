import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import type { Board, BoardScene, Estimate, Scene } from "../../../lib/types";
import type { CanvasInfo } from "./model";

/** A scene as the episode payload sends it (every column; the shared type lists only the common ones). */
export type SceneX = Scene & { emotion?: string; look?: string; sound?: string; music?: string };

/**
 * Step states, failures and scene music for the canvas. Keyed under "episode" so every live event that refreshes the
 * episode (a job finished, a take arrived) refreshes this too.
 */
export const useCanvasInfo = (eid: number, lang: string) =>
  useQuery({
    queryKey: ["episode", eid, "canvas", lang],
    queryFn: () => api.get<CanvasInfo>(`/api/episodes/${eid}/canvas?lang=${encodeURIComponent(lang)}`, { silent: true }),
    enabled: !!eid,
    staleTime: 5_000,
  });

/**
 * The price of a paid action before it runs (POST /estimate, nothing is spent). Shown on the button; the click still goes
 * through generate(), which estimates again and opens the cost dialog. Refreshes with the episode.
 */
export function useEstimate(eid: number, body: Record<string, unknown> | null, enabled = true) {
  return useQuery({
    queryKey: ["episode", eid, "estimate", body],
    queryFn: () => api.post<Estimate>(`/api/episodes/${eid}/estimate`, body, { silent: true }),
    enabled: !!eid && !!body && enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/** The shot list as saved now (scene order and scene notes go through it). */
export const freshBoard = (eid: number) => api.get<Board>(`/api/episodes/${eid}/board`);

/** PUT body for the shot list: the scenes in this order, everything else as it is. */
export function boardBody(scenes: BoardScene[], version?: string) {
  return {
    version,
    scenes: scenes.map((sc) => ({
      id: sc.id ?? null, title: sc.title, location: sc.location, time_of_day: sc.time_of_day, summary: sc.summary,
      mood: sc.mood ?? "", look: sc.look ?? "", sound: sc.sound ?? "", music: sc.music ?? "",
      shots: sc.shots.map((s) => ({
        id: s.id ?? null, prompt: s.prompt, characters: s.characters, duration_s: s.duration_s, extend_to: s.extend_to || 0,
        extend_prompt: s.extend_prompt, framing: s.framing, camera: s.camera, engine: s.engine || "auto", sfx: s.sfx ?? "",
        lines: s.lines.map((l) => ({ speaker: l.speaker, text: l.text, emotion: l.emotion })),
      })),
    })),
  };
}

/** The board's scenes put in the order of `keys` ("scene-12", "scene-none"); scenes not listed keep their place after them. */
export function scenesInOrder(scenes: BoardScene[], keys: string[]): BoardScene[] {
  const keyOf = (sc: BoardScene) => `scene-${sc.id ?? "none"}`;
  const rank = new Map(keys.map((k, i) => [k, i]));
  return [...scenes].sort((a, b) => (rank.get(keyOf(a)) ?? 1e6) - (rank.get(keyOf(b)) ?? 1e6));
}

/** A media query, live. */
export function useMedia(q: string): boolean {
  const [on, setOn] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const h = () => setOn(m.matches);
    h();
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, [q]);
  return on;
}

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string | null) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage blocked */ }
  },
};
