/**
 * Keyboard shortcuts as data (editor-motion): every editor action with its Premiere Pro key (the default), the
 * DaVinci Resolve and Final Cut Pro presets, your own changes on top, conflict detection, and the JSON you can export
 * and import. editor/keymap.ts runs the actions; the Keyboard Shortcuts dialog edits this. Pure.
 *
 * Key names: modifiers in the order Ctrl, Alt, Shift, then the key ("Ctrl+Shift+K", "Alt+ArrowLeft", ";", "1").
 * Ctrl also means ⌘ on a Mac.
 */

export type KeyPreset = "premiere" | "resolve" | "fcp";
export const KEY_PRESETS: { id: KeyPreset; label: string }[] = [
  { id: "premiere", label: "Adobe Premiere Pro (default)" },
  { id: "resolve", label: "DaVinci Resolve" },
  { id: "fcp", label: "Final Cut Pro" },
];

export interface KeyAction { id: string; label: string; group: string; keys: string[]; /** not rebindable */ fixed?: boolean }

const A = (group: string, id: string, label: string, ...keys: string[]): KeyAction => ({ id, label, group, keys });

/** Every action, with its Premiere key(s). */
export const KEY_ACTIONS: KeyAction[] = [
  A("Tools", "tool.select", "Selection tool", "V"), A("Tools", "tool.trackFwd", "Track select forward", "A"), A("Tools", "tool.trackBack", "Track select backward", "Shift+A"),
  A("Tools", "tool.ripple", "Ripple edit tool", "B"), A("Tools", "tool.roll", "Rolling edit tool", "N"), A("Tools", "tool.rate", "Rate stretch tool", "R"),
  A("Tools", "tool.razor", "Razor tool", "C"), A("Tools", "tool.slip", "Slip tool", "Y"), A("Tools", "tool.slide", "Slide tool", "U"), A("Tools", "tool.pen", "Pen tool (keyframes)", "P"),
  A("Tools", "tool.hand", "Hand tool", "H"), A("Tools", "tool.zoom", "Zoom tool", "Z"), A("Tools", "tool.text", "Type tool (new title)", "T"),
  A("Tools", "snapping", "Snapping on / off", "S"), A("Tools", "magnetic", "Magnetic timeline on / off"),
  { ...A("Tools", "escape", "Cancel / clear the selection", "Escape"), fixed: true },
  A("Playback", "play", "Play / pause", "Space"), A("Playback", "shuttle.fwd", "Shuttle forward", "L"), A("Playback", "shuttle.back", "Shuttle back", "J"),
  A("Playback", "stop", "Stop", "K"), A("Playback", "step.fwd.pause", "Pause and step forward", "Shift+L"), A("Playback", "step.back.pause", "Pause and step back", "Shift+J"),
  A("Playback", "step.fwd", "Step forward one frame", "ArrowRight"), A("Playback", "step.back", "Step back one frame", "ArrowLeft"),
  A("Playback", "step.fwd5", "Step forward five frames", "Shift+ArrowRight"), A("Playback", "step.back5", "Step back five frames", "Shift+ArrowLeft"),
  A("Playback", "edit.prev", "Go to previous edit", "ArrowUp"), A("Playback", "edit.next", "Go to next edit", "ArrowDown"),
  A("Playback", "home", "Go to start", "Home"), A("Playback", "end", "Go to end", "End"),
  A("Marking", "mark.in", "Mark in", "I"), A("Marking", "mark.out", "Mark out", "O"), A("Marking", "goto.in", "Go to in", "Shift+I"), A("Marking", "goto.out", "Go to out", "Shift+O"),
  A("Marking", "mark.clip", "Mark clip", "X"), A("Marking", "clear.inout", "Clear in and out", "Ctrl+Shift+X"), A("Marking", "marker", "Add marker", "M"),
  A("Marking", "marker.next", "Go to next marker", "Shift+M"), A("Marking", "marker.prev", "Go to previous marker", "Ctrl+Shift+M"),
  A("Editing", "insert", "Insert from the Source monitor", ","), A("Editing", "overwrite", "Overwrite from the Source monitor", "."),
  A("Editing", "lift", "Lift", ";"), A("Editing", "extract", "Extract", "'"), A("Editing", "add.edit", "Add edit", "Ctrl+K"), A("Editing", "add.edit.all", "Add edit to all tracks", "Ctrl+Shift+K"),
  A("Editing", "trim.prev", "Ripple trim previous edit to playhead", "Q"), A("Editing", "trim.next", "Ripple trim next edit to playhead", "W"),
  A("Editing", "clear", "Clear", "Delete", "Backspace"), A("Editing", "ripple.delete", "Ripple delete", "Shift+Delete", "Shift+Backspace"),
  A("Editing", "nudge.right", "Nudge right", "Alt+ArrowRight"), A("Editing", "nudge.left", "Nudge left", "Alt+ArrowLeft"),
  A("Editing", "nudge.right5", "Nudge right five frames", "Alt+Shift+ArrowRight"), A("Editing", "nudge.left5", "Nudge left five frames", "Alt+Shift+ArrowLeft"),
  A("Editing", "enable", "Enable / disable", "Shift+E"), A("Editing", "group", "Group", "Ctrl+G"), A("Editing", "ungroup", "Ungroup", "Ctrl+Shift+G"), A("Editing", "link", "Link / unlink", "Ctrl+L"),
  A("Editing", "nest", "Nest (compound clip)", "Ctrl+Shift+N"), A("Editing", "unnest", "Un-nest (break apart)"),
  A("Editing", "transition.video", "Apply default video transition", "Ctrl+D"), A("Editing", "transition.audio", "Apply default audio crossfade", "Ctrl+Shift+D"),
  A("Editing", "speed", "Speed / duration", "Ctrl+R"), A("Editing", "freeze", "Insert frame hold at playhead"), A("Editing", "hold", "Frame hold (whole clip)"),
  A("Editing", "title", "New title", "Ctrl+T"),
  A("Editing", "select.all", "Select all", "Ctrl+A"), A("Editing", "deselect", "Deselect all", "Ctrl+Shift+A"),
  A("Multicam", "angle.1", "Cut to angle 1", "1"), A("Multicam", "angle.2", "Cut to angle 2", "2"), A("Multicam", "angle.3", "Cut to angle 3", "3"),
  A("Multicam", "angle.4", "Cut to angle 4", "4"), A("Multicam", "angle.5", "Cut to angle 5", "5"), A("Multicam", "angle.6", "Cut to angle 6", "6"),
  A("Multicam", "angle.7", "Cut to angle 7", "7"), A("Multicam", "angle.8", "Cut to angle 8", "8"), A("Multicam", "angle.9", "Cut to angle 9", "9"),
  A("Clipboard and history", "copy", "Copy", "Ctrl+C"), A("Clipboard and history", "cut", "Cut", "Ctrl+X"), A("Clipboard and history", "paste", "Paste", "Ctrl+V"),
  A("Clipboard and history", "paste.insert", "Paste insert", "Ctrl+Shift+V"), A("Clipboard and history", "paste.attributes", "Paste attributes", "Ctrl+Alt+V"),
  A("Clipboard and history", "undo", "Undo", "Ctrl+Z"), A("Clipboard and history", "redo", "Redo", "Ctrl+Shift+Z", "Ctrl+Y"),
  A("Timeline", "zoom.in", "Zoom in", "=", "Shift+="), A("Timeline", "zoom.out", "Zoom out", "-"), A("Timeline", "zoom.fit", "Zoom to sequence", "\\"),
  A("File", "save", "Save", "Ctrl+S"), A("File", "save.as", "Save as", "Ctrl+Shift+S"), A("File", "open", "Open edit", "Ctrl+O"), A("File", "new.edit", "New edit", "Ctrl+Alt+N"),
  A("File", "import", "Import media", "Ctrl+I"), A("File", "export", "Export", "Ctrl+M"),
  A("News Room", "nr.strap", "Add a name strap at the playhead", "Alt+N"), A("News Room", "nr.ticker", "Add a ticker at the playhead", "Alt+T"),
  A("News Room", "nr.breaking", "Add a breaking bar at the playhead", "Alt+B"), A("News Room", "nr.layout", "Add a screen layout at the playhead", "Alt+L"),
  A("News Room", "nr.wipe", "Add a wipe at the nearest cut", "Alt+S"),
  A("Help", "shortcuts", "Keyboard shortcuts list", "Shift+/"), A("Help", "shortcut.editor", "Keyboard shortcut editor", "Ctrl+Alt+K"),
];

