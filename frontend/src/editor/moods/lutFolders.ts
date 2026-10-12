/**
 * The user's own LUT folders for the LUT browser (docs/EDITOR.md §12, last paragraph): any folder of .cube / .3dl
 * files the user chooses — never other apps' installed LUT folders, nothing is scanned or shipped.
 *
 * - Tatvam Desktop with the LUT-folder bridge (`editor.addLutFolder` / `lutFolders` / `removeLutFolder`, desktop-tools):
 *   a folder dialog and the folders remembered by the app (it lists their files); `editor.importLutFile` copies a LUT
 *   into the edit's LUTs\ folder (.3dl made .cube) the first time it's used, so it previews and exports like any
 *   imported LUT.
 * - Otherwise (the browser, older desktop builds): the folder picker (File System Access, its handle remembered in this
 *   browser and reconnected with one click), else a folder upload for this session. Files are read here, .3dl turned
 *   into .cube, and shown through blob URLs (preview); applying one says when the export can't carry it yet.
 */
import { create } from "zustand";
import { editorBridge } from "../../lib/desktop";
import { ed, exec, setUrls } from "../store";
import { folderLutId, lutFormatOf, toCube, type LutFormat } from "./lutFiles";

export interface FolderLut { id: string; name: string; file: string; format: LutFormat; size?: number; error?: string;
  /** A desktop folder's LUT not read yet: it is imported into the edit (and previewed) when first applied. */
  pending?: boolean }
export interface LutFolder { key: string; name: string; path?: string; luts: FolderLut[]; source: "bridge" | "handle" | "picked"; needsPermission?: boolean }

/** desktop/src/shared/types.ts LutFolder */
interface BridgeFolder { path: string; files: { name: string; relPath: string; size: number }[] }
interface LutFolderBridge {
  lutFolders?(): Promise<BridgeFolder[]>;
  addLutFolder?(): Promise<BridgeFolder | null>;
  removeLutFolder?(path: string): Promise<void>;
  importLutFile?(editPath: string, file: string): Promise<{ id: string; name: string; path?: string; url?: string; size?: number }>;
}
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
function fromBridge(f: BridgeFolder): { folder: LutFolder; entries: { file: string; size?: number; pending: true }[] } {
  return { folder: { key: f.path, name: folderName(f.path), path: f.path, luts: [], source: "bridge" },
    entries: (f.files ?? []).map((x) => ({ file: x.relPath || x.name, size: x.size, pending: true as const })) };
}
const lutBridge = () => editorBridge() as unknown as (LutFolderBridge | null);
export const hasFolderBridge = () => typeof lutBridge()?.addLutFolder === "function";

export const useLutFolders = create<{ folders: LutFolder[]; busy: boolean }>(() => ({ folders: [], busy: false }));
const setFolders = (fn: (f: LutFolder[]) => LutFolder[]) => useLutFolders.setState((s) => ({ folders: fn(s.folders) }));

/** look id → the LUT file it came from (desktop path, for importLutFile) */
const origin = new Map<string, { folder: LutFolder; file: string }>();
const blobs = new Map<string, string>();

const MAX_FILES = 400, MAX_BYTES = 24 * 1024 * 1024;

