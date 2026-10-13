/**
 * Audio Effects (docs/EDITOR.md §11): the effect stack of the selected audio clip, of an audio track or of the master.
 * Add from a searchable list by group (or a chain preset), drag to reorder, bypass, remove, per-effect presets, and a
 * keyframe stopwatch on every number (clip effects key clip frames, track and master effects sequence frames).
 * Each effect says how the preview plays it: live (WebAudio) or from the export's own render (Tatvam Desktop).
 */
import "../audiofx/audiofx.css";
import { clsx } from "clsx";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Diamond, GripVertical, Plus, RotateCcw, SlidersHorizontal, Timer, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SearchField } from "../../components/ui";
import { addFx, applyChainPreset, editStack, learnNoise } from "../audiofx/actions";
import { useAudioCache } from "../audiofx/cache";
import { audioFxDef, byGroup, CHAIN_PRESETS, searchAudioFx, type AudioFxDef, type AudioParamDef } from "../audiofx/registry";
import { audioStack, fx, targetFrame, type FxTarget } from "../audiofx/stack";
import { isAnimated, nextKeyframe, prevKeyframe, valueAt } from "../model/params";
import { kindOf, tracksOf } from "../model/ops";
import type { EffectInstance, Param, Sequence } from "../model/types";
import { mixer } from "../playback/audio";
import { program } from "../playback/transport";
import { setFocus, useEditor, useSequence } from "../store";
import { IBtn, openMenu, ScrubNumber } from "../ui";
import { AuditionNote, AudioWave, fxChain, presetChain, rowAudition } from "../preview/AudioWave"; // preview-polish: wave bars

/** The program frame, at most ~12 times a second. */
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

/** Opens this panel on a target (the mixer's insert slots). */
export function showAudioEffects(t: FxTarget) {
  window.dispatchEvent(new CustomEvent("ed:audiofx-target", { detail: t }));
  window.dispatchEvent(new CustomEvent("ed:panel", { detail: "audiofx" }));
}

