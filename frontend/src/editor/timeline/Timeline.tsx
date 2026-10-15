/**
 * The Timeline panel (docs/EDITOR.md §3): track headers, ruler, lanes with clips, transitions and keyframe lines, the
 * playhead in its own layer, the mini-map, and every tool. Pointer gestures preview the real edit on each move (the
 * document as it was when the drag began + the op), and commit one undo step on release; Esc cancels.
 * Only the clips in the visible range render; pictures are canvases of their visible part.
 */
import { clsx } from "clsx";
import {
  ArrowLeftRight, Blend, Bookmark, Columns2, Hand, Link2, Magnet, MousePointer2, MoveHorizontal, PenTool, Scissors, SquareSplitHorizontal, StretchHorizontal,
  Type, ZoomIn, ChevronsRight, ChevronsLeft, Plus, ChevronRight, Rows3, X,
} from "lucide-react";
import * as M from "../motionActions";
import { audioTransients } from "../model/snapping";
import "./motion.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import * as A from "../actions";
import { openDialog, transitionLabel } from "../dialogs";
import { currentDrag, isEditorDrag, isFileDrag, type DragPayload } from "../dnd";
import { makeEffect } from "../effects";
import { mediaSpan } from "../model/defaults";
import * as O from "../model/ops";
import { addKeyframe, getParam, moveKeyframe, setParam } from "../model/params";
import { snapBlock, snapFrame, snapPoints, type SnapPoint } from "../model/snapping";
import { toTimecode } from "../model/time";
import type { Param, Sequence, TimelineClip, Track, Transition } from "../model/types";
import { program, useFrame } from "../playback/transport";
import { importDropped } from "../session";
import {
  clearSelection, ctx as getCtx, ed, gesture, select, selectTransition, seq as getSeq, setFocus, setSnapLine, setTool, setView,
  toggleLinked, toggleSnapBeats, toggleSnapping, toggleSnapTransients, TOOLS, urlFor, useEditor, useProject, useSequence, type Tool,
} from "../store";
import { IBtn, openMenu, TimecodeField } from "../ui";
import { bandOf, ClipView, NAME_H, SPEED_BAND } from "./Clip";
import { EDGE_PX, HEADER_W, layoutRows, rowAt, SPLIT_H, type Layout } from "./geometry";
import { clipMenu, gapMenu, transitionMenu } from "./menus";
import { MiniMap } from "./MiniMap";
import { Playhead } from "./Playhead";
import { Ruler } from "./Ruler";
import { TrackHeader } from "./TrackHeader";
import { source as sourceTransport } from "../playback/transport";

const TOOL_ICON: Record<Tool, typeof MousePointer2> = {
  select: MousePointer2, trackFwd: ChevronsRight, trackBack: ChevronsLeft, ripple: SquareSplitHorizontal, roll: Columns2, rate: StretchHorizontal,
  razor: Scissors, slip: ArrowLeftRight, slide: MoveHorizontal, pen: PenTool, hand: Hand, zoom: ZoomIn, text: Type,
};
const CURSOR: Partial<Record<Tool, string>> = { razor: "crosshair", hand: "grab", zoom: "zoom-in", text: "text", pen: "crosshair", trackFwd: "e-resize", trackBack: "w-resize" };

interface Drop { kind: "ghost"; trackId: string; start: number; duration: number }

