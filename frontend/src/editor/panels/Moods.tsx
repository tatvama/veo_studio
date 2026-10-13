/**
 * Moods panel (docs/EDITOR.md §10): one click gives the chosen clips, a track or the whole sequence a mood — its
 * colour and texture chain, its transitions at the cuts and its title style — as one undoable command, at an
 * intensity. Each card shows the user's own frame at the playhead through that mood. For a sequence imported from a
 * studio episode, "Mood per scene" reads the episode's scenes and suggests a mood for each from its emotion (or asks
 * the AI, mood_suggest, when the AI tools have it) to preview and apply per scene range.
 */
import { clsx } from "clsx";
import { Check, Clapperboard, Copy, Eraser, Loader2, Music2, Sparkles, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../components/ui";
import { api } from "../../lib/api";
import { MOODS, moodById, type MoodDef } from "../../lib/moods";
import { transitionLabel } from "../dialogs";
import { useEditorHost } from "../host";
import { applyMood, clipMood, moodInstances, removeMood, scopeClips, type MoodScope } from "../moods/apply";
import { renderLook } from "../moods/engineLooks";
import { sceneRanges, type SceneRange, type StudioScene } from "../moods/scenes";
import { lutUrlFor, ScopePicker, scopeOf, Slider, Thumb, useClipFrame, useVisible, type ScopeChoice } from "../moods/ui";
import { clipEnd, ctxOf, tracksOf } from "../model/ops";
import { framesToSeconds, toTimecode } from "../model/time";
import type { Sequence } from "../model/types";
import { program } from "../playback/transport";
import { setFocus, useEditor, useSequence } from "../store";

const LS = "tatvam-editor:moods";
const lsRead = (): { intensity: number; transitions: boolean; titles: boolean } => {
  try { return { intensity: 1, transitions: true, titles: true, ...JSON.parse(localStorage.getItem(LS) || "{}") }; } catch { return { intensity: 1, transitions: true, titles: true }; }
};

/** Average shot length (seconds) of the clips in a scope. */
function avgShot(s: Sequence, scope: MoodScope): number | null {
  const cs = scopeClips(s, scope).filter((c) => c.source.type === "media" || c.source.type === "nested");
  if (!cs.length) return null;
  return framesToSeconds(cs.reduce((n, c) => n + c.duration, 0) / cs.length, s.fps);
}

export default function MoodsPanel() {
  const host = useEditorHost();
  const s = useSequence();
  const sel = useEditor((x) => x.selection);
  const root = useRef<HTMLDivElement>(null);
  const visible = useVisible(root);
  const [opts, setOpts] = useState(lsRead);
  const [choice, setChoice] = useState<ScopeChoice>(sel.length ? "selection" : "sequence");
  const [picked, setPicked] = useState<string>(MOODS[0].id);
  useEffect(() => { try { localStorage.setItem(LS, JSON.stringify(opts)); } catch { /* blocked */ } }, [opts]);
  useEffect(() => { if (!sel.length && choice === "selection") setChoice("sequence"); }, [sel.length]);
  // thumbnails follow the intensity a moment after the slider stops
  const [thumbK, setThumbK] = useState(opts.intensity);
  useEffect(() => { const id = window.setTimeout(() => setThumbK(opts.intensity), 300); return () => window.clearTimeout(id); }, [opts.intensity]);
  const frame = useClipFrame(240);
  const thumbs = useMemo(() => {
    if (!visible || !frame.canvas) return {} as Record<string, Promise<ImageBitmap | null>>;
    return Object.fromEntries(MOODS.map((m) => [m.id, renderLook(frame.canvas!, moodInstances(m, thumbK), { lutUrl: lutUrlFor })]));
  }, [visible, frame.canvas, thumbK]);
  const original = useMemo(() => (visible && frame.canvas ? renderLook(frame.canvas, []) : null), [visible, frame.canvas]);

  const scope = scopeOf(choice, s, sel);
  const count = scopeClips(s, scope, opts.titles).length;
  const current = useMemo(() => {
    const ms = new Set(scopeClips(s, scope).map(clipMood).filter(Boolean));
    return ms.size === 1 ? [...ms][0] : ms.size > 1 ? "mixed" : null;
  }, [s, choice, sel]);
  const mood = moodById(picked) ?? MOODS[0];
  const avg = avgShot(s, scope);

  const apply = (m: MoodDef, sc: MoodScope = scope, what = choice === "selection" ? "selected clips" : choice === "track" ? "the track" : "the sequence") => {
    let res = { clips: 0, cuts: 0, titles: 0 };
    host.apply(`Mood ${m.label}`, (d) => {
      const i = d.sequences.findIndex((x) => x.id === d.activeSequenceId);
      if (i < 0) return;
      const r = applyMood(d.sequences[i], ctxOf(d), m, sc, { intensity: opts.intensity, transitions: opts.transitions, titles: opts.titles });
      d.sequences[i] = r.seq;
      res = r;
    });
    if (!res.clips && !res.titles) { toast.message(choice === "selection" ? "Select video clips first" : "No video clips to give a mood to"); return; }
    toast.success(`${m.label} on ${what}: ${res.clips} clip${res.clips === 1 ? "" : "s"}${res.cuts ? `, ${res.cuts} transition${res.cuts === 1 ? "" : "s"}` : ""}${res.titles ? `, ${res.titles} title${res.titles === 1 ? "" : "s"}` : ""}`);
  };
  const remove = () => {
    let n = 0;
    host.apply("Remove mood", (d) => {
      const i = d.sequences.findIndex((x) => x.id === d.activeSequenceId);
      const r = removeMood(d.sequences[i], ctxOf(d), scope);
      d.sequences[i] = r.seq; n = r.clips;
    });
    toast.message(n ? `Mood removed from ${n} clip${n === 1 ? "" : "s"}` : "No mood to remove there");
  };

  return (
    <div ref={root} className="pn" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar flex-wrap gap-2">
        <ScopePicker value={choice} onChange={setChoice} count={sel.length} />
        <span className="text-2xs text-dim">{count} clip{count === 1 ? "" : "s"}{current ? ` · now ${current === "mixed" ? "mixed moods" : moodById(current)?.label}` : ""}</span>
        <button type="button" className="ed-ibtn ml-auto" title="Remove the mood from these clips" onClick={remove}><Eraser className="size-3.5" /></button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line px-3 py-2">
        <div className="min-w-[180px] flex-1"><Slider label="Intensity" value={opts.intensity} min={0} max={1.5} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setOpts((o) => ({ ...o, intensity: v }))} /></div>
        <label className="flex items-center gap-1.5 text-2xs text-mute"><input type="checkbox" checked={opts.transitions} onChange={(e) => setOpts((o) => ({ ...o, transitions: e.target.checked }))} />Transitions at cuts</label>
        <label className="flex items-center gap-1.5 text-2xs text-mute"><input type="checkbox" checked={opts.titles} onChange={(e) => setOpts((o) => ({ ...o, titles: e.target.checked }))} />Title style</label>
      </div>
      <div className="pn-scroll">
        <div className="grid gap-2 p-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))" }}>
          <div className="rounded-lg border border-line p-1.5">
            <Thumb promise={original} className="aspect-video" label={frame.clip ? (frame.loading ? "Reading the frame…" : "No picture") : "Put a clip on V1"} />
            <p className="mt-1 truncate text-2xs text-dim" title={frame.clip?.name}>Original · {frame.clip?.name ?? "no clip"}</p>
          </div>
          {MOODS.map((m) => (
            <button key={m.id} type="button" data-mood={m.id} title={`${m.blurb} — double-click to apply`}
              className={clsx("group rounded-lg border p-1.5 text-left transition-colors", picked === m.id ? "border-accent bg-accent/10" : "border-line hover:border-dim/50")}
              onClick={() => setPicked(m.id)} onDoubleClick={() => apply(m)}>
              <div className="relative">
                <Thumb promise={thumbs[m.id] ?? null} className="aspect-video" label={<span className="block h-full w-full" style={{ background: `linear-gradient(135deg, ${m.swatch[0]}, ${m.swatch[1]})` }} />} />
                {current === m.id && <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-accent text-black"><Check className="size-3" /></span>}
              </div>
              <p className="mt-1 flex items-center gap-1 text-xs font-medium"><span className="size-2 rounded-full" style={{ background: m.swatch[0] }} />{m.label}</p>
              <p className="truncate text-[10px] text-dim">{m.blurb}</p>
            </button>
          ))}
        </div>
        <MoodDetails mood={mood} avg={avg} onApply={() => apply(mood)} />
        {s.source && <MoodPerScene seq={s} intensity={opts.intensity} onApply={(m, r) => apply(m, { kind: "range", from: r.from, to: r.to }, `scene ${r.scene.order}`)} />}
      </div>
    </div>
  );
}