const byId = new Map(KEY_ACTIONS.map((a) => [a.id, a]));

/** What each preset changes from Premiere's keys ([] = no key). */
const PRESET_CHANGES: Record<KeyPreset, Record<string, string[]>> = {
  premiere: {},
  resolve: {
    "tool.select": ["A"], "tool.trackFwd": ["Y"], "tool.trackBack": ["Alt+Y"], "tool.ripple": ["T"], "tool.roll": [], "tool.rate": [], "tool.razor": ["B"],
    "tool.slip": [], "tool.slide": [], "tool.pen": [], "tool.text": [], "tool.zoom": [], "snapping": ["N"],
    "insert": ["F9"], "overwrite": ["F10"], "lift": [], "extract": [], "add.edit": ["Ctrl+B", "Ctrl+\\"], "add.edit.all": [],
    "trim.prev": ["Ctrl+Shift+["], "trim.next": ["Ctrl+Shift+]"], "clear": ["Backspace"], "ripple.delete": ["Delete", "Shift+Backspace"],
    "nudge.left": [","], "nudge.right": ["."], "nudge.left5": ["Shift+,"], "nudge.right5": ["Shift+."],
    "enable": ["D"], "group": [], "ungroup": [], "link": ["Ctrl+Alt+L"], "nest": [], "transition.video": ["Ctrl+T"], "transition.audio": ["Ctrl+Shift+T"],
    "title": [], "freeze": ["Shift+R"], "clear.inout": ["Alt+X"], "marker.next": ["Shift+ArrowDown"], "marker.prev": ["Shift+ArrowUp"],
    "paste.attributes": ["Alt+V"], "zoom.in": ["Ctrl+="], "zoom.out": ["Ctrl+-"], "zoom.fit": ["Shift+Z"], "export": ["Ctrl+Shift+E"], "shortcut.editor": ["Ctrl+Alt+K"],
  },
  fcp: {
    "tool.select": ["A"], "tool.trackFwd": [], "tool.trackBack": [], "tool.ripple": ["T"], "tool.roll": [], "tool.rate": [], "tool.razor": ["B"],
    "tool.slip": [], "tool.slide": [], "tool.pen": [], "tool.text": [], "snapping": ["N"], "magnetic": ["P"],
    "insert": ["W"], "overwrite": ["D"], "lift": [], "extract": [], "add.edit": ["Ctrl+B"], "add.edit.all": ["Ctrl+Shift+B"],
    "trim.prev": ["Alt+["], "trim.next": ["Alt+]"], "clear": ["Shift+Delete", "Shift+Backspace"], "ripple.delete": ["Delete", "Backspace"],
    "nudge.left": [","], "nudge.right": ["."], "nudge.left5": ["Shift+,"], "nudge.right5": ["Shift+."],
    "enable": ["V"], "group": [], "ungroup": [], "link": [], "nest": ["Alt+G"], "unnest": ["Ctrl+Shift+G"], "transition.video": ["Ctrl+T"], "transition.audio": [],
    "title": ["Ctrl+Alt+T"], "freeze": ["Alt+F"], "hold": ["Shift+H"], "clear.inout": ["Alt+X"], "marker.next": ["Ctrl+'"], "marker.prev": ["Ctrl+;"],
    "paste.insert": [], "paste.attributes": ["Ctrl+Shift+V"], "zoom.in": ["Ctrl+="], "zoom.out": ["Ctrl+-"], "zoom.fit": ["Shift+Z"], "export": ["Ctrl+E"],
  },
};

