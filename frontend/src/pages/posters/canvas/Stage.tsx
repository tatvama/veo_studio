/**
 * The live editing canvas (Konva). Fills its parent and reads/writes the editor store.
 * Two Konva layers: the page (background + design layers, panned and zoomed as one group, the only thing ever exported)
 * and the UI (transformer, guides, safe areas, grid, outlines, marquee), drawn in screen space.
 */
import Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type { Vector2d } from "konva/lib/types";
import {
  ArrowDownToLine, ArrowUpToLine, BringToFront, ChevronDown, ChevronUp, ClipboardPaste, Copy, Crosshair, EyeOff, Grid3x3, ImageDown,
  Lock, LockOpen, Maximize, ScanLine, SendToBack, Sparkles, SquareDashed, Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Layer as KLayer, Stage, Transformer } from "react-konva";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { isTypingTarget, MOD } from "../../../components/shell/keys";
import { cn } from "../../../lib/cn";
import { tr, useT } from "../../../lib/i18n";
import "../../../styles/posters.css";
import { runAi } from "../api";
import { boundsOf, displayText, fixFontForText, unionBox, type Box } from "../doc";
import { loadFontsFor } from "../fonts";
import { useEditor } from "../store";
import { DND_MIME, type DropPayload, type ImageLayer, type Layer, type TextLayer } from "../types";
import { getCacheScale, setCacheScale } from "./cacheScale";
import { useCanvasColors } from "./colors";
import { canvasCommand, clampZoom, effectiveFormat } from "./commands";
import { ContextMenu, type CtxItem } from "./ContextMenu";
import { containsPoint, copyLayers, handlePaste, placePayload, slotAt, uploadFiles } from "./drop";
import { registerExporter, type RenderOptions } from "./exporter";
import { loadImage, nextFrame } from "./images";
import { BackgroundView, LayerView, PENDING_LABEL, quietSlots } from "./nodes";
import { cornerPoints, DropTarget, GridOverlay, Guides, Marquee, Outline, SafeArea } from "./overlays";
import { buildTargets, snapMove, snapValue, type GapHint, type Guide, type SnapTargets } from "./snap";
import { TextEditor } from "./TextEditor";
import { neededHeight } from "./textLayout";
import { useViewport } from "./useViewport";

Konva.dragDistance = 3;

const r2 = (v: number) => Math.round(v * 100) / 100;
const normRot = (r: number) => r2((((r % 360) + 540) % 360) - 180);
const ALL_ANCHORS = ["top-left", "top-center", "top-right", "middle-right", "middle-left", "bottom-left", "bottom-center", "bottom-right"];
const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];
const SNAPS_15 = Array.from({ length: 24 }, (_, i) => i * 15);
const SNAPS_90 = [0, 90, 180, 270];

type DragGesture = {
  kind: "drag"; start: Record<string, { x: number; y: number }>; box0: Box; pointer0: Vector2d; targets: SnapTargets;
  delta: { dx: number; dy: number }; key: string; guides: Guide[]; gaps: GapHint[];
};
type TransformGesture = {
  kind: "resize" | "rotate"; ids: string[]; startLayers: Record<string, Layer>; anchor: string; targets: SnapTargets;
  /** nodes scale visually during the gesture and are baked at the end (multi-selection, filtered images) */
  scaleMode: boolean; multi: boolean; fontScale: boolean; guides: Guide[];
};
type Gesture = DragGesture | TransformGesture;

interface Down { at: Vector2d; id: string | null; locked: boolean; additive: boolean; toggleOnClick: boolean; narrowOnClick: boolean; dragged: boolean }
interface GestureUI { guides: Guide[]; gaps: GapHint[]; readout: { x: number; y: number; text: string } | null }

function layerGroupOf(n: Konva.Node | null): Konva.Group | null {
  let c: Konva.Node | null = n;
  while (c && c.getClassName() !== "Stage") {
    if (c.getClassName() === "Transformer") return null;
    if (c.hasName("layer")) return c as Konva.Group;
    c = c.getParent();
  }
  return null;
}
const inTransformer = (n: Konva.Node | null) => {
  let c: Konva.Node | null = n;
  while (c) { if (c.getClassName() === "Transformer") return true; c = c.getParent(); }
  return false;
};

/** Scale the "content" of a layer with its box (multi-selection resize): font sizes, strokes, radii, shadows. */
function scaleContent(l: Layer, k: number): Partial<Layer> {
  const shadow = l.shadow ? { ...l.shadow, blur: r2(l.shadow.blur * k), x: r2(l.shadow.x * k), y: r2(l.shadow.y * k) } : l.shadow;
  if (l.type === "text") {
    return {
      fontSize: r2(l.fontSize * k), letterSpacing: r2(l.letterSpacing * k), shadow,
      stroke: l.stroke ? { ...l.stroke, width: r2(l.stroke.width * k) } : l.stroke,
      background: l.background ? { ...l.background, padding: r2(l.background.padding * k), radius: r2(l.background.radius * k) } : l.background,
    } as Partial<TextLayer>;
  }
  if (l.type === "shape") {
    return { shadow, cornerRadius: l.cornerRadius != null ? r2(l.cornerRadius * k) : l.cornerRadius,
      stroke: l.stroke ? { ...l.stroke, width: r2(l.stroke.width * k) } : l.stroke, dash: l.dash?.map((d) => r2(d * k)) } as Partial<Layer>;
  }
  if (l.type === "image") {
    return { shadow, cornerRadius: l.cornerRadius != null ? r2(l.cornerRadius * k) : l.cornerRadius,
      stroke: l.stroke ? { ...l.stroke, width: r2(l.stroke.width * k) } : l.stroke } as Partial<Layer>;
  }
  return {};
}

const hasCache = (l: Layer | undefined) => !!l && l.type === "image" && !!l.src && (l.mask === "fade-bottom" || l.mask === "fade-top"
  || Object.values(l.filters ?? {}).some((v) => !!v));

