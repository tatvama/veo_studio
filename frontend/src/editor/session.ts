/**
 * The edit on disk, through the desktop bridge (docs/EDITOR.md §5): save (atomic, .bak rotation on the desktop
 * side), save as, autosave, import (dialog, paths, drops from Explorer), media URLs, relink, studio episodes, export.
 * The demo edit (no bridge) keeps everything in memory.
 */
import { toast } from "sonner";
import { editorBridge } from "../lib/desktop";
import { addMedia } from "./actions";
import { forDisk } from "./model/serialize";
import type { EditProject, MediaItem } from "./model/types";
import { program } from "./playback/transport";
import { ed, exec, isDirty, project, replaceProject, setSaveState, setUrls } from "./store";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "");

/** The document with the active sequence's playhead and view written in (saved with the edit, no undo step). */
function stamped(): EditProject {
  const p = project();
  const { zoom, scroll } = ed();
  return { ...p, sequences: p.sequences.map((s) => (s.id === p.activeSequenceId ? { ...s, playhead: program.frame, workArea: { zoom, scroll } } : s)) };
}

let demoNoted = false;

/** Saves the edit. Resolves true when it's on disk (or, for the demo, kept in memory). */
export async function save(): Promise<boolean> {
  const st = ed();
  if (st.saving) return false;
  const b = editorBridge();
  if (st.demo || !b || !st.path) {
    if (!demoNoted) { toast.message(st.demo ? "The demo edit lives in memory only — open Tatvam Desktop to save edits" : "Saving needs Tatvam Desktop"); demoNoted = true; }
    setSaveState({ saved: st.h.present, savedAt: new Date().toISOString() });
    return st.demo;
  }
  const before = project();
  const doc = stamped();
  setSaveState({ saving: true, saveError: null });
  try {
    const r = await b.save(st.path, forDisk(doc));
    const saved = { ...doc, modified: r.modified };
    if (project() === before) replaceProject(saved, true);
    setSaveState({ saving: false, savedAt: r.modified });
    return true;
  } catch (e) {
    setSaveState({ saving: false, saveError: msg(e) });
    toast.error(`Couldn't save: ${msg(e)}`);
    return false;
  }
}

/** Save As: a new edit in the library with this content; the window then works on the copy. */
export async function saveAs(name: string): Promise<string | null> {
  const b = editorBridge();
  if (!b) { toast.message("Save As needs Tatvam Desktop"); return null; }
  try {
    const p = stamped();
    const s = p.sequences.find((x) => x.id === p.activeSequenceId) ?? p.sequences[0];
    const made = await b.create(name, { width: s.width, height: s.height, fps: s.fps });
    const doc: EditProject = { ...p, id: made.project.id, name, created: made.project.created };
    const r = await b.save(made.path, forDisk(doc));
    replaceProject({ ...doc, modified: r.modified }, true);
    setSaveState({ path: made.path, savedAt: r.modified });
    return made.path;
  } catch (e) {
    toast.error(`Save As failed: ${msg(e)}`);
    return null;
  }
}

/** Autosave every `settings.autosaveSeconds` while there are unsaved changes; returns the stop function. */
export function startAutosave(): () => void {
  let last = Date.now();
  const id = window.setInterval(() => {
    const st = ed();
    const every = Math.max(0, st.h.present.settings.autosaveSeconds) * 1000;
    if (!every || st.demo || !st.path || st.saving || st.h.gesture || !isDirty(st)) return;
    if (Date.now() - last < every) return;
    last = Date.now();
    void save();
  }, 1000);
  return () => window.clearInterval(id);
}

/** Media URLs for items that came without one (the bridge registers each file with the gateway). */
export async function resolveUrls(items: MediaItem[] = project().media) {
  const b = editorBridge();
  const path = ed().path;
  if (!b || !path) return;
  const need = items.filter((m) => !m.url && !ed().urls[m.id] && !m.missing && !m.path.startsWith("studio:"));
  const out: Record<string, string> = {};
  await Promise.all(need.map(async (m) => { try { out[m.id] = await b.mediaUrl(path, m.path); } catch { /* offline: shown as missing */ } }));
  if (Object.keys(out).length) setUrls(out);
}

/** Import: the file dialog, or the given paths (drag from Explorer). */
export async function importFiles(files?: string[], binId: string | null = null): Promise<MediaItem[]> {
  const b = editorBridge();
  const path = ed().path;
  if (!b || !path) { toast.message(ed().demo ? "Importing files needs Tatvam Desktop (the demo has its own media)" : "Importing needs Tatvam Desktop"); return []; }
  const t = files?.length ? toast.loading(`Importing ${files.length} file${files.length === 1 ? "" : "s"}…`) : undefined;
  try {
    const items = await b.importMedia(path, files);
    if (t !== undefined) toast.dismiss(t);
    if (!items?.length) return [];
    const fresh = addMedia(items, binId);
    void resolveUrls(fresh);
    if (fresh.length) toast.success(fresh.length === 1 ? `Imported ${fresh[0].name}` : `Imported ${fresh.length} files`);
    return fresh;
  } catch (e) {
    if (t !== undefined) toast.dismiss(t);
    toast.error(`Import failed: ${msg(e)}`);
    return [];
  }
}

/** Files dropped from Explorer → paths → import. */
export async function importDropped(files: FileList | File[], binId: string | null = null): Promise<MediaItem[]> {
  const b = editorBridge();
  if (!b) { toast.message("Dropping files needs Tatvam Desktop"); return []; }
  let paths: string[] = [];
  try { paths = b.pathsForDrop([...files]); } catch { paths = []; }
  if (!paths.length) return [];
  return importFiles(paths, binId);
}

