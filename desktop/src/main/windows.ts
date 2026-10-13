/**
 * Windows (docs/DESKTOP.md §4, §5): the main window, pop-out panels (`/desktop/panel/<panel>` on the gateway), the
 * display list, move to a display, the clean full-screen feed, workspaces and saved window state per display.
 * Every window is sandboxed with context isolation; only gateway-origin pages get the bridge, and navigation away
 * from the gateway opens in the system browser instead.
 *
 * The desktop shell adds: the Windows 11 chrome (a custom title bar over the system window buttons, Mica), the
 * Settings window (`/desktop/panel/settings`), bounds remembered per arrangement of monitors, and a short fade when a
 * window opens or a panel closes.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { BrowserWindow, dialog, screen, shell, type BrowserWindowConstructorOptions, type Display, type Rectangle, type WebContents } from "electron";
import type { Bounds, DisplayInfo, PanelId, PanelWindowInfo, WindowStateEntry, Workspace, WorkspacePanel } from "../shared/types.ts";
import type { Config } from "./config.ts";
import { BUILTIN_WORKSPACES } from "./config.ts";

export const PANELS: PanelId[] = ["program", "source", "timeline", "scopes", "mixer", "notes", "media", "renders", "bible"];
const PANEL_TITLES: Record<PanelId, string> = {
  program: "Program monitor", source: "Source monitor", timeline: "Timeline", scopes: "Scopes", mixer: "Mixer",
  notes: "Review notes", media: "Media", renders: "Renders", bible: "Bible",
};
/** Desktop pages served under /desktop/panel/ that aren't pop-out panels (frontend/src/pages/desktop). */
export const DESKTOP_PAGES = ["start", "settings", "welcome"] as const;
export type DesktopPage = (typeof DESKTOP_PAGES)[number];

/** Which kind of window, for its chrome. */
export type WindowKind = "main" | "panel" | "page";

export interface WindowDeps {
  config: Config;
  gatewayUrl(): string;
  preload: string;
  isPackaged: boolean;
  log(msg: string): void;
  /** Google sign-in in its own window (signin.ts). */
  signIn(parent: BrowserWindow): void;
  /** additive (desktop shell): constructor options for the custom title bar and backdrop of a window kind */
  chrome?(kind: WindowKind): Partial<BrowserWindowConstructorOptions>;
  /** additive: a window was made (the shell applies appearance, zoom and the title bar CSS) */
  onWindow?(win: BrowserWindow, kind: WindowKind): void;
  /** additive: bounds saved for this arrangement of monitors, and saving them */
  boundsFor?(key: string): WindowStateEntry | undefined;
  saveBounds?(key: string, entry: WindowStateEntry): void;
  /** additive: no fades with "reduce motion" */
  reduceMotion?(): boolean;
  /** additive: the main window is closing; true keeps it (hidden in the tray while a render runs) */
  onMainClose?(win: BrowserWindow): boolean;
  /** additive: an edit handed to openEditor may be opened by the page (EditorManager.allowEditFile) */
  allowEditFile?(file: string): void;
}

/** openEditor's options: `newWindow` never reuses the main window; `whenReady` is awaited after the page loaded. */
export interface OpenEditorOptions {
  newWindow?: boolean;
  /** e.g. desktop-mcp waiting until the page attached the edit for tool calls */
  whenReady?(win: BrowserWindow): Promise<unknown> | unknown;
  /** default 30 s for the load and whenReady together */
  timeoutMs?: number;
}

let instance: WindowManager | null = null;

/** The app's WindowManager.openEditor (for main-process modules such as desktop/src/main/mcp/**). */
export function openEditor(file: string, opts: OpenEditorOptions = {}): Promise<BrowserWindow> {
  if (!instance) return Promise.reject(new Error("The windows aren't ready yet"));
  return instance.openEditor(file, opts);
}

const samePath = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

interface PanelWin { win: BrowserWindow; panel: PanelId; clean: boolean; pid?: number; eid?: number }

