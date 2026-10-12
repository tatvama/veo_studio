/**
 * The editor's dialogs, opened from anywhere with `openDialog(...)` and rendered once by <Dialogs/>: transition
 * settings, marker, speed / duration, new sequence, a name prompt, export and the unsaved-changes guard.
 */
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { Button, Field, Input, Modal, Select, Textarea, Toggle } from "../components/ui";
import { desktop, type RenderPreset } from "../lib/desktop";
import * as A from "./actions";
import { listTransitions, onCatalog, type TransitionInfo } from "./engine";
import { MARKER_COLORS, PRESET_SIZES } from "./model/defaults";
import { AUDIO_TRANSITIONS, clipById, isAudioTransition, maxTransition, MAX_SPEED, MIN_SPEED, transitionRepeats } from "./model/ops";
import { FPS_LIST, fpsLabel, parseTimecode, shortDuration, toTimecode } from "./model/time";
import type { Easing, Transition } from "./model/types";
import { ctx, exec as execDoc, project, seq, seqExec, useProject as useProjectDoc, useSequence } from "./store";
import { ScrubNumber } from "./ui";
import { updateTransition, removeTransitions } from "./model/ops";
import { AUDIO_TRANSITION_DEFS } from "./audiofx/registry";
/** Every audio transition: the model's two, then the other acrossfade curves (editor-audio, docs/EDITOR.md §11.1). */
const ALL_AUDIO_TRANSITIONS: { id: string; label: string }[] = [...AUDIO_TRANSITIONS, ...AUDIO_TRANSITION_DEFS.filter((d) => !AUDIO_TRANSITIONS.some((x) => x.id === d.id))];

export type DialogSpec =
  | { kind: "transition"; id: string }
  | { kind: "marker"; id: string }
  | { kind: "speed"; ids: string[] }
  | { kind: "newSequence" }
  | { kind: "prompt"; title: string; label: string; value: string; ok: string; onOk: (v: string) => void }
  | { kind: "export" }
  | { kind: "settings" }
  | { kind: "unsaved"; name: string; onSave: () => Promise<boolean>; onDiscard: () => void };

const useDialog = create<{ d: DialogSpec | null }>(() => ({ d: null }));
export const openDialog = (d: DialogSpec) => useDialog.setState({ d });
export const closeDialog = () => useDialog.setState({ d: null });

export function Dialogs() {
  const d = useDialog((s) => s.d);
  if (!d) return null;
  switch (d.kind) {
    case "transition": return <TransitionDialog id={d.id} />;
    case "marker": return <MarkerDialog id={d.id} />;
    case "speed": return <SpeedDialog ids={d.ids} />;
    case "newSequence": return <NewSequenceDialog />;
    case "prompt": return <PromptDialog d={d} />;
    case "export": return <ExportDialog />;
    case "settings": return <SettingsDialog />;
    case "unsaved": return <UnsavedDialog d={d} />;
  }
}

// ── transition ───────────────────────────────────────────────────────────────

const EASINGS: { value: Easing; label: string }[] = [
  { value: "linear", label: "Linear" }, { value: "ease_in", label: "Ease in" }, { value: "ease_out", label: "Ease out" }, { value: "ease_in_out", label: "Ease in and out" },
];

let catalog: TransitionInfo[] = [];
const loadCatalog = () => void listTransitions().then((l) => { catalog = l; });
loadCatalog();
onCatalog(loadCatalog);
/** A transition's display name ("gl:cube" → "Cube"). */
export function transitionLabel(type: string): string {
  const a = ALL_AUDIO_TRANSITIONS.find((x) => x.id === type);
  if (a) return a.label;
  const t = catalog.find((x) => x.id === type);
  if (t) return t.label;
  const s = type.replace(/^gl:/, "").replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return type === "fade" ? "Cross dissolve" : s.charAt(0).toUpperCase() + s.slice(1);
}

