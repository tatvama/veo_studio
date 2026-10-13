/**
 * The audio tools' entry points (docs/EDITOR.md §15.4): the "Audio tools" menu, opening the Audio Tools panel on a
 * tab, and "Audio visualiser" dragged from the Effects panel's Generate section onto a video track. EditorApp imports
 * this module at start, which also connects the visualiser's spectrum frames (./actions).
 */
import { create } from "zustand";
import type { MenuItem } from "../ui";
import { ed, seq } from "../store";
import { addVisualizer } from "./actions";

export type AudioToolsTab = "mix" | "roomtone" | "breaths" | "visualizer";
export const useAudioTools = create<{ tab: AudioToolsTab }>(() => ({ tab: "mix" }));

/** Opens the Audio Tools panel (beside the Source monitor when the layout doesn't have it yet) on a tab. */
export function openAudioTools(tab: AudioToolsTab) {
  useAudioTools.setState({ tab });
  window.dispatchEvent(new CustomEvent("ed:panel", { detail: "audiotools" }));
}

export const audioToolsMenu = (): MenuItem => ({
  label: "Audio tools", items: [
    { label: "Auto mix…", onClick: () => openAudioTools("mix") },
    { label: "Room-tone fill…", onClick: () => openAudioTools("roomtone") },
    { label: "Breath remover…", onClick: () => openAudioTools("breaths") },
    { label: "Audio visualiser…", onClick: () => openAudioTools("visualizer") },
  ],
});

/** The Effects panel's Generate entry. */
export const VIZ_MIME = "application/x-tatvam-visualizer";
export const VISUALIZER_ITEM = { id: "visualizer", label: "Audio visualiser", hint: "video" };

let dropInstalled = false;
/** "Audio visualiser" dragged from the Effects panel lands on a video track lane as a new visualiser clip. */
export function installVisualizerDrop() {
  if (dropInstalled || typeof window === "undefined") return;
  dropInstalled = true;
  const laneOf = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(VIZ_MIME)) return null;
    const lane = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(".tl-lane[data-track]");
    const t = lane ? seq().tracks.find((x) => x.id === lane.dataset.track) : undefined;
    return lane && t?.kind === "video" && !t.locked ? { lane, track: t } : null;
  };
  window.addEventListener("dragover", (e) => { if (laneOf(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; } });
  window.addEventListener("drop", (e) => {
    const hit = laneOf(e);
    if (!hit) return;
    e.preventDefault();
    const s = ed();
    const frame = Math.max(0, Math.round((e.clientX - hit.lane.getBoundingClientRect().left + s.scroll) / s.zoom));
    void addVisualizer({ at: frame, trackId: hit.track.id });
  });
}