function intersects(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** At least 80×40 pixels of the window show on the work area (a sliver off the edge doesn't count). */
function visibleOn(area: Rectangle, b: Rectangle): boolean {
  const w = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x);
  const h = Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y);
  return w >= 80 && h >= 40;
}

function centered(d: Display, w: number, h: number): Bounds {
  const wa = d.workArea;
  const width = Math.min(w, wa.width);
  const height = Math.min(h, wa.height);
  return { x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2), width, height };
}

export class WindowManager {
  private deps: WindowDeps;
  main: BrowserWindow | null = null;
  private panels = new Map<number, PanelWin>();
  private saveTimers = new Map<number, NodeJS.Timeout>();
  private settingsWin: BrowserWindow | null = null;
  private closing = new Set<number>();

  private editorWins = new Set<BrowserWindow>();

  constructor(deps: WindowDeps) {
    this.deps = deps;
    instance = this;
  }

  // ── origins ──
  isGatewayUrl(url: string): boolean {
    try { return new URL(url).origin === new URL(this.deps.gatewayUrl()).origin; } catch { return false; }
  }

  /** Displays, primary first, then left to right: workspace indices refer to this order. */
  sortedDisplays(): Display[] {
    const primary = screen.getPrimaryDisplay();
    return screen.getAllDisplays().sort((a, b) => (a.id === primary.id ? -1 : b.id === primary.id ? 1 : a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y));
  }

  displays(): DisplayInfo[] {
    const primary = screen.getPrimaryDisplay().id;
    return this.sortedDisplays().map((d, i) => ({
      id: d.id, label: d.label || `Display ${i + 1}${d.id === primary ? " (main)" : ""}`,
      bounds: { ...d.bounds }, primary: d.id === primary, scaleFactor: d.scaleFactor,
    }));
  }

  /** A display by id, or by index into sortedDisplays() for small numbers (workspaces). */
  private display(ref: number | undefined): Display | undefined {
    if (ref === undefined || ref === null) return undefined;
    const all = this.sortedDisplays();
    return all.find((d) => d.id === ref) ?? (ref >= 0 && ref < all.length && ref < 16 ? all[ref] : undefined);
  }

  private displayOf(win: BrowserWindow): Display {
    return screen.getDisplayMatching(win.getBounds());
  }

