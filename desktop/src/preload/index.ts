/**
 * `window.tatvamDesktop`, the typed bridge (docs/DESKTOP.md §5). Sandboxed preload: bundled to CommonJS with only
 * `electron` external. Every call is an ipcRenderer.invoke; every `on…` returns its unsubscribe function.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type OfflineStatus, type ProxyStatus, type RenderJob, type SyncStatus, type TatvamDesktop, type UpdateState } from "../shared/types.ts";

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
  offline: {
    status: () => invoke(IPC.offlineStatus),
    onChange: listen<OfflineStatus>(IPC.offlineChange),
    flush: () => invoke(IPC.offlineFlush),
  },
};

contextBridge.exposeInMainWorld("tatvamDesktop", bridge);
