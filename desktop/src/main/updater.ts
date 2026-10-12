/**
 * Auto-update from GitHub Releases (electron-updater, provider settings from electron-builder.yml `publish`).
 * Only in the packaged app; in dev every call reports "disabled". The state carries the release notes when the updater
 * has them (the title bar pill, "What's new" and Settings → Updates show them); a failed check can be retried.
 */
import { app } from "electron";
import type { UpdateState } from "../shared/types.ts";

type AutoUpdater = typeof import("electron-updater").autoUpdater;

let state: UpdateState = { state: "disabled" };
let updater: AutoUpdater | null = null;
let notify: (s: UpdateState) => void = () => undefined;
let installOnQuit = true;

function set(s: UpdateState): void {
  state = { ...s, ...(s.releaseNotes === undefined && state.releaseNotes && s.version === state.version ? { releaseNotes: state.releaseNotes } : {}) };
  notify(state);
}

/** electron-updater's releaseNotes: a string, or a list of {version, note} for several releases. */
export function notesText(n: unknown): string | undefined {
  if (typeof n === "string") return n.trim() || undefined;
  if (Array.isArray(n)) {
    const s = n.map((x) => (x && typeof x === "object" ? `${(x as { version?: string }).version ?? ""}\n${(x as { note?: string }).note ?? ""}` : "")).join("\n\n").trim();
    return s || undefined;
  }
  return undefined;
}

export function updateState(): UpdateState {
  return state;
}

/** Install a downloaded update when the app quits (Settings → Updates). */
export function setAutoInstallOnQuit(on: boolean): void {
  installOnQuit = on;
  if (updater) updater.autoInstallOnAppQuit = on;
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
  autoUpdater.autoInstallOnAppQuit = installOnQuit;
  autoUpdater.logger = { info: (m: unknown) => log(`updater: ${m}`), warn: (m: unknown) => log(`updater: ${m}`), error: (m: unknown) => log(`updater error: ${m}`), debug: () => undefined } as never;
  autoUpdater.on("checking-for-update", () => set({ state: "checking", version: state.version }));
  autoUpdater.on("update-available", (i) => set({ state: "available", version: i.version, releaseNotes: notesText(i.releaseNotes) }));
  autoUpdater.on("update-not-available", (i) => set({ state: "none", version: i.version }));
  autoUpdater.on("download-progress", (p) => set({ state: "downloading", version: state.version, progress: Math.round(p.percent * 10) / 1000 }));
  autoUpdater.on("update-downloaded", (i) => set({ state: "ready", version: i.version, releaseNotes: notesText(i.releaseNotes) }));
  autoUpdater.on("error", (e) => set({ state: "error", version: state.version, error: String(e?.message || e) }));
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
