/**
 * Tatvam Studio desktop: lifecycle, single instance, the tatvam:// deep link and the wiring of every module.
 * Start order: logging → settings → library → gateway → windows → menu → updater.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, crashReporter, dialog, ipcMain, screen, session, shell } from "electron";
import { IPC } from "../shared/types.ts";
import { LocalUpscaler } from "./aiupscale.ts";
import { Config } from "./config.ts";
import { openConnectionWindow, registerConnectIpc, type ConnectDeps } from "./connect.ts";
import { EditorManager } from "./editor.ts";
import { InteropManager, registerInteropIpc } from "./editor-interop.ts";
import { editorDeepLink } from "./editor-model.ts";
import { locateFfmpeg, machineCheck, probeHardware, type FfmpegInfo } from "./ffmpeg.ts";
import { Gateway } from "./gateway.ts";
import { chooseLibraryRoot, projectTitle, registerIpc, writeEdits, type AppCtx } from "./ipc.ts";
import { Library } from "./library.ts";
import { initLog, logsDir } from "./log.ts";
import { buildMenu } from "./menu.ts";
import { ProxyManager } from "./proxies.ts";
import { RenderManager } from "./render.ts";
import { googleSignIn } from "./signin.ts";
import { DesktopShell } from "./shell.ts";
import { Splash } from "./shell-splash.ts";
import { runSmoke } from "./smoke.ts";
import { SyncManager } from "./sync.ts";
import { ToolManager } from "./tools.ts";
import { UiCache } from "./uicache.ts";
import { checkForUpdates, initUpdater } from "./updater.ts";
import { COOKIE, Upstream } from "./upstream.ts";
import { ImportWatcher } from "./watch.ts";
import { WindowManager } from "./windows.ts";
import { Assistants } from "./mcp/index.ts";
import { isRelayRun, relayViaNode } from "./mcp/stdio.ts";

if (process.env.TATVAM_USER_DATA) app.setPath("userData", process.env.TATVAM_USER_DATA);
// laptops with two GPUs: the GPU engine and WebCodecs run on the dedicated card, not the built-in one
if (process.env.TATVAM_INTEGRATED_GPU !== "1") app.commandLine.appendSwitch("force_high_performance_gpu");
crashReporter.start({ uploadToServer: false, compress: true });
const userData = app.getPath("userData");
initLog(userData);
const log = (m: string) => console.log(m);
const smoke = process.env.TATVAM_SMOKE === "1";
// desktop-mcp (docs/EDITOR.md §13.1): `--mcp-stdio` relays an MCP app's stdio to the local server; no lock, no windows
const mcpStdio = isRelayRun(process.argv);
if (mcpStdio) {
  app.disableHardwareAcceleration();
  app.setPath("sessionData", path.join(app.getPath("temp"), "tatvam-mcp-relay")); // the running app holds the caches in userData
  relayViaNode({ execPath: process.execPath, script: path.join(__dirname, "mcp-relay.cjs"), userData, appArgs: app.isPackaged ? [] : [app.getAppPath()],
    env: process.env, exit: (code) => app.exit(code) });
}

/** tatvam://open?project=12&episode=3 → /p/12/finish?episode=3; tatvam://editor?path=… → /editor/edit?path=… */
export function deepLinkPath(url: string): string | null {
  const ed = editorDeepLink(url);
  if (ed) {
    if (ed.file) editorRef?.allowEditFile(ed.file); // the link hands this edit over: the page may open it
    return ed.urlPath;
  }
  try {
    const u = new URL(url);
    if (u.protocol !== "tatvam:") return null;
    const action = (u.hostname || u.pathname.replace(/^\/+/, "")).toLowerCase();
    const pid = u.searchParams.get("project");
    if (action !== "open" || !pid || !/^\d+$/.test(pid)) return "/";
    const eid = u.searchParams.get("episode");
    return `/p/${pid}/finish${eid && /^\d+$/.test(eid) ? `?episode=${eid}` : ""}`;
  } catch {
    return null;
  }
}