export default function AudioEffects() {
  const s = useSequence();
  const sel = useEditor((x) => x.selection);
  const ats = tracksOf(s, "audio");
  const selClip = s.clips.find((c) => sel.includes(c.id) && (kindOf(s, c) === "audio" || !!c.audio));
  const [mode, setMode] = useState<"clip" | "track" | "master">("clip");
  const [trackId, setTrackId] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<FxTarget>).detail;
      setMode(t.kind);
      if (t.kind === "track") setTrackId(t.trackId);
    };
    window.addEventListener("ed:audiofx-target", on);
    return () => window.removeEventListener("ed:audiofx-target", on);
  }, []);
  const tid = trackId && ats.some((t) => t.id === trackId) ? trackId : selClip && ats.some((t) => t.id === selClip.trackId) ? selClip.trackId : ats[0]?.id;
  const target: FxTarget | null = mode === "clip" ? (selClip ? { kind: "clip", clipId: selClip.id } : null) : mode === "track" ? (tid ? { kind: "track", trackId: tid } : null) : { kind: "master" };
  return (
    <div className="pn" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar gap-2">
        <div className="afx-tabs" role="tablist">
          {(["clip", "track", "master"] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={clsx(mode === m && "on")} onClick={() => setMode(m)}>{m === "clip" ? "Clip" : m === "track" ? "Track" : "Master"}</button>
          ))}
        </div>
        {mode === "track" && (
          <select className="ed-field" value={tid ?? ""} onChange={(e) => setTrackId(e.target.value)} aria-label="Track">
            {ats.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        {mode === "clip" && <span className="min-w-0 flex-1 truncate text-xs font-medium" title={selClip?.name}>{selClip?.name ?? ""}</span>}
        {mode === "clip" && selClip && <PreviewBadge clipId={selClip.id} />}
      </div>
      {target ? <Stack key={JSON.stringify(target)} s={s} t={target} /> : (
        <div className="pn-empty">{mode === "clip" ? "Select an audio clip to see its effects, or switch to a track or the master." : "Add an audio track first."}</div>
      )}
    </div>
  );
}

/** How the selected clip is heard in the preview. */
function PreviewBadge({ clipId }: { clipId: string }) {
  useAudioCache();
  useSequence();
  const st = mixer.clipPreview(clipId);
  if (st === "none") return null;
  const [cls, text, tip] = st === "live" ? ["live", "Live", "Every effect plays live in the preview"]
    : st === "cache" ? ["render", "Export render", "Heard from the desktop's render of the export graph, so it matches the export"]
    : st === "rendering" ? ["render", "Rendering sound…", "The desktop is rendering this clip's effects with the export graph"]
    : st === "unavailable" ? ["warn", "Preview in Tatvam Desktop", "Some of these effects are heard only in Tatvam Desktop (it renders them with the export graph); here they are skipped"]
    : ["warn", "Render failed", "The desktop couldn't render this clip's effects; they are skipped in the preview"];
  return <span className={clsx("afx-tag", cls)} title={tip}>{text}</span>;
}

function Stack({ s, t }: { s: Sequence; t: FxTarget }) {
  const frame = useSlowFrame();
  const list = audioStack(s, t);
  const local = targetFrame(s, t, frame);
  const base = t.kind === "clip" ? s.clips.find((c) => c.id === t.clipId)?.start ?? 0 : 0;
  const [adding, setAdding] = useState(false);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  return (
    <>
      <div className="ed-bar">
        <button type="button" className="ed-menubtn flex items-center gap-1" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
          {adding ? <X className="size-3.5" /> : <Plus className="size-3.5" />}{adding ? "Close" : "Add effect"}
        </button>
        <span className="ml-auto text-2xs text-dim">{list.length ? `${list.length} effect${list.length > 1 ? "s" : ""}` : ""}</span>
      </div>
      {adding && <AddList onPick={(id) => { addFx(t, id); setAdding(false); }} onPreset={(id) => { applyChainPreset(t, id); setAdding(false); }} />}
      <div className={clsx("pn-scroll", adding && "afx-stack-adding")} onDragOver={(e) => { if (drag) e.preventDefault(); }}>
        {list.map((e, i) => {
          const d = audioFxDef(e.type);
          return (
            <div key={e.id} className={clsx("afx-card", !e.enabled && "off", drag && drag.over === i && drag.id !== e.id && "drop-above")}
              onDragOver={(ev) => { if (!drag) return; ev.preventDefault(); if (drag.over !== i) setDrag({ ...drag, over: i }); }}
              onDrop={(ev) => { ev.preventDefault(); if (drag) editStack(t, "Reorder audio effects", (l) => fx.moveTo(l, drag.id, drag.over)); setDrag(null); }}>
              <div className="afx-head">
                <span className="grip" draggable onDragStart={(ev) => { ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", e.id); setDrag({ id: e.id, over: i }); }} onDragEnd={() => setDrag(null)} title="Drag to reorder"><GripVertical className="size-3.5" /></span>
                <input type="checkbox" checked={e.enabled} title={e.enabled ? "Bypass" : "Turn on"} aria-label={`${d?.label ?? e.type} on`}
                  onChange={() => editStack(t, e.enabled ? "Bypass audio effect" : "Turn on audio effect", (l) => fx.toggle(l, e.id))} />
                <button type="button" className="afx-title flex min-w-0 flex-1 items-center gap-1 text-left" onClick={() => setClosed((c) => ({ ...c, [e.id]: !c[e.id] }))}>
                  {closed[e.id] ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}<span className="truncate">{d?.label ?? e.type}</span>
                </button>
                {d && <span className={clsx("afx-tag", d.preview === "realtime" ? "live" : "render")} title={d.preview === "realtime" ? "Plays live in the preview (WebAudio)" : "Previewed from the export's own render (Tatvam Desktop)"}>{d.preview === "realtime" ? "live" : "render"}</span>}
                {!!d?.presets?.length && (
                  <IBtn title="Presets" className="!size-5" onClick={(ev) => openMenu(ev.currentTarget.getBoundingClientRect(), d.presets!.map((p) => ({ label: p.name, onClick: () => editStack(t, `Preset: ${p.name}`, (l) => fx.preset(l, e.id, p.values)) })))}>
                    <SlidersHorizontal className="size-3" />
                  </IBtn>
                )}
                <IBtn title="Move up" className="!size-5" disabled={i === 0} onClick={() => editStack(t, "Reorder audio effects", (l) => fx.move(l, e.id, -1))}><ChevronUp className="size-3" /></IBtn>
                <IBtn title="Move down" className="!size-5" disabled={i === list.length - 1} onClick={() => editStack(t, "Reorder audio effects", (l) => fx.move(l, e.id, 1))}><ChevronDown className="size-3" /></IBtn>
                <IBtn title="Reset" className="!size-5" onClick={() => editStack(t, "Reset audio effect", (l) => fx.reset(l, e.id))}><RotateCcw className="size-3" /></IBtn>
                <IBtn title="Remove" className="!size-5" onClick={() => editStack(t, "Remove audio effect", (l) => fx.remove(l, e.id))}><Trash2 className="size-3" /></IBtn>
              </div>
              {!closed[e.id] && d && (
                <>
                  {d.params.map((pd) => <ParamRow key={pd.name} t={t} e={e} pd={pd} frame={local} base={base} />)}
                  {d.id === "noise_print" && (
                    <div className="flex items-center gap-2 px-3 py-1.5">
                      <button type="button" className="ed-menubtn" onClick={() => learnNoise(t, e.id)} disabled={t.kind !== "clip"}>Learn noise</button>
                      <span className="text-2xs text-dim">Mark in / out around noise only in the Source monitor first</span>
                    </div>
                  )}
                  {d.note && <div className="px-3 pb-1.5 text-2xs text-dim">{d.note}</div>}
                </>
              )}
            </div>
          );
        })}
        {!list.length && !adding && <div className="p-4 text-center text-2xs text-dim">No audio effects yet. Add one here, or drag one from the Effects panel onto a clip.</div>}
      </div>
      <div className="ed-bar bottom text-2xs text-dim">{t.kind === "clip" ? "Keyframes are on the clip's frames" : t.kind === "track" ? "On the track's mix, after its clips" : "On the whole mix, before the meters"}</div>
    </>
  );
}

function ParamRow({ t, e, pd, frame, base }: { t: FxTarget; e: EffectInstance; pd: AudioParamDef; frame: number; base: number }) {
  const prm: Param<unknown> = e.params[pd.name] ?? { value: pd.default };
  const v = valueAt(prm, frame);
  const animated = isAnimated(prm);
  const kfHere = !!prm.keyframes?.some((k) => k.frame === frame);
  const seek = (f: number | null) => { if (f !== null) program.seek(base + f); };
  const label = `Set ${pd.label}`;
  const key = `afx:${e.id}:${pd.name}`;
  return (
    <div className="afx-row">
      {pd.type === "number" ? (
        <button type="button" title={animated ? "Stop animating (keeps the value here)" : "Animate: keyframes from here on"} onClick={() => editStack(t, animated ? "Stop animating" : "Animate", (l) => fx.stopwatch(l, e.id, pd.name, frame))}
          className={clsx("grid size-[18px] place-items-center rounded", animated ? "text-accent-ink" : "text-dim hover:text-ink")}><Timer className="size-3.5" /></button>
      ) : <span />}
      <span className="truncate text-2xs text-mute" title={pd.label}>{pd.label}</span>
      <div className="flex min-w-0 items-center gap-1">
        {pd.type === "number" ? (
          <ScrubNumber value={Number(v)} min={pd.min} max={pd.max} step={pd.step ?? 0.01} unit={pd.unit} animated={animated}
            onChange={(nv) => editStack(t, label, (l) => fx.set(l, e.id, pd.name, Math.min(pd.max ?? Infinity, Math.max(pd.min ?? -Infinity, nv)), frame), key)} />
        ) : pd.type === "select" ? (
          <select className="ed-field max-w-full" value={String(v)} onChange={(ev) => editStack(t, label, (l) => fx.set(l, e.id, pd.name, ev.target.value, frame))}>
            {pd.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <input className="ed-field w-40" defaultValue={String(v ?? "")} onBlur={(ev) => editStack(t, label, (l) => fx.set(l, e.id, pd.name, ev.target.value, frame))}
            onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); }} />
        )}
      </div>
      <div className="flex items-center">
        {animated && (
          <>
            <button type="button" className="grid size-4 place-items-center text-dim hover:text-ink" title="Previous keyframe" onClick={() => seek(prevKeyframe(prm, frame))}><ChevronLeft className="size-3" /></button>
            <button type="button" className={clsx("grid size-4 place-items-center", kfHere ? "text-accent-ink" : "text-dim hover:text-ink")} title={kfHere ? "Remove keyframe" : "Add keyframe"}
              onClick={() => editStack(t, kfHere ? "Remove keyframe" : "Add keyframe", (l) => fx.keyframe(l, e.id, pd.name, frame, !kfHere))}><Diamond className="size-2.5" fill={kfHere ? "currentColor" : "none"} /></button>
            <button type="button" className="grid size-4 place-items-center text-dim hover:text-ink" title="Next keyframe" onClick={() => seek(nextKeyframe(prm, frame))}><ChevronRight className="size-3" /></button>
          </>
        )}
      </div>
    </div>
  );
}

/** The searchable add list: effects by group, then chain presets. */
function AddList({ onPick, onPreset }: { onPick: (id: string) => void; onPreset: (id: string) => void }) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => byGroup(searchAudioFx(q)), [q]);
  const presets = CHAIN_PRESETS.filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()) || p.group.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="afx-add">
      <div className="sticky top-0 z-10 bg-panel p-1.5"><SearchField value={q} onChange={setQ} placeholder="Search audio effects and presets" className="[&_input]:h-6 [&_input]:text-xs" />
        <AuditionNote className="mt-1 block px-0.5 text-2xs text-dim" fallback="Hover a row (or ▶) to hear it: on the selected audio clip's first 4 s, else a music loop or a voice-like sample" /></div>
      {!!presets.length && (
        <>
          <div className="grp">Presets</div>
          {presets.map((p) => (
            <div key={p.id} className="flex items-center pr-2 hover:bg-hover/70" data-afx-preset={p.id} onPointerEnter={() => rowAudition.enter(presetChain(p))} onPointerLeave={() => rowAudition.leave(presetChain(p))}>
              <button type="button" className="it min-w-0 hover:!bg-transparent" style={{ width: "auto", flex: 1 }} onClick={() => onPreset(p.id)} title={p.effects.map((e) => audioFxDef(e.id)?.label ?? e.id).join(" → ")}>
                <span className="min-w-0 flex-1 truncate">{p.name}</span><span className="text-2xs text-dim">{p.group}</span>
              </button>
              <AudioWave chain={presetChain(p)} note={false} />
            </div>
          ))}
        </>
      )}
      {groups.map((g) => (
        <div key={g.group}>
          <div className="grp">{g.group}</div>
          {g.defs.map((d: AudioFxDef) => (
            <div key={d.id} className="flex items-center pr-2 hover:bg-hover/70" data-afx-fx={d.id} onPointerEnter={() => rowAudition.enter(fxChain(d.id))} onPointerLeave={() => rowAudition.leave(fxChain(d.id))}>
              <button type="button" className="it min-w-0 hover:!bg-transparent" style={{ width: "auto", flex: 1 }} onClick={() => onPick(d.id)} title={d.note}>
                <span className="min-w-0 flex-1 truncate">{d.label}</span>
                <span className={clsx("afx-tag", d.preview === "realtime" ? "live" : "render")}>{d.preview === "realtime" ? "live" : "render"}</span>
              </button>
              <AudioWave chain={fxChain(d.id)} note={false} />
            </div>
          ))}
        </div>
      ))}
      {!groups.length && !presets.length && <div className="p-3 text-center text-2xs text-dim">Nothing matches</div>}
    </div>
  );
}
