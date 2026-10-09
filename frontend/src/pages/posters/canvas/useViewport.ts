/**
 * The canvas viewport: container size, pan (local) and zoom (in the store), fit-to-screen, Ctrl/⌘+wheel and pinch
 * zoom around the pointer, wheel scrolling, Space+drag and middle-drag panning.
 */
import Konva from "konva";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isTypingTarget } from "../../../components/shell/keys";
import { useEditor } from "../store";
import { setCacheScale } from "./cacheScale";
import { clampZoom, onCanvasCommand } from "./commands";
import type { View } from "./overlays";

const clamp = (v: number, a: number, b: number) => (a > b ? (a + b) / 2 : Math.max(a, Math.min(b, v)));

export function useViewport(W: number, H: number, designKey: number) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [pan, setPanState] = useState({ x: 0, y: 0 });
  const zoom = useEditor((s) => s.zoom);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);

  const sizeRef = useRef(size);
  sizeRef.current = size;
  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const lastZoom = useRef(zoom);
  const autoFit = useRef(true);
  const zoomAnchor = useRef<{ x: number; y: number } | null>(null);
  const spaceRef = useRef(false);
  const pageRef = useRef({ W, H });
  pageRef.current = { W, H };

  const setPan = useCallback((p: { x: number; y: number }) => {
    panRef.current = p;
    setPanState(p);
  }, []);

  /** Keep at least a strip of the page on screen. */
  const clampPan = useCallback((p: { x: number; y: number }, z: number) => {
    const { w, h } = sizeRef.current;
    const { W: pw, H: ph } = pageRef.current;
    const m = 64;
    return { x: clamp(p.x, m - pw * z, w - m), y: clamp(p.y, m - ph * z, h - m) };
  }, []);

  const computeFit = useCallback(() => {
    const { w, h } = sizeRef.current;
    const { W: pw, H: ph } = pageRef.current;
    if (!w || !h) return zoomRef.current;
    const pad = Math.max(20, Math.min(64, Math.min(w, h) * 0.07));
    return clampZoom(Math.min((w - pad * 2) / pw, (h - pad * 2) / ph));
  }, []);

  const fitNow = useCallback(() => {
    const { w, h } = sizeRef.current;
    if (!w || !h) return;
    const { W: pw, H: ph } = pageRef.current;
    const z = computeFit();
    const st = useEditor.getState();
    st.setFit(z);
    lastZoom.current = z;
    zoomRef.current = z;
    st.setZoom(z);
    setPan({ x: (w - pw * z) / 2, y: (h - ph * z) / 2 });
    autoFit.current = true;
  }, [computeFit, setPan]);

  /** Zoom to `z` keeping the screen point `at` (default: the viewport centre) still. */
  const zoomTo = useCallback((z: number, at?: { x: number; y: number }) => {
    const z1 = clampZoom(z);
    const z0 = zoomRef.current;
    const a = at ?? { x: sizeRef.current.w / 2, y: sizeRef.current.h / 2 };
    const p = panRef.current;
    lastZoom.current = z1;
    zoomRef.current = z1;
    setPan(clampPan({ x: a.x - ((a.x - p.x) * z1) / z0, y: a.y - ((a.y - p.y) * z1) / z0 }, z1));
    useEditor.getState().setZoom(z1);
    autoFit.current = false;
  }, [clampPan, setPan]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      setSize((s) => (s.w === Math.round(r.width) && s.h === Math.round(r.height) ? s : { w: Math.round(r.width), h: Math.round(r.height) }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // a new design or a new page size starts fitted; a resized viewport stays fitted while the user hasn't zoomed
  const lastPage = useRef("");
  useLayoutEffect(() => {
    if (!size.w || !size.h) return;
    const key = `${designKey}|${W}|${H}`;
    if (key !== lastPage.current) { lastPage.current = key; autoFit.current = true; }
    const f = computeFit();
    useEditor.getState().setFit(f);
    if (autoFit.current) fitNow();
    else setPan(clampPan(panRef.current, zoomRef.current));
  }, [size.w, size.h, W, H, designKey, computeFit, fitNow, clampPan, setPan]);

  // zoom set from elsewhere (slider, presets): keep the viewport centre still
  useLayoutEffect(() => {
    const prev = lastZoom.current;
    if (Math.abs(prev - zoom) < 1e-9) return;
    lastZoom.current = zoom;
    const a = zoomAnchor.current ?? { x: sizeRef.current.w / 2, y: sizeRef.current.h / 2 };
    zoomAnchor.current = null;
    const p = panRef.current;
    setPan(clampPan({ x: a.x - ((a.x - p.x) * zoom) / prev, y: a.y - ((a.y - p.y) * zoom) / prev }, zoom));
    autoFit.current = false;
  }, [zoom, clampPan, setPan]);

  // filtered images re-render at a resolution that matches the zoom, once zooming settles
  useEffect(() => {
    const id = window.setTimeout(() => setCacheScale(zoom * (window.devicePixelRatio || 1)), 220);
    return () => window.clearTimeout(id);
  }, [zoom]);

  useEffect(() => onCanvasCommand((c) => {
    if (c.type === "fit") fitNow();
    else if (c.type === "zoom") zoomTo(c.z);
    else zoomTo(zoomRef.current * c.factor);
  }), [fitNow, zoomTo]);

  // wheel: Ctrl/⌘ (and trackpad pinch) zooms around the pointer, otherwise scrolls the workspace
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.(".pst-text-editor")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      let dx = e.deltaX, dy = e.deltaY;
      if (e.deltaMode === 1) { dx *= 16; dy *= 16; } else if (e.deltaMode === 2) { dx *= r.width; dy *= r.height; }
      if (e.ctrlKey || e.metaKey) {
        const f = Math.exp(-Math.max(-120, Math.min(120, dy)) * 0.0024);
        zoomTo(zoomRef.current * f, { x: e.clientX - r.left, y: e.clientY - r.top });
      } else {
        if (e.shiftKey && !dx) { dx = dy; dy = 0; }
        const p = panRef.current;
        setPan(clampPan({ x: p.x - dx, y: p.y - dy }, zoomRef.current));
        autoFit.current = false;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomTo, clampPan, setPan]);

  // Safari trackpad pinch
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let base = 1;
    const start = (e: Event) => { e.preventDefault(); base = zoomRef.current; };
    const change = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const r = el.getBoundingClientRect();
      zoomTo(base * g.scale, { x: g.clientX - r.left, y: g.clientY - r.top });
    };
    el.addEventListener("gesturestart", start);
    el.addEventListener("gesturechange", change);
    return () => { el.removeEventListener("gesturestart", start); el.removeEventListener("gesturechange", change); };
  }, [zoomTo]);

  // Space held: the hand tool
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (spaceRef.current) { e.preventDefault(); return; }
      if (isTypingTarget(e.target) || useEditor.getState().editingTextId) return;
      if ((e.target as HTMLElement | null)?.closest?.("button, [role='menuitem'], a")) return;
      e.preventDefault();
      spaceRef.current = true;
      setSpaceHeld(true);
    };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") { spaceRef.current = false; setSpaceHeld(false); } };
    const blur = () => { spaceRef.current = false; setSpaceHeld(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  }, []);

  // two-finger pinch and pan on touch screens
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d0: number; z0: number; p: { x: number; y: number } } | null>(null);
  useEffect(() => {
    const local = (x: number, y: number) => {
      const r = wrapRef.current?.getBoundingClientRect();
      return { x: x - (r?.left ?? 0), y: y - (r?.top ?? 0) };
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !touches.current.has(e.pointerId)) return;
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pc = pinch.current;
      if (!pc || touches.current.size < 2) return;
      const [a, b] = [...touches.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = local((a.x + b.x) / 2, (a.y + b.y) / 2);
      const z = clampZoom((pc.z0 * d) / pc.d0);
      lastZoom.current = z;
      zoomRef.current = z;
      setPan(clampPan({ x: mid.x - pc.p.x * z, y: mid.y - pc.p.y * z }, z));
      useEditor.getState().setZoom(z);
      autoFit.current = false;
    };
    const up = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      touches.current.delete(e.pointerId);
      if (touches.current.size < 2) pinch.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [clampPan, setPan]);

  /** Pointer-down in the capture phase: middle button or Space+left starts a pan before Konva sees the event. */
  const onPointerDownCapture = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch") {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size === 2) {
        e.preventDefault();
        e.stopPropagation();
        // a second finger turns a layer drag into a pinch
        Konva.stages.forEach((s) => s.find(".layer").forEach((n) => { if (n.isDragging()) n.stopDrag(); }));
        const [a, b] = [...touches.current.values()];
        const r = wrapRef.current?.getBoundingClientRect();
        const mid = { x: (a.x + b.x) / 2 - (r?.left ?? 0), y: (a.y + b.y) / 2 - (r?.top ?? 0) };
        const z0 = zoomRef.current, p0 = panRef.current;
        pinch.current = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0, p: { x: (mid.x - p0.x) / z0, y: (mid.y - p0.y) / z0 } };
      }
      return;
    }
    if (!(e.button === 1 || (e.button === 0 && spaceRef.current))) return;
    if ((e.target as HTMLElement).closest(".pst-text-editor")) return;
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY, p0 = panRef.current;
    setPanning(true);
    autoFit.current = false;
    const move = (ev: PointerEvent) => setPan(clampPan({ x: p0.x + ev.clientX - sx, y: p0.y + ev.clientY - sy }, zoomRef.current));
    const up = () => {
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, [clampPan, setPan]);

  const view: View = { x: pan.x, y: pan.y, z: zoom };

  const clientToDesign = useCallback((cx: number, cy: number) => {
    const r = wrapRef.current?.getBoundingClientRect();
    const p = panRef.current, z = zoomRef.current;
    return { x: (cx - (r?.left ?? 0) - p.x) / z, y: (cy - (r?.top ?? 0) - p.y) / z };
  }, []);

  return { wrapRef, size, view, fitNow, zoomTo, spaceHeld, panning, onPointerDownCapture, clientToDesign, panRef, zoomRef };
}
