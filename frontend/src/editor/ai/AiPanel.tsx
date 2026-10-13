/**
 * The editor's AI panel (docs/EDITOR.md §8). Paid tools show their price before they run and go through the studio's
 * jobs, budgets and approvals; free tools run on this PC. Everything reaches the edit through the EditorHost.
 */
import {
  AudioWaveform, Bot, Captions, Clapperboard, Expand, Film, Gauge, Languages, Mic, Music2, ScanSearch, Scissors,
  Sparkles, Volume2, Wand2, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { usd } from "../../lib/format";
import type { VideoEngines } from "../../lib/types";
import { Badge, Button, Input, Progress, Segmented, Select, Textarea, Toggle } from "../../components/ui";
import { XFADE_IDS } from "../../engine/transitions/xfade";
import { clipById, ctxOf, seqEnd, trackById } from "../model/ops";
import { framesToSeconds, shortDuration, toTimecode } from "../model/time";
import { DUB_LANGUAGES, SILENCE_DEFAULTS } from "./actions";
import { cancelJob, ensureStudioProject, toolsInfo, voicesFor } from "./api";
import { canAnalyze } from "./bridge";
import { sequenceDigest, soundParts, videoParts, type CaptionStyle } from "./commands";
import { ensureDialogs } from "./dialogs";
import type { EditorHost } from "./host-types";
import { useAi, type AiRun } from "./store";
import {
  applyAssistant, applyScenes, askAssistant, beatMarkers, broll, brollTarget, captions, cleanVoice, cutSilences, dub, editWithWords,
  extendClip, findScenes, findSilences, getLastCaptions, inOutRange, measureLoudness, music, normaliseLoudness, soundEffect, suggestSounds,
  translateCaptions, upscale, voiceOver, type CaptionSet, type LoudnessRow,
} from "./tools";
import { errMsg, Go, knownKey, Note, Row, Section, usePrice } from "./parts";
import type { AiCommandRow, ToolsInfo, VoiceRef, VoicesInfo } from "./types";
import { MoodSelect, moodMusic, useMoodNames, Wave3Sections } from "./Wave3Sections";

const LANGS: [string, string][] = [["en", "English"], ["hi", "Hindi"], ["kn", "Kannada"], ["te", "Telugu"], ["ta", "Tamil"]];

// ── reading the editor ───────────────────────────────────────────────────────

/** Re-renders when the selection, playhead, marks or sequence change (the host has getters, not events). */
function useHostTick(host: EditorHost): string {
  const read = () => {
    const seq = host.sequence(), io = host.inOut();
    return [seq.id, seq.clips.length, seqEnd(seq), host.selection().clipIds.join(","), host.playhead(), io.in, io.out,
      host.studioProjectId()].join("|");
  };
  const [key, setKey] = useState(read);
  useEffect(() => {
    const t = setInterval(() => { const k = read(); setKey((p) => (p === k ? p : k)); }, 400);
    return () => clearInterval(t);
  }, [host]);  // eslint-disable-line react-hooks/exhaustive-deps
  return key;
}

/** A stable key for parts and their studio keys (prices refetch when what they cover changes or its media reaches the
 *  studio, not on every tick). */
let keyHost: EditorHost | null = null;
const partsKey = (parts: { mediaId: string; srcStart: number; srcEnd: number }[]) =>
  parts.map((x) => `${x.mediaId}:${x.srcStart}:${x.srcEnd}:${keyHost ? knownKey(keyHost, x.mediaId) ?? "" : ""}`).join("|");

function LangSelect({ value, onChange, auto }: { value: string; onChange: (v: string) => void; auto?: boolean }) {
  return (
    <Select className="h-7 text-xs" value={value} onChange={(e) => onChange(e.target.value)}>
      {auto && <option value="auto">Detect</option>}
      {LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
    </Select>
  );
}

function VoicePicker({ host, language, value, onChange }: { host: EditorHost; language: string; value: VoiceRef; onChange: (v: VoiceRef) => void }) {
  const pid = host.studioProjectId();
  const [info, setInfo] = useState<VoicesInfo | null>(null);
  useEffect(() => {
    if (!pid) return;
    let alive = true;
    voicesFor(pid, language).then((v) => alive && setInfo(v)).catch(() => alive && setInfo(null));
    return () => { alive = false; };
  }, [pid, language]);
  const cur = value.profile_id ? `profile:${value.profile_id}` : value.provider ? `${value.provider}:${value.voice_id ?? ""}` : "";
  const pick = (v: string) => {
    if (!v) return onChange({});
    if (v.startsWith("profile:")) return onChange({ profile_id: Number(v.slice(8)) });
    const [provider, ...rest] = v.split(":");
    onChange({ provider, voice_id: rest.join(":") });
  };
  if (!pid) {
    return (
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-mute">The team's voice for this language</span>
        <Button size="sm" variant="ghost" onClick={() => ensureStudioProject(host).catch(() => undefined)}>More voices</Button>
      </div>
    );
  }
  return (
    <Select className="h-7 text-xs" value={cur} onChange={(e) => pick(e.target.value)}>
      <option value="">Team voice{info ? ` (${info.default.provider} · ${info.default.voice_id || "pick"})` : ""}</option>
      {!!info?.studio.length && (
        <optgroup label="Studio voices">{info.studio.map((v) => <option key={v.profile_id} value={`profile:${v.profile_id}`}>{v.name}</option>)}</optgroup>
      )}
      {info?.providers.filter((p) => p.voices.length).map((p) => (
        <optgroup key={p.provider} label={`${p.provider}${p.mode === "mock" ? " (mock)" : ""}`}>
          {p.voices.slice(0, 80).map((v) => <option key={v.voice_id} value={`${p.provider}:${v.voice_id}`}>{v.name}{v.description ? ` — ${v.description}` : ""}</option>)}
        </optgroup>
      ))}
    </Select>
  );
}

function RunList() {
  const runs = useAi((s) => s.runs);
  const { dismiss, clearDone } = useAi.getState();
  if (!runs.length) return null;
  const tone = (r: AiRun) => (r.status === "failed" ? "bad" : r.status === "done" ? "ok" : r.status === "awaiting_approval" ? "warn" : "accent");
  return (
    <div className="space-y-1.5 border-b border-line px-3 py-2">
      <div className="flex items-center justify-between text-2xs uppercase tracking-wide text-dim">
        <span>Runs</span>
        <button className="hover:text-ink" onClick={clearDone}>Clear finished</button>
      </div>
      {runs.slice(0, 8).map((r) => (
        <div key={r.id} className="space-y-1">
          <div className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate">{r.title}</span>
            <span className="shrink-0 text-dim">{r.status === "failed" ? "failed" : r.status === "done" ? (r.usd ? usd(r.usd) : "done") : r.message || r.status}</span>
            {["queued", "running", "awaiting_approval"].includes(r.status) && r.jobIds.length > 0 && (
              <button title="Stop" className="text-dim hover:text-ink" onClick={() => r.jobIds.forEach((j) => cancelJob(j).catch(() => undefined))}><X className="size-3.5" /></button>
            )}
            {["done", "failed", "cancelled"].includes(r.status) && (
              <button title="Dismiss" className="text-dim hover:text-ink" onClick={() => dismiss(r.id)}><X className="size-3.5" /></button>
            )}
          </div>
          {!["done", "failed", "cancelled"].includes(r.status) && <Progress size="sm" value={r.progress} indeterminate={!r.progress} tone={tone(r)} />}
          {r.status === "failed" && r.error && <p className="truncate text-2xs text-red-300" title={r.error}>{r.error}</p>}
        </div>
      ))}
    </div>
  );
}

// ── the panel ────────────────────────────────────────────────────────────────

export function AiPanel({ host }: { host: EditorHost }) {
  keyHost = host;
  const tick = useHostTick(host);
  const [open, setOpen] = useState<string>("captions");
  const toggle = (id: string) => setOpen((o) => (o === id ? "" : id));
  const pid = host.studioProjectId();
  const [info, setInfo] = useState<ToolsInfo | null>(null);
  useEffect(() => { ensureDialogs(); }, []);
  useEffect(() => {
    if (!pid) return;
    toolsInfo(pid).then(setInfo).catch(() => setInfo(null));
  }, [pid]);

  const ctx = useMemo(() => {
    const p = host.project(), seq = host.sequence(), sel = host.selection().clipIds;
    const c = ctxOf(p);
    const clips = sel.map((id) => clipById(seq, id)).filter((x): x is NonNullable<typeof x> => !!x);
    const sound = soundParts(p, seq, { clipIds: sel });
    const video = videoParts(p, seq, sel);
    const music = clips.filter((x) => x.source.type === "media" && c.media(x.source.mediaId)?.kind === "audio" && trackById(seq, x.trackId)?.kind === "audio");
    return { p, seq, sel, clips, sound, video, music, range: inOutRange(host), fps: seq.fps };
  }, [tick]);  // eslint-disable-line react-hooks/exhaustive-deps

  const missing = (id: string) => info?.tools.find((t) => t.id === id && !t.ready);
  const keyWarn = (id: string) => { const m = missing(id); return m ? <Note>Needs the {m.provider} key on the studio (Admin → Settings).</Note> : null; };
  const local = canAnalyze();
  const sel = ctx.sel.length ? `${ctx.sel.length} selected` : "nothing selected";

  return (
    <div className="flex h-full flex-col overflow-hidden text-ink">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs">
        <Sparkles className="size-4 text-ai" />
        <span className="font-semibold">AI tools</span>
        <span className="min-w-0 flex-1 truncate text-dim">{sel} · {toTimecode(host.playhead(), ctx.fps)}</span>
        {pid ? <Badge tone="ai" title="The studio project that carries this edit's AI costs">studio #{pid}</Badge> : <Badge>not connected</Badge>}
      </div>
      <RunList />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <CaptionsSection host={host} ctx={ctx} open={open === "captions"} onToggle={toggle} warn={keyWarn("transcribe")} />
        <TranslateSection host={host} open={open === "translate"} onToggle={toggle} />
        <VoiceOverSection host={host} open={open === "tts"} onToggle={toggle} />
        <DubSection host={host} ctx={ctx} open={open === "dub"} onToggle={toggle} />
        <CleanSection host={host} ctx={ctx} open={open === "clean"} onToggle={toggle} warn={keyWarn("clean_voice")} />
        <SfxSection host={host} open={open === "sfx"} onToggle={toggle} />
        <MusicSection host={host} ctx={ctx} open={open === "music"} onToggle={toggle} />
        <BrollSection host={host} ctx={ctx} open={open === "broll"} onToggle={toggle} />
        <ExtendSection host={host} ctx={ctx} open={open === "extend"} onToggle={toggle} />
        <EditWordsSection host={host} ctx={ctx} open={open === "words"} onToggle={toggle} />
        <UpscaleSection host={host} ctx={ctx} open={open === "upscale"} onToggle={toggle} />
        <SilenceSection host={host} ctx={ctx} open={open === "silence"} onToggle={toggle} local={local} />
        <ScenesSection host={host} ctx={ctx} open={open === "scenes"} onToggle={toggle} local={local} />
        <Section id="beats" open={open === "beats"} onToggle={toggle} free icon={<AudioWaveform className="size-4" />} title="Beat markers">
          <Note>Markers on a music clip's beats, for cutting to the beat. Select one music clip.</Note>
          {!local && <Note>Runs on your PC: open the edit in Tatvam Desktop.</Note>}
          <Go label="Add beat markers" disabled={!local || ctx.music.length !== 1}
            onClick={async () => { try { host.toast(`${await beatMarkers(host, ctx.music[0].id)} beat markers added`, "ok"); } catch (e) { host.toast(errMsg(e), "error"); } }} />
        </Section>
        <LoudnessSection host={host} ctx={ctx} open={open === "loudness"} onToggle={toggle} local={local} />
        <AssistantSection host={host} open={open === "assistant"} onToggle={toggle} />
        <Wave3Sections host={host} open={open} onToggle={toggle} tick={tick} />
      </div>
    </div>
  );
}

type Ctx = { p: ReturnType<EditorHost["project"]>; seq: ReturnType<EditorHost["sequence"]>; sel: string[]; clips: { id: string }[];
  sound: ReturnType<typeof soundParts>; video: ReturnType<typeof videoParts>; music: { id: string }[]; range: [number, number] | null; fps: number };
interface SectionProps { host: EditorHost; open: boolean; onToggle: (id: string) => void }

// ── captions ─────────────────────────────────────────────────────────────────

function CaptionsSection({ host, ctx, open, onToggle, warn }: SectionProps & { ctx: Ctx; warn: ReactNode }) {
  const [scope, setScope] = useState<"selection" | "range" | "all">("selection");
  const [language, setLanguage] = useState("auto");
  const [style, setStyle] = useState<CaptionStyle>("lines");
  const [words, setWords] = useState(true);
  const effScope = scope === "selection" && !ctx.sel.length ? (ctx.range ? "range" : "all") : scope;
  const parts = useMemo(() => soundParts(ctx.p, ctx.seq, effScope === "selection" ? { clipIds: ctx.sel } : { range: effScope === "range" && ctx.range ? ctx.range : [0, seqEnd(ctx.seq)] }),
    [ctx, effScope]);
  const price = usePrice(host, open, () => {
    const keys = parts.map((x) => knownKey(host, x.mediaId));
    if (keys.some((k) => !k)) return null;
    return parts.map((x, i) => ({ tool: "transcribe", params: { key: keys[i], language, words, start: x.srcStart, end: x.srcEnd } }));
  }, [partsKey(parts), language, words]);
  return (
    <Section id="captions" open={open} onToggle={onToggle} icon={<Captions className="size-4" />} title="Auto captions" hint={`${parts.length} clip${parts.length === 1 ? "" : "s"}`}>
      <Segmented size="sm" value={scope} onChange={setScope} options={[
        { value: "selection", label: `Selected${ctx.sel.length ? ` (${ctx.sel.length})` : ""}` }, { value: "range", label: "In / out" }, { value: "all", label: "Whole sequence" }]} />
      <Row label="Language"><LangSelect auto value={language} onChange={setLanguage} /></Row>
      <Row label="Lines">
        <Segmented size="sm" value={style} onChange={setStyle} options={[{ value: "lines", label: "Sentences" }, { value: "phrases", label: "Short phrases" }]} />
      </Row>
      <Toggle checked={words} onChange={setWords} label={<span className="text-xs">Word timings</span>} />
      <Note>Gemini listens to the sound (Google first). The captions go on a new caption track as styled title clips. A karaoke word highlight needs the text engine's word styling (later).</Note>
      {warn}
      <Go label={`Caption ${parts.length} clip${parts.length === 1 ? "" : "s"}`} price={price} disabled={!parts.length}
        onClick={() => captions(host, { clipIds: effScope === "selection" ? ctx.sel : undefined, range: effScope === "range" ? ctx.range : effScope === "all" ? [0, seqEnd(ctx.seq)] : null, language, words, style })} />
    </Section>
  );
}

function TranslateSection({ host, open, onToggle }: SectionProps) {
  const [targets, setTargets] = useState<string[]>(["hi"]);
  const [src, setSrc] = useState<CaptionSet | null>(getLastCaptions());
  useEffect(() => { if (open) setSrc(getLastCaptions()); }, [open]);
  const f = host.sequence().fps;
  const price = usePrice(host, open, () => src ? targets.map((t) => ({ tool: "translate", params: { target: t, source: src.language || "auto",
    segments: src.cues.map((c) => ({ start: framesToSeconds(c.start, f), end: framesToSeconds(c.end, f), text: c.text })) } })) : null, [src, targets.join(",")]);
  return (
    <Section id="translate" open={open} onToggle={onToggle} icon={<Languages className="size-4" />} title="Translate captions">
      {!src ? <Note>Make captions first: their lines are translated with the same timings (Claude).</Note> : <Note>{src.cues.length} lines in {src.language || "the spoken language"}.</Note>}
      <div className="flex flex-wrap gap-1">
        {LANGS.map(([c, n]) => (
          <button key={c} onClick={() => setTargets((t) => (t.includes(c) ? t.filter((x) => x !== c) : [...t, c]))}
            className={`rounded-md border px-2 py-0.5 text-xs ${targets.includes(c) ? "border-accent/50 bg-accent/15 text-accent-ink" : "border-line text-mute"}`}>{n}</button>
        ))}
      </div>
      <Go label={`New caption track${targets.length === 1 ? "" : "s"}`} price={price} disabled={!src || !targets.length} onClick={() => src && translateCaptions(host, src, targets)} />
    </Section>
  );
}

// ── voice ────────────────────────────────────────────────────────────────────

function VoiceOverSection({ host, open, onToggle }: SectionProps) {
  const [text, setText] = useState("");
  const [language, setLanguage] = useState("en");
  const [voice, setVoice] = useState<VoiceRef>({});
  const [style, setStyle] = useState("");
  const price = usePrice(host, open, () => (text.trim() ? [{ tool: "tts", params: { text, language, voice, style } }] : null), [text, language, JSON.stringify(voice), style]);
  return (
    <Section id="tts" open={open} onToggle={onToggle} icon={<Volume2 className="size-4" />} title="AI voice-over">
      <Textarea rows={4} value={text} placeholder="Type or paste the narration…" onChange={(e) => setText(e.target.value)} />
      <Row label="Language"><LangSelect value={language} onChange={setLanguage} /></Row>
      <Row label="Voice"><VoicePicker host={host} language={language} value={voice} onChange={setVoice} /></Row>
      <Row label="Style"><Input className="h-7 text-xs" value={style} placeholder="warm, unhurried (optional)" onChange={(e) => setStyle(e.target.value)} /></Row>
      <Go label="Add at the playhead" price={price} disabled={!text.trim()} onClick={() => voiceOver(host, { text, language, voice, style })} />
    </Section>
  );
}

function DubSection({ host, ctx, open, onToggle }: SectionProps & { ctx: Ctx }) {
  const [target, setTarget] = useState<string>(DUB_LANGUAGES[0][0]);
  const [voice, setVoice] = useState<VoiceRef>({});
  const part = ctx.sound.length === 1 ? ctx.sound[0] : null;
  const price = usePrice(host, open, () => {
    const key = part && knownKey(host, part.mediaId);
    return key && part ? [{ tool: "dub", params: { key, target, voice, start: part.srcStart, end: part.srcEnd } }] : null;
  }, [part ? partsKey([part]) : "", target, JSON.stringify(voice)]);
  return (
    <Section id="dub" open={open} onToggle={onToggle} icon={<Languages className="size-4" />} title="Dub a clip" hint={part ? part.name : "select one clip"}>
      <Note>Listens, translates and voices each line at its time, on a new audio track; the original sound is muted and kept.</Note>
      <Row label="Into"><Select className="h-7 text-xs" value={target} onChange={(e) => setTarget(e.target.value)}>{DUB_LANGUAGES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select></Row>
      <Row label="Voice"><VoicePicker host={host} language={target} value={voice} onChange={setVoice} /></Row>
      <Go label={part ? `Dub ${part.name}` : "Select one clip with sound"} price={price} disabled={!part} onClick={() => part && dub(host, part.clipId, { target, voice })} />
    </Section>
  );
}

function CleanSection({ host, ctx, open, onToggle, warn }: SectionProps & { ctx: Ctx; warn: ReactNode }) {
  const price = usePrice(host, open, () => {
    const keys = ctx.sound.map((x) => knownKey(host, x.mediaId));
    return keys.length && keys.every(Boolean) ? ctx.sound.map((x, i) => ({ tool: "clean_voice", params: { key: keys[i], start: x.srcStart, end: x.srcEnd } })) : null;
  }, [partsKey(ctx.sound)]);
  return (
    <Section id="clean" open={open} onToggle={onToggle} icon={<Mic className="size-4" />} title="Clean up voice" hint={`${ctx.sound.length} with sound`}>
      <Note>Takes the voice out of noise and music (ElevenLabs). The clean voice goes on a new audio track; the original sound is muted, not deleted.</Note>
      {warn}
      <Go label={`Clean ${ctx.sound.length || ""} clip${ctx.sound.length === 1 ? "" : "s"}`} disabled={!ctx.sound.length} onClick={() => cleanVoice(host, ctx.sel)} price={price} />
    </Section>
  );
}

// ── sound ────────────────────────────────────────────────────────────────────

function SfxSection({ host, open, onToggle }: SectionProps) {
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState(4);
  const [ideas, setIdeas] = useState<string[]>([]);
  const price = usePrice(host, open, () => (prompt.trim().length > 1 ? [{ tool: "sfx", params: { prompt, seconds } }] : null), [prompt, seconds]);
  return (
    <Section id="sfx" open={open} onToggle={onToggle} icon={<Sparkles className="size-4" />} title="Sound effects">
      <Textarea rows={2} value={prompt} placeholder="Rain on a tin roof, close" onChange={(e) => setPrompt(e.target.value)} />
      <Row label="Length (s)"><Input className="h-7 text-xs" type="number" min={0.5} max={30} step={0.5} value={seconds} onChange={(e) => setSeconds(Math.max(0.5, Math.min(30, Number(e.target.value) || 4)))} /></Row>
      <Button size="sm" variant="ghost" icon={<ScanSearch className="size-3.5" />} onClick={async () => setIdeas(await suggestSounds(host))}>Ideas from the picture at the playhead</Button>
      {!!ideas.length && (
        <div className="flex flex-wrap gap-1">{ideas.map((s) => <button key={s} className="rounded-md border border-line px-2 py-0.5 text-left text-xs text-mute hover:text-ink" onClick={() => setPrompt(s)}>{s}</button>)}</div>
      )}
      <Go label="Add at the playhead" price={price} disabled={prompt.trim().length < 2} onClick={() => soundEffect(host, { prompt, seconds })} />
    </Section>
  );
}

function MusicSection({ host, ctx, open, onToggle }: SectionProps & { ctx: Ctx }) {
  const [prompt, setPrompt] = useState("");
  const [len, setLen] = useState<"range" | "selection" | "custom">("custom");
  const [custom, setCustom] = useState(30);
  const [volume, setVolume] = useState(-18);
  const [mood, setMood] = useState("");
  const [bpm, setBpm] = useState<number | null>(null);
  const moods = useMoodNames();
  // with no words of your own, a mood the editor knows brings its music prompt
  const words = prompt.trim() || moodMusic(moods, mood);
  const selSpan = ctx.clips.length ? (() => {
    const cs = ctx.sel.map((id) => clipById(ctx.seq, id)!).filter(Boolean);
    return [Math.min(...cs.map((c) => c.start)), Math.max(...cs.map((c) => c.start + c.duration))] as [number, number];
  })() : null;
  const span: [number, number] | null = len === "range" ? ctx.range : len === "selection" ? selSpan : null;
  const seconds = span ? framesToSeconds(span[1] - span[0], ctx.fps) : custom;
  const at = span ? span[0] : host.playhead();
  const described = words.length > 1 || !!mood;
  const price = usePrice(host, open, () => (described ? [{ tool: "music", params: { prompt: words, seconds: Math.max(5, Math.min(300, seconds)),
    ...(mood ? { mood } : {}), ...(bpm ? { bpm } : {}) } }] : null), [prompt, Math.round(seconds), mood, bpm]);
  return (
    <Section id="music" open={open} onToggle={onToggle} icon={<Music2 className="size-4" />} title="Music">
      <Textarea rows={2} value={prompt} placeholder="Gentle santoor and strings, hopeful (or just pick a mood)" onChange={(e) => setPrompt(e.target.value)} />
      <Row label="Length">
        <Segmented size="sm" value={len} onChange={setLen} options={[{ value: "range", label: "In / out" }, { value: "selection", label: "Selection" }, { value: "custom", label: "Seconds" }]} />
      </Row>
      {len === "custom" && <Row label="Seconds"><Input className="h-7 text-xs" type="number" min={5} max={300} value={custom} onChange={(e) => setCustom(Math.max(5, Math.min(300, Number(e.target.value) || 30)))} /></Row>}
      {span === null && len !== "custom" && <Note>{len === "range" ? "Set in and out first." : "Select clips first."}</Note>}
      <Row label="Mood"><MoodSelect value={mood} onChange={setMood} /></Row>
      {!prompt.trim() && moodMusic(moods, mood) && <Note>{moodMusic(moods, mood)}</Note>}
      <Row label="Tempo">
        <div className="flex items-center gap-2">
          <Input className="h-7 w-20 text-xs" type="number" min={40} max={220} placeholder="BPM" value={bpm ?? ""}
            onChange={(e) => { const v = Number(e.target.value); setBpm(e.target.value === "" || !v ? null : Math.max(40, Math.min(220, Math.round(v)))); }} />
          <span className="text-2xs text-dim">{bpm ? `${bpm} BPM` : "any tempo"}</span>
        </div>
      </Row>
      <Row label={`Volume ${volume} dB`}><input type="range" min={-30} max={0} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="w-full" /></Row>
      <Note>Placed on a new audio track at {toTimecode(at, ctx.fps)}, {Math.round(seconds)} s, under the dialogue at {volume} dB.</Note>
      <Go label="Make music" price={price} disabled={!described || (len !== "custom" && !span)} onClick={() => music(host, { prompt: words, seconds, at, volumeDb: volume, mood, bpm })} />
    </Section>
  );
}

// ── picture ──────────────────────────────────────────────────────────────────

function useVideoRoutes(enabled: boolean) {
  const [list, setList] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    if (!enabled) return;
    api.get<VideoEngines>("/api/engines/video", { silent: true }).then((v) => setList(v.engines.flatMap((e) => (e.routes ?? []).map((r) => ({
      id: r.id, label: `${r.display_name}${r.provider_mode === "mock" ? " (mock)" : ""}${r.est_8s_usd ? ` · ${usd(r.est_8s_usd)}/8 s` : ""}`,
    }))))).catch(() => setList([]));
  }, [enabled]);
  return list;
}

function BrollSection({ host, ctx, open, onToggle }: SectionProps & { ctx: Ctx }) {
  const [prompt, setPrompt] = useState("");
  const [quality, setQuality] = useState<"saver" | "balanced" | "hero">("saver");
  const [route, setRoute] = useState("");
  const [useFrame, setUseFrame] = useState(false);
  const routes = useVideoRoutes(open);
  const slot = brollTarget(host);
  const secs = Math.max(1, Math.min(30, framesToSeconds(slot.end - slot.start, ctx.fps)));
  const track = slot.trackId ? trackById(ctx.seq, slot.trackId)?.name : "a new track";
  const price = usePrice(host, open, () => (prompt.trim().length > 1 && !useFrame ? [{ tool: "video", params: { prompt, seconds: secs, quality, route: route || null,
    aspect: ctx.seq.width >= ctx.seq.height ? "16:9" : "9:16" } }] : null), [prompt, secs, quality, route, useFrame]);
  return (
    <Section id="broll" open={open} onToggle={onToggle} icon={<Film className="size-4" />} title="Generate B-roll / fill gap">
      <Textarea rows={3} value={prompt} placeholder="Slow aerial over paddy fields at sunrise" onChange={(e) => setPrompt(e.target.value)} />
      <Row label="Quality"><Segmented size="sm" value={quality} onChange={setQuality} options={[{ value: "saver", label: "Saver" }, { value: "balanced", label: "Balanced" }, { value: "hero", label: "Hero" }]} /></Row>
      <Row label="Engine">
        <Select className="h-7 text-xs" value={route} onChange={(e) => setRoute(e.target.value)}>
          <option value="">Auto (the team's chain, Google first)</option>
          {routes.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </Select>
      </Row>
      <Toggle checked={useFrame} onChange={setUseFrame} label={<span className="text-xs">Start from the frame at the playhead</span>} />
      <Note>Fills {shortDuration(slot.end - slot.start, ctx.fps)} on {track} from {toTimecode(slot.start, ctx.fps)} (the in/out range, else the gap at the playhead). The engine may make a shorter clip; it goes into the AI bin and the gap.</Note>
      <Go label="Generate" price={price} disabled={prompt.trim().length < 2} onClick={() => broll(host, { prompt, quality, route, useFrame })} />
    </Section>
  );
}

function ExtendSection({ host, ctx, open, onToggle }: SectionProps & { ctx: Ctx }) {
  const [seconds, setSeconds] = useState(6);
  const [prompt, setPrompt] = useState("");
  const v = ctx.video.length === 1 ? ctx.video[0] : null;
  const price = usePrice(host, open, () => {
    const key = v && knownKey(host, v.mediaId);
    return key && v ? [{ tool: "extend", params: { key, seconds, prompt, at: Math.max(0, v.srcEnd - 1 / ctx.fps) } }] : null;
  }, [v ? partsKey([v]) : "", seconds, prompt.length > 0]);
  return (
    <Section id="extend" open={open} onToggle={onToggle} icon={<Expand className="size-4" />} title="Extend clip" hint={v ? v.name : "select one video"}>
      <Note>Continues the clip from its last frame; the new part goes right after it.</Note>
      <Row label="Seconds"><Input className="h-7 text-xs" type="number" min={1} max={30} value={seconds} onChange={(e) => setSeconds(Math.max(1, Math.min(30, Number(e.target.value) || 6)))} /></Row>
      <Input className="h-7 text-xs" value={prompt} placeholder="What happens next (optional)" onChange={(e) => setPrompt(e.target.value)} />
      <Go label={v ? `Extend ${v.name}` : "Select one video clip"} disabled={!v} price={price} onClick={() => v && extendClip(host, v.clipId, { seconds, prompt })} />
    </Section>
  );
}

function EditWordsSection({ host, ctx, open, onToggle }: SectionProps & { ctx: Ctx }) {
  const [instruction, setInstruction] = useState("");
  const v = ctx.video.length === 1 ? ctx.video[0] : null;
  const price = usePrice(host, open, () => {
    const key = v && knownKey(host, v.mediaId);
    return key && v && instruction.trim().length > 1 ? [{ tool: "edit_words", params: { key, instruction, start: v.srcStart, end: v.srcEnd } }] : null;
  }, [v ? partsKey([v]) : "", instruction.trim().length > 1]);
  return (
    <Section id="words" open={open} onToggle={onToggle} icon={<Wand2 className="size-4" />} title="Edit with words" hint={v ? v.name : "select one video"}>
      <Textarea rows={2} value={instruction} placeholder="Make it night · remove the car · add light rain" onChange={(e) => setInstruction(e.target.value)} />
      <Note>The edited clip goes on a new track above the original (the original stays).</Note>
      <Go label="Edit the clip" disabled={!v || instruction.trim().length < 2} price={price} onClick={() => v && editWithWords(host, v.clipId, instruction)} />
    </Section>
  );
}

function UpscaleSection({ host, ctx, open, onToggle }: SectionProps & { ctx: Ctx }) {
  const [target, setTarget] = useState(2160);
  const price = usePrice(host, open, () => {
    const keys = ctx.video.map((x) => knownKey(host, x.mediaId));
    return keys.length && keys.every(Boolean) ? ctx.video.map((x, i) => ({ tool: "upscale", params: { key: keys[i], target_h: target, start: x.srcStart, end: x.srcEnd } })) : null;
  }, [partsKey(ctx.video), target]);
  return (
    <Section id="upscale" open={open} onToggle={onToggle} icon={<Gauge className="size-4" />} title="AI upscale" hint={`${ctx.video.length} video`}>
      <Segmented size="sm" value={target} onChange={setTarget} options={[{ value: 1440, label: "2K" }, { value: 2160, label: "4K" }]} />
      <Note>In the cloud (Topaz). Free upscaling on this PC (Real-ESRGAN) is in the finishing room for studio takes; for edit media it comes later. The clip then plays the upscaled file.</Note>
      <Go label={`Upscale ${ctx.video.length || ""} clip${ctx.video.length === 1 ? "" : "s"}`} disabled={!ctx.video.length} price={price}
        onClick={() => upscale(host, ctx.video.map((v) => v.clipId), target)} />
    </Section>
  );
}

// ── free tools ───────────────────────────────────────────────────────────────

const PcOnly = () => <Note>Runs on your PC (FFmpeg): open the edit in Tatvam Desktop.</Note>;

function SilenceSection({ host, ctx, open, onToggle, local }: SectionProps & { ctx: Ctx; local: boolean }) {
  const [o, setO] = useState(SILENCE_DEFAULTS);
  const [found, setFound] = useState<{ range: [number, number]; on: boolean }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { setFound((await findSilences(host, ctx.sel, o)).map((range) => ({ range, on: true }))); }
    catch (e) { host.toast(errMsg(e), "error"); }
    finally { setBusy(false); }
  };
  const picked = found?.filter((x) => x.on) ?? [];
  return (
    <Section id="silence" open={open} onToggle={onToggle} free icon={<Scissors className="size-4" />} title="Remove silences">
      {!local && <PcOnly />}
      <Row label={`Below ${o.thresholdDb} dB`}><input type="range" min={-60} max={-20} value={o.thresholdDb} onChange={(e) => setO({ ...o, thresholdDb: Number(e.target.value) })} className="w-full" /></Row>
      <Row label="Longer than"><Input className="h-7 text-xs" type="number" min={100} step={50} value={o.minMs} onChange={(e) => setO({ ...o, minMs: Math.max(100, Number(e.target.value) || 500) })} /></Row>
      <Row label="Keep (ms)"><Input className="h-7 text-xs" type="number" min={0} step={20} value={o.padMs} onChange={(e) => setO({ ...o, padMs: Math.max(0, Number(e.target.value) || 0) })} /></Row>
      <Go label={ctx.sel.length ? "Find silences in the selection" : "Find silences in in/out"} busy={busy} disabled={!local} onClick={run} />
      {found && (
        <div className="space-y-1">
          {!found.length && <Note>No pauses long enough.</Note>}
          <div className="max-h-40 space-y-0.5 overflow-y-auto">
            {found.map((x, i) => (
              <label key={i} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={x.on} onChange={() => setFound(found.map((y, j) => (j === i ? { ...y, on: !y.on } : y)))} />
                <span className="mono flex-1">{toTimecode(x.range[0], ctx.fps)}</span>
                <span className="text-dim">{shortDuration(x.range[1] - x.range[0], ctx.fps)}</span>
              </label>
            ))}
          </div>
          {!!found.length && <Go label={`Cut ${picked.length} and close the gaps`} disabled={!picked.length}
            onClick={() => { if (cutSilences(host, picked.map((x) => x.range))) { host.toast(`${picked.length} silences cut`, "ok"); setFound(null); } }} />}
        </div>
      )}
    </Section>
  );
}

function ScenesSection({ host, ctx, open, onToggle, local }: SectionProps & { ctx: Ctx; local: boolean }) {
  const [threshold, setThreshold] = useState(0.3);
  const [frames, setFrames] = useState<number[] | null>(null);
  const v = ctx.video.length === 1 ? ctx.video[0] : null;
  useEffect(() => { setFrames(null); }, [v?.clipId]);
  return (
    <Section id="scenes" open={open} onToggle={onToggle} free icon={<Clapperboard className="size-4" />} title="Detect scenes" hint={v ? v.name : "select one video"}>
      {!local && <PcOnly />}
      <Row label={`Sensitivity ${threshold.toFixed(2)}`}><input type="range" min={0.1} max={0.6} step={0.05} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="w-full" /></Row>
      <Go label="Find the cuts" disabled={!local || !v} onClick={async () => { try { if (v) setFrames(await findScenes(host, v.clipId, threshold)); } catch (e) { host.toast(errMsg(e), "error"); } }} />
      {frames && (frames.length ? (
        <div className="space-y-1.5">
          <Note>{frames.length} cut{frames.length === 1 ? "" : "s"}: {frames.slice(0, 8).map((f) => toTimecode(f, ctx.fps)).join(", ")}{frames.length > 8 ? " …" : ""}</Note>
          <div className="grid grid-cols-2 gap-1.5">
            <Button size="sm" onClick={() => { if (v && applyScenes(host, v.clipId, frames, "split")) setFrames(null); }}>Split there</Button>
            <Button size="sm" onClick={() => { if (v && applyScenes(host, v.clipId, frames, "markers")) setFrames(null); }}>Add markers</Button>
          </div>
        </div>
      ) : <Note>No cuts found.</Note>)}
    </Section>
  );
}

function LoudnessSection({ host, ctx, open, onToggle, local }: SectionProps & { ctx: Ctx; local: boolean }) {
  const [rows, setRows] = useState<LoudnessRow[] | null>(null);
  const [target, setTarget] = useState(-14);
  return (
    <Section id="loudness" open={open} onToggle={onToggle} free icon={<AudioWaveform className="size-4" />} title="Loudness" hint={`${ctx.sound.length} with sound`}>
      {!local && <PcOnly />}
      <Go label="Measure the selection" disabled={!local || !ctx.sound.length} onClick={async () => { try { setRows(await measureLoudness(host, ctx.sel)); } catch (e) { host.toast(errMsg(e), "error"); } }} />
      {rows && (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.clipId} className="flex gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span className="mono text-dim">{r.value ? `${r.value.lufs.toFixed(1)} LUFS${Number.isFinite(r.value.peak) ? ` · ${r.value.peak.toFixed(1)} dBTP` : ""}` : "—"}</span>
            </div>
          ))}
          <Row label="Target">
            <Select className="h-7 text-xs" value={target} onChange={(e) => setTarget(Number(e.target.value))}>
              <option value={-14}>−14 LUFS (streaming, social)</option><option value={-16}>−16 LUFS (podcast)</option><option value={-23}>−23 LUFS (broadcast)</option>
            </Select>
          </Row>
          <Go label="Normalise (clip gain)" onClick={() => { const n = normaliseLoudness(host, rows, target); host.toast(n ? `${n} clip${n === 1 ? "" : "s"} set to ${target} LUFS` : "Already there", "ok"); }} />
        </div>
      )}
    </Section>
  );
}

