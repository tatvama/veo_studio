/**
 * The Windows taskbar (desktop shell): a progress bar while renders, upscales and downloads run (red after a failure),
 * a Cancel button on the thumbnail toolbar during a render, an overlay badge while a job runs, and the Jump List (New
 * edit, New edit from folder, Open library, and the recent edits).
 */
import path from "node:path";
import { app, nativeImage, type BrowserWindow, type NativeImage } from "electron";
import type { JobsSummary } from "../shared/types.ts";
import { crossIcon, dotIcon, hexRgba } from "./shell-icons.ts";

export interface TaskbarDeps {
  main(): BrowserWindow | null;
  cancelRender(): void;
  showRenders(): void;
  accent(): string;
  log(msg: string): void;
}

const bitmap = (buf: Buffer, size: number): NativeImage => nativeImage.createFromBitmap(buf, { width: size, height: size });

/** argv for a Jump List task: the dev build needs the app folder before the link. */
function taskArgs(link: string): string {
  return app.isPackaged ? `"${link}"` : `"${app.getAppPath()}" "${link}"`;
}

export class Taskbar {
  private deps: TaskbarDeps;
  private lastKey = "";
  private thumbOn = false;
  private overlayOn = false;

  constructor(deps: TaskbarDeps) {
    this.deps = deps;
  }

  update(j: JobsSummary): void {
    const win = this.deps.main();
    if (!win || win.isDestroyed()) return;
    const active = j.running + j.queued > 0;
    const render = j.items.some((i) => i.kind === "render" && ["queued", "preparing", "downloading", "rendering"].includes(i.status));
    const key = `${active}|${j.progress === null ? "-" : Math.round(j.progress * 200)}|${j.error}|${render}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    try {
      if (active) win.setProgressBar(j.progress && j.progress > 0 ? j.progress : 2, { mode: j.error ? "error" : j.progress ? "normal" : "indeterminate" });
      else if (j.error) win.setProgressBar(1, { mode: "error" });
      else win.setProgressBar(-1);
      if (process.platform === "win32") {
        if (render !== this.thumbOn) {
          this.thumbOn = render;
          win.setThumbarButtons(render ? [
            { tooltip: "Cancel the render", icon: bitmap(crossIcon(32), 32), click: () => this.deps.cancelRender() },
            { tooltip: "Show the render queue", icon: bitmap(dotIcon(32, hexRgba(this.deps.accent())), 32), click: () => this.deps.showRenders() },
          ] : []);
        }
        if (active !== this.overlayOn) {
          this.overlayOn = active;
          win.setOverlayIcon(active ? bitmap(dotIcon(32, hexRgba(this.deps.accent())), 32) : null, active ? `${j.running} job${j.running === 1 ? "" : "s"} running` : "");
        }
      }
    } catch (e) {
      this.deps.log(`taskbar: ${(e as Error).message}`);
    }
  }

  /** The Jump List: tasks plus the recent edits (also given to Windows as recent documents). */
  jumpList(recent: { path: string; name: string }[]): void {
    if (process.platform !== "win32") return;
    const exe = process.execPath;
    const task = (title: string, description: string, link: string) => ({ type: "task" as const, title, description, program: exe, args: taskArgs(link),
      iconPath: exe, iconIndex: 0 });
    try {
      const r = app.setJumpList([
        ...(recent.length ? [{ type: "custom" as const, name: "Recent edits", items: recent.slice(0, 8).map((e) =>
          task(e.name, e.path, `tatvam://editor?path=${encodeURIComponent(e.path)}`)) }] : []),
        { type: "tasks" as const, items: [
          task("New edit", "Start a new edit in the Tatvam Editor", "tatvam://editor"),
          task("New edit from folder…", "Pick a folder of clips for a new edit", "tatvam://shell?action=new-edit-from-folder"),
          task("Open library", "The library folder in Explorer", "tatvam://shell?action=open-library"),
        ] },
      ]);
      if (r !== "ok") this.deps.log(`jump list: ${r}`);
    } catch (e) {
      this.deps.log(`jump list: ${(e as Error).message}`);
    }
  }

  recentDocument(file: string): void {
    try { if (path.isAbsolute(file)) app.addRecentDocument(file); } catch { /* not registered */ }
  }
}
