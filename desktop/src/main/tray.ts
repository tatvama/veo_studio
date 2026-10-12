/**
 * The tray icon (desktop shell): shown while jobs run (the default), always, or never. Its menu lists the job queue
 * with progress, "Open Tatvam" and Quit. With "Keep rendering when the window is closed", closing the main window
 * during a render hides it here and the render carries on.
 */
import { Menu, nativeImage, Tray, type NativeImage } from "electron";
import type { JobsSummary, ShellPrefs } from "../shared/types.ts";
import { appIcon, hexRgba } from "./shell-icons.ts";

export interface TrayDeps {
  prefs(): ShellPrefs;
  icon(): NativeImage | null;
  accent(): string;
  open(): void;
  quit(): void;
  /** the main window is hidden in the tray right now */
  hidden(): boolean;
  log(msg: string): void;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

export class TrayIcon {
  private deps: TrayDeps;
  private tray: Tray | null = null;
  private lastMenu = "";

  constructor(deps: TrayDeps) {
    this.deps = deps;
  }

  update(j: JobsSummary): void {
    const mode = this.deps.prefs().tray;
    const busy = j.running + j.queued > 0;
    const want = mode === "always" || this.deps.hidden() || (mode === "auto" && busy);
    if (!want) {
      if (this.tray) { this.tray.destroy(); this.tray = null; this.lastMenu = ""; }
      return;
    }
    try {
      if (!this.tray) {
        const img = this.deps.icon() ?? nativeImage.createFromBitmap(appIcon(32, hexRgba(this.deps.accent())), { width: 32, height: 32 });
        this.tray = new Tray(img.resize({ width: 16, height: 16 }));
        this.tray.on("click", () => this.deps.open());
      }
      const active = j.items.filter((i) => !["done", "failed", "cancelled", "idle"].includes(i.status));
      this.tray.setToolTip(busy ? `Tatvam Studio · ${j.running} running${j.queued ? `, ${j.queued} queued` : ""}${j.progress !== null ? ` · ${pct(j.progress)}` : ""}` : "Tatvam Studio");
      const sig = JSON.stringify(active.map((i) => [i.label, Math.round(i.progress * 20), i.status]));
      if (sig === this.lastMenu) return;
      this.lastMenu = sig;
      this.tray.setContextMenu(Menu.buildFromTemplate([
        { label: busy ? "Job queue" : "No jobs running", enabled: false },
        ...active.slice(0, 8).map((i) => ({ label: `${i.label} · ${i.status === "queued" ? "queued" : pct(i.progress)}`, enabled: false })),
        { type: "separator" },
        { label: "Open Tatvam", click: () => this.deps.open() },
        { label: "Quit", click: () => this.deps.quit() },
      ]));
    } catch (e) {
      this.deps.log(`tray: ${(e as Error).message}`);
    }
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
