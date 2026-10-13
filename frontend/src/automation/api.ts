/**
 * The `assistants` bridge group (window.tatvamDesktop.assistants, docs/EDITOR.md §13), or null in a browser or an older
 * desktop build, and the window event that opens the Auto edit dialog from anywhere (File menu, Project panel, the
 * Start window, a dropped folder).
 */
import { desktop, type AssistantsBridge, type FolderListing } from "../lib/desktop";

export const assistantsBridge = (): AssistantsBridge | null => desktop()?.assistants ?? null;

export interface OpenAutoEdit {
  /** a folder to start from (a drop, the Start window's "New edit from folder") */
  folder?: string;
  listing?: FolderListing;
  /** the edit to add the sequence to (default: the open one; none on the Start window: a new edit is made) */
  editPath?: string;
}

export const AUTO_EDIT_EVENT = "tatvam:auto-edit";

/** Opens the Auto edit dialog (it is mounted by the editor, the Start window or the drop handler). */
export function openAutoEdit(o: OpenAutoEdit = {}): void {
  window.dispatchEvent(new CustomEvent<OpenAutoEdit>(AUTO_EDIT_EVENT, { detail: o }));
}

export const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+':\s*(?:[A-Za-z]*Error:\s*)?/, "");
