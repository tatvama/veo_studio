/**
 * The command registry behind the desktop command palette (Ctrl+K / Ctrl+Shift+P) and the shortcut cheat sheet
 * (Shift+/): sources register providers (the desktop's own commands, the editor's action registry while an edit is
 * open, pages), the palette reads them all, ranks with the fuzzy matcher and puts recently used commands first.
 */
import type { ReactNode } from "react";
import { useEffect, useSyncExternalStore } from "react";
import { fuzzyScore } from "../components/shell/fuzzy";

export type CommandGroup = "Recent" | "Navigate" | "Projects" | "Edits" | "Windows" | "Editor" | "Actions" | "Appearance" | "Settings" | "Files" | "Help";
export const GROUP_ORDER: CommandGroup[] = ["Recent", "Files", "Edits", "Projects", "Navigate", "Editor", "Windows", "Actions", "Appearance", "Settings", "Help"];

export interface Command {
  id: string;
  title: string;
  group: CommandGroup;
  /** extra words to match (never highlighted) */
  keywords?: string;
  /** e.g. "Ctrl+Shift+P" (shown in the palette, the cheat sheet and tooltips) */
  shortcut?: string;
  hint?: string;
  icon?: ReactNode;
  run(): void | Promise<void>;
  /** only listed while typing (keeps the empty palette short) */
  searchOnly?: boolean;
  /** in the cheat sheet even without a shortcut? (default: only with one) */
  sheet?: boolean;
}

type Provider = () => Command[];
const providers = new Map<string, Provider>();
let version = 0;
const subs = new Set<() => void>();
const bump = () => { version++; subs.forEach((f) => f()); };

export function registerCommands(source: string, provider: Provider): () => void {
  providers.set(source, provider);
  bump();
  return () => { if (providers.get(source) === provider) { providers.delete(source); bump(); } };
}

/** Re-read the providers (after their data changed). */
export const commandsChanged = bump;

export function allCommands(): Command[] {
  const out: Command[] = [];
  const seen = new Set<string>();
  for (const p of providers.values()) {
    let list: Command[] = [];
    try { list = p(); } catch { list = []; }
    for (const c of list) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
  }
  return out;
}

export function useCommandsVersion(): number {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => version, () => version);
}

/** Register while mounted (deps re-register). */
export function useCommands(source: string, provider: Provider, deps: unknown[]): void {
  useEffect(() => registerCommands(source, provider), deps); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Keys an open page claims (the editor binds Ctrl+K to "Add edit"): the palette then opens with Ctrl+Shift+P only. */
const claimed = new Set<string>();
export function claimKeys(keys: string[]): () => void {
  for (const k of keys) claimed.add(k);
  return () => { for (const k of keys) claimed.delete(k); };
}
export const isClaimed = (k: string) => claimed.has(k);

// ── recents ─────────────────────────────────────────────────────────────────

const RECENT_KEY = "tatvam-desktop:palette-recent";
export function readRecent(): { id: string; at: number; n: number }[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is { id: string; at: number; n: number } => x && typeof x.id === "string").slice(0, 40) : [];
  } catch {
    return [];
  }
}
export function pushRecent(id: string): void {
  const list = readRecent();
  const cur = list.find((x) => x.id === id);
  const next = [{ id, at: Date.now(), n: (cur?.n ?? 0) + 1 }, ...list.filter((x) => x.id !== id)].slice(0, 40);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
}

export interface Ranked { cmd: Command; score: number; indices: number[]; recent: boolean }

/** Rank for a query: fuzzy score plus a boost for recent and frequent use; empty query = recents, then the rest. */
export function rank(cmds: Command[], query: string, recent = readRecent()): Ranked[] {
  const r = new Map(recent.map((x, i) => [x.id, { i, n: x.n, at: x.at }]));
  const q = query.trim();
  const out: Ranked[] = [];
  for (const cmd of cmds) {
    const rec = r.get(cmd.id);
    if (!q) {
      if (cmd.searchOnly && !rec) continue;
      out.push({ cmd, score: rec ? 10_000 - rec.i : 0, indices: [], recent: Boolean(rec) });
      continue;
    }
    const m = fuzzyScore(q, cmd.title, `${cmd.group} ${cmd.keywords ?? ""} ${cmd.hint ?? ""}`);
    if (!m) continue;
    const boost = rec ? 120 + Math.min(rec.n, 10) * 15 - rec.i * 4 : 0;
    out.push({ cmd, score: m.score + boost, indices: m.indices, recent: Boolean(rec) });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ── synthetic keys (running editor actions by their binding) ────────────────

const CODE: Record<string, string> = {
  "=": "Equal", "-": "Minus", "\\": "Backslash", ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash", "[": "BracketLeft",
  "]": "BracketRight", Space: "Space",
};
/** Fire a binding like "Ctrl+Shift+K" as a keydown on the window (the editor's keymap handles it as if typed). */
export function pressKeys(binding: string): void {
  const parts = binding.split("+");
  const key = parts.pop() || "";
  const mods = new Set(parts);
  let code = CODE[key] ?? "";
  let k = key;
  if (/^[A-Z]$/.test(key)) { code = `Key${key}`; k = mods.has("Shift") ? key : key.toLowerCase(); }
  else if (/^\d$/.test(key)) code = `Digit${key}`;
  else if (key === "Space") k = " ";
  else if (!code) code = key; // ArrowLeft, Delete, Home, F9 …
  if (key === "/" && mods.has("Shift")) k = "?";
  const ev = new KeyboardEvent("keydown", { key: k, code, ctrlKey: mods.has("Ctrl"), altKey: mods.has("Alt"), shiftKey: mods.has("Shift"), bubbles: true, cancelable: true });
  document.body.dispatchEvent(ev);
}

/** "Ctrl+Shift+K" → ["Ctrl", "Shift", "K"] for <Kbd> chips; ⌘ on a Mac. */
export function keyParts(binding: string): string[] {
  const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  return binding.split("+").map((p) => (mac ? ({ Ctrl: "⌘", Alt: "⌥", Shift: "⇧" } as Record<string, string>)[p] ?? p : p)
    .replace(/^Arrow(Left|Right|Up|Down)$/, (_m, d: string) => ({ Left: "←", Right: "→", Up: "↑", Down: "↓" } as Record<string, string>)[d]));
}