const MOD_ORDER = ["Ctrl", "Alt", "Shift"];
/** A key name in the canonical order ("shift+ctrl+k" → "Ctrl+Shift+K"). Empty when it isn't a key. */
export function normalizeKey(s: string): string {
  const raw = s.trim();
  if (!raw) return "";
  const parts = raw === "+" ? ["+"] : raw.split("+").filter((x, i, a) => x !== "" || i === a.length - 1);
  let key = parts.pop() ?? "";
  if (key === "") key = "+";
  const mods = new Set(parts.map((m) => {
    const l = m.toLowerCase();
    return l === "cmd" || l === "meta" || l === "control" || l === "ctrl" || l === "⌘" ? "Ctrl" : l === "option" || l === "alt" || l === "⌥" ? "Alt" : l === "shift" || l === "⇧" ? "Shift" : m;
  }));
  if (key.length === 1) key = key.toUpperCase();
  else if (/^space(bar)?$/i.test(key)) key = "Space";
  else if (/^(esc|escape)$/i.test(key)) key = "Escape";
  else if (/^del(ete)?$/i.test(key)) key = "Delete";
  else if (/^(left|right|up|down)$/i.test(key)) key = `Arrow${key[0].toUpperCase()}${key.slice(1).toLowerCase()}`;
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join("+");
}

export interface KeySettings { preset: KeyPreset; custom: Record<string, string[]> }
export const DEFAULT_KEYS: KeySettings = { preset: "premiere", custom: {} };

