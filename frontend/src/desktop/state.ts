/**
 * Small shared state of the desktop shell in one window: which overlay is open (command palette, shortcut sheet,
 * notification centre, What's new, the folder choice), the unsaved-work guards a reload must respect, and the drop
 * handlers pages register (the editor imports dropped media into the open edit).
 */
import { useSyncExternalStore } from "react";
import type { DropEntry } from "../lib/desktop";

export type Overlay = "palette" | "shortcuts" | "notifications" | "whatsnew" | "jobs" | null;

interface ShellUi { overlay: Overlay; folder: DropEntry | null; paletteQuery: string }
let ui: ShellUi = { overlay: null, folder: null, paletteQuery: "" };
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function setOverlay(o: Overlay, query = ""): void {
  ui = { ...ui, overlay: o, paletteQuery: o === "palette" ? query : "" };
  emit();
}
export const toggleOverlay = (o: Exclude<Overlay, null>) => setOverlay(ui.overlay === o ? null : o);
/** Open the "New edit from this folder" choice (Empty edit with these clips / Auto edit…). */
export function chooseFolderEdit(folder: DropEntry | null): void {
  ui = { ...ui, folder };
  emit();
}
export function useShellUi(): ShellUi {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => ui, () => ui);
}

// ── unsaved work ────────────────────────────────────────────────────────────

export interface Guard { name: string; dirty(): boolean; /** saves; resolves false when it couldn't */ save?(): Promise<boolean> }
const guards = new Set<Guard>();
export function registerGuard(g: Guard): () => void {
  guards.add(g);
  return () => { guards.delete(g); };
}

/**
 * Before a reload (or a restart into an update): guards with a save() save first (the editor); any other unsaved
 * work asks (`ask` shows the question and resolves true to go on). Resolves true when it's fine to go ahead.
 */
export async function saveGuards(ask: (names: string[]) => Promise<boolean>): Promise<boolean> {
  const unsaved: string[] = [];
  for (const g of guards) {
    let dirty = false;
    try { dirty = g.dirty(); } catch { dirty = false; }
    if (!dirty) continue;
    if (g.save) {
      const ok = await g.save().catch(() => false);
      if (!ok) unsaved.push(g.name);
    } else unsaved.push(g.name);
  }
  if (document.querySelector("[data-unsaved='true']")) unsaved.push("This page");
  return !unsaved.length || ask(unsaved);
}

/** Reload this window into the newest screens, after saveGuards. */
export async function reloadWindow(ask: (names: string[]) => Promise<boolean>): Promise<boolean> {
  if (!(await saveGuards(ask))) return false;
  window.location.reload();
  return true;
}

// ── drops ───────────────────────────────────────────────────────────────────

export interface DropTarget {
  /** media files dropped on the window; true = handled */
  media?(paths: string[]): boolean | Promise<boolean>;
}
const dropTargets: DropTarget[] = [];
export function registerDropTarget(t: DropTarget): () => void {
  dropTargets.unshift(t);
  return () => { const i = dropTargets.indexOf(t); if (i >= 0) dropTargets.splice(i, 1); };
}
export const currentDropTargets = () => [...dropTargets];
