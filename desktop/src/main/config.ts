/**
 * settings.json in userData (docs/DESKTOP.md §4): defaults, validation and atomic writes.
 * Electron-free: index.ts passes the userData and Documents folders in.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DesktopSettings, Workspace } from "../shared/types.ts";
import { DEFAULT_TEMPLATES } from "./naming.ts";

export const DEFAULT_GATEWAY_PORT = 18100;

export const BUILTIN_WORKSPACES: Workspace[] = [
  { id: "edit", name: "Edit", builtIn: true, mainDisplay: 0, panels: [{ panel: "program", display: 1, fullscreen: true }] },
  { id: "colour", name: "Colour", builtIn: true, mainDisplay: 0, panels: [{ panel: "program", display: 1, fullscreen: true }, { panel: "scopes", display: 0 }] },
  { id: "audio", name: "Audio", builtIn: true, mainDisplay: 0, panels: [{ panel: "mixer", display: 0 }, { panel: "program", display: 1, fullscreen: true }] },
  { id: "review", name: "Review", builtIn: true, mainDisplay: 0, panels: [{ panel: "program", display: 1, fullscreen: true }, { panel: "notes", display: 0 }] },
  { id: "story", name: "Story", builtIn: true, mainDisplay: 0, panels: [{ panel: "bible", display: 1 }, { panel: "media", display: 0 }] },
];

export function defaultSettings(opts: { documents: string; env?: Record<string, string | undefined> }): DesktopSettings {
  const env = opts.env ?? process.env;
  return {
    serverUrl: normalizeServerUrl(env.TATVAM_SERVER || "http://localhost:8100"),
    gatewayPort: DEFAULT_GATEWAY_PORT,
    uiSource: "bundled",
    libraryRoot: path.join(opts.documents, "Tatvam Projects"),
    projectFolders: {},
    naming: { ...DEFAULT_TEMPLATES },
    pullScope: "approved",
    proxyMode: false,
    encoder: { prefer: "auto", hevc10bit: true, intermediateCq: 16 },
    ffmpegPath: "",
    workspaces: BUILTIN_WORKSPACES.map((w) => structuredClone(w)),
    windowState: { panels: {} },
    autoSync: true,
    watching: {},
  };
}

export function normalizeServerUrl(u: string): string {
  const s = u.trim().replace(/\/+$/, "");
  const url = new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`);
  return url.origin;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Merge a stored (or patched) object over the defaults, keeping only known keys with the right types. */
export function sanitize(input: unknown, defaults: DesktopSettings): DesktopSettings {
  const s: DesktopSettings = structuredClone(defaults);
  if (!isObj(input)) return s;
  if (typeof input.serverUrl === "string") {
    try { s.serverUrl = normalizeServerUrl(input.serverUrl); } catch { /* keep the default */ }
  }
  if (typeof input.gatewayPort === "number" && Number.isInteger(input.gatewayPort) && input.gatewayPort > 1023 && input.gatewayPort < 65536) {
    s.gatewayPort = input.gatewayPort;
  }
  if (input.uiSource === "bundled" || input.uiSource === "server") s.uiSource = input.uiSource;
  if (typeof input.libraryRoot === "string" && input.libraryRoot.trim()) s.libraryRoot = input.libraryRoot;
  if (isObj(input.projectFolders)) {
    s.projectFolders = Object.fromEntries(Object.entries(input.projectFolders).filter(([k, v]) => /^\d+$/.test(k) && typeof v === "string" && v)) as Record<string, string>;
  }
  if (isObj(input.naming)) {
    for (const [k, v] of Object.entries(input.naming)) if (typeof v === "string" && v.trim()) s.naming[k] = v;
  }
  if (input.pullScope === "approved" || input.pullScope === "cut") s.pullScope = input.pullScope;
  if (typeof input.proxyMode === "boolean") s.proxyMode = input.proxyMode;
  if (isObj(input.encoder)) {
    const e = input.encoder;
    if (["auto", "nvenc", "qsv", "amf", "software"].includes(e.prefer as string)) s.encoder.prefer = e.prefer as DesktopSettings["encoder"]["prefer"];
    if (typeof e.hevc10bit === "boolean") s.encoder.hevc10bit = e.hevc10bit;
    if (typeof e.intermediateCq === "number" && e.intermediateCq >= 0 && e.intermediateCq <= 51) s.encoder.intermediateCq = Math.round(e.intermediateCq);
  }
  if (typeof input.ffmpegPath === "string") s.ffmpegPath = input.ffmpegPath;
  if (Array.isArray(input.workspaces)) {
    const ws = input.workspaces.filter((w): w is Workspace => isObj(w) && typeof w.id === "string" && typeof w.name === "string" && Array.isArray(w.panels));
    // built-ins always exist (a saved copy of one keeps the user's edits)
    const ids = new Set(ws.map((w) => w.id));
    s.workspaces = [...BUILTIN_WORKSPACES.filter((b) => !ids.has(b.id)).map((b) => structuredClone(b)), ...ws];
  }
  if (isObj(input.windowState)) {
    s.windowState = { ...(isObj(input.windowState.main) ? { main: input.windowState.main as never } : {}),
      panels: isObj(input.windowState.panels) ? (input.windowState.panels as never) : {} };
  }
  if (typeof input.autoSync === "boolean") s.autoSync = input.autoSync;
  if (isObj(input.watching)) {
    s.watching = Object.fromEntries(Object.entries(input.watching).filter(([k, v]) => /^\d+$/.test(k) && typeof v === "number")) as Record<string, number>;
  }
  return s;
}

/** Write a file atomically: a temp file next to it, then rename over it. */
export function writeFileAtomic(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, file);
}

export class Config {
  readonly file: string;
  private defaults: DesktopSettings;
  private value: DesktopSettings;
  private listeners = new Set<(s: DesktopSettings, prev: DesktopSettings) => void>();

  constructor(userData: string, documents: string, env: Record<string, string | undefined> = process.env) {
    this.file = path.join(userData, "settings.json");
    this.defaults = defaultSettings({ documents, env });
    let stored: unknown = undefined;
    if (existsSync(this.file)) {
      try { stored = JSON.parse(readFileSync(this.file, "utf8")); } catch { stored = undefined; }
    }
    this.value = sanitize(stored, this.defaults);
    if (!stored) this.save();
  }

  get(): DesktopSettings {
    return structuredClone(this.value);
  }

  /** Shallow patch (objects like `naming` or `encoder` are merged one level). */
  set(patch: Partial<DesktopSettings>): DesktopSettings {
    const prev = this.value;
    const merged: Record<string, unknown> = { ...prev };
    for (const [k, v] of Object.entries(patch ?? {})) {
      const cur = (prev as unknown as Record<string, unknown>)[k];
      merged[k] = isObj(v) && isObj(cur) && k !== "projectFolders" && k !== "watching" ? { ...cur, ...v } : v;
    }
    this.value = sanitize(merged, this.defaults);
    this.save();
    for (const l of this.listeners) l(this.get(), prev);
    return this.get();
  }

  onChange(fn: (s: DesktopSettings, prev: DesktopSettings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.value, null, 2));
  }
}
