/**
 * The user's look and template library (docs/EDITOR.md §16.8–16.9). Owner: nr-designer. PLACEHOLDER signatures.
 * On the desktop: one JSON file each in <library>\News\Looks | Templates (bridge.newsroom.library*); in the browser:
 * localStorage. The Graphics library, Wipe Designer and Template Designer read and write it through here.
 */
import type { ChannelLook, GfxCategory, GfxTemplate } from "./types.ts";

export interface LibraryEntry { id: string; name: string; modified: string; category?: GfxCategory }

export async function listLooks(): Promise<LibraryEntry[]> { return []; }
export async function loadLook(_id: string): Promise<ChannelLook | null> { return null; }
export async function saveLook(_l: ChannelLook): Promise<void> {}
export async function deleteLook(_id: string): Promise<void> {}
export async function listTemplates(): Promise<LibraryEntry[]> { return []; }
export async function loadTemplate(_id: string): Promise<GfxTemplate | null> { return null; }
export async function saveTemplate(_t: GfxTemplate): Promise<void> {}
export async function deleteTemplate(_id: string): Promise<void> {}
/** A .tatvamlook / .tatvamgfx file (save dialog on the desktop, a download in the browser); the path or null. */
export async function exportToFile(_kind: "look" | "template", _obj: ChannelLook | GfxTemplate): Promise<string | null> { return null; }
/** Opens a .tatvamlook / .tatvamgfx file (validated); null = cancelled or not valid. */
export async function importFromFile(_kind: "look" | "template"): Promise<ChannelLook | GfxTemplate | null> { return null; }
/** Called after any library change (to refresh lists); returns an unsubscribe. */
export function onLibraryChange(_cb: () => void): () => void { return () => undefined; }