function MoodDetails({ mood, avg, onApply }: { mood: MoodDef; avg: number | null; onApply: () => void }) {
  const copy = (t: string) => { void navigator.clipboard?.writeText(t).then(() => toast.success("Music prompt copied: paste it into the AI panel's Music tool")).catch(() => toast.message(t)); };
  return (
    <div className="mx-2 mb-2 rounded-lg border border-line p-3" data-mood-details={mood.id}>
      <div className="mb-2 flex items-center gap-2">
        <span className="size-3 rounded-full" style={{ background: `linear-gradient(135deg, ${mood.swatch[0]}, ${mood.swatch[1]})` }} />
        <span className="text-sm font-semibold">{mood.label}</span>
        <span className="text-2xs text-dim">{mood.blurb}</span>
        <Button size="sm" variant="primary" className="ml-auto" icon={<Wand2 className="size-3.5" />} onClick={onApply}>Apply</Button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-2xs">
        <dt className="text-dim">Look</dt><dd className="text-mute">{mood.effects.map((e) => (e.type === "look" ? `${String(e.params.look).replace(/_/g, " ")} LUT` : e.type.replace(/_/g, " "))).join(" → ")}</dd>
        <dt className="text-dim">Transitions</dt><dd className="text-mute">{mood.transition.ids.map(transitionLabel).join(", ")} · {mood.transition.seconds} s</dd>
        <dt className="text-dim">Titles</dt><dd><span style={{ fontFamily: `"${mood.title.font}"`, fontWeight: mood.title.weight, color: mood.title.color }} className="text-sm">{mood.label} title</span></dd>
        <dt className="text-dim">Pacing</dt><dd className="text-mute">{mood.pacing.label}: shots of about {mood.pacing.avgShot} s{avg !== null ? ` · yours average ${avg.toFixed(1)} s${avg > mood.pacing.avgShot * 1.5 ? " (cut tighter)" : avg < mood.pacing.avgShot / 1.5 ? " (let shots breathe)" : ""}` : ""}</dd>
        <dt className="text-dim">Music</dt>
        <dd className="flex items-start gap-1.5 text-mute"><Music2 className="mt-0.5 size-3 shrink-0 text-ai" /><span className="flex-1">{mood.music}</span>
          <button type="button" className="text-dim hover:text-ink" title="Copy the music prompt" onClick={() => copy(mood.music)}><Copy className="size-3" /></button></dd>
      </dl>
    </div>
  );
}