function TransitionDialog({ id }: { id: string }) {
  const s = useSequence();
  const tr = s.transitions.find((t) => t.id === id);
  const [list, setList] = useState<TransitionInfo[]>(catalog);
  useEffect(() => { void listTransitions().then(setList); }, []);
  useEffect(() => { if (!tr) closeDialog(); }, [tr]);
  if (!tr) return null;
  const audio = isAudioTransition(tr.type);
  const from = tr.fromClipId ? clipById(s, tr.fromClipId) : undefined, to = tr.toClipId ? clipById(s, tr.toClipId) : undefined;
  const max = maxTransition(s, ctx(), tr.alignment, from, to);
  const info = list.find((x) => x.id === tr.type);
  const set = (patch: Partial<Transition>, label = "Transition settings") => seqExec(label, (sq, c) => updateTransition(sq, c, id, patch), `tr:${id}:${Object.keys(patch).join()}`);
  const groups = [...new Set(list.map((x) => x.group))];
  return (
    <Modal open onClose={closeDialog} title={`Transition · ${transitionLabel(tr.type)}`}
      footer={<>
        <Button variant="danger" onClick={() => { seqExec("Delete transition", (sq) => removeTransitions(sq, [id])); closeDialog(); }}>Delete</Button>
        <Button variant="primary" onClick={closeDialog}>Done</Button>
      </>}>
      <div className="grid gap-3.5">
        <Field label="Type">
          {audio ? (
            <Select value={tr.type} onChange={(e) => set({ type: e.target.value }, "Change transition")}>
              {ALL_AUDIO_TRANSITIONS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </Select>
          ) : (
            <Select value={tr.type} onChange={(e) => set({ type: e.target.value, params: undefined }, "Change transition")}>
              {!info && <option value={tr.type}>{transitionLabel(tr.type)}</option>}
              {groups.map((g) => <optgroup key={g} label={g}>{list.filter((x) => x.group === g).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</optgroup>)}
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Duration" hint={`Up to ${toTimecode(max, s.fps)}${transitionRepeats(s, ctx(), tr) ? " · uses repeated frames (no handles)" : ""}`}>
            <div className="flex items-center gap-2">
              <Input className="mono h-8" defaultValue={toTimecode(tr.duration, s.fps)} key={tr.duration}
                onKeyDown={(e) => { if (e.key === "Enter") { const f = parseTimecode((e.target as HTMLInputElement).value, s.fps); if (f) set({ duration: f }, "Transition duration"); } }}
                onBlur={(e) => { const f = parseTimecode(e.target.value, s.fps); if (f && f !== tr.duration) set({ duration: f }, "Transition duration"); }} />
              <ScrubNumber value={tr.duration} min={1} max={max} step={1} unit="f" onChange={(v) => set({ duration: Math.round(v) }, "Transition duration")} />
            </div>
          </Field>
          <Field label="Easing">
            <Select value={tr.easing === "hold" ? "linear" : tr.easing} onChange={(e) => set({ easing: e.target.value as Easing })}>
              {EASINGS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
            </Select>
          </Field>
        </div>
        {from && to && (
          <Field label="Alignment">
            <div className="ed-seg w-fit">
              {(["start", "center", "end"] as const).map((a) => (
                <button key={a} type="button" aria-pressed={tr.alignment === a} onClick={() => set({ alignment: a }, "Transition alignment")}>
                  {a === "start" ? "Start at cut" : a === "center" ? "Centre at cut" : "End at cut"}
                </button>
              ))}
            </div>
          </Field>
        )}
        {!from || !to ? <p className="text-2xs text-dim">At a clip's {to ? "start" : "end"} with nothing next to it: plays as a fade {to ? "from" : "to"} black.</p> : null}
        {info && info.params.length > 0 && (
          <div className="rounded-lg border border-line p-3">
            <p className="eyebrow mb-2">Parameters</p>
            <div className="grid gap-2">
              {info.params.map((pa) => {
                const v = (tr.params?.[pa.name] ?? pa.default) as unknown;
                const put = (nv: unknown) => set({ params: { ...(tr.params ?? {}), [pa.name]: nv } });
                return (
                  <div key={pa.name} className="flex items-center gap-3 text-xs">
                    <span className="w-36 truncate text-mute" title={pa.description}>{pa.name}</span>
                    {typeof v === "boolean" ? <input type="checkbox" checked={v} onChange={(e) => put(e.target.checked)} />
                      : Array.isArray(v) ? (
                        <div className="flex gap-2">
                          {(v as number[]).map((x, i) => <ScrubNumber key={i} value={x} step={pa.step ?? 0.01} min={pa.min} max={pa.max}
                            onChange={(nv) => put((v as number[]).map((y, j) => (j === i ? nv : y)))} />)}
                        </div>
                      ) : <ScrubNumber value={Number(v) || 0} step={pa.step ?? (pa.type === "int" ? 1 : 0.01)} min={pa.min} max={pa.max} onChange={(nv) => put(pa.type === "int" ? Math.round(nv) : nv)} />}
                  </div>
                );
              })}
              <button type="button" className="w-fit text-2xs text-accent-ink hover:underline" onClick={() => set({ params: undefined }, "Reset transition")}>Reset parameters</button>
            </div>
          </div>
        )}
        {info?.author && <p className="text-2xs text-dim">gl-transitions · {info.author} · {info.license ?? "MIT"}</p>}
      </div>
    </Modal>
  );
}

// ── marker ───────────────────────────────────────────────────────────────────

function MarkerDialog({ id }: { id: string }) {
  const s = useSequence();
  const m = s.markers.find((x) => x.id === id);
  useEffect(() => { if (!m) closeDialog(); }, [m]);
  if (!m) return null;
  const up = (patch: Parameters<typeof A.updateSeqMarker>[1], key: string) => A.updateSeqMarker(id, patch, `mk:${id}:${key}`);
  return (
    <Modal open onClose={closeDialog} title={`Marker · ${toTimecode(m.frame, s.fps)}`} size="sm"
      footer={<><Button variant="danger" onClick={() => { A.removeSeqMarker(id); closeDialog(); }}>Delete</Button><Button variant="primary" onClick={closeDialog}>Done</Button></>}>
      <div className="grid gap-3">
        <Field label="Name"><Input data-autofocus defaultValue={m.name} onChange={(e) => up({ name: e.target.value }, "name")} /></Field>
        <Field label="Comment"><Textarea defaultValue={m.comment ?? ""} onChange={(e) => up({ comment: e.target.value }, "comment")} /></Field>
        <div className="flex items-end gap-4">
          <Field label="Colour">
            <div className="flex gap-1.5">
              {MARKER_COLORS.map((c) => (
                <button key={c} type="button" aria-label={c} aria-pressed={m.color === c} onClick={() => up({ color: c }, "color")}
                  className="size-6 rounded-md ring-offset-2 ring-offset-panel aria-pressed:ring-2 aria-pressed:ring-ink" style={{ background: c }} />
              ))}
            </div>
          </Field>
          <Field label="Duration">
            <ScrubNumber value={m.duration} min={0} step={1} unit="f" onChange={(v) => up({ duration: Math.round(v) }, "dur")} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

// ── speed / duration ─────────────────────────────────────────────────────────

function SpeedDialog({ ids }: { ids: string[] }) {
  const s = useSequence();
  const cs = s.clips.filter((c) => ids.includes(c.id));
  const first = cs[0];
  const [pct, setPct] = useState(first ? Math.round(first.speed * 1000) / 10 : 100);
  const [rev, setRev] = useState(first?.reverse ?? false);
  const [ripple, setRipple] = useState(false);
  if (!first) { closeDialog(); return null; }
  const dur = Math.max(1, Math.round((first.duration * first.speed) / (pct / 100)));
  return (
    <Modal open onClose={closeDialog} title={`Speed / Duration${cs.length > 1 ? ` · ${cs.length} clips` : ""}`} size="sm"
      footer={<><Button variant="ghost" onClick={closeDialog}>Cancel</Button>
        <Button variant="primary" onClick={() => { A.setSpeed(ids, pct / 100, { reverse: rev, ripple }); closeDialog(); }}>Apply</Button></>}>
      <div className="grid gap-3.5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Speed" hint={`${MIN_SPEED * 100}–${MAX_SPEED * 100} %`}>
            <div className="flex items-center gap-1"><Input data-autofocus type="number" className="mono" value={pct} min={MIN_SPEED * 100} max={MAX_SPEED * 100} step={1}
              onChange={(e) => setPct(Math.max(MIN_SPEED * 100, Math.min(MAX_SPEED * 100, Number(e.target.value) || 100)))} /><span className="text-dim">%</span></div>
          </Field>
          <Field label="Duration">
            <Input className="mono" defaultValue={toTimecode(dur, s.fps)} key={dur}
              onBlur={(e) => { const f = parseTimecode(e.target.value, s.fps); if (f && f > 0) setPct(Math.round(((first.duration * first.speed) / f) * 1000) / 10); }} />
          </Field>
        </div>
        <Toggle checked={rev} onChange={setRev} label="Reverse speed" />
        <Toggle checked={ripple} onChange={setRipple} label="Ripple edit, shifting the clips after it" />
        <div className="flex flex-wrap gap-1.5">
          {[25, 50, 75, 100, 150, 200, 400].map((v) => <Button key={v} size="sm" variant={pct === v ? "primary" : "secondary"} onClick={() => setPct(v)}>{v}%</Button>)}
        </div>
      </div>
    </Modal>
  );
}

// ── new sequence / prompt ────────────────────────────────────────────────────

export function PresetPicker({ size, fps, onSize, onFps }: { size: string; fps: number; onSize: (s: string) => void; onFps: (f: number) => void }) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-2">
      <Select value={size} onChange={(e) => onSize(e.target.value)}>
        {PRESET_SIZES.map((p) => <option key={p.id} value={p.id}>{p.label} · {p.width}×{p.height}</option>)}
      </Select>
      <Select value={String(fps)} onChange={(e) => onFps(Number(e.target.value))} className="w-32">
        {FPS_LIST.map((f) => <option key={f} value={f}>{fpsLabel(f)}</option>)}
      </Select>
    </div>
  );
}

function NewSequenceDialog() {
  const cur = seq();
  const [name, setName] = useState(`Sequence ${String(project().sequences.length + 1).padStart(2, "0")}`);
  const [size, setSize] = useState<string>(PRESET_SIZES.find((p) => p.width === cur.width && p.height === cur.height)?.id ?? "1080p");
  const [fps, setFps] = useState(cur.fps);
  const p = PRESET_SIZES.find((x) => x.id === size)!;
  const ok = () => { A.newSequence(name.trim() || "Sequence", { width: p.width, height: p.height, fps }); closeDialog(); };
  return (
    <Modal open onClose={closeDialog} title="New sequence" size="sm"
      footer={<><Button variant="ghost" onClick={closeDialog}>Cancel</Button><Button variant="primary" onClick={ok}>Create</Button></>}>
      <div className="grid gap-3">
        <Field label="Name"><Input data-autofocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ok()} /></Field>
        <Field label="Format"><PresetPicker size={size} fps={fps} onSize={setSize} onFps={setFps} /></Field>
      </div>
    </Modal>
  );
}

function PromptDialog({ d }: { d: Extract<DialogSpec, { kind: "prompt" }> }) {
  const [v, setV] = useState(d.value);
  const ok = () => { if (!v.trim()) return; closeDialog(); d.onOk(v.trim()); };
  return (
    <Modal open onClose={closeDialog} title={d.title} size="sm"
      footer={<><Button variant="ghost" onClick={closeDialog}>Cancel</Button><Button variant="primary" onClick={ok} disabled={!v.trim()}>{d.ok}</Button></>}>
      <Field label={d.label}><Input data-autofocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ok()} /></Field>
    </Modal>
  );
}

// ── export ───────────────────────────────────────────────────────────────────

function ExportDialog() {
  const s = useSequence();
  const [presets, setPresets] = useState<RenderPreset[]>([]);
  const [preset, setPreset] = useState("");
  const [range, setRange] = useState<"all" | "inout">(s.inPoint !== undefined || s.outPoint !== undefined ? "inout" : "all");
  const [upload, setUpload] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const d = desktop();
    if (!d) return;
    d.render.presets().then((ps) => { setPresets(ps); setPreset((p) => p || ps.find((x) => x.h === s.height && x.w === s.width)?.id || ps[0]?.id || ""); }).catch(() => undefined);
  }, [s.width, s.height]);
  const len = useMemo(() => s.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0), [s.clips]);
  return (
    <Modal open onClose={closeDialog} title={`Export · ${s.name}`}
      footer={<><Button variant="ghost" onClick={closeDialog}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!desktop() || !preset || !len} onClick={async () => {
          setBusy(true);
          const { exportSequence } = await import("./session");
          const id = await exportSequence({ preset, range, upload });
          setBusy(false);
          if (id) closeDialog();
        }}>Export</Button></>}>
      {!desktop() ? <p className="text-sm text-mute">Exports render on this PC's graphics card in Tatvam Desktop.</p> : (
        <div className="grid gap-3.5">
          <Field label="Preset" hint="The picture is drawn by the GPU engine; FFmpeg mixes the sound from the audio tracks and encodes.">
            <Select value={preset} onChange={(e) => setPreset(e.target.value)}>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.label} · {p.w}×{p.h} · {p.fps} fps · {p.codec}{p.hardware ? " (GPU)" : ""}</option>)}
            </Select>
          </Field>
          <Field label="Range">
            <div className="ed-seg w-fit">
              <button type="button" aria-pressed={range === "all"} onClick={() => setRange("all")}>Whole sequence · {shortDuration(len, s.fps)}</button>
              <button type="button" aria-pressed={range === "inout"} disabled={s.inPoint === undefined && s.outPoint === undefined} onClick={() => setRange("inout")}>In to out</button>
            </div>
          </Field>
          <Toggle checked={upload} onChange={setUpload} label="Upload to the Render Center when done" />
        </div>
      )}
    </Modal>
  );
}

