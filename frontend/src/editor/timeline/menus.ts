/** Context menus of the timeline: a clip (with the AI submenu), empty track space and a transition. */
import { createElement } from "react";
import { Coins } from "lucide-react";
import * as A from "../actions";
import { loadAi } from "../aiLoader";
import { openDialog } from "../dialogs";
import { LABEL_COLORS } from "../model/defaults";
import { gapAt, isAudioTransition, kindOf, removeTransitions, rippleDeleteGap, updateTransition, withLinked } from "../model/ops";
import type { TimelineClip } from "../model/types";
import { makeHost } from "../host";
import { ed, seq, seqExec, setSource } from "../store";
import { source as sourceTransport } from "../playback/transport";
import type { MenuItem } from "../ui";

const swatch = (css: string) => createElement("span", { className: "block size-3 rounded-sm", style: { background: css } });

export function clipMenu(c: TimelineClip): MenuItem[] {
  const s = seq();
  const ids = ed().selection.length ? ed().selection : [c.id];
  const linked = withLinked(s, [c.id]).length > 1;
  const kind = kindOf(s, c);
  const items: MenuItem[] = [
    { label: "Cut", shortcut: "Ctrl+X", onClick: () => A.copy(true) },
    { label: "Copy", shortcut: "Ctrl+C", onClick: () => A.copy() },
    { label: "Paste attributes", shortcut: "Ctrl+Alt+V", disabled: !ed().clipboard, onClick: () => A.pasteAttributes() },
    { label: "Clear", shortcut: "Del", separator: true, onClick: () => A.deleteSelection(false) },
    { label: "Ripple delete", shortcut: "Shift+Del", onClick: () => A.deleteSelection(true) },
    { label: c.enabled ? "Disable" : "Enable", shortcut: "Shift+E", separator: true, onClick: () => A.toggleEnabled() },
    linked ? { label: "Unlink", shortcut: "Ctrl+L", onClick: () => A.unlinkSelection() } : { label: "Link", shortcut: "Ctrl+L", disabled: ids.length < 2, onClick: () => A.linkSelection() },
    { label: "Group", shortcut: "Ctrl+G", disabled: ids.length < 2, onClick: () => A.groupSelection() },
    { label: "Swap clips", disabled: ids.filter((id) => !s.clips.find((x) => x.id === id)?.linkId).length !== 2 && ids.length !== 2, onClick: () => A.swapSelection() },
    { label: "Speed / Duration…", shortcut: "Ctrl+R", separator: true, onClick: () => openDialog({ kind: "speed", ids }) },
    { label: c.reverse ? "Play forwards" : "Reverse", onClick: () => A.setSpeed(ids, c.speed, { reverse: !c.reverse }) },
    { label: `Add default ${kind === "video" ? "transitions" : "crossfades"}`, shortcut: kind === "video" ? "Ctrl+D" : "Ctrl+Shift+D", onClick: () => A.defaultTransitions(kind) },
    { label: "Nest…", shortcut: "Ctrl+Shift+N", onClick: () => A.nest() },
    { label: "Rename…", separator: true, onClick: () => openDialog({ kind: "prompt", title: "Rename clip", label: "Name", value: c.name, ok: "Rename", onOk: (v) => A.renameClip(c.id, v) }) },
    { label: "Label", items: [
      { label: "None", onClick: () => A.labelClips(ids, undefined) },
      ...LABEL_COLORS.map((l) => ({ label: l.label, icon: swatch(l.css), checked: c.colorLabel === l.id, onClick: () => A.labelClips(ids, l.id) })),
    ] },
  ];
  if (c.source.type === "media") {
    const mid = c.source.mediaId, at = c.source.in;
    items.push({ label: "Open in Source monitor", onClick: () => A.openInSource(mid, at) });
    items.push({ label: "Reveal in Project", onClick: () => window.dispatchEvent(new CustomEvent("ed:reveal", { detail: mid })) });
  }
  if (c.source.type === "nested") { const sid = c.source.sequenceId; items.push({ label: "Open nested sequence", onClick: () => A.openSequence(sid) }); }
  items.push({
    label: "AI", separator: true,
    items: async () => {
      const ai = await loadAi();
      if (!ai) return [{ label: "AI tools aren't installed in this build", disabled: true }];
      let acts: ReturnType<typeof ai.aiClipActions> = [];
      try { acts = ai.aiClipActions(makeHost(), ids); } catch (e) { return [{ label: `AI tools failed: ${(e as Error).message}`, disabled: true }]; }
      const out: MenuItem[] = [];
      let group = "";
      for (const a of acts) {
        out.push({ label: a.label, separator: !!group && a.group !== group, icon: a.paid ? createElement(Coins, { className: "size-3.5 text-money" }) : undefined,
          hint: a.group !== group ? a.group : undefined, onClick: () => a.run() });
        group = a.group;
      }
      return out;
    },
  });
  return items;
}

export function gapMenu(trackId: string, frame: number): MenuItem[] {
  const s = seq();
  const gap = gapAt(s, trackId, frame);
  return [
    { label: "Ripple delete gap", disabled: !gap, onClick: () => seqExec("Ripple delete gap", (sq, c) => rippleDeleteGap(sq, c, trackId, frame)) },
    { label: "Paste", shortcut: "Ctrl+V", disabled: !ed().clipboard, onClick: () => A.paste("overwrite") },
    { label: "Paste insert", shortcut: "Ctrl+Shift+V", disabled: !ed().clipboard, onClick: () => A.paste("insert") },
    { label: "Add marker", shortcut: "M", separator: true, onClick: () => A.addSeqMarker(frame) },
  ];
}

export function transitionMenu(id: string): MenuItem[] {
  const t = seq().transitions.find((x) => x.id === id);
  if (!t) return [];
  const align = (a: "start" | "center" | "end") => seqExec("Transition alignment", (s, c) => updateTransition(s, c, id, { alignment: a }));
  return [
    { label: "Settings…", onClick: () => openDialog({ kind: "transition", id }) },
    ...(t.fromClipId && t.toClipId ? [{ label: "Alignment", items: [
      { label: "Start at cut", checked: t.alignment === "start", onClick: () => align("start") },
      { label: "Centre at cut", checked: t.alignment === "center", onClick: () => align("center") },
      { label: "End at cut", checked: t.alignment === "end", onClick: () => align("end") },
    ] }] : []),
    { label: isAudioTransition(t.type) ? "Set as default crossfade" : "Set as default transition", onClick: () => A.setDefaultTransition(isAudioTransition(t.type) ? "audio" : "video", t.type) },
    { label: "Delete", danger: true, separator: true, onClick: () => seqExec("Delete transition", (s) => removeTransitions(s, [id])) },
  ];
}
