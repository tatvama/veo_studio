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

/** The project's pipeline rail collapses to icons below this width it is replaced by a strip. */
export const SIDEBAR_RAIL_MIN = 1024;

export const TOGGLE_RAIL_EVENT = "veo:toggle-rail";

/** Collapse / expand the project pipeline rail (the "[" key). Returns false when there is no rail on screen. */
export function toggleSidebar(): boolean {
  if (window.innerWidth < SIDEBAR_RAIL_MIN || !document.querySelector("[aria-label][data-pipeline-rail]")) return false;
  window.dispatchEvent(new CustomEvent(TOGGLE_RAIL_EVENT));
  return true;
}

/** True when the pipeline rail currently shows labels. */
export function sidebarExpanded(): boolean {
  return document.querySelector("[data-pipeline-rail]")?.getAttribute("data-collapsed") !== "1";
}
