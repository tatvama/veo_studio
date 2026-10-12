/**
 * `window.tatvamDesktop`, the typed bridge (docs/DESKTOP.md §5). Sandboxed preload: bundled to CommonJS with only
 * `electron` external. Every call is an ipcRenderer.invoke; every `on…` returns its unsubscribe function.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { IPC, type OfflineStatus, type ProxyStatus, type RenderJob, type SyncStatus, type TatvamDesktop, type UpdateState, type UpscaleJob,
  type UpscaleTool } from "../shared/types.ts";

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (e) {
    // "Error invoking remote method 'x': Error: message" → "message"
    const msg = String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, "");
    throw new Error(msg);
  }
}

function listen<T>(channel: string) {
  return (cb: (value: T) => void): (() => void) => {
    const l = (_e: IpcRendererEvent, value: T) => cb(value);
    ipcRenderer.on(channel, l);
    return () => { ipcRenderer.removeListener(channel, l); };
  };
}

const bridge: TatvamDesktop = {
  version: __APP_VERSION__,
  platform: process.platform,
  info: () => invoke(IPC.info),
  settings: {
    get: () => invoke(IPC.settingsGet),
    set: (patch) => invoke(IPC.settingsSet, patch),
  },
  library: {
    chooseRoot: () => invoke(IPC.libChooseRoot),
    projectFolder: (pid) => invoke(IPC.libProjectFolder, pid),
    chooseProjectFolder: (pid) => invoke(IPC.libChooseProjectFolder, pid),
    open: (pid, sub) => invoke(IPC.libOpen, pid, sub),
    usage: (pid) => invoke(IPC.libUsage, pid),
    clean: (pid, what) => invoke(IPC.libClean, pid, what),
  },
  naming: {
    get: () => invoke(IPC.namingGet),
    set: (t) => invoke(IPC.namingSet, t),
    preview: (pid) => invoke(IPC.namingPreview, pid),
    tokens: () => invoke(IPC.namingTokens),
  },
  sync: {
    start: (pid, opts) => invoke(IPC.syncStart, pid, opts),
    stop: (pid) => invoke(IPC.syncStop, pid),
    status: (pid) => invoke(IPC.syncStatus, pid),
    onProgress: listen<SyncStatus>(IPC.syncProgress),
  },
  imports: {
    status: (pid) => invoke(IPC.importsStatus, pid),
    setWatching: (pid, eid, on) => invoke(IPC.importsSetWatching, pid, eid, on),
  },
  media: {
    machineCheck: () => invoke(IPC.machineCheck),
    proxies: (pid, on) => invoke(IPC.proxies, pid, on),
    proxyMode: (on) => invoke(IPC.proxyMode, on),
    proxyStatus: (pid) => invoke(IPC.proxyStatus, pid),
    onProxyProgress: listen<ProxyStatus>(IPC.proxyProgress),
  },
  render: {
    presets: () => invoke(IPC.renderPresets),
    start: (job) => invoke(IPC.renderStart, job),
    cancel: (id) => invoke(IPC.renderCancel, id),
    list: () => invoke(IPC.renderList),
    onProgress: listen<RenderJob>(IPC.renderProgress),
    reveal: (id) => invoke(IPC.renderReveal, id),
    upload: (id) => invoke(IPC.renderUpload, id),
  },
  edl: { write: (pid, eid, lang) => invoke(IPC.edlWrite, pid, eid, lang) },
  windows: {
    displays: () => invoke(IPC.winDisplays),
    popOut: (panel, opts) => invoke(IPC.winPopOut, panel, opts),
    list: () => invoke(IPC.winList),
    moveToDisplay: (windowId, display, fullscreen) => invoke(IPC.winMove, windowId, display, fullscreen),
    close: (windowId) => invoke(IPC.winClose, windowId),
    workspaces: () => invoke(IPC.wsList),
    saveWorkspace: (name) => invoke(IPC.wsSave, name),
    applyWorkspace: (id) => invoke(IPC.wsApply, id),
    deleteWorkspace: (id) => invoke(IPC.wsDelete, id),
    exportWorkspaces: () => invoke(IPC.wsExport),
    importWorkspaces: () => invoke(IPC.wsImport),
  },
  app: {
    openExternal: (url) => invoke(IPC.openExternal, url),
    revealLogs: () => invoke(IPC.revealLogs),
    checkForUpdates: () => invoke(IPC.checkUpdates),
    openConnection: () => invoke(IPC.openConnection),
    onUpdate: listen<UpdateState>(IPC.update),
    onMenu: listen<string>(IPC.menu),
  },
  upscale: {
    tool: () => invoke(IPC.upTool),
    install: () => invoke(IPC.upInstall),
    onTool: listen<UpscaleTool>(IPC.upToolChange),
    estimate: (opts) => invoke(IPC.upEstimate, opts),
    start: (opts) => invoke(IPC.upStart, opts),
    list: () => invoke(IPC.upList),
    cancel: (id) => invoke(IPC.upCancel, id),
    onProgress: listen<UpscaleJob>(IPC.upProgress),
  },
  engine: {
    job: (id) => invoke(IPC.engineJob, id),
    frame: (id, index, bytes) => invoke(IPC.engineFrame, id, index, bytes),
    done: (id) => invoke(IPC.engineDone, id),
    fail: (id, message) => invoke(IPC.engineFail, id, message),
  },
  editor: {
    list: () => invoke(IPC.editorList),
    create: (name, preset) => invoke(IPC.editorCreate, name, preset),
    open: (file) => invoke(IPC.editorOpen, file),
    save: (file, project) => invoke(IPC.editorSave, file, project),
    importMedia: (file, files) => invoke(IPC.editorImportMedia, file, files),
    // runs here, synchronously: File objects from a drop can't cross IPC, their paths can
    pathsForDrop: (files) => Array.from(files ?? []).map((f) => { try { return webUtils.getPathForFile(f); } catch { return ""; } }).filter(Boolean),
    mediaUrl: (file, media) => invoke(IPC.editorMediaUrl, file, media),
    relink: (file, mediaId) => invoke(IPC.editorRelink, file, mediaId),
    proxy: (file, mediaId) => invoke(IPC.editorProxy, file, mediaId),
    importEpisode: (pid, eid, file) => invoke(IPC.editorImportEpisode, pid, eid, file),
    export: (file, sequenceId, opts) => invoke(IPC.editorExport, file, sequenceId, opts),
    importLut: (file) => invoke(IPC.editorImportLut, file),
    importShader: (file, kind) => invoke(IPC.editorImportShader, file, kind),
    shaders: () => invoke(IPC.editorShaders),
    analyze: (file, mediaId, kind, opts) => invoke(IPC.editorAnalyze, file, mediaId, kind, opts),
    uploadAsset: (file, mediaId, projectId) => invoke(IPC.editorUploadAsset, file, mediaId, projectId),
    importStudioAsset: (file, key, name) => invoke(IPC.editorImportStudioAsset, file, key, name),
  },
  offline: {
    status: () => invoke(IPC.offlineStatus),
    onChange: listen<OfflineStatus>(IPC.offlineChange),
    flush: () => invoke(IPC.offlineFlush),
  },
};

contextBridge.exposeInMainWorld("tatvamDesktop", bridge);
