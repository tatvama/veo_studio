/**
 * AI assistants in Tatvam Desktop (docs/EDITOR.md §13), wired into Electron: the local MCP server (on when Settings →
 * AI assistants says so), tokens kept with safeStorage, the folder prompt in a window (or a native box), the editor
 * windows' side of tool calls, analysis for auto edit, watch folders, the activity log, and the `assistants` bridge
 * group (every call checks that it comes from a gateway page, as ipc.ts does).
 */
import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, webContents, type IpcMainInvokeEvent } from "electron";
import {
  ASSISTANTS_IPC, type AnalysisKindName, type AnalyzeMediaRef, type AssistantReply, type AssistantScope, type AssistantsState, type AutoEditStyle,
  type FolderAnswer, type FolderPromptRequest, type MediaAnalysis, type MediaItem, type WatchFolder,
} from "../../shared/types.ts";
import { AutoWatcher } from "../autowatch.ts";
import type { Config } from "../config.ts";
import type { EditorManager } from "../editor.ts";
import { runFfmpegLines } from "../editor-media.ts";
import type { FfmpegInfo } from "../ffmpeg.ts";
import * as notifyModule from "../notify.ts";
import type { RenderManager } from "../render.ts";
import { WHISPER_MODELS, type ToolManager } from "../tools.ts";
import type { WindowManager } from "../windows.ts";
import { ActivityLog } from "./activity.ts";
import { Analyzer } from "./analyze.ts";
import { FolderGuard } from "./folders.ts";
import { McpJobs } from "./jobs.ts";
import { EditorLink } from "./link.ts";
import { mediaKind } from "./security.ts";
import { AssistantServer } from "./server.ts";
import { AUTO_EDIT_STYLES, effectivePort, validPort } from "./settings.ts";
import { TokenStore, type Cipher } from "./tokens.ts";
import { folderMedia, type McpDeps } from "./tools.ts";

export interface AssistantsDeps {
  config: Config;
  editor: EditorManager;
  renders: RenderManager;
  windows: WindowManager;
  tools?: ToolManager;
  ff(): FfmpegInfo | null;
  userData: string;
  version: string;
  log(m: string): void;
}

const cipher: Cipher = {
  available: () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } },
  encrypt: (s) => safeStorage.encryptString(s).toString("base64"),
  decrypt: (b) => safeStorage.decryptString(Buffer.from(b, "base64")),
};

export class Assistants {
  readonly tokens: TokenStore;
  readonly activity: ActivityLog;
  readonly folders: FolderGuard;
  readonly link: EditorLink;
  readonly jobs = new McpJobs();
  readonly analyzer: Analyzer;
  readonly server: AssistantServer;
  readonly watcher: AutoWatcher;
  private promptHosts = new Map<number, number>();
  /** webContents whose destroy / navigation we follow */
  private hooked = new Set<number>();
  private native = new Map<string, AbortController>();
  private stateTimer: NodeJS.Timeout | null = null;
  private applying: Promise<void> = Promise.resolve();

  private deps: AssistantsDeps;

