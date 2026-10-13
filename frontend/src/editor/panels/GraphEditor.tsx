/**
 * The keyframe graph editor (editor-motion, docs/EDITOR.md §10): one property of the selected clip as a value graph
 * or a speed graph, with keyframes you select (click, Shift-click, box), move in time and value, and bezier handles you
 * drag (Alt breaks a smooth key). Ease presets (linear, ease in / out, easy ease, back, bounce, elastic, hold),
 * auto-bezier, copy / paste (Ctrl+C / Ctrl+V with the graph focused), delete. `GraphView` is the graph itself; Effect
 * Controls shows it inline under a property, the docked panel adds the property list and the toolbar.
 */
import { clsx } from "clsx";
import { Activity, Clipboard, ClipboardPaste, Copy, Gauge, LineChart, Maximize2, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { EASE_PRESETS, LINEAR_IN, LINEAR_OUT, type EasePresetId, type Vec2 } from "../model/bezier";
import { applyEasePreset, autoBezier, copyKeys, deleteKeys, moveKeys, pasteKeys, setHandle, speedAt } from "../model/keyframes";
import { updateParam } from "../model/ops";
import { addKeyframe, clipParams, getParam, valueAt } from "../model/params";
import { fpsExact, toTimecode } from "../model/time";
import type { Keyframe, Param, TimelineClip } from "../model/types";
import { program } from "../playback/transport";
import { gesture, seqExec, setFocus, useEditor, useSequence } from "../store";
import { IBtn, openMenu } from "../ui";
import "./GraphEditor.css";

export type GraphMode = "value" | "speed";

/** Copied keyframes (any property of the same shape can take them). */
let kfClip: { keys: Keyframe<unknown>[]; pair: boolean } | null = null;

const PARAM_LABEL: Record<string, string> = {
  "motion.position": "Position", "motion.scale": "Scale", "motion.rotation": "Rotation", "motion.anchor": "Anchor point", "motion.opacity": "Opacity",
  "audio.gain": "Volume", "audio.pan": "Pan", timeRemap: "Speed (time remapping)",
};
export const paramLabel = (c: TimelineClip, path: string) => {
  if (PARAM_LABEL[path]) return PARAM_LABEL[path];
  const [, id, name] = path.split(".");
  const e = c.effects.find((x) => x.id === id);
  return `${e?.type ?? "Effect"} · ${name}`;
};
const COMP_COLORS = ["#f87171", "#4ade80", "#60a5fa", "#fbbf24"];

const num = (v: unknown, i: number) => (Array.isArray(v) ? Number(v[i]) : Number(v));
const dims = (p: Param<unknown>) => (Array.isArray(p.value) ? (p.value as unknown[]).length : 1);
const isNumeric = (p: Param<unknown> | undefined) => !!p && (typeof p.value === "number" || (Array.isArray(p.value) && (p.value as unknown[]).every((x) => typeof x === "number")));

function useClipFrame(c: TimelineClip): number {
  const last = useRef(0);
  return useSyncExternalStore((cb) => program.subscribe(() => { const f = program.frame - c.start; if (f !== last.current) { last.current = f; cb(); } }), () => (last.current = program.frame - c.start), () => 0);
}

/** "Nice" grid steps for a value range. */
function ticks(lo: number, hi: number, n = 5): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n + 1) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

export interface GraphViewProps {
  clip: TimelineClip; path: string; fps: number; mode: GraphMode;
  sel: number[]; onSel: (frames: number[]) => void;
  height?: number; compact?: boolean;
}

