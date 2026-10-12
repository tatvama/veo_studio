/**
 * Applies the desktop appearance (theme, accent, density, motion, contrast, backdrop) to this window through CSS
 * variables and data attributes on <html>. The theme and motion go through components/shell/theme.ts, so the studio's
 * own theme switch and this one stay the same setting. Scale is the window zoom (set by the main process).
 */
import { applyMotionPref, applyThemePref, getMotionPref, getThemePref } from "../components/shell/theme";
import type { AppearanceState } from "../lib/desktop";

/** Relative luminance of #rrggbb (0..1). */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 0.5;
  const c = [m[1], m[2], m[3]].map((x) => {
    const v = parseInt(x, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

let lastTheme: string | null = null;

/** The theme this window applied from the desktop setting last (so a change made in the studio can be told apart). */
export const appliedTheme = () => lastTheme;

export function applyAppearance(s: AppearanceState, opts: { pinDark?: boolean } = {}): void {
  const root = document.documentElement;
  if (!opts.pinDark && getThemePref() !== s.theme) applyThemePref(s.theme);
  lastTheme = s.theme;
  const motion = s.reduceMotion ? "reduced" : "full";
  if (getMotionPref() !== motion) applyMotionPref(motion);
  root.dataset.density = s.density;
  root.dataset.contrast = s.highContrast ? "high" : "normal";
  root.dataset.material = s.materialInUse;
  root.dataset.desktop = "1";
  const st = root.style;
  if (s.accent === "tatvam") {
    for (const v of ["--color-accent", "--color-accent-ink", "--desk-accent"]) st.removeProperty(v);
    root.removeAttribute("data-accent-dark");
    root.removeAttribute("data-accent-custom");
  } else {
    const a = s.accentColor;
    st.setProperty("--color-accent", a);
    st.setProperty("--desk-accent", a);
    // accent as text: lighter on the dark ground, deeper on the light one (AA on panels)
    st.setProperty("--color-accent-ink", `color-mix(in srgb, ${a} ${s.dark ? 62 : 72}%, ${s.dark ? "white" : "black"})`);
    root.setAttribute("data-accent-custom", "1");
    if (luminance(a) < 0.32) root.setAttribute("data-accent-dark", "1"); else root.removeAttribute("data-accent-dark");
  }
}