export async function relink(mediaId: string) {
  const b = editorBridge();
  const path = ed().path;
  if (!b || !path) { toast.message("Relinking needs Tatvam Desktop"); return; }
  try {
    const m = await b.relink(path, mediaId);
    if (!m) return;
    exec(`Relink ${m.name}`, (p) => ({ ...p, media: p.media.map((x) => (x.id === mediaId ? { ...m, id: mediaId, binId: x.binId, markers: x.markers, inPoint: x.inPoint, outPoint: x.outPoint } : x)) }));
    void resolveUrls([m]);
    toast.success(`Relinked ${m.name}`);
  } catch (e) { toast.error(`Relink failed: ${msg(e)}`); }
}

/** Makes a proxy (the bridge reads the saved file, so this saves first) and records it on the item. */
export async function makeProxy(mediaId: string) {
  const b = editorBridge();
  const path = ed().path;
  if (!b || !path) { toast.message("Proxies need Tatvam Desktop"); return; }
  if (isDirty() && !(await save())) return;
  const t = toast.loading("Making a proxy…");
  try {
    const m = await b.proxy(path, mediaId);
    toast.dismiss(t);
    if (m) exec("Make proxy", (p) => ({ ...p, media: p.media.map((x) => (x.id === mediaId ? { ...x, proxyPath: m.proxyPath, proxyUrl: m.proxyUrl } : x)) }));
    toast.success("Proxy ready");
  } catch (e) { toast.dismiss(t); toast.error(`Proxy failed: ${msg(e)}`); }
}

/** A studio episode's cut as a new sequence in this edit (the bridge syncs its media into the edit folder). */
export async function importEpisode(pid: number, eid: number): Promise<boolean> {
  const b = editorBridge();
  const path = ed().path;
  if (!b || !path) { toast.message("Importing an episode needs Tatvam Desktop"); return false; }
  if (isDirty() && !(await save())) return false;
  const t = toast.loading("Importing the episode's cut…");
  try {
    const r = await b.importEpisode(pid, eid, path);
    toast.dismiss(t);
    // the returned project becomes the document (one undo step); autosave writes it
    exec("Import studio episode", () => ({ ...r.project, activeSequenceId: r.sequenceId }));
    void resolveUrls(r.project.media);
    toast.success("The episode is a new sequence");
    for (const w of (r.warnings ?? []).slice(0, 4)) toast.warning(w);
    return true;
  } catch (e) {
    toast.dismiss(t);
    toast.error(`Import failed: ${msg(e)}`);
    return false;
  }
}

export async function exportSequence(opts: { preset: string; range: "all" | "inout"; upload?: boolean }): Promise<string | null> {
  const b = editorBridge();
  const st = ed();
  if (!b || !st.path) { toast.message("Exporting needs Tatvam Desktop"); return null; }
  if (isDirty() && !(await save())) return null;
  try {
    const id = await b.export(st.path, project().activeSequenceId, opts);
    toast.success("Export started — follow it in the Render queue");
    return id;
  } catch (e) { toast.error(`Export failed: ${msg(e)}`); return null; }
}

/** Imports a .cube LUT into the edit: it becomes a look ("lut:<id>") in the Look effect's picker. */
export async function importLut(): Promise<string | null> {
  const b = editorBridge();
  const st = ed();
  if (!b || !st.path) { toast.message("Importing LUTs needs Tatvam Desktop"); return null; }
  try {
    const r = await b.importLut(st.path);
    if (!r) return null;
    exec(`Import LUT ${r.name}`, (p) => ({ ...p, luts: [...(p.luts ?? []).filter((l) => l.id !== r.id), { id: r.id, name: r.name, ...(r.path ? { path: r.path } : {}), ...(r.size ? { size: r.size } : {}) }] }));
    if (r.url) setUrls({ [`lut:${r.id}`]: r.url });
    toast.success(`LUT ${r.name} imported: pick it in a Look / LUT effect`);
    return r.id;
  } catch (e) { toast.error(msg(e)); return null; }
}

/** Gateway URLs for the edit's imported LUTs (on open). */
export async function resolveLutUrls() {
  const b = editorBridge();
  const path = ed().path;
  if (!b || !path) return;
  const out: Record<string, string> = {};
  await Promise.all((project().luts ?? []).filter((l) => l.path).map(async (l) => { try { out[`lut:${l.id}`] = await b.mediaUrl(path, l.path!); } catch { /* missing: the look is left out */ } }));
  if (Object.keys(out).length) setUrls(out);
}

/** Registers this PC's custom shaders with the engine (on open, and after an import). */
export async function loadShaders(): Promise<void> {
  try {
    const { registerDesktopShaders } = await import("./engine");
    const r = await registerDesktopShaders();
    for (const f of r.failed.slice(0, 3)) toast.error(`Custom shader ${f.name}: ${f.error}`);
  } catch (e) { console.warn("[editor] shaders", e); }
}

/** Effects panel → Import shader…: a GLSL effect or a gl-transitions transition. */
export async function importShader(kind: "transition" | "effect"): Promise<string | null> {
  const b = editorBridge();
  const st = ed();
  if (!b || !st.path) { toast.message("Importing shaders needs Tatvam Desktop"); return null; }
  try {
    const r = await b.importShader(st.path, kind);
    if (!r) return null;
    const list = await b.shaders();
    const mine = list.filter((x) => x.id === r.id && x.kind === kind);
    const { registerShaders } = await import("./engine");
    const res = await registerShaders(mine);
    if (res.failed.length) { toast.error(`${r.name}: ${res.failed[0].error}`); return null; }
    toast.success(`${kind === "effect" ? "Effect" : "Transition"} ${r.name} added`);
    return `custom:${r.id}`;
  } catch (e) { toast.error(`Import failed: ${msg(e)}`); return null; }
}
