/**
 * `window.tatvamDesktop`, the typed bridge (docs/DESKTOP.md §5). Sandboxed preload: bundled to CommonJS with only
 * `electron` external. Every call is an ipcRenderer.invoke; every `on…` returns its unsubscribe function.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { IPC, SHELL_IPC, type AppearanceState, type DesktopNotification, type DiskStatus, type JobsSummary, type ShellState, type UiStatus, type EditorJob, type MediaItem, type OfflineStatus, type ProxyStatus, type RenderJob, type SyncStatus, type TatvamDesktop, type ToolStatus,
  type UpdateState, type UpscaleJob, type UpscaleTool } from "../shared/types.ts";
import { ASSISTANTS_IPC, type AssistantCall, type AssistantsState, type FolderPromptRequest } from "../shared/types.ts";

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
    // additive (desktop-shell): screens from the server (docs/DESKTOP.md §4.3) and the updater
    uiStatus: () => invoke(SHELL_IPC.uiStatus),
    onUiStatus: listen<UiStatus>(SHELL_IPC.uiStatusChange),
    checkUi: () => invoke(SHELL_IPC.uiCheck),
    updateState: () => invoke(SHELL_IPC.updateState),
    installUpdate: () => invoke(SHELL_IPC.updateInstall),
    releaseNotes: () => invoke(SHELL_IPC.releaseNotes),
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
    exportBatch: (file, sequenceId, items) => invoke(IPC.editorExportBatch, file, sequenceId, items),
    interpolate: (file, mediaId, opts) => invoke(IPC.editorInterpolate, file, mediaId, opts),
    transcribeLocal: (file, mediaId, opts) => invoke(IPC.editorTranscribeLocal, file, mediaId, opts),
    jobs: () => invoke(IPC.editorJobs),
    cancelJob: (id) => invoke(IPC.editorCancelJob, id),
    onJob: listen<EditorJob>(IPC.editorJob),
    onMediaUpdate: listen<{ path: string; item: MediaItem }>(IPC.editorMediaUpdate),
    versions: (file) => invoke(IPC.editorVersions, file),
    restoreVersion: (file, id) => invoke(IPC.editorRestoreVersion, file, id),
    backupNow: (file, projectId) => invoke(IPC.editorBackupNow, file, projectId),
    backupStatus: (file) => invoke(IPC.editorBackupStatus, file),
    close: (file) => invoke(IPC.editorClose, file),
    renderAudioPreview: (file, sequenceId, clipId, clip) => invoke(IPC.editorRenderAudioPreview, file, sequenceId, clipId, clip),
    impulseResponses: () => invoke(IPC.editorImpulseResponses),
    addLutFolder: () => invoke(IPC.editorAddLutFolder),
    lutFolders: () => invoke(IPC.editorLutFolders),
    removeLutFolder: (dir) => invoke(IPC.editorRemoveLutFolder, dir),
    importLutFile: (file, lut) => invoke(IPC.editorImportLutFile, file, lut),
    writeLut: (file, name, cube) => invoke(IPC.editorWriteLut, file, name, cube),
    readSidecar: (file, name) => invoke(IPC.editorReadSidecar, file, name),
    writeSidecar: (file, name, json) => invoke(IPC.editorWriteSidecar, file, name, json),
    interop: {
      exportFile: (file, sequenceId, format, outPath) => invoke(IPC.editorInteropExport, file, sequenceId, format, outPath),
      importFile: (file) => invoke(IPC.editorInteropImport, file),
      findApps: () => invoke(IPC.editorInteropFindApps),
      openIn: (app, file) => invoke(IPC.editorInteropOpenIn, app, file),
    },
  },
  tools: {
    status: () => invoke(IPC.toolsStatus),
    install: (id) => invoke(IPC.toolsInstall, id),
    remove: (id) => invoke(IPC.toolsRemove, id),
    onProgress: listen<ToolStatus>(IPC.toolsProgress),
  },
  offline: {
    status: () => invoke(IPC.offlineStatus),
    onChange: listen<OfflineStatus>(IPC.offlineChange),
    flush: () => invoke(IPC.offlineFlush),
  },
  // ── additive (desktop-shell) ──
  appearance: {
    get: () => invoke(SHELL_IPC.appearanceGet),
    set: (patch) => invoke(SHELL_IPC.appearanceSet, patch),
    onChange: listen<AppearanceState>(SHELL_IPC.appearanceChange),
  },
  shell: {
    state: () => invoke(SHELL_IPC.state),
    setPrefs: (patch) => invoke(SHELL_IPC.setPrefs, patch),
    onState: listen<ShellState>(SHELL_IPC.stateChange),
    finishOnboarding: (opts) => invoke(SHELL_IPC.finishOnboarding, opts),
    open: (page, opts) => invoke(SHELL_IPC.open, page, opts),
    popupMenu: (menu, x, y) => invoke(SHELL_IPC.popupMenu, menu, x, y),
    // File objects from a drop can't cross IPC: their real paths are read here (a page can't make up a path this way)
    dropped: (files) => invoke(SHELL_IPC.dropped, Array.from(files ?? []).map((f) => { try { return webUtils.getPathForFile(f); } catch { return ""; } }).filter(Boolean)),
    pickFolder: (title) => invoke(SHELL_IPC.pickFolder, title),
    jobs: () => invoke(SHELL_IPC.jobs),
    onJobs: listen<JobsSummary>(SHELL_IPC.jobsChange),
    disk: () => invoke(SHELL_IPC.disk),
    onDisk: listen<DiskStatus>(SHELL_IPC.diskChange),
    storage: () => invoke(SHELL_IPC.storage),
    clearStorage: (id) => invoke(SHELL_IPC.clearStorage, id),
    aiTools: () => invoke(SHELL_IPC.aiTools),
    gpu: () => invoke(SHELL_IPC.gpu),
    reset: (scope) => invoke(SHELL_IPC.reset, scope),
    recover: (reopen) => invoke(SHELL_IPC.recover, reopen),
  },
  notifications: {
    list: () => invoke(SHELL_IPC.notifList),
    onChange: listen<DesktopNotification[]>(SHELL_IPC.notifChange),
    show: (n) => invoke(SHELL_IPC.notifShow, n),
    markRead: (id) => invoke(SHELL_IPC.notifRead, id),
    clear: () => invoke(SHELL_IPC.notifClear),
    open: (id) => invoke(SHELL_IPC.notifOpen, id),
  },
  // additive (desktop-mcp): AI assistants over the local MCP server, auto edit and watch folders (docs/EDITOR.md §13)
  assistants: {
    state: () => invoke(ASSISTANTS_IPC.state),
    onState: listen<AssistantsState>(ASSISTANTS_IPC.stateChange),
    setEnabled: (on) => invoke(ASSISTANTS_IPC.setEnabled, on),
    setPort: (port) => invoke(ASSISTANTS_IPC.setPort, port),
    createToken: (name, scopes) => invoke(ASSISTANTS_IPC.createToken, name, scopes),
    revokeToken: (id) => invoke(ASSISTANTS_IPC.revokeToken, id),
    tokenValue: (id) => invoke(ASSISTANTS_IPC.tokenValue, id),
    addFolder: () => invoke(ASSISTANTS_IPC.addFolder),
    removeFolder: (folder) => invoke(ASSISTANTS_IPC.removeFolder, folder),
    activity: (limit) => invoke(ASSISTANTS_IPC.activity, limit),
    pause: (on) => invoke(ASSISTANTS_IPC.pause, on),
    stop: (sessionId) => invoke(ASSISTANTS_IPC.stop, sessionId),
    promptHost: (on) => invoke(ASSISTANTS_IPC.promptHost, on),
    onFolderPrompt: listen<FolderPromptRequest | { id: string; closed: true }>(ASSISTANTS_IPC.folderPrompt),
    answerFolderPrompt: (id, answer) => invoke(ASSISTANTS_IPC.answerFolderPrompt, id, answer),
    chooseFolder: () => invoke(ASSISTANTS_IPC.chooseFolder),
    listFolder: (folder, opts) => invoke(ASSISTANTS_IPC.listFolder, folder, opts),
    analyze: (editPath, media, kinds) => invoke(ASSISTANTS_IPC.analyze, editPath, media, kinds),
    onProgress: listen<{ task: string; done: number; total: number; current?: string }>(ASSISTANTS_IPC.progress),
    addWatch: (w) => invoke(ASSISTANTS_IPC.addWatch, w),
    updateWatch: (id, patch) => invoke(ASSISTANTS_IPC.updateWatch, id, patch),
    removeWatch: (id) => invoke(ASSISTANTS_IPC.removeWatch, id),
    attach: (file, info) => invoke(ASSISTANTS_IPC.attach, file, info),
    detach: (file) => invoke(ASSISTANTS_IPC.detach, file),
    onCall: listen<AssistantCall>(ASSISTANTS_IPC.call),
    reply: (id, r) => invoke(ASSISTANTS_IPC.reply, id, r),
    jobUpdate: (id, patch) => invoke(ASSISTANTS_IPC.jobUpdate, id, patch),
  },
};

contextBridge.exposeInMainWorld("tatvamDesktop", bridge);