export default function TimelinePanel() {
  const s = useSequence();
  const p = useProject();
  const st = useEditor(useShallow((x) => ({ zoom: x.zoom, scroll: x.scroll, tool: x.tool, snapping: x.snapping, linked: x.linked, selection: x.selection,
    selTransition: x.selTransition, selMarker: x.selMarker, snapLine: x.snapLine, urls: x.urls })));
  const { zoom, scroll, tool } = st;
  const body = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [laneW, setLaneW] = useState(800);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [ghosts, setGhosts] = useState<Drop[]>([]);
  const [dropClip, setDropClip] = useState<string | null>(null);
  const [dropCut, setDropCut] = useState<{ trackId: string; at: number } | null>(null);
  const [hover, setHover] = useState<{ x: number } | null>(null);
  const [activeKf, setActiveKf] = useState<{ clipId: string; frame: number } | null>(null);
  const layout = useMemo(() => layoutRows(s), [s.tracks]);
  const media = useMemo(() => new Map(p.media.map((m) => [m.id, m])), [p.media]);
  const byTrack = useMemo(() => {
    const m = new Map<string, TimelineClip[]>();
    for (const c of s.clips) { const l = m.get(c.trackId); if (l) l.push(c); else m.set(c.trackId, [c]); }
    return m;
  }, [s.clips]);
  const trByTrack = useMemo(() => {
    const m = new Map<string, Transition[]>();
    for (const t of s.transitions) { const l = m.get(t.trackId); if (l) l.push(t); else m.set(t.trackId, [t]); }
    return m;
  }, [s.transitions]);
  const selSet = useMemo(() => new Set(st.selection), [st.selection]);
  const ctx = useMemo(() => O.ctxOf(p), [p]);

  // lane width
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLaneW(Math.max(100, el.clientWidth - HEADER_W)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // a sequence opened without a saved zoom fits the window
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (fitted.current === s.id || laneW <= 100) return;
    fitted.current = s.id;
    if (!s.workArea?.zoom) A.zoomToFit(laneW);
  }, [s.id, laneW, s.workArea?.zoom]);
  // the transport's length follows the sequence
  useEffect(() => { program.configure(s.fps, O.seqEnd(s)); }, [s]);

  // ── coordinates ────────────────────────────────────────────────────────────
  const live = useRef({ zoom, scroll, layout, s, laneW });
  live.current = { zoom, scroll, layout, s, laneW };
  const laneLeft = () => (body.current?.getBoundingClientRect().left ?? 0) + HEADER_W;
  const frameAt = (clientX: number) => (clientX - laneLeft() + live.current.scroll) / live.current.zoom;
  const yIn = (clientY: number) => { const b = body.current!; return clientY - b.getBoundingClientRect().top + b.scrollTop; };
  const rowOf = (clientY: number, kind?: Track["kind"]) => rowAt(live.current.layout, yIn(clientY), kind);

  // ── gestures ───────────────────────────────────────────────────────────────
  const drag = useRef<{ move(e: PointerEvent): void; up(e: PointerEvent): void; cancel(): void } | null>(null);
  const run = (e: React.PointerEvent, h: { move(e: PointerEvent): void; up(e: PointerEvent): void; cancel?(): void }, autoScroll = true) => {
    const el = body.current!;
    try { el.setPointerCapture(e.pointerId); } catch { /* fine */ }
    // near the lane's left / right edge the timeline scrolls along, and the gesture follows
    let last: PointerEvent | null = null, raf = 0;
    const edgeSpeed = (x: number) => { const l = laneLeft(), r = l + live.current.laneW; return x < l + 24 ? -Math.min(40, (l + 24 - x) * 1.5) : x > r - 24 ? Math.min(40, (x - (r - 24)) * 1.5) : 0; };
    const tick = () => {
      raf = 0;
      if (!last) return;
      const v = edgeSpeed(last.clientX);
      if (!v || (v < 0 && live.current.scroll <= 0)) return;
      setView({ scroll: live.current.scroll + v });
      live.current.scroll = Math.max(0, live.current.scroll + v);
      h.move(last);
      raf = requestAnimationFrame(tick);
    };
    const move = (ev: PointerEvent) => { last = ev; h.move(ev); if (autoScroll && !raf && edgeSpeed(ev.clientX)) raf = requestAnimationFrame(tick); };
    const done = () => { if (raf) cancelAnimationFrame(raf); last = null; el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", cancel); window.removeEventListener("keydown", key, true); drag.current = null; };
    const up = (ev: PointerEvent) => { done(); h.up(ev); };
    const cancel = () => { done(); h.cancel?.(); if (gesture.active()) gesture.cancel(); setMarquee(null); };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancel(); } };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    drag.current = { move, up, cancel };
  };
  // unmounted mid-drag (a workspace switch, the panel closing): the gesture is cancelled and its window keydown
  // listener (capturing Esc) and element listeners go with it
  useEffect(() => () => { drag.current?.cancel(); drag.current = null; }, []);
  const points = (exclude: string[]) => {
    const st0 = ed();
    if (!st0.snapping) return [] as SnapPoint[];
    const sq = getSeq();
    return snapPoints(sq, { playhead: program.frame, exclude, beats: st0.snapBeats, transients: st0.snapTransients ? audioTransients(sq, getCtx(), { exclude }) : undefined });
  };
  const snapEdge = (f: number, pts: SnapPoint[], ev: PointerEvent) => {
    if (!pts.length || ev.shiftKey) { setSnapLine(null); return f; }
    const sn = snapFrame(f, pts, live.current.zoom);
    setSnapLine(sn ? sn.frame : null);
    return sn ? sn.frame : f;
  };

  /** Moving (and Alt-duplicating, Ctrl-inserting, Ctrl+Alt rearranging) the selection. */
  function startMove(e: React.PointerEvent, c: TimelineClip) {
    const base = getSeq();
    const ids = ed().selection.length ? ed().selection : [c.id];
    const moving = base.clips.filter((x) => ids.includes(x.id));
    const a = Math.min(...moving.map((x) => x.start)), b = Math.max(...moving.map(O.clipEnd));
    const kind = O.kindOf(base, c);
    const anchor = O.trackById(base, c.trackId)!;
    const pts = points(ids);
    const x0 = e.clientX, y0 = e.clientY, s0 = live.current.scroll;
    let begun = false, label = "Move clips";
    run(e, {
      move(ev) {
        if (!begun) { if (Math.abs(ev.clientX - x0) < 4 && Math.abs(ev.clientY - y0) < 4) return; gesture.begin("Move clips"); begun = true; }
        let df = Math.round((ev.clientX - x0 + live.current.scroll - s0) / live.current.zoom);
        if (pts.length && !ev.shiftKey) { const r = snapBlock(a + df, b - a, pts, live.current.zoom); df = r.start - a; setSnapLine(r.at ? r.at.frame : null); } else setSnapLine(null);
        const row = rowOf(ev.clientY, kind);
        const d = row ? row.track.index - anchor.index : 0;
        const tracks = kind === "video" ? { video: d, audio: 0 } : { video: 0, audio: d };
        // magnetic: moving storyline (V1) clips along V1 rearranges them (the storyline stays closed up)
        const storyline = !!base.magnetic && kind === "video" && d === 0 && moving.some((x) => x.trackId === O.tracksOf(base, "video")[0]?.id);
        const rearr = (ev.ctrlKey && ev.altKey) || (storyline && !ev.altKey), ins = ev.ctrlKey && !ev.altKey && !storyline, dup = ev.altKey && !ev.ctrlKey;
        label = rearr ? "Rearrange clips" : ins ? "Insert clips" : dup ? "Duplicate clips" : "Move clips";
        gesture.previewSeq((sq, cx) => (rearr ? O.rearrange(sq, cx, ids, a + df, tracks) : O.moveClips(sq, cx, ids, df, tracks, { mode: ins ? "insert" : "overwrite", duplicate: dup })));
      },
      up() {
        if (!begun) {
          // a click on a selected clip without dragging selects just it
          if (!e.shiftKey && !e.ctrlKey) select([c.id], "set", { linked: e.altKey ? false : undefined });
          return;
        }
        const before = new Set(base.clips.map((x) => x.id));
        gesture.commit(label);
        if (label === "Duplicate clips") select(getSeq().clips.filter((x) => !before.has(x.id)).map((x) => x.id), "set", { linked: false });
      },
    });
  }

  /** Edge drags: trim / ripple / roll / rate stretch. */
  function startTrim(e: React.PointerEvent, c: TimelineClip, edge: "start" | "end", t: Tool) {
    const base = getSeq();
    const orig = edge === "start" ? c.start : O.clipEnd(c);
    const neighbour = edge === "end" ? base.clips.find((x) => x.trackId === c.trackId && x.start === orig) : base.clips.find((x) => x.trackId === c.trackId && O.clipEnd(x) === orig);
    const roll = t === "roll" && !!neighbour;
    const ex = O.withLinked(base, [c.id, ...(roll && neighbour ? [neighbour.id] : [])]);
    const pts = points(ex);
    const x0 = e.clientX, s0 = live.current.scroll;
    const label = roll ? "Rolling edit" : t === "rate" ? "Rate stretch" : t === "ripple" ? "Ripple trim" : "Trim";
    let begun = false, wanted = 0, rippling = false;
    run(e, {
      move(ev) {
        if (!begun) { if (Math.abs(ev.clientX - x0) < 2) return; gesture.begin(label); begun = true; }
        const raw = orig + Math.round((ev.clientX - x0 + live.current.scroll - s0) / live.current.zoom);
        const df = snapEdge(raw, pts, ev) - orig;
        const linkedOn = ed().linked && !ev.altKey;
        gesture.previewSeq((sq, cx) => {
          if (roll && neighbour) return edge === "end" ? O.rollEdit(sq, cx, c.id, neighbour.id, df, { linked: linkedOn }) : O.rollEdit(sq, cx, neighbour.id, c.id, df, { linked: linkedOn });
          if (t === "rate") return O.rateStretch(sq, cx, c.id, edge, df, { linked: linkedOn });
          return O.trimClip(sq, cx, c.id, edge, df, { ripple: t === "ripple" || ev.ctrlKey, linked: linkedOn });
        });
        wanted = df;
        rippling = t === "ripple" || ev.ctrlKey;
      },
      up() {
        if (!begun) return;
        const same = ed().h.present === ed().h.gesture?.base;
        gesture.commit();
        if (same && wanted && rippling) toast.message("A clip on a sync-locked track is in the way: turn off that track's sync lock to ripple past it");
      },
    });
  }

  function startSlipSlide(e: React.PointerEvent, c: TimelineClip, t: "slip" | "slide") {
    const x0 = e.clientX;
    let begun = false;
    run(e, {
      move(ev) {
        if (!begun) { if (Math.abs(ev.clientX - x0) < 2) return; gesture.begin(t === "slip" ? "Slip" : "Slide"); begun = true; }
        const df = Math.round((ev.clientX - x0) / live.current.zoom);
        const linkedOn = ed().linked && !ev.altKey;
        gesture.previewSeq((sq, cx) => (t === "slip" ? O.slipClip(sq, cx, c.id, -df, { linked: linkedOn }) : O.slideClip(sq, cx, c.id, df, { linked: linkedOn })));
        if (t === "slip") {
          const now = O.clipById(getSeq(), c.id);
          if (now && now.source.type === "media") { if (ed().sourceId !== now.source.mediaId) A.openInSource(now.source.mediaId, now.source.in); else { const m = getCtx().media(now.source.mediaId); if (m) sourceTransport.seek(A.srcToDisplay(m, now.source.in)); } }
        }
      },
      up() { if (begun) gesture.commit(); },
    });
  }

  function startMarquee(e: React.PointerEvent, additive: boolean) {
    const base = getSeq();
    const keep = additive ? ed().selection : [];
    const fx0 = frameAt(e.clientX), y0 = yIn(e.clientY);
    let moved = false;
    run(e, {
      move(ev) {
        const fx1 = frameAt(ev.clientX), y1 = yIn(ev.clientY);
        if (!moved && Math.abs(ev.clientX - e.clientX) < 4 && Math.abs(ev.clientY - e.clientY) < 4) return;
        moved = true;
        const fa = Math.min(fx0, fx1), fb = Math.max(fx0, fx1), ya = Math.min(y0, y1), yb = Math.max(y0, y1);
        const { zoom: z, scroll: sc } = live.current;
        setMarquee({ x: fa * z - sc, y: ya, w: (fb - fa) * z, h: yb - ya });
        const tracks = new Set(live.current.layout.rows.filter((r) => r.top < yb && r.top + r.height > ya).map((r) => r.track.id));
        const ids = base.clips.filter((c) => tracks.has(c.trackId) && c.start < fb && O.clipEnd(c) > fa).map((c) => c.id);
        select([...new Set([...keep, ...ids])], "set", { linked: !ev.altKey && ed().linked });
      },
      up() { setMarquee(null); if (!moved && !additive) clearSelection(); },
    });
  }

  function startHand(e: React.PointerEvent) {
    const x0 = e.clientX, y0 = e.clientY, s0 = live.current.scroll, t0 = body.current!.scrollTop;
    run(e, {
      move(ev) { setView({ scroll: s0 - (ev.clientX - x0) }); body.current!.scrollTop = t0 - (ev.clientY - y0); },
      up() {},
    }, false);
  }

  /** Pen / keyframe line: drag a keyframe (frame and value), click the line to add one, drag a line without keyframes to set the level. */
  function startBand(e: React.PointerEvent, c: TimelineClip, path: string, kfFrame: number | null, addKf: boolean) {
    const audio = path === "audio.gain";
    const b = path === "timeRemap" ? SPEED_BAND : bandOf(audio);
    const clipEl = (e.target as Element).closest("[data-clip]") as HTMLElement;
    const r = clipEl.getBoundingClientRect();
    const top = r.top + NAME_H + 2, bh = r.height - NAME_H - 6;
    const valAt = (cy: number) => b.fromY(Math.max(0, Math.min(1, (cy - top) / bh)));
    const base = O.clipById(getSeq(), c.id)!;
    const p0 = getParam(base, path) as Param<number> | undefined;
    if (!p0) return;
    let frame = kfFrame;
    const f0 = Math.max(0, Math.min(c.duration - 1, Math.round(frameAt(e.clientX) - c.start)));
    gesture.begin(kfFrame !== null ? "Move keyframe" : addKf ? "Add keyframe" : b.speed ? "Speed ramp" : audio ? "Volume" : "Opacity");
    if (frame === null && addKf) {
      frame = f0;
      const v = valAt(e.clientY);
      gesture.previewSeq((sq, cx) => O.updateParam(sq, cx, c.id, path, (pp) => addKeyframe(pp as Param<number>, f0, v)));
    }
    setActiveKf(frame !== null ? { clipId: c.id, frame } : null);
    const x0 = e.clientX, y0 = e.clientY;
    const startFrame = frame;
    run(e, {
      move(ev) {
        if (startFrame !== null) {
          const nf = Math.max(0, Math.min(c.duration - 1, startFrame + Math.round((ev.clientX - x0) / live.current.zoom)));
          const v = valAt(ev.clientY);
          gesture.previewSeq((sq, cx) => O.updateParam(sq, cx, c.id, path, (pp) => {
            const q = kfFrame === null ? addKeyframe(pp as Param<number>, startFrame, v) : pp as Param<number>;
            return addKeyframe(moveKeyframe(q, startFrame, nf), nf, v);
          }));
          setActiveKf({ clipId: c.id, frame: nf });
        } else {
          // a line without keyframes moves as a whole; with keyframes all of them shift by the same amount
          const dv = valAt(ev.clientY) - valAt(y0);
          gesture.previewSeq((sq, cx) => O.updateParam(sq, cx, c.id, path, (pp) => {
            const q = p0;
            const lo = b.lo, hi = b.hi;
            const cl = (v: number) => Math.round(Math.max(lo, Math.min(hi, v)) * 10) / 10;
            if (!q.keyframes?.length) return { value: cl(q.value + dv) };
            return { ...q, keyframes: q.keyframes.map((k) => ({ ...k, value: cl(k.value + dv) })) };
          }));
        }
      },
      up() { gesture.commit(); setActiveKf(null); },
      cancel() { setActiveKf(null); },
    });
    void setParam;
  }

  function startTransitionEdge(e: React.PointerEvent, t: Transition, edge: "l" | "r") {
    const x0 = e.clientX;
    gesture.begin("Transition duration");
    run(e, {
      move(ev) {
        const df = Math.round((ev.clientX - x0) / live.current.zoom) * (edge === "r" ? 1 : -1);
        const k = t.alignment === "center" ? 2 : 1;
        const want = t.alignment === "start" && edge === "l" ? t.duration : t.alignment === "end" && edge === "r" ? t.duration : t.duration + df * k;
        gesture.previewSeq((sq, cx) => O.updateTransition(sq, cx, t.id, { duration: Math.max(1, want) }));
      },
      up() { gesture.commit(); },
    });
  }

  // ── pointer down: decide what the gesture is ───────────────────────────────
  const onDown = (e: React.PointerEvent) => {
    if (e.button === 1) { e.preventDefault(); startHand(e); return; }
    if (e.button !== 0) return;
    setFocus("timeline");
    root.current?.focus({ preventScroll: true });
    const target = e.target as HTMLElement;
    const sq = getSeq();
    const t = ed().tool;
    if (t === "hand") { startHand(e); return; }
    const frame = frameAt(e.clientX);
    const row = rowOf(e.clientY);
    if (t === "zoom") { A.zoomBy(e.altKey ? 1 / 1.6 : 1.6, frame, live.current.laneW); return; }
    // transitions
    const trEl = target.closest<HTMLElement>("[data-trans]");
    if (trEl) {
      const tr = sq.transitions.find((x) => x.id === trEl.dataset.trans);
      if (!tr) return;
      const edge = target.closest<HTMLElement>("[data-tr-edge]")?.dataset.trEdge as "l" | "r" | undefined;
      selectTransition(tr.id);
      if (edge) startTransitionEdge(e, tr, edge);
      return;
    }
    const clipEl = target.closest<HTMLElement>("[data-clip]");
    const c = clipEl ? O.clipById(sq, clipEl.dataset.clip!) : undefined;
    // keyframe line
    const band = target.closest<SVGElement>("[data-band]");
    if (c && band && (t === "pen" || t === "select" || target.hasAttribute("data-kf"))) {
      const kf = target.getAttribute("data-kf");
      if (kf !== null || t === "pen" || e.ctrlKey) {
        if (O.trackById(sq, c.trackId)?.locked) return;
        startBand(e, c, band.getAttribute("data-band")!, kf !== null ? Number(kf) : null, kf === null && (t === "pen" || e.ctrlKey));
        return;
      }
    }
    if (t === "text") {
      if (row && row.track.kind === "video" && !row.track.locked) A.newTitle({ at: Math.max(0, Math.round(frame)), trackId: c ? undefined : row.track.id });
      setTool("select");
      return;
    }
    if (t === "razor") {
      if (!c) return;
      let f = Math.round(frame);
      if (ed().snapping && !e.shiftKey) { const sn = snapFrame(f, [{ frame: program.frame, kind: "playhead" }], live.current.zoom); if (sn) f = sn.frame; }
      A.addEditAt(f, e.shiftKey ? undefined : (e.altKey ? [c.id] : O.withLinked(sq, [c.id])), e.altKey);
      return;
    }
    if (t === "trackFwd" || t === "trackBack") {
      const ids = O.trackSelect(sq, Math.round(frame), t === "trackFwd" ? 1 : -1, e.shiftKey ? row?.track.id : undefined);
      select(ids, "set");
      return;
    }
    if (!c) {
      if (row && (e.detail === 2)) return;
      selectTransition(null);
      if (t === "select" || t === "ripple" || t === "roll" || t === "rate" || t === "slip" || t === "slide" || t === "pen") startMarquee(e, e.shiftKey);
      return;
    }
    if (O.trackById(sq, c.trackId)?.locked) { select([c.id], e.shiftKey ? "toggle" : "set"); return; }
    // edges
    const r = clipEl!.getBoundingClientRect();
    const edgePx = Math.min(EDGE_PX, r.width / 3);
    const zone = e.clientX - r.left < edgePx ? "start" : r.right - e.clientX < edgePx ? "end" : "body";
    const trimTool = t === "select" || t === "ripple" || t === "roll" || t === "rate";
    if (zone !== "body" && trimTool) {
      if (!selSet.has(c.id) && !e.shiftKey) select([c.id], "set", { linked: e.altKey ? false : undefined });
      startTrim(e, c, zone, t);
      return;
    }
    // selection on press
    if (e.shiftKey) select([c.id], "toggle", { linked: e.altKey ? false : undefined });
    else if (!selSet.has(c.id)) select([c.id], "set", { linked: e.altKey ? false : undefined });
    if (t === "slip" || t === "slide") { startSlipSlide(e, c, t); return; }
    if (e.shiftKey) return;
    startMove(e, c);
  };

  const onDouble = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const trEl = target.closest<HTMLElement>("[data-trans]");
    if (trEl) { openDialog({ kind: "transition", id: trEl.dataset.trans! }); return; }
    const clipEl = target.closest<HTMLElement>("[data-clip]");
    const c = clipEl ? O.clipById(getSeq(), clipEl.dataset.clip!) : undefined;
    if (!c) return;
    if (c.source.type === "media") A.openInSource(c.source.mediaId, c.source.in);
    else if (c.source.type === "title") window.dispatchEvent(new CustomEvent("ed:panel", { detail: "text" }));
    else if (c.source.type === "nested") M.openTab(c.source.sequenceId, { fromParent: true });
  };

  const onHoverMove = (e: React.PointerEvent) => {
    if (drag.current) return;
    const el = body.current;
    if (!el) return;
    const t = ed().tool;
    const target = e.target as HTMLElement;
    let cursor = CURSOR[t] ?? "default";
    const clipEl = target.closest<HTMLElement>("[data-clip]");
    if (target.closest("[data-tr-edge]")) cursor = "ew-resize";
    else if (target.closest("[data-trans]")) cursor = "pointer";
    else if (clipEl && (t === "select" || t === "ripple" || t === "roll" || t === "rate")) {
      const r = clipEl.getBoundingClientRect();
      const edgePx = Math.min(EDGE_PX, r.width / 3);
      if (e.clientX - r.left < edgePx || r.right - e.clientX < edgePx) cursor = t === "roll" ? "col-resize" : t === "rate" ? "ew-resize" : "ew-resize";
    } else if (clipEl && (t === "slip" || t === "slide")) cursor = "ew-resize";
    if (target.closest("[data-kf]")) cursor = "move";
    else if (target.closest("[data-band]") && (t === "pen" || e.ctrlKey)) cursor = "copy";
    if (el.style.cursor !== cursor) el.style.cursor = cursor;
    if (t === "razor") setHover({ x: e.clientX - laneLeft() }); else if (hover) setHover(null);
  };

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    const target = e.target as HTMLElement;
    const sq = getSeq();
    const trEl = target.closest<HTMLElement>("[data-trans]");
    if (trEl) { selectTransition(trEl.dataset.trans!); openMenu(e, transitionMenu(trEl.dataset.trans!)); return; }
    const clipEl = target.closest<HTMLElement>("[data-clip]");
    const c = clipEl ? O.clipById(sq, clipEl.dataset.clip!) : undefined;
    if (c) {
      if (!ed().selection.includes(c.id)) select([c.id]);
      openMenu(e, clipMenu(c));
      return;
    }
    const row = rowOf(e.clientY);
    if (row) openMenu(e, gapMenu(row.track.id, Math.round(frameAt(e.clientX))));
  };

  // wheel: Alt / Ctrl zoom around the pointer, Shift (or a sideways trackpad) scrolls in time
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) {
        e.preventDefault();
        A.zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25, frameAt(e.clientX), live.current.laneW);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        setView({ scroll: live.current.scroll + (e.shiftKey ? e.deltaY : e.deltaX) });
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  // ── drag and drop from the bin, source, effects and Explorer ───────────────
  const dropInfo = (e: React.DragEvent, pay: DragPayload | null) => {
    const sq = getSeq();
    const row = rowOf(e.clientY);
    const frame = Math.max(0, Math.round(frameAt(e.clientX)));
    return { sq, row, frame, pay };
  };
  const placeFor = (sq: Sequence, row: ReturnType<typeof rowOf>, items: { mediaId: string; video?: boolean; audio?: boolean }[]) => {
    const vts = O.tracksOf(sq, "video"), ats = O.tracksOf(sq, "audio");
    const idx = row?.track.index ?? 0;
    const v = row?.track.kind === "video" ? row.track : vts[Math.min(idx, vts.length - 1)];
    const a = row?.track.kind === "audio" ? row.track : ats[Math.min(idx, ats.length - 1)];
    const anyV = items.some((it) => it.video !== false && media.get(it.mediaId)?.kind !== "audio");
    const anyA = items.some((it) => it.audio !== false && (media.get(it.mediaId)?.kind === "audio" || media.get(it.mediaId)?.hasAudio));
    return { v: anyV ? v : undefined, a: anyA ? a : undefined };
  };
  const onDragOver = (e: React.DragEvent) => {
    const file = isFileDrag(e);
    if (!isEditorDrag(e) && !file) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const { sq, row, frame, pay } = dropInfo(e, currentDrag(e));
    if (pay?.kind === "effect") {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-clip]");
      const c = el ? O.clipById(sq, el.dataset.clip!) : undefined;
      setDropClip(c && O.kindOf(sq, c) === pay.media ? c.id : null);
      return;
    }
    if (pay?.kind === "transition") {
      if (!row || row.track.kind !== pay.media) { setDropCut(null); return; }
      const pts = O.editPoints(sq, [row.track.id]).filter((f) => sq.clips.some((c) => c.trackId === row.track.id && (c.start === f || O.clipEnd(c) === f)));
      const near = pts.reduce<number | null>((b, f) => (Math.abs(f - frame) * live.current.zoom < 40 && (b === null || Math.abs(f - frame) < Math.abs(b - frame)) ? f : b), null);
      setDropCut(near !== null ? { trackId: row.track.id, at: near } : null);
      return;
    }
    // media, a sequence or files: ghosts where they'd land
    let len = 0;
    let items: { mediaId: string; video?: boolean; audio?: boolean }[] = [];
    if (pay?.kind === "media") {
      items = pay.items;
      for (const it of items) { const m = media.get(it.mediaId); if (m) len += mediaSpan(m, sq.fps).frames; }
    } else if (pay?.kind === "sequence") {
      const ns = p.sequences.find((x) => x.id === pay.sequenceId);
      len = ns ? Math.max(1, O.seqEnd(ns)) : 0;
    } else len = Math.round(sq.fps * 5);
    const place = pay?.kind === "media" ? placeFor(sq, row, items) : { v: row?.track.kind === "video" ? row.track : O.tracksOf(sq, "video")[0], a: undefined as Track | undefined };
    let start = frame;
    if (ed().snapping && !e.shiftKey) start = snapBlock(frame, len, snapPoints(sq, { playhead: program.frame }), live.current.zoom).start;
    const gs: Drop[] = [];
    if (place.v) gs.push({ kind: "ghost", trackId: place.v.id, start, duration: len });
    if (place.a) gs.push({ kind: "ghost", trackId: place.a.id, start, duration: len });
    setGhosts(gs);
  };
  const clearDrop = () => { setGhosts([]); setDropClip(null); setDropCut(null); };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const pay = currentDrag(e);
    const { sq, row, pay: p2 } = dropInfo(e, pay);
    const g = ghosts[0];
    const mode = e.ctrlKey ? "insert" : "overwrite";
    const at = g?.start ?? Math.max(0, Math.round(frameAt(e.clientX)));
    clearDrop();
    if (p2?.kind === "effect") {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-clip]");
      const c = el ? O.clipById(sq, el.dataset.clip!) : undefined;
      if (!c) return;
      const targets = ed().selection.includes(c.id) ? sq.clips.filter((x) => ed().selection.includes(x.id) && O.kindOf(sq, x) === p2.media).map((x) => x.id) : [c.id];
      A.applyEffect(targets, () => makeEffect(p2.effect), "Apply effect");
      return;
    }
    if (p2?.kind === "transition") {
      const cut = dropCut;
      if (!cut) return;
      const before = sq.clips.find((c) => c.trackId === cut.trackId && O.clipEnd(c) === cut.at), after = sq.clips.find((c) => c.trackId === cut.trackId && c.start === cut.at);
      A.addTransitionAt(cut.trackId, cut.at, p2.transition, before && after ? undefined : after ? "to" : "from");
      return;
    }
    if (p2?.kind === "media") {
      const place = placeFor(sq, row, p2.items);
      A.dropMedia(p2.items, at, place.v?.id, place.a?.id, mode);
      return;
    }
    if (p2?.kind === "sequence") {
      const v = row?.track.kind === "video" ? row.track : O.tracksOf(sq, "video")[0];
      const a = O.tracksOf(sq, "audio")[Math.min(v.index, O.tracksOf(sq, "audio").length - 1)];
      A.dropSequence(p2.sequenceId, at, v.id, a?.id, mode);
      return;
    }
    if (e.dataTransfer.files?.length) {
      const fresh = await importDropped(e.dataTransfer.files);
      if (!fresh.length) return;
      const place = placeFor(getSeq(), row, fresh.map((m) => ({ mediaId: m.id })));
      A.dropMedia(fresh.map((m) => ({ mediaId: m.id })), at, place.v?.id, place.a?.id, mode);
    }
  };

  // ── render ─────────────────────────────────────────────────────────────────
  const f0 = scroll / zoom - 2, f1 = (scroll + laneW) / zoom + 2;
  const inout = O.markedRange(s);
  const totalH = layout.height;
  return (
    <div ref={root} tabIndex={-1} className={clsx("tl", s.magnetic && "magnetic")} onFocus={() => setFocus("timeline")} onPointerDown={() => setFocus("timeline")}>
      <SequenceTabs />
      <TimelineBar seq={s} laneW={laneW} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0">
          <div className="flex shrink-0 items-center border-b border-r border-line px-2" style={{ width: HEADER_W, height: 34 }}>
            <PlayheadTimecode fps={s.fps} />
          </div>
          <Ruler seq={s} zoom={zoom} scroll={scroll} width={laneW} selMarker={st.selMarker} onEditMarker={(id) => openDialog({ kind: "marker", id })} />
        </div>
        <div ref={body} className="tl-body" onPointerDown={onDown} onPointerMove={onHoverMove} onPointerLeave={() => setHover(null)}
          onDoubleClick={onDouble} onContextMenu={onContext} onDragOver={onDragOver} onDragLeave={(e) => { if (!body.current?.contains(e.relatedTarget as Node)) clearDrop(); }} onDrop={onDrop}>
          <div className="relative" style={{ height: totalH + 60 }}>
            {layout.rows.map((r, i) => {
              const t = r.track;
              const cs = byTrack.get(t.id) ?? [];
              const audio = t.kind === "audio";
              return (
                <div key={t.id} className={clsx("tl-row absolute inset-x-0", i % 2 && "alt", t.locked && "locked", s.magnetic && t.kind === "video" && t.index === 0 && "storyline")} style={{ top: r.top, height: r.height + 1 }}>
                  <TrackHeader track={t} width={HEADER_W} clips={cs.length} />
                  <div className="tl-lane" data-track={t.id} style={{ height: r.height }}>
                    {cs.map((c) => {
                      if (O.clipEnd(c) < f0 || c.start > f1) return null;
                      const m = c.source.type === "media" ? media.get(c.source.mediaId) : undefined;
                      return (
                        <ClipView key={c.id} clip={c} media={m} url={m ? urlFor(m) : undefined} x={c.start * zoom - scroll} w={c.duration * zoom} laneW={laneW}
                          height={r.height - 1} audio={audio} selected={selSet.has(c.id)} zoom={zoom} rate={O.sourceRate(c, s, ctx)}
                          band={r.height >= 34} drop={dropClip === c.id} missing={!!m && (m.missing || m.offline || !urlFor(m))}
                          activeKf={activeKf?.clipId === c.id ? activeKf.frame : null} />
                      );
                    })}
                    {(trByTrack.get(t.id) ?? []).map((tr) => {
                      const [a, b] = O.transitionRange(tr);
                      if (b < f0 || a > f1) return null;
                      return (
                        <div key={tr.id} data-trans={tr.id} title={`${transitionLabel(tr.type)} · ${toTimecode(tr.duration, s.fps)} — double-click for settings`}
                          className={clsx("tl-trans", audio && "audio", st.selTransition === tr.id && "sel", O.transitionRepeats(s, ctx, tr) && "repeat")}
                          style={{ left: a * zoom - scroll, width: Math.max(6, (b - a) * zoom), top: r.height > 40 ? 17 : 1, height: Math.max(10, Math.round((r.height - (r.height > 40 ? 17 : 1)) * 0.45)) }}>
                          {(b - a) * zoom > 40 ? transitionLabel(tr.type) : ""}
                          <span data-tr-edge="l" className="edge l" /><span data-tr-edge="r" className="edge r" />
                        </div>
                      );
                    })}
                    {ghosts.filter((g) => g.trackId === t.id).map((g, j) => (
                      <div key={j} className="tl-ghost" style={{ left: g.start * zoom - scroll, width: Math.max(4, g.duration * zoom) }} />
                    ))}
                    {dropCut?.trackId === t.id && <div className="tl-ghost" style={{ left: dropCut.at * zoom - scroll - 12, width: 24 }} />}
                  </div>
                </div>
              );
            })}
            <div className="tl-split absolute inset-x-0" style={{ top: layout.splitTop, height: SPLIT_H }} />
            {/* overlays over the lanes */}
            <div className="pointer-events-none absolute bottom-0 right-0 top-0 overflow-hidden" style={{ left: HEADER_W }}>
              {inout && <div className="tl-inout" style={{ left: inout[0] * zoom - scroll, width: (inout[1] - inout[0]) * zoom }} />}
              {st.snapLine !== null && <div className="tl-snap" style={{ left: st.snapLine * zoom - scroll }} />}
              {hover && tool === "razor" && <div className="tl-snap" style={{ left: hover.x, background: "var(--color-ink)", boxShadow: "none", opacity: 0.6 }} />}
              {marquee && <div className="tl-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
            </div>
            <div className="absolute bottom-0 left-0 flex gap-1 px-2 py-1" style={{ top: totalH + 4, width: HEADER_W }}>
              <button type="button" className="ed-ibtn !h-6 !w-auto gap-1 px-1.5 text-2xs" onClick={() => A.addTrack("video")}><Plus className="size-3" />Video</button>
              <button type="button" className="ed-ibtn !h-6 !w-auto gap-1 px-1.5 text-2xs" onClick={() => A.addTrack("audio")}><Plus className="size-3" />Audio</button>
            </div>
          </div>
        </div>
        <div className="pointer-events-none absolute bottom-0 right-0 top-0 overflow-hidden" style={{ left: HEADER_W }}>
          <Playhead zoom={zoom} scroll={scroll} width={laneW} />
        </div>
      </div>
      <div className="flex shrink-0">
        <div className="shrink-0 border-r border-t border-line" style={{ width: HEADER_W }} />
        <MiniMap seq={s} zoom={zoom} scroll={scroll} width={laneW} />
      </div>
    </div>
  );
}

