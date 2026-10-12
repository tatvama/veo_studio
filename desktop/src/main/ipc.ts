/**
 * The bridge's main-process side (docs/DESKTOP.md §5): one ipcMain.handle per method. Only frames on the gateway
 * origin may call (event.senderFrame.url is checked on every call).
 */
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import {
  IPC, RENDERER_SETTINGS, type AnalyzeKind, type DesktopSettings, type DuckingOptions, type EditBatchItem, type EditPreset, type EditProject, type InterpolateOptions,
  type PanelId, type RenderJobInput, type TimelineClip, type TranscribeOptions,
} from "../shared/types.ts";
import { isLoudnessPreset } from "./editor-audio.ts";
import { isToolId, type ToolManager } from "./tools.ts";
import type { Config } from "./config.ts";
import type { EditorManager } from "./editor.ts";
import { projectTitle, writeEdits } from "./edits.ts";
import type { FfmpegInfo } from "./ffmpeg.ts";
import type { Gateway } from "./gateway.ts";
import type { Library } from "./library.ts";
import { logsDir } from "./log.ts";
import { TOKENS } from "./naming.ts";
import type { ProxyManager } from "./proxies.ts";
import type { RenderManager } from "./render.ts";
import type { SyncManager } from "./sync.ts";
import { checkForUpdates } from "./updater.ts";
import type { Upstream } from "./upstream.ts";
import type { LocalUpscaler } from "./aiupscale.ts";
import type { ImportWatcher } from "./watch.ts";
import type { WindowManager } from "./windows.ts";

export interface AppCtx {
  config: Config;
  library: Library;
  gateway: Gateway;
  upstream: Upstream;
  sync: SyncManager;
  imports: ImportWatcher;
  proxies: ProxyManager;
  renders: RenderManager;
  upscaler: LocalUpscaler;
  editor: EditorManager;
  /** local tools (RIFE, whisper.cpp, models, Real-ESRGAN) */
  tools: ToolManager;
  windows: WindowManager;
  ff(): FfmpegInfo | null;
  probe(force?: boolean): Promise<Record<string, boolean>>;
  machineCheck(): Promise<unknown>;
  /** The native Studio server window (main/connect.ts). */
  openConnection(): void;
  log(msg: string): void;
}

export { projectTitle, writeEdits };

const int = (v: unknown, name: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
  return n;
};

export async function chooseLibraryRoot(ctx: AppCtx): Promise<string | null> {
  const parent = ctx.windows.main ?? BrowserWindow.getFocusedWindow();
  const opts: Electron.OpenDialogOptions = { title: "Choose the library folder", defaultPath: ctx.library.root(), properties: ["openDirectory", "createDirectory"] };
  const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths[0]) return null;
  ctx.library.setRoot(r.filePaths[0]);
  return r.filePaths[0];
}