/** The keys of every action: the preset's, then your changes. */
export function resolveBindings(st: KeySettings): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const ch = PRESET_CHANGES[st.preset] ?? {};
  for (const a of KEY_ACTIONS) {
    const keys = a.fixed ? a.keys : st.custom[a.id] ?? ch[a.id] ?? a.keys;
    out[a.id] = [...new Set(keys.map(normalizeKey).filter(Boolean))];
  }
  return out;
}

/** Keys bound to more than one action. */
export function findConflicts(bindings: Record<string, string[]>): { key: string; actions: string[] }[] {
  const by = new Map<string, string[]>();
  for (const [id, keys] of Object.entries(bindings)) for (const k of keys) { const l = by.get(k); if (l) l.push(id); else by.set(k, [id]); }
  return [...by.entries()].filter(([, ids]) => ids.length > 1).map(([key, actions]) => ({ key, actions })).sort((a, b) => a.key.localeCompare(b.key));
}

/** key → action (the first one bound, in KEY_ACTIONS order, wins a conflict). */
export function keyIndex(bindings: Record<string, string[]>): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of KEY_ACTIONS) for (const k of bindings[a.id] ?? []) if (!m.has(k)) m.set(k, a.id);
  return m;
}

/** Sets one action's keys (an empty list unbinds it); a key taken elsewhere can be moved off the other action. */
export function setKeys(st: KeySettings, actionId: string, keys: string[], opts: { steal?: boolean } = {}): KeySettings {
  const a = byId.get(actionId);
  if (!a || a.fixed) return st;
  const ks = [...new Set(keys.map(normalizeKey).filter(Boolean))];
  const custom = { ...st.custom, [actionId]: ks };
  if (opts.steal) {
    const cur = resolveBindings({ ...st, custom });
    for (const [id, list] of Object.entries(cur)) {
      if (id === actionId || byId.get(id)?.fixed) continue;
      const left = list.filter((k) => !ks.includes(k));
      if (left.length !== list.length) custom[id] = left;
    }
  }
  return { ...st, custom };
}

/** Back to the preset's keys for one action (or all). */
export function resetKeys(st: KeySettings, actionId?: string): KeySettings {
  if (!actionId) return { ...st, custom: {} };
  const custom = { ...st.custom };
  delete custom[actionId];
  return { ...st, custom };
}

export const actionById = (id: string) => byId.get(id);

/** The JSON a user exports (every action's keys, resolved). */
export function exportKeys(st: KeySettings): string {
  return JSON.stringify({ format: "tatvam-keys", version: 1, preset: st.preset, bindings: resolveBindings(st) }, null, 2);
}

/** Reads an exported file back (unknown actions are skipped, keys are normalised); throws on anything else. */
export function importKeys(text: string): KeySettings {
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new Error("That file isn't valid JSON"); }
  const o = v as { format?: unknown; preset?: unknown; bindings?: unknown };
  if (!o || typeof o !== "object" || o.format !== "tatvam-keys" || !o.bindings || typeof o.bindings !== "object") throw new Error("That isn't a Tatvam keyboard shortcuts file");
  const preset = KEY_PRESETS.some((p) => p.id === o.preset) ? (o.preset as KeyPreset) : "premiere";
  const base = resolveBindings({ preset, custom: {} });
  const custom: Record<string, string[]> = {};
  for (const [id, keys] of Object.entries(o.bindings as Record<string, unknown>)) {
    if (!byId.has(id) || !Array.isArray(keys)) continue;
    const ks = [...new Set(keys.filter((k): k is string => typeof k === "string").map(normalizeKey).filter(Boolean))];
    if (JSON.stringify(ks) !== JSON.stringify(base[id])) custom[id] = ks;
  }
  return { preset, custom };
}

/** Reads the saved settings (anything broken → the defaults). */
export function parseKeySettings(raw: string | null): KeySettings {
  if (!raw) return DEFAULT_KEYS;
  try {
    const v = JSON.parse(raw) as Partial<KeySettings>;
    const preset = KEY_PRESETS.some((p) => p.id === v.preset) ? (v.preset as KeyPreset) : "premiere";
    const custom: Record<string, string[]> = {};
    if (v.custom && typeof v.custom === "object") for (const [id, ks] of Object.entries(v.custom)) if (byId.has(id) && Array.isArray(ks)) custom[id] = ks.filter((k) => typeof k === "string");
    return { preset, custom };
  } catch { return DEFAULT_KEYS; }
}
