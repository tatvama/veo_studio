/**
 * The News Room look / template library on disk (docs/EDITOR.md §16.9). Owner: nr-designer.
 * <library>\News\Looks\<id>.tatvamlook and <library>\News\Templates\<id>.tatvamgfx, one JSON file each. Ids are
 * checked (letters, digits, dot, dash, underscore; no separators), writes are atomic (temp file + rename), files are
 * capped at 32 MB, and export / import go through the Electron save / open dialogs of the app window. The shape of a
 * look or template is checked by the page (newsroom/designer/validate.ts); here only "is it a JSON object" is.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BrowserWindow, OpenDialogOptions, SaveDialogOptions } from "electron";
import type { NewsLibraryEntry, NewsLibraryKind } from "../../shared/types.ts";
import type { NewsroomDeps } from "./ipc.ts";

/** Largest look or template file (a look carries its logo as a small data: URL; templates are plain JSON). */
export const MAX_LIBRARY_BYTES = 32 * 1024 * 1024;
export const LIBRARY_EXT: Record<NewsLibraryKind, string> = { look: ".tatvamlook", template: ".tatvamgfx" };
const DIR: Record<NewsLibraryKind, string> = { look: "Looks", template: "Templates" };
const WHAT: Record<NewsLibraryKind, string> = { look: "look", template: "graphic" };

/** The save / open dialogs (Electron's by default; tests pass their own). Each returns a path, or null = cancelled. */
export interface FileDialogs {
  save(parent: BrowserWindow | null, o: SaveDialogOptions): Promise<string | null>;
  open(parent: BrowserWindow | null, o: OpenDialogOptions): Promise<string | null>;
}
const electronDialogs: FileDialogs = {
  async save(parent, o) {
    const { dialog } = await import("electron");
    const r = parent ? await dialog.showSaveDialog(parent, o) : await dialog.showSaveDialog(o);
    return r.canceled || !r.filePath ? null : r.filePath;
  },
  async open(parent, o) {
    const { dialog } = await import("electron");
    const r = parent ? await dialog.showOpenDialog(parent, o) : await dialog.showOpenDialog(o);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  },
};

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
/** A library id is a plain file name: letters, digits, ".", "-" and "_", not starting or ending with a dot. */
export function isLibraryId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 160 && /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test(id)
    && !id.includes("..") && !RESERVED.test(id);
}
function checkId(id: string): string {
  if (!isLibraryId(id)) throw new Error("That name can't be used for a library file (letters, digits, dot, dash and underscore only).");
  return id;
}

export const libraryDir = (d: Pick<NewsroomDeps, "libraryRoot">, k: NewsLibraryKind) => path.join(d.libraryRoot(), "News", DIR[k]);
const fileOf = (d: Pick<NewsroomDeps, "libraryRoot">, k: NewsLibraryKind, id: string) => path.join(libraryDir(d, k), checkId(id) + LIBRARY_EXT[k]);
const isMissing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";

/** Parses text as a JSON object (not an array or a value) or throws a plain-English error. */
function jsonObject(json: string, k: NewsLibraryKind): Record<string, unknown> {
  if (Buffer.byteLength(json, "utf8") > MAX_LIBRARY_BYTES) throw new Error(`That ${WHAT[k]} is too large (over 32 MB).`);
  let v: unknown;
  try { v = JSON.parse(json); } catch { throw new Error(`That isn't a Tatvam ${WHAT[k]} file (it isn't readable JSON).`); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`That isn't a Tatvam ${WHAT[k]} file.`);
  return v as Record<string, unknown>;
}

/** Writes a file so a crash never leaves half of it: a temp file next to it, then a rename over the old one. */
async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, text, "utf8");
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** A suggested file name without characters Windows refuses. */
export function safeFileName(name: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const s = name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 80);
  return s && !RESERVED.test(s) ? s : fallback;
}

