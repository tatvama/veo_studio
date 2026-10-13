/**
 * News Room IPC (docs/EDITOR.md §16.9). Owner: lead (stable). Every call is checked to come from an app page, then
 * handed to its module: files.ts (nr-designer), fetch.ts (nr-data), export.ts (nr-delivery).
 */
import type { BrowserWindow, IpcMain } from "electron";
import { NEWSROOM_IPC, type NewsExportOptions, type NewsLibraryKind } from "../../shared/types.ts";
import { exportGraphics, type NewsExportDeps } from "./export.ts";
import { fetchText, readTextFile } from "./fetch.ts";
import { libraryDelete, libraryList, libraryRead, libraryWrite, exportFile, importFile } from "./files.ts";

export interface NewsroomDeps extends NewsExportDeps {
  /** The library root ("Tatvam Projects"). */
  libraryRoot(): string;
  /** The window dialogs belong to. */
  parent(): BrowserWindow | null;
  log(msg: string): void;
}

export function registerNewsroomIpc(ipc: IpcMain, isAllowed: (url: string) => boolean, deps: NewsroomDeps): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, async (e, ...args) => {
      if (!isAllowed(e.senderFrame?.url ?? "")) throw new Error("Not allowed from this page");
      return fn(...args);
    });
  };
  const kind = (v: unknown): NewsLibraryKind => {
    if (v !== "look" && v !== "template") throw new Error("kind must be look or template");
    return v;
  };
  const str = (v: unknown, name: string, max = 4096): string => {
    if (typeof v !== "string" || !v || v.length > max) throw new Error(`${name} must be text`);
    return v;
  };
  handle(NEWSROOM_IPC.libraryList, (k) => libraryList(deps, kind(k)));
  handle(NEWSROOM_IPC.libraryRead, (k, id) => libraryRead(deps, kind(k), str(id, "id", 200)));
  handle(NEWSROOM_IPC.libraryWrite, (k, id, json) => libraryWrite(deps, kind(k), str(id, "id", 200), str(json, "json", 32 * 1024 * 1024)));
  handle(NEWSROOM_IPC.libraryDelete, (k, id) => libraryDelete(deps, kind(k), str(id, "id", 200)));
  handle(NEWSROOM_IPC.exportFile, (k, json, name) => exportFile(deps, kind(k), str(json, "json", 32 * 1024 * 1024), str(name, "name", 200)));
  handle(NEWSROOM_IPC.importFile, (k) => importFile(deps, kind(k)));
  handle(NEWSROOM_IPC.fetchText, (url) => fetchText(str(url, "url")));
  handle(NEWSROOM_IPC.readTextFile, (p) => readTextFile(deps, typeof p === "string" && p ? str(p, "path") : undefined));
  handle(NEWSROOM_IPC.exportGraphics, (o) => exportGraphics(deps, o as NewsExportOptions));
}
