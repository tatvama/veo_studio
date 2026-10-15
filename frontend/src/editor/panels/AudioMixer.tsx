/**
 * Audio Mixer (docs/EDITOR.md §3, §11): a strip per audio track (insert slots, fader, pan, mute, solo, peak meter from
 * its AnalyserNode) and the master (its insert slots, the monitoring level, loudness M / S / I, true peak and phase
 * correlation). Faders and pans are the tracks' own values (undoable; a drag is one step); the master level is the
 * preview's monitoring level. The insert slots show a stack's first three effects; a click opens Audio Effects on it.
 * "Match loudness" sets the selected clips' levels to one LUFS target (measured, one undo step).
 */
import "../audiofx/audiofx.css";
import { clsx } from "clsx";
import { useEffect, useRef, useState } from "react";
import * as A from "../actions";
import { matchLoudness, selectedAudioClips } from "../audiofx/actions";
import { audioFxDef } from "../audiofx/registry";
import { audioStack, type FxTarget } from "../audiofx/stack";
import { tracksOf } from "../model/ops";
import type { EffectInstance, Track } from "../model/types";
import { useVisible } from "../moods/ui";
import { mixer } from "../playback/audio";
import { setFocus, useEditor, useSequence } from "../store";
import { ScrubNumber } from "../ui";
import { showAudioEffects } from "./AudioEffects";
import { LoudnessReadout } from "./LoudnessMeter";

const toDb = (lin: number) => (lin <= 1e-5 ? -Infinity : 20 * Math.log10(lin));
const DB_MIN = -60, DB_MAX = 6;
const meterFrac = (db: number) => Math.max(0, Math.min(1, (db - DB_MIN) / (DB_MAX - DB_MIN)));
const SLOTS = 3;
const MATCH_TARGETS = [-14, -16, -18, -20, -23, -24];

/** The first three effects of a stack, and an empty slot to add. */
function Inserts({ list, target }: { list: EffectInstance[]; target: FxTarget }) {
  const shown = list.slice(0, SLOTS);
  return (
    <div className="afx-slots" aria-label="Insert effects">
      {shown.map((e) => {
        const d = audioFxDef(e.type);
        return (
          <button key={e.id} type="button" className={clsx("afx-slot", !e.enabled && "off")} title={`${d?.label ?? e.type}${e.enabled ? "" : " (bypassed)"}: open in Audio Effects`}
            onClick={() => showAudioEffects(target)}>{d?.label ?? e.type}</button>
        );
      })}
      {list.length > SLOTS && <button type="button" className="afx-slot" onClick={() => showAudioEffects(target)}>+{list.length - SLOTS} more</button>}
      {list.length < SLOTS && <button type="button" className="afx-slot empty" title="Add an effect (Audio Effects)" onClick={() => showAudioEffects(target)}>+ insert</button>}
    </div>
  );
}