// ── the edit assistant ───────────────────────────────────────────────────────

interface Msg { role: "user" | "assistant"; text: string; rows?: AiCommandRow[]; rejected?: { op: string; reason: string }[]; picked?: Set<string>; applied?: boolean }

function AssistantSection({ host, open, onToggle }: SectionProps) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs.length]);
  const hasText = text.trim().length > 0;
  const price = usePrice(host, open, () => (hasText ? [{ tool: "assistant", params: { instruction: text,
    sequence_digest: sequenceDigest(host.project(), host.sequence(), host.selection().clipIds, { transitions: XFADE_IDS }) } }] : null),
  [hasText, host.sequence().clips.length]);
  const send = async () => {
    const instruction = text.trim();
    if (!instruction) return;
    const history = msgs.map((m) => ({ role: m.role, text: m.text }));
    setMsgs((m) => [...m, { role: "user", text: instruction }]);
    setText("");
    setBusy(true);
    try {
      const r = await askAssistant(host, instruction, history, { transitions: XFADE_IDS });
      if (r) setMsgs((m) => [...m, { role: "assistant", text: r.reply ?? "", rows: r.commands ?? [], rejected: r.rejected ?? [], picked: new Set((r.commands ?? []).map((c) => c.id)) }]);
    } finally { setBusy(false); }
  };
  const apply = async (i: number) => {
    const m = msgs[i];
    const rows = (m.rows ?? []).filter((r) => m.picked?.has(r.id));
    const res = await applyAssistant(host, rows);
    setMsgs((all) => all.map((x, j) => (j === i ? { ...x, applied: true } : x)));
    host.toast(`Edit assistant: ${res.applied} change${res.applied === 1 ? "" : "s"} applied${res.skipped.length ? `, ${res.skipped.length} skipped (${res.skipped[0].reason})` : ""}. Undo takes them back in one step.`, res.skipped.length ? "warn" : "ok");
  };
  return (
    <Section id="assistant" open={open} onToggle={onToggle} icon={<Bot className="size-4" />} title="Edit assistant">
      <Note>Ask for edits ("cut this to 30 seconds", "add markers at each clip", "fade into the second shot"). You review the changes, apply them together and undo them in one step. Claude writes them.</Note>
      <div className="max-h-72 space-y-2 overflow-y-auto">
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "ml-6 rounded-lg bg-raised px-2.5 py-1.5 text-xs" : "space-y-1.5 text-xs"}>
            <p className="whitespace-pre-wrap">{m.text}</p>
            {!!m.rows?.length && (
              <div className="space-y-1 rounded-lg border border-line p-2">
                {m.rows.map((r) => (
                  <label key={r.id} className="flex items-start gap-2">
                    <input type="checkbox" className="mt-0.5" disabled={m.applied} checked={!!m.picked?.has(r.id)}
                      onChange={() => setMsgs((all) => all.map((x, j) => { if (j !== i) return x; const p = new Set(x.picked); if (p.has(r.id)) p.delete(r.id); else p.add(r.id); return { ...x, picked: p }; }))} />
                    <span className="flex-1">{r.summary}</span>
                    {r.paid && <Badge tone="money">paid</Badge>}
                  </label>
                ))}
                <Go label={m.applied ? "Applied" : `Apply ${m.picked?.size ?? 0}`} disabled={m.applied || !m.picked?.size} onClick={() => apply(i)} />
              </div>
            )}
            {!!m.rejected?.length && <p className="text-2xs text-dim">Left out: {m.rejected.map((r) => `${r.op} (${r.reason})`).join("; ")}</p>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <Textarea rows={2} value={text} placeholder="Make the intro punchier and add a title" onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
      <Go label="Ask" price={price} busy={busy} disabled={!text.trim()} onClick={send} />
    </Section>
  );
}
