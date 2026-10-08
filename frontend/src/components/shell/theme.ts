/**
 * Theme (dark | light | system) and motion (full | reduced) preferences, applied to <html> as
 * data-theme / data-motion. index.html runs the same logic inline before React mounts, so there is no flash.
 * Persisted locally here; components/shell/prefs.ts also syncs them to /api/me/prefs.
 */
import { useSyncExternalStore } from "react";

export type ThemePref = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";
export type MotionPref = "full" | "reduced";

export const THEME_KEY = "veo-theme";
export const MOTION_KEY = "veo-motion";
export const THEME_COLORS: Record<ResolvedTheme, string> = { dark: "#0a0b0f", light: "#f5f3ee" };

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

const media = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

let themePref: ThemePref = read<ThemePref>(THEME_KEY, ["dark", "light", "system"], "dark");
let motionPref: MotionPref = read<MotionPref>(MOTION_KEY, ["full", "reduced"], "full");
let resolved: ResolvedTheme = resolve();
const listeners = new Set<() => void>();

function resolve(): ResolvedTheme {
  if (themePref === "system") return media?.matches ? "light" : "dark";
  return themePref;
}

function apply() {
  resolved = resolve();
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  root.dataset.motion = motionPref;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", THEME_COLORS[resolved]));
  listeners.forEach((l) => l());
}

media?.addEventListener?.("change", () => { if (themePref === "system") apply(); });
if (typeof document !== "undefined") apply();

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

export function getThemePref(): ThemePref { return themePref; }
export function getResolvedTheme(): ResolvedTheme { return resolved; }
export function getMotionPref(): MotionPref { return motionPref; }

export function applyThemePref(p: ThemePref) {
  if (!["dark", "light", "system"].includes(p)) return;
  themePref = p;
  write(THEME_KEY, p);
  apply();
}

export function applyMotionPref(p: MotionPref) {
  if (p !== "full" && p !== "reduced") return;
  motionPref = p;
  write(MOTION_KEY, p);
  apply();
}

/** Next theme in the dark → light → system cycle. */
export function nextTheme(p: ThemePref): ThemePref {
  return p === "dark" ? "light" : p === "light" ? "system" : "dark";
}

export const useThemePref = () => useSyncExternalStore(subscribe, getThemePref, () => "dark" as ThemePref);
export const useResolvedTheme = () => useSyncExternalStore(subscribe, getResolvedTheme, () => "dark" as ResolvedTheme);
export const useMotionPref = () => useSyncExternalStore(subscribe, getMotionPref, () => "full" as MotionPref);