  constructor(deps: AssistantsDeps) {
    this.deps = deps;
    const log = deps.log;
    this.tokens = new TokenStore(path.join(deps.userData, "assistants-tokens.json"), cipher, log);
    this.activity = new ActivityLog(path.join(deps.userData, "assistants-activity.jsonl"));
    this.folders = new FolderGuard({
      libraryRoot: () => deps.config.get().libraryRoot,
      folders: () => deps.config.get().assistants.folders,
      addFolder: (f) => this.saveAssistants({ folders: [...deps.config.get().assistants.folders, f] }),
      show: (p) => this.showPrompt(p),
      close: (id) => this.closePrompt(id),
    });
    this.link = new EditorLink((windowId, call) => {
      const wc = webContents.fromId(windowId);
      if (!wc || wc.isDestroyed()) return false;
      wc.send(ASSISTANTS_IPC.call, call);
      return true;
    });
    this.analyzer = new Analyzer({
      analyze: (file, id, kind, opts) => deps.editor.analyze(file, id, kind, opts),
      transcribe: (file, id, opts) => deps.editor.transcribeLocal(file, id, opts),
      whisperModel: () => this.whisperModel(),
      ffmpegLines: (args, onLine, signal) => {
        const f = deps.ff();
        if (!f) return Promise.reject(new Error("FFmpeg wasn't found: set its path in File → Studio server…"));
        return runFfmpegLines(f.path, args, onLine, { signal });
      },
      log,
    });
    const mcp: McpDeps = {
      editor: {
        list: () => deps.editor.list(),
        create: (name, preset) => deps.editor.create(name, preset),
        save: (file, project) => deps.editor.save(file, project),
        importMedia: (file, files) => deps.editor.importMedia(file, files),
        export: (file, seq, opts) => deps.editor.export(file, seq, opts),
        allowEditFile: (file) => deps.editor.allowEditFile(file),
        editsRoot: () => deps.editor.editsRoot(),
      },
      renders: { presets: () => deps.renders.presets(), get: (id) => deps.renders.get(id), cancel: (id) => deps.renders.cancel(id) },
      link: this.link, folders: this.folders, jobs: this.jobs, analyzer: this.analyzer,
      libraryRoot: () => deps.config.get().libraryRoot,
      showEdit: (file) => this.showEdit(file),
      log,
    };
    this.server = new AssistantServer({ tokens: this.tokens, activity: this.activity, folders: this.folders, mcp, version: deps.version, log,
      onChange: () => this.changed() });
    this.watcher = new AutoWatcher({
      watches: () => deps.config.get().assistants.watches,
      known: (edit) => this.knownMedia(edit),
      deliver: (w, files) => this.deliverWatch(w, files),
      notify: (title, body, editPath) => this.notify(title, body, editPath),
      saveWatch: (id, patch) => this.saveAssistants({ watches: deps.config.get().assistants.watches.map((w) => (w.id === id ? { ...w, ...patch } : w)) }, false),
      log,
    });
    this.activity.onAdd(() => this.changed());
  }

  // ── life ──
  /** Start or stop the server to match the settings (and the watch folders). */
  apply(): Promise<void> {
    this.applying = this.applying.then(async () => {
      const s = this.deps.config.get().assistants;
      const port = effectivePort(s);
      if (s.enabled) await this.server.start(port).catch((e) => this.deps.log(`assistants: ${(e as Error).message}`));
      else if (this.server.running) await this.server.stop();
      this.watcher.sync();
      this.changed();
    }).catch((e) => this.deps.log(`assistants: ${(e as Error).message}`));
    return this.applying;
  }

  async stopAll(): Promise<void> {
    this.watcher.stopAll();
    for (const a of this.native.values()) a.abort();
    await this.server.stop().catch(() => undefined);
  }

  private saveAssistants(patch: Partial<ReturnType<Config["get"]>["assistants"]>, reapply = true): void {
    const cur = this.deps.config.get().assistants;
    this.deps.config.set({ assistants: { ...cur, ...patch } });
    if (reapply) void this.apply();
    else this.changed();
  }

  private whisperModel(): "base" | "large-v3-turbo-q5" | null {
    const t = this.deps.tools;
    if (!t || !(t.pathOf("whisper") || t.pathOf("whisper-cuda"))) return null;
    if (t.pathOf(WHISPER_MODELS["large-v3-turbo-q5"])) return "large-v3-turbo-q5";
    if (t.pathOf(WHISPER_MODELS.base)) return "base";
    return null;
  }

  command(): { exe: string; args: string[] } {
    return app.isPackaged ? { exe: process.execPath, args: ["--mcp-stdio"] } : { exe: process.execPath, args: [app.getAppPath(), "--mcp-stdio"] };
  }

  state(): AssistantsState {
    const s = this.deps.config.get();
    const port = this.server.running ? this.server.port : effectivePort(s.assistants);
    return {
      enabled: s.assistants.enabled, port, running: this.server.running, url: `http://127.0.0.1:${port}/mcp`,
      ...(this.server.error ? { error: this.server.error } : {}), paused: this.server.paused, tokens: this.tokens.infos(), folders: [...s.assistants.folders],
      libraryRoot: s.libraryRoot, sessions: this.server.sessionInfos(), watches: s.assistants.watches, command: this.command(), encrypted: cipher.available(),
    };
  }

