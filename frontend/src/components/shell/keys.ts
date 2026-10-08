import { useUI } from "../../lib/store";

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
/** Label for the platform's command modifier. */
export const MOD = IS_MAC ? "⌘" : "Ctrl";

/** True when the key event comes from somewhere the user is typing (so single-key shortcuts must not fire). */
export function isTypingTarget(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  if (!n || !n.tagName) return false;
  const tag = n.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (n as HTMLInputElement).type;
    return !["checkbox", "radio", "range", "button", "submit", "reset", "color", "file"].includes(type);
  }
  return n.isContentEditable;
}

/** Open the Director panel and focus its input (on narrow screens it replaces the shot drawer). */
export function openDirector() {
  const ui = useUI.getState();
  ui.setAgentOpen(true);
  if (window.innerWidth < 1760) ui.setSelectedShot(null);
  setTimeout(() => document.getElementById("agent-input")?.focus(), 80);
}

/** The sidebar is a slide-over (opened by the Shell) below this width; above it can be expanded or collapsed. */
export const SIDEBAR_RAIL_MIN = 1100;

/** True when the desktop sidebar currently shows labels (same rule as the Shell: saved choice, else wide screens). */
export function sidebarExpanded(): boolean {
  const s = useUI.getState();
  return window.innerWidth >= SIDEBAR_RAIL_MIN && (s.railExpanded ?? window.innerWidth >= 1440);
}

/** Expand / collapse the desktop sidebar like the "[" key does. Returns false when the viewport is too narrow for it. */
export function toggleSidebar(): boolean {
  if (window.innerWidth < SIDEBAR_RAIL_MIN) return false;
  const s = useUI.getState();
  s.setRailExpanded(!(s.railExpanded ?? window.innerWidth >= 1440));
  return true;
}