function uiDir(): string | null {
  const cands = [process.env.TATVAM_UI_DIR, path.join(process.resourcesPath || "", "web"), path.join(app.getAppPath(), "..", "frontend", "dist")];
  for (const c of cands) if (c && existsSync(path.join(c, "index.html"))) return c;
  return null;
}

let ctx: AppCtx | null = null;
let editorRef: EditorManager | null = null;
let shellRef: DesktopShell | null = null; // the desktop shell (main/shell.ts): appearance, notifications, taskbar, tray, start
let pendingLink = process.argv.find((a) => a.startsWith("tatvam://")) ?? null;

if (mcpStdio) {
  // the relay runs on its own (mcp/stdio.ts) and exits when stdin closes
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (app.isPackaged && !smoke) app.setAsDefaultProtocolClient("tatvam"); // the dev build and smoke runs never claim the protocol
  app.on("second-instance", (_e, argv) => {
    const link = argv.find((a) => a.startsWith("tatvam://"));
    if (link && shellRef?.handleLink(link)) return; // Jump List tasks (tatvam://shell?action=…)
    const w = ctx?.windows.main;
    if (link && ctx) ctx.windows.navigateMain(deepLinkPath(link) ?? "/");
    else if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
  app.on("open-url", (e, url) => { // macOS
    e.preventDefault();
    if (ctx) ctx.windows.navigateMain(deepLinkPath(url) ?? "/");
    else pendingLink = url;
  });
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(start).catch((e) => {
    console.error("start failed", e);
    dialog.showErrorBox("Tatvam Studio couldn't start", String((e as Error).stack || e));
    app.exit(1);
  });
}

async function start(): Promise<void> {
  DesktopShell.early(app.isPackaged);
  const splash = smoke ? null : new Splash(app.getVersion());
  splash?.step("Reading settings…", 10);
  const config = new Config(userData, app.getPath("documents"));
  const library = new Library(config, userData, log);
  library.appVersion = app.getVersion();
  const dir = uiDir();
  if (!dir) log("No built UI found (TATVAM_UI_DIR, resources/web, ../frontend/dist): the gateway forwards the UI to the server");

  // screens from the server, with an offline copy (docs/DESKTOP.md §4.3)
  const uiCache = new UiCache({ root: path.join(userData, "ui-cache"), appVersion: app.getVersion(), serverUrl: () => config.get().serverUrl,
    setting: () => config.get().uiSource, bundledDir: () => dir, envOverride: Boolean(process.env.TATVAM_UI_DIR), log,
    onStatus: (s) => shellRef?.onUiStatus(s) });
  splash?.step("Checking the offline screens…", 25);
  await uiCache.init();

  let gatewayRef: Gateway | null = null;
  const cookie = async (): Promise<string | undefined> => {
    if (!gatewayRef) return undefined;
    const [c] = await session.defaultSession.cookies.get({ url: gatewayRef.url, name: COOKIE });
    return c ? `${COOKIE}=${c.value}` : undefined;
  };
  let windows: WindowManager | null = null;
  const gateway = new Gateway({
    upstream: () => config.get().serverUrl,
    uiDir: () => dir,
    uiSource: () => config.get().uiSource,
    uiDirs: () => uiCache.dirs(),
    resolveMedia: (key) => library.resolveKey(key),
    resolveEditorMedia: (id) => editorRef?.resolve(id) ?? null,
    resolveImpulse: (name) => editorRef?.impulseFile(name) ?? Promise.resolve(null),
    store: library,
    getCookie: cookie,
    onStatus: (s) => { windows?.broadcast(IPC.offlineChange, s); shellRef?.onOffline(s); },
    log,
  });
  gatewayRef = gateway;
  const port = await gateway.listen(config.get().gatewayPort);
  if (port !== config.get().gatewayPort) config.set({ gatewayPort: port }); // keep the origin (and its localStorage) stable next time
  log(`gateway on ${gateway.url} → ${config.get().serverUrl}${dir ? ` (UI from ${dir})` : ""}`);
  splash?.step("Starting the local gateway…", 45);

  const upstream = new Upstream({ serverUrl: () => config.get().serverUrl, cookie, log });

  let ffInfo: FfmpegInfo | null | undefined;
  let ffFor = "";
  const ff = () => {
    const want = config.get().ffmpegPath;
    if (ffInfo === undefined || ffFor !== want) {
      ffInfo = locateFfmpeg({ configured: want || undefined, resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
        appPath: app.getAppPath(), packaged: app.isPackaged });
      ffFor = want;
      log(ffInfo ? `FFmpeg ${ffInfo.version} (${ffInfo.source}): ${ffInfo.path}` : "FFmpeg not found");
    }
    return ffInfo;
  };
  let probing: Promise<Record<string, boolean>> | null = null;
  let probedFor = "";
  const probe = (force = false) => {
    const f = ff();
    if (!f) return Promise.resolve({} as Record<string, boolean>);
    if (!probing || force || probedFor !== f.path) {
      probedFor = f.path;
      probing = probeHardware(f.path, path.join(userData, "hw-probe.json"), force).then((r) => {
        log(`encoders: ${Object.entries(r).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
        return r;
      });
    }
    return probing;
  };

  windows = new WindowManager({
    config, gatewayUrl: () => gateway.url, preload: path.join(__dirname, "preload.cjs"), isPackaged: app.isPackaged, log,
    signIn: (parent) => void googleSignIn(parent, config.get().serverUrl, gateway.url, log),
    chrome: (k) => shellRef?.chrome(k) ?? {}, onWindow: (w, k) => shellRef?.onWindow(w, k), boundsFor: (k) => shellRef?.boundsFor(k),
    saveBounds: (k, e) => shellRef?.saveBounds(k, e), reduceMotion: () => shellRef?.reduceMotion() ?? false, onMainClose: (w) => shellRef?.onMainClose(w) ?? false,
    allowEditFile: (f) => editorRef?.allowEditFile(f),
  });
  const wm = windows;
  const connectDeps: ConnectDeps = { config, gatewayUrl: () => gateway.url, appVersion: app.getVersion(),
    preload: path.join(__dirname, "connect-preload.cjs"), ff, main: () => wm.main, log,
    uiStatus: () => uiCache.status(), checkUi: () => void uiCache.check("settings") };
  registerConnectIpc(connectDeps);
  const appCtx: AppCtx = {
    config, library, gateway, upstream, windows: wm, ff, probe, log,
    openConnection: () => void openConnectionWindow(connectDeps, wm.main),
    sync: undefined as never, imports: undefined as never, proxies: undefined as never, renders: undefined as never, upscaler: undefined as never,
    editor: undefined as never, tools: undefined as never,
    machineCheck: async () => machineCheck({ ffmpeg: ff(), encoders: await probe(), libraryRoot: config.get().libraryRoot,
      gpuInfo: await app.getGPUInfo("complete").catch(() => undefined),
      displays: wm.displays().map((d) => ({ id: d.id, label: d.label, width: d.bounds.width, height: d.bounds.height, scaleFactor: d.scaleFactor, primary: d.primary })) }),
  };
  appCtx.sync = new SyncManager({
    library, upstream, templates: () => config.get().naming, serverUrl: () => config.get().serverUrl, autoSync: () => config.get().autoSync,
    broadcast: (s) => { wm.broadcast(IPC.syncProgress, s); shellRef?.onSync(s); }, writeEdits: (pid, eid) => writeEdits(appCtx, pid, eid), log,
  });
  appCtx.imports = new ImportWatcher({ library, upstream, template: () => config.get().naming.Imports, log });
  appCtx.proxies = new ProxyManager({ library, ff, probe: () => probe(), broadcast: (s) => wm.broadcast(IPC.proxyProgress, s), log });
  appCtx.renders = new RenderManager({ upstream, library, ff, probe: () => probe(), settings: () => config.get(),
    jobsFile: path.join(userData, "renders.json"), broadcast: (j) => { wm.broadcast(IPC.renderProgress, j); shellRef?.onRender(j); }, log,
    openRenderWindow: (urlPath, onClosed) => wm.openRenderWindow(urlPath, onClosed) });
  appCtx.tools = new ToolManager({ userData, log,
    broadcast: (t) => {
      wm.broadcast(IPC.toolsProgress, t);
      shellRef?.onTool(t);
      if (t.id === "realesrgan") void appCtx.upscaler?.tool().then((u) => wm.broadcast(IPC.upToolChange, u)).catch(() => undefined);
    } });
  appCtx.upscaler = new LocalUpscaler({ library, upstream, ff, probe: () => probe(), userData, machine: os.hostname(),
    prefer: () => config.get().encoder.prefer, broadcast: (j) => { wm.broadcast(IPC.upProgress, j); shellRef?.onUpscale(j); },
    broadcastTool: (t) => wm.broadcast(IPC.upToolChange, t), tools: appCtx.tools, log });
  appCtx.editor = new EditorManager({
    libraryRoot: () => config.get().libraryRoot, userData, upstream, localKey: (k) => library.resolveKeyOriginal(k), ff, probeHw: () => probe(),
    renders: appCtx.renders, log, localTools: appCtx.tools,
    onJob: (j) => { wm.broadcast(IPC.editorJob, j); shellRef?.onEditorJob(j); },
    onMediaUpdate: (u) => wm.broadcast(IPC.editorMediaUpdate, u),
    backupSettings: () => config.get().editorBackups,
    signedIn: async () => Boolean(await cookie()),
    prefer: () => config.get().encoder.prefer,
    lutFolders: () => config.get().lutFolders,
    setLutFolders: (list) => { config.set({ lutFolders: list }); },
    dialogs: {
      openFolder: async (o) => {
        const parent = BrowserWindow.getFocusedWindow() ?? wm.main;
        const opts: Electron.OpenDialogOptions = { title: o.title, defaultPath: o.defaultPath, properties: ["openDirectory"] };
        const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
        return r.canceled ? null : r.filePaths[0] ?? null;
      },
      openFiles: async (o) => {
        const parent = BrowserWindow.getFocusedWindow() ?? wm.main;
        const opts: Electron.OpenDialogOptions = { title: o.title, filters: o.filters, defaultPath: o.defaultPath,
          properties: o.multi ? ["openFile", "multiSelections"] : ["openFile"] };
        const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
        return r.canceled ? [] : r.filePaths;
      },
    },
  });
  editorRef = appCtx.editor;
  appCtx.editor.startAutoBackups();
  ctx = appCtx;
  registerIpc(appCtx);
  // AI assistants over the local MCP server, auto edit and watch folders (main/mcp, docs/EDITOR.md §13)
  const assistants = new Assistants({ config, editor: appCtx.editor, renders: appCtx.renders, windows: wm, tools: appCtx.tools, ff, userData,
    version: app.getVersion(), log });
  assistants.registerIpc();
  void assistants.apply();
  shellRef = new DesktopShell({ ctx: () => appCtx, userData, appVersion: app.getVersion(), packaged: app.isPackaged, smoke, uiCache, bundledDir: () => dir, log });
  shellRef.registerIpc();
  const desk = shellRef;
  // Premiere Pro / Audition / EDL / OTIO interchange (main/editor-interop.ts, docs/EDITOR.md §12)
  const pickParent = () => BrowserWindow.getFocusedWindow() ?? wm.main;
  const interop = new InteropManager({
    editor: appCtx.editor, ff, log, reveal: (f) => shell.showItemInFolder(f),
    dialogs: {
      openFiles: async (o) => {
        const parent = pickParent();
        const opts: Electron.OpenDialogOptions = { title: o.title, filters: o.filters, defaultPath: o.defaultPath, properties: ["openFile"] };
        const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
        return r.canceled ? [] : r.filePaths;
      },
      saveFile: async (o) => {
        const parent = pickParent();
        const opts: Electron.SaveDialogOptions = { title: o.title, defaultPath: o.defaultPath, filters: o.filters };
        const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
        return r.canceled || !r.filePath ? null : r.filePath;
      },
    },
  });
  registerInteropIpc(ipcMain, (url) => wm.isGatewayUrl(url), interop,
    { export: IPC.editorInteropExport, import: IPC.editorInteropImport, findApps: IPC.editorInteropFindApps, openIn: IPC.editorInteropOpenIn });

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(wm.isGatewayUrl(wc.getURL()) && ["fullscreen", "clipboard-sanitized-write", "clipboard-read", "media", "notifications", "window-management",
      "pointerLock"].includes(permission));
  });

  const rebuildMenu = () => buildMenu({
    isPackaged: app.isPackaged,
    proxyMode: () => config.get().proxyMode,
    setProxyMode: (on) => config.set({ proxyMode: on }),
    workspaces: () => wm.workspaces(),
    applyWorkspace: (id) => { try { wm.applyWorkspace(id); } catch (e) { log(`workspace: ${(e as Error).message}`); } },
    popOut: (panel) => { wm.popOut(panel); },
    programToNextDisplay: () => wm.programToNextDisplay(),
    closeAllPanels: () => wm.closeAllPanels(),
    openProjectFolder: () => {
      const pid = wm.context().pid;
      if (pid === undefined) { void shell.openPath(library.root()); return; }
      void projectTitle(appCtx, pid).then((p) => shell.openPath(library.ensure(p, config.get().serverUrl)));
    },
    chooseLibrary: () => void chooseLibraryRoot(appCtx),
    openConnection: () => appCtx.openConnection(),
    syncNow: () => {
      const pid = wm.context().pid;
      if (pid === undefined) wm.sendToMain(IPC.menu, "sync-now");
      else void appCtx.sync.start(pid, { scope: config.get().pullScope }).catch((e) => log(`sync: ${(e as Error).message}`));
    },
    sendMenu: (action) => wm.sendToMain(IPC.menu, action),
    revealLogs: () => void shell.openPath(logsDir()),
    checkForUpdates: () => void checkForUpdates(),
    shell: { openSettings: (section) => { wm.openPage("settings", { section }); }, openStart: () => { wm.openPage("start"); },
      openWelcome: () => { wm.openPage("welcome"); }, uiScale: (step) => desk.uiScale(step) },
  });
  rebuildMenu();
  config.onChange((s, prev) => {
    if (s.proxyMode !== prev.proxyMode || JSON.stringify(s.workspaces.map((w) => [w.id, w.name])) !== JSON.stringify(prev.workspaces.map((w) => [w.id, w.name]))) rebuildMenu();
  });
  for (const ev of ["display-added", "display-removed", "display-metrics-changed"] as const) {
    screen.on(ev as "display-added", () => wm.onDisplaysChanged());
  }

  splash?.step("Opening the window…", 80);
  const shellLink = pendingLink && /^tatvam:\/\/shell/i.test(pendingLink) ? pendingLink : null;
  const main = wm.createMain(pendingLink && !shellLink ? deepLinkPath(pendingLink) ?? "/" : desk.initialUrl());
  if (shellLink) desk.handleLink(shellLink);
  pendingLink = null;
  main.once("ready-to-show", () => splash?.close());
  setTimeout(() => splash?.close(), 20_000).unref?.();
  for (const [pid, eid] of Object.entries(config.get().watching)) {
    if (library.folderFor(Number(pid)).exists) appCtx.imports.setWatching(Number(pid), eid, true);
  }
  void initUpdater((u) => { wm.broadcast(IPC.update, u); desk.onUpdate(u); }, log);
  if (!smoke) { void uiCache.check("start"); uiCache.start(); }
  desk.afterStart();
  setTimeout(() => void probe(), smoke ? 0 : 4000).unref?.();
  if (smoke) void runSmoke(appCtx, main);

  let quitting = false;
  app.on("before-quit", (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    appCtx.sync.stopAll();
    appCtx.imports.stopAll();
    appCtx.proxies.stopAll();
    appCtx.renders.cancelAll();
    appCtx.upscaler.stopAll();
    appCtx.editor.stopAll();
    void assistants.stopAll();
    void gateway.close().catch(() => undefined).finally(() => {
      library.closeAll();
      app.exit(0);
    });
    setTimeout(() => app.exit(0), 3000).unref?.();
  });
}