  /** Coalesced: the banner and Settings get the state at most every 150 ms. */
  private changed(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.deps.windows.broadcast(ASSISTANTS_IPC.stateChange, this.state());
    }, 150);
  }

  private notify(title: string, body: string, editPath?: string): void {
    const fn = (notifyModule as { notify?: (n: { title: string; body?: string; kind?: string; tone?: string; target?: { editPath?: string } }) => unknown }).notify;
    const shown = fn?.({ title, body, kind: "system", tone: "info", ...(editPath ? { target: { editPath } } : {}) });
    if (shown) return;
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body, silent: false });
      n.on("click", () => { if (editPath) void this.showEdit(editPath).catch(() => undefined); });
      n.show();
    } catch (e) { this.deps.log(`notification: ${(e as Error).message}`); }
  }

  // ── windows ──
  /**
   * Shows an edit in an editor window (desktop-shell's openEditor: the window that has it, an idle main window, or a
   * new editor window) and resolves once that page's tool executor has attached the edit.
   */
  async showEdit(file: string): Promise<void> {
    this.deps.editor.allowEditFile(file);
    await this.deps.windows.openEditor(file, {
      timeoutMs: 45_000,
      whenReady: async () => { if (!(await this.link.waitFor(file, 40_000))) throw new Error("The editor window didn't attach the edit"); },
    });
  }

  private showPrompt(p: FolderPromptRequest): void {
    const hosts = [...this.promptHosts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => webContents.fromId(id)).filter((w) => w && !w.isDestroyed());
    const focused = BrowserWindow.getFocusedWindow()?.webContents;
    const target = hosts.find((w) => w === focused) ?? hosts[0];
    if (target) {
      target.send(ASSISTANTS_IPC.folderPrompt, p);
      const win = BrowserWindow.fromWebContents(target);
      if (win && !win.isFocused()) win.flashFrame(true);
      return;
    }
    // no window shows prompts: a native box, which times out with the prompt
    const ac = new AbortController();
    this.native.set(p.id, ac);
    const parent = this.deps.windows.main ?? undefined;
    const opts: Electron.MessageBoxOptions = { type: "question", title: "Tatvam Studio", buttons: ["Allow once", "Always allow", "Deny"], defaultId: 2, cancelId: 2,
      message: `${p.client} wants to use ${p.folder}`, detail: `${p.why}\n\nIt will be denied in 60 seconds if you don't answer.`, signal: ac.signal, noLink: true };
    void (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts)).then((r) => {
      this.native.delete(p.id);
      if (!ac.signal.aborted) this.folders.answer(p.id, (["once", "always", "deny"] as FolderAnswer[])[r.response] ?? "deny");
    }).catch(() => this.folders.answer(p.id, "deny"));
  }

  private closePrompt(id: string): void {
    this.native.get(id)?.abort();
    this.native.delete(id);
    for (const wid of this.promptHosts.keys()) webContents.fromId(wid)?.send(ASSISTANTS_IPC.folderPrompt, { id, closed: true });
  }

  // ── analysis and watch folders ──
  private async knownMedia(editPath: string): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      const p = JSON.parse(await fsp.readFile(editPath, "utf8")) as { media?: { path?: string }[] };
      const dir = path.dirname(editPath);
      for (const m of p.media ?? []) if (typeof m.path === "string" && !m.path.startsWith("studio:")) out.add(path.resolve(dir, m.path).toLowerCase());
    } catch { /* not saved yet */ }
    const open = this.link.windowFor(editPath);
    if (open) {
      try {
        const r = await this.link.call<{ data?: { media?: AnalyzeMediaRef[] } }>(editPath, "__media", { ids: null }, { client: "Tatvam", scopes: ["read"], timeoutMs: 10_000 });
        for (const m of r.data?.media ?? []) out.add(path.resolve(m.path).toLowerCase());
      } catch { /* the window is busy: the saved file is enough */ }
    }
    return out;
  }

  private async deliverWatch(w: WatchFolder, files: string[]): Promise<{ added: number; deferred?: boolean; edit: string }> {
    if (!existsSync(w.editPath)) throw new Error(`${w.editPath} wasn't found`);
    let open = this.link.windowFor(w.editPath);
    if (!open) {
      if (this.link.list().some((a) => a.dirty)) return { added: 0, deferred: true, edit: w.editPath };
      await this.showEdit(w.editPath).catch((e) => this.deps.log(`watch ${w.folder}: ${(e as Error).message}`));
      open = this.link.windowFor(w.editPath);
      if (!open) return { added: 0, deferred: true, edit: w.editPath };
    }
    const items = await this.deps.editor.importMedia(w.editPath, files);
    if (!items.length) return { added: 0, edit: w.editPath };
    const opts = { client: "Watch folder", scopes: ["read", "edit"] as AssistantScope[], timeoutMs: 120_000 };
    await this.link.call(w.editPath, "add_media", { items, bin: path.basename(w.folder) }, opts);
    // the clips to plan: the new ones (append) or every clip of this folder (rebuild)
    const refs = (await this.link.call<{ data?: { media?: AnalyzeMediaRef[] } }>(w.editPath, "__media", { ids: null }, opts)).data?.media ?? [];
    const plan = w.mode === "rebuild" ? refs.filter((m) => path.resolve(m.path).toLowerCase().startsWith(path.resolve(w.folder).toLowerCase())) : refs.filter((m) => items.some((i) => i.id === m.id));
    const analysis = await this.analyzer.run(w.editPath, plan, ["silence", "scenes", "loudness", "quality"]);
    const r = await this.link.call<{ data?: { added?: number } }>(w.editPath, "watch_batch", { style: w.style, mode: w.mode, folder: path.basename(w.folder),
      media_ids: plan.map((m) => m.id), new_ids: items.map((i) => i.id), analysis, options: w.options ?? {} }, opts);
    this.activity.add({ client: "Watch folder", tool: "watch_batch", ok: true, summary: `${items.length} new from ${w.folder} → ${path.basename(w.editPath)} (${w.mode})`, edit: w.editPath });
    return { added: Number(r.data?.added ?? 0), edit: w.editPath };
  }

  // ── the bridge ──
  registerIpc(): void {
    const wm = this.deps.windows;
    const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) => {
      ipcMain.handle(channel, async (e: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (!wm.isGatewayUrl(e.senderFrame?.url ?? "")) throw new Error("Not allowed from this page");
        return fn(e, ...args);
      });
    };
    const cfg = () => this.deps.config.get().assistants;
    handle(ASSISTANTS_IPC.state, () => this.state());
    handle(ASSISTANTS_IPC.setEnabled, async (_e, on: boolean) => {
      this.saveAssistants({ enabled: Boolean(on) }, false);
      this.activity.add({ client: "Tatvam", tool: on ? "enable" : "disable", ok: true, summary: on ? "AI assistants turned on" : "AI assistants turned off" });
      await this.apply();
      return this.state();
    });
    handle(ASSISTANTS_IPC.setPort, async (_e, port: number) => {
      const p = Number(port);
      if (!validPort(p) || p === this.deps.config.get().gatewayPort) throw new Error("Pick a port between 1024 and 65535 that the app doesn't use already");
      this.saveAssistants({ port: p }, false);
      await this.apply();
      return this.state();
    });
    handle(ASSISTANTS_IPC.createToken, (_e, name: string, scopes: AssistantScope[]) => {
      const r = this.tokens.create(String(name ?? ""), scopes);
      this.activity.add({ client: "Tatvam", tool: "token", ok: true, summary: `Token "${r.info.name}" made (${r.info.scopes.join(", ")})` });
      this.changed();
      return r;
    });
    handle(ASSISTANTS_IPC.revokeToken, async (_e, id: string) => {
      const info = this.tokens.infos().find((t) => t.id === String(id));
      if (this.tokens.revoke(String(id))) {
        await this.server.dropToken(String(id));
        this.activity.add({ client: "Tatvam", tool: "token", ok: true, summary: `Token "${info?.name ?? id}" revoked` });
      }
      return this.state();
    });
    handle(ASSISTANTS_IPC.tokenValue, (_e, id: string) => this.tokens.value(String(id)));
    handle(ASSISTANTS_IPC.addFolder, async (e) => {
      const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const opts: Electron.OpenDialogOptions = { title: "A folder AI assistants may use", properties: ["openDirectory"] };
      const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
      if (!r.canceled && r.filePaths[0]) this.saveAssistants({ folders: [...cfg().folders, r.filePaths[0]] }, false);
      return this.state();
    });
    handle(ASSISTANTS_IPC.removeFolder, (_e, folder: string) => {
      this.saveAssistants({ folders: cfg().folders.filter((f) => path.resolve(f).toLowerCase() !== path.resolve(String(folder)).toLowerCase()) }, false);
      return this.state();
    });
    handle(ASSISTANTS_IPC.activity, (_e, limit?: number) => this.activity.list(Number(limit) || 200));
    handle(ASSISTANTS_IPC.pause, (_e, on: boolean) => {
      this.server.setPaused(Boolean(on));
      this.activity.add({ client: "Tatvam", tool: on ? "pause" : "resume", ok: true, summary: on ? "The user paused assistants" : "The user resumed assistants" });
      return this.state();
    });
    handle(ASSISTANTS_IPC.stop, async (_e, id?: string) => { await this.server.stopSessions(typeof id === "string" && id ? id : undefined); return this.state(); });
    handle(ASSISTANTS_IPC.promptHost, (e, on: boolean) => {
      const id = e.sender.id;
      if (on) {
        this.promptHosts.set(id, Date.now());
        e.sender.once("destroyed", () => this.promptHosts.delete(id));
        for (const p of this.folders.pending()) e.sender.send(ASSISTANTS_IPC.folderPrompt, p); // one that opened before this window
      } else this.promptHosts.delete(id);
    });
    handle(ASSISTANTS_IPC.answerFolderPrompt, (_e, id: string, answer: FolderAnswer) => { this.folders.answer(String(id), answer); });
    handle(ASSISTANTS_IPC.chooseFolder, async (e) => {
      const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const opts: Electron.OpenDialogOptions = { title: "A folder of clips to auto edit", properties: ["openDirectory"] };
      const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths[0]) return null;
      return { folder: r.filePaths[0], ...(await folderMedia(r.filePaths[0])) };
    });
    handle(ASSISTANTS_IPC.listFolder, async (_e, folder: string, o?: { recursive?: boolean }) => {
      if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error("A folder is named by its full path");
      return { folder: path.resolve(folder), ...(await folderMedia(folder, { recursive: Boolean(o?.recursive) })) };
    });
    handle(ASSISTANTS_IPC.analyze, async (e, editPath: string, media: AnalyzeMediaRef[], kinds?: AnalysisKindName[]): Promise<MediaAnalysis[]> => {
      if (typeof editPath !== "string" || !editPath.toLowerCase().endsWith(".tatvamedit")) throw new Error("Analysis is for an edit's media");
      const refs = (Array.isArray(media) ? media : []).slice(0, 500).filter((m) => m && typeof m.id === "string" && typeof m.path === "string" && path.isAbsolute(m.path)
        && mediaKind(m.path) !== null);
      const sender = e.sender;
      return this.analyzer.run(editPath, refs, Array.isArray(kinds) && kinds.length ? kinds : undefined, {
        onProgress: (done, total, current) => { if (!sender.isDestroyed()) sender.send(ASSISTANTS_IPC.progress, { task: "analysis", done, total, current }); },
      });
    });
    handle(ASSISTANTS_IPC.addWatch, async (e, w: Partial<WatchFolder> & { style: AutoEditStyle; editPath: string; mode: WatchFolder["mode"] }) => {
      let folder = typeof w?.folder === "string" && path.isAbsolute(w.folder) ? w.folder : "";
      if (!folder) {
        const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined;
        const opts: Electron.OpenDialogOptions = { title: "A folder to watch for new clips", properties: ["openDirectory"] };
        const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
        if (r.canceled || !r.filePaths[0]) return this.state();
        folder = r.filePaths[0];
      }
      if (typeof w?.editPath !== "string" || !w.editPath.toLowerCase().endsWith(".tatvamedit")) throw new Error("A watch folder needs the edit its clips go into");
      const watch: WatchFolder = { id: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, folder: path.resolve(folder), editPath: path.resolve(w.editPath),
        style: AUTO_EDIT_STYLES.includes(w.style) ? w.style : "talking_head", mode: w.mode === "rebuild" ? "rebuild" : "append", on: w.on !== false,
        ...(w.options && typeof w.options === "object" ? { options: w.options } : {}) };
      this.deps.editor.allowEditFile(watch.editPath);
      // one watch per folder and edit: a second one updates it
      const same = cfg().watches.find((x) => x.folder.toLowerCase() === watch.folder.toLowerCase() && x.editPath.toLowerCase() === watch.editPath.toLowerCase());
      this.saveAssistants({ watches: same ? cfg().watches.map((x) => (x.id === same.id ? { ...watch, id: same.id } : x)) : [...cfg().watches, watch] });
      return this.state();
    });
    handle(ASSISTANTS_IPC.updateWatch, (_e, id: string, patch: Partial<WatchFolder>) => {
      const p = { ...(patch ?? {}) } as Partial<WatchFolder>;
      delete (p as { id?: string }).id;
      this.saveAssistants({ watches: cfg().watches.map((w) => (w.id === id ? { ...w, ...p } : w)) });
      return this.state();
    });
    handle(ASSISTANTS_IPC.removeWatch, (_e, id: string) => { this.saveAssistants({ watches: cfg().watches.filter((w) => w.id !== id) }); return this.state(); });
    // the editor window's side
    handle(ASSISTANTS_IPC.attach, (e, file: string, info: { name?: string; dirty?: boolean }) => {
      if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("attach takes the edit's full path");
      const wc = e.sender;
      this.link.attach(wc.id, file, info ?? {});
      if (!this.hooked.has(wc.id)) {
        const id = wc.id;
        this.hooked.add(id);
        wc.once("destroyed", () => { this.hooked.delete(id); this.link.gone(id); this.changed(); });
        wc.on("did-navigate", () => { this.link.gone(id); this.changed(); }); // a reload: the page attaches again
      }
      this.changed();
    });
    handle(ASSISTANTS_IPC.detach, (e, file: string) => { this.link.detach(e.sender.id, typeof file === "string" ? file : undefined); this.changed(); });
    handle(ASSISTANTS_IPC.reply, (e, id: string, r: AssistantReply) => { this.link.reply(e.sender.id, String(id), r); });
    handle(ASSISTANTS_IPC.jobUpdate, (_e, id: string, patch: { status?: string; progress?: number; message?: string; result?: unknown; error?: string }) => {
      const p = patch ?? {};
      const status = ["queued", "running", "awaiting_approval", "done", "failed", "cancelled"].includes(String(p.status)) ? (p.status as never) : undefined;
      this.jobs.update(String(id), { ...(status ? { status } : {}), ...(typeof p.progress === "number" ? { progress: p.progress } : {}),
        ...(typeof p.message === "string" ? { message: p.message.slice(0, 300) } : {}), ...(p.result !== undefined ? { result: p.result } : {}),
        ...(typeof p.error === "string" ? { error: p.error.slice(0, 1000) } : {}) });
    });
  }
}

/** The items an import gave, as analysis refs (create_edit from a folder, the Start window's auto edit). */
export const refsOf = (items: MediaItem[]): AnalyzeMediaRef[] => items.map((m) => ({ id: m.id, path: m.path, name: m.name, kind: m.kind, hasAudio: m.hasAudio,
  seconds: m.seconds, width: m.width, height: m.height }));