  // ── hardening ──
  private harden(wc: WebContents, win: BrowserWindow): void {
    wc.setWindowOpenHandler(({ url }) => {
      if (this.isGatewayUrl(url)) {
        const u = new URL(url);
        const m = /^\/desktop\/panel\/([a-z]+)/.exec(u.pathname);
        if (m && (PANELS as string[]).includes(m[1])) {
          const num = (k: string) => (u.searchParams.get(k) && /^\d+$/.test(u.searchParams.get(k)!) ? Number(u.searchParams.get(k)) : undefined);
          this.popOut(m[1] as PanelId, { pid: num("pid"), eid: num("eid"), clean: u.searchParams.get("clean") === "1" });
          return { action: "deny" };
        }
        if (m && (DESKTOP_PAGES as readonly string[]).includes(m[1])) {
          this.openPage(m[1] as DesktopPage, { section: u.hash.replace(/^#/, "") || undefined });
          return { action: "deny" };
        }
        if (u.pathname.startsWith("/api/auth/google/start")) {
          this.deps.signIn(this.main ?? win);
          return { action: "deny" };
        }
        if (u.pathname.startsWith("/media/") || u.pathname.startsWith("/api/")) { // downloads and file views stay inside the app
          wc.downloadURL(url);
          return { action: "deny" };
        }
      }
      if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    wc.on("will-navigate", (e, url) => {
      if (this.isGatewayUrl(url)) {
        if (new URL(url).pathname.startsWith("/api/auth/google/start")) {
          e.preventDefault();
          this.deps.signIn(this.main ?? win);
        }
        return;
      }
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    });
    wc.on("will-attach-webview", (e) => e.preventDefault());
    wc.on("before-input-event", (e, input) => {
      if (input.type === "keyDown" && input.key === "Escape" && win.isFullScreen()) {
        win.setFullScreen(false);
        e.preventDefault();
      }
    });
  }

  private webPreferences(): Electron.WebPreferences {
    return { preload: this.deps.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      spellcheck: false, devTools: !this.deps.isPackaged || process.env.TATVAM_DEVTOOLS === "1" };
  }

  // ── window state ──
  private restoreBounds(st: WindowStateEntry | undefined, w: number, h: number, key?: string): Bounds {
    const all = screen.getAllDisplays();
    // the bounds this window had on this arrangement of monitors (docked, undocked …)
    const here = key ? this.deps.boundsFor?.(key) : undefined;
    if (here?.bounds && all.some((d) => visibleOn(d.workArea, here.bounds!))) return here.bounds;
    if (st?.bounds) {
      const d = all.find((x) => x.id === st.displayId) ?? all.find((x) => intersects(x.workArea, st.bounds!));
      if (d && visibleOn(d.workArea, st.bounds)) return st.bounds;
    }
    // the monitor it was on is gone: back to the primary one
    return centered(screen.getPrimaryDisplay(), w, h);
  }

  private remember(win: BrowserWindow, key: string): void {
    const save = () => {
      if (win.isDestroyed()) return;
      const entry: WindowStateEntry = { bounds: win.isMaximized() || win.isFullScreen() ? undefined : win.getBounds(), displayId: this.displayOf(win).id,
        maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
      const cur = this.deps.config.get().windowState;
      const prevEntry = key === "main" ? cur.main : cur.panels[key];
      if (!entry.bounds && prevEntry?.bounds) entry.bounds = prevEntry.bounds;
      if (!entry.bounds) entry.bounds = win.getNormalBounds();
      this.deps.saveBounds?.(key, entry);
      if (key === "main" || (PANELS as string[]).includes(key)) {
        this.deps.config.set({ windowState: key === "main" ? { ...cur, main: entry } : { ...cur, panels: { ...cur.panels, [key]: entry } } });
      }
    };
    const later = () => {
      const t = this.saveTimers.get(win.id);
      if (t) clearTimeout(t);
      this.saveTimers.set(win.id, setTimeout(save, 600));
    };
    win.on("resize", later);
    win.on("move", later);
    win.on("maximize", later);
    win.on("unmaximize", later);
    win.on("enter-full-screen", later);
    win.on("leave-full-screen", later);
    win.on("close", save);
  }

  // ── fades ──
  private fadeIn(win: BrowserWindow): void {
    if (this.deps.reduceMotion?.() || process.platform !== "win32") { win.show(); return; }
    win.setOpacity(0);
    win.show();
    let o = 0;
    const t = setInterval(() => {
      if (win.isDestroyed()) { clearInterval(t); return; }
      o = Math.min(1, o + 0.2);
      win.setOpacity(o);
      if (o >= 1) clearInterval(t);
    }, 16);
  }

  /** Fade a secondary window out before it closes (the main window closes at once: quitting must not wait). */
  private fadeOnClose(win: BrowserWindow): void {
    win.on("close", (e) => {
      if (this.closing.has(win.id) || this.deps.reduceMotion?.() || process.platform !== "win32" || !win.isVisible()) return;
      e.preventDefault();
      this.closing.add(win.id);
      let o = win.getOpacity();
      const t = setInterval(() => {
        if (win.isDestroyed()) { clearInterval(t); return; }
        o -= 0.25;
        if (o <= 0) { clearInterval(t); win.close(); return; }
        win.setOpacity(o);
      }, 16);
    });
  }

  private create(kind: WindowKind, opts: BrowserWindowConstructorOptions): BrowserWindow {
    const win = new BrowserWindow({ ...opts, ...(this.deps.chrome?.(kind) ?? {}), webPreferences: opts.webPreferences });
    this.deps.onWindow?.(win, kind);
    return win;
  }

  // ── main window ──
  createMain(urlPath = "/"): BrowserWindow {
    const st = this.deps.config.get().windowState.main;
    const here = this.deps.boundsFor?.("main");
    const b = this.restoreBounds(st, 1440, 900, "main");
    const win = this.create("main", {
      ...b, minWidth: 960, minHeight: 600, show: false, title: "Tatvam Studio", backgroundColor: "#0b0b0f", autoHideMenuBar: false,
      webPreferences: this.webPreferences(),
    });
    this.main = win;
    this.harden(win.webContents, win);
    this.remember(win, "main");
    if ((here ?? st)?.maximized) win.maximize();
    win.once("ready-to-show", () => this.fadeIn(win));
    win.on("close", (e) => {
      if (this.deps.onMainClose?.(win)) e.preventDefault();
    });
    win.on("closed", () => {
      this.main = null;
      for (const p of this.panels.values()) if (!p.win.isDestroyed()) p.win.close();
      if (this.settingsWin && !this.settingsWin.isDestroyed()) this.settingsWin.close();
    });
    void win.loadURL(this.deps.gatewayUrl() + urlPath);
    return win;
  }

  /** {pid, eid} of what the main window shows (/p/<pid>/…?eid=… or …/e/<eid>). */
  context(): { pid?: number; eid?: number } {
    const url = this.main && !this.main.isDestroyed() ? this.main.webContents.getURL() : "";
    try {
      const u = new URL(url);
      const pid = /^\/p\/(\d+)/.exec(u.pathname)?.[1];
      const eid = u.searchParams.get("eid") ?? u.searchParams.get("episode") ?? /\/e(?:pisodes?)?\/(\d+)/.exec(u.pathname)?.[1];
      return { pid: pid ? Number(pid) : undefined, eid: eid && /^\d+$/.test(eid) ? Number(eid) : undefined };
    } catch {
      return {};
    }
  }

  navigateMain(urlPath: string): void {
    if (!this.main || this.main.isDestroyed()) this.createMain(urlPath);
    else {
      void this.main.loadURL(this.deps.gatewayUrl() + urlPath);
      this.showMain();
    }
  }

  /** Bring the main window back (restored, shown from the tray, focused). */
  showMain(): void {
    const w = this.main;
    if (!w || w.isDestroyed()) { this.createMain("/desktop/panel/start"); return; }
    if (!w.isVisible()) w.show();
    if (w.isMinimized()) w.restore();
    w.focus();
  }

  /**
   * A desktop page: Start and the first-run steps in the main window; Settings in a window of its own (one), at a
   * section (`#appearance`).
   */
  openPage(page: DesktopPage, opts: { section?: string } = {}): BrowserWindow | null {
    const hash = opts.section && /^[a-z0-9-]{1,40}$/.test(opts.section) ? `#${opts.section}` : "";
    if (page !== "settings") {
      this.navigateMain(`/desktop/panel/${page}${hash}`);
      return this.main;
    }
    const url = `${this.deps.gatewayUrl()}/desktop/panel/settings${hash}`;
    const existing = this.settingsWin;
    if (existing && !existing.isDestroyed()) {
      if (hash) void existing.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => undefined);
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return existing;
    }
    const st = this.deps.boundsFor?.("settings");
    const b = this.restoreBounds(st, 1080, 760, "settings");
    const win = this.create("page", {
      ...b, minWidth: 720, minHeight: 480, show: false, title: "Settings · Tatvam Studio", backgroundColor: "#0b0b0f", autoHideMenuBar: true,
      webPreferences: this.webPreferences(),
    });
    this.settingsWin = win;
    this.harden(win.webContents, win);
    this.remember(win, "settings");
    this.fadeOnClose(win);
    win.once("ready-to-show", () => this.fadeIn(win));
    win.on("closed", () => { if (this.settingsWin === win) this.settingsWin = null; this.closing.delete(win.id); });
    void win.loadURL(url);
    return win;
  }

  /**
   * A hidden window for the GPU engine's final render (docs/ENGINE.md §5): the bridge, never shown, never throttled, so
   * frames keep coming while the editor works in other windows. `onClosed` fires if it goes away (a crash, say).
   */
  openRenderWindow(urlPath: string, onClosed: () => void): { close(): void } {
    const win = new BrowserWindow({
      width: 640, height: 360, show: false, title: "GPU render · Tatvam Studio", backgroundColor: "#000000", autoHideMenuBar: true,
      webPreferences: { ...this.webPreferences(), backgroundThrottling: false },
    });
    this.harden(win.webContents, win);
    win.webContents.on("render-process-gone", () => onClosed());
    win.on("closed", () => onClosed());
    void win.loadURL(this.deps.gatewayUrl() + urlPath);
    return { close: () => { if (!win.isDestroyed()) win.destroy(); } };
  }

  // ── editor windows ──
  /** The .tatvamedit a window shows (/editor/edit?path=…), or null. */
  private editOf(win: BrowserWindow): string | null {
    try {
      const u = new URL(win.webContents.getURL());
      return u.pathname === "/editor/edit" ? u.searchParams.get("path") : null;
    } catch {
      return null;
    }
  }

  /**
   * Open or focus an editor window for a .tatvamedit and resolve when its page has loaded (and `whenReady` passed): a
   * window that already shows the edit is focused; else the main window takes it when it shows nothing to lose (Start,
   * the first-run steps, the editor's home); else a new editor window opens (its bounds remembered as "editor").
   */
  async openEditor(file: string, opts: OpenEditorOptions = {}): Promise<BrowserWindow> {
    if (typeof file !== "string" || !file.toLowerCase().endsWith(".tatvamedit")) throw new Error("openEditor needs the path of a .tatvamedit file");
    this.deps.allowEditFile?.(file);
    const urlPath = `/editor/edit?path=${encodeURIComponent(file)}`;
    const timeout = opts.timeoutMs ?? 30_000;
    const focus = (w: BrowserWindow) => { if (!w.isVisible()) w.show(); if (w.isMinimized()) w.restore(); w.focus(); };
    let win = this.bridgeWindows().find((w) => { const e = this.editOf(w); return e !== null && samePath(e, file); }) ?? null;
    let loading = Boolean(win?.webContents.isLoading());
    if (win) focus(win);
    else {
      const m = this.main && !this.main.isDestroyed() ? this.main : null;
      let idle = false;
      try { idle = Boolean(m) && ["/desktop/panel/start", "/desktop/panel/welcome", "/editor"].includes(new URL(m!.webContents.getURL()).pathname); } catch { idle = false; }
      if (!m) { win = this.createMain(urlPath); }
      else if (idle && !opts.newWindow) { void m.loadURL(this.deps.gatewayUrl() + urlPath); focus(m); win = m; }
      else {
        const st = this.deps.boundsFor?.("editor");
        const b = this.restoreBounds(st, 1440, 900, "editor");
        const w = this.create("main", {
          ...b, minWidth: 960, minHeight: 600, show: false, title: "Tatvam Editor", backgroundColor: "#0b0b0f", autoHideMenuBar: true,
          webPreferences: this.webPreferences(),
        });
        this.harden(w.webContents, w);
        this.remember(w, "editor");
        this.editorWins.add(w);
        w.once("ready-to-show", () => this.fadeIn(w));
        w.on("closed", () => { this.editorWins.delete(w); this.closing.delete(w.id); });
        void w.loadURL(this.deps.gatewayUrl() + urlPath);
        win = w;
      }
      loading = true;
    }
    const target = win;
    const work = (async () => {
      if (loading || target.webContents.isLoading()) {
        await new Promise<void>((resolve, reject) => {
          const ok = () => { target.webContents.off("did-fail-load", bad); resolve(); };
          const bad = (_e: unknown, code: number, desc: string, _url: string, mainFrame: boolean) => {
            if (!mainFrame || code === -3) return; // -3: aborted by a newer navigation
            target.webContents.off("did-finish-load", ok);
            reject(new Error(`The editor didn't load: ${desc}`));
          };
          target.webContents.once("did-finish-load", ok);
          target.webContents.on("did-fail-load", bad);
        });
      }
      await opts.whenReady?.(target);
    })();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([work, new Promise((_r, j) => { timer = setTimeout(() => j(new Error("The editor window didn't get ready in time")), timeout); })])
      .finally(() => clearTimeout(timer));
    return target;
  }

  // ── panels ──
  popOut(panel: PanelId, opts: { pid?: number; eid?: number; display?: number; fullscreen?: boolean; clean?: boolean } = {}): number {
    if (!(PANELS as string[]).includes(panel)) throw new Error(`Unknown panel ${panel}`);
    const ctx = this.context();
    const pid = opts.pid ?? ctx.pid;
    const eid = opts.eid ?? ctx.eid;
    const clean = Boolean(opts.clean);
    const existing = [...this.panels.values()].find((p) => p.panel === panel && p.clean === clean && !p.win.isDestroyed());
    if (existing) {
      if (opts.display !== undefined || opts.fullscreen !== undefined) this.moveToDisplay(existing.win.id, opts.display ?? this.displayOf(existing.win).id, opts.fullscreen ?? clean);
      if ((pid !== undefined && pid !== existing.pid) || (eid !== undefined && eid !== existing.eid)) {
        existing.pid = pid;
        existing.eid = eid;
        void existing.win.loadURL(this.panelUrl(panel, pid, eid, clean));
      }
      existing.win.show();
      existing.win.focus();
      return existing.win.id;
    }
    const st = this.deps.config.get().windowState.panels[panel];
    const target = this.display(opts.display);
    const b = target ? centered(target, 1280, 760) : this.restoreBounds(st, 1280, 760, clean ? undefined : panel);
    const base: BrowserWindowConstructorOptions = {
      ...b, minWidth: 320, minHeight: 200, show: false, title: `${PANEL_TITLES[panel]} · Tatvam Studio`, frame: !clean,
      backgroundColor: clean ? "#000000" : "#0b0b0f", autoHideMenuBar: true, webPreferences: this.webPreferences(),
    };
    // the clean feed has no frame at all; framed panels get the shell's title bar
    const win = clean ? new BrowserWindow(base) : this.create("panel", base);
    const entry: PanelWin = { win, panel, clean, pid, eid };
    this.panels.set(win.id, entry);
    this.harden(win.webContents, win);
    if (!clean) {
      this.remember(win, panel);
      this.fadeOnClose(win);
    }
    const id = win.id;
    win.on("closed", () => { this.panels.delete(id); this.closing.delete(id); });
    win.once("ready-to-show", () => {
      const fs = opts.fullscreen ?? (clean || Boolean(!target && st?.fullscreen));
      if (clean || fs) win.show(); else this.fadeIn(win);
      if (fs) win.setFullScreen(true);
    });
    void win.loadURL(this.panelUrl(panel, pid, eid, clean));
    return id;
  }

  private panelUrl(panel: PanelId, pid?: number, eid?: number, clean?: boolean): string {
    const q = new URLSearchParams();
    if (pid !== undefined) q.set("pid", String(pid));
    if (eid !== undefined) q.set("eid", String(eid));
    q.set("clean", clean ? "1" : "0");
    return `${this.deps.gatewayUrl()}/desktop/panel/${panel}?${q}`;
  }

  list(): PanelWindowInfo[] {
    return [...this.panels.values()].filter((p) => !p.win.isDestroyed())
      .map((p) => ({ id: p.win.id, panel: p.panel, display: this.displayOf(p.win).id, fullscreen: p.win.isFullScreen() }));
  }

  /** The pop-out panels that are open (crash recovery reopens them). */
  openPanels(): { panel: PanelId; clean: boolean }[] {
    return [...this.panels.values()].filter((p) => !p.win.isDestroyed()).map((p) => ({ panel: p.panel, clean: p.clean }));
  }

  moveToDisplay(windowId: number, display: number, fullscreen?: boolean): void {
    const win = BrowserWindow.fromId(windowId);
    if (!win || win.isDestroyed()) throw new Error("No such window");
    const d = this.display(display);
    if (!d) throw new Error("That display isn't connected");
    const go = () => {
      const b = win.getBounds();
      win.setBounds(centered(d, Math.min(b.width, d.workArea.width), Math.min(b.height, d.workArea.height)));
      if (fullscreen) setTimeout(() => !win.isDestroyed() && win.setFullScreen(true), 50);
    };
    if (win.isFullScreen()) {
      win.once("leave-full-screen", () => setTimeout(go, 50));
      win.setFullScreen(false);
    } else {
      go();
    }
  }

  close(windowId: number): void {
    const p = this.panels.get(windowId);
    if (p && !p.win.isDestroyed()) p.win.close();
  }

  closeAllPanels(): void {
    for (const p of this.panels.values()) if (!p.win.isDestroyed()) p.win.close();
  }

  /** Send the program monitor to the next display (opens it when needed). */
  programToNextDisplay(): void {
    const all = this.sortedDisplays();
    const prog = [...this.panels.values()].find((p) => p.panel === "program" && !p.win.isDestroyed());
    if (!prog) {
      this.popOut("program", { display: all.length > 1 ? all[1].id : all[0].id, fullscreen: all.length > 1 });
      return;
    }
    const cur = this.displayOf(prog.win).id;
    const i = all.findIndex((d) => d.id === cur);
    const next = all[(i + 1) % all.length];
    this.moveToDisplay(prog.win.id, next.id, all.length > 1 && next.id !== screen.getPrimaryDisplay().id);
  }

  /**
   * Display hot-plug: windows left on a screen that's gone come back to the primary one; when a known arrangement
   * comes back (docking again), windows return to the bounds they had on it.
   */
  onDisplaysChanged(): void {
    const all = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const wins: [BrowserWindow, string | undefined][] = [
      ...(this.main && !this.main.isDestroyed() ? [[this.main, "main"] as [BrowserWindow, string]] : []),
      ...[...this.panels.values()].filter((p) => !p.win.isDestroyed()).map((p) => [p.win, p.clean ? undefined : p.panel] as [BrowserWindow, string | undefined]),
      ...(this.settingsWin && !this.settingsWin.isDestroyed() ? [[this.settingsWin, "settings"] as [BrowserWindow, string]] : []),
      ...[...this.editorWins].filter((w) => !w.isDestroyed()).map((w) => [w, "editor"] as [BrowserWindow, string]),
    ];
    for (const [w, key] of wins) {
      const here = key ? this.deps.boundsFor?.(key) : undefined;
      if (here?.bounds && !w.isFullScreen() && all.some((d) => visibleOn(d.workArea, here.bounds!))) {
        if (!w.isMaximized()) w.setBounds(here.bounds);
        continue;
      }
      if (all.some((d) => visibleOn(d.workArea, w.getBounds()))) continue;
      const move = () => w.setBounds(centered(primary, Math.min(w.getBounds().width, primary.workArea.width), Math.min(w.getBounds().height, primary.workArea.height)));
      if (w.isFullScreen()) { w.once("leave-full-screen", move); w.setFullScreen(false); } else move();
    }
  }

  /** Every window that shows a gateway page (bridge events go only there). */
  bridgeWindows(): BrowserWindow[] {
    return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && this.isGatewayUrl(w.webContents.getURL()));
  }

  broadcast(channel: string, payload: unknown): void {
    for (const w of this.bridgeWindows()) w.webContents.send(channel, payload);
  }

  sendToMain(channel: string, payload: unknown): void {
    const focused = BrowserWindow.getFocusedWindow();
    const target = focused && this.isGatewayUrl(focused.webContents.getURL()) ? focused : this.main;
    if (target && !target.isDestroyed()) target.webContents.send(channel, payload);
  }

  // ── workspaces ──
  workspaces(): Workspace[] {
    return this.deps.config.get().workspaces;
  }

  saveWorkspace(name: string): Workspace {
    const all = this.sortedDisplays();
    const idx = (w: BrowserWindow) => Math.max(0, all.findIndex((d) => d.id === this.displayOf(w).id));
    const panels: WorkspacePanel[] = [...this.panels.values()].filter((p) => !p.win.isDestroyed()).map((p) => ({
      panel: p.panel, display: idx(p.win), fullscreen: p.win.isFullScreen(), clean: p.clean, bounds: p.win.isFullScreen() ? undefined : p.win.getBounds(),
    }));
    const ws: Workspace = { id: `ws-${randomUUID().slice(0, 8)}`, name: name.trim().slice(0, 60) || "Workspace", builtIn: false,
      mainDisplay: this.main ? idx(this.main) : 0, panels };
    this.deps.config.set({ workspaces: [...this.workspaces(), ws] });
    return ws;
  }

  deleteWorkspace(id: string): void {
    if (BUILTIN_WORKSPACES.some((b) => b.id === id)) throw new Error("Built-in workspaces can't be deleted");
    this.deps.config.set({ workspaces: this.workspaces().filter((w) => w.id !== id) });
  }

  applyWorkspace(id: string): void {
    const ws = this.workspaces().find((w) => w.id === id);
    if (!ws) throw new Error("No such workspace");
    const all = this.sortedDisplays();
    const mainD = all[ws.mainDisplay ?? 0] ?? all[0];
    if (this.main && !this.main.isDestroyed() && this.displayOf(this.main).id !== mainD.id) this.moveToDisplay(this.main.id, mainD.id, false);
    const wanted = new Set(ws.panels.map((p) => `${p.panel}|${Boolean(p.clean)}`));
    for (const p of [...this.panels.values()]) if (!wanted.has(`${p.panel}|${p.clean}`) && !p.win.isDestroyed()) p.win.close();
    for (const p of ws.panels) {
      const d = all[p.display ?? 0];
      const target = d ?? all[0];
      // full screen only on a screen of its own, never over the main window
      const fullscreen = Boolean(p.fullscreen && d && d.id !== mainD.id);
      const existing = [...this.panels.values()].find((x) => x.panel === p.panel && x.clean === Boolean(p.clean) && !x.win.isDestroyed());
      if (existing) {
        if (this.displayOf(existing.win).id !== target.id || existing.win.isFullScreen() !== fullscreen) this.moveToDisplay(existing.win.id, target.id, fullscreen);
      } else {
        const wid = this.popOut(p.panel, { display: target.id, fullscreen, clean: p.clean });
        const win = BrowserWindow.fromId(wid);
        if (win && p.bounds && !fullscreen && intersects(target.workArea, p.bounds)) win.setBounds(p.bounds);
      }
    }
  }

  async exportWorkspaces(): Promise<string | null> {
    const opts: Electron.SaveDialogOptions = { title: "Export workspaces", defaultPath: "tatvam-workspaces.json", filters: [{ name: "Workspaces", extensions: ["json"] }] };
    const r = this.main ? await dialog.showSaveDialog(this.main, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, JSON.stringify({ format: "tatvam-workspaces", version: 1, workspaces: this.workspaces() }, null, 2), "utf8");
    return r.filePath;
  }

  async importWorkspaces(): Promise<number> {
    const opts: Electron.OpenDialogOptions = { title: "Import workspaces", properties: ["openFile"], filters: [{ name: "Workspaces", extensions: ["json"] }] };
    const r = this.main ? await dialog.showOpenDialog(this.main, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return 0;
    const raw = JSON.parse(readFileSync(r.filePaths[0], "utf8")) as { workspaces?: unknown };
    const list = (Array.isArray(raw) ? raw : raw.workspaces) as unknown[];
    if (!Array.isArray(list)) throw new Error("That file has no workspaces");
    const valid = list.filter((w): w is Workspace => typeof w === "object" && w !== null && typeof (w as Workspace).id === "string"
      && typeof (w as Workspace).name === "string" && Array.isArray((w as Workspace).panels))
      .map((w) => ({ ...w, builtIn: BUILTIN_WORKSPACES.some((b) => b.id === w.id),
        panels: w.panels.filter((p) => (PANELS as string[]).includes(p.panel)).map((p) => ({ ...p, display: Number(p.display) || 0 })) }));
    const byId = new Map(this.workspaces().map((w) => [w.id, w]));
    for (const w of valid) byId.set(w.id, w);
    this.deps.config.set({ workspaces: [...byId.values()] });
    return valid.length;
  }
}
