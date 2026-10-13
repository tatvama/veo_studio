/**
 * The desktop shell: the parts of Tatvam Desktop that apply to every window (docs/DESKTOP.md §4.3 and the shell notes).
 *  - appearance (theme, accent, density, scale, motion, contrast, Mica) applied live to every window,
 *  - the Windows 11 chrome: a custom title bar over the system window buttons (titleBarOverlay), Mica / acrylic,
 *  - the screens' status (main/uicache.ts) and the update state for the title bar and the status bar,
 *  - notifications (main/notify.ts), the job queue with the taskbar (main/taskbar.ts) and the tray (main/tray.ts),
 *  - Start, Settings and the first-run steps, drops from Explorer, storage and disk space, crash recovery,
 * and the bridge groups `app.uiStatus…`, `appearance`, `shell` and `notifications` (preload/index.ts).
 */
import { existsSync, promises as fsp, readdirSync, readFileSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, session, shell as eshell, systemPreferences,
  type BrowserWindowConstructorOptions, type IpcMainInvokeEvent, type NativeImage,
} from "electron";
import {
  SHELL_IPC, type AppearanceSettings, type AppearanceState, type DiskDrive, type DiskStatus, type DropEntry, type EditorJob, type GpuSummary,
  type NotificationTarget, type OfflineStatus, type ReleaseNotes, type RenderJob, type ShellPrefs, type StorageItem, type SyncStatus, type ToolStatus,
  type UiStatus, type UpdateState, type UpscaleJob, type WindowStateEntry,
} from "../shared/types.ts";
import { DEFAULT_APPEARANCE, defaultSettings, sanitizeAppearance } from "./config.ts";
import { AUDIO_EXTS, IMAGE_EXTS, mediaKindOf, VIDEO_EXTS } from "./editor-model.ts";
import type { AppCtx } from "./ipc.ts";
import { logsDir } from "./log.ts";
import { NotificationCenter, setNotificationCenter, type NotifyInput } from "./notify.ts";
import { accentHex, appearanceState, chromeCss, GROUND, overlayFor } from "./shell-appearance.ts";
import { JobTracker, type JobEvent } from "./shell-jobs.ts";
import { boundsVisible, changelogSection, DEFAULT_PREFS, displaySignature, ShellStore } from "./shell-state.ts";
import { Taskbar } from "./taskbar.ts";
import { TOOLS } from "./tools.ts";
import { TrayIcon } from "./tray.ts";
import type { UiCache } from "./uicache.ts";
import { installNow, setAutoInstallOnQuit, updateState } from "./updater.ts";
import type { WindowKind } from "./windows.ts";

export const LOW_DISK_BYTES = 15 * 1024 ** 3;
const TIMELINE_EXTS = ["xml", "fcpxml", "edl", "otio"];
const EDIT_EXT = "tatvamedit";

export interface ShellDeps {
  ctx: () => AppCtx;
  userData: string;
  appVersion: string;
  packaged: boolean;
  smoke: boolean;
  uiCache: UiCache;
  bundledDir(): string | null;
  log(msg: string): void;
}

export class DesktopShell {
  readonly store: ShellStore;
  readonly notifications: NotificationCenter;
  readonly jobs = new JobTracker();
  private deps: ShellDeps;
  private taskbar: Taskbar;
  private tray: TrayIcon;
  private chromeWins = new Map<number, { win: BrowserWindow; kind: WindowKind; css?: string }>();
  private crashDismissed = false;
  private quitting = false;
  private hiddenInTray = false;
  private jobsTimer: NodeJS.Timeout | null = null;
  private disk: DiskStatus = { checkedAt: new Date(0).toISOString(), drives: [], low: false, thresholdBytes: LOW_DISK_BYTES };
  private warnedLow = new Set<string>();
  private lastOffline: OfflineStatus | null = null;
  private lastUpdate: UpdateState | null = null;
  private gpuCache: GpuSummary | null = null;
  private iconCache: NativeImage | null | undefined;
  private sessionTimer: NodeJS.Timeout | null = null;

  constructor(deps: ShellDeps) {
    this.deps = deps;
    this.store = new ShellStore(path.join(deps.userData, "shell.json"));
    this.notifications = new NotificationCenter({
      file: path.join(deps.userData, "notifications.json"),
      prefs: () => this.store.get().prefs,
      open: (t) => this.openTarget(t),
      broadcast: (list) => this.broadcast(SHELL_IPC.notifChange, list),
      icon: () => this.appIcon() ?? undefined,
      appFocused: () => Boolean(BrowserWindow.getFocusedWindow()),
      log: deps.log,
    });
    setNotificationCenter(this.notifications);
    this.taskbar = new Taskbar({ main: () => this.wm()?.main ?? null, accent: () => this.appearance().accentColor, log: deps.log,
      cancelRender: () => { for (const r of this.jobs.activeRenders()) this.deps.ctx().renders.cancel(r.id.replace(/^render:/, "")); },
      showRenders: () => this.wm()?.showMain() });
    this.tray = new TrayIcon({ prefs: () => this.store.get().prefs, icon: () => this.appIcon(), accent: () => this.appearance().accentColor,
      open: () => { this.hiddenInTray = false; this.wm()?.showMain(); this.jobsChanged(); }, quit: () => app.quit(), hidden: () => this.hiddenInTray, log: deps.log });
    this.store.set({ running: !deps.smoke, lastVersion: deps.appVersion });
    // the theme before any window: Mica, the title bar overlay and native dialogs follow it
    try { nativeTheme.themeSource = deps.ctx().config.get().appearance?.theme ?? "dark"; } catch { /* no config yet */ }
    app.on("before-quit", () => {
      this.quitting = true;
      this.saveSession();
      this.store.set({ running: false });
      this.tray.destroy();
    });
  }