export function registerIpc(ctx: AppCtx): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown) => {
    ipcMain.handle(channel, async (e: IpcMainInvokeEvent, ...args: unknown[]) => {
      const url = e.senderFrame?.url ?? "";
      if (!ctx.windows.isGatewayUrl(url)) throw new Error("Not allowed from this page");
      return fn(...args);
    });
  };
  const s = () => ctx.config.get();

  handle(IPC.info, () => ({ appVersion: app.getVersion(), serverUrl: s().serverUrl, gatewayUrl: ctx.gateway.url, libraryRoot: s().libraryRoot,
    uiSource: s().uiSource, packaged: app.isPackaged, machine: os.hostname() }));
  handle(IPC.settingsGet, () => s());
  handle(IPC.settingsSet, (patch: Partial<DesktopSettings>) => {
    const allowed = new Set<string>(RENDERER_SETTINGS);
    const blocked = Object.keys(patch ?? {}).filter((k) => !allowed.has(k));
    if (blocked.length) ctx.log(`settings.set ignored ${blocked.join(", ")}: change them in File → Studio server… or the folder dialogs`);
    return ctx.config.set(Object.fromEntries(Object.entries(patch ?? {}).filter(([k]) => allowed.has(k))) as Partial<DesktopSettings>);
  });

  handle(IPC.libChooseRoot, () => chooseLibraryRoot(ctx));
  handle(IPC.libProjectFolder, async (pid: number) => {
    const id = int(pid, "pid");
    const p = await projectTitle(ctx, id);
    return ctx.library.folderFor(id, p.title);
  });
  handle(IPC.libChooseProjectFolder, async (pid: number) => {
    const id = int(pid, "pid");
    const parent = ctx.windows.main;
    const opts: Electron.OpenDialogOptions = { title: "Move the project folder to…", defaultPath: ctx.library.folderFor(id).path, properties: ["openDirectory", "createDirectory"] };
    const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return null;
    await ctx.sync.stop(id);
    ctx.imports.setWatching(id, 0, false);
    ctx.proxies.stop(id);
    return ctx.library.move(id, r.filePaths[0]);
  });
  handle(IPC.libOpen, async (pid: number, sub?: string) => {
    const id = int(pid, "pid");
    const p = await projectTitle(ctx, id);
    const dir = ctx.library.ensure(p, s().serverUrl);
    const target = sub ? path.resolve(dir, sub) : dir;
    if (!target.toLowerCase().startsWith(path.resolve(dir).toLowerCase())) throw new Error("Outside the project folder");
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
  });
  handle(IPC.libUsage, (pid: number) => ctx.library.usage(int(pid, "pid")));
  handle(IPC.libClean, (pid: number, what: ("cache" | "proxies" | "renders")[]) => {
    const id = int(pid, "pid");
    const list = (Array.isArray(what) ? what : []).filter((w) => ["cache", "proxies", "renders"].includes(w));
    return ctx.library.clean(id, list, ctx.renders.uploadedOutputs(id));
  });

  handle(IPC.namingGet, () => s().naming);
  handle(IPC.namingSet, (t: Record<string, string>) => { ctx.config.set({ naming: t ?? {} }); });
  handle(IPC.namingPreview, (pid: number) => ctx.sync.preview(int(pid, "pid")));
  handle(IPC.namingTokens, () => TOKENS.map((t) => ({ ...t })));

  handle(IPC.syncStart, async (pid: number, opts?: { scope?: "approved" | "cut"; episodeId?: number }) => {
    const id = int(pid, "pid");
    void ctx.sync.start(id, { scope: opts?.scope ?? s().pullScope, episodeId: opts?.episodeId }).catch((e) => ctx.log(`sync: ${(e as Error).message}`));
  });
  handle(IPC.syncStop, (pid: number) => ctx.sync.stop(int(pid, "pid")));
  handle(IPC.syncStatus, (pid: number) => ctx.sync.status(int(pid, "pid")));

  handle(IPC.importsStatus, (pid: number) => ctx.imports.status(int(pid, "pid")));
  handle(IPC.importsSetWatching, async (pid: number, eid: number, on: boolean) => {
    const id = int(pid, "pid");
    const e = int(eid, "eid");
    if (on) ctx.library.ensure(await projectTitle(ctx, id), s().serverUrl);
    ctx.imports.setWatching(id, e, Boolean(on));
    const watching = { ...s().watching };
    if (on) watching[String(id)] = e;
    else delete watching[String(id)];
    ctx.config.set({ watching });
  });

  handle(IPC.machineCheck, () => ctx.machineCheck());
  handle(IPC.proxies, (pid: number, on: boolean, opts?: { all?: boolean }) => {
    const id = int(pid, "pid");
    if (on) void ctx.proxies.start(id, { all: Boolean(opts?.all) }).catch((e) => ctx.log(`proxies: ${(e as Error).message}`));
    else ctx.proxies.stop(id);
  });
  handle(IPC.proxyMode, (on: boolean) => { ctx.config.set({ proxyMode: Boolean(on) }); });
  handle(IPC.proxyStatus, (pid: number) => ctx.proxies.status(int(pid, "pid")));

  handle(IPC.renderPresets, () => ctx.renders.presets());
  handle(IPC.renderStart, (job: RenderJobInput) => {
    if (!job || typeof job.lang !== "string" || typeof job.preset !== "string") throw new Error("A render needs pid, eid, lang and preset");
    return ctx.renders.start({ ...job, pid: int(job.pid, "pid"), eid: int(job.eid, "eid") });
  });
  handle(IPC.renderCancel, (id: string) => ctx.renders.cancel(String(id)));
  handle(IPC.renderList, () => ctx.renders.list());
  handle(IPC.renderReveal, (id: string) => {
    const j = ctx.renders.get(String(id));
    if (j?.output) shell.showItemInFolder(j.output);
  });
  handle(IPC.renderUpload, (id: string) => ctx.renders.upload(String(id)));

  handle(IPC.edlWrite, (pid: number, eid: number, lang: string) => writeEdits(ctx, int(pid, "pid"), int(eid, "eid"), lang ? String(lang) : undefined));

  handle(IPC.winDisplays, () => ctx.windows.displays());
  handle(IPC.winPopOut, (panel: PanelId, opts?: { pid?: number; eid?: number; display?: number; fullscreen?: boolean; clean?: boolean }) => ctx.windows.popOut(panel, opts ?? {}));
  handle(IPC.winList, () => ctx.windows.list());
  handle(IPC.winMove, (id: number, display: number, fullscreen?: boolean) => ctx.windows.moveToDisplay(int(id, "windowId"), Number(display), fullscreen));
  handle(IPC.winClose, (id: number) => ctx.windows.close(int(id, "windowId")));
  handle(IPC.wsList, () => ctx.windows.workspaces());
  handle(IPC.wsSave, (name: string) => ctx.windows.saveWorkspace(String(name ?? "")));
  handle(IPC.wsApply, (id: string) => ctx.windows.applyWorkspace(String(id)));
  handle(IPC.wsDelete, (id: string) => ctx.windows.deleteWorkspace(String(id)));
  handle(IPC.wsExport, () => ctx.windows.exportWorkspaces());
  handle(IPC.wsImport, () => ctx.windows.importWorkspaces());

  handle(IPC.openExternal, async (url: string) => {
    const u = new URL(String(url));
    if (!["http:", "https:", "mailto:"].includes(u.protocol)) throw new Error("Only web links can be opened");
    await shell.openExternal(u.toString());
  });
  handle(IPC.revealLogs, async () => { await shell.openPath(logsDir()); });
  handle(IPC.openConnection, () => { ctx.openConnection(); });

  const upOpts = (o: { pid: number; eid: number; targetH: number; model: string; shotIds?: number[] }) => ({
    pid: int(o?.pid, "pid"), eid: int(o?.eid, "eid"), targetH: Math.min(4320, Math.max(360, int(o?.targetH, "targetH"))),
    model: o?.model === "best" ? "best" as const : "fast" as const,
    shotIds: Array.isArray(o?.shotIds) ? o.shotIds.map((x) => int(x, "shotId")) : undefined,
  });
  handle(IPC.upTool, () => ctx.upscaler.tool());
  handle(IPC.upInstall, () => ctx.upscaler.install());
  handle(IPC.upEstimate, (o) => ctx.upscaler.estimate(upOpts(o)));
  handle(IPC.upStart, (o) => ctx.upscaler.start(upOpts(o)));
  handle(IPC.upList, () => ctx.upscaler.list());
  handle(IPC.upCancel, (id: string) => ctx.upscaler.cancel(String(id)));

  handle(IPC.engineJob, (id: string) => ctx.renders.engineJob(String(id)));
  handle(IPC.engineFrame, (id: string, index: number, frame: Uint8Array | Uint16Array) => {
    // 8-bit I420 arrives as a Uint8Array, 10-bit yuv420p10le as a Uint16Array (little-endian on every PC we run on)
    if (!(frame instanceof Uint8Array) && !(frame instanceof Uint16Array)) throw new Error("A frame must be bytes");
    const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    return ctx.renders.engineFrame(String(id), int(index, "index"), bytes);
  });
  handle(IPC.engineDone, (id: string) => ctx.renders.engineDone(String(id)));
  handle(IPC.engineFail, (id: string, message: string) => ctx.renders.engineFail(String(id), String(message ?? "")));
  handle(IPC.checkUpdates, () => checkForUpdates());

  // ── Tatvam Editor (docs/EDITOR.md §5): the manager checks every edit path against its allow-list ──
  const str = (v: unknown, name: string): string => {
    if (typeof v !== "string" || !v || v.length > 4096) throw new Error(`${name} must be text`);
    return v;
  };
  const ed = () => ctx.editor;
  handle(IPC.editorList, () => ed().list());
  handle(IPC.editorCreate, (name: string, preset: EditPreset) => ed().create(str(name, "name"), preset));
  handle(IPC.editorOpen, (file?: string) => ed().open(file ? str(file, "path") : undefined));
  handle(IPC.editorSave, (file: string, project: EditProject) => {
    if (!project || typeof project !== "object") throw new Error("Nothing to save");
    return ed().save(str(file, "path"), project);
  });
  handle(IPC.editorImportMedia, (file: string, files?: string[]) => ed().importMedia(str(file, "path"),
    Array.isArray(files) ? files.filter((f) => typeof f === "string").slice(0, 2000) : undefined));
  handle(IPC.editorMediaUrl, (file: string, media: string) => ed().mediaUrl(str(file, "path"), str(media, "file")));
  handle(IPC.editorRelink, (file: string, mediaId: string) => ed().relink(str(file, "path"), str(mediaId, "mediaId")));
  handle(IPC.editorProxy, (file: string, mediaId: string) => ed().proxy(str(file, "path"), str(mediaId, "mediaId")));
  handle(IPC.editorImportEpisode, (pid: number, eid: number, file: string) => ed().importEpisode(int(pid, "pid"), int(eid, "eid"), str(file, "path")));
  const ducking = (d: unknown): boolean | DuckingOptions | undefined => {
    if (typeof d === "boolean") return d;
    if (!d || typeof d !== "object") return undefined;
    const o = d as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    return { threshold: n(o.threshold), ratio: n(o.ratio), attack: n(o.attack), release: n(o.release) };
  };
  const batchItem = (o: Partial<EditBatchItem> | undefined): EditBatchItem => ({
    preset: str(o?.preset, "preset"), range: o?.range === "inout" ? "inout" : "all", upload: Boolean(o?.upload),
    ...(typeof o?.sequenceId === "string" && o.sequenceId ? { sequenceId: o.sequenceId.slice(0, 200) } : {}),
    ...(typeof o?.name === "string" && o.name.trim() ? { name: o.name.slice(0, 100) } : {}),
    ...(o?.loudness !== undefined ? { loudness: isLoudnessPreset(o.loudness) ? o.loudness : (() => { throw new Error("Unknown loudness target"); })() } : {}),
    ...(o?.ducking !== undefined ? { ducking: ducking(o.ducking) } : {}),
  });
  handle(IPC.editorExport, (file: string, sequenceId: string, opts: Partial<EditBatchItem>) => {
    const o = batchItem(opts);
    delete o.sequenceId;
    return ed().export(str(file, "path"), str(sequenceId, "sequenceId"), { ...o, range: o.range ?? "all" });
  });
  handle(IPC.editorExportBatch, (file: string, sequenceId: string, items: Partial<EditBatchItem>[]) => {
    if (!Array.isArray(items)) throw new Error("A batch is a list of exports");
    return ed().exportBatch(str(file, "path"), str(sequenceId, "sequenceId"), items.slice(0, 24).map(batchItem));
  });
  handle(IPC.editorImportLut, (file: string) => ed().importLut(str(file, "path")));
  handle(IPC.editorImportShader, (file: string, kind: "transition" | "effect") => ed().importShader(str(file, "path"), kind === "effect" ? "effect" : "transition"));
  handle(IPC.editorShaders, () => ed().shaders());
  handle(IPC.editorAnalyze, (file: string, mediaId: string, kind: AnalyzeKind, opts?: Record<string, unknown>) => {
    if (!["silence", "scenes", "beats", "loudness", "sync"].includes(kind)) throw new Error("Unknown analysis");
    const o = opts && typeof opts === "object" ? opts : {};
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    return ed().analyze(str(file, "path"), str(mediaId, "mediaId"), kind, { noiseDb: n(o.noiseDb), minMs: n(o.minMs), threshold: n(o.threshold),
      maxOffset: n(o.maxOffset), in: n(o.in), out: n(o.out), ...(typeof o.against === "string" && o.against ? { against: o.against.slice(0, 200) } : {}) });
  });
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const jobId = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(v) ? v : undefined);
  handle(IPC.editorInterpolate, (file: string, mediaId: string, opts?: InterpolateOptions) => {
    const o = (opts && typeof opts === "object" ? opts : {}) as InterpolateOptions;
    const factor = [2, 4, 8].includes(Number(o.factor)) ? (Number(o.factor) as 2 | 4 | 8) : undefined;
    return ed().interpolate(str(file, "path"), str(mediaId, "mediaId"), { factor, fps: num(o.fps), in: num(o.in), out: num(o.out),
      model: typeof o.model === "string" ? o.model : undefined, dropAudio: Boolean(o.dropAudio), jobId: jobId(o.jobId) });
  });
  handle(IPC.editorTranscribeLocal, (file: string, mediaId: string, opts: TranscribeOptions) => {
    const o = (opts && typeof opts === "object" ? opts : {}) as TranscribeOptions;
    return ed().transcribeLocal(str(file, "path"), str(mediaId, "mediaId"), { language: typeof o.language === "string" ? o.language : "auto",
      model: o.model, cuda: typeof o.cuda === "boolean" ? o.cuda : undefined, in: num(o.in), out: num(o.out), translate: Boolean(o.translate),
      prompt: typeof o.prompt === "string" ? o.prompt.slice(0, 600) : undefined, jobId: jobId(o.jobId) });
  });
  handle(IPC.editorJobs, () => ed().jobList());
  handle(IPC.editorCancelJob, (id: string) => ed().cancelJob(str(id, "id")));
  handle(IPC.editorVersions, (file: string) => ed().versions(str(file, "path")));
  handle(IPC.editorRestoreVersion, (file: string, id: string) => ed().restoreVersion(str(file, "path"), str(id, "id")));
  handle(IPC.editorBackupNow, (file: string, projectId?: number) => ed().backupNow(str(file, "path"),
    projectId === undefined || projectId === null ? undefined : int(projectId, "projectId")));
  handle(IPC.editorBackupStatus, (file: string) => ed().backupStatus(str(file, "path")));
  handle(IPC.editorClose, (file: string) => ed().close(str(file, "path")));
  handle(IPC.editorRenderAudioPreview, (file: string, sequenceId: string, clipId: string, clip?: TimelineClip) =>
    ed().renderAudioPreview(str(file, "path"), str(sequenceId, "sequenceId"), str(clipId, "clipId"), clip && typeof clip === "object" ? clip : undefined));
  handle(IPC.editorImpulseResponses, () => ed().impulseResponses());
  handle(IPC.editorAddLutFolder, () => ed().addLutFolder());
  handle(IPC.editorLutFolders, () => ed().lutFolders());
  handle(IPC.editorRemoveLutFolder, (dir: string) => ed().removeLutFolder(str(dir, "path")));
  handle(IPC.editorImportLutFile, (file: string, lut: string) => ed().importLutFile(str(file, "path"), str(lut, "file")));
  handle(IPC.editorWriteLut, (file: string, name: string, cube: string) => {
    if (typeof cube !== "string") throw new Error("A LUT is text");
    return ed().writeLut(str(file, "path"), typeof name === "string" ? name.slice(0, 200) : "lut", cube);
  });
  handle(IPC.editorReadSidecar, (file: string, name: string) => ed().readSidecar(str(file, "path"), str(name, "name")));
  handle(IPC.editorWriteSidecar, (file: string, name: string, json: unknown) => ed().writeSidecar(str(file, "path"), str(name, "name"), json));

  handle(IPC.toolsStatus, () => ctx.tools.status());
  handle(IPC.toolsInstall, (id: string) => {
    if (!isToolId(id)) throw new Error("Unknown tool");
    return ctx.tools.install(id);
  });
  handle(IPC.toolsRemove, (id: string) => {
    if (!isToolId(id)) throw new Error("Unknown tool");
    return ctx.tools.remove(id);
  });
  handle(IPC.editorUploadAsset, (file: string, mediaId: string, projectId: number) => ed().uploadAsset(str(file, "path"), str(mediaId, "mediaId"), int(projectId, "projectId")));
  handle(IPC.editorImportStudioAsset, (file: string, key: string, name?: string) => ed().importStudioAsset(str(file, "path"), str(key, "key"),
    typeof name === "string" && name ? name.slice(0, 200) : undefined));

  handle(IPC.offlineStatus, () => ctx.gateway.status());
  handle(IPC.offlineFlush, () => ctx.gateway.flush());
}
