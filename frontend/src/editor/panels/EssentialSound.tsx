/**
 * Essential Sound (docs/EDITOR.md §11.1): tag the selected audio clips Dialogue, Music, SFX or Ambience and get
 * one-click controls for that role. Every control writes ordinary audio effect instances on the clip (or its level
 * keyframes), which Audio Effects and Effect Controls show like any other:
 *  - Dialogue: loudness to target; repair (noise, rumble, hum, de-ess, reverb); clarity (dynamics, EQ, enhance); reverb
 *  - Music: loudness; auto-duck under dialogue; remix to length (cut on its beats so it ends with the sequence)
 *  - SFX: loudness and reverb
 *  - Ambience: loudness, stereo width and duck
 */
import "../audiofx/audiofx.css";
import { clsx } from "clsx";
import { useState } from "react";
import { autoDuck, matchLoudness, remixToLength, selectedAudioClips, setRole, setRoleControl } from "../audiofx/actions";
import { CONTROLS, readControl, ROLE_CONTROLS, ROLE_LOUDNESS, type RoleControl } from "../audiofx/essential";
import { SOUND_ROLES, type SoundRole } from "../audiofx/registry";
import type { TimelineClip } from "../model/types";
import { setFocus, useEditor, useSequence } from "../store";
import { showAudioEffects } from "./AudioEffects";
import { openAudioTools } from "../audiotools/menu"; // audio-tools2 (additive)

export default function EssentialSound() {
  const s = useSequence();
  useEditor((x) => x.selection);
  const clips = selectedAudioClips(s);
  const roles = new Set(clips.map((c) => c.role ?? ""));
  const role = roles.size === 1 ? ([...roles][0] as SoundRole | "") : "";
  if (!clips.length) {
    return <div className="pn" onPointerDown={() => setFocus("other")}><div className="pn-empty">Select audio clips on the timeline, then tag them Dialogue, Music, SFX or Ambience for one-click controls.</div></div>;
  }
  const ids = clips.map((c) => c.id);
  return (
    <div className="pn" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{clips.length === 1 ? clips[0].name : `${clips.length} clips`}</span>
        {role && <button type="button" className="ed-menubtn !text-2xs" onClick={() => setRole(ids, undefined)}>Clear tag</button>}
      </div>
      <div className="es-role" role="radiogroup" aria-label="Sound type">
        {SOUND_ROLES.map((r) => (
          <button key={r.id} type="button" role="radio" aria-checked={role === r.id} className={clsx(role === r.id && "on")} onClick={() => setRole(ids, r.id)}>{r.label}</button>
        ))}
      </div>
      <div className="pn-scroll pb-3">
        {role ? <RolePanel role={role} clips={clips} /> : <p className="px-3 text-2xs text-dim">{roles.size > 1 ? "The selected clips have different tags: pick one for all of them." : "Pick what these clips are."}</p>}
      </div>
      <div className="ed-bar bottom text-2xs text-dim">
        <span className="min-w-0 flex-1 truncate">Each control writes a normal effect you can open in Audio Effects</span>
        {clips.length === 1 && <button type="button" className="ed-menubtn !h-5 !text-2xs" onClick={() => showAudioEffects({ kind: "clip", clipId: clips[0].id })}>Open effects</button>}
      </div>
    </div>
  );
}

