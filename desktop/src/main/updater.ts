/**
 * Auto-update from GitHub Releases (electron-updater, provider settings from electron-builder.yml `publish`).
 * Only in the packaged app; in dev every call reports "disabled".
 */
import { app } from "electron";
import type { UpdateState } from "../shared/types.ts";

type AutoUpdater = typeof import("electron-updater").autoUpdater;

let state: UpdateState = { state: "disabled" };
let updater: AutoUpdater | null = null;
let notify: (s: UpdateState) => void = () => undefined;

function set(s: UpdateState): void {
  state = s;
  notify(state);
}

export function updateState(): UpdateState {
  return state;
}

export async function initUpdater(onChange: (s: UpdateState) => void, log: (m: string) => void): Promise<void> {
  notify = onChange;
  if (!app.isPackaged || process.env.TATVAM_NO_UPDATES === "1") {
    set({ state: "disabled" });
    return;
  }
  const { autoUpdater } = await import("electron-updater");
  updater = autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m: unknown) => log(`updater: ${m}`), warn: (m: unknown) => log(`updater: ${m}`), error: (m: unknown) => log(`updater error: ${m}`), debug: () => undefined } as never;
  autoUpdater.on("checking-for-update", () => set({ state: "checking" }));
  autoUpdater.on("update-available", (i) => set({ state: "available", version: i.version }));
  autoUpdater.on("update-not-available", (i) => set({ state: "none", version: i.version }));
  autoUpdater.on("download-progress", (p) => set({ state: "downloading", version: state.version, progress: Math.round(p.percent * 10) / 1000 }));
  autoUpdater.on("update-downloaded", (i) => set({ state: "ready", version: i.version }));
  autoUpdater.on("error", (e) => set({ state: "error", error: String(e?.message || e) }));
  set({ state: "idle" });
  setTimeout(() => void checkForUpdates(), 15_000).unref?.();
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!updater) return state;
  try {
    await updater.checkForUpdates();
  } catch (e) {
    set({ state: "error", error: String((e as Error).message || e) });
  }
  return state;
}

export function installNow(): void {
  if (updater && state.state === "ready") updater.quitAndInstall();
}
