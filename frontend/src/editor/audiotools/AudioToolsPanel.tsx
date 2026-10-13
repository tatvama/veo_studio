/**
 * The Audio Tools panel (docs/EDITOR.md §15.4): Auto mix (measure, a dry-run table of role, clip, before and after,
 * then apply), Room-tone fill, the Breath remover and the Audio visualiser (add one from an audio clip, or change the
 * selected one). Every change is one undo step.
 */
import "../audiofx/audiofx.css";
import { clsx } from "clsx";
import { useEffect, useMemo, useState } from "react";
import { openInSource } from "../actions";
import { clipById } from "../model/ops";
import { setFocus, useEditor, useSequence } from "../store";
import type { BreathRange } from "./breaths";
import type { RoomTone } from "./roomtone";
import { addVisualizer, applyBreaths, applyMix, clearRoomTone, detectBreathsFor, dialogueClip, fillRoomTone, findRoomToneFor, planMix, projectMedia, updateVisualizer, visualizerAudio } from "./actions";
import { LOUDNESS_TARGETS, ROLE_LABELS, ROLE_OFFSETS, type AutoMixPlan } from "./automix";
import { MUTE_DB } from "./edits";
import { useAudioTools, type AudioToolsTab } from "./menu";
import { VISUALIZER_PALETTES, VISUALIZER_STYLES, visualizerSettings, type VisualizerSource } from "./visualizer";

const TABS: { id: AudioToolsTab; label: string }[] = [
  { id: "mix", label: "Auto mix" }, { id: "roomtone", label: "Room tone" }, { id: "breaths", label: "Breaths" }, { id: "visualizer", label: "Visualiser" },
];
const db = (x: number | null | undefined, unit = "dB") => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(1)} ${unit}`);
const lufs = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x.toFixed(1)}`);
const tc = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;

export default function AudioToolsPanel() {
  const tab = useAudioTools((s) => s.tab);
  return (
    <div className="pn" onPointerDown={() => setFocus("other")}>
      <div className="es-role" role="tablist" aria-label="Audio tools">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={clsx(tab === t.id && "on")} onClick={() => useAudioTools.setState({ tab: t.id })}>{t.label}</button>
        ))}
      </div>
      <div className="pn-scroll pb-3">
        {tab === "mix" ? <AutoMix /> : tab === "roomtone" ? <RoomToneTool /> : tab === "breaths" ? <BreathTool /> : <VisualizerTool />}
      </div>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="px-2.5 py-1 text-2xs text-dim">{children}</p>;
}

// ── auto mix ───────────────────────────────────────────────────────────────────────────────────────────────

