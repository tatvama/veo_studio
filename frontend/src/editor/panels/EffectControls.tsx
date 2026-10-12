/**
 * Effect Controls (docs/EDITOR.md §3): the selected clip's Motion, Opacity and Time (or Volume, Panner and fades
 * for sound), then each effect with the parameters it declares. Every animatable parameter has a stopwatch,
 * previous / add-remove / next keyframe, reset, and a row in the mini keyframe timeline on the right (aligned to the
 * clip: click to seek, drag a keyframe to move it, right-click for its easing). Edits made while dragging a value
 * merge into one undo step.
 */
import { clsx } from "clsx";
import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, Diamond, RotateCcw, Timer, Trash2, Type } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as A from "../actions";
import { effectDef, effectDefaults, videoEffects, type EffectDef, type ParamDef } from "../effects";
import { kindOf, MAX_SPEED, MIN_SPEED, updateClips, updateEffect, updateParam, moveEffect, removeEffect } from "../model/ops";
import { addKeyframe, isAnimated, moveKeyframe, nextKeyframe, prevKeyframe, removeKeyframe, setKeyframeEase, setParam, toggleStopwatch, valueAt } from "../model/params";
import { toTimecode } from "../model/time";
import type { BlendMode, Easing, Param, Sequence, TimelineClip } from "../model/types";
import { program } from "../playback/transport";
import { gesture, seqExec, setFocus, useEditor, useSequence } from "../store";
import { IBtn, openMenu, ScrubNumber } from "../ui";

const BLENDS: BlendMode[] = ["normal", "add", "multiply", "screen", "overlay", "lighten", "darken"];
const EASES: { value: Easing; label: string }[] = [
  { value: "linear", label: "Linear" }, { value: "ease_in", label: "Ease in" }, { value: "ease_out", label: "Ease out" },
  { value: "ease_in_out", label: "Ease in and out" }, { value: "hold", label: "Hold" },
];

/** The program frame, at most ~12 times a second (values follow the playhead without re-rendering every frame). */
function useSlowFrame(): number {
  const last = useRef({ f: program.frame, at: 0 });
  return useSyncExternalStore((cb) => {
    let timer = 0;
    const off = program.subscribe(() => {
      const now = performance.now();
      if (now - last.current.at > 80) { last.current = { f: program.frame, at: now }; cb(); }
      else if (!timer) timer = window.setTimeout(() => { timer = 0; last.current = { f: program.frame, at: performance.now() }; cb(); }, 90);
    });
    return () => { off(); if (timer) window.clearTimeout(timer); };
  }, () => last.current.f);
}

export default function EffectControls() {
  const s = useSequence();
  const sel = useEditor((x) => x.selection);
  const c = s.clips.find((x) => x.id === sel[0]);
  const [defs, setDefs] = useState<EffectDef[]>([]);
  useEffect(() => { void videoEffects().then(setDefs); }, []);
  if (!c) {
    return <div className="pn" onPointerDown={() => setFocus("controls")}><div className="pn-empty">Select a clip on the timeline to see its motion, opacity, speed and effects here.</div></div>;
  }
  return <Controls key={c.id} c={c} s={s} defs={defs} />;
}