async function register(folder: LutFolder, entries: { file: string; text?: string; url?: string; size?: number; pending?: boolean }[]): Promise<LutFolder> {
  const urls: Record<string, string> = {};
  const luts: FolderLut[] = [];
  for (const e of entries.slice(0, MAX_FILES)) {
    const fmt = lutFormatOf(e.file);
    if (!fmt) continue;
    const id = folderLutId(folder.path ?? folder.name, e.file);
    const name = e.file.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");
    if (e.pending) luts.push({ id, name, file: e.file, format: fmt, size: e.size, pending: true });
    else if (e.url && fmt === "cube") { urls[`lut:${id}`] = e.url; luts.push({ id, name, file: e.file, format: fmt, size: e.size }); }
    else {
      let text = e.text;
      if (text === undefined && e.url) text = await fetch(e.url, { credentials: "same-origin" }).then((r) => (r.ok ? r.text() : "")).catch(() => "");
      const c = toCube(e.file, text ?? "");
      if ("error" in c) { luts.push({ id, name, file: e.file, format: fmt, error: c.error }); continue; }
      const old = blobs.get(id);
      if (old) URL.revokeObjectURL(old);
      const u = URL.createObjectURL(new Blob([c.cube], { type: "text/plain" }));
      blobs.set(id, u);
      urls[`lut:${id}`] = u;
      luts.push({ id, name: c.title || name, file: e.file, format: fmt, size: c.size });
    }
    origin.set(`lut:${id}`, { folder, file: e.file });
  }
  if (Object.keys(urls).length) setUrls(urls);
  luts.sort((a, b) => a.name.localeCompare(b.name));
  return { ...folder, luts, needsPermission: false };
}

// ── this browser's remembered folder handles (IndexedDB) ─────────────────────

type DirHandle = { name: string; kind: "directory"; values(): AsyncIterable<{ kind: string; name: string; getFile?(): Promise<File> } & Record<string, unknown>>;
  queryPermission?(o: { mode: "read" }): Promise<string>; requestPermission?(o: { mode: "read" }): Promise<string> };
const DB = "tatvam-editor", STORE = "lutFolders";
function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const rq = run(tx.objectStore(STORE));
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
      tx.oncomplete = () => open.result.close();
    };
  });
}
const handles = new Map<string, DirHandle>();

async function readHandle(h: DirHandle, depth = 0, prefix = ""): Promise<{ file: string; text: string }[]> {
  const out: { file: string; text: string }[] = [];
  for await (const e of h.values()) {
    if (out.length >= MAX_FILES) break;
    if (e.kind === "directory" && depth < 2) out.push(...await readHandle(e as unknown as DirHandle, depth + 1, `${prefix}${e.name}/`));
    else if (e.kind === "file" && lutFormatOf(e.name) && e.getFile) {
      const f = await e.getFile();
      if (f.size <= MAX_BYTES) out.push({ file: `${prefix}${e.name}`, text: await f.text() });
    }
  }
  return out;
}

/** Lists the folders: the desktop's remembered ones, or this browser's (reconnected when permission is still there). */
export async function loadFolders(): Promise<void> {
  const b = lutBridge();
  if (b?.lutFolders) {
    try {
      const list = await b.lutFolders();
      const folders = await Promise.all(list.map((f) => { const x = fromBridge(f); return register(x.folder, x.entries); }));
      setFolders(() => folders);
      return;
    } catch (e) { console.warn("[luts] folders", e); }
  }
  if (typeof indexedDB === "undefined") return;
  try {
    const keys = await idb<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
    const out: LutFolder[] = [];
    for (const k of keys) {
      const h = await idb<DirHandle>("readonly", (s) => s.get(k));
      if (!h) continue;
      handles.set(String(k), h);
      const f: LutFolder = { key: String(k), name: h.name, luts: [], source: "handle" };
      const perm = await h.queryPermission?.({ mode: "read" }).catch(() => "prompt");
      out.push(perm === "granted" ? await register(f, await readHandle(h)) : { ...f, needsPermission: true });
    }
    setFolders((cur) => [...out, ...cur.filter((c) => c.source === "picked")]);
  } catch (e) { console.warn("[luts] remembered folders", e); }
}