/** Sequences open as tabs, and the way back up from a nested sequence (breadcrumbs). */
function SequenceTabs() {
  const p = useProject();
  const { tabs, crumbs } = useEditor(useShallow((x) => ({ tabs: x.tabs, crumbs: x.crumbs })));
  const active = p.activeSequenceId;
  const list = [...new Set([...tabs.filter((id) => p.sequences.some((s) => s.id === id)), active])];
  const name = (id: string) => p.sequences.find((s) => s.id === id)?.name ?? "?";
  // the trail is only shown while it still leads here (each step nests the next)
  const trail = crumbs.filter((id) => p.sequences.some((s) => s.id === id));
  const valid = trail.length > 0 && trail.every((id, i) => {
    const next = trail[i + 1] ?? active;
    return p.sequences.find((s) => s.id === id)?.clips.some((c) => c.source.type === "nested" && c.source.sequenceId === next);
  });
  if (list.length < 2 && !valid) return null;
  return (
    <div className="tl-tabs">
      {list.map((id) => (
        <div key={id} className={clsx("tl-tab", id === active && "on")} onClick={() => M.openTab(id)} title={name(id)}>
          {p.sequences.find((s) => s.id === id)?.multicam ? <Rows3 className="size-3 shrink-0 opacity-70" /> : null}
          <span className="truncate">{name(id)}</span>
          {list.length > 1 && <button type="button" className="x" title="Close this tab" onClick={(e) => { e.stopPropagation(); M.closeTab(id); }}><X className="size-3" /></button>}
        </div>
      ))}
      {valid && (
        <div className="tl-crumbs" title="Nested sequences: click to go back up">
          {trail.map((id) => (
            <span key={id} className="flex items-center gap-1"><button type="button" onClick={() => M.openTab(id)}>{name(id)}</button><ChevronRight className="size-3 opacity-50" /></span>
          ))}
          <span className="text-ink">{name(active)}</span>
        </div>
      )}
    </div>
  );
}