export default function AudioMixer() {
  const s = useSequence();
  const ats = tracksOf(s, "audio");
  const sel = useEditor((x) => x.selection);
  const root = useRef<HTMLDivElement>(null);
  const visible = useVisible(root);
  const meters = useRef<Record<string, HTMLCanvasElement | null>>({});
  const holds = useRef<Record<string, { db: number; at: number }>>({});
  const [master, setMaster] = useState(mixer.masterDb);
  const [target, setTarget] = useState(-16);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(!!mixer.ctx);
  const nSel = selectedAudioClips(s).filter((c) => c.source.type === "media").length;
  // the meters animate only while the panel is on screen and the audio context exists (it wakes on the first play);
  // before that they are painted empty once and the mixer is polled for its context
  useEffect(() => {
    if (!visible || live) return;
    const id = window.setInterval(() => { if (mixer.ctx) setLive(true); }, 500);
    return () => window.clearInterval(id);
  }, [visible, live]);
  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    const draw = () => {
      if (!mixer.ctx) { setLive(false); }
      const m = mixer.ctx ? mixer.meters() : { tracks: {}, master: 0 };
      const now = performance.now();
      const paint = (id: string, lin: number) => {
        const c = meters.current[id];
        if (!c) return;
        const g = c.getContext("2d");
        if (!g) return;
        const W = c.width, H = c.height;
        const db = toDb(lin);
        const h = holds.current[id];
        if (!h || db > h.db || now - h.at > 1200) holds.current[id] = { db, at: now };
        g.clearRect(0, 0, W, H);
        const f = meterFrac(db), y = H * (1 - f);
        const css = getComputedStyle(c);
        const ok = css.getPropertyValue("--color-ok").trim() || "green", warn = css.getPropertyValue("--color-warn").trim() || "orange", bad = css.getPropertyValue("--color-bad").trim() || "red";
        const grad = g.createLinearGradient(0, H, 0, 0);
        grad.addColorStop(0, ok); grad.addColorStop(0.75, ok); grad.addColorStop(0.88, warn); grad.addColorStop(1, bad);
        g.fillStyle = "rgba(255,255,255,0.06)"; g.fillRect(0, 0, W, H);
        g.fillStyle = grad; g.fillRect(0, y, W, H - y);
        const hy = H * (1 - meterFrac(holds.current[id].db));
        g.fillStyle = holds.current[id].db > -0.5 ? bad : "rgba(255,255,255,0.8)"; g.fillRect(0, Math.max(0, hy - 1), W, 2);
      };
      for (const t of ats) paint(t.id, m.tracks[t.id] ?? 0);
      paint("__master", m.master);
      if (mixer.ctx) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [ats.map((t) => t.id).join(), visible, live]);

  const match = async () => { setBusy(true); try { await matchLoudness(selectedAudioClips(), target); } finally { setBusy(false); } };

  return (
    <div ref={root} className="pn" onPointerDown={() => setFocus("mixer")}>
      <div className="flex min-h-0 flex-1 overflow-x-auto">
        {ats.map((t) => <Strip key={t.id} t={t} fx={audioStack(s, { kind: "track", trackId: t.id })} meterRef={(el) => { meters.current[t.id] = el; }} />)}
        <div className="mx-strip !w-[112px] border-l border-line bg-raised/40">
          <span className="text-2xs font-semibold text-mute">Master</span>
          <Inserts list={audioStack(s, { kind: "master" })} target={{ kind: "master" }} />
          <div className="flex min-h-0 flex-1 items-stretch gap-1.5">
            <input type="range" className="mx-fader" min={-40} max={6} step={0.1} value={master} aria-label="Master level"
              onChange={(e) => { const v = Number(e.target.value); setMaster(v); mixer.setMaster(v); }} onDoubleClick={() => { setMaster(0); mixer.setMaster(0); }} />
            <canvas ref={(el) => { meters.current.__master = el; }} width={10} height={160} className="h-full w-2.5 rounded-sm" />
          </div>
          <span className="mono text-2xs text-mute">{master > 0 ? "+" : ""}{master.toFixed(1)} dB</span>
          <span className="text-[10px] text-dim">monitoring</span>
          <LoudnessReadout compact />
        </div>
      </div>
      <div className="ed-bar bottom gap-2 text-2xs text-dim">
        <span className="min-w-0 truncate">Double-click a fader to reset it · the master sets only what you hear here</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <select className="ed-field !h-5 !text-2xs" value={target} onChange={(e) => setTarget(Number(e.target.value))} aria-label="Match loudness target">
            {MATCH_TARGETS.map((v) => <option key={v} value={v}>{v} LUFS</option>)}
          </select>
          <button type="button" className="ed-menubtn !h-5 !text-2xs" disabled={!nSel || busy} onClick={() => void match()}
            title={nSel ? `Set the ${nSel} selected clip${nSel > 1 ? "s" : ""} to ${target} LUFS` : "Select audio clips on the timeline"}>
            {busy ? "Measuring…" : `Match loudness${sel.length && nSel ? ` (${nSel})` : ""}`}
          </button>
        </span>
      </div>
    </div>
  );
}

function Strip({ t, fx, meterRef }: { t: Track; fx: EffectInstance[]; meterRef: (el: HTMLCanvasElement | null) => void }) {
  const set = (patch: Partial<Track>, label: string, key?: string) => A.updateTrack(t.id, patch, label, key);
  return (
    <div className="mx-strip !w-[84px]">
      <span className="w-full truncate text-center text-2xs font-semibold text-mute" title={t.name}>{t.name}</span>
      <Inserts list={fx} target={{ kind: "track", trackId: t.id }} />
      <div className="flex w-full items-center justify-center gap-1">
        <span className="text-[10px] text-dim">L</span>
        <input type="range" min={-1} max={1} step={0.01} value={t.pan} aria-label="Pan" className="w-12 accent-[var(--color-accent)]"
          onChange={(e) => set({ pan: Number(e.target.value) }, "Track pan", `pan:${t.id}`)} onDoubleClick={() => set({ pan: 0 }, "Track pan")} />
        <span className="text-[10px] text-dim">R</span>
      </div>
      <span className="mono text-[10px] text-dim">{t.pan === 0 ? "C" : `${t.pan < 0 ? "L" : "R"}${Math.round(Math.abs(t.pan) * 100)}`}</span>
      <div className="flex min-h-0 flex-1 items-stretch gap-1.5">
        <input type="range" className="mx-fader" min={-60} max={12} step={0.1} value={t.volume} aria-label={`${t.name} level`}
          onChange={(e) => set({ volume: Number(e.target.value) }, "Track level", `vol:${t.id}`)} onDoubleClick={() => set({ volume: 0 }, "Track level")} />
        <canvas ref={meterRef} width={10} height={160} className="h-full w-2.5 rounded-sm" />
      </div>
      <ScrubNumber value={t.volume} min={-60} max={12} step={0.1} unit="dB" onChange={(v) => set({ volume: Math.round(v * 10) / 10 }, "Track level", `vol:${t.id}`)} />
      <div className="flex gap-1">
        <button type="button" className={clsx("tl-tbtn mute text-[10px] font-bold", t.muted && "on")} title="Mute" onClick={() => set({ muted: !t.muted }, "Mute track")}>M</button>
        <button type="button" className={clsx("tl-tbtn solo text-[10px] font-bold", t.solo && "on")} title="Solo" onClick={() => set({ solo: !t.solo }, "Solo track")}>S</button>
      </div>
    </div>
  );
}
