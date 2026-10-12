/**
 * The `assistants` block of settings.json (docs/EDITOR.md §13): off by default, the port, the folders assistants may
 * use besides the library root, and the watch folders. Pure (config.ts calls it while sanitizing).
 */
import path from "node:path";
import type { AssistantsSettings, AutoEditStyle, WatchFolder } from "../../shared/types.ts";

export const DEFAULT_MCP_PORT = 18110;
export const AUTO_EDIT_STYLES: AutoEditStyle[] = ["talking_head", "montage", "documentary", "highlights", "slideshow"];

export const defaultAssistants = (): AssistantsSettings => ({ enabled: false, port: DEFAULT_MCP_PORT, folders: [], watches: [] });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A port assistants may use: unprivileged, and never the gateway's. */
export const validPort = (p: unknown): p is number => typeof p === "number" && Number.isInteger(p) && p > 1023 && p < 65536;

function sanitizeWatch(w: unknown): WatchFolder | null {
  if (!isObj(w)) return null;
  if (typeof w.id !== "string" || !/^[A-Za-z0-9_-]{4,40}$/.test(w.id)) return null;
  if (typeof w.folder !== "string" || !path.isAbsolute(w.folder)) return null;
  if (typeof w.editPath !== "string" || !path.isAbsolute(w.editPath) || !w.editPath.toLowerCase().endsWith(".tatvamedit")) return null;
  const style = AUTO_EDIT_STYLES.includes(w.style as AutoEditStyle) ? (w.style as AutoEditStyle) : "talking_head";
  const out: WatchFolder = { id: w.id, folder: w.folder, editPath: w.editPath, style, mode: w.mode === "rebuild" ? "rebuild" : "append", on: w.on !== false };
  if (isObj(w.options)) out.options = JSON.parse(JSON.stringify(w.options)) as Record<string, unknown>;
  if (typeof w.lastRun === "string") out.lastRun = w.lastRun;
  if (typeof w.lastCount === "number" && Number.isFinite(w.lastCount)) out.lastCount = w.lastCount;
  if (typeof w.lastError === "string") out.lastError = w.lastError.slice(0, 300);
  return out;
}

/** Known keys with the right types over the defaults. */
export function sanitizeAssistants(input: unknown, base: AssistantsSettings = defaultAssistants()): AssistantsSettings {
  const a: AssistantsSettings = { ...base, folders: [...base.folders], watches: [...base.watches] };
  if (!isObj(input)) return a;
  if (typeof input.enabled === "boolean") a.enabled = input.enabled;
  if (validPort(input.port)) a.port = input.port;
  if (Array.isArray(input.folders)) {
    const seen = new Set<string>();
    a.folders = input.folders.filter((d): d is string => typeof d === "string" && path.isAbsolute(d))
      .map((d) => path.resolve(d)).filter((d) => { const k = d.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 50);
  }
  if (Array.isArray(input.watches)) a.watches = input.watches.map(sanitizeWatch).filter((w): w is WatchFolder => w !== null).slice(0, 20);
  return a;
}

/** The port for this run: TATVAM_MCP_PORT wins (tests), else the setting. */
export function effectivePort(s: AssistantsSettings, env: Record<string, string | undefined> = process.env): number {
  const e = Number(env.TATVAM_MCP_PORT);
  return validPort(e) ? e : s.port;
}