function PlayheadTimecode({ fps }: { fps: number }) {
  const f = useFrame(program);
  return <TimecodeField frame={f} fps={fps} size="lg" className="text-accent-ink" onChange={(v) => program.seek(v)} />;
}

/** The timeline's tool strip: tools, snapping, linked selection, add marker, sequence switcher and zoom. */
function TimelineBar({ seq: s, laneW }: { seq: Sequence; laneW: number }) {
  const { tool, snapping, linked, zoom, snapBeats, snapTransients } = useEditor(useShallow((x) => ({ tool: x.tool, snapping: x.snapping, linked: x.linked, zoom: x.zoom, snapBeats: x.snapBeats, snapTransients: x.snapTransients })));
  const p = useProject();
  const slider = (z: number) => Math.round((Math.log(z / 0.002) / Math.log(60 / 0.002)) * 1000);
  const fromSlider = (v: number) => 0.002 * Math.pow(60 / 0.002, v / 1000);
  return (
    <div className="ed-bar gap-1">
      <select className="ed-field max-w-[11rem] truncate" value={s.id} onChange={(e) => M.openTab(e.target.value)} title="Sequence">
        {p.sequences.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
      <span className="mx-1 h-4 w-px bg-line" />
      {TOOLS.map((t) => {
        const I = TOOL_ICON[t.id];
        return <IBtn key={t.id} title={t.label} shortcut={t.key} on={tool === t.id} onClick={() => setTool(t.id)}><I className="size-3.5" /></IBtn>;
      })}
      <span className="mx-1 h-4 w-px bg-line" />
      <IBtn title={`${snapping ? "Snapping on" : "Snapping off"} (right-click: beats, audio transients)`} shortcut="S" on={snapping} onClick={toggleSnapping}
        onContextMenu={(e) => { e.preventDefault(); openMenu(e, [
          { label: "Snapping", shortcut: "S", checked: snapping, onClick: toggleSnapping },
          { label: "Snap to beat markers", checked: snapBeats, separator: true, onClick: toggleSnapBeats },
          { label: "Snap to audio transients", checked: snapTransients, onClick: toggleSnapTransients },
        ]); }}><Magnet className="size-3.5" /></IBtn>
      <button type="button" className={clsx("tl-mag", s.magnetic && "on")} onClick={M.toggleMagnetic}
        title={s.magnetic ? "Magnetic timeline: V1 is the storyline — gaps close and clips above ride along (click for position mode)" : "Position mode: clips stay where you put them (click for the magnetic timeline)"}>
        {s.magnetic ? "Magnetic" : "Position"}
      </button>
      <IBtn title={linked ? "Linked selection on" : "Linked selection off"} on={linked} onClick={toggleLinked}><Link2 className="size-3.5" /></IBtn>
      <IBtn title="Add marker" shortcut="M" onClick={() => A.addSeqMarker()}><Bookmark className="size-3.5" /></IBtn>
      <IBtn title="Apply default transition" shortcut="Ctrl+D" onClick={() => A.defaultTransitions("video")}><Blend className="size-3.5" /></IBtn>
      <div className="ml-auto flex items-center gap-2">
        <span className="mono text-2xs text-dim">{s.width}×{s.height} · {s.fps} fps</span>
        <input type="range" min={0} max={1000} value={slider(zoom)} title="Zoom (= / -, \ to fit, Alt+wheel)" className="w-28 accent-[var(--color-accent)]"
          onChange={(e) => A.zoomBy(fromSlider(Number(e.target.value)) / zoom, program.frame, laneW)} />
        <IBtn title="Zoom to fit" shortcut="\" onClick={() => A.zoomToFit(laneW)}><ZoomIn className="size-3.5" /></IBtn>
      </div>
    </div>
  );
}
