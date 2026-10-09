/** UI colours for things drawn on the canvas (selection, guides, safe areas), read from the theme's CSS tokens. */
import { useSyncExternalStore } from "react";

export interface CanvasColors {
  accent: string;
  guide: string;
  gap: string;
  safe: string;
  ai: string;
  warn: string;
  onAccent: string;
  handleFill: string;
}

const FALLBACK: CanvasColors = {
  accent: "#22d3ee", guide: "#f472b6", gap: "#f472b6", safe: "#fbbf24", ai: "#a78bfa", warn: "#fbbf24", onAccent: "#021016", handleFill: "#ffffff",
};

let current: CanvasColors | null = null;
const subs = new Set<() => void>();
let observer: MutationObserver | null = null;

function read(): CanvasColors {
  if (typeof document === "undefined") return FALLBACK;
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => s.getPropertyValue(name).trim() || fb;
  return {
    accent: v("--color-accent", FALLBACK.accent),
    guide: v("--pst-guide", FALLBACK.guide),
    gap: v("--pst-gap", FALLBACK.gap),
    safe: v("--pst-safe", FALLBACK.safe),
    ai: v("--color-ai", FALLBACK.ai),
    warn: v("--color-warn", FALLBACK.warn),
    onAccent: v("--on-accent", FALLBACK.onAccent),
    handleFill: v("--pst-handle", FALLBACK.handleFill),
  };
}

function subscribe(cb: () => void) {
  subs.add(cb);
  if (!observer && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(() => { current = read(); subs.forEach((s) => s()); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  }
  return () => {
    subs.delete(cb);
    if (!subs.size && observer) { observer.disconnect(); observer = null; }
  };
}

export function useCanvasColors(): CanvasColors {
  return useSyncExternalStore(subscribe, () => (current ??= read()), () => FALLBACK);
}
