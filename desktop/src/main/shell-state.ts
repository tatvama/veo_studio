/**
 * The desktop shell's own state, `userData/shell.json` (kept apart from settings.json): notification and tray
 * preferences, first-run onboarding, the version that last ran ("What's new" after an update), the last session for
 * crash recovery, and window bounds per monitor arrangement. Pure and Electron-free (test/shell.test.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import type { Bounds, NotificationKind, ShellPrefs, ShellState, WindowStateEntry } from "../shared/types.ts";
import { writeFileAtomic } from "./config.ts";

export const NOTIFICATION_KINDS: NotificationKind[] = ["render", "ai", "sync", "update", "download", "system"];

export const DEFAULT_PREFS: ShellPrefs = {
  notifications: { render: true, ai: true, sync: true, update: true, download: true, system: true, native: true },
  tray: "auto", keepRendering: true, autoInstallOnQuit: true, restoreWindows: true,
};

export interface SessionInfo { at: string; url?: string; panels: string[]; editPath?: string }

export interface ShellFile {
  prefs: ShellPrefs;
  onboarded: boolean;
  offlineOnly: boolean;
  /** the app version of the last run */
  lastVersion?: string;
  /** true from start until a clean quit */
  running: boolean;
  session?: SessionInfo;
  /** {display arrangement: {window key: state}} */
  bounds: Record<string, Record<string, WindowStateEntry>>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function sanitizePrefs(input: unknown, base: ShellPrefs = DEFAULT_PREFS): ShellPrefs {
  const p: ShellPrefs = structuredClone(base);
  if (!isObj(input)) return p;
  if (isObj(input.notifications)) {
    for (const k of [...NOTIFICATION_KINDS, "native"] as const) {
      const v = input.notifications[k];
      if (typeof v === "boolean") p.notifications[k] = v;
    }
  }
  if (input.tray === "auto" || input.tray === "always" || input.tray === "off") p.tray = input.tray;
  for (const k of ["keepRendering", "autoInstallOnQuit", "restoreWindows"] as const) if (typeof input[k] === "boolean") p[k] = input[k] as boolean;
  return p;
}

function isBounds(b: unknown): b is Bounds {
  return isObj(b) && ["x", "y", "width", "height"].every((k) => typeof b[k] === "number" && Number.isFinite(b[k] as number)) && (b.width as number) > 50 && (b.height as number) > 50;
}

export function sanitizeShell(input: unknown): ShellFile {
  const o = isObj(input) ? input : {};
  const bounds: ShellFile["bounds"] = {};
  if (isObj(o.bounds)) {
    for (const [sig, wins] of Object.entries(o.bounds).slice(0, 20)) {
      if (!isObj(wins)) continue;
      const m: Record<string, WindowStateEntry> = {};
      for (const [k, e] of Object.entries(wins)) {
        if (!isObj(e)) continue;
        m[k] = { ...(isBounds(e.bounds) ? { bounds: e.bounds } : {}), ...(typeof e.displayId === "number" ? { displayId: e.displayId } : {}),
          maximized: Boolean(e.maximized), fullscreen: Boolean(e.fullscreen) };
      }
      bounds[sig] = m;
    }
  }
  const s = isObj(o.session) ? o.session : null;
  return {
    prefs: sanitizePrefs(o.prefs),
    onboarded: o.onboarded === true,
    offlineOnly: o.offlineOnly === true,
    ...(typeof o.lastVersion === "string" ? { lastVersion: o.lastVersion } : {}),
    running: o.running === true,
    ...(s ? { session: { at: typeof s.at === "string" ? s.at : new Date(0).toISOString(), ...(typeof s.url === "string" ? { url: s.url } : {}),
      panels: Array.isArray(s.panels) ? s.panels.filter((x): x is string => typeof x === "string").slice(0, 12) : [],
      ...(typeof s.editPath === "string" ? { editPath: s.editPath } : {}) } } : {}),
    bounds,
  };
}

/** The arrangement of displays as a key: ids and sizes, sorted (a laptop alone and docked to two screens differ). */
export function displaySignature(displays: { id: number; bounds: Bounds }[]): string {
  return displays.map((d) => `${d.id}:${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height}`).sort().join("|");
}

/** Does a saved rectangle still show on one of these work areas (at least 80×40 pixels of it)? */
export function boundsVisible(b: Bounds, areas: Bounds[]): boolean {
  return areas.some((a) => {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return w >= 80 && h >= 40;
  });
}

export class ShellStore {
  readonly file: string;
  private value: ShellFile;
  /** what was on disk at start: the previous run */
  readonly previous: ShellFile;
  private listeners = new Set<(s: ShellFile) => void>();

  constructor(file: string) {
    this.file = file;
    let raw: unknown;
    if (existsSync(file)) {
      try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { raw = undefined; }
    }
    this.value = sanitizeShell(raw);
    this.previous = structuredClone(this.value);
  }

  get(): ShellFile {
    return structuredClone(this.value);
  }

  set(patch: Partial<ShellFile>): ShellFile {
    const next = { ...this.value, ...patch };
    if (patch.prefs) next.prefs = sanitizePrefs(patch.prefs, this.value.prefs);
    this.value = sanitizeShell(next);
    this.save();
    for (const l of this.listeners) l(this.get());
    return this.get();
  }

  onChange(fn: (s: ShellFile) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The renderer's view: prefs, onboarding, the update since the last run, and a crash of the last run. */
  state(appVersion: string, opts: { crashDismissed?: boolean } = {}): ShellState {
    const prev = this.previous;
    const crashed = prev.running && !opts.crashDismissed && prev.session ? { at: prev.session.at, ...(prev.session.url ? { url: prev.session.url } : {}),
      panels: prev.session.panels, ...(prev.session.editPath ? { editPath: prev.session.editPath } : {}) } : undefined;
    return {
      prefs: this.value.prefs, onboarded: this.value.onboarded, offlineOnly: this.value.offlineOnly, appVersion,
      ...(prev.lastVersion && prev.lastVersion !== appVersion ? { updatedFrom: prev.lastVersion } : {}),
      ...(crashed ? { crashed } : {}),
    };
  }

  private save(): void {
    try { writeFileAtomic(this.file, JSON.stringify(this.value, null, 2)); } catch { /* read-only profile: keep in memory */ }
  }
}

/** The CHANGELOG.md section of a version ("## [3.1.0](…) (2026-10-12)" up to the next "## "), else the first one. */
export function changelogSection(md: string, version: string): string {
  const parts = md.split(/\n(?=## )/);
  const sections = parts.filter((p) => p.startsWith("## "));
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hit = sections.find((s) => new RegExp(`^## \\[?v?${esc}\\]?(\\(|\\s|$)`).test(s)) ?? sections[0];
  return hit ? hit.trim() : "";
}
