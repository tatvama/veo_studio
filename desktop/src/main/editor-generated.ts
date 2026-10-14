/**
 * Media the page generates, written into the edit (docs/EDITOR.md §15.1): the bridge's
 * `editor.writeGeneratedMedia(editPath, name, bytes, kind)`. The SFX library's WAVs go to `<edit>\Audio\SFX\`
 * (generated video and images to `<edit>\Generated\…`). The name must be a plain, safe file name of that kind; the file
 * is at most 50 MB, is written atomically (`.part`, then a rename) and only ever under the edit's folder, and the same
 * content already there is reused instead of written again. The file then goes through the editor's own import path
 * (probe, waveform peaks, the /__media registry) and comes back as a MediaItem.
 *
 * Electron-free (the IPC object is passed in), so the tests run it with a fake editor.
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { MediaItem } from "../shared/types.ts";
import type { EditorManager } from "./editor.ts";
import { EditorError, isInside, mediaKindOf } from "./editor-model.ts";
import { pathKey, uniquePath } from "./naming.ts";

export type GeneratedKind = "audio" | "video" | "image";
export const GENERATED_KINDS: readonly GeneratedKind[] = ["audio", "video", "image"];
export const GENERATED_MAX_BYTES = 50 * 1024 * 1024;
/** Where each kind is written inside the edit folder. */
export const GENERATED_DIRS: Record<GeneratedKind, string[]> = { audio: ["Audio", "SFX"], video: ["Generated", "Video"], image: ["Generated", "Images"] };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,118}$/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** The name as written, or an EditorError: letters, digits, space _ . ( ) -, no "..", no reserved device names, at
 *  most 119 characters, and an extension of the asked kind (.wav … for audio). */
export function checkGeneratedName(name: unknown, kind: unknown): string {
  if (!GENERATED_KINDS.includes(kind as GeneratedKind)) throw new EditorError("Generated media is audio, video or an image");
  if (typeof name !== "string") throw new EditorError("A generated file needs a name");
  const n = name.normalize("NFC");
  if (!NAME_RE.test(n) || n.includes("..") || /[. ]$/.test(n)) throw new EditorError(`"${name.slice(0, 80)}" isn't a safe file name`);
  if (RESERVED.test(n.split(".")[0].trim())) throw new EditorError(`"${n}" is a reserved name on Windows`);
  if (mediaKindOf(n) !== kind) throw new EditorError(`${n} isn't a${kind === "audio" ? "n audio" : kind === "video" ? " video" : "n image"} file name`);
  return n;
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 4 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
}

/** One write at a time per folder (two renders of a new name never race for it). */
const locks = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/**
 * Writes `bytes` as `name` (already checked) into the kind's folder of the edit folder `dir`: the same content under
 * that name (or its `_2`, `_3` … siblings) is reused; otherwise the first free name of that family is written,
 * atomically. Returns the file and whether it was already there.
 */
export async function writeGenerated(dir: string, name: string, bytes: Uint8Array, kind: GeneratedKind): Promise<{ file: string; reused: boolean }> {
  const folder = path.join(dir, ...GENERATED_DIRS[kind]);
  if (!isInside(dir, folder)) throw new EditorError("Generated media stays inside the edit's folder");
  if (!bytes.byteLength) throw new EditorError("The generated file is empty");
  if (bytes.byteLength > GENERATED_MAX_BYTES) throw new EditorError("A generated file is at most 50 MB");
  return serial(pathKey(folder), async () => {
    await fsp.mkdir(folder, { recursive: true });
    const names = await fsp.readdir(folder);
    const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
    const family = new RegExp(`^${escapeRe(stem)}(_\\d+)?${escapeRe(ext)}$`, "i");
    const want = sha(bytes);
    for (const n of names.filter((x) => family.test(x)).sort()) {
      const f = path.join(folder, n);
      // one handle for the size check and the read, so the file can't change in between
      const h = await fsp.open(f, "r").catch(() => null);
      if (!h) continue; // vanished or unreadable: not a match
      try {
        const st = await h.stat();
        if (st.isFile() && st.size === bytes.byteLength && sha(await h.readFile()) === want) return { file: f, reused: true };
      } catch { /* unreadable: not a match */ } finally {
        await h.close().catch(() => undefined);
      }
    }
    const dest = uniquePath(path.join(folder, name), new Set(names.map((n) => pathKey(path.join(folder, n)))));
    if (!isInside(folder, dest) || path.dirname(dest) !== folder) throw new EditorError("Generated media stays inside the edit's folder");
    const part = `${dest}.${process.pid}.${Date.now().toString(36)}.part`;
    try {
      await fsp.writeFile(part, bytes, { flag: "wx" });
      await retry(() => fsp.rename(part, dest));
    } catch (e) {
      await fsp.rm(part, { force: true }).catch(() => undefined);
      throw new EditorError(`${path.basename(dest)} couldn't be written: ${(e as Error).message}`);
    }
    return { file: dest, reused: false };
  });
}

/** What writeGeneratedMedia needs from the editor: its allow-list check and its import path. */
export interface GeneratedHost {
  /** The folder of an edit that was opened in Tatvam (else throws, like every editor call). */
  editDir(editPath: string): string;
  /** Probe the file, make its waveform and register it for the gateway: the MediaItem an import gives. */
  ingest(dir: string, file: string, name: string): Promise<MediaItem>;
}

/** The EditorManager as a GeneratedHost: its own edit-file check and import (probe, peaks, registry), not copied. */
export function editorGeneratedHost(ed: EditorManager): GeneratedHost {
  return {
    editDir: (p) => ed.editDir(p),
    ingest: (dir, file, name) => ed.ingestInPlace(dir, file, name),
  };
}

const asBytes = (b: unknown): Uint8Array | null =>
  b instanceof Uint8Array ? b : b instanceof ArrayBuffer ? new Uint8Array(b) : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : null;

/** The bridge's editor.writeGeneratedMedia. */
export async function writeGeneratedMedia(host: GeneratedHost, editPath: string, name: unknown, bytes: unknown, kind: unknown): Promise<MediaItem> {
  const n = checkGeneratedName(name, kind);
  const b = asBytes(bytes);
  if (!b) throw new EditorError("The generated media must be bytes");
  if (b.byteLength > GENERATED_MAX_BYTES) throw new EditorError("A generated file is at most 50 MB");
  const dir = host.editDir(editPath);
  const { file } = await writeGenerated(dir, n, b, kind as GeneratedKind);
  return host.ingest(dir, file, path.basename(file));
}

/** IPC: editor.writeGeneratedMedia; only pages on the gateway origin may call (like every editor handler). */
export function registerGeneratedIpc(ipc: { handle(channel: string, listener: (event: { senderFrame?: { url?: string } | null }, ...args: unknown[]) => unknown): void },
  isAllowed: (url: string) => boolean, host: GeneratedHost, channel: string): void {
  ipc.handle(channel, async (e, file, name, bytes, kind) => {
    if (!isAllowed(e.senderFrame?.url ?? "")) throw new Error("Not allowed from this page");
    if (typeof file !== "string" || !file || file.length > 4096) throw new Error("path must be text");
    return writeGeneratedMedia(host, file, name, bytes, kind);
  });
}