/** Every look or template in the library, newest first, with its name read from the file. */
export async function libraryList(d: NewsroomDeps, k: NewsLibraryKind): Promise<NewsLibraryEntry[]> {
  const dir = libraryDir(d, k);
  let names: string[];
  try { names = await fs.readdir(dir); } catch (e) { if (isMissing(e)) return []; throw e; }
  const out: NewsLibraryEntry[] = [];
  for (const n of names) {
    if (!n.toLowerCase().endsWith(LIBRARY_EXT[k])) continue;
    const id = n.slice(0, -LIBRARY_EXT[k].length);
    if (!isLibraryId(id)) continue;
    const file = path.join(dir, n);
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) continue;
      let name = id;
      if (st.size <= MAX_LIBRARY_BYTES) {
        try {
          const v = JSON.parse(await fs.readFile(file, "utf8")) as { name?: unknown };
          if (typeof v?.name === "string" && v.name.trim()) name = v.name.trim().slice(0, 200);
        } catch { /* listed by its id; reading it later says what's wrong */ }
      }
      out.push({ id, name, path: file, modified: st.mtime.toISOString(), bytes: st.size });
    } catch (e) {
      d.log(`newsroom library: ${n}: ${(e as Error).message}`);
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified) || a.name.localeCompare(b.name));
}

/** A library file's JSON, or null when there is none. */
export async function libraryRead(d: NewsroomDeps, k: NewsLibraryKind, id: string): Promise<string | null> {
  const file = fileOf(d, k, id);
  try {
    const st = await fs.stat(file);
    if (st.size > MAX_LIBRARY_BYTES) throw new Error(`That ${WHAT[k]} is too large (over 32 MB).`);
    return await fs.readFile(file, "utf8");
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/** Saves a look or template (replacing one with the same id). The JSON's own id, when it has one, must match. */
export async function libraryWrite(d: NewsroomDeps, k: NewsLibraryKind, id: string, json: string): Promise<{ path: string }> {
  const file = fileOf(d, k, id);
  const v = jsonObject(json, k);
  if (typeof v.id === "string" && v.id !== id) throw new Error(`The ${WHAT[k]}'s id doesn't match its file name.`);
  await writeAtomic(file, json);
  return { path: file };
}

export async function libraryDelete(d: NewsroomDeps, k: NewsLibraryKind, id: string): Promise<void> {
  try { await fs.unlink(fileOf(d, k, id)); } catch (e) { if (!isMissing(e)) throw e; }
}

/** Save dialog for a .tatvamlook / .tatvamgfx file; the path written, or null when cancelled. */
export async function exportFile(d: NewsroomDeps, k: NewsLibraryKind, json: string, name: string, dialogs: FileDialogs = electronDialogs): Promise<string | null> {
  jsonObject(json, k);
  const ext = LIBRARY_EXT[k];
  const base = safeFileName(name.replace(new RegExp(`\\${ext}$`, "i"), ""), k === "look" ? "Channel look" : "Graphic");
  const picked = await dialogs.save(d.parent(), {
    title: k === "look" ? "Export look" : "Export graphic template",
    defaultPath: base + ext,
    filters: [{ name: k === "look" ? "Tatvam look" : "Tatvam graphic", extensions: [ext.slice(1)] }],
    properties: ["showOverwriteConfirmation", "createDirectory"],
  });
  if (!picked) return null;
  const file = picked.toLowerCase().endsWith(ext) ? picked : picked + ext;
  await writeAtomic(file, json);
  d.log(`newsroom: exported ${WHAT[k]} to ${file}`);
  return file;
}

/** Open dialog for a .tatvamlook / .tatvamgfx file; its name and JSON, or null when cancelled. */
export async function importFile(d: NewsroomDeps, k: NewsLibraryKind, dialogs: FileDialogs = electronDialogs): Promise<{ name: string; json: string } | null> {
  const ext = LIBRARY_EXT[k];
  const picked = await dialogs.open(d.parent(), {
    title: k === "look" ? "Import look" : "Import graphic template",
    properties: ["openFile"],
    filters: [{ name: k === "look" ? "Tatvam look" : "Tatvam graphic", extensions: [ext.slice(1)] }, { name: "All files", extensions: ["*"] }],
  });
  if (!picked) return null;
  const st = await fs.stat(picked);
  if (!st.isFile()) throw new Error("That isn't a file.");
  if (st.size > MAX_LIBRARY_BYTES) throw new Error(`That file is too large to be a ${WHAT[k]} (over 32 MB).`);
  const json = await fs.readFile(picked, "utf8");
  jsonObject(json, k);
  const name = path.basename(picked).replace(/\.[^.]+$/, "");
  return { name, json };
}
