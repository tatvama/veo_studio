/**
 * Opening the News Room workspace (docs/EDITOR.md §16.8). The editor lays out its current workspace when it opens
 * (workspaces.ts restoreWorkspace), so "New news edit" makes "news" the current one just before it opens the edit.
 */
import { setCurrentWorkspace } from "../../workspaces";

export function openNextInNewsWorkspace() { setCurrentWorkspace("news"); }
