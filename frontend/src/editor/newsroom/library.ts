/**
 * The user's look and template library (docs/EDITOR.md §16.8–16.9). Owner: nr-designer.
 * On the desktop: one JSON file each in <library>\News\Looks | Templates (bridge.newsroom.library*); in the browser:
 * localStorage. Everything read is checked (designer/validate.ts); the user's ids are `look.my.<uuid>` / `my.<uuid>`.
 * The Graphics library, Wipe Designer and Template Designer read and write it through here. The logic is in
 * designer/libraryCore.ts (pure, tested); this file picks the backend and does the file dialogs.
 */
import { toast } from "sonner";
import { newsroomBridge } from "../../lib/desktop";
import { createLibrary, bridgeBackend, storageBackend, type StorageLike } from "./designer/libraryCore";
import type { Checked } from "./designer/validate";
import { builtinLook, DEFAULT_LOOK_ID } from "./looks";
import type { ChannelLook, GfxTemplate } from "./types";

export type { LibraryEntry } from "./designer/libraryCore";
export { newLookId, newTemplateId, isMyLook, isMyTemplate } from "./designer/libraryCore";

function storage(): StorageLike | null {
  try { const s = window.localStorage; const k = "tatvam.newsroom.probe"; s.setItem(k, "1"); s.removeItem(k); return s; } catch { return null; }
}
const lib = createLibrary(() => {
  const b = newsroomBridge();
  return b ? bridgeBackend(b) : storageBackend(storage());
}, () => builtinLook(DEFAULT_LOOK_ID)!, (m) => console.warn(m));

export const listLooks = lib.listLooks;
export const loadLook = lib.loadLook;
export const saveLook = lib.saveLook;
export const deleteLook = lib.deleteLook;
export const listTemplates = lib.listTemplates;
export const loadTemplate = lib.loadTemplate;
export const saveTemplate = lib.saveTemplate;
export const deleteTemplate = lib.deleteTemplate;
/** Called after any library change (to refresh lists); returns an unsubscribe. */
export const onLibraryChange = lib.onChange;
/** "desktop" (files in the library folder) or "browser" (this browser only). */
export const libraryWhere = lib.where;

const EXT = { look: ".tatvamlook", template: ".tatvamgfx" } as const;

/** A .tatvamlook / .tatvamgfx file (save dialog on the desktop, a download in the browser); the path or null. */
export async function exportToFile(kind: "look" | "template", obj: ChannelLook | GfxTemplate): Promise<string | null> {
  const json = JSON.stringify(obj, null, 1);
  const name = obj.name || (kind === "look" ? "Channel look" : "Graphic");
  const b = newsroomBridge();
  if (b) return b.exportFile(kind, json, name);
  try {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name.replace(/[<>:"/\\|?*]+/g, " ").trim() + EXT[kind];
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return a.download;
  } catch {
    return null;
  }
}

/** The browser's file picker for one file's text; null when cancelled. */
function pickText(ext: string): Promise<{ name: string; json: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `${ext},application/json`;
    let done = false;
    const finish = (v: { name: string; json: string } | null) => { if (!done) { done = true; resolve(v); } };
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return finish(null);
      if (f.size > 32 * 1024 * 1024) return finish({ name: f.name, json: "" });
      finish({ name: f.name.replace(/\.[^.]+$/, ""), json: await f.text() });
    };
    window.addEventListener("focus", () => setTimeout(() => { if (!input.files?.length) finish(null); }, 800), { once: true });
    input.click();
  });
}

/**
 * Opens a .tatvamlook / .tatvamgfx file, checks it and adds it to the library (with a fresh id when it would clash).
 * `null` = cancelled; `{ ok: false, reason }` = not a valid file.
 */
export async function importFileChecked(kind: "look", taken?: Iterable<string>): Promise<Checked<ChannelLook> | null>;
export async function importFileChecked(kind: "template", taken?: Iterable<string>): Promise<Checked<GfxTemplate> | null>;
export async function importFileChecked(kind: "look" | "template", taken: Iterable<string> = []): Promise<Checked<ChannelLook | GfxTemplate> | null> {
  let picked: { name: string; json: string } | null;
  try {
    const b = newsroomBridge();
    picked = b ? await b.importFile(kind) : await pickText(EXT[kind]);
  } catch (e) {
    return { ok: false, reason: (e as Error).message ?? "The file couldn't be read." };
  }
  if (!picked) return null;
  if (!picked.json) return { ok: false, reason: "That file is too large (over 32 MB)." };
  const have = new Set(taken);
  for (const e of kind === "look" ? await lib.listLooks() : await lib.listTemplates()) have.add(e.id);
  const r = kind === "look" ? lib.parseLook(picked.json, have) : lib.parseTemplate(picked.json, have);
  if (!r.ok) return r;
  try {
    if (kind === "look") await lib.saveLook(r.value as ChannelLook); else await lib.saveTemplate(r.value as GfxTemplate);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  return r;
}

/** Opens a .tatvamlook / .tatvamgfx file (validated, added to the library); null = cancelled or not valid (a toast says why). */
export async function importFromFile(kind: "look" | "template"): Promise<ChannelLook | GfxTemplate | null> {
  const r = kind === "look" ? await importFileChecked("look") : await importFileChecked("template");
  if (!r) return null;
  if (!r.ok) { toast.error(`That file couldn't be imported. ${r.reason}`); return null; }
  return r.value;
}
