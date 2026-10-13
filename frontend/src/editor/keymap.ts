/**
 * The editor's keyboard (docs/EDITOR.md §3). Keys reach the focused panel's monitor: with the Source monitor focused,
 * Space / J K L / arrows / I O / M drive the source clip; everywhere else the sequence. Nothing fires while you type
 * in a field or a dialog is open (except Esc).
 *
 * Which key runs which action comes from model/keybindings.ts: the Premiere preset by default, Resolve or Final Cut
 * Pro, plus your own changes from the Keyboard Shortcuts dialog (saved in this browser, exportable as JSON).
 */
import { useSyncExternalStore } from "react";
import * as A from "./actions";
import { openDialog } from "./dialogs";
import { DEFAULT_KEYS, KEY_ACTIONS, keyIndex, parseKeySettings, resolveBindings, type KeySettings } from "./model/keybindings";
import { seqEnd } from "./model/ops";
import * as M from "./motionActions";
import { playProgram, playSource, shuttleProgram } from "./playback/control";
import { program, source } from "./playback/transport";
import { clearSelection, ed, gesture, redo, select, seq, setTool, toggleSnapping, undo, type EditorState, type Tool } from "./store";
import { closeMenu, typing } from "./ui";

export interface KeyHandlers { save(): void; saveAs(): void; open(): void; newEdit(): void; importMedia(): void; exportSeq(): void; shortcuts(): void; laneWidth(): number; shortcutEditor?(): void }

/** "Ctrl+Shift+K", "Alt+ArrowLeft", "Shift+Delete", ";", "=", "1", "[". */
export function keyName(e: KeyboardEvent): string {
  let k = e.key;
  if (k === " " || k === "Spacebar") k = "Space";
  else if (k.length === 1) k = k.toUpperCase();
  if (e.code === "Equal") k = "=";
  else if (e.code === "Minus") k = "-";
  else if (e.code === "Backslash") k = "\\";
  else if (e.code === "Semicolon") k = ";";
  else if (e.code === "Quote") k = "'";
  else if (e.code === "Comma") k = ",";
  else if (e.code === "Period") k = ".";
  else if (e.code === "Slash") k = "/";
  else if (e.code === "BracketLeft") k = "[";
  else if (e.code === "BracketRight") k = "]";
  else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  const mods = [(e.ctrlKey || e.metaKey) && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  return [...mods, k].join("+");
}

// ── the bindings in use ──────────────────────────────────────────────────────

const LS_KEYS = "tatvam-editor:keys:v1";
let settings: KeySettings = DEFAULT_KEYS;
try { settings = parseKeySettings(localStorage.getItem(LS_KEYS)); } catch { /* storage blocked */ }
let bindings = resolveBindings(settings);
let index = keyIndex(bindings);
const subs = new Set<() => void>();

export const keySettings = () => settings;
export const currentBindings = () => bindings;
export function setKeySettings(st: KeySettings) {
  settings = st;
  bindings = resolveBindings(st);
  index = keyIndex(bindings);
  try { localStorage.setItem(LS_KEYS, JSON.stringify(st)); } catch { /* blocked */ }
  rebuildList();
  subs.forEach((f) => f());
}
export function useKeySettings(): KeySettings {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => settings, () => settings);
}
/** The first key of an action ("" when it has none), for menus and tooltips. */
export const keyFor = (id: string) => bindings[id]?.[0] ?? "";

// ── what every action does ───────────────────────────────────────────────────

interface Ctx { src: boolean; tr: typeof program; st: EditorState; h: KeyHandlers }
/** Runs an action; false = not handled here (the key goes on to the page). */
type Run = (c: Ctx) => boolean | void;