/** The graph of one property: curves, keyframes, handles, the playhead; all edits are undoable steps. */
export function GraphView({ clip: c, path, fps, mode, sel, onSel, height = 220, compact }: GraphViewProps) {
  const p = getParam(c, path) ?? (path === "timeRemap" ? c.timeRemap : undefined);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(400);
  const local = useClipFrame(c);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const frozen = useRef<{ lo: number; hi: number } | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(120, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height;
  const padL = compact ? 34 : 44, padR = 10, padT = 10, padB = compact ? 14 : 18;
  const D = Math.max(1, c.duration);
  const n = p ? dims(p) : 1;
  const ks = (p?.keyframes ?? []) as Keyframe<unknown>[];
  const rate = fpsExact(fps);
  // what the graph shows: values (each component) or speed (per second)
  const sample = (f: number, k: number): number => {
    if (!p) return 0;
    if (mode === "speed") {
      if (n > 1) return speedAt(p, f) * rate;
      return speedAt(p, f) * rate;
    }
    return num(valueAt(p, f), k);
  };
  const N = Math.min(600, Math.max(60, Math.round(W / 2)));
  const curves = useMemo(() => {
    if (!p) return [] as number[][];
    const cs: number[][] = [];
    const comps = mode === "speed" ? 1 : n;
    for (let k = 0; k < comps; k++) { const ys: number[] = []; for (let i = 0; i <= N; i++) ys.push(sample((i / N) * D, k)); cs.push(ys); }
    return cs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, mode, D, N, n]);
  // the value range (kept still while dragging)
  const range = useMemo(() => {
    if (frozen.current) return frozen.current;
    let lo = Infinity, hi = -Infinity;
    for (const ys of curves) for (const y of ys) { if (Number.isFinite(y)) { lo = Math.min(lo, y); hi = Math.max(hi, y); } }
    if (mode === "value") for (const k of ks) for (let j = 0; j < n; j++) { const v = num(k.value, j); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (mode === "speed") { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const pad = (hi - lo) * 0.12 || Math.max(1, Math.abs(hi) * 0.2);
    return { lo: lo - pad, hi: hi + pad };
  }, [curves, ks, mode, n]);
  const X = (f: number) => padL + (f / D) * (W - padL - padR);
  const Y = (v: number) => padT + (1 - (v - range.lo) / (range.hi - range.lo || 1)) * (H - padT - padB);
  const F = (x: number) => ((x - padL) / (W - padL - padR)) * D;
  const V = (y: number) => range.lo + (1 - (y - padT) / (H - padT - padB)) * (range.hi - range.lo);

  const edit = (label: string, fn: (q: Param<unknown>) => Param<unknown>) => seqExec(label, (s, cx) => updateParam(s, cx, c.id, path, fn));
  const dragEdit = (fn: (q: Param<unknown>) => Param<unknown>) => gesture.previewSeq((s, cx) => updateParam(s, cx, c.id, path, fn));
  const selSet = new Set(sel);

  if (!p || !isNumeric(p)) return <div className="ge-empty" style={{ height }}>{p ? "This property can't be drawn as a graph." : "Nothing to show."}</div>;

  const rel = (e: { clientX: number; clientY: number }) => { const r = box.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const capture = (e: React.PointerEvent, move: (ev: PointerEvent) => void, up: (ev: PointerEvent) => void) => {
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* fine */ }
    const mv = (ev: PointerEvent) => move(ev);
    const fin = (ev: PointerEvent) => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", fin); el.removeEventListener("pointercancel", fin); frozen.current = null; up(ev); };
    el.addEventListener("pointermove", mv); el.addEventListener("pointerup", fin); el.addEventListener("pointercancel", fin);
  };

  // ── keyframe drag ──────────────────────────────────────────────────────────
  const onKeyDown = (e: React.PointerEvent, k: Keyframe<unknown>, comp: number) => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    box.current?.focus({ preventScroll: true });
    let frames = sel;
    if (e.shiftKey) { frames = selSet.has(k.frame) ? sel.filter((f) => f !== k.frame) : [...sel, k.frame]; onSel(frames); return; }
    if (!selSet.has(k.frame)) { frames = [k.frame]; onSel(frames); }
    const s0 = rel(e);
    frozen.current = range;
    let begun = false;
    capture(e, (ev) => {
      const s1 = rel(ev);
      if (!begun && Math.abs(s1.x - s0.x) < 3 && Math.abs(s1.y - s0.y) < 3) return;
      if (!begun) { gesture.begin("Move keyframes"); begun = true; }
      const df = Math.round(F(s1.x) - F(s0.x));
      const dvRaw = mode === "value" && !ev.shiftKey ? V(s1.y) - V(s0.y) : 0;
      const dv = n > 1 ? Array.from({ length: n }, (_, j) => (j === comp ? dvRaw : 0)) : dvRaw;
      const lockTime = ev.shiftKey;
      dragEdit((q) => moveKeys(q, frames, lockTime ? 0 : df, dv));
      onSel(frames.map((f) => f + (lockTime ? 0 : df)));
    }, () => { if (begun) gesture.commit(); else program.seek(c.start + k.frame); });
  };

  // ── handle drag ────────────────────────────────────────────────────────────
  const segOf = (i: number) => ({ a: ks[i], b: ks[i + 1] });
  const handlePos = (i: number, side: "out" | "in", comp: number): { x: number; y: number } | null => {
    const { a, b } = side === "out" ? segOf(i) : segOf(i - 1);
    if (!a || !b || a.ease !== "bezier") return null;
    const h = side === "out" ? a.out ?? LINEAR_OUT : b.in ?? LINEAR_IN;
    const dt = b.frame - a.frame, v0 = num(a.value, comp), dv = num(b.value, comp) - v0;
    const f = a.frame + h[0] * dt;
    if (mode === "value") return { x: X(f), y: Y(v0 + h[1] * dv) };
    // speed graph: the handle sits at the speed it sets at its key
    const slopeOut = h[0] > 1e-6 ? (h[1] / h[0]) : 0, slopeIn = 1 - h[0] > 1e-6 ? (1 - h[1]) / (1 - h[0]) : 0;
    const per = (dv / Math.max(1e-9, dt)) * rate;
    return { x: X(f), y: Y((side === "out" ? slopeOut : slopeIn) * per * (n > 1 ? Math.sign(dv) || 1 : 1)) };
  };
  const onHandleDown = (e: React.PointerEvent, i: number, side: "out" | "in", comp: number) => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    frozen.current = range;
    gesture.begin("Bezier handle");
    const key = ks[i];
    capture(e, (ev) => {
      const s1 = rel(ev);
      const { a, b } = side === "out" ? segOf(i) : segOf(i - 1);
      const dt = b.frame - a.frame, v0 = num(a.value, comp), dv = num(b.value, comp) - v0;
      let hx = (F(s1.x) - a.frame) / dt;
      hx = Math.max(0.01, Math.min(0.99, hx));
      let hy: number;
      if (mode === "value") hy = Math.abs(dv) > 1e-9 ? (V(s1.y) - v0) / dv : side === "out" ? 0 : 1;
      else {
        const per = (dv / Math.max(1e-9, dt)) * rate;
        const sp = V(s1.y);
        const slope = Math.abs(per) > 1e-9 ? sp / per : 0;
        hy = side === "out" ? slope * hx : 1 - slope * (1 - hx);
      }
      const h: Vec2 = [hx, hy];
      dragEdit((q) => setHandle(q, key.frame, side, h, { mirror: !ev.altKey }));
    }, () => gesture.commit());
  };

  // ── empty space: box select, double-click adds a key ───────────────────────
  const onBgDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    box.current?.focus({ preventScroll: true });
    setFocus("graph");
    const s0 = rel(e);
    const keep = e.shiftKey ? sel : [];
    let moved = false;
    capture(e, (ev) => {
      const s1 = rel(ev);
      if (!moved && Math.abs(s1.x - s0.x) < 3 && Math.abs(s1.y - s0.y) < 3) return;
      moved = true;
      setMarquee({ x0: s0.x, y0: s0.y, x1: s1.x, y1: s1.y });
      const xa = Math.min(s0.x, s1.x), xb = Math.max(s0.x, s1.x), ya = Math.min(s0.y, s1.y), yb = Math.max(s0.y, s1.y);
      const hit = ks.filter((k) => {
        const x = X(k.frame);
        if (x < xa || x > xb) return false;
        if (mode === "speed") return true;
        for (let j = 0; j < n; j++) { const y = Y(num(k.value, j)); if (y >= ya && y <= yb) return true; }
        return false;
      }).map((k) => k.frame);
      onSel([...new Set([...keep, ...hit])]);
    }, (ev) => {
      setMarquee(null);
      if (!moved) {
        if (!e.shiftKey) onSel([]);
        const f = Math.max(0, Math.min(D - 1, Math.round(F(rel(ev).x))));
        if (ev.detail >= 2 || e.detail >= 2) edit("Add keyframe", (q) => addKeyframe(q, f));
        else program.seek(c.start + f);
      }
    });
  };

  const keyMenu = (e: React.MouseEvent, k: Keyframe<unknown>) => {
    e.preventDefault(); e.stopPropagation();
    const frames = selSet.has(k.frame) ? sel : [k.frame];
    if (!selSet.has(k.frame)) onSel(frames);
    openMenu(e, [
      ...EASE_PRESETS.map((pr) => ({ label: pr.label, checked: frames.length === 1 && k.ease === pr.ease && (pr.ease !== "bezier" || JSON.stringify(k.out) === JSON.stringify(pr.out)), onClick: () => edit(`Ease: ${pr.label}`, (q) => applyEasePreset(q, frames, pr.id)) })),
      { label: "Auto bezier", separator: true, onClick: () => edit("Auto bezier", (q) => autoBezier(q, frames)) },
      { label: "Go to keyframe", onClick: () => program.seek(c.start + k.frame) },
      { label: frames.length > 1 ? `Delete ${frames.length} keyframes` : "Delete keyframe", danger: true, separator: true, onClick: () => { edit("Delete keyframes", (q) => deleteKeys(q, frames)); onSel([]); } },
    ]);
  };

  const onKeys = (e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if ((e.key === "Delete" || e.key === "Backspace") && sel.length) { e.preventDefault(); edit("Delete keyframes", (q) => deleteKeys(q, sel)); onSel([]); }
    else if (ctrl && e.key.toLowerCase() === "c" && sel.length) { e.preventDefault(); kfClip = { keys: copyKeys(p, sel), pair: n > 1 }; toast.message(`${sel.length} keyframe${sel.length === 1 ? "" : "s"} copied`); }
    else if (ctrl && e.key.toLowerCase() === "v") { e.preventDefault(); pasteHere(); }
    else if (ctrl && e.key.toLowerCase() === "a") { e.preventDefault(); onSel(ks.map((k) => k.frame)); }
  };
  const pasteHere = () => {
    if (!kfClip?.keys.length) { toast.message("Copy keyframes first (select them, Ctrl+C)"); return; }
    if (kfClip.pair !== (n > 1)) { toast.message("Those keyframes are for another kind of property"); return; }
    const at = Math.max(0, Math.min(D - 1, program.frame - c.start));
    const keys = kfClip.keys;
    edit("Paste keyframes", (q) => pasteKeys(q, keys, at));
    onSel(keys.map((k) => at + k.frame));
  };
  if (!compact) graphApi.current = { pasteHere, copy: () => { if (sel.length) { kfClip = { keys: copyKeys(p, sel), pair: n > 1 }; toast.message(`${sel.length} keyframe${sel.length === 1 ? "" : "s"} copied`); } } };

  const yTicks = ticks(range.lo, range.hi, compact ? 3 : 5);
  const unit = mode === "speed" ? "/s" : "";
  const path0 = (ys: number[]) => ys.map((y, i) => `${i ? "L" : "M"}${X((i / N) * D).toFixed(1)},${Y(y).toFixed(1)}`).join(" ");
  return (
    <div ref={box} tabIndex={0} className={clsx("ge-view", compact && "compact")} style={{ height }} onKeyDown={onKeys} onFocus={() => setFocus("graph")} data-graph={path}>
      <svg width={W} height={H} onPointerDown={onBgDown} onContextMenu={(e) => e.preventDefault()}>
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={Y(v)} y2={Y(v)} className="ge-grid" />
            <text x={padL - 4} y={Y(v) + 3} textAnchor="end" className="ge-label">{Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : Math.round(v * 100) / 100}{unit}</text>
          </g>
        ))}
        {mode === "speed" && <line x1={padL} x2={W - padR} y1={Y(0)} y2={Y(0)} className="ge-zero" />}
        {!compact && [0, 0.25, 0.5, 0.75, 1].map((t) => <text key={t} x={X(t * D)} y={H - 4} textAnchor="middle" className="ge-label">{toTimecode(Math.round(c.start + t * D), fps).slice(3)}</text>)}
        <line x1={X(local)} x2={X(local)} y1={padT} y2={H - padB} className="ge-head" style={{ opacity: local >= 0 && local <= D ? 1 : 0 }} />
        {curves.map((ys, k) => <path key={k} d={path0(ys)} fill="none" stroke={n > 1 && mode === "value" ? COMP_COLORS[k % 4] : "var(--color-accent-ink)"} strokeWidth={1.5} />)}
        {/* bezier handles of the selected keys' segments */}
        {ks.map((k, i) => (mode === "speed" ? [0] : Array.from({ length: n }, (_, j) => j)).map((j) => {
          const items: React.ReactNode[] = [];
          for (const side of ["out", "in"] as const) {
            if (!selSet.has(k.frame) && !(side === "in" && selSet.has(ks[i - 1]?.frame)) && !(side === "out" && selSet.has(ks[i + 1]?.frame))) continue;
            const hp = handlePos(i, side, j);
            if (!hp) continue;
            const kx = X(k.frame), ky = mode === "value" ? Y(num(k.value, j)) : hp.y;
            items.push(<g key={`${side}${j}`}>
              <line x1={kx} y1={ky} x2={hp.x} y2={hp.y} className="ge-hline" />
              <circle cx={hp.x} cy={hp.y} r={4} className="ge-handle" onPointerDown={(e) => onHandleDown(e, i, side, j)} />
            </g>);
          }
          return items;
        }))}
        {ks.map((k) => (mode === "speed" ? [0] : Array.from({ length: n }, (_, j) => j)).map((j) => {
          const x = X(k.frame), y = mode === "value" ? Y(num(k.value, j)) : Y(sample(Math.min(D, k.frame + 0.5), 0));
          const on = selSet.has(k.frame);
          const shape = k.ease === "bezier" || k.ease === "ease_in" || k.ease === "ease_out" || k.ease === "ease_in_out" ? "circle" : k.ease === "hold" ? "square" : "diamond";
          return (
            <g key={`${k.frame}:${j}`} className={clsx("ge-key", on && "on")} data-kf={k.frame} onPointerDown={(e) => onKeyDown(e, k, j)} onContextMenu={(e) => keyMenu(e, k)}>
              <title>{`${toTimecode(c.start + k.frame, fps)} · ${Array.isArray(k.value) ? (k.value as number[]).map((v) => Math.round(v * 100) / 100).join(", ") : Math.round(Number(k.value) * 100) / 100} · ${k.ease}`}</title>
              {shape === "circle" ? <circle cx={x} cy={y} r={4.5} /> : shape === "square" ? <rect x={x - 4} y={y - 4} width={8} height={8} /> : <rect x={x - 4} y={y - 4} width={8} height={8} transform={`rotate(45 ${x} ${y})`} />}
            </g>
          );
        }))}
        {marquee && <rect x={Math.min(marquee.x0, marquee.x1)} y={Math.min(marquee.y0, marquee.y1)} width={Math.abs(marquee.x1 - marquee.x0)} height={Math.abs(marquee.y1 - marquee.y0)} className="ge-marquee" />}
      </svg>
      {!ks.length && <div className="ge-hint">Turn on the stopwatch (or double-click here) to add keyframes</div>}
    </div>
  );
}

