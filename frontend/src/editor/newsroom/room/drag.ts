/**
 * Dragging a graphic from the room (Graphics, Playlist) onto the timeline or the program monitor (docs/EDITOR.md
 * §16.8). The timeline only takes its own drags (dnd.ts), so the room listens on the window while one of its graphics
 * is dragged: over a timeline lane it shows where it lands (snapped to the playhead and cuts), and the drop adds it
 * there on its own track — a wipe on the nearest cut. Over the program monitor it lands at the playhead.
 */
import { editPoints } from "../../model/ops";
import { toTimecode } from "../../model/time";
import { program } from "../../playback/transport";
import { ed, seq } from "../../store";
import type { GfxTemplate, GfxValue } from "../types";
import { nearestCut } from "../wipes/apply";
import { addNewsTransitionAtCut, addTemplateAt, addWipeAtCut, isWipe } from "./actions";

export const GFX_MIME = "application/x-tatvam-gfx";
/** A graphic (template + values) or a news transition (by preset id) being dragged. */
let dragging: { name: string; t?: GfxTemplate; values?: Record<string, GfxValue>; transition?: string } | null = null;
let mark: HTMLDivElement | null = null;
const onCut = () => !!dragging && (!!dragging.transition || (!!dragging.t && isWipe(dragging.t)));

export function startGfxDrag(e: React.DragEvent, t: GfxTemplate, values?: Record<string, GfxValue>) { begin(e, { name: t.name, t, values }); }
export function startTransitionDrag(e: React.DragEvent, presetId: string, label: string) { begin(e, { name: label, transition: presetId }); }

function begin(e: React.DragEvent, d: NonNullable<typeof dragging>) {
  dragging = d;
  const dt = e.dataTransfer;
  dt.effectAllowed = "copy";
  dt.setData(GFX_MIME, d.t?.id ?? d.transition ?? "");
  dt.setData("text/plain", d.name);
  const g = document.createElement("div");
  g.textContent = d.name;
  g.style.cssText = "position:fixed;top:-100px;left:-100px;padding:3px 8px;border-radius:6px;font:600 11px Inter Variable,system-ui;color:#fff;background:rgba(20,30,48,.92);border:1px solid rgba(103,232,249,.5)";
  document.body.appendChild(g);
  dt.setDragImage(g, 10, 10);
  window.setTimeout(() => g.remove(), 0);
}

function hideMark() { mark?.remove(); mark = null; }
function showMark(x: number, top: number, h: number, text: string) {
  if (!mark) {
    mark = document.createElement("div");
    mark.style.cssText = "position:fixed;z-index:80;pointer-events:none;width:2px;margin-left:-1px;background:var(--color-accent,#22d3ee);box-shadow:0 0 8px var(--color-accent,#22d3ee)";
    const tag = document.createElement("span");
    tag.style.cssText = "position:absolute;top:2px;left:6px;white-space:nowrap;padding:1px 6px;border-radius:5px;font:600 10.5px Inter Variable,system-ui;color:#fff;background:rgba(15,23,42,.92);border:1px solid rgba(103,232,249,.45)";
    mark.appendChild(tag);
    document.body.appendChild(mark);
  }
  mark.style.left = `${x}px`; mark.style.top = `${top}px`; mark.style.height = `${h}px`;
  (mark.firstChild as HTMLSpanElement).textContent = text;
}

/** Where a drop at clientX lands on the timeline (snapped within 8 px to the playhead and edit points), or null. */
function timelineFrame(e: DragEvent): { frame: number; x: number; body: DOMRect } | null {
  const el = e.target instanceof Element ? e.target : null;
  const body = el?.closest(".tl-body");
  const lane = body?.querySelector(".tl-lane");
  if (!body || !lane) return null;
  const left = lane.getBoundingClientRect().left;
  const { zoom, scroll } = ed();
  if (e.clientX < left) return null;
  let frame = Math.max(0, Math.round((e.clientX - left + scroll) / zoom));
  const s = seq();
  if (onCut()) frame = nearestCut(s, frame) ?? frame;
  else if (ed().snapping && !e.shiftKey) {
    const pts = [...editPoints(s), program.frame];
    const near = pts.reduce((b, f) => (Math.abs(f - frame) < Math.abs(b - frame) ? f : b), pts[0]);
    if (Math.abs(near - frame) * zoom < 8) frame = near;
  }
  return { frame, x: left + frame * zoom - scroll, body: body.getBoundingClientRect() };
}

function over(e: DragEvent) {
  if (!dragging) return;
  const el = e.target instanceof Element ? e.target : null;
  const tl = timelineFrame(e);
  if (tl) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    showMark(tl.x, tl.body.top, tl.body.height, `${dragging.name} · ${toTimecode(tl.frame, seq().fps)}${onCut() ? " (cut)" : ""}`);
    return;
  }
  hideMark();
  if (el?.closest(".mon-stage")) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; }
}

function drop(e: DragEvent) {
  if (!dragging) return;
  const d = dragging;
  const cut = onCut();
  const tl = timelineFrame(e);
  const onMonitor = !tl && e.target instanceof Element && !!e.target.closest(".mon-stage");
  hideMark();
  dragging = null;
  if (!tl && !onMonitor) return;
  e.preventDefault();
  e.stopPropagation();
  const at = tl?.frame ?? program.frame;
  if (d.transition) addNewsTransitionAtCut(d.transition, at);
  else if (d.t && cut) addWipeAtCut(d.t, at);
  else if (d.t) addTemplateAt(d.t, at, { values: d.values });
}

function end() { dragging = null; hideMark(); }

let users = 0;
/** Listens for the room's drags while a panel that starts them is open; returns the stop function. */
export function listenForGfxDrops(): () => void {
  if (users++ === 0) {
    window.addEventListener("dragover", over, true);
    window.addEventListener("drop", drop, true);
    window.addEventListener("dragend", end, true);
  }
  return () => {
    if (--users > 0) return;
    window.removeEventListener("dragover", over, true);
    window.removeEventListener("drop", drop, true);
    window.removeEventListener("dragend", end, true);
    end();
  };
}