// ── mood per scene ───────────────────────────────────────────────────────────

interface EpisodeOut { scenes?: StudioScene[]; shots?: { code: string; scene_id?: number | null }[] }
type Ai = { suggestMoods?: (host: ReturnType<typeof useEditorHost>, scenes: { id: string; title: string; emotion: string; summary: string; start: number; end: number }[], moods: string[]) => Promise<{ scene_id: string; mood: string; why: string }[] | null> };

function MoodPerScene({ seq, onApply }: { seq: Sequence; intensity: number; onApply: (m: MoodDef, r: SceneRange) => void }) {
  const host = useEditorHost();
  const [scenes, setScenes] = useState<StudioScene[] | null>(null);
  const [codes, setCodes] = useState<Record<number, string[]>>({});
  const [busy, setBusy] = useState<"" | "load" | "ai">("");
  const [ai, setAi] = useState<Record<number, { mood: string; why?: string }>>({});
  const [override, setOverride] = useState<Record<number, string>>({});
  const [aiMod, setAiMod] = useState<Ai | null>(null);
  // the AI tools' mood_suggest, when this build has them (no hard dependency on editor/ai)
  useEffect(() => {
    const load = import.meta.glob("../ai/wave3Tools.ts")["../ai/wave3Tools.ts"];
    if (load) void load().then((m) => setAiMod(m as Ai)).catch(() => setAiMod(null));
  }, []);
  const load = async () => {
    if (!seq.source) return;
    setBusy("load");
    try {
      // the edit's studio API (scene emotions and their shots' codes), else the episode itself
      const pid = host.studioProjectId();
      const viaEdit = pid ? await api.get<{ scenes: { id: number; title: string; emotion: string; summary: string; shot_codes: string[] }[] }>(
        `/api/edits/${pid}/episode-scenes?episode_id=${seq.source.eid}`, { silent: true }).catch(() => null) : null;
      if (viaEdit) {
        setScenes(viaEdit.scenes.map((x, i) => ({ id: x.id, order: i + 1, title: x.title, emotion: x.emotion, summary: x.summary })));
        setCodes(Object.fromEntries(viaEdit.scenes.map((x) => [x.id, x.shot_codes])));
        if (!viaEdit.scenes.length) toast.message("The episode has no scenes");
      } else {
        const ep = await api.get<EpisodeOut>(`/api/episodes/${seq.source.eid}`, { silent: true });
        setScenes(ep.scenes ?? []);
        const by: Record<number, string[]> = {};
        for (const sh of ep.shots ?? []) if (sh.scene_id && sh.code) (by[sh.scene_id] ??= []).push(sh.code);
        setCodes(by);
        if (!ep.scenes?.length) toast.message("The episode has no scenes");
      }
    } catch (e) { toast.error(`Couldn't read the episode's scenes: ${(e as Error).message}`); }
    setBusy("");
  };
  const ranges = useMemo(() => {
    if (!scenes) return [];
    const base = sceneRanges(seq, scenes, ai);
    // clips named after their shot's code give exact scene ranges (desktop import names them so)
    const vids = new Set(tracksOf(seq, "video").map((t) => t.id));
    return base.map((r) => {
      const cs = seq.clips.filter((c) => vids.has(c.trackId) && (codes[r.scene.id] ?? []).includes(c.name));
      return cs.length ? { ...r, from: Math.min(...cs.map((c) => c.start)), to: Math.max(...cs.map(clipEnd)) } : r;
    });
  }, [scenes, seq, ai, codes]);
  const askAi = async () => {
    if (!aiMod?.suggestMoods || !ranges.length) return;
    setBusy("ai");
    try {
      const picks = await aiMod.suggestMoods(host, ranges.map((r) => ({ id: String(r.scene.id), title: r.scene.title ?? "", emotion: r.scene.emotion ?? "", summary: r.scene.summary ?? "", start: r.from, end: r.to })), MOODS.map((m) => m.id));
      if (picks) setAi(Object.fromEntries(picks.map((p) => [Number(p.scene_id), { mood: p.mood, why: p.why }])));
    } finally { setBusy(""); }
  };
  const moodOf = (r: SceneRange) => moodById(override[r.scene.id] ?? "") ?? r.suggested;
  return (
    <div className="mx-2 mb-3 rounded-lg border border-line" data-mood-scenes>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Clapperboard className="size-3.5 text-accent-ink" />
        <span className="text-xs font-semibold">Mood per scene</span>
        <span className="text-2xs text-dim">from the studio episode's scene emotions</span>
        <div className="ml-auto flex gap-1.5">
          {aiMod?.suggestMoods && scenes && <Button size="sm" variant="ghost" loading={busy === "ai"} icon={<Sparkles className="size-3.5" />} onClick={() => void askAi()} title="Ask the AI (shows the price first)">Ask AI</Button>}
          <Button size="sm" variant="secondary" loading={busy === "load"} onClick={() => void load()}>{scenes ? "Reload" : "Load scenes"}</Button>
          {ranges.length > 0 && <Button size="sm" variant="primary" onClick={() => ranges.forEach((r) => { const m = moodOf(r); if (m) onApply(m, r); })}>Apply all</Button>}
        </div>
      </div>
      {scenes && !ranges.length && <p className="p-3 text-2xs text-dim">No scene ranges found: the import marks each scene with a “Scene N” marker.</p>}
      {ranges.map((r) => {
        const m = moodOf(r);
        return (
          <div key={r.scene.id} className="pn-row items-start gap-2 py-1.5" data-scene={r.scene.order}>
            <button type="button" className="mono w-[4.5rem] shrink-0 text-left text-2xs text-accent-ink hover:underline" title="Go to the scene" onClick={() => program.seek(r.from)}>{toTimecode(r.from, seq.fps)}</button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs">Scene {r.scene.order}{r.scene.title ? `: ${r.scene.title}` : ""}</p>
              <p className="truncate text-[10px] text-dim" title={r.why}>{r.scene.emotion ? `Emotion: ${r.scene.emotion}` : "No emotion set"}{ai[r.scene.id] ? " · AI" : ""} · {r.why}</p>
            </div>
            <select className="ed-field w-28" value={m?.id ?? ""} onChange={(e) => setOverride((o) => ({ ...o, [r.scene.id]: e.target.value }))}>
              <option value="">No mood</option>
              {MOODS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
            <Button size="sm" variant="secondary" disabled={!m} onClick={() => { if (m) { program.seek(r.from); onApply(m, r); } }}>Apply</Button>
          </div>
        );
      })}
      {busy === "load" && <div className="grid place-items-center p-3"><Loader2 className="size-4 animate-spin text-dim" /></div>}
    </div>
  );
}