/** The docked panel's way to paste / copy into the graph on screen. */
const graphApi: { current: { pasteHere(): void; copy(): void } | null } = { current: null };

/** The toolbar's one-click presets (the rest are under "More"). */
const QUICK: EasePresetId[] = ["linear", "easy_ease", "ease_in", "ease_out", "back", "bounce", "elastic", "hold"];
const SHORT: Partial<Record<EasePresetId, string>> = { easy_ease: "Easy ease", back: "Back", ease_in: "Ease in", ease_out: "Ease out" };

/** The docked Graph Editor panel. */
export default function GraphEditor() {
  const s = useSequence();
  const selection = useEditor((x) => x.selection);
  const c = s.clips.find((x) => x.id === selection[0]);
  const [path, setPath] = useState<string | null>(null);
  const [mode, setMode] = useState<GraphMode>("value");
  const [sel, setSel] = useState<number[]>([]);
  const params = useMemo(() => (c ? clipParams(c).filter((x) => isNumeric(x.param)) : []), [c]);
  const cur = c && path && params.some((x) => x.path === path) ? path : params.find((x) => x.param.keyframes?.length)?.path ?? params[0]?.path ?? null;
  useEffect(() => { setSel([]); }, [c?.id, cur]);
  if (!c) return <div className="pn" onPointerDown={() => setFocus("graph")}><div className="pn-empty">Select a clip to see its keyframes as curves.</div></div>;
  const p = cur ? getParam(c, cur) : undefined;
  const preset = (id: EasePresetId, label: string) => cur && seqExec(`Ease: ${label}`, (sq, cx) => updateParam(sq, cx, c.id, cur, (q) => applyEasePreset(q, sel.length ? sel : undefined, id)));
  return (
    <div className="pn ge" onPointerDown={() => setFocus("graph")}>
      <div className="ed-bar gap-1 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
        <div className="ed-seg shrink-0">
          <button type="button" aria-pressed={mode === "value"} onClick={() => setMode("value")} title="Value graph"><LineChart className="mr-1 inline size-3" />Value</button>
          <button type="button" aria-pressed={mode === "speed"} onClick={() => setMode("speed")} title="Speed graph"><Gauge className="mr-1 inline size-3" />Speed</button>
        </div>
        <span className="mx-1 h-4 w-px shrink-0 bg-line" />
        {QUICK.map((id) => { const pr = EASE_PRESETS.find((x) => x.id === id)!; return (
          <button key={pr.id} type="button" className="ge-preset" title={`${pr.label} (on the selected keyframes, else all)`} onClick={() => preset(pr.id, pr.label)}>{SHORT[pr.id] ?? pr.label}</button>
        ); })}
        <button type="button" className="ge-preset" title="Every ease preset" onClick={(e) => openMenu(e.currentTarget.getBoundingClientRect(), EASE_PRESETS.map((pr) => ({ label: pr.label, onClick: () => preset(pr.id, pr.label) })))}>More ▾</button>
        <IBtn title="Auto bezier: smooth through every keyframe" onClick={() => cur && seqExec("Auto bezier", (sq, cx) => updateParam(sq, cx, c.id, cur, (q) => autoBezier(q, sel.length ? sel : undefined)))}><Sparkles className="size-3.5" /></IBtn>
        <IBtn title="Copy keyframes (Ctrl+C)" disabled={!sel.length} onClick={() => graphApi.current?.copy()}><Copy className="size-3.5" /></IBtn>
        <IBtn title="Paste keyframes at the playhead (Ctrl+V)" onClick={() => graphApi.current?.pasteHere()}><ClipboardPaste className="size-3.5" /></IBtn>
        <IBtn title="Delete keyframes (Del)" disabled={!sel.length} onClick={() => { if (cur) { seqExec("Delete keyframes", (sq, cx) => updateParam(sq, cx, c.id, cur, (q) => deleteKeys(q, sel))); setSel([]); } }}><Trash2 className="size-3.5" /></IBtn>
        <span className="ml-auto shrink-0 truncate pl-2 text-2xs text-dim" title={c.name}>{c.name} · {sel.length ? `${sel.length} selected` : `${p?.keyframes?.length ?? 0} keyframes`}</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="ge-list">
          {params.map((x) => (
            <button key={x.path} type="button" className={clsx("ge-item", x.path === cur && "on")} onClick={() => setPath(x.path)} title={x.path}>
              <Activity className={clsx("size-3 shrink-0", x.param.keyframes?.length ? "text-warn" : "text-dim")} />
              <span className="truncate">{paramLabel(c, x.path)}</span>
              {!!x.param.keyframes?.length && <span className="ml-auto mono text-[10px] text-dim">{x.param.keyframes.length}</span>}
            </button>
          ))}
          {!c.timeRemap && <div className="px-2 py-2 text-[10.5px] text-dim">Speed ramps: Clip → Speed ramp, or Effect Controls → Time remapping.</div>}
        </div>
        <div className="min-w-0 flex-1 p-1.5">
          {cur ? <FillGraph clip={c} path={cur} fps={s.fps} mode={mode} sel={sel} onSel={setSel} /> : <div className="pn-empty">No animatable properties.</div>}
        </div>
      </div>
      <div className="ed-bar bottom gap-2 text-2xs text-dim">
        <Clipboard className="size-3" />Click a keyframe to select it (Shift adds), drag a box to select several, drag to move (Shift: value only), drag a handle (Alt breaks a smooth key), double-click to add, right-click for eases.
        <Maximize2 className="ml-auto size-3" />
      </div>
    </div>
  );
}

/** GraphView filling its box. */
function FillGraph(props: Omit<GraphViewProps, "height">) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(220);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(Math.max(100, el.clientHeight)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <div ref={ref} className="h-full"><GraphView {...props} height={h} /></div>;
}
