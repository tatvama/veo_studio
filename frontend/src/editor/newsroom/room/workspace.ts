/**
 * Opening the News Room workspace (docs/EDITOR.md §16.8). The editor lays out its current workspace when it opens
 * (workspaces.ts restoreWorkspace), so "New news edit" makes "news" the current one just before it opens the edit.
 * Uses the same saved key as workspaces.ts (which has no setter for a closed editor).
 */
const KEY = "tatvam-editor:workspaces:v1";

export function openNextInNewsWorkspace() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { current?: string; layouts?: Record<string, unknown>; custom?: unknown[] } | null;
    const v = raw && typeof raw === "object" ? raw : {};
    localStorage.setItem(KEY, JSON.stringify({ layouts: {}, custom: [], ...v, current: "news" }));
  } catch { /* storage blocked: the edit opens in the last workspace */ }
}