function AutoMix() {
  const s = useSequence();
  const [target, setTarget] = useState(-14);
  const [scope, setScope] = useState<"all" | "selected">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [plan, setPlan] = useState<AutoMixPlan | null>(null);
  const [stale, setStale] = useState(false);
  useEffect(() => { if (plan) setStale(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [s.clips]);
  // one entry per level: "YouTube / Instagram / Reels / Spotify (−14 LUFS)"
  const targets = useMemo(() => {
    const by = new Map<number, string[]>();
    for (const t of LOUDNESS_TARGETS) by.set(t.lufs, [...(by.get(t.lufs) ?? []), t.label.replace(/\s*\(.*\)$/, "")]);
    return [...by].map(([lufs, names]) => ({ id: String(lufs), lufs, label: `${names.join(" / ")} (${String(lufs).replace("-", "−")} LUFS)` }));
  }, []);
  const run = async () => {
    setBusy("Measuring…");
    try {
      const p = await planMix(target, scope === "selected", (d, n) => setBusy(`Measuring ${d} of ${n}…`));
      setPlan(p); setStale(false);
    } finally { setBusy(null); }
  };
  return (
    <>
      <div className="es-sec">Targets</div>
      <div className="es-row">
        <span className="text-2xs text-mute">Dialogue</span>
        <select className="ed-field" value={target} onChange={(e) => { setTarget(Number(e.target.value)); setPlan(null); }} aria-label="Dialogue loudness target">
          {targets.map((t) => <option key={t.id} value={t.lufs}>{t.label}</option>)}
        </select>
        <span />
      </div>
      <Hint>Music {ROLE_OFFSETS.music} LU, SFX {ROLE_OFFSETS.sfx} LU and ambience {ROLE_OFFSETS.ambience} LU under the dialogue. Clip gains stay within ±12 dB; music and ambience duck under the dialogue in the export.</Hint>
      <div className="es-row">
        <span className="text-2xs text-mute">Clips</span>
        <select className="ed-field" value={scope} onChange={(e) => { setScope(e.target.value as "all" | "selected"); setPlan(null); }} aria-label="Which clips">
          <option value="all">Every audio clip</option><option value="selected">Selected clips</option>
        </select>
        <span />
      </div>
      <div className="flex gap-1.5 px-2.5 py-1.5">
        <button type="button" className="ed-menubtn border border-line" disabled={!!busy} onClick={() => void run()}>{busy ?? (plan ? "Measure again" : "Measure (dry run)")}</button>
        {plan && <button type="button" className="ed-menubtn border border-accent/50 text-ink" disabled={!!busy || !plan.rows.length} onClick={() => { applyMix(plan); setPlan(null); }}>Apply</button>}
      </div>
      {plan && (
        <div className="px-2.5">
          {stale && <p className="mb-1 text-2xs text-amber-300">The edit changed since this was measured: measure again before applying.</p>}
          <table className="w-full text-2xs" data-testid="automix-table">
            <thead><tr className="text-left text-dim"><th className="py-0.5 font-medium">Role</th><th className="font-medium">Clip</th><th className="text-right font-medium">LUFS</th><th className="text-right font-medium">Gain before</th><th className="text-right font-medium">After</th><th className="text-right font-medium">Lands at</th></tr></thead>
            <tbody>
              {plan.rows.map((r) => (
                <tr key={r.clipId} className="border-t border-line/60" title={r.note}>
                  <td className="py-0.5">{ROLE_LABELS[r.role]}</td>
                  <td className="max-w-[9rem] truncate">{r.name}</td>
                  <td className="mono text-right">{lufs(r.measured)}</td>
                  <td className="mono text-right">{db(r.before)}</td>
                  <td className={clsx("mono text-right", r.capped && "text-amber-300")}>{db(r.after)}{r.capped ? " (cap)" : ""}</td>
                  <td className="mono text-right">{r.result === null ? (r.note ? "follows" : "—") : `${lufs(r.result)} / ${r.target}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!plan.rows.length && <p className="py-1 text-2xs text-dim">Nothing to set.</p>}
          {plan.skipped.length > 0 && (
            <details className="mt-1 text-2xs text-dim"><summary>{plan.skipped.length} clip{plan.skipped.length > 1 ? "s" : ""} left as they are</summary>
              {plan.skipped.map((x) => <p key={x.clipId} className="truncate">{x.name}: {x.reason}</p>)}
            </details>
          )}
          <p className="mt-1 text-2xs text-dim">{plan.ducking ? "Ducking: the music and ambience will duck under the dialogue in the export." : "No dialogue with music or ambience under it: nothing to duck."}</p>
        </div>
      )}
    </>
  );
}

// ── room tone ──────────────────────────────────────────────────────────────────────────────────────────────

function useDialogueClip() {
  useEditor((x) => x.selection);
  const s = useSequence();
  return dialogueClip(s);
}

function RoomToneTool() {
  const c = useDialogueClip();
  const s = useSequence();
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ clipId: string; stretch: RoomTone | null; thresholdDb: number; gaps: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const tone = s.clips.filter((x) => x.roomTone).length;
  if (!c) return <Hint>Select a dialogue clip (on its track, the gaps between the cuts get filled with its room tone).</Hint>;
  const track = s.tracks.find((t) => t.id === c.trackId);
  const run = async () => {
    setBusy(true); setErr(null);
    try { const r = await findRoomToneFor(c.id); if (r) setFound({ clipId: c.id, ...r }); else setErr("Couldn't read that clip's sound"); }
    catch (e) { setErr(String((e as Error)?.message ?? e)); } finally { setBusy(false); }
  };
  const f = found && found.clipId === c.id ? found : null;
  return (
    <>
      <div className="es-sec">Source</div>
      <Hint><span className="text-ink">{c.name}</span> on {track?.name ?? "its track"}: the quietest 1–3 s without speech that isn't digital silence.</Hint>
      <div className="flex flex-wrap gap-1.5 px-2.5 py-1.5">
        <button type="button" className="ed-menubtn border border-line" disabled={busy} onClick={() => void run()}>{busy ? "Listening…" : "Find room tone"}</button>
        {tone > 0 && <button type="button" className="ed-menubtn border border-line" onClick={() => clearRoomTone()}>Remove room tone ({tone})</button>}
      </div>
      {err && <p className="px-2.5 text-2xs text-red-300">{err}</p>}
      {f && (f.stretch ? (
        <div className="px-2.5 text-2xs" data-testid="roomtone-found">
          <p>Found <span className="mono text-ink">{tc(f.stretch.start)}–{tc(f.stretch.end)}</span> ({(f.stretch.end - f.stretch.start).toFixed(1)} s) at <span className="mono">{f.stretch.rmsDb.toFixed(1)} dBFS</span>.</p>
          {f.stretch.short && <p className="mt-0.5 text-amber-300">The recording has no pause of 1 s or more: this shorter stretch loops more often.</p>}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button type="button" className="ed-menubtn border border-accent/50 text-ink" disabled={!f.gaps} onClick={() => fillRoomTone(c.id, f.stretch!)}>Fill {f.gaps} gap{f.gaps === 1 ? "" : "s"} on {track?.name ?? "the track"}</button>
            <button type="button" className="ed-menubtn" onClick={() => {
              const src = c.source.type === "media" ? c.source : null;
              const m = src ? projectMedia(src.mediaId) : undefined;
              if (m) openInSource(m.id, Math.round(f.stretch!.start * (m.fps > 0 ? m.fps : s.fps)));
            }}>Show in Source</button>
          </div>
          {!f.gaps && <p className="mt-1 text-dim">That track has no gaps between its cuts.</p>}
        </div>
      ) : <Hint>No stretch of 1 s or more without speech was found in that recording (threshold {f.thresholdDb} dBFS).</Hint>)}
      <Hint>The room tone goes in as normal clips, looped with 30 ms crossfades at the dialogue clip's level.</Hint>
    </>
  );
}

// ── breaths ────────────────────────────────────────────────────────────────────────────────────────────────

function BreathTool() {
  const c = useDialogueClip();
  const [amount, setAmount] = useState<number | "mute">(-12);
  const [threshold, setThreshold] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ clipId: string; breaths: BreathRange[]; speech: { start: number; end: number }[]; noiseFloorDb: number } | null>(null);
  const [off, setOff] = useState<Set<number>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  if (!c) return <Hint>Select a dialogue clip to find its breaths.</Hint>;
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await detectBreathsFor(c.id, threshold);
      if (r) { setRes({ clipId: c.id, breaths: r.breaths, speech: r.speech, noiseFloorDb: r.noiseFloorDb }); setOff(new Set()); } else setErr("Couldn't read that clip's sound");
    } catch (e) { setErr(String((e as Error)?.message ?? e)); } finally { setBusy(false); }
  };
  const r = res && res.clipId === c.id ? res : null;
  const chosen = r ? r.breaths.filter((_, i) => !off.has(i)) : [];
  return (
    <>
      <div className="es-sec">Clip</div>
      <Hint><span className="text-ink">{c.name}</span>: breaths are 150–600 ms, quiet (−45 to −25 dBFS), noisy at 1–6 kHz, between words. They are lowered with level keyframes, never cut.</Hint>
      <div className="es-row">
        <span className="text-2xs text-mute">Lower by</span>
        <select className="ed-field" value={String(amount)} onChange={(e) => setAmount(e.target.value === "mute" ? "mute" : Number(e.target.value))} aria-label="Lower breaths by">
          {[-6, -9, -12, -15, -18, -24].map((v) => <option key={v} value={v}>{v} dB</option>)}
          <option value="mute">Mute ({MUTE_DB} dB)</option>
        </select>
        <span />
      </div>
      <div className="es-row">
        <span className="text-2xs text-mute">Sensitivity</span>
        <input type="range" min={0.3} max={0.8} step={0.05} value={1.1 - threshold} onChange={(e) => setThreshold(Math.round((1.1 - Number(e.target.value)) * 100) / 100)} aria-label="Sensitivity" />
        <span className="mono text-2xs">{Math.round((1.1 - threshold) * 100)}</span>
      </div>
      <div className="flex gap-1.5 px-2.5 py-1.5">
        <button type="button" className="ed-menubtn border border-line" disabled={busy} onClick={() => void run()}>{busy ? "Listening…" : r ? "Detect again" : "Detect breaths"}</button>
        {r && <button type="button" className="ed-menubtn border border-accent/50 text-ink" disabled={!chosen.length} onClick={() => { applyBreaths(c.id, chosen, amount, r.speech); setRes(null); }}>Apply to {chosen.length}</button>}
      </div>
      {err && <p className="px-2.5 text-2xs text-red-300">{err}</p>}
      {r && (
        <div className="px-2.5" data-testid="breath-list">
          {!r.breaths.length && <p className="text-2xs text-dim">No breaths found (room noise {r.noiseFloorDb.toFixed(1)} dBFS). Try a higher sensitivity.</p>}
          {r.breaths.map((b, i) => (
            <label key={`${b.start}`} className="flex items-center gap-2 py-0.5 text-2xs">
              <input type="checkbox" checked={!off.has(i)} onChange={(e) => setOff((o) => { const n = new Set(o); if (e.target.checked) n.delete(i); else n.add(i); return n; })} />
              <span className="mono w-16">{tc(b.start)}</span>
              <span className="mono w-12 text-dim">{Math.round((b.end - b.start) * 1000)} ms</span>
              <span className="mono w-16 text-dim">{b.rmsDb.toFixed(1)} dB</span>
              <span className="mono text-dim">{Math.round(b.confidence * 100)} %</span>
            </label>
          ))}
        </div>
      )}
    </>
  );
}

// ── visualiser ─────────────────────────────────────────────────────────────────────────────────────────────

const BOXES: { id: string; label: string; box: [number, number, number, number] }[] = [
  { id: "centre", label: "Centre", box: [0.1, 0.3, 0.8, 0.4] },
  { id: "lower", label: "Lower third", box: [0.08, 0.62, 0.84, 0.28] },
  { id: "strip", label: "Bottom strip", box: [0, 0.82, 1, 0.18] },
  { id: "full", label: "Full frame", box: [0, 0, 1, 1] },
  { id: "square", label: "Centre square", box: [0.28, 0.2, 0.44, 0.6] },
];

function VisualizerTool() {
  const s = useSequence();
  const sel = useEditor((x) => x.selection);
  const vc = sel.map((id) => clipById(s, id)).find((c) => c?.source.type === "visualizer");
  const [style, setStyle] = useState<VisualizerSource["style"]>("bars");
  const [busy, setBusy] = useState(false);
  if (!vc) {
    const a = visualizerAudio(undefined, s);
    return (
      <>
        <div className="es-sec">New visualiser</div>
        <Hint>Draws an audio clip's spectrum as a picture on a video track, in sync with it. You can also drag "Audio visualiser" from Effects → Generate onto a video track.</Hint>
        <div className="grid grid-cols-3 gap-1 px-2.5 py-1">
          {VISUALIZER_STYLES.map((x) => <button key={x.id} type="button" className={clsx("ed-menubtn border", style === x.id ? "border-accent text-ink" : "border-line")} onClick={() => setStyle(x.id)}>{x.label}</button>)}
        </div>
        <div className="px-2.5 py-1.5">
          <button type="button" className="ed-menubtn border border-accent/50 text-ink" disabled={!a || busy} onClick={async () => { setBusy(true); try { await addVisualizer({ audioClipId: a?.id, style }); } finally { setBusy(false); } }}>
            {busy ? "Analysing…" : a ? `Add for "${a.name}"` : "Select an audio clip first"}
          </button>
        </div>
      </>
    );
  }
  const src = vc.source as VisualizerSource;
  const v = visualizerSettings(src);
  const up = (patch: Partial<Omit<VisualizerSource, "type">>, key: string) => updateVisualizer(vc.id, patch, `viz:${vc.id}:${key}`);
  const audio = src.audioClipId ? clipById(s, src.audioClipId) : undefined;
  const slider = (label: string, key: keyof VisualizerSource, val: number, min: number, max: number, step: number, show: (x: number) => string, write = (x: number) => x) => (
    <div className="es-row" key={key}>
      <span className="text-2xs text-mute">{label}</span>
      <input type="range" min={min} max={max} step={step} value={val} onChange={(e) => up({ [key]: write(Number(e.target.value)) } as never, key)} aria-label={label} />
      <span className="mono text-2xs">{show(val)}</span>
    </div>
  );
  return (
    <>
      <div className="es-sec">Visualiser</div>
      <Hint>{audio ? <>Follows <span className="text-ink">{audio.name}</span>.</> : src.mediaId ? "Draws a media item's sound." : "Its audio clip is gone: pick another below."}</Hint>
      <div className="grid grid-cols-3 gap-1 px-2.5 py-1">
        {VISUALIZER_STYLES.map((x) => <button key={x.id} type="button" className={clsx("ed-menubtn border", v.style === x.id ? "border-accent text-ink" : "border-line")} onClick={() => up({ style: x.id }, "style")}>{x.label}</button>)}
      </div>
      <div className="es-sec">Colours</div>
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-1">
        {VISUALIZER_PALETTES.map((p) => (
          <button key={p.id} type="button" title={p.label} aria-label={p.label} className="h-5 w-9 rounded border border-line" style={{ background: `linear-gradient(90deg, ${p.colors.join(",")})` }} onClick={() => up({ colors: p.colors }, "palette")} />
        ))}
      </div>
      <div className="flex items-center gap-2 px-2.5 py-1">
        {[0, 1, 2].map((i) => (
          <input key={i} type="color" className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent" value={v.colors[i] ?? v.colors[v.colors.length - 1]} aria-label={`Colour ${i + 1}`}
            onChange={(e) => { const c = [...v.colors]; while (c.length <= i) c.push(c[c.length - 1]); c[i] = e.target.value; up({ colors: c }, `color${i}`); }} />
        ))}
        <label className="flex items-center gap-1.5 text-2xs text-mute"><input type="checkbox" checked={v.gradient} onChange={(e) => up({ gradient: e.target.checked }, "gradient")} />Gradient</label>
      </div>
      <div className="es-sec">Look</div>
      {slider("Glow", "glow", v.glow, 0, 1, 0.01, (x) => `${Math.round(x * 100)}`)}
      {slider("Smoothing", "smoothing", v.smoothing, 0, 0.95, 0.01, (x) => `${Math.round(x * 100)}`)}
      {slider("Sensitivity", "sensitivity", v.sensitivity, 0.25, 4, 0.05, (x) => `${x.toFixed(2)}×`)}
      {slider("Bars", "bars", v.bars, 8, 128, 1, (x) => String(x))}
      {slider("Thickness", "thickness", v.thickness, 0.1, 1, 0.01, (x) => `${Math.round(x * 100)}`)}
      <div className="es-sec">Frequencies</div>
      {slider("From", "freqMin", Math.log10(v.freqMin), Math.log10(20), Math.log10(2000), 0.01, (x) => `${Math.round(10 ** x)} Hz`, (x) => Math.round(10 ** x))}
      {slider("To", "freqMax", Math.log10(v.freqMax), Math.log10(1000), Math.log10(16000), 0.01, (x) => `${(10 ** x / 1000).toFixed(1)} kHz`, (x) => Math.round(10 ** x))}
      <div className="es-sec">Place</div>
      <div className="flex flex-wrap gap-1 px-2.5 py-1">
        {BOXES.map((b) => <button key={b.id} type="button" className={clsx("ed-menubtn border", v.box.join() === b.box.join() ? "border-accent text-ink" : "border-line")} onClick={() => up({ box: b.box }, "box")}>{b.label}</button>)}
      </div>
      <div className="es-row">
        <span className="text-2xs text-mute">Background</span>
        <label className="flex items-center gap-1.5 text-2xs text-mute"><input type="checkbox" checked={!!v.background} onChange={(e) => up({ background: e.target.checked ? "#0b1020" : undefined }, "bg")} />Fill</label>
        {v.background ? <input type="color" className="h-5 w-8 rounded border border-line bg-transparent" value={v.background} aria-label="Background colour" onChange={(e) => up({ background: e.target.value }, "bgc")} /> : <span />}
      </div>
    </>
  );
}