function Controls({ c, s, defs }: { c: TimelineClip; s: Sequence; defs: EffectDef[] }) {
  const frame = useSlowFrame();
  const local = Math.max(0, Math.min(c.duration - 1, frame - c.start));
  const audio = kindOf(s, c) === "audio";
  const grid = useRef<HTMLDivElement>(null);
  const [laneW, setLaneW] = useState(160);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const laneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = laneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLaneW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // the playhead line in the keyframe column (CSS variable, no render per frame)
  useEffect(() => {
    const place = () => {
      const x = ((program.frame - c.start) / Math.max(1, c.duration)) * laneW;
      grid.current?.style.setProperty("--ec-x", `${x}px`);
      grid.current?.style.setProperty("--ec-vis", program.frame >= c.start && program.frame < c.start + c.duration ? "1" : "0");
    };
    place();
    return program.subscribe(place);
  }, [c.start, c.duration, laneW]);

  const toggle = (k: string) => setClosed((o) => ({ ...o, [k]: !o[k] }));
  const sec = (key: string, title: React.ReactNode, actions?: React.ReactNode) => (
    <div className="col-span-2 flex h-7 items-center gap-1.5 border-b border-line bg-raised/60 px-1.5 text-2xs font-semibold text-mute">
      <button type="button" className="flex flex-1 items-center gap-1 text-left" onClick={() => toggle(key)}>
        {closed[key] ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}{title}
      </button>
      {actions}
    </div>
  );
  const row = (props: Omit<RowProps, "c" | "local" | "laneW">) => <PRow key={props.path} {...props} c={c} local={local} laneW={laneW} />;
  return (
    <div className="pn" onPointerDown={() => setFocus("controls")}>
      <div className="ed-bar">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={c.name}>{c.name}</span>
        {c.source.type === "title" && <IBtn title="Edit the text" onClick={() => window.dispatchEvent(new CustomEvent("ed:panel", { detail: "text" }))}><Type className="size-3.5" /></IBtn>}
        <span className="mono text-2xs text-dim">{toTimecode(c.start, s.fps)} – {toTimecode(c.start + c.duration, s.fps)}</span>
      </div>
      <div className="pn-scroll">
        <div ref={grid} className="ec-grid relative" style={{ ["--ec-x" as string]: "0px" }}>
          <div className="sticky top-0 z-10 flex h-6 items-center bg-panel px-2 text-2xs text-dim">{audio ? "Audio" : "Video"} clip</div>
          <div ref={laneRef} className="sticky top-0 z-10 flex h-6 items-center justify-between border-l border-line bg-panel px-1 text-[10px] text-dim">
            <span className="mono">{toTimecode(c.start, s.fps).slice(3)}</span><span className="mono">{toTimecode(c.start + c.duration, s.fps).slice(3)}</span>
          </div>
          {!audio && (
            <>
              {sec("motion", "Motion", <IBtn title="Reset motion" className="!size-5" onClick={() => A.resetMotion(c.id)}><RotateCcw className="size-3" /></IBtn>)}
              {!closed.motion && <>
                {row({ label: "Position", path: "motion.position", param: c.motion.position, def: [s.width / 2, s.height / 2], step: 1 })}
                {row({ label: "Scale", path: "motion.scale", param: c.motion.scale, def: 100, step: 0.5, min: 0, max: 2000, unit: "%" })}
                {row({ label: "Rotation", path: "motion.rotation", param: c.motion.rotation, def: 0, step: 0.5, unit: "°" })}
                {row({ label: "Anchor point", path: "motion.anchor", param: c.motion.anchor, def: c.motion.anchor.value, step: 1 })}
              </>}
              {sec("opacity", "Opacity")}
              {!closed.opacity && <>
                {row({ label: "Opacity", path: "motion.opacity", param: c.motion.opacity, def: 100, step: 0.5, min: 0, max: 100, unit: "%" })}
                <Plain label="Blend mode">
                  <select className="ed-field" value={c.motion.blend} onChange={(e) => seqExec("Blend mode", (sq, cx) => updateClips(sq, cx, [c.id], (x) => ({ ...x, motion: { ...x.motion, blend: e.target.value as BlendMode } })))}>
                    {BLENDS.map((b) => <option key={b} value={b}>{b[0].toUpperCase() + b.slice(1)}</option>)}
                  </select>
                </Plain>
              </>}
            </>
          )}
          {audio && c.audio && (
            <>
              {sec("volume", "Volume")}
              {!closed.volume && row({ label: "Level", path: "audio.gain", param: c.audio.gain, def: 0, step: 0.1, min: -96, max: 15, unit: "dB" })}
              {sec("pan", "Panner")}
              {!closed.pan && row({ label: "Pan", path: "audio.pan", param: c.audio.pan, def: 0, step: 0.01, min: -1, max: 1 })}
              {sec("fades", "Fades")}
              {!closed.fades && <>
                <Plain label="Fade in"><ScrubNumber value={c.audio.fadeIn} min={0} max={c.duration} step={1} unit="f" onChange={(v) => A.setAudioFade(c.id, "fadeIn", Math.round(v))} /></Plain>
                <Plain label="Fade out"><ScrubNumber value={c.audio.fadeOut} min={0} max={c.duration} step={1} unit="f" onChange={(v) => A.setAudioFade(c.id, "fadeOut", Math.round(v))} /></Plain>
              </>}
            </>
          )}
          {sec("time", "Time")}
          {!closed.time && <>
            <Plain label="Speed">
              <ScrubNumber value={c.speed * 100} min={MIN_SPEED * 100} max={MAX_SPEED * 100} step={1} unit="%" onChange={(v, done) => { if (done) A.setSpeed([c.id], v / 100, {}); }} />
              <label className="ml-2 flex items-center gap-1 text-2xs text-mute"><input type="checkbox" checked={c.reverse} onChange={(e) => A.setSpeed([c.id], c.speed, { reverse: e.target.checked })} />Reverse</label>
            </Plain>
            <Plain label="Duration"><span className="mono text-2xs text-mute">{toTimecode(c.duration, s.fps)}</span></Plain>
          </>}
          {c.effects.map((e, i) => {
            const d = defs.find((x) => x.id === e.type) ?? effectDef(e.type);
            const key = `fx:${e.id}`;
            return (
              <EffectBlock key={e.id}>
                {sec(key, <span className="flex items-center gap-1.5">
                  <input type="checkbox" checked={e.enabled} title={e.enabled ? "Turn off" : "Turn on"} onClick={(ev) => ev.stopPropagation()}
                    onChange={() => seqExec(e.enabled ? "Turn off effect" : "Turn on effect", (sq, cx) => updateEffect(sq, cx, c.id, e.id, (x) => ({ ...x, enabled: !x.enabled })))} />
                  <span className={clsx(!e.enabled && "line-through opacity-60")}>{d?.label ?? (e.type === "shotfx" ? "Studio shot effects" : e.type)}</span>
                </span>, <>
                  <IBtn title="Move up" className="!size-5" disabled={i === 0} onClick={() => seqExec("Reorder effects", (sq, cx) => moveEffect(sq, cx, c.id, e.id, -1))}><ArrowUp className="size-3" /></IBtn>
                  <IBtn title="Move down" className="!size-5" disabled={i === c.effects.length - 1} onClick={() => seqExec("Reorder effects", (sq, cx) => moveEffect(sq, cx, c.id, e.id, 1))}><ArrowDown className="size-3" /></IBtn>
                  {d && <IBtn title="Reset" className="!size-5" onClick={() => seqExec("Reset effect", (sq, cx) => updateEffect(sq, cx, c.id, e.id, (x) => ({ ...x, params: effectDefaults(e.type) })))}><RotateCcw className="size-3" /></IBtn>}
                  <IBtn title="Remove effect" className="!size-5" onClick={() => seqExec("Remove effect", (sq, cx) => removeEffect(sq, cx, c.id, e.id))}><Trash2 className="size-3" /></IBtn>
                </>)}
                {!closed[key] && (d?.params ?? Object.keys(e.params).map((k) => ({ name: k, label: k, type: "number", default: 0 } as ParamDef))).map((pd) => {
                  const prm = e.params[pd.name] ?? { value: pd.default };
                  const path = `fx.${e.id}.${pd.name}`;
                  if (pd.type === "number" || pd.type === "rgb") {
                    return row({ label: pd.label, path, param: prm as Param<number | number[]>, def: pd.default as number, step: pd.step ?? 0.01, min: pd.min, max: pd.max, unit: pd.unit, ensure: !e.params[pd.name] ? { effectId: e.id, name: pd.name, value: pd.default } : undefined });
                  }
                  return (
                    <Plain key={path} label={pd.label}>
                      <StaticParam pd={pd} value={prm.value} onChange={(v) => seqExec(`Set ${pd.label}`, (sq, cx) => updateEffect(sq, cx, c.id, e.id, (x) => ({ ...x, params: { ...x.params, [pd.name]: { value: v } } })), `ec:${c.id}:${path}`)} />
                    </Plain>
                  );
                })}
                {d?.note && <div className="col-span-2 px-3 py-1 text-2xs text-dim">{d.note}</div>}
                {e.type === "shotfx" && <div className="col-span-2 px-3 py-1.5 text-2xs text-dim">The studio shot's look, adjustments and camera move, as they were in the cut.</div>}
              </EffectBlock>
            );
          })}
          <div className="col-span-2 px-3 py-3 text-2xs text-dim">{c.effects.length ? "" : "No effects yet. "}Drag effects here from the Effects panel, or double-click one with this clip selected.</div>
        </div>
      </div>
      <div className="ed-bar bottom gap-2 text-2xs text-dim">
        <span className="mono text-accent-ink">{toTimecode(c.start + local, s.fps)}</span>
        <span>clip frame {local + 1} of {c.duration}</span>
      </div>
    </div>
  );
}

const EffectBlock = ({ children }: { children: React.ReactNode }) => <>{children}</>;

function Plain({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ec-row">
      <div className="p"><span className="w-[18px]" /><span className="w-24 shrink-0 truncate text-2xs text-mute">{label}</span><div className="flex min-w-0 items-center gap-1">{children}</div></div>
      <div className="k" />
    </div>
  );
}

function StaticParam({ pd, value, onChange }: { pd: ParamDef; value: unknown; onChange: (v: unknown) => void }) {
  if (pd.type === "select") return <select className="ed-field" value={String(value)} onChange={(e) => onChange(e.target.value)}>{pd.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
  if (pd.type === "bool") return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
  if (pd.type === "color") return <input type="color" className="h-5 w-10 cursor-pointer rounded border border-line bg-transparent" value={String(value).slice(0, 7)} onChange={(e) => onChange(e.target.value)} />;
  if (pd.type === "curve") return <CurveEditor points={(value as [number, number][]) ?? [[0, 0], [1, 1]]} onChange={onChange} />;
  if (pd.type === "text") return <input className="ed-field w-40" defaultValue={String(value ?? "")} onBlur={(e) => onChange(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />;
  return <span className="text-2xs text-dim">{JSON.stringify(value)}</span>;
}

interface RowProps {
  c: TimelineClip; local: number; laneW: number; label: string; path: string; param: Param<unknown>; def: unknown;
  step: number; min?: number; max?: number; unit?: string;
  /** An effect param missing from the instance (added with its default on first edit). */
  ensure?: { effectId: string; name: string; value: unknown };
}

/** One animatable parameter: stopwatch, value(s), keyframe navigation, reset | its keyframe lane. */
function PRow({ c, local, laneW, label, path, param, def, step, min, max, unit, ensure }: RowProps) {
  const animated = isAnimated(param);
  const v = valueAt(param, local);
  const kfHere = !!param.keyframes?.some((k) => k.frame === local);
  const edit = (fn: (p: Param<unknown>) => Param<unknown>, lbl: string, coalesce?: string) =>
    seqExec(lbl, (sq, cx) => {
      let s2 = sq;
      if (ensure) s2 = updateEffect(s2, cx, c.id, ensure.effectId, (x) => (x.params[ensure.name] ? x : { ...x, params: { ...x.params, [ensure.name]: { value: ensure.value } } }));
      return updateParam(s2, cx, c.id, path, fn);
    }, coalesce);
  const set = (nv: unknown) => edit((p) => setParam(p, nv, local), `Set ${label}`, `ec:${c.id}:${path}`);
  const clampN = (x: number) => Math.max(min ?? -Infinity, Math.min(max ?? Infinity, x));
  return (
    <div className="ec-row">
      <div className="p">
        <button type="button" title={animated ? "Stop animating (keeps the value here)" : "Animate: keyframes from here on"} onClick={() => edit((p) => toggleStopwatch(p, local), animated ? "Stop animating" : "Animate")}
          className={clsx("grid size-[18px] shrink-0 place-items-center rounded", animated ? "text-accent-ink" : "text-dim hover:text-ink")}>
          <Timer className="size-3.5" />
        </button>
        <span className="w-24 shrink-0 truncate text-2xs text-mute" title={label}>{label}</span>
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {Array.isArray(v) ? (v as number[]).map((x, i) => (
            <ScrubNumber key={i} value={x} step={step} min={min} max={max} animated={animated} onChange={(nv) => set((v as number[]).map((y, j) => (j === i ? clampN(nv) : y)))} />
          )) : <ScrubNumber value={Number(v)} step={step} min={min} max={max} unit={unit} animated={animated} onChange={(nv) => set(clampN(nv))} />}
        </div>
        {animated && (
          <div className="flex shrink-0 items-center">
            <button type="button" className="grid size-4 place-items-center text-dim hover:text-ink" title="Previous keyframe" onClick={() => { const f = prevKeyframe(param, local); if (f !== null) program.seek(c.start + f); }}><ChevronLeft className="size-3" /></button>
            <button type="button" className={clsx("grid size-4 place-items-center", kfHere ? "text-accent-ink" : "text-dim hover:text-ink")} title={kfHere ? "Remove keyframe" : "Add keyframe"}
              onClick={() => edit((p) => (kfHere ? removeKeyframe(p, local) : addKeyframe(p, local)), kfHere ? "Remove keyframe" : "Add keyframe")}>
              <Diamond className="size-2.5" fill={kfHere ? "currentColor" : "none"} />
            </button>
            <button type="button" className="grid size-4 place-items-center text-dim hover:text-ink" title="Next keyframe" onClick={() => { const f = nextKeyframe(param, local); if (f !== null) program.seek(c.start + f); }}><ChevronRight className="size-3" /></button>
          </div>
        )}
        <button type="button" className="grid size-4 shrink-0 place-items-center text-dim hover:text-ink" title="Reset" onClick={() => edit((p) => setParam(p, def, local), `Reset ${label}`)}><RotateCcw className="size-3" /></button>
      </div>
      <KfLane c={c} path={path} param={param} laneW={laneW} />
    </div>
  );
}

/** A parameter's keyframes over the clip's length: click to seek, drag to move, right-click for easing / delete. */
function KfLane({ c, path, param, laneW }: { c: TimelineClip; path: string; param: Param<unknown>; laneW: number }) {
  const ks = param.keyframes ?? [];
  const x = (f: number) => 6 + (f / Math.max(1, c.duration - 1)) * Math.max(1, laneW - 12);
  return (
    <div className="k" onPointerDown={(e) => {
      if ((e.target as HTMLElement).dataset.kf !== undefined || e.button !== 0) return;
      const r = e.currentTarget.getBoundingClientRect();
      program.seek(c.start + Math.round(((e.clientX - r.left) / r.width) * c.duration));
    }}>
      <div className="pointer-events-none absolute bottom-0 top-0 w-px bg-bad" style={{ left: "var(--ec-x)", opacity: "var(--ec-vis)" as unknown as number }} />
      {ks.map((k) => (
        <span key={k.frame} data-kf={k.frame} title={`${k.frame} · ${EASES.find((e) => e.value === k.ease)?.label ?? k.ease}`}
          className={clsx("ec-kf", (k.ease === "ease_in" || k.ease === "ease_out" || k.ease === "ease_in_out") && "ease", k.ease === "hold" && "hold")}
          style={{ left: x(k.frame) }}
          onDoubleClick={() => program.seek(c.start + k.frame)}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e, [
            ...EASES.map((ez) => ({ label: ez.label, checked: k.ease === ez.value, onClick: () => seqExec("Keyframe easing", (sq, cx) => updateParam(sq, cx, c.id, path, (p) => setKeyframeEase(p, k.frame, ez.value))) })),
            { label: "Go to keyframe", separator: true, onClick: () => program.seek(c.start + k.frame) },
            { label: "Delete keyframe", danger: true, onClick: () => seqExec("Delete keyframe", (sq, cx) => updateParam(sq, cx, c.id, path, (p) => removeKeyframe(p, k.frame))) },
          ]); }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            const x0 = e.clientX;
            let moved = false;
            const el = e.currentTarget;
            el.setPointerCapture(e.pointerId);
            const move = (ev: PointerEvent) => {
              if (!moved && Math.abs(ev.clientX - x0) < 3) return;
              if (!moved) { moved = true; gesture.begin("Move keyframe"); }
              const nf = Math.max(0, Math.min(c.duration - 1, k.frame + Math.round(((ev.clientX - x0) / Math.max(1, laneW)) * c.duration)));
              gesture.previewSeq((sq, cx) => updateParam(sq, cx, c.id, path, (p) => moveKeyframe(p, k.frame, nf)));
            };
            const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); if (moved) gesture.commit(); else program.seek(c.start + k.frame); };
            el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
          }} />
      ))}
    </div>
  );
}

