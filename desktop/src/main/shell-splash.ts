/**
 * The splash window (desktop shell): shown at once while the app starts, with the real steps (settings, gateway,
 * offline screens, the main window) and closed when the main window is ready. No preload, no bridge: the main
 * process writes the progress into it.
 */
import { BrowserWindow } from "electron";

const PAGE = (version: string) => `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%;background:#05070b;color:#e9eef7;font:13px/1.4 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;overflow:hidden;-webkit-app-region:drag;user-select:none}
.wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 34px;
 background:radial-gradient(120% 90% at 0% 0%,rgba(34,211,238,.12),transparent 60%),radial-gradient(90% 80% at 100% 100%,rgba(129,140,248,.12),transparent 60%)}
.brand{font-weight:700;letter-spacing:.14em;font-size:20px;background:linear-gradient(90deg,#67e8f9,#818cf8);-webkit-background-clip:text;color:transparent}
.sub{color:#9ba8bd;font-size:12px;margin-top:2px}
.bar{margin-top:26px;height:3px;border-radius:2px;background:#172033;overflow:hidden}
.bar i{display:block;height:100%;width:4%;background:linear-gradient(90deg,#22d3ee,#818cf8);transition:width .25s cubic-bezier(.22,1,.36,1)}
.step{margin-top:10px;color:#74829b;font-size:11.5px;min-height:16px}
.ver{position:absolute;right:16px;bottom:12px;color:#4b5870;font:11px/1 "JetBrains Mono",Consolas,monospace}
@media (prefers-reduced-motion: reduce){.bar i{transition:none}}
</style></head><body><div class="wrap"><div class="brand">TATVAM STUDIO</div><div class="sub">The finishing room</div>
<div class="bar"><i id="b"></i></div><div class="step" id="s">Starting…</div></div><div class="ver">v${version}</div>
<script>window.step=function(t,p){document.getElementById("s").textContent=t;document.getElementById("b").style.width=Math.max(4,Math.min(100,p))+"%";};</script>
</body></html>`;

export class Splash {
  private win: BrowserWindow | null;
  private last = { text: "Starting…", pct: 4 };

  constructor(version: string) {
    this.win = new BrowserWindow({
      width: 440, height: 240, frame: false, resizable: false, movable: true, show: false, skipTaskbar: false, center: true,
      backgroundColor: "#05070b", title: "Tatvam Studio", webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
    });
    const w = this.win;
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("will-navigate", (e) => e.preventDefault());
    w.once("ready-to-show", () => { if (!w.isDestroyed()) { w.show(); this.push(); } });
    void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE(version))}`);
  }

  step(text: string, pct: number): void {
    this.last = { text, pct };
    this.push();
  }

  private push(): void {
    const w = this.win;
    if (!w || w.isDestroyed() || w.webContents.isLoading()) return;
    void w.webContents.executeJavaScript(`window.step && window.step(${JSON.stringify(this.last.text)}, ${Number(this.last.pct) || 0})`).catch(() => undefined);
  }

  close(): void {
    const w = this.win;
    this.win = null;
    if (!w || w.isDestroyed()) return;
    this.last = { text: "Ready", pct: 100 };
    let o = 1;
    const t = setInterval(() => {
      if (w.isDestroyed()) { clearInterval(t); return; }
      o -= 0.2;
      if (o <= 0) { clearInterval(t); w.destroy(); return; }
      w.setOpacity(o);
    }, 16);
  }
}