let renderChain: Promise<unknown> = Promise.resolve();

export function EditorCanvas({ designId }: { designId: number }) {
  const t = useT();
  const colors = useCanvasColors();
  const { doc, W, H, selection, hover, editingTextId, snapOn, showSafe, showGrid, format } = useEditor(useShallow((s) => ({
    doc: s.doc, W: s.width, H: s.height, selection: s.selection, hover: s.hover, editingTextId: s.editingTextId,
    snapOn: s.snap, showSafe: s.showSafe, showGrid: s.showGrid, format: s.design?.format ?? "",
  })));
  const vp = useViewport(W, H, designId);
  const { view, size } = vp;
  const viewRef = useRef(view);
  viewRef.current = view;

  const stageRef = useRef<Konva.Stage>(null);
  const pageRef = useRef<Konva.Group>(null);
  const pageLayerRef = useRef<Konva.Layer>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fileTarget = useRef<string | null>(null);

  const gesture = useRef<Gesture | null>(null);
  const down = useRef<Down | null>(null);
  const [gestureUI, setGestureUI] = useState<GestureUI | null>(null);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const marqueeStart = useRef<Vector2d | null>(null);
  const marqueeRef = useRef<Box | null>(null);
  const [live, setLive] = useState<Record<string, Partial<Layer>>>({});
  const liveQueue = useRef<Record<string, Partial<Layer>>>({});
  const raf = useRef(0);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string | null } | null>(null);
  const [mods, setMods] = useState({ shift: false, alt: false });
  const modsRef = useRef({ shift: false, alt: false, ctrl: false });
  const snapRef = useRef(snapOn);
  snapRef.current = snapOn;

  // ── fonts ──
  const [fontsVersion, setFontsVersion] = useState(0);
  const bumpFonts = useCallback(() => setFontsVersion((v) => v + 1), []);
  useEffect(() => {
    const fonts = document.fonts;
    if (!fonts?.addEventListener) return;
    fonts.addEventListener("loadingdone", bumpFonts);
    return () => fonts.removeEventListener("loadingdone", bumpFonts);
  }, [bumpFonts]);
  const texts = doc.layers.filter((l): l is TextLayer => l.type === "text");
  const fontKey = [...new Set(texts.map((l) => `${l.fontFamily}|${l.fontWeight}|${l.fontStyle}|${displayText(l).slice(0, 40)}`))].join("¦");
  useEffect(() => {
    let alive = true;
    void loadFontsFor(texts.map((l) => ({ fontFamily: l.fontFamily, fontWeight: l.fontWeight, fontStyle: l.fontStyle, text: displayText(l) })))
      .then(() => { if (alive) bumpFonts(); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontKey]);

  // ── layers as drawn (with live transform previews) ──
  const layers = useMemo(() => doc.layers.map((l) => (live[l.id] ? ({ ...l, ...live[l.id] } as Layer) : l)), [doc.layers, live]);
  const byId = useMemo(() => new Map(layers.map((l) => [l.id, l])), [layers]);
  const quiet = useMemo(() => quietSlots(doc.layers), [doc.layers]);
  const selected = useMemo(() => layers.filter((l) => selection.includes(l.id)), [layers, selection]);
  const editable = selected.filter((l) => !l.locked && l.visible && l.id !== editingTextId);

  // ── modifier keys (rotation snapping, ratio, snapping override) ──
  useEffect(() => {
    const upd = (e: KeyboardEvent) => {
      modsRef.current = { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
      setMods((m) => (m.shift === e.shiftKey && m.alt === e.altKey ? m : { shift: e.shiftKey, alt: e.altKey }));
    };
    const reset = () => { modsRef.current = { shift: false, alt: false, ctrl: false }; setMods({ shift: false, alt: false }); };
    window.addEventListener("keydown", upd);
    window.addEventListener("keyup", upd);
    window.addEventListener("blur", reset);
    return () => { window.removeEventListener("keydown", upd); window.removeEventListener("keyup", upd); window.removeEventListener("blur", reset); };
  }, []);

  // ── transformer ──
  const attachKey = editable.map((l) => l.id).join(",");
  useEffect(() => {
    const tr = trRef.current, stage = stageRef.current;
    if (!tr || !stage) return;
    const nodes = attachKey ? attachKey.split(",").map((id) => stage.findOne<Konva.Group>(`#${id}`)).filter((n): n is Konva.Group => !!n) : [];
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
  }, [attachKey, layers.length]);

  const single = editable.length === 1 ? editable[0] : null;
  const trCfg = useMemo(() => {
    if (!editable.length) return { keepRatio: false, anchors: [] as string[], shiftBehavior: "default" };
    if (editable.length > 1) return { keepRatio: true, anchors: CORNERS, shiftBehavior: "none" };
    const l = editable[0];
    if (l.type === "image") return { keepRatio: true, anchors: ALL_ANCHORS, shiftBehavior: "inverted" };
    if (l.type === "text") return { keepRatio: mods.alt, anchors: ALL_ANCHORS, shiftBehavior: "default" };
    if (l.type === "shape" && (l.shape === "line" || l.shape === "arrow")) return { keepRatio: false, anchors: ["middle-left", "middle-right", ...CORNERS], shiftBehavior: "default" };
    return { keepRatio: false, anchors: ALL_ANCHORS, shiftBehavior: "default" };
  }, [editable.length, single?.type, (single as { shape?: string } | null)?.shape, mods.alt]); // eslint-disable-line react-hooks/exhaustive-deps

  const flushUI = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const g = gesture.current;
      if (Object.keys(liveQueue.current).length) setLive({ ...liveQueue.current });
      if (!g) return;
      const v = viewRef.current;
      if (g.kind === "drag") {
        const b = { ...g.box0, x: g.box0.x + g.delta.dx, y: g.box0.y + g.delta.dy };
        setGestureUI({ guides: g.guides, gaps: g.gaps, readout: { x: v.x + (b.x + b.width / 2) * v.z, y: v.y + (b.y + b.height) * v.z + 12,
          text: `X ${Math.round(b.x)}  Y ${Math.round(b.y)}` } });
      } else {
        const tr = trRef.current;
        if (!tr) return;
        const rect = tr.getClientRect();
        const nodes = tr.nodes();
        let text = "";
        if (g.kind === "rotate") text = `${Math.round(normRot(nodes[0]?.rotation() ?? 0))}°`;
        else if (nodes.length === 1) {
          const n = nodes[0];
          text = `${Math.round(n.getAttr("boxW") * Math.abs(n.scaleX()))} × ${Math.round(n.getAttr("boxH") * Math.abs(n.scaleY()))}`;
        } else text = `${Math.round(rect.width / v.z)} × ${Math.round(rect.height / v.z)}`;
        setGestureUI({ guides: g.guides, gaps: [], readout: { x: rect.x + rect.width / 2, y: rect.y + rect.height + 14, text } });
      }
    });
  }, []);

  // ── dragging (all selected layers move together, with smart guides) ──
  const dragBound = useCallback(function (this: Konva.Node, pos: Vector2d): Vector2d {
    const g = gesture.current;
    const stage = this.getStage();
    if (!g || g.kind !== "drag" || !stage) return pos;
    const start = g.start[this.id()];
    if (!start) return pos;
    const v = viewRef.current;
    const p = stage.getPointerPosition() ?? pos;
    const key = `${p.x},${p.y},${modsRef.current.shift},${modsRef.current.ctrl},${snapRef.current}`;
    if (key !== g.key) {
      g.key = key;
      let dx = (p.x - g.pointer0.x) / v.z, dy = (p.y - g.pointer0.y) / v.z;
      const lockX = modsRef.current.shift && Math.abs(dy) > Math.abs(dx), lockY = modsRef.current.shift && !lockX;
      if (lockX) dx = 0;
      if (lockY) dy = 0;
      g.guides = [];
      g.gaps = [];
      if (snapRef.current && !modsRef.current.ctrl) {
        const r = snapMove({ ...g.box0, x: g.box0.x + dx, y: g.box0.y + dy }, g.targets, 6 / v.z, { x: !lockX, y: !lockY });
        dx += r.dx;
        dy += r.dy;
        g.guides = r.guides;
        g.gaps = r.gaps;
      }
      g.delta = { dx, dy };
    }
    return { x: v.x + (start.x + g.delta.dx) * v.z, y: v.y + (start.y + g.delta.dy) * v.z };
  }, []);

  const onDragStart = (e: KonvaEventObject<DragEvent>) => {
    const node = e.target;
    if (!node.hasName("layer") || gesture.current) return;
    const st = useEditor.getState();
    const ids = st.selection.includes(node.id()) ? st.selection : [node.id()];
    const movable = st.doc.layers.filter((l) => ids.includes(l.id) && !l.locked && l.visible);
    if (!movable.length) return;
    const start: DragGesture["start"] = {};
    movable.forEach((l) => { start[l.id] = { x: l.x, y: l.y }; });
    gesture.current = {
      kind: "drag", start, box0: unionBox(movable.map(boundsOf))!, pointer0: down.current?.at ?? stageRef.current!.getPointerPosition()!,
      targets: buildTargets(st.doc.layers, new Set(ids), st.width, st.height), delta: { dx: 0, dy: 0 }, key: "", guides: [], gaps: [],
    };
    if (down.current) down.current.dragged = true;
    st.setHover(null);
    setMenu(null);
  };
  const onDragMove = () => { if (gesture.current?.kind === "drag") flushUI(); };
  const onDragEnd = () => {
    const g = gesture.current;
    if (!g || g.kind !== "drag") return;
    gesture.current = null;
    const { dx, dy } = g.delta;
    const patches: Record<string, Partial<Layer>> = {};
    for (const [id, s] of Object.entries(g.start)) patches[id] = { x: r2(s.x + dx), y: r2(s.y + dy) };
    if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) useEditor.getState().patchLayers(patches);
    // make sure every node sits exactly where the document now says
    const stage = stageRef.current;
    for (const [id, p] of Object.entries(patches)) stage?.findOne(`#${id}`)?.position(p as Vector2d);
    setGestureUI(null);
  };

  // ── transforming ──
  const onTransformStart = () => {
    const tr = trRef.current;
    if (!tr) return;
    const st = useEditor.getState();
    const nodes = tr.nodes();
    const ids = nodes.map((n) => n.id());
    const startLayers: Record<string, Layer> = {};
    st.doc.layers.forEach((l) => { if (ids.includes(l.id)) startLayers[l.id] = l; });
    const anchor = tr.getActiveAnchor() ?? "";
    const multi = nodes.length > 1;
    gesture.current = {
      kind: anchor === "rotater" ? "rotate" : "resize", ids, startLayers, anchor, multi,
      scaleMode: multi || hasCache(startLayers[ids[0]]),
      fontScale: !multi && startLayers[ids[0]]?.type === "text" && modsRef.current.alt && CORNERS.includes(anchor),
      targets: buildTargets(st.doc.layers, new Set(ids), st.width, st.height), guides: [],
    };
    st.setHover(null);
    setMenu(null);
  };

  const onTransform = (e: KonvaEventObject<Event>) => {
    const g = gesture.current;
    const node = e.target as Konva.Group;
    if (!g || g.kind === "drag" || !node.hasName("layer")) return;
    if (!g.scaleMode) {
      const l0 = g.startLayers[node.id()];
      const w = Math.max(1, node.getAttr("boxW") * Math.abs(node.scaleX())), h = Math.max(1, node.getAttr("boxH") * Math.abs(node.scaleY()));
      node.setAttrs({ boxW: w, boxH: h, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0 });
      let patch: Partial<Layer> = { x: node.x(), y: node.y(), width: w, height: h, rotation: node.rotation() };
      if (g.fontScale && l0) patch = { ...patch, ...scaleContent(l0, w / l0.width) } as Partial<Layer>;
      liveQueue.current[node.id()] = patch;
    }
    flushUI();
  };

  const onTransformEnd = () => {
    const g = gesture.current;
    const tr = trRef.current;
    if (!g || g.kind === "drag" || !tr) return;
    gesture.current = null;
    const patches: Record<string, Partial<Layer>> = {};
    for (const node of tr.nodes()) {
      const l0 = g.startLayers[node.id()];
      if (!l0) continue;
      const sx = Math.abs(node.scaleX()), sy = Math.abs(node.scaleY());
      const w = Math.max(1, node.getAttr("boxW") * sx), h = Math.max(1, node.getAttr("boxH") * sy);
      let p: Partial<Layer> = { x: r2(node.x()), y: r2(node.y()), width: r2(w), height: r2(h), rotation: normRot(node.rotation()) };
      if (g.multi) p = { ...p, ...scaleContent(l0, Math.sqrt(sx * sy)) } as Partial<Layer>;
      else if (g.fontScale) p = { ...p, ...scaleContent(l0, w / l0.width) } as Partial<Layer>;
      node.setAttrs({ scaleX: 1, scaleY: 1, skewX: 0, skewY: 0, boxW: w, boxH: h });
      patches[node.id()] = p;
    }
    liveQueue.current = {};
    setLive({});
    useEditor.getState().patchLayers(patches);
    setGestureUI(null);
    tr.forceUpdate();
  };

  /** Resize handles snap to guides (single, unrotated layer). */
  const anchorBound = useCallback((_old: Vector2d, pos: Vector2d): Vector2d => {
    const g = gesture.current;
    const tr = trRef.current;
    if (!g || g.kind !== "resize" || g.multi || !tr || !snapRef.current || modsRef.current.ctrl) return pos;
    const l0 = g.startLayers[g.ids[0]];
    if (!l0 || Math.abs(normRot(l0.rotation || 0)) > 0.01) return pos;
    const v = viewRef.current;
    const anchor = tr.getActiveAnchor() ?? "";
    let x = (pos.x - v.x) / v.z, y = (pos.y - v.y) / v.z;
    const thr = 6 / v.z;
    const guides: Guide[] = [];
    if (anchor.includes("left") || anchor.includes("right")) {
      const sx = snapValue(x, "x", g.targets, thr);
      if (sx !== x) { x = sx; guides.push(...g.targets.xs.filter((tl) => Math.abs(tl.v - x) < 0.5).map((tl) => ({ axis: "x" as const, pos: x, from: Math.min(tl.from, l0.y), to: Math.max(tl.to, l0.y + l0.height) }))); }
    }
    if (anchor.includes("top") || anchor.includes("bottom")) {
      const sy = snapValue(y, "y", g.targets, thr);
      if (sy !== y) { y = sy; guides.push(...g.targets.ys.filter((tl) => Math.abs(tl.v - y) < 0.5).map((tl) => ({ axis: "y" as const, pos: y, from: Math.min(tl.from, l0.x), to: Math.max(tl.to, l0.x + l0.width) }))); }
    }
    g.guides = guides;
    return { x: v.x + x * v.z, y: v.y + y * v.z };
  }, []);

  // ── pointer: selection, marquee, hover ──
  const pointerDesign = (): Vector2d => {
    const p = stageRef.current?.getPointerPosition() ?? { x: 0, y: 0 };
    const v = viewRef.current;
    return { x: (p.x - v.x) / v.z, y: (p.y - v.y) / v.z };
  };

  const finishDown = useCallback(() => {
    const d = down.current;
    down.current = null;
    const st = useEditor.getState();
    if (marqueeStart.current) {
      marqueeStart.current = null;
      const m = marqueeRef.current;
      marqueeRef.current = null;
      setMarquee(null);
      if (m && m.width * viewRef.current.z > 3 && m.height * viewRef.current.z > 3) {
        const hits = st.doc.layers.filter((l) => {
          if (!l.visible || l.locked || l.type === "effect") return false;
          const b = boundsOf(l);
          // full-page layers (backgrounds, overlays) are picked by clicking them, not by sweeping across the page
          if (b.width >= st.width * 0.95 && b.height >= st.height * 0.95) return false;
          const inter = b.x < m.x + m.width && b.x + b.width > m.x && b.y < m.y + m.height && b.y + b.height > m.y;
          const covers = b.x <= m.x && b.y <= m.y && b.x + b.width >= m.x + m.width && b.y + b.height >= m.y + m.height;
          return inter && !covers;
        }).map((l) => l.id);
        st.select(hits, d?.additive ? "add" : "set");
      } else if (d && !d.dragged) {
        if (d.id && d.locked) st.select([d.id], d.additive ? "toggle" : "set");
        else if (!d.id && !d.additive) st.select([]);
      }
      return;
    }
    if (!d || d.dragged) return;
    if (d.toggleOnClick && d.id) st.select([d.id], "toggle");
    else if (d.narrowOnClick && d.id && st.selection.length > 1) st.select([d.id]);
  }, []);

  useEffect(() => {
    const up = () => { if (down.current || marqueeStart.current) finishDown(); };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [finishDown]);

  const onPointerDown = (e: KonvaEventObject<PointerEvent>) => {
    if (e.evt.button !== 0) return;
    setMenu(null);
    if (inTransformer(e.target)) return;
    const st = useEditor.getState();
    if (st.editingTextId) return;
    const grp = layerGroupOf(e.target);
    const at = stageRef.current?.getPointerPosition() ?? { x: 0, y: 0 };
    const additive = e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey;
    const id = grp?.id() ?? null;
    const l = id ? st.doc.layers.find((x) => x.id === id) : undefined;
    down.current = { at, id, locked: !!l?.locked, additive, toggleOnClick: false, narrowOnClick: false, dragged: false };
    if (!l || l.locked) {
      marqueeStart.current = pointerDesign();
      return;
    }
    if (!st.selection.includes(l.id)) st.select([l.id], additive ? "add" : "set");
    else if (additive) down.current.toggleOnClick = true;
    else down.current.narrowOnClick = true;
  };

  const onPointerMove = (e: KonvaEventObject<PointerEvent>) => {
    const stage = stageRef.current;
    if (!stage) return;
    if (marqueeStart.current && down.current) {
      const p = pointerDesign(), s = marqueeStart.current;
      const box = { x: Math.min(p.x, s.x), y: Math.min(p.y, s.y), width: Math.abs(p.x - s.x), height: Math.abs(p.y - s.y) };
      if (box.width * viewRef.current.z > 3 || box.height * viewRef.current.z > 3) down.current.dragged = true;
      marqueeRef.current = box;
      setMarquee(box);
      return;
    }
    if (gesture.current || e.evt.buttons) return;
    const grp = layerGroupOf(e.target);
    const id = grp?.id() ?? null;
    const st = useEditor.getState();
    if (st.hover !== id) st.setHover(id);
    if (!inTransformer(e.target)) {
      const l = id ? st.doc.layers.find((x) => x.id === id) : undefined;
      stage.container().style.cursor = l && !l.locked ? "move" : "";
    }
  };

  const onPointerLeave = () => {
    const st = useEditor.getState();
    if (st.hover && !gesture.current) st.setHover(null);
  };

  const startEditing = useCallback((id: string) => {
    const st = useEditor.getState();
    st.select([id]);
    st.setEditingText(id);
    setMenu(null);
  }, []);

  const onDblClick = (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    const grp = layerGroupOf(e.target);
    const l = grp ? useEditor.getState().doc.layers.find((x) => x.id === grp.id()) : undefined;
    if (!l || l.locked) return;
    if (l.type === "text") startEditing(l.id);
    else if (l.type === "image" && !l.src && !l.pending) { fileTarget.current = l.id; fileRef.current?.click(); }
  };

  const onContextMenu = (e: KonvaEventObject<PointerEvent>) => {
    e.evt.preventDefault();
    const st = useEditor.getState();
    if (st.editingTextId) return;
    const grp = layerGroupOf(e.target);
    let id = grp?.id() ?? null;
    if (!id && inTransformer(e.target) && st.selection.length) id = st.selection[st.selection.length - 1];
    if (id && !st.selection.includes(id)) st.select([id]);
    setMenu({ x: e.evt.clientX, y: e.evt.clientY, id });
  };

  // ── text editing ──
  const editing = editingTextId ? (byId.get(editingTextId) as TextLayer | undefined) : undefined;
  const commitText = useCallback((text: string) => {
    const st = useEditor.getState();
    const id = st.editingTextId;
    st.setEditingText(null);
    const l = st.doc.layers.find((x) => x.id === id);
    if (!l || l.type !== "text") return;
    if (!text.trim()) { st.removeLayers([l.id]); return; }
    if (text === l.text) return;
    const next = fixFontForText({ ...l, text });
    const patch: Partial<TextLayer> = { text, fontFamily: next.fontFamily };
    if (!next.autoFit) {
      const need = neededHeight(next, next.width, text);
      if (need > next.height + 0.5) {
        patch.height = need;
        if (!next.rotation) patch.y = r2(next.verticalAlign === "bottom" ? next.y - (need - next.height)
          : next.verticalAlign === "middle" ? next.y - (need - next.height) / 2 : next.y);
      }
    }
    st.patchLayer(l.id, patch);
  }, []);
  const cancelText = useCallback(() => useEditor.getState().setEditingText(null), []);
  useEffect(() => {
    if (editingTextId && !byId.get(editingTextId)) useEditor.getState().setEditingText(null);
  }, [editingTextId, byId]);

  // ── keyboard ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const st = useEditor.getState();
      if (st.editingTextId) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key;
      const sel = st.selection;
      const movable = st.doc.layers.filter((l) => sel.includes(l.id) && !l.locked);
      const handled = () => { e.preventDefault(); e.stopPropagation(); };
      const onControl = !!(e.target as HTMLElement | null)?.closest?.(
        'input, select, textarea, button, a, [role="slider"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [contenteditable="true"]');
      if (mod && !e.altKey) {
        const lower = k.toLowerCase();
        if (lower === "z" && !e.shiftKey) { handled(); st.undo(); return; }
        if ((lower === "z" && e.shiftKey) || lower === "y") { handled(); st.redo(); return; }
        if (lower === "d") { handled(); if (sel.length) st.duplicate(); return; }
        if (lower === "c") { if (sel.length) { handled(); copyLayers(); } return; }
        if (lower === "x") { if (sel.length) { handled(); copyLayers(); st.removeLayers(); } return; }
        if (lower === "a") { handled(); st.selectAll(); return; }
        if (e.code === "BracketRight") { handled(); if (sel.length) st.order(e.shiftKey ? "front" : "forward"); return; }
        if (e.code === "BracketLeft") { handled(); if (sel.length) st.order(e.shiftKey ? "back" : "backward"); return; }
        if (k === "0") { handled(); canvasCommand({ type: "fit" }); return; }
        if (k === "1") { handled(); canvasCommand({ type: "zoom", z: 1 }); return; }
        if (k === "=" || k === "+") { handled(); canvasCommand({ type: "zoomBy", factor: 1.25 }); return; }
        if (k === "-" || k === "_") { handled(); canvasCommand({ type: "zoomBy", factor: 0.8 }); return; }
        return;
      }
      if (onControl && (k.startsWith("Arrow") || k === "Enter" || k === " ")) return;
      if (k === "Delete" || k === "Backspace") { if (sel.length && !(onControl && (e.target as HTMLElement).tagName === "INPUT")) { handled(); st.removeLayers(); } return; }
      if (k === "Escape") { if (sel.length) { handled(); st.select([]); } return; }
      if (k === "Enter" && sel.length === 1) {
        const l = st.doc.layers.find((x) => x.id === sel[0]);
        if (l?.type === "text" && !l.locked) { handled(); startEditing(l.id); }
        return;
      }
      if (k.startsWith("Arrow") && movable.length && !e.altKey) {
        handled();
        const step = e.shiftKey ? 10 : 1;
        const dx = k === "ArrowLeft" ? -step : k === "ArrowRight" ? step : 0;
        const dy = k === "ArrowUp" ? -step : k === "ArrowDown" ? step : 0;
        const patches: Record<string, Partial<Layer>> = {};
        movable.forEach((l) => { patches[l.id] = { x: r2(l.x + dx), y: r2(l.y + dy) }; });
        st.patchLayers(patches, "nudge");
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target) || isTypingTarget(document.activeElement) || useEditor.getState().editingTextId) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (handlePaste(designId, e.clipboardData)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("paste", onPaste); };
  }, [designId, startEditing]);

  // ── drops ──
  const onDragOver = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types);
    if (!types.includes(DND_MIME) && !types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const slot = slotAt(vp.clientToDesign(e.clientX, e.clientY), e.altKey);
    setDropTarget(slot?.id ?? null);
  };
  const onDrop = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types);
    if (!types.includes(DND_MIME) && !types.includes("Files")) return;
    e.preventDefault();
    setDropTarget(null);
    const at = vp.clientToDesign(e.clientX, e.clientY);
    const raw = e.dataTransfer.getData(DND_MIME);
    if (raw) {
      try { placePayload(JSON.parse(raw) as DropPayload, at, e.altKey); } catch { toast.error(t("That item couldn't be added.")); }
      return;
    }
    const files = Array.from(e.dataTransfer.files);
    if (files.length) void uploadFiles(designId, files, { at, alt: e.altKey });
  };

  // ── exporter ──
  const renderPage = useCallback(async (opts: RenderOptions = {}): Promise<Blob> => {
    const st = useEditor.getState();
    const PW = st.width, PH = st.height;
    const txt = st.doc.layers.filter((l): l is TextLayer => l.type === "text");
    await loadFontsFor(txt.map((l) => ({ fontFamily: l.fontFamily, fontWeight: l.fontWeight, fontStyle: l.fontStyle, text: displayText(l) })));
    try { await document.fonts?.ready; } catch { /* ignore */ }
    await Promise.all(st.doc.layers.map((l) => (l.type === "image" && l.src ? loadImage(l.src) : null)));
    let ratio = opts.pixelRatio ?? 1;
    if (opts.maxSide) ratio = Math.min(ratio, opts.maxSide / Math.max(PW, PH));
    ratio = Math.max(0.01, Math.min(ratio, 16384 / Math.max(PW, PH), Math.sqrt(1.2e8 / (PW * PH))));
    // filtered / masked images re-render at the export resolution when it is finer than the screen's
    const prevScale = getCacheScale();
    const recache = ratio > prevScale * 1.01;
    if (recache) setCacheScale(ratio, true);
    await nextFrame();
    await nextFrame();
    const page = pageRef.current, layer = pageLayerRef.current;
    if (!page || !layer) { if (recache) setCacheScale(prevScale, true); throw new Error("The canvas isn't ready"); }
    const restore: (() => void)[] = [];
    const hide = (n: Konva.Node) => { if (n.visible()) { n.visible(false); restore.push(() => n.visible(true)); } };
    page.find(".ui-only").forEach(hide);
    page.find(".text-glyphs").forEach((n) => { if (!n.visible()) { n.visible(true); restore.push(() => n.visible(false)); } });
    if (opts.background === false) page.find(".page-bg").forEach(hide);
    const hideTypes = new Set(opts.hideTypes ?? []), hideIds = new Set(opts.hideIds ?? []);
    page.find(".layer").forEach((n) => { if (hideTypes.has(n.getAttr("layerType")) || hideIds.has(n.id())) hide(n); });
    const old = { x: page.x(), y: page.y(), scaleX: page.scaleX(), scaleY: page.scaleY() };
    let canvas: HTMLCanvasElement;
    try {
      page.setAttrs({ x: 0, y: 0, scaleX: 1, scaleY: 1 });
      canvas = page.toCanvas({ x: 0, y: 0, width: PW, height: PH, pixelRatio: ratio }) as HTMLCanvasElement;
    } finally {
      page.setAttrs(old);
      restore.forEach((f) => f());
      if (recache) setCacheScale(prevScale, true);
      layer.batchDraw();
    }
    const mime = opts.mime ?? "image/png";
    if (mime === "image/jpeg") {
      const flat = document.createElement("canvas");
      flat.width = canvas.width;
      flat.height = canvas.height;
      const c = flat.getContext("2d")!;
      c.fillStyle = "#ffffff";
      c.fillRect(0, 0, flat.width, flat.height);
      c.drawImage(canvas, 0, 0);
      canvas = flat;
    }
    return new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Rendering failed"))), mime, opts.quality ?? 0.92));
  }, []);

  useEffect(() => {
    registerExporter({
      render: (opts) => {
        const run = renderChain.then(() => renderPage(opts), () => renderPage(opts));
        renderChain = run.catch(() => undefined);
        return run;
      },
    });
    return () => registerExporter(null);
  }, [renderPage]);

  // ── context menu ──
  const menuItems = useMemo((): CtxItem[] => {
    if (!menu) return [];
    const st = useEditor.getState();
    const target = menu.id ? st.doc.layers.find((l) => l.id === menu.id) : undefined;
    if (!target) {
      return [
        { label: t("Paste"), icon: <ClipboardPaste className="size-4" />, shortcut: `${MOD}+V`, disabled: !st.clipboard.length, onClick: () => st.paste() },
        { label: t("Select all"), icon: <SquareDashed className="size-4" />, shortcut: `${MOD}+A`, onClick: () => st.selectAll() },
        { label: t("Fit to screen"), icon: <Maximize className="size-4" />, shortcut: `${MOD}+0`, separator: true, onClick: () => canvasCommand({ type: "fit" }) },
        { label: st.showGrid ? t("Hide grid") : t("Show grid"), icon: <Grid3x3 className="size-4" />, onClick: () => st.toggle("showGrid") },
        { label: st.showSafe ? t("Hide safe areas") : t("Show safe areas"), icon: <ScanLine className="size-4" />, onClick: () => st.toggle("showSafe") },
      ];
    }
    const ids = st.selection.includes(target.id) ? st.selection : [target.id];
    const idx = st.doc.layers.findIndex((l) => l.id === target.id);
    const top = idx === st.doc.layers.length - 1, bottom = idx === 0;
    const img = target.type === "image" ? (target as ImageLayer) : null;
    const items: CtxItem[] = [
      { label: t("Duplicate"), icon: <Copy className="size-4" />, shortcut: `${MOD}+D`, onClick: () => st.duplicate(ids) },
      { label: t("Delete"), icon: <Trash2 className="size-4" />, shortcut: "Del", danger: true, disabled: ids.every((i) => st.doc.layers.find((l) => l.id === i)?.locked),
        onClick: () => st.removeLayers(ids) },
      { label: t("Copy"), icon: <Copy className="size-4" />, shortcut: `${MOD}+C`, separator: true, onClick: () => copyLayers(ids) },
      { label: t("Paste"), icon: <ClipboardPaste className="size-4" />, shortcut: `${MOD}+V`, disabled: !st.clipboard.length, onClick: () => st.paste() },
      { label: t("Bring forward"), icon: <ChevronUp className="size-4" />, shortcut: `${MOD}+]`, separator: true, disabled: top, onClick: () => st.order("forward", ids) },
      { label: t("Send backward"), icon: <ChevronDown className="size-4" />, shortcut: `${MOD}+[`, disabled: bottom, onClick: () => st.order("backward", ids) },
      { label: t("Bring to front"), icon: <BringToFront className="size-4" />, shortcut: `${MOD}+⇧+]`, disabled: top, onClick: () => st.order("front", ids) },
      { label: t("Send to back"), icon: <SendToBack className="size-4" />, shortcut: `${MOD}+⇧+[`, disabled: bottom, onClick: () => st.order("back", ids) },
      { label: target.locked ? t("Unlock") : t("Lock"), icon: target.locked ? <LockOpen className="size-4" /> : <Lock className="size-4" />, separator: true,
        onClick: () => { const p: Record<string, Partial<Layer>> = {}; ids.forEach((i) => { p[i] = { locked: !target.locked }; }); st.patchLayers(p); } },
      { label: t("Hide"), icon: <EyeOff className="size-4" />,
        onClick: () => { const p: Record<string, Partial<Layer>> = {}; ids.forEach((i) => { p[i] = { visible: false }; }); st.patchLayers(p); st.select([]); } },
      { label: t("Centre on page"), icon: <Crosshair className="size-4" />, disabled: ids.every((i) => st.doc.layers.find((l) => l.id === i)?.locked),
        onClick: () => {
          const s2 = useEditor.getState();
          const ls = s2.doc.layers.filter((l) => ids.includes(l.id) && !l.locked);
          const u = unionBox(ls.map(boundsOf));
          if (!u) return;
          const dx = s2.width / 2 - (u.x + u.width / 2), dy = s2.height / 2 - (u.y + u.height / 2);
          const p: Record<string, Partial<Layer>> = {};
          ls.forEach((l) => { p[l.id] = { x: r2(l.x + dx), y: r2(l.y + dy) }; });
          s2.patchLayers(p);
        } },
    ];
    if (img && img.src) {
      items.push({ label: t("Use as background"), icon: <ImageDown className="size-4" />, separator: true,
        onClick: () => st.commit((d) => {
          const i = d.layers.findIndex((l) => l.id === img.id);
          if (i < 0) return d;
          const [l] = d.layers.splice(i, 1);
          const s2 = useEditor.getState();
          d.layers.unshift({ ...(l as ImageLayer), x: 0, y: 0, width: s2.width, height: s2.height, rotation: 0, fit: "cover", role: "background",
            mask: "none", flipX: false, flipY: false });
          return d;
        }) });
    }
    if (img?.ai) {
      const ai = img.ai;
      items.push({ label: t("Regenerate with AI"), icon: <Sparkles className="size-4" />, tone: "ai", separator: !img.src, disabled: !!img.pending,
        onClick: () => { void runAi(designId, { kind: ai.kind, prompt: ai.prompt, style: ai.style, character_id: ai.characterId ?? null, outfit: ai.outfit,
          pose: ai.pose, cutout: ["character", "element", "product"].includes(ai.kind), layerId: img.id }); } });
    }
    return items;
  }, [menu, designId, t]);

  const closeMenu = useCallback(() => setMenu(null), []);

  // ── render ──
  const z = view.z;
  const fmt = effectiveFormat(format, W, H).format;
  const hoverLayer = hover && !selection.includes(hover) && !gestureUI ? byId.get(hover) : undefined;
  const lockedSel = selected.filter((l) => l.locked && l.visible);
  const dropLayer = dropTarget ? byId.get(dropTarget) : undefined;
  const wrapCursor = vp.panning ? "grabbing" : vp.spaceHeld ? "grab" : undefined;
  useEffect(() => {
    const c = stageRef.current?.container();
    if (c && (vp.panning || vp.spaceHeld)) c.style.cursor = "";
  }, [vp.panning, vp.spaceHeld]);

  return (
    <div
      ref={vp.wrapRef}
      className={cn("pst-workspace relative min-h-0 min-w-0 flex-1 overflow-hidden outline-none", (vp.spaceHeld || vp.panning) && "is-hand")}
      style={{ cursor: wrapCursor }}
      data-design={designId}
      tabIndex={-1}
      aria-label={t("Design canvas")}
      onPointerDownCapture={vp.onPointerDownCapture}
      onPointerDown={(e) => { if (e.button !== 2 || document.activeElement !== e.currentTarget) (e.currentTarget as HTMLElement).focus({ preventScroll: true }); }}
      onMouseDownCapture={(e) => { if (e.button === 1) e.preventDefault(); }}
      onDragOver={onDragOver}
      onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropTarget(null); }}
      onDrop={onDrop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className={cn("pst-page-shadow", !doc.background.gradient && /^(transparent|#[0-9a-f]{6}00|#[0-9a-f]{3}0)$/i.test(doc.background.color) && "is-transparent")}
        style={{ left: view.x, top: view.y, width: W * z, height: H * z }}
      />
      {size.w > 0 && size.h > 0 && (
        <Stage
          ref={stageRef} width={size.w} height={size.h} className="pst-stage"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}
          onDblClick={onDblClick} onDblTap={onDblClick} onContextMenu={onContextMenu}
          onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd}
        >
          <KLayer ref={pageLayerRef}>
            <Group ref={pageRef} x={view.x} y={view.y} scaleX={z} scaleY={z} clipX={0} clipY={0} clipWidth={W} clipHeight={H}>
              <BackgroundView bg={doc.background} W={W} H={H} />
              {layers.map((l) => {
                const sel = selection.includes(l.id);
                const hit = l.visible && (l.type !== "effect" || sel);
                return (
                  <LayerView
                    key={l.id} layer={l} mode="edit" fontsVersion={l.type === "text" ? fontsVersion : 0}
                    zoom={l.type === "image" && (!l.src || l.pending) ? z : 1}
                    hit={hit} draggable={hit && !l.locked && l.id !== editingTextId} dragBound={dragBound}
                    textHidden={l.id === editingTextId} quiet={quiet.has(l.id)}
                  />
                );
              })}
            </Group>
          </KLayer>
          <KLayer>
            {showGrid && <GridOverlay view={view} W={W} H={H} colors={colors} />}
            {showSafe && fmt?.safe && <SafeArea view={view} W={W} H={H} safe={fmt.safe} colors={colors} label={tr("SAFE AREA")} />}
            {hoverLayer && hoverLayer.visible && <Outline view={view} layer={hoverLayer} color={colors.accent} width={1.5} />}
            {lockedSel.map((l) => <Outline key={l.id} view={view} layer={l} color={colors.warn} dashed />)}
            {editable.length > 1 && !gestureUI && editable.map((l) => <Outline key={`s-${l.id}`} view={view} layer={l} color={colors.accent} width={1} />)}
            {dropLayer && <DropTarget view={view} layer={dropLayer} colors={colors} />}
            <Transformer
              ref={trRef}
              visible={!editingTextId && editable.length > 0}
              flipEnabled={false} ignoreStroke padding={0} rotateEnabled
              keepRatio={trCfg.keepRatio} enabledAnchors={trCfg.anchors} shiftBehavior={trCfg.shiftBehavior}
              rotationSnaps={mods.shift ? SNAPS_15 : SNAPS_90} rotationSnapTolerance={mods.shift ? 7.5 : 3}
              anchorSize={9} anchorCornerRadius={2.5} anchorStroke={colors.accent} anchorFill={colors.handleFill} anchorStrokeWidth={1.25}
              borderStroke={colors.accent} borderStrokeWidth={1.5} rotateAnchorOffset={24} rotateAnchorCursor="grab"
              anchorStyleFunc={(a) => {
                const n = a.name();
                if (n.includes("rotater")) { a.cornerRadius(6); a.width(12); a.height(12); a.offsetX(6); a.offsetY(6); }
                else if (n.includes("middle-left") || n.includes("middle-right")) { a.width(6); a.height(16); a.offsetX(3); a.offsetY(8); a.cornerRadius(3); }
                else if (n.includes("top-center") || n.includes("bottom-center")) { a.width(16); a.height(6); a.offsetX(8); a.offsetY(3); a.cornerRadius(3); }
              }}
              boundBoxFunc={(o, n) => (Math.abs(n.width) < 4 || Math.abs(n.height) < 4 ? o : n)}
              anchorDragBoundFunc={anchorBound}
              onTransformStart={onTransformStart} onTransform={onTransform} onTransformEnd={onTransformEnd}
            />
            {gestureUI && <Guides view={view} guides={gestureUI.guides} gaps={gestureUI.gaps} colors={colors} />}
            {marquee && <Marquee view={view} box={marquee} colors={colors} />}
          </KLayer>
        </Stage>
      )}
      {editing && (
        <TextEditor key={editing.id} layer={editing} view={view} fontsVersion={fontsVersion} onCommit={commitText} onCancel={cancelText} />
      )}
      {layers.filter((l): l is ImageLayer => l.type === "image" && !!l.pending && l.visible).map((l) => {
        const pts = cornerPoints(view, l);
        const cx = (pts[0] + pts[4]) / 2, cy = (pts[1] + pts[5]) / 2;
        if (cx < -40 || cy < -20 || cx > size.w + 40 || cy > size.h + 20) return null;
        return (
          <div key={`p-${l.id}`} className="pst-pending" style={{ left: cx, top: cy }} role="status">
            <span className="eq" aria-hidden><i /><i /><i /><i /></span>
            <span>{t(PENDING_LABEL[l.pending!.kind] ?? "Generating")}…</span>
            {l.pending!.message && <span className="text-mute">{l.pending!.message}</span>}
          </div>
        );
      })}
      {gestureUI?.readout && (
        <div className="pst-readout mono" style={{ left: gestureUI.readout.x, top: gestureUI.readout.y }}>{gestureUI.readout.text}</div>
      )}
      {menu && <ContextMenu at={{ x: menu.x, y: menu.y }} items={menuItems} onClose={closeMenu} />}
      <input
        ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          const id = fileTarget.current;
          fileTarget.current = null;
          if (files.length) void uploadFiles(designId, files, { targetId: id ?? undefined });
        }}
      />
    </div>
  );
}

export { clampZoom, containsPoint };
