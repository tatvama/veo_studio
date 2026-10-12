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

/** The bridge's error text without Electron's "Error invoking remote method …" prefix. */
export function bridgeMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e ?? "");
  return m.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "") || "failed";
}
