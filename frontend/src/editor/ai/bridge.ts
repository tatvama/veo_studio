/**
 * The desktop bridge calls the AI tools use (`window.tatvamDesktop.editor`, docs/EDITOR.md §5 and §8; typed in
 * lib/desktop.ts). Each may be missing: an older desktop build or a plain browser simply doesn't have it, and the tools
 * fall back (upload from the media's URL, play results from the studio) or say what is missing.
 */
import { desktop, type EditorBridge } from "../../lib/desktop";

export type EditorAiBridge = Partial<Pick<EditorBridge, "uploadAsset" | "importStudioAsset" | "analyze">>;

export function editorBridge(): EditorAiBridge | null {
  return (desktop()?.editor as EditorAiBridge | undefined) ?? null;
}

export const canAnalyze = () => typeof editorBridge()?.analyze === "function";

/** A local version of the edit on this PC (desktop-tools' version-history bridge; loosely typed until it lands). */
export interface LocalVersion { id: string; created?: string; modified?: string; size?: number; label?: string; clip_count?: number }

/** The desktop's version history and backup calls (docs/EDITOR.md §10: `editor.versions(path)` / `restoreVersion(path,
 *  id)`, plus `backupNow`). Each is feature-detected: missing in a browser and in desktop builds without them. */
export interface VersionsBridge {
  backupNow?(path: string): Promise<unknown>;
  versions?(path: string): Promise<LocalVersion[] | { versions: LocalVersion[] }>;
  restoreVersion?(path: string, id: string): Promise<unknown>;
}

export function versionsBridge(): VersionsBridge | null {
  return (desktop()?.editor as unknown as VersionsBridge | undefined) ?? null;
}

/** This computer's name for a backup's "device" (the desktop reports it; a browser says so). */
export async function deviceName(): Promise<string> {
  try {
    const info = await desktop()?.info?.();
    if (info?.machine) return info.machine.slice(0, 120);
  } catch { /* an older desktop build */ }
  return desktop() ? "Tatvam Desktop" : `Browser${typeof navigator !== "undefined" && navigator.platform ? ` (${navigator.platform})` : ""}`;
}

/** The bridge's error text without Electron's "Error invoking remote method …" prefix. */
export function bridgeMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e ?? "");
  return m.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "") || "failed";
}
