/**
 * Screen layout actions for the UI (docs/EDITOR.md §16.6): the layout commands as single undo steps on the editor's
 * store, the box names a layout shows, and the "Put in box" entries of the timeline's clip menu.
 */
import { toast } from "sonner";
import type { EditProject, Sequence, TimelineClip } from "../../model/types";
import { valuesOf } from "../render/layout";
import { ed, exec, project, seq } from "../../store";
import type { MenuItem } from "../../ui";
import { assignSlot, boxesOfClip, clearSlot, clipsUnder, isPictureClip, layoutOf, layoutsOver, placeInSlot, setSlotFraming } from "./commands";
import type { SlotBinding } from "../types";

/** One undo step running layout commands on a shallow copy (they only replace `sequences`). */
export function runLayout(label: string, fn: (d: EditProject) => void, coalesce?: string): boolean {
  let ok = true;
  exec(label, (p) => {
    const d = { ...p };
    try { fn(d); } catch (e) { ok = false; toast.error((e as Error).message); return p; }
    return d.sequences === p.sequences ? p : d;
  }, coalesce);
  return ok;
}

/** A box's name for menus and the assigner: its name tag filled in, else "Main picture" / "Box n". */
export function boxName(p: EditProject, s: Sequence, layoutClipId: string, index: number, label: string): string {
  const lo = layoutOf(p, s, layoutClipId);
  let text = "";
  if (lo && label && lo.clip.source.type === "graphic") {
    const v = valuesOf(lo.template, lo.clip.source.gfx.values ?? {});
    text = label.replace(/\{([^{}]+)\}/g, (_, k: string) => { const x = v[k.trim()]; return typeof x === "string" || typeof x === "number" ? String(x) : ""; }).trim();
  }
  return text || (index === 0 ? "Main picture" : `Box ${index + 1}`);
}

/** Puts clips in a box; the clips that were in that box over the same time are taken out (one picture per box). */
export function putInBox(seqId: string, layoutClipId: string, clipIds: string[], index: number): void {
  runLayout(`Put in box ${index + 1}`, (d) => {
    const s = d.sequences.find((x) => x.id === seqId)!;
    const moving = s.clips.filter((c) => clipIds.includes(c.id));
    for (const o of clipsUnder(d, s, layoutClipId)) {
      if (o.slot?.index !== index || clipIds.includes(o.id)) continue;
      if (moving.some((c) => c.start < o.start + o.duration && o.start < c.start + c.duration)) clearSlot(d, seqId, o.id);
    }
    for (const id of clipIds) assignSlot(d, seqId, id, index);
  });
}

export const takeOutOfBox = (seqId: string, clipIds: string[]) =>
  runLayout(clipIds.length > 1 ? "Take clips out of their boxes" : "Take out of box", (d) => { for (const id of clipIds) clearSlot(d, seqId, id); });

export const frameInBox = (seqId: string, clipId: string, patch: Partial<Omit<SlotBinding, "index">>, key: string) =>
  runLayout("Box framing", (d) => setSlotFraming(d, seqId, clipId, patch), `slot:${clipId}:${key}`);

export const mediaInBox = (seqId: string, mediaId: string, layoutClipId: string, index: number) =>
  runLayout(`Put in box ${index + 1}`, (d) => { placeInSlot(d, seqId, mediaId, layoutClipId, index); });

/** The clip menu's screen layout entries for a picture clip under a layout (or one in a box). */
export function slotMenuItems(c: TimelineClip): MenuItem[] {
  const p = project(), s = seq();
  if (!isPictureClip(s, c)) return [];
  const lay = layoutsOver(p, s, c)[0];
  if (!lay && !c.slot) return [];
  const sel = ed().selection.filter((id) => { const x = s.clips.find((y) => y.id === id); return !!x && isPictureClip(s, x); });
  const ids = sel.includes(c.id) ? sel : [c.id];
  const items: MenuItem[] = [];
  if (lay) {
    const boxes = boxesOfClip(p, s, lay.clip.id);
    items.push({
      label: ids.length > 1 ? `Put ${ids.length} clips in box` : "Put in box", separator: true,
      items: boxes.map((b) => ({ label: `${b.index + 1} · ${boxName(p, s, lay.clip.id, b.index, b.label)}`, checked: ids.length === 1 && c.slot?.index === b.index,
        onClick: () => putInBox(s.id, lay.clip.id, ids, b.index) })),
    });
    if (ids.length > 1 && boxes.length > 1) {
      // bottom track first: the main picture is usually on V1
      const order = new Map(s.tracks.map((t) => [t.id, t.index]));
      const sorted = ids.map((id) => s.clips.find((x) => x.id === id)!).sort((a, b) => order.get(a.trackId)! - order.get(b.trackId)! || a.start - b.start);
      items.push({ label: "Fill the boxes in order", onClick: () => runLayout("Fill the boxes", (d) => sorted.forEach((x, i) => assignSlot(d, s.id, x.id, boxes[Math.min(i, boxes.length - 1)].index))) });
    }
  }
  items.push({ label: "Take out of box", separator: !lay, disabled: !ids.some((id) => s.clips.find((x) => x.id === id)?.slot), onClick: () => takeOutOfBox(s.id, ids) });
  return items;
}
