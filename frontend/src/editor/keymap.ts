/**
 * The editor's keyboard (docs/EDITOR.md §3). Keys reach the focused panel's monitor: with the Source monitor focused,
 * Space / J K L / arrows / I O / M drive the source clip; everywhere else the sequence. Nothing fires while you type
 * in a field or a dialog is open (except Esc).
 */
import * as A from "./actions";
import { openDialog } from "./dialogs";
import { seqEnd } from "./model/ops";
import { playProgram, playSource, shuttleProgram } from "./playback/control";
import { program, source } from "./playback/transport";
import { clearSelection, ed, gesture, redo, select, seq, setTool, toggleSnapping, undo, type Tool } from "./store";
import { closeMenu, typing } from "./ui";

export interface KeyHandlers { save(): void; saveAs(): void; open(): void; newEdit(): void; importMedia(): void; exportSeq(): void; shortcuts(): void; laneWidth(): number }

/** "Ctrl+Shift+K", "Alt+ArrowLeft", "Shift+Delete", ";", "=". */
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
  else if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  const mods = [(e.ctrlKey || e.metaKey) && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  return [...mods, k].join("+");
}

const TOOL_KEYS: Record<string, Tool> = { V: "select", A: "trackFwd", "Shift+A": "trackBack", B: "ripple", N: "roll", R: "rate", C: "razor", Y: "slip", U: "slide", P: "pen", H: "hand", Z: "zoom", T: "text" };

export function handleKey(e: KeyboardEvent, h: KeyHandlers): boolean {
  if (e.defaultPrevented) return false;
  const name = keyName(e);
  if (typing(e)) return false;
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return false;
  const st = ed();
  const src = st.focus === "source" && !!st.sourceId;
  const tr = src ? source : program;
  const run = (fn: () => void) => { e.preventDefault(); fn(); return true; };

  if (TOOL_KEYS[name]) return run(() => setTool(TOOL_KEYS[name]));
  switch (name) {
    case "Escape": return run(() => { closeMenu(); if (gesture.active()) gesture.cancel(); else clearSelection(); });
    case "S": return run(toggleSnapping);
    case "Space": return run(() => (src ? playSource() : playProgram()));
    case "L": return run(() => (src ? source.shuttle(1) : shuttleProgram(1)));
    case "J": return run(() => (src ? source.shuttle(-1) : shuttleProgram(-1)));
    case "K": return run(() => tr.pause());
    case "Shift+L": return run(() => { tr.pause(); tr.step(1); });
    case "Shift+J": return run(() => { tr.pause(); tr.step(-1); });
    case "ArrowRight": return run(() => tr.step(1));
    case "ArrowLeft": return run(() => tr.step(-1));
    case "Shift+ArrowRight": return run(() => tr.step(5));
    case "Shift+ArrowLeft": return run(() => tr.step(-5));
    case "Alt+ArrowRight": return run(() => A.nudge(1));
    case "Alt+ArrowLeft": return run(() => A.nudge(-1));
    case "Alt+Shift+ArrowRight": return run(() => A.nudge(5));
    case "Alt+Shift+ArrowLeft": return run(() => A.nudge(-5));
    case "ArrowUp": return run(() => A.gotoEdit(-1));
    case "ArrowDown": return run(() => A.gotoEdit(1));
    case "Home": return run(() => tr.seek(0));
    case "End": return run(() => tr.seek(src ? Math.max(0, source.end - 1) : seqEnd(seq())));
    case "I": return run(() => (src ? A.sourceMark("in") : A.markIn()));
    case "O": return run(() => (src ? A.sourceMark("out") : A.markOut()));
    case "Shift+I": return run(() => { if (src) { const m = st.h.present.media.find((x) => x.id === st.sourceId); if (m?.inPoint !== undefined) source.seek(A.srcToDisplay(m, m.inPoint)); } else A.gotoInOut("in"); });
    case "Shift+O": return run(() => { if (src) { const m = st.h.present.media.find((x) => x.id === st.sourceId); if (m?.outPoint !== undefined) source.seek(A.srcToDisplay(m, m.outPoint)); } else A.gotoInOut("out"); });
    case "X": return run(A.markClip);
    case "Ctrl+Shift+X": return run(() => (src ? A.sourceMark("clear") : A.clearInOut()));
    case "M": return run(() => (src ? A.sourceMarker() : A.addSeqMarker()));
    case "Shift+M": return run(() => A.gotoMarker(1));
    case "Ctrl+Shift+M": return run(() => A.gotoMarker(-1));
    case ";": return run(() => A.liftExtract("lift"));
    case "'": return run(() => A.liftExtract("extract"));
    case ",": return run(() => A.sourceEdit("insert"));
    case ".": return run(() => A.sourceEdit("overwrite"));
    case "Ctrl+K": return run(() => A.addEdit(false));
    case "Ctrl+Shift+K": return run(() => A.addEdit(true));
    case "Q": return run(() => A.rippleTrimTo("prev"));
    case "W": return run(() => A.rippleTrimTo("next"));
    case "Delete": case "Backspace": if (st.focus === "project") return false; return run(() => A.deleteSelection(false));
    case "Shift+Delete": case "Shift+Backspace": return run(() => A.deleteSelection(true));
    case "Ctrl+C": return run(() => A.copy());
    case "Ctrl+X": return run(() => A.copy(true));
    case "Ctrl+V": return run(() => A.paste("overwrite"));
    case "Ctrl+Shift+V": return run(() => A.paste("insert"));
    case "Ctrl+Alt+V": return run(A.pasteAttributes);
    case "Shift+E": return run(A.toggleEnabled);
    case "Ctrl+G": return run(A.groupSelection);
    case "Ctrl+Shift+G": return run(A.unlinkSelection);
    case "Ctrl+L": return run(A.linkSelection);
    case "Ctrl+Shift+N": return run(A.nest);
    case "Ctrl+D": return run(() => A.defaultTransitions("video"));
    case "Ctrl+Shift+D": return run(() => A.defaultTransitions("audio"));
    case "=": case "Shift+=": return run(() => A.zoomBy(1.5, program.frame, h.laneWidth()));
    case "-": return run(() => A.zoomBy(1 / 1.5, program.frame, h.laneWidth()));
    case "\\": return run(() => A.zoomToFit(h.laneWidth()));
    case "Ctrl+Z": return run(undo);
    case "Ctrl+Shift+Z": case "Ctrl+Y": return run(redo);
    case "Ctrl+S": return run(h.save);
    case "Ctrl+Shift+S": return run(h.saveAs);
    case "Ctrl+O": return run(h.open);
    case "Ctrl+Alt+N": return run(h.newEdit);
    case "Ctrl+I": return run(h.importMedia);
    case "Ctrl+M": return run(h.exportSeq);
    case "Ctrl+A": return run(() => select(seq().clips.filter((c) => !seq().tracks.find((t) => t.id === c.trackId)?.locked).map((c) => c.id), "set", { linked: false }));
    case "Ctrl+Shift+A": return run(clearSelection);
    case "Ctrl+R": return run(() => { const ids = ed().selection; if (ids.length) openDialog({ kind: "speed", ids }); });
    case "Ctrl+T": return run(() => A.newTitle());
    case "Shift+/": case "?": case "Shift+?": return run(h.shortcuts);
    default: return false;
  }
}