// ── project settings ─────────────────────────────────────────────────────────

function SettingsDialog() {
  const st = useProjectDoc();
  const set = (patch: Partial<typeof st.settings>, label: string) => execDoc(label, (p) => ({ ...p, settings: { ...p.settings, ...patch } }));
  return (
    <Modal open onClose={closeDialog} title="Project settings" size="sm" footer={<Button variant="primary" onClick={closeDialog}>Done</Button>}>
      <div className="grid gap-4">
        <Field label="Autosave" hint="Unsaved changes are written this often (0 turns autosave off). The desktop keeps the last 10 .bak copies.">
          <Select value={String(st.settings.autosaveSeconds)} onChange={(e) => set({ autosaveSeconds: Number(e.target.value) }, "Autosave")}>
            {[0, 5, 10, 30, 60, 120].map((v) => <option key={v} value={v}>{v ? `Every ${v} s` : "Off"}</option>)}
          </Select>
        </Field>
        <Field label="Proxies" hint="Smaller copies for smooth preview of heavy footage. Exports always use the originals.">
          <Select value={st.settings.proxy} onChange={(e) => set({ proxy: e.target.value as "off" | "auto" | "always" }, "Proxy mode")}>
            <option value="off">Off</option><option value="auto">When there is one</option><option value="always">Always (make them on import)</option>
          </Select>
        </Field>
        <Toggle checked={st.settings.copyMedia} onChange={(v) => set({ copyMedia: v }, "Copy media")} label="Copy imported files into the edit's Media folder" />
      </div>
    </Modal>
  );
}

// ── unsaved changes ──────────────────────────────────────────────────────────

function UnsavedDialog({ d }: { d: Extract<DialogSpec, { kind: "unsaved" }> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={closeDialog} title="Save changes?" size="sm"
      footer={<>
        <Button variant="ghost" onClick={closeDialog}>Cancel</Button>
        <Button variant="danger" onClick={() => { closeDialog(); d.onDiscard(); }}>Don't save</Button>
        <Button variant="primary" loading={busy} onClick={async () => { setBusy(true); const ok = await d.onSave(); setBusy(false); if (ok) { closeDialog(); d.onDiscard(); } }}>Save</Button>
      </>}>
      <p className="text-sm text-mute">“{d.name}” has changes that aren't saved yet.</p>
    </Modal>
  );
}