const tool = (t: Tool): Run => () => setTool(t);
const RUN: Record<string, Run> = {
  "tool.select": tool("select"), "tool.trackFwd": tool("trackFwd"), "tool.trackBack": tool("trackBack"), "tool.ripple": tool("ripple"), "tool.roll": tool("roll"),
  "tool.rate": tool("rate"), "tool.razor": tool("razor"), "tool.slip": tool("slip"), "tool.slide": tool("slide"), "tool.pen": tool("pen"), "tool.hand": tool("hand"),
  "tool.zoom": tool("zoom"), "tool.text": tool("text"),
  snapping: () => toggleSnapping(), magnetic: () => M.toggleMagnetic(),
  escape: () => { closeMenu(); if (gesture.active()) gesture.cancel(); else clearSelection(); },
  play: ({ src }) => (src ? playSource() : playProgram()),
  "shuttle.fwd": ({ src }) => (src ? source.shuttle(1) : shuttleProgram(1)),
  "shuttle.back": ({ src }) => (src ? source.shuttle(-1) : shuttleProgram(-1)),
  stop: ({ tr }) => tr.pause(),
  "step.fwd.pause": ({ tr }) => { tr.pause(); tr.step(1); }, "step.back.pause": ({ tr }) => { tr.pause(); tr.step(-1); },
  "step.fwd": ({ tr }) => tr.step(1), "step.back": ({ tr }) => tr.step(-1), "step.fwd5": ({ tr }) => tr.step(5), "step.back5": ({ tr }) => tr.step(-5),
  "nudge.right": () => A.nudge(1), "nudge.left": () => A.nudge(-1), "nudge.right5": () => A.nudge(5), "nudge.left5": () => A.nudge(-5),
  "edit.prev": () => A.gotoEdit(-1), "edit.next": () => A.gotoEdit(1),
  home: ({ tr }) => tr.seek(0), end: ({ src, tr }) => tr.seek(src ? Math.max(0, source.end - 1) : seqEnd(seq())),
  "mark.in": ({ src }) => (src ? A.sourceMark("in") : A.markIn()), "mark.out": ({ src }) => (src ? A.sourceMark("out") : A.markOut()),
  "goto.in": ({ src, st }) => { if (src) { const m = st.h.present.media.find((x) => x.id === st.sourceId); if (m?.inPoint !== undefined) source.seek(A.srcToDisplay(m, m.inPoint)); } else A.gotoInOut("in"); },
  "goto.out": ({ src, st }) => { if (src) { const m = st.h.present.media.find((x) => x.id === st.sourceId); if (m?.outPoint !== undefined) source.seek(A.srcToDisplay(m, m.outPoint)); } else A.gotoInOut("out"); },
  "mark.clip": () => A.markClip(), "clear.inout": ({ src }) => (src ? A.sourceMark("clear") : A.clearInOut()),
  marker: ({ src }) => (src ? A.sourceMarker() : A.addSeqMarker()), "marker.next": () => A.gotoMarker(1), "marker.prev": () => A.gotoMarker(-1),
  lift: () => A.liftExtract("lift"), extract: () => A.liftExtract("extract"),
  insert: () => A.sourceEdit("insert"), overwrite: () => A.sourceEdit("overwrite"),
  "add.edit": () => A.addEdit(false), "add.edit.all": () => A.addEdit(true),
  "trim.prev": () => A.rippleTrimTo("prev"), "trim.next": () => A.rippleTrimTo("next"),
  clear: ({ st }) => { if (st.focus === "project" || st.focus === "graph") return false; A.deleteSelection(false); },
  "ripple.delete": ({ st }) => { if (st.focus === "graph") return false; A.deleteSelection(true); },
  copy: () => A.copy(), cut: () => A.copy(true), paste: () => A.paste("overwrite"), "paste.insert": () => A.paste("insert"), "paste.attributes": () => A.pasteAttributes(),
  enable: () => A.toggleEnabled(), group: () => A.groupSelection(), ungroup: () => A.unlinkSelection(), link: () => A.linkSelection(),
  nest: () => M.nestNamed(), unnest: () => M.unnest(),
  "transition.video": () => A.defaultTransitions("video"), "transition.audio": () => A.defaultTransitions("audio"),
  speed: () => { const ids = ed().selection; if (ids.length) openDialog({ kind: "speed", ids }); },
  freeze: () => M.insertFreezeAt(), hold: () => M.holdFrameAt(),
  title: () => { A.newTitle(); },
  "select.all": () => select(seq().clips.filter((c) => !seq().tracks.find((t) => t.id === c.trackId)?.locked).map((c) => c.id), "set", { linked: false }),
  deselect: () => clearSelection(),
  "zoom.in": ({ h }) => A.zoomBy(1.5, program.frame, h.laneWidth()), "zoom.out": ({ h }) => A.zoomBy(1 / 1.5, program.frame, h.laneWidth()), "zoom.fit": ({ h }) => A.zoomToFit(h.laneWidth()),
  undo: () => undo(), redo: () => redo(),
  save: ({ h }) => h.save(), "save.as": ({ h }) => h.saveAs(), open: ({ h }) => h.open(), "new.edit": ({ h }) => h.newEdit(),
  import: ({ h }) => h.importMedia(), export: ({ h }) => h.exportSeq(),
  shortcuts: ({ h }) => h.shortcuts(),
  "shortcut.editor": ({ h }) => { if (h.shortcutEditor) h.shortcutEditor(); else window.dispatchEvent(new CustomEvent("ed:shortcut-editor")); },
};
for (let n = 1; n <= 9; n++) RUN[`angle.${n}`] = () => M.cutToAngle(n - 1);

export function handleKey(e: KeyboardEvent, h: KeyHandlers): boolean {
  if (e.defaultPrevented) return false;
  const name = keyName(e);
  if (typing(e)) return false;
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return false;
  // the "?" key: Shift+/ on most layouts
  const id = index.get(name) ?? (name === "?" || name === "Shift+?" ? index.get("Shift+/") : undefined);
  const run = id ? RUN[id] : undefined;
  if (!run) return false;
  const st = ed();
  const src = st.focus === "source" && !!st.sourceId;
  if (run({ src, tr: src ? source : program, st, h }) === false) return false;
  e.preventDefault();
  return true;
}

/** The shortcut list for Help → Keyboard shortcuts (the keys in use, grouped). */
export const SHORTCUTS: [string, [string, string][]][] = [];
function rebuildList() {
  const groups = new Map<string, [string, string][]>();
  for (const a of KEY_ACTIONS) {
    const ks = bindings[a.id] ?? [];
    if (!ks.length) continue;
    const g = groups.get(a.group) ?? [];
    g.push([ks.join(" / "), a.label]);
    groups.set(a.group, g);
  }
  const extra: [string, [string, string][]] = ["Mouse", [["Alt+wheel", "Zoom at the pointer"], ["Shift+wheel", "Scroll in time"], ["Drag with Ctrl", "Insert instead of overwrite"],
    ["Drag with Alt", "Duplicate (on an edge: trim one side only)"], ["Ctrl+Alt drag", "Rearrange"], ["Ctrl+edge drag", "Ripple trim"]]];
  SHORTCUTS.splice(0, SHORTCUTS.length, ...groups.entries(), extra);
}
rebuildList();