/** The shortcut list for Help → Keyboard shortcuts. */
export const SHORTCUTS: [string, [string, string][]][] = [
  ["Tools", [["V", "Selection"], ["A / Shift+A", "Track select forward / backward"], ["B", "Ripple edit"], ["N", "Rolling edit"], ["R", "Rate stretch"], ["C", "Razor"], ["Y", "Slip"], ["U", "Slide"], ["P", "Pen (keyframes)"], ["H", "Hand"], ["Z", "Zoom (Alt: out)"], ["T", "Type (new title)"], ["S", "Snapping"]]],
  ["Playback", [["Space", "Play / pause"], ["J / K / L", "Shuttle back / stop / forward (press again: faster)"], ["← / →", "One frame"], ["Shift+← / →", "Five frames"], ["↑ / ↓", "Previous / next edit"], ["Home / End", "Start / end"]]],
  ["Marking", [["I / O", "In / out"], ["Shift+I / Shift+O", "Go to in / out"], ["X", "Mark clip"], ["Ctrl+Shift+X", "Clear in and out"], ["M", "Marker"], ["Shift+M / Ctrl+Shift+M", "Next / previous marker"]]],
  ["Editing", [[",  /  .", "Insert / overwrite from the Source monitor"], [";  /  '", "Lift / extract"], ["Ctrl+K", "Add edit (Shift: all tracks)"], ["Q / W", "Ripple trim previous / next edit to the playhead"], ["Del / Shift+Del", "Clear / ripple delete"], ["Alt+← / →", "Nudge"], ["Shift+E", "Enable / disable"], ["Ctrl+L / Ctrl+G", "Link / group"], ["Ctrl+Shift+N", "Nest"], ["Ctrl+R", "Speed / duration"], ["Ctrl+D / Ctrl+Shift+D", "Default video transition / audio crossfade"]]],
  ["Clipboard and history", [["Ctrl+C / X / V", "Copy / cut / paste (overwrite)"], ["Ctrl+Shift+V", "Paste insert"], ["Ctrl+Alt+V", "Paste attributes"], ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo"]]],
  ["Timeline", [["= / -", "Zoom in / out"], ["\\", "Zoom to fit"], ["Alt+wheel", "Zoom at the pointer"], ["Shift+wheel", "Scroll in time"], ["Drag with Ctrl", "Insert instead of overwrite"], ["Drag with Alt", "Duplicate (on an edge: trim one side only)"], ["Ctrl+Alt drag", "Rearrange"], ["Ctrl+edge drag", "Ripple trim"]]],
  ["File", [["Ctrl+S / Ctrl+Shift+S", "Save / save as"], ["Ctrl+I", "Import"], ["Ctrl+O", "Open"], ["Ctrl+M", "Export"]]],
];
