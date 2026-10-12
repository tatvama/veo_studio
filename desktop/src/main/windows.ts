/**
 * Windows (docs/DESKTOP.md §4, §5): the main window, pop-out panels (`/desktop/panel/<panel>` on the gateway), the
 * display list, move to a display, the clean full-screen feed, workspaces and saved window state per display.
 * Every window is sandboxed with context isolation; only gateway-origin pages get the bridge, and navigation away
 * from the gateway opens in the system browser instead.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { BrowserWindow, dialog, screen, shell, type Display, type Rectangle, type WebContents } from "electron";
import type { Bounds, DisplayInfo, PanelId, PanelWindowInfo, WindowStateEntry, Workspace, WorkspacePanel } from "../shared/types.ts";
import type { Config } from "./config.ts";
import { BUILTIN_WORKSPACES } from "./config.ts";

export const PANELS: PanelId[] = ["program", "source", "timeline", "scopes", "mixer", "notes", "media", "renders", "bible"];
const PANEL_TITLES: Record<PanelId, string> = {
  program: "Program monitor", source: "Source monitor", timeline: "Timeline", scopes: "Scopes", mixer: "Mixer",
  notes: "Review notes", media: "Media", renders: "Renders", bible: "Bible",
};

export interface WindowDeps {
  config: Config;
  gatewayUrl(): string;
  preload: string;
  isPackaged: boolean;
  log(msg: string): void;
  /** Google sign-in in its own window (signin.ts). */
  signIn(parent: BrowserWindow): void;
}

interface PanelWin { win: BrowserWindow; panel: PanelId; clean: boolean; pid?: number; eid?: number }

function intersects(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
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

  constructor(deps: WindowDeps) {
    this.deps = deps;
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
  private restoreBounds(st: WindowStateEntry | undefined, w: number, h: number): Bounds {
    const all = screen.getAllDisplays();
    if (st?.bounds) {
      const d = all.find((x) => x.id === st.displayId) ?? all.find((x) => intersects(x.workArea, st.bounds!));
      if (d && intersects(d.workArea, st.bounds)) return st.bounds;
    }
    return centered(screen.getPrimaryDisplay(), w, h);
  }

  private remember(win: BrowserWindow, key: "main" | PanelId): void {
    const save = () => {
      if (win.isDestroyed()) return;
      const entry: WindowStateEntry = { bounds: win.isMaximized() || win.isFullScreen() ? undefined : win.getBounds(), displayId: this.displayOf(win).id,
        maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
      const cur = this.deps.config.get().windowState;
      const prevEntry = key === "main" ? cur.main : cur.panels[key];
      if (!entry.bounds && prevEntry?.bounds) entry.bounds = prevEntry.bounds;
      this.deps.config.set({ windowState: key === "main" ? { ...cur, main: entry } : { ...cur, panels: { ...cur.panels, [key]: entry } } });
    };
    const later = () => {
      const t = this.saveTimers.get(win.id);
      if (t) clearTimeout(t);
      this.saveTimers.set(win.id, setTimeout(save, 600));
    };
    win.on("resize", later);
    win.on("move", later);
    win.on("enter-full-screen", later);
    win.on("leave-full-screen", later);
    win.on("close", save);
  }

  // ── main window ──
  createMain(urlPath = "/"): BrowserWindow {
    const st = this.deps.config.get().windowState.main;
    const b = this.restoreBounds(st, 1440, 900);
    const win = new BrowserWindow({
      ...b, minWidth: 960, minHeight: 600, show: false, title: "Tatvam Studio", backgroundColor: "#0b0b0f", autoHideMenuBar: false,
      webPreferences: this.webPreferences(),
    });
    this.main = win;
    this.harden(win.webContents, win);
    this.remember(win, "main");
    if (st?.maximized) win.maximize();
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => {
      this.main = null;
      for (const p of this.panels.values()) if (!p.win.isDestroyed()) p.win.close();
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
      if (this.main.isMinimized()) this.main.restore();
      this.main.focus();
    }
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
    const b = target ? centered(target, 1280, 760) : this.restoreBounds(st, 1280, 760);
    const win = new BrowserWindow({
      ...b, minWidth: 320, minHeight: 200, show: false, title: `${PANEL_TITLES[panel]} · Tatvam Studio`, frame: !clean,
      backgroundColor: clean ? "#000000" : "#0b0b0f", autoHideMenuBar: true, webPreferences: this.webPreferences(),
    });
    const entry: PanelWin = { win, panel, clean, pid, eid };
    this.panels.set(win.id, entry);
    this.harden(win.webContents, win);
    if (!clean) this.remember(win, panel);
    const id = win.id;
    win.on("closed", () => this.panels.delete(id));
    win.once("ready-to-show", () => {
      win.show();
      const fs = opts.fullscreen ?? (clean || Boolean(!target && st?.fullscreen));
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

  /** Display hot-plug: windows left on a screen that's gone come back to the primary one. */
  onDisplaysChanged(): void {
    const all = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const wins = [this.main, ...[...this.panels.values()].map((p) => p.win)].filter((w): w is BrowserWindow => Boolean(w && !w.isDestroyed()));
    for (const w of wins) {
      if (all.some((d) => intersects(d.bounds, w.getBounds()))) continue;
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