/** A small curve editor (0..1 both ways): drag points, click to add, right-click to remove. */
function CurveEditor({ points, onChange }: { points: [number, number][]; onChange: (p: [number, number][]) => void }) {
  const S = 96;
  const ref = useRef<SVGSVGElement>(null);
  const pts = useMemo(() => [...points].sort((a, b) => a[0] - b[0]), [points]);
  const at = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height))] as [number, number];
  };
  const path = pts.map(([x, y], i) => `${i ? "L" : "M"}${x * S},${(1 - y) * S}`).join(" ");
  return (
    <svg ref={ref} width={S} height={S} className="my-1 rounded border border-line bg-black/30"
      onPointerDown={(e) => {
        if ((e.target as Element).tagName === "circle" || e.button !== 0) return;
        const p = at(e);
        if (pts.length < 16) onChange([...pts, p].sort((a, b) => a[0] - b[0]));
      }}>
      <path d={`M0,${S} L${S},0`} stroke="currentColor" className="text-line" fill="none" />
      <path d={path} stroke="currentColor" className="text-accent-ink" fill="none" strokeWidth={1.5} />
      {pts.map(([x, y], i) => (
        <circle key={i} cx={x * S} cy={(1 - y) * S} r={4} className="cursor-move fill-[var(--color-ink)]"
          onContextMenu={(e) => { e.preventDefault(); if (i > 0 && i < pts.length - 1) onChange(pts.filter((_, j) => j !== i)); }}
          onPointerDown={(e) => {
            e.stopPropagation();
            const el = e.currentTarget;
            el.setPointerCapture(e.pointerId);
            const move = (ev: PointerEvent) => {
              let [nx, ny] = at(ev);
              const lo = i > 0 ? pts[i - 1][0] + 0.01 : 0, hi = i < pts.length - 1 ? pts[i + 1][0] - 0.01 : 1;
              if (i === 0) nx = 0; else if (i === pts.length - 1) nx = 1; else nx = Math.max(lo, Math.min(hi, nx));
              onChange(pts.map((q, j) => (j === i ? [nx, ny] : q)) as [number, number][]);
            };
            const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
            el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
          }} />
      ))}
    </svg>
  );
}
