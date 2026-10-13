/**
 * Things the desktop shell does from several places (Start, the palette, drops, the Jump List): new edits (empty, from
 * a folder of clips, from dropped clips), opening an edit or a timeline file, and uploading dropped media to the open
 * studio project's library.
 */
import { toast } from "sonner";
import { api } from "../lib/api";
import { desktop, editorBridge, type DropEntry } from "../lib/desktop";
import { useUI } from "../lib/store";
import { chooseFolderEdit } from "./state";
import { editUrl, errText } from "./bridge";

export type Nav = (to: string) => void;

export const DEFAULT_PRESET = { width: 1920, height: 1080, fps: 25 };

/** Create an edit, trying "Name 2", "Name 3" … when the name is taken. */
export async function createEdit(name: string, preset = DEFAULT_PRESET): Promise<{ path: string } | null> {
  const b = editorBridge();
  if (!b) { toast.message("Edits need Tatvam Desktop"); return null; }
  const base = name.trim().slice(0, 80) || "Untitled edit";
  for (let i = 1; i <= 20; i++) {
    try {
      return await b.create(i === 1 ? base : `${base} ${i}`, preset);
    } catch (e) {
      if (!/already exists/i.test(errText(e))) { toast.error(`Couldn't create the edit: ${errText(e)}`); return null; }
    }
  }
  toast.error("Couldn't find a free name for the edit");
  return null;
}

/** A new edit with these clips in its project panel (the timeline stays empty). */
export async function newEditWithClips(name: string, files: string[], nav: Nav): Promise<boolean> {
  const b = editorBridge();
  if (!b) return false;
  const t = toast.loading(`Creating "${name}" with ${files.length} clip${files.length === 1 ? "" : "s"}…`);
  try {
    const made = await createEdit(name);
    if (!made) return false;
    if (files.length) {
      const items = await b.importMedia(made.path, files);
      if (items.length) {
        const r = await b.open(made.path);
        if (r) await b.save(made.path, { ...r.project, media: [...r.project.media.filter((m) => !items.some((x) => x.id === m.id)), ...items] });
      }
    }
    toast.success(`"${name}" is ready`, { id: t });
    nav(editUrl(made.path));
    return true;
  } catch (e) {
    toast.error(`Couldn't make the edit: ${errText(e)}`, { id: t });
    return false;
  } finally {
    setTimeout(() => toast.dismiss(t), 4000);
  }
}

/** Pick a folder of clips, then choose: an empty edit with them, or Auto edit. */
export async function newEditFromFolder(): Promise<void> {
  const s = desktop()?.shell;
  if (!s) { toast.message("This needs Tatvam Desktop"); return; }
  const f = await s.pickFolder("Choose a folder of clips").catch((e) => { toast.error(errText(e)); return null; });
  if (f) folderChoice(f);
}

export function folderChoice(f: DropEntry): void {
  if (!f.media?.length) { toast.message(`${f.name} has no video, audio or image files in it`); return; }
  chooseFolderEdit(f);
}

/** Open an edit (a dialog without a path). */
export async function openEdit(nav: Nav, path?: string): Promise<void> {
  const b = editorBridge();
  if (!b) { toast.message("Opening edits needs Tatvam Desktop"); return; }
  try {
    const r = await b.open(path);
    if (r) nav(editUrl(r.path));
  } catch (e) {
    toast.error(errText(e));
  }
}

/** An XML / EDL / OTIO through editor-interop's bridge, when this build has it. */
export async function importTimeline(path: string, nav: Nav): Promise<void> {
  const interop = editorBridge()?.interop;
  if (!interop?.importFile) { toast.message("Importing XML, EDL and OTIO timelines needs a newer Tatvam Editor"); return; }
  const t = toast.loading("Importing the timeline…");
  try {
    const r = await interop.importFile(path);
    toast.dismiss(t);
    if (!r) return;
    if (r.kind === "edit") {
      for (const w of r.warnings.slice(0, 3)) toast.warning(w);
      toast.success(`Imported ${r.name}${r.missing ? ` (${r.missing} file${r.missing === 1 ? "" : "s"} to relink)` : ""}`);
      nav(editUrl(r.path));
    } else {
      toast.message(`${r.name}: open an edit and import the markers from its Markers panel`);
    }
  } catch (e) {
    toast.error(`Import failed: ${errText(e)}`, { id: t });
  }
}

/** The episode a studio page is on: ?eid= / ?episode=, the remembered one, else the project's first. */
async function episodeOf(pid: number): Promise<number | null> {
  const q = new URLSearchParams(location.search);
  const e = Number(q.get("eid") ?? q.get("episode"));
  if (e > 0) return e;
  const remembered = useUI.getState().episode[pid];
  if (remembered) return remembered;
  try {
    const p = await api.get<{ episodes?: { id: number }[] }>(`/api/projects/${pid}`, { silent: true });
    return p.episodes?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Media dropped on a studio project page: uploaded to its media library (the episode's layer media). */
export async function uploadToProject(pid: number, files: File[]): Promise<void> {
  const eid = await episodeOf(pid);
  if (!eid) { toast.error("This project has no episode to add media to yet"); return; }
  const t = toast.loading(`Uploading ${files.length} file${files.length === 1 ? "" : "s"} to the project's media…`);
  let ok = 0;
  for (const f of files) {
    try { await api.upload(`/api/episodes/${eid}/media`, f); ok++; } catch { /* api toasts the reason */ }
  }
  toast.dismiss(t);
  if (ok) toast.success(`${ok} file${ok === 1 ? "" : "s"} added to the project's media library`);
}