function RolePanel({ role, clips }: { role: SoundRole; clips: TimelineClip[] }) {
  const ids = clips.map((c) => c.id);
  const [target, setTarget] = useState(ROLE_LOUDNESS[role]);
  const [busy, setBusy] = useState(false);
  const [duck, setDuck] = useState(12);
  const [fadeMs, setFadeMs] = useState(400);
  const groups = [...new Set(ROLE_CONTROLS[role].map((k) => CONTROLS[k].group))];
  const lead = clips[0];
  return (
    <>
      <div className="es-sec">Loudness</div>
      <div className="es-row">
        <span className="text-2xs text-mute">Target</span>
        <select className="ed-field" value={target} onChange={(e) => setTarget(Number(e.target.value))} aria-label="Loudness target">
          {[-14, -16, -18, -20, -23, -26, -30].map((v) => <option key={v} value={v}>{v} LUFS</option>)}
        </select>
        <span />
      </div>
      <div className="px-2.5 py-1">
        <button type="button" className="ed-menubtn" disabled={busy} onClick={async () => { setBusy(true); try { await matchLoudness(clips, target); } finally { setBusy(false); } }}>
          {busy ? "Measuring…" : "Auto-match loudness"}
        </button>
      </div>
      {/* audio-tools2 (additive): the Audio Tools panel for this role */}
      <div className="flex flex-wrap gap-1 px-2.5 pb-1">
        <button type="button" className="ed-menubtn !text-2xs" onClick={() => openAudioTools("mix")} title="Every clip to its role's loudness, music ducked under dialogue">Auto mix…</button>
        {role === "dialogue" && <button type="button" className="ed-menubtn !text-2xs" onClick={() => openAudioTools("roomtone")}>Room-tone fill…</button>}
        {role === "dialogue" && <button type="button" className="ed-menubtn !text-2xs" onClick={() => openAudioTools("breaths")}>Breath remover…</button>}
        {(role === "music" || role === "dialogue") && <button type="button" className="ed-menubtn !text-2xs" onClick={() => openAudioTools("visualizer")}>Visualiser…</button>}
      </div>
      {groups.map((g) => (
        <div key={g}>
          <div className="es-sec">{g}</div>
          {ROLE_CONTROLS[role].filter((k) => CONTROLS[k].group === g).map((k) => <Control key={k} c={CONTROLS[k]} ids={ids} value={readControl(lead.effects, k)} />)}
        </div>
      ))}
      {(role === "music" || role === "ambience") && (
        <>
          <div className="es-sec">Duck under dialogue</div>
          <div className="es-row"><span className="text-2xs text-mute">Duck by</span><input type="range" min={3} max={30} step={1} value={duck} onChange={(e) => setDuck(Number(e.target.value))} aria-label="Duck amount" /><span className="mono text-2xs">−{duck} dB</span></div>
          <div className="es-row"><span className="text-2xs text-mute">Fades</span><input type="range" min={50} max={1500} step={50} value={fadeMs} onChange={(e) => setFadeMs(Number(e.target.value))} aria-label="Duck fades" /><span className="mono text-2xs">{fadeMs} ms</span></div>
          <div className="px-2.5 py-1"><button type="button" className="ed-menubtn" onClick={() => autoDuck(ids, duck, fadeMs)} title="Writes level keyframes on these clips wherever dialogue plays">Generate duck keyframes</button></div>
        </>
      )}
      {role === "music" && (
        <>
          <div className="es-sec">Duration</div>
          <div className="px-2.5 py-1">
            <button type="button" className="ed-menubtn" disabled={clips.length !== 1 || lead.source.type !== "media"} onClick={() => void remixToLength(lead.id)}
              title="Cuts the music on its beats so it ends with the sequence (beat analysis in Tatvam Desktop)">Remix to the sequence's length</button>
          </div>
        </>
      )}
    </>
  );
}

function Control({ c, ids, value }: { c: RoleControl; ids: string[]; value: number | string }) {
  const key = `es:${c.id}:${ids.join()}`;
  if (c.kind === "select") {
    return (
      <div className="es-row">
        <span className="text-2xs text-mute">{c.label}</span>
        <select className="ed-field" value={String(value)} onChange={(e) => setRoleControl(ids, c.id, e.target.value)} aria-label={c.label}>
          {c.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span />
      </div>
    );
  }
  const v = Number(value) || 0;
  return (
    <div className="es-row">
      <label className="flex items-center gap-1.5 text-2xs text-mute">
        <input type="checkbox" checked={v > 0} onChange={(e) => setRoleControl(ids, c.id, e.target.checked ? 0.5 : 0)} />{c.label}
      </label>
      <input type="range" min={0} max={1} step={0.01} value={v} disabled={v <= 0} onChange={(e) => setRoleControl(ids, c.id, Math.max(0.01, Number(e.target.value)), key)} aria-label={c.label} />
      <span className="mono text-2xs">{v > 0 ? Math.round(v * 100) : "off"}</span>
    </div>
  );
}
