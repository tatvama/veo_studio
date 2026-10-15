/**
 * settings.json in userData (docs/DESKTOP.md §4): defaults, validation and atomic writes.
 * Electron-free: index.ts passes the userData and Documents folders in.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AppearanceSettings, DesktopSettings, Workspace } from "../shared/types.ts";
import { DEFAULT_TEMPLATES } from "./naming.ts";
import { defaultAssistants, sanitizeAssistants } from "./mcp/settings.ts";

export const DEFAULT_GATEWAY_PORT = 18100;

export const BUILTIN_WORKSPACES: Workspace[] = [
  { id: "edit", name: "Edit", builtIn: true, mainDisplay: 0, panels: [{ panel: "program", display: 1, fullscreen: true }] },
  { id: "colour", name: "Colour", builtIn: true, mainDisplay: 0, panels: [{ panel: "program", display: 1, fullscreen: true }, { panel: "scopes", display: 0 }] },
  { id: "audio", name: "Audio", builtIn: true, mainDisplay: 0, panels: [{ panel: "mixer", display: 0 }, { panel: "program", display: 1, fullscreen: true }] },
  { id: "review", name: "Review", builtIn: true, mainDisplay: 0, panels: [{ panel: "program", display: 1, fullscreen: true }, { panel: "notes", display: 0 }] },
  { id: "story", name: "Story", builtIn: true, mainDisplay: 0, panels: [{ panel: "bible", display: 1 }, { panel: "media", display: 0 }] },
];

export const DEFAULT_SERVER_URL = "http://localhost:8100";

export function defaultSettings(opts: { documents: string; env?: Record<string, string | undefined> }): DesktopSettings {
  const env = opts.env ?? process.env;
  let serverUrl = DEFAULT_SERVER_URL;
  if (env.TATVAM_SERVER) {
    try { serverUrl = normalizeServerUrl(env.TATVAM_SERVER); } catch { /* a plain-http address off this PC: the app starts on the default and the Studio server window says why */ }
  }
  return {
    serverUrl,
    gatewayPort: DEFAULT_GATEWAY_PORT,
    uiSource: "bundled",
    appearance: { ...DEFAULT_APPEARANCE },
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
    editorBackups: { auto: true, minutes: 10 },
    lutFolders: [],
    assistants: defaultAssistants(),
  };
}

/** Appearance defaults (docs/DESKTOP.md, desktop shell): dark, the Windows accent, comfortable, 100 %, Mica. */
export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: "dark", accent: "system", density: "comfortable", scale: 100, reduceMotion: false, highContrast: false, material: "mica",
};

/** Keep known appearance keys with the right types over `base`. */
export function sanitizeAppearance(input: unknown, base: AppearanceSettings = DEFAULT_APPEARANCE): AppearanceSettings {
  const a: AppearanceSettings = { ...base };
  if (typeof input !== "object" || input === null || Array.isArray(input)) return a;
  const o = input as Record<string, unknown>;
  if (o.theme === "dark" || o.theme === "light" || o.theme === "system") a.theme = o.theme;
  if (typeof o.accent === "string" && (o.accent === "system" || o.accent === "tatvam" || /^#[0-9a-fA-F]{6}$/.test(o.accent))) a.accent = o.accent.toLowerCase();
  if (o.density === "comfortable" || o.density === "compact") a.density = o.density;
  if (typeof o.scale === "number" && Number.isFinite(o.scale)) a.scale = Math.min(150, Math.max(80, Math.round(o.scale / 5) * 5));
  if (typeof o.reduceMotion === "boolean") a.reduceMotion = o.reduceMotion;
  if (typeof o.highContrast === "boolean") a.highContrast = o.highContrast;
  if (o.material === "mica" || o.material === "acrylic" || o.material === "none") a.material = o.material;
  return a;
}

/**
 * Screens from the server are opt-in (docs/DESKTOP.md §4.3): for a while "auto" was written as the default, so a
 * settings file whose `uiSource` is "auto" or "server" without the user's choice (`uiSourceChosen`, set by the Studio
 * server window) moves back to "bundled". A chosen source stays.
 */
export function migrateSettings(stored: unknown): { value: unknown; migrated: boolean } {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return { value: stored, migrated: false };
  const o = stored as Record<string, unknown>;
  if ((o.uiSource === "auto" || o.uiSource === "server") && o.uiSourceChosen !== true) return { value: { ...o, uiSource: "bundled" }, migrated: true };
  return { value: stored, migrated: false };
}

/** localhost, *.localhost, 127.0.0.0/8 and ::1: a server on this PC, the only place plain http is allowed. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "::ffff:127.0.0.1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * The server origin from what the user typed. Every call to the server carries the session cookie and the gateway runs
 * the server's answers (and, when chosen, its screens), so a server that isn't on this PC must be reached over https:
 * a bare host name gets https://, and an explicit http:// off loopback is refused with a message the Studio server
 * window shows.
 */
export function normalizeServerUrl(u: string): string {
  const s = u.trim().replace(/\/+$/, "");
  const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  let url = new URL(explicit ? s : `http://${s}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The server address must start with https:// (or http:// for a server on this PC)");
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    if (explicit) throw new Error(`${url.host} must be reached over https://: plain http is only allowed for a server on this PC (localhost)`);
    url = new URL(`https://${s}`);
  }
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
  if (input.uiSource === "bundled" || input.uiSource === "server" || input.uiSource === "auto") s.uiSource = input.uiSource;
  if (typeof input.uiSourceChosen === "boolean") s.uiSourceChosen = input.uiSourceChosen;
  s.appearance = sanitizeAppearance(input.appearance, s.appearance);
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
  if (isObj(input.editorBackups)) {
    const b = input.editorBackups;
    if (typeof b.auto === "boolean") s.editorBackups.auto = b.auto;
    if (typeof b.minutes === "number" && Number.isFinite(b.minutes)) s.editorBackups.minutes = Math.min(120, Math.max(5, Math.round(b.minutes)));
  }
  if (Array.isArray(input.lutFolders)) s.lutFolders = input.lutFolders.filter((d): d is string => typeof d === "string" && path.isAbsolute(d)).slice(0, 50);
  if (isObj(input.assistants)) s.assistants = sanitizeAssistants(input.assistants, s.assistants);
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
    const m = migrateSettings(stored);
    this.value = sanitize(m.value, this.defaults);
    if (!stored || m.migrated) this.save();
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