/** Adds a folder the user picks. Resolves with it, or null when the picker was closed. */
export async function addFolder(): Promise<LutFolder | null> {
  useLutFolders.setState({ busy: true });
  try {
    const b = lutBridge();
    if (b?.addLutFolder) {
      const f = await b.addLutFolder();
      if (!f) return null;
      const x = fromBridge(f);
      const folder = await register(x.folder, x.entries);
      setFolders((cur) => [...cur.filter((x) => x.key !== folder.key), folder]);
      return folder;
    }
    const pick = (window as unknown as { showDirectoryPicker?: (o: { id?: string; mode?: string }) => Promise<DirHandle> }).showDirectoryPicker;
    if (pick) {
      let h: DirHandle;
      try { h = await pick({ id: "tatvam-luts", mode: "read" }); } catch { return null; }
      const key = `${h.name}:${Date.now()}`;
      handles.set(key, h);
      try { await idb("readwrite", (s) => s.put(h as never, key)); } catch { /* not remembered: still listed */ }
      const folder = await register({ key, name: h.name, luts: [], source: "handle" }, await readHandle(h));
      setFolders((cur) => [...cur, folder]);
      return folder;
    }
    // a folder upload (this session only)
    const files = await new Promise<File[]>((resolve) => {
      const input = document.createElement("input");
      input.type = "file"; input.multiple = true;
      (input as unknown as { webkitdirectory: boolean }).webkitdirectory = true;
      input.onchange = () => resolve([...(input.files ?? [])]);
      input.oncancel = () => resolve([]);
      input.click();
    });
    const luts = files.filter((f) => lutFormatOf(f.name) && f.size <= MAX_BYTES).slice(0, MAX_FILES);
    if (!files.length) return null;
    const name = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split("/")[0] || "LUTs";
    const folder = await register({ key: `${name}:${Date.now()}`, name, luts: [], source: "picked" },
      await Promise.all(luts.map(async (f) => ({ file: (f as File & { webkitRelativePath?: string }).webkitRelativePath?.split("/").slice(1).join("/") || f.name, text: await f.text() }))));
    setFolders((cur) => [...cur, folder]);
    return folder;
  } finally { useLutFolders.setState({ busy: false }); }
}

/** Reads a remembered folder again after the browser asks for permission (needs a click). */
export async function reconnect(key: string): Promise<void> {
  const h = handles.get(key);
  if (!h) return;
  const perm = await h.requestPermission?.({ mode: "read" }).catch(() => "denied");
  if (perm !== "granted") return;
  const f = useLutFolders.getState().folders.find((x) => x.key === key);
  if (!f) return;
  const folder = await register(f, await readHandle(h));
  setFolders((cur) => cur.map((x) => (x.key === key ? folder : x)));
}

export async function removeFolder(key: string): Promise<void> {
  const f = useLutFolders.getState().folders.find((x) => x.key === key);
  if (f?.source === "bridge") await lutBridge()?.removeLutFolder?.(f.path ?? key).catch(() => undefined);
  if (f?.source === "handle") { handles.delete(key); await idb("readwrite", (s) => s.delete(key)).catch(() => undefined); }
  setFolders((cur) => cur.filter((x) => x.key !== key));
}

/**
 * The look id to put on clips for a folder LUT. With the desktop's importLutFile the file is copied into the edit
 * (exported like any imported LUT); otherwise the id points at the folder (preview only) and `exportable` is false.
 */
export async function lookForFolderLut(id: string): Promise<{ look: string; exportable: boolean }> {
  const look = `lut:${id}`;
  const src = origin.get(look);
  const b = lutBridge();
  const path = ed().path;
  if (src?.folder.source === "bridge" && src.folder.path && b?.importLutFile && path) {
    const sep = src.folder.path.includes("\\") ? "\\" : "/";
    const r = await b.importLutFile(path, `${src.folder.path}${sep}${src.file.replace(/\//g, sep)}`);
    exec(`Import LUT ${r.name}`, (p) => ({ ...p, luts: [...(p.luts ?? []).filter((l) => l.id !== r.id), { id: r.id, name: r.name, ...(r.path ? { path: r.path } : {}), ...(r.size ? { size: r.size } : {}) }] }));
    if (r.url) setUrls({ [`lut:${r.id}`]: r.url, [look]: r.url });
    // the folder's tile previews from now on
    setFolders((cur) => cur.map((f) => (f.key !== src.folder.key ? f : { ...f, luts: f.luts.map((l) => (l.id === id ? { ...l, pending: false } : l)) })));
    return { look: `lut:${r.id}`, exportable: true };
  }
  return { look, exportable: false };
}
