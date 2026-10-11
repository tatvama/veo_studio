/**
 * The "Studio server" window (File → Studio server…, or the button in the Finishing room): the server address, where
 * the UI comes from and which FFmpeg to use. These settings decide where the session cookie goes and which program
 * runs, so the web UI can't change them through the bridge: only this native window can, and its IPC answers only it.
 */
import { BrowserWindow, dialog, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { CONNECT_IPC } from "../shared/types.ts";
import { normalizeServerUrl, type Config } from "./config.ts";
import { ffmpegVersion, type FfmpegInfo } from "./ffmpeg.ts";
import { COOKIE } from "./upstream.ts";

export interface ConnectDeps {
  config: Config;
  gatewayUrl(): string;
  appVersion: string;
  preload: string;
  ff(): FfmpegInfo | null;
  /** The main window, reloaded after a change of server or UI source. */
  main(): BrowserWindow | null;
  log(msg: string): void;
}

/** Health check of a studio server: {ok, version} or the reason it can't be reached. */
export async function testServer(raw: string, timeoutMs = 6000): Promise<{ ok: boolean; url?: string; version?: string; error?: string }> {
  let url: string;
  try {
    url = normalizeServerUrl(raw);
  } catch {
    return { ok: false, error: "That isn't a web address" };
  }
  try {
    const r = await fetch(`${url}/api/health/live`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, url, error: `The server answered ${r.status}` };
    const body = (await r.json().catch(() => ({}))) as { version?: string };
    return { ok: true, url, version: body.version ?? "" };
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "No answer within 6 seconds" : (e as Error).message;
    return { ok: false, url, error: msg };
  }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Studio server</title><style>
:root{color-scheme:dark;font:13px/1.45 "Segoe UI",system-ui,sans-serif}
body{margin:0;padding:20px 22px;background:#0f0f14;color:#e7e7ee}
h1{font-size:15px;font-weight:600;margin:0 0 4px}p{margin:0 0 14px;color:#9a9aab}
label{display:block;font-weight:600;margin:14px 0 6px}
input[type=text]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:7px;border:1px solid #2c2c38;background:#16161e;color:inherit;font:inherit}
.row{display:flex;gap:8px;align-items:center}.row input{flex:1}
button{padding:7px 12px;border-radius:7px;border:1px solid #2c2c38;background:#1d1d27;color:inherit;font:inherit;cursor:pointer}
button.primary{background:#f97316;border-color:#f97316;color:#111;font-weight:600}
.note{font-size:12px;color:#9a9aab;margin-top:6px;min-height:17px}.ok{color:#4ade80}.bad{color:#f87171}
.seg{display:flex;gap:6px}.seg label{font-weight:400;margin:0;display:flex;gap:6px;align-items:center}
footer{display:flex;justify-content:space-between;align-items:center;margin-top:22px}
</style></head><body>
<h1>Studio server</h1><p>The Tatvam server this app works with. Your login, approvals and costs live there.</p>
<label for="url">Server address</label>
<div class="row"><input id="url" type="text" spellcheck="false" placeholder="https://studio.example.com"><button id="test">Test</button></div>
<div id="testNote" class="note"></div>
<label>Interface</label>
<div class="seg"><label><input type="radio" name="ui" value="bundled"> Built into this app (works offline)</label>
<label><input type="radio" name="ui" value="server"> From the server (always its newest)</label></div>
<label>FFmpeg</label>
<div class="row"><input id="ff" type="text" readonly><button id="pick">Choose…</button><button id="auto">Find automatically</button></div>
<div id="ffNote" class="note"></div>
<footer><span class="note" id="meta"></span><span class="row"><button id="cancel">Cancel</button><button id="save" class="primary">Save</button></span></footer>
<script>
const api = window.tatvamConnect; const $ = (id) => document.getElementById(id);
let ffPath = "";
function setNote(el, text, tone) { el.textContent = text; el.className = "note" + (tone ? " " + tone : ""); }
api.get().then((s) => {
  $("url").value = s.serverUrl; ffPath = s.ffmpegPath;
  $("ff").value = s.ffmpegPath || (s.ffmpeg ? s.ffmpeg.path : "");
  setNote($("ffNote"), s.ffmpeg ? "FFmpeg " + s.ffmpeg.version + " (" + (s.ffmpegPath ? "chosen" : s.ffmpeg.source) + ")" : "No FFmpeg found: renders and proxies need one", s.ffmpeg ? "" : "bad");
  document.querySelector('input[name=ui][value="' + s.uiSource + '"]').checked = true;
  $("meta").textContent = "Tatvam Studio " + s.appVersion + " · " + s.gatewayUrl;
});
$("test").onclick = async () => {
  setNote($("testNote"), "Testing…");
  const r = await api.test($("url").value);
  setNote($("testNote"), r.ok ? "Reached " + r.url + (r.version ? " (v" + r.version + ")" : "") : (r.error || "Not reachable"), r.ok ? "ok" : "bad");
};
$("pick").onclick = async () => {
  const r = await api.chooseFfmpeg(); if (!r) return;
  if (r.error) { setNote($("ffNote"), r.error, "bad"); return; }
  ffPath = r.path; $("ff").value = r.path; setNote($("ffNote"), "FFmpeg " + r.version + " (chosen)", "ok");
};
$("auto").onclick = () => { ffPath = ""; $("ff").value = ""; setNote($("ffNote"), "The app will use its own FFmpeg"); };
$("cancel").onclick = () => api.close();
$("save").onclick = async () => {
  const ui = document.querySelector("input[name=ui]:checked").value;
  const r = await api.save({ serverUrl: $("url").value, uiSource: ui, ffmpegPath: ffPath });
  if (r.error) setNote($("testNote"), r.error, "bad"); else api.close();
};
</script></body></html>`;

let current: BrowserWindow | null = null;

export function openConnectionWindow(deps: ConnectDeps, parent?: BrowserWindow | null): BrowserWindow {
  if (current && !current.isDestroyed()) {
    current.focus();
    return current;
  }
  const win = new BrowserWindow({
    width: 560, height: 470, resizable: false, minimizable: false, maximizable: false, title: "Studio server",
    backgroundColor: "#0f0f14", parent: parent ?? undefined, modal: !!parent, show: false, autoHideMenuBar: true,
    webPreferences: { preload: deps.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  current = win;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => { if (current === win) current = null; });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  return win;
}

/** IPC for the Studio server window; each call must come from that window. */
export function registerConnectIpc(deps: ConnectDeps): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown) => {
    ipcMain.handle(channel, async (e: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!current || current.isDestroyed() || e.sender.id !== current.webContents.id) throw new Error("Not allowed from this page");
      return fn(...args);
    });
  };
  handle(CONNECT_IPC.get, () => {
    const s = deps.config.get();
    const f = deps.ff();
    return { serverUrl: s.serverUrl, uiSource: s.uiSource, ffmpegPath: s.ffmpegPath, gatewayUrl: deps.gatewayUrl(), appVersion: deps.appVersion,
      ffmpeg: f ? { path: f.path, version: f.version, source: f.source } : null };
  });
  handle(CONNECT_IPC.test, (raw: string) => testServer(String(raw ?? "")));
  handle(CONNECT_IPC.chooseFfmpeg, async () => {
    const r = await dialog.showOpenDialog(current!, { title: "Choose ffmpeg.exe", properties: ["openFile"],
      filters: process.platform === "win32" ? [{ name: "FFmpeg", extensions: ["exe"] }] : [] });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    const v = ffmpegVersion(p);
    if (!v.version) return { error: `${path.basename(p)} doesn't run as FFmpeg` };
    return { path: p, version: v.version };
  });
  handle(CONNECT_IPC.save, async (patch: { serverUrl?: string; uiSource?: string; ffmpegPath?: string }) => {
    const prev = deps.config.get();
    let serverUrl = prev.serverUrl;
    if (typeof patch?.serverUrl === "string") {
      try { serverUrl = normalizeServerUrl(patch.serverUrl); } catch { return { error: "That isn't a web address" }; }
    }
    const uiSource = patch?.uiSource === "server" ? "server" : "bundled";
    const ffmpegPath = typeof patch?.ffmpegPath === "string" ? patch.ffmpegPath : prev.ffmpegPath;
    if (ffmpegPath && !ffmpegVersion(ffmpegPath).version) return { error: "That FFmpeg doesn't run" };
    deps.config.set({ serverUrl, uiSource, ffmpegPath });
    if (serverUrl !== prev.serverUrl) {
      // the session belongs to the old server: sign in again on the new one
      await session.defaultSession.cookies.remove(deps.gatewayUrl(), COOKIE).catch(() => undefined);
      deps.log(`server changed: ${prev.serverUrl} → ${serverUrl}`);
    }
    if (serverUrl !== prev.serverUrl || uiSource !== prev.uiSource) {
      const m = deps.main();
      if (m && !m.isDestroyed()) m.webContents.reloadIgnoringCache();
    }
    return { ok: true };
  });
  handle(CONNECT_IPC.close, () => { current?.close(); });
}
