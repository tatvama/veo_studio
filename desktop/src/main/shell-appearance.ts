/**
 * Appearance of every window (desktop shell): the Windows 11 look (Mica / acrylic backdrop where the OS has it, a solid
 * colour elsewhere), the custom title bar's overlay colours (the system window buttons and snap layouts stay), the
 * system accent colour, and the zoom that carries the UI scale. The pure parts are tested in test/shell.test.ts.
 */
import os from "node:os";
import type { AppearanceSettings, AppearanceState } from "../shared/types.ts";

export const BRAND_ACCENT = "#22d3ee";
export const TITLE_BAR_HEIGHT = 32;

/** Windows 11 22H2 (build 22621) and later draw Mica and acrylic behind a window. */
export function materialSupported(platform: string = process.platform, release: string = os.release()): boolean {
  if (platform !== "win32") return false;
  const build = Number(release.split(".")[2] ?? 0);
  return build >= 22621;
}

/** Electron's systemPreferences.getAccentColor() is "rrggbbaa": → "#rrggbb" (null when it isn't a colour). */
export function accentHex(raw: string | null | undefined): string | null {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(raw ?? "").trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

export function resolveAccent(a: Pick<AppearanceSettings, "accent">, systemAccent: string | null): string {
  if (a.accent === "system") return systemAccent ?? BRAND_ACCENT;
  if (a.accent === "tatvam") return BRAND_ACCENT;
  return /^#[0-9a-f]{6}$/i.test(a.accent) ? a.accent.toLowerCase() : BRAND_ACCENT;
}

/** The theme's ground colours (index.css --color-bg / --color-panel / --color-ink). */
export const GROUND = {
  dark: { bg: "#05070b", panel: "#0a0e15", ink: "#e9eef7", mute: "#9ba8bd" },
  light: { bg: "#e9edf4", panel: "#ffffff", ink: "#0b1220", mute: "#44516a" },
};

/** The title bar overlay (window buttons): transparent over Mica / acrylic, the panel colour otherwise. */
export function overlayFor(dark: boolean, material: AppearanceState["materialInUse"], highContrast = false): { color: string; symbolColor: string; height: number } {
  const g = dark ? GROUND.dark : GROUND.light;
  return { color: material === "none" ? g.panel : "#00000000", symbolColor: highContrast ? (dark ? "#ffffff" : "#000000") : g.ink, height: TITLE_BAR_HEIGHT };
}

export function appearanceState(a: AppearanceSettings, env: { dark: boolean; systemAccent: string | null; platform?: string; release?: string; chrome?: boolean }): AppearanceState {
  const supported = materialSupported(env.platform, env.release);
  return {
    ...a,
    dark: env.dark,
    accentColor: resolveAccent(a, env.systemAccent),
    systemAccent: env.systemAccent,
    materialSupported: supported,
    materialInUse: supported && !a.highContrast ? a.material : "none",
    titleBarHeight: env.chrome === false ? 0 : TITLE_BAR_HEIGHT,
    platform: env.platform ?? process.platform,
  };
}

/**
 * CSS the main process puts into every window with the custom title bar, before (and whatever) the page renders: the
 * top strip is a drag region, the page sits below it, and over Mica the ground behind the title bar is see-through.
 * The page's desktop kit (frontend/src/desktop) draws the title bar's contents and the status bar into these strips.
 */
export function chromeCss(s: Pick<AppearanceState, "materialInUse" | "titleBarHeight">): string {
  const h = s.titleBarHeight;
  return `
:root { --desk-title-h: ${h}px; }
html, body { background: ${s.materialInUse === "none" ? "var(--color-bg, #05070b)" : "transparent"} !important; }
body::before { content: ""; position: fixed; z-index: 0; top: 0; left: 0; right: 0; height: var(--desk-title-h); -webkit-app-region: drag; }
#root { position: fixed !important; left: 0; right: 0; top: var(--desk-title-h); bottom: var(--desk-status-h, 0px); height: auto !important;
  background: var(--color-bg, #05070b); }
.ed-root.fixed { top: var(--desk-title-h) !important; bottom: var(--desk-status-h, 0px) !important; }
`;
}