  /** Before any window: the app's id for toasts and the taskbar (packaged: the installer's appId). */
  static early(packaged: boolean): void {
    if (process.platform === "win32") app.setAppUserModelId(packaged ? "com.tatvam.studio" : process.execPath);
  }

  private wm() {
    try { return this.deps.ctx().windows; } catch { return null; }
  }

  private broadcast(channel: string, payload: unknown): void {
    this.wm()?.broadcast(channel, payload);
  }

  private appIcon(): NativeImage | null {
    if (this.iconCache !== undefined) return this.iconCache;
    const dirs = [this.deps.bundledDir(), ...(this.deps.uiCache.dirs() ?? [])].filter((d): d is string => Boolean(d));
    for (const d of dirs) {
      const p = path.join(d, "icon-192.png");
      if (existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) { this.iconCache = img; return img; }
      }
    }
    this.iconCache = null;
    return null;
  }

  // ── appearance ────────────────────────────────────────────────────────────

  appearance(): AppearanceState {
    const a = this.deps.ctx().config.get().appearance ?? DEFAULT_APPEARANCE;
    let sys: string | null = null;
    try { sys = accentHex(systemPreferences.getAccentColor?.()); } catch { sys = null; }
    return appearanceState(a, { dark: a.theme === "system" ? nativeTheme.shouldUseDarkColors : a.theme === "dark", systemAccent: sys });
  }

  private zoom(): number {
    return (this.appearance().scale || 100) / 100;
  }

  /** Constructor options for a window kind: the custom title bar, the overlay colours and the backdrop. */
  chrome(_kind: WindowKind): Partial<BrowserWindowConstructorOptions> {
    if (process.platform !== "win32" || process.env.TATVAM_SYSTEM_FRAME === "1") return {};
    const s = this.appearance();
    const opts: Partial<BrowserWindowConstructorOptions> = {
      titleBarStyle: "hidden",
      titleBarOverlay: overlayFor(s.dark, s.materialInUse, s.highContrast),
      backgroundColor: s.materialInUse === "none" ? (s.dark ? GROUND.dark.bg : GROUND.light.bg) : "#00000000",
    };
    if (s.materialInUse !== "none") opts.backgroundMaterial = s.materialInUse;
    return opts;
  }

  /** A window was made: zoom, the title bar CSS on every page load, session tracking for the main window. */
  onWindow(win: BrowserWindow, kind: WindowKind): void {
    const chrome = process.platform === "win32" && process.env.TATVAM_SYSTEM_FRAME !== "1";
    const entry: { win: BrowserWindow; kind: WindowKind; css?: string } = { win, kind };
    this.chromeWins.set(win.id, entry);
    const wc = win.webContents;
    wc.on("dom-ready", () => {
      if (win.isDestroyed()) return;
      try { wc.setZoomFactor(this.zoom()); } catch { /* closing */ }
      if (!chrome) return;
      const css = chromeCss({ materialInUse: this.appearance().materialInUse, titleBarHeight: 32 / this.zoom() });
      void wc.insertCSS(css).then((k) => { entry.css = k; }).catch(() => undefined);
    });
    win.on("closed", () => this.chromeWins.delete(win.id));
    if (kind === "main") {
      const track = () => { this.trackMain(); };
      wc.on("did-navigate", track);
      wc.on("did-navigate-in-page", track);
      wc.on("render-process-gone", (_e, d) => {
        if (d.reason === "clean-exit") return;
        this.deps.log(`main window renderer gone: ${d.reason}`);
        this.notifications.show({ kind: "system", tone: "error", title: "The window stopped unexpectedly", body: "Tatvam reloaded it. Your edits autosave." });
        setTimeout(() => { if (!win.isDestroyed()) wc.reload(); }, 600);
      });
    }
  }

  /** Apply the appearance to every window and tell every page. */
  applyAppearance(): AppearanceState {
    const s = this.appearance();
    try { nativeTheme.themeSource = s.theme; } catch { /* old Electron */ }
    const fresh = this.appearance(); // shouldUseDarkColors follows themeSource
    for (const { win, css } of [...this.chromeWins.values()]) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.setZoomFactor(fresh.scale / 100);
        if (process.platform === "win32" && process.env.TATVAM_SYSTEM_FRAME !== "1") {
          win.setTitleBarOverlay?.(overlayFor(fresh.dark, fresh.materialInUse, fresh.highContrast));
          if (fresh.materialSupported) win.setBackgroundMaterial?.(fresh.materialInUse);
          win.setBackgroundColor(fresh.materialInUse === "none" ? (fresh.dark ? GROUND.dark.bg : GROUND.light.bg) : "#00000000");
          const next = chromeCss({ materialInUse: fresh.materialInUse, titleBarHeight: 32 / (fresh.scale / 100) });
          const entry = this.chromeWins.get(win.id)!;
          if (css) void win.webContents.removeInsertedCSS(css).catch(() => undefined);
          void win.webContents.insertCSS(next).then((k) => { entry.css = k; }).catch(() => undefined);
        }
      } catch (e) {
        this.deps.log(`appearance: ${(e as Error).message}`);
      }
    }
    this.broadcast(SHELL_IPC.appearanceChange, fresh);
    return fresh;
  }

  setAppearance(patch: Partial<AppearanceSettings>): AppearanceState {
    const cur = this.deps.ctx().config.get().appearance ?? DEFAULT_APPEARANCE;
    this.deps.ctx().config.set({ appearance: sanitizeAppearance({ ...cur, ...(patch ?? {}) }, cur) });
    return this.applyAppearance();
  }

  /** View → Zoom: ±10 % steps of the UI scale (0 = 100 %). */
  uiScale(step: number): void {
    const cur = this.appearance().scale;
    this.setAppearance({ scale: step === 0 ? 100 : cur + step * 10 });
  }

  // ── jobs, taskbar, tray, notifications from the managers ───────────────────

  private jobsChanged(): void {
    if (this.jobsTimer) return;
    this.jobsTimer = setTimeout(() => {
      this.jobsTimer = null;
      const sum = this.jobs.summary();
      this.taskbar.update(sum);
      this.tray.update(sum);
      this.broadcast(SHELL_IPC.jobsChange, sum);
    }, 200);
  }

  private event(ev: JobEvent | null): void {
    this.jobsChanged();
    if (!ev) return;
    const n = this.describe(ev);
    if (n) this.notifications.show(n);
  }

  private describe(ev: JobEvent): NotifyInput | null {
    const failed = ev.type === "failed";
    switch (ev.source) {
      case "render": {
        const j = ev.job;
        if (j.status === "done" && j.uploaded && j.upload?.state === "done") {
          return { kind: "render", tone: "ok", title: "Uploaded to the Render Center", body: `${ev.item.label}${j.version ? ` · v${j.version}` : ""}`,
            target: j.kind === "edit" && j.editPath ? { editPath: j.editPath } : { url: `/p/${j.pid}/finish#renders` } };
        }
        const target: NotificationTarget = j.kind === "edit" && j.editPath ? { editPath: j.editPath, renderId: j.id } : { url: `/p/${j.pid}/finish#renders`, renderId: j.id };
        return failed
          ? { kind: "render", tone: "error", title: j.kind === "edit" ? "Export failed" : "Render failed", body: `${ev.item.label}: ${j.error ?? "see the log"}`, target }
          : { kind: "render", tone: "ok", title: j.kind === "edit" ? "Export finished" : "Render finished", body: `${ev.item.label}${j.elapsed_s ? ` in ${Math.round(j.elapsed_s)} s` : ""}`, target };
      }
      case "upscale": {
        const j = ev.job;
        return { kind: "ai", tone: failed ? "error" : "ok", title: failed ? "AI upscale failed" : "AI upscale finished", body: failed ? `${j.code}: ${j.error ?? ""}` : ev.item.label,
          target: { url: `/p/${j.pid}/finish#upscale` } };
      }
      case "editor": {
        const j = ev.job;
        return { kind: "ai", tone: failed ? "error" : "ok", title: `${j.kind === "interpolate" ? "Slow motion" : "Transcript"} ${failed ? "failed" : "ready"}`,
          body: failed ? `${j.name}: ${j.error ?? ""}` : j.name, target: { editPath: j.editPath } };
      }
      case "tool": {
        const t = ev.job;
        return { kind: "download", tone: failed ? "error" : "ok", title: failed ? `${t.label} didn't install` : `${t.label} is installed`, body: failed ? t.error : "Ready to use on this PC",
          target: { settings: "ai-tools" } };
      }
      case "sync": {
        const s = ev.job;
        if (failed) return { kind: "sync", tone: "error", title: "Sync failed", body: s.errors?.[s.errors.length - 1] ?? `Project #${s.pid}`, target: { url: `/p/${s.pid}/finish#folder` } };
        if (!(s.bytesTotal > 0)) return null; // nothing was downloaded
        return { kind: "download", tone: "ok", title: "Project folder synced", body: `${s.inFolder ?? s.done} file${(s.inFolder ?? s.done) === 1 ? "" : "s"} in the folder${s.renamed ? `, ${s.renamed} renamed into cut order` : ""}`,
          target: { url: `/p/${s.pid}/finish#folder` } };
      }
    }
  }

  onRender(j: RenderJob): void { this.event(this.jobs.render(j)); }
  onUpscale(j: UpscaleJob): void { this.event(this.jobs.upscale(j)); }
  onEditorJob(j: EditorJob): void { this.event(this.jobs.editor(j)); }
  onTool(t: ToolStatus): void { this.event(this.jobs.tool(t)); }
  onSync(s: SyncStatus): void { this.event(this.jobs.sync(s)); }

  /** The gateway's connection: a replayed offline edit the server refused is a sync conflict. */
  onOffline(s: OfflineStatus): void {
    const prev = this.lastOffline;
    this.lastOffline = s;
    this.deps.uiCache.setOnline(s.online);
    if (prev && s.online && s.queued < prev.queued && s.lastError && s.lastError !== prev.lastError && /\b4\d\d\b|checked out|read-only|conflict|changed/i.test(s.lastError)) {
      this.notifications.show({ kind: "sync", tone: "warn", title: "An offline edit couldn't be applied", body: s.lastError.slice(0, 300) });
    }
  }

  onUpdate(u: UpdateState): void {
    const prev = this.lastUpdate;
    this.lastUpdate = u;
    if (u.state === "ready" && prev?.state !== "ready") {
      this.notifications.show({ kind: "update", tone: "ok", title: "Update ready", body: `Restart to update to ${u.version ?? "the new version"}`, target: { settings: "updates" } });
    }
  }

  onUiStatus(s: UiStatus): void {
    this.broadcast(SHELL_IPC.uiStatusChange, s);
  }

  // ── the main window: start page, session, close to tray ───────────────────

  /** Where the main window starts when no link names a page: the first-run steps, else Start. */
  initialUrl(): string {
    if (this.deps.smoke) return "/";
    const s = this.store.get();
    return s.onboarded ? "/desktop/panel/start" : "/desktop/panel/welcome";
  }

  /** tatvam://shell?action=new-edit-from-folder | open-library | settings&section=… (the Jump List). */
  handleLink(url: string): boolean {
    let u: URL;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== "tatvam:" || (u.hostname || u.pathname.replace(/^\/+/, "")).toLowerCase() !== "shell") return false;
    const action = u.searchParams.get("action") ?? "";
    const wm = this.wm();
    if (action === "open-library") void eshell.openPath(this.deps.ctx().library.root());
    else if (action === "new-edit-from-folder") wm?.navigateMain("/desktop/panel/start?action=new-edit-from-folder");
    else if (action === "settings") wm?.openPage("settings", { section: u.searchParams.get("section") ?? undefined });
    else wm?.navigateMain("/desktop/panel/start");
    return true;
  }

  /** The main window is closing: with "Keep rendering when the window is closed" and a render running, hide it. */
  onMainClose(win: BrowserWindow): boolean {
    if (this.quitting) return false;
    if (!this.store.get().prefs.keepRendering || !this.jobs.activeRenders().length) return false;
    win.hide();
    if (!this.hiddenInTray) {
      this.hiddenInTray = true;
      this.notifications.show({ kind: "render", tone: "info", title: "Tatvam keeps rendering", body: "The render carries on; open Tatvam from the tray icon." });
    }
    this.jobsChanged();
    return true;
  }

  private trackMain(): void {
    const w = this.wm()?.main;
    if (!w || w.isDestroyed()) return;
    try {
      const u = new URL(w.webContents.getURL());
      if (u.pathname === "/editor/edit") {
        const p = u.searchParams.get("path");
        if (p) { this.taskbar.recentDocument(p); void this.refreshJumpList(); }
      }
    } catch { /* not loaded */ }
    this.saveSessionSoon();
  }

  private saveSessionSoon(): void {
    if (this.sessionTimer) return;
    this.sessionTimer = setTimeout(() => { this.sessionTimer = null; this.saveSession(); }, 1500);
    this.sessionTimer.unref?.();
  }

  private saveSession(): void {
    const wm = this.wm();
    if (!wm || this.deps.smoke) return;
    let url: string | undefined;
    let editPath: string | undefined;
    try {
      const m = wm.main;
      if (m && !m.isDestroyed()) {
        const u = new URL(m.webContents.getURL());
        if (wm.isGatewayUrl(u.href)) url = u.pathname + u.search + u.hash;
        if (u.pathname === "/editor/edit") editPath = u.searchParams.get("path") ?? undefined;
      }
    } catch { /* not loaded yet */ }
    this.store.set({ session: { at: new Date().toISOString(), ...(url ? { url } : {}), panels: wm.openPanels().filter((p) => !p.clean).map((p) => p.panel),
      ...(editPath ? { editPath } : {}) } });
  }

  async refreshJumpList(): Promise<void> {
    try {
      const list = await this.deps.ctx().editor.list();
      this.taskbar.jumpList(list.filter((e) => e.recent).map((e) => ({ path: e.path, name: e.name })));
    } catch (e) {
      this.deps.log(`jump list: ${(e as Error).message}`);
    }
  }

  /** After the main window is up: jump list, disk watch, session saves, the first-run server check. */
  afterStart(): void {
    setTimeout(() => void this.refreshJumpList(), 3000).unref?.();
    void this.checkDisk();
    setInterval(() => void this.checkDisk(), 5 * 60_000).unref?.();
    setInterval(() => this.saveSession(), 30_000).unref?.();
    nativeTheme.on("updated", () => { if (this.appearance().theme === "system") this.applyAppearance(); });
    try { systemPreferences.on("accent-color-changed", () => this.applyAppearance()); } catch { /* not on this OS */ }
    if (!this.deps.smoke && !this.store.get().onboarded) void this.firstRunServerCheck();
  }

  private async firstRunServerCheck(): Promise<void> {
    const url = this.deps.ctx().config.get().serverUrl;
    try {
      const r = await fetch(`${url}/api/health/live`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) return;
    } catch { /* unreachable */ }
    this.deps.ctx().openConnection();
    this.deps.log(`first run: ${url} isn't reachable, opened the Studio server window`);
  }

  // ── disk space and storage ─────────────────────────────────────────────────

  private drive(p: string, label: string): DiskDrive | null {
    try {
      const target = existsSync(p) ? p : path.parse(path.resolve(p)).root;
      const st = statfsSync(target);
      const free = Number(st.bavail) * Number(st.bsize);
      const total = Number(st.blocks) * Number(st.bsize);
      return { path: path.parse(path.resolve(p)).root || p, label, freeBytes: free, totalBytes: total, low: free < LOW_DISK_BYTES };
    } catch {
      return null;
    }
  }

  async checkDisk(): Promise<DiskStatus> {
    const lib = this.deps.ctx().config.get().libraryRoot;
    const drives: DiskDrive[] = [];
    for (const [p, label] of [[lib, "Library"], [this.deps.userData, "Cache"]] as const) {
      const d = this.drive(p, label);
      if (!d) continue;
      const same = drives.find((x) => x.path.toLowerCase() === d.path.toLowerCase());
      if (same) same.label = `${same.label} and ${label.toLowerCase()}`;
      else drives.push(d);
    }
    this.disk = { checkedAt: new Date().toISOString(), drives, low: drives.some((d) => d.low), thresholdBytes: LOW_DISK_BYTES };
    for (const d of drives.filter((x) => x.low && !this.warnedLow.has(x.path))) {
      this.warnedLow.add(d.path);
      this.notifications.show({ kind: "system", tone: "warn", title: `Low disk space on ${d.path}`, body: `${(d.freeBytes / 1024 ** 3).toFixed(1)} GB free (${d.label}). Renders and syncs need room.`,
        target: { settings: "storage" } });
    }
    this.broadcast(SHELL_IPC.diskChange, this.disk);
    return this.disk;
  }

  private async folderSize(dir: string, depth = 0): Promise<{ bytes: number; files: number }> {
    let bytes = 0, files = 0;
    let ents: import("node:fs").Dirent[] = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return { bytes, files }; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 12) continue;
        const s = await this.folderSize(p, depth + 1);
        bytes += s.bytes; files += s.files;
      } else if (e.isFile()) {
        try { bytes += (await fsp.stat(p)).size; files++; } catch { /* gone */ }
      }
    }
    return { bytes, files };
  }

  /** Project folders: the library's own plus any moved ones. */
  private async projectDirs(): Promise<string[]> {
    const cfg = this.deps.ctx().config.get();
    const out = new Set<string>(Object.values(cfg.projectFolders));
    try {
      for (const e of await fsp.readdir(cfg.libraryRoot, { withFileTypes: true })) {
        if (e.isDirectory() && e.name !== "Edits" && existsSync(path.join(cfg.libraryRoot, e.name, "project.tatvam.json"))) out.add(path.join(cfg.libraryRoot, e.name));
      }
    } catch { /* no library yet */ }
    return [...out];
  }

  private async sumSub(dirs: string[], sub: string): Promise<{ bytes: number; files: number }> {
    let bytes = 0, files = 0;
    for (const d of dirs) { const s = await this.folderSize(path.join(d, sub)); bytes += s.bytes; files += s.files; }
    return { bytes, files };
  }

  async storage(): Promise<{ items: StorageItem[]; disk: DiskStatus }> {
    const cfg = this.deps.ctx().config.get();
    const projects = await this.projectDirs();
    const editsRoot = path.join(cfg.libraryRoot, "Edits");
    let editDirs: string[] = [];
    try { editDirs = (await fsp.readdir(editsRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => path.join(editsRoot, e.name)); } catch { editDirs = []; }
    const ui = await this.deps.uiCache.usage();
    const tools = await this.folderSize(path.join(this.deps.userData, "tools"));
    const logs = await this.folderSize(logsDir() || path.join(this.deps.userData, "logs"));
    let http = 0;
    try { http = await session.defaultSession.getCacheSize(); } catch { http = 0; }
    const pc = await this.sumSub(projects, "Cache");
    const px = await this.sumSub(projects, "Proxies");
    const rd = await this.sumSub(projects, "Renders");
    const ec = await this.sumSub(editDirs, "Cache");
    const items: StorageItem[] = [
      { id: "project-cache", label: "Project caches", path: cfg.libraryRoot, ...pc, clearable: true, note: `Cache/ in ${projects.length} project folder${projects.length === 1 ? "" : "s"}: rebuilt as needed` },
      { id: "proxies", label: "Proxies", path: cfg.libraryRoot, ...px, clearable: true, note: "1080p proxies; build them again from the Finishing room" },
      { id: "edit-cache", label: "Editor caches", path: editsRoot, ...ec, clearable: false, note: "Thumbnails, filmstrips, waveforms and audio previews of your edits" },
      { id: "renders", label: "Renders", path: cfg.libraryRoot, ...rd, clearable: false, note: "Uploaded renders can be cleaned per project in the Finishing room" },
      { id: "ui-cache", label: "Saved screens", path: path.join(this.deps.userData, "ui-cache"), bytes: ui, files: 0, clearable: true, note: "Offline copies of the server's screens (the one in use stays)" },
      { id: "http-cache", label: "Web cache", path: path.join(this.deps.userData, "Cache"), bytes: http, files: 0, clearable: true, note: "Images and pages the app's windows cached" },
      { id: "tools", label: "AI tools", path: path.join(this.deps.userData, "tools"), ...tools, clearable: false, note: "Remove tools one by one under AI tools on this PC" },
      { id: "logs", label: "Logs", path: logsDir() || path.join(this.deps.userData, "logs"), ...logs, clearable: false },
    ];
    return { items, disk: await this.checkDisk() };
  }

  async clearStorage(id: string): Promise<{ removedBytes: number }> {
    if (id === "ui-cache") return { removedBytes: await this.deps.uiCache.clear() };
    if (id === "http-cache") {
      const before = await session.defaultSession.getCacheSize().catch(() => 0);
      await session.defaultSession.clearCache();
      return { removedBytes: before };
    }
    if (id === "project-cache" || id === "proxies") {
      const sub = id === "proxies" ? "Proxies" : "Cache";
      let removed = 0;
      for (const d of await this.projectDirs()) {
        const dir = path.join(d, sub);
        let ents: string[] = [];
        try { ents = await fsp.readdir(dir); } catch { continue; }
        for (const n of ents) {
          const p = path.join(dir, n);
          const s = await this.folderSize(p).catch(() => ({ bytes: 0, files: 0 }));
          const st = await fsp.stat(p).catch(() => null);
          try { await fsp.rm(p, { recursive: true, force: true }); removed += st?.isFile() ? st.size : s.bytes; } catch { /* in use */ }
        }
      }
      void this.checkDisk();
      return { removedBytes: removed };
    }
    throw new Error("That folder can't be cleared here");
  }

  // ── drops from Explorer ────────────────────────────────────────────────────

  async describePath(p: string): Promise<DropEntry | null> {
    if (typeof p !== "string" || !path.isAbsolute(p)) return null;
    const abs = path.resolve(p);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) return null;
    const name = path.basename(abs) || abs;
    if (st.isDirectory()) {
      let media: string[] = [];
      try {
        media = (await fsp.readdir(abs, { withFileTypes: true })).filter((e) => e.isFile() && mediaKindOf(e.name)).map((e) => path.join(abs, e.name))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 2000);
      } catch { media = []; }
      return { path: abs, name, type: "folder", ext: "", media };
    }
    const ext = path.extname(abs).slice(1).toLowerCase();
    if (ext === EDIT_EXT) {
      this.deps.ctx().editor.allowEditFile(abs); // the user dropped it: the page may open it
      return { path: abs, name, type: "edit", ext };
    }
    if (TIMELINE_EXTS.includes(ext)) return { path: abs, name, type: "timeline", ext };
    if (mediaKindOf(abs)) return { path: abs, name, type: "media", ext };
    return { path: abs, name, type: "other", ext };
  }

  // ── IPC ────────────────────────────────────────────────────────────────────

  registerIpc(): void {
    const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) => {
      ipcMain.handle(channel, async (e: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (!this.wm()?.isGatewayUrl(e.senderFrame?.url ?? "")) throw new Error("Not allowed from this page");
        return fn(e, ...args);
      });
    };
    handle(SHELL_IPC.uiStatus, () => this.deps.uiCache.status());
    handle(SHELL_IPC.uiCheck, () => this.deps.uiCache.check("manual"));
    handle(SHELL_IPC.updateState, () => updateState());
    handle(SHELL_IPC.updateInstall, () => { installNow(); });
    handle(SHELL_IPC.releaseNotes, () => this.releaseNotes());

    handle(SHELL_IPC.appearanceGet, () => this.appearance());
    handle(SHELL_IPC.appearanceSet, (_e, patch: Partial<AppearanceSettings>) => this.setAppearance(patch ?? {}));

    handle(SHELL_IPC.state, () => this.state());
    handle(SHELL_IPC.setPrefs, (_e, patch: Partial<ShellPrefs>) => {
      this.store.set({ prefs: { ...this.store.get().prefs, ...(patch ?? {}) } as ShellPrefs });
      setAutoInstallOnQuit(this.store.get().prefs.autoInstallOnQuit);
      this.jobsChanged();
      return this.pushState();
    });
    handle(SHELL_IPC.finishOnboarding, (_e, opts?: { offlineOnly?: boolean }) => {
      this.store.set({ onboarded: true, offlineOnly: Boolean(opts?.offlineOnly) });
      return this.pushState();
    });
    handle(SHELL_IPC.open, (_e, page: string, opts?: { section?: string }) => {
      if (page !== "start" && page !== "settings" && page !== "welcome") throw new Error("Unknown page");
      this.wm()?.openPage(page, { section: typeof opts?.section === "string" ? opts.section : undefined });
    });
    handle(SHELL_IPC.popupMenu, (e, menu: string, x: number, y: number) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const item = Menu.getApplicationMenu()?.items.find((i) => i.label.replace(/&/g, "") === String(menu));
      if (!win || !item?.submenu) return;
      const z = e.sender.getZoomFactor();
      item.submenu.popup({ window: win, x: Math.round(Number(x) * z), y: Math.round(Number(y) * z) });
    });
    handle(SHELL_IPC.dropped, async (_e, paths: string[]) => {
      const list = Array.isArray(paths) ? paths.filter((p) => typeof p === "string").slice(0, 500) : [];
      const entries = (await Promise.all(list.map((p) => this.describePath(p)))).filter((x): x is DropEntry => Boolean(x));
      return { entries };
    });
    handle(SHELL_IPC.pickFolder, async (e, title?: string) => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const opts: Electron.OpenDialogOptions = { title: typeof title === "string" ? title.slice(0, 100) : "Choose a folder of clips", properties: ["openDirectory"] };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths[0]) return null;
      return this.describePath(r.filePaths[0]);
    });
    handle(SHELL_IPC.jobs, () => this.jobs.summary());
    handle(SHELL_IPC.disk, () => this.checkDisk());
    handle(SHELL_IPC.storage, () => this.storage());
    handle(SHELL_IPC.clearStorage, (_e, id: string) => this.clearStorage(String(id)));
    handle(SHELL_IPC.aiTools, () => this.aiTools());
    handle(SHELL_IPC.gpu, () => this.gpu());
    handle(SHELL_IPC.reset, (_e, scope: string) => this.reset(scope === "all" ? "all" : scope === "app" ? "app" : "appearance"));
    handle(SHELL_IPC.recover, (_e, reopen: boolean) => this.recover(Boolean(reopen)));

    handle(SHELL_IPC.notifList, () => this.notifications.list());
    handle(SHELL_IPC.notifShow, (_e, n: NotifyInput) => (n && typeof n === "object" ? this.notifications.show(n) : null));
    handle(SHELL_IPC.notifRead, (_e, id?: string) => this.notifications.markRead(typeof id === "string" ? id : undefined));
    handle(SHELL_IPC.notifClear, () => this.notifications.clear());
    handle(SHELL_IPC.notifOpen, (_e, id: string) => this.notifications.open(String(id)));
  }

  state() {
    return this.store.state(this.deps.appVersion, { crashDismissed: this.crashDismissed });
  }

  private pushState() {
    const s = this.state();
    this.broadcast(SHELL_IPC.stateChange, s);
    return s;
  }

  private releaseNotes(): ReleaseNotes {
    const v = this.deps.appVersion;
    const u = updateState();
    if (u.releaseNotes && u.version === v) return { version: v, notes: u.releaseNotes, source: "updater" };
    for (const f of [path.join(process.resourcesPath || "", "CHANGELOG.md"), path.join(app.getAppPath(), "..", "CHANGELOG.md")]) {
      try {
        if (!existsSync(f)) continue;
        const notes = changelogSection(readFileSync(f, "utf8"), v);
        if (notes) return { version: v, notes, source: "bundled" };
      } catch { /* unreadable */ }
    }
    return { version: v, notes: "", source: "none" };
  }

  private aiTools() {
    const sources = Object.entries(TOOLS).map(([id, def]) => {
      let host = "";
      try { host = new URL(def.pin.url).host; } catch { host = ""; }
      return { id, url: def.pin.url, host, file: def.pin.file, sizeBytes: def.pin.size };
    });
    const dir = [...(this.deps.uiCache.dirs() ?? []), this.deps.bundledDir()].find((d): d is string => Boolean(d && existsSync(path.join(d, "models", "mediapipe"))));
    let bytes = 0, files = 0;
    if (dir) {
      try {
        for (const n of readdirSync(path.join(dir, "models", "mediapipe"))) {
          try { bytes += statSync(path.join(dir, "models", "mediapipe", n)).size; files++; } catch { /* gone */ }
        }
      } catch { /* none */ }
    }
    return { sources, mediapipe: { installed: files > 0, sizeBytes: bytes, files, source: "Ships with the screens (frontend/public/models/mediapipe)" } };
  }

  private async gpu(): Promise<GpuSummary> {
    if (this.gpuCache) return this.gpuCache;
    const features = app.getGPUFeatureStatus() as unknown as Record<string, string>;
    let name: string | undefined, vendor: string | undefined, driver: string | undefined;
    try {
      const info = (await app.getGPUInfo("complete")) as { auxAttributes?: { glRenderer?: string; glVendor?: string }; gpuDevice?: { active?: boolean; driverVersion?: string; vendorId?: number }[] };
      const r = info.auxAttributes?.glRenderer ?? "";
      const m = /ANGLE \(([^,]+),\s*([^,(]+?)(?:\s*\(|,|$)/.exec(r);
      vendor = m?.[1]?.trim() || info.auxAttributes?.glVendor;
      name = m?.[2]?.trim() || r || undefined;
      driver = info.gpuDevice?.find((d) => d.active)?.driverVersion ?? info.gpuDevice?.[0]?.driverVersion;
    } catch { /* no info */ }
    this.gpuCache = { ...(name ? { name } : {}), ...(vendor ? { vendor } : {}), ...(driver ? { driver } : {}), features };
    return this.gpuCache;
  }

  private reset(scope: "appearance" | "app" | "all"): void {
    const config = this.deps.ctx().config;
    if (scope === "appearance" || scope === "all") config.set({ appearance: { ...DEFAULT_APPEARANCE } });
    if (scope === "app" || scope === "all") { this.store.set({ prefs: structuredClone(DEFAULT_PREFS) }); setAutoInstallOnQuit(true); }
    if (scope === "all") {
      const d = defaultSettings({ documents: app.getPath("documents") });
      config.set({ naming: d.naming, pullScope: d.pullScope, proxyMode: d.proxyMode, encoder: d.encoder, autoSync: d.autoSync, editorBackups: d.editorBackups,
        uiSource: "auto", uiSourceChosen: false });
      void this.deps.uiCache.check("reset");
    }
    this.applyAppearance();
    this.pushState();
  }

  private recover(reopen: boolean): void {
    this.crashDismissed = true;
    const prev = this.store.previous.session;
    if (reopen && prev) {
      const wm = this.wm();
      if (prev.editPath) this.deps.ctx().editor.allowEditFile(prev.editPath);
      if (prev.url && wm) wm.navigateMain(prev.url);
      for (const p of prev.panels) { try { wm?.popOut(p as never); } catch { /* unknown panel */ } }
    }
    this.pushState();
  }

  /** Focus the window and item a notification points at. */
  openTarget(t: NotificationTarget | undefined): void {
    const wm = this.wm();
    if (!wm) return;
    if (this.hiddenInTray) { this.hiddenInTray = false; this.jobsChanged(); }
    if (!t) { wm.showMain(); return; }
    if (t.reveal) eshell.showItemInFolder(t.reveal);
    if (t.settings) { wm.openPage("settings", { section: t.settings }); return; }
    let editPath = t.editPath;
    let url = t.url;
    if (t.renderId && !editPath && !url) {
      const j = this.deps.ctx().renders.get(t.renderId);
      if (j?.kind === "edit" && j.editPath) editPath = j.editPath;
      else if (j) url = `/p/${j.pid}/finish#renders`;
    }
    if (editPath) {
      this.deps.ctx().editor.allowEditFile(editPath);
      const want = `/editor/edit?path=${encodeURIComponent(editPath)}`;
      const open = wm.bridgeWindows().find((w) => { try { const u = new URL(w.webContents.getURL()); return u.pathname === "/editor/edit" && u.searchParams.get("path") === editPath; } catch { return false; } });
      if (open) { if (!open.isVisible()) open.show(); if (open.isMinimized()) open.restore(); open.focus(); return; }
      wm.navigateMain(want);
      return;
    }
    if (url) {
      const pathOnly = url.split("#")[0];
      const open = wm.bridgeWindows().find((w) => { try { const u = new URL(w.webContents.getURL()); return u.pathname + u.search === pathOnly; } catch { return false; } });
      if (open) {
        if (!open.isVisible()) open.show();
        if (open.isMinimized()) open.restore();
        open.focus();
        if (url.includes("#")) void open.webContents.executeJavaScript(`location.hash = ${JSON.stringify(url.slice(url.indexOf("#")))}`).catch(() => undefined);
        return;
      }
      wm.navigateMain(url);
      return;
    }
    wm.showMain();
  }

  // ── window bounds per arrangement of monitors ──────────────────────────────

  private signature(): string {
    return displaySignature(screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds })));
  }

  boundsFor(key: string): WindowStateEntry | undefined {
    const e = this.store.get().bounds[this.signature()]?.[key];
    if (!e?.bounds) return e;
    return boundsVisible(e.bounds, screen.getAllDisplays().map((d) => d.workArea)) ? e : undefined;
  }

  saveBounds(key: string, entry: WindowStateEntry): void {
    const all = this.store.get().bounds;
    const sig = this.signature();
    const next = { ...all, [sig]: { ...(all[sig] ?? {}), [key]: entry } };
    // keep the 8 most recent arrangements
    const keys = Object.keys(next);
    if (keys.length > 8) for (const k of keys.slice(0, keys.length - 8)) if (k !== sig) delete next[k];
    this.store.set({ bounds: next });
  }

  reduceMotion(): boolean {
    return this.appearance().reduceMotion;
  }
}

export const MEDIA_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS];
