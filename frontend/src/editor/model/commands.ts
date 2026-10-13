/**
 * Commands and the undo / redo history (docs/EDITOR.md §3). The document is immutable, so a history entry is the
 * state before and after a command (structural sharing keeps that cheap). 500 steps. A drag is a gesture: `begin`
 * remembers the document, `preview` shows each step without recording it, `commit` records one entry for the whole
 * drag, `cancel` (Esc) puts the document back. Commands with the same `coalesce` key in quick succession (a slider
 * being dragged, typing in a field) merge into one entry. Pure: the store owns the instance.
 */
import type { EditProject } from "./types.ts";

export const HISTORY_LIMIT = 500;
export const COALESCE_MS = 900;

export interface Command {
  label: string;
  run(p: EditProject): EditProject;
  /** Merge with the previous entry when it has the same key and came within COALESCE_MS. */
  coalesce?: string;
}

export interface HistoryEntry { label: string; before: EditProject; after: EditProject; at: number; coalesce?: string }

export interface HistoryState {
  present: EditProject;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** An open gesture: the document when it began, and its label. */
  gesture: { label: string; base: EditProject } | null;
}

export const initHistory = (p: EditProject): HistoryState => ({ present: p, past: [], future: [], gesture: null });

export const command = (label: string, run: (p: EditProject) => EditProject, coalesce?: string): Command => ({ label, run, coalesce });

/** Runs a command and records it (a no-op command records nothing). */
export function exec(h: HistoryState, cmd: Command, now = Date.now()): HistoryState {
  if (h.gesture) h = commit(h, now);
  const next = cmd.run(h.present);
  if (next === h.present) return h;
  const last = h.past[h.past.length - 1];
  if (cmd.coalesce && last && last.coalesce === cmd.coalesce && now - last.at < COALESCE_MS) {
    const merged: HistoryEntry = { ...last, after: next, at: now };
    return { ...h, present: next, past: [...h.past.slice(0, -1), merged], future: [] };
  }
  const past = [...h.past, { label: cmd.label, before: h.present, after: next, at: now, coalesce: cmd.coalesce }];
  return { ...h, present: next, past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past, future: [] };
}

export function canUndo(h: HistoryState) { return h.past.length > 0 || !!h.gesture; }
export function canRedo(h: HistoryState) { return h.future.length > 0 && !h.gesture; }

export function undo(h: HistoryState): HistoryState {
  if (h.gesture) return cancel(h);
  const e = h.past[h.past.length - 1];
  if (!e) return h;
  return { ...h, present: e.before, past: h.past.slice(0, -1), future: [e, ...h.future] };
}

export function redo(h: HistoryState): HistoryState {
  const e = h.future[0];
  if (!e || h.gesture) return h;
  return { ...h, present: e.after, past: [...h.past, e], future: h.future.slice(1) };
}

/** Goes to the state right after past entry `index` (-1 = before everything): the History panel's click. */
export function jumpTo(h: HistoryState, index: number): HistoryState {
  let s = h.gesture ? cancel(h) : h;
  const target = Math.max(-1, Math.min(index, s.past.length + s.future.length - 1));
  while (s.past.length - 1 > target) s = undo(s);
  while (s.past.length - 1 < target && s.future.length) s = redo(s);
  return s;
}

// ── gestures (drags) ─────────────────────────────────────────────────────────

export function begin(h: HistoryState, label: string): HistoryState {
  const s = h.gesture ? commit(h) : h;
  return { ...s, gesture: { label, base: s.present } };
}

/** Shows a step of the drag: `fn` always starts from the document as it was when the drag began. */
export function preview(h: HistoryState, fn: (base: EditProject) => EditProject): HistoryState {
  if (!h.gesture) return h;
  const next = fn(h.gesture.base);
  return next === h.present ? h : { ...h, present: next };
}

export function commit(h: HistoryState, now = Date.now(), label?: string): HistoryState {
  const g = h.gesture;
  if (!g) return h;
  if (h.present === g.base) return { ...h, gesture: null };
  const past = [...h.past, { label: label ?? g.label, before: g.base, after: h.present, at: now }];
  return { present: h.present, past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past, future: [], gesture: null };
}

export function cancel(h: HistoryState): HistoryState {
  if (!h.gesture) return h;
  return { ...h, present: h.gesture.base, gesture: null };
}

/** Replaces the document without recording (load, a save stamping `modified`, runtime media URLs). */
export const replace = (h: HistoryState, p: EditProject): HistoryState => ({ ...h, present: p });
