/**
 * The AI panel's wave 3 sections (docs/EDITOR.md §10): B-roll ideas from the transcript, highlights into Shorts, a
 * thumbnail from the frame at the playhead, a cloned voice (consent first), a mood per scene, backups of the edit on
 * the studio, and timeline review comments (when the editor has no Comments panel of its own).
 */
import { Archive, Download, Image as ImageIcon, Lightbulb, MessageSquare, Mic2, Palette, RotateCcw, Scissors } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, Input, Segmented, Select, Textarea, Toggle } from "../../components/ui";
import { seqEnd } from "../model/ops";
import { secondsToFrames, shortDuration, toTimecode } from "../model/time";
import { soundParts } from "./commands";
import type { EditorHost, MediaItem } from "./host-types";
import { errMsg, Go, knownKey, Note, Row, Section, usePrice } from "./parts";
import { broll, captions, getLastCaptions, pictureAtPlayhead } from "./tools";
import type { Backup, BrollIdea, ConsentRow, EditComment, Highlight, MoodPick, Platform } from "./types";
import { findInBin, MOOD_NAMES, scenesFromEpisode, scenesFromTimeline, transcriptOf, type SceneRange } from "./wave3";
import {
  addComment, addMoodMarkers, applyMoodLooks, backupNow, brollIdeas, cloneVoice, episodeScenes, findHighlights, listBackups, listComments, localVersions,
  makeShorts, placeIdea, resolveComment, restoreBackup, restoreLocal, suggestMoods, thumbnails, voiceConsents,
} from "./wave3Tools";
import type { LocalVersion } from "./bridge";

// editor-looks' Moods (lib/moods.ts, editor/moods/apply.ts), Comments and Versions panels, when they are there: their
// moods (with their emotion words and music prompts) are used, "Apply looks" calls their applyMood, and the comments
// and backups sections here step aside for their panels. All feature-detected: the AI panel builds and runs without them.
const moodModules = import.meta.glob<Record<string, unknown>>(["../../lib/moods.ts", "../moods/index.ts"]);
const applyModules = import.meta.glob<Record<string, unknown>>("../moods/apply.ts");
const hasCommentsPanel = Object.keys(import.meta.glob(["../panels/Comments.tsx", "../panels/Comments/index.tsx"])).length > 0;
// editor-looks' Versions panel is the one home for local versions and studio backups: the Backups section steps aside
const hasVersionsPanel = Object.keys(import.meta.glob(["../panels/Versions.tsx", "../panels/Versions/index.tsx"])).length > 0;

export interface Mood { id: string; label: string; words?: string[]; music?: string }

function readMoods(mod: Record<string, unknown>): Mood[] {
  const arr = mod.MOODS ?? mod.moods ?? mod.MOOD_LIST ?? mod.default;
  const list = Array.isArray(arr) ? arr : arr && typeof arr === "object" ? Object.values(arr) : [];
  return list.map((x): Mood | null => {
    if (typeof x === "string") return { id: x, label: x };
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const id = String(o.id ?? o.name ?? "");
      const words = (Array.isArray(o.emotions) ? o.emotions : Array.isArray(o.words) ? o.words : []).filter((w): w is string => typeof w === "string");
      return id ? { id, label: String(o.label ?? o.name ?? id), words: words.slice(0, 40).map((w) => w.slice(0, 40)),
        ...(typeof o.music === "string" ? { music: o.music } : {}) } : null;
    }
    return null;
  }).filter((x): x is Mood => !!x);
}

let moodCache: Mood[] | null = null;

/** What mood_suggest gets for each mood: its id, name and emotion words. */
export const moodOptions = (moods: Mood[]) => moods.slice(0, 100).map((m) => ({ id: m.id.slice(0, 60), label: m.label.slice(0, 80), words: m.words ?? [] }));

/** The music words of a mood the editor knows (its music prompt), or "". */
export const moodMusic = (moods: Mood[], id: string) => moods.find((m) => m.id === id)?.music ?? "";

/** editor-looks' applyMood and the mood by id, or null when the editor has no Moods. */
type Applier = { apply: (...a: unknown[]) => { seq: unknown }; byId: (id: string) => unknown };
let applierP: Promise<Applier | null> | null = null;
function moodApplier(): Promise<Applier | null> {
  const a = Object.values(applyModules)[0], m = Object.values(moodModules)[0];
  if (!a || !m) return Promise.resolve(null);
  applierP ??= Promise.all([a(), m()]).then(([am, mm]) => {
    const apply = am.applyMood, list = mm.MOODS;
    const byId = typeof mm.moodById === "function" ? mm.moodById : Array.isArray(list) ? (id: string) => list.find((x: { id?: string }) => x?.id === id) : null;
    return typeof apply === "function" && byId ? { apply: apply as Applier["apply"], byId: byId as Applier["byId"] } : null;
  }).catch(() => null);
  return applierP;
}

export function useMoodNames(): Mood[] {
  const [list, setList] = useState<Mood[]>(moodCache ?? MOOD_NAMES);
  useEffect(() => {
    const load = Object.values(moodModules)[0];
    if (!load || moodCache) return;
    let alive = true;
    load().then((m) => { const got = readMoods(m); if (got.length) { moodCache = got; if (alive) setList(got); } }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return list;
}

export function MoodSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const moods = useMoodNames();
  return (
    <Select className="h-7 text-xs" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No mood</option>
      {moods.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
    </Select>
  );
}

interface Props { host: EditorHost; open: string; onToggle: (id: string) => void; tick: string }
interface SectionProps { host: EditorHost; open: boolean; onToggle: (id: string) => void; tick: string }

export function Wave3Sections({ host, open, onToggle, tick }: Props) {
  const p = { host, onToggle, tick };
  return (
    <>
      <BrollIdeasSection {...p} open={open === "broll_ideas"} />
      <HighlightsSection {...p} open={open === "highlights"} />
      <ThumbnailSection {...p} open={open === "thumbnail"} />
      <VoiceCloneSection {...p} open={open === "voice_clone"} />
      <MoodSection {...p} open={open === "moods"} />
      {!hasVersionsPanel && <BackupsSection {...p} open={open === "backups"} />}
      {!hasCommentsPanel && <CommentsSection {...p} open={open === "comments"} />}
    </>
  );
}

const secs = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The transcript the tools read: the caption track, else the last captions made. */
function useTranscript(host: EditorHost, tick: string) {
  return useMemo(() => transcriptOf(host.sequence(), getLastCaptions()?.cues), [tick]);  // eslint-disable-line react-hooks/exhaustive-deps
}

function NeedCaptions({ host }: { host: EditorHost }) {
  return (
    <div className="space-y-1.5">
      <Note>These read what is said: make captions first (they become the transcript, with timings).</Note>
      <Button size="sm" onClick={() => captions(host, { range: [0, Math.max(1, seqEnd(host.sequence()))], language: "auto", words: false })}>
        Caption the whole sequence
      </Button>
    </div>
  );
}

// ── B-roll ideas ─────────────────────────────────────────────────────────────

function BrollIdeasSection({ host, open, onToggle, tick }: SectionProps) {
  const segs = useTranscript(host, tick);
  const [style, setStyle] = useState("");
  const [count, setCount] = useState(6);
  const [ideas, setIdeas] = useState<BrollIdea[] | null>(null);
  const [find, setFind] = useState<number | null>(null);
  const price = usePrice(host, open, () => (segs.length ? [{ tool: "broll_suggest", params: { segments: segs, style, count } }] : null), [segs.length, style, count]);
  const fps = host.sequence().fps;
  return (
    <Section id="broll_ideas" open={open} onToggle={onToggle} icon={<Lightbulb className="size-4" />} title="B-roll ideas" hint={`${segs.length} lines`}>
      {!segs.length ? <NeedCaptions host={host} /> : <Note>From the captions ({segs.length} lines). Each idea is tied to its moment; generate it or find a shot in the bin.</Note>}
      <Row label="Style"><Input className="h-7 text-xs" value={style} placeholder="warm documentary, handheld (optional)" onChange={(e) => setStyle(e.target.value)} /></Row>
      <Row label="Ideas"><Input className="h-7 text-xs" type="number" min={1} max={12} value={count} onChange={(e) => setCount(Math.max(1, Math.min(12, Number(e.target.value) || 6)))} /></Row>
      <Go label="Suggest B-roll" price={price} disabled={!segs.length} onClick={async () => { const r = await brollIdeas(host, segs, { style, count }); if (r) { setIdeas(r); setFind(null); } }} />
      {ideas && !ideas.length && <Note>No ideas came back.</Note>}
      {!!ideas?.length && (
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {ideas.map((x, i) => {
            const matches = find === i ? findInBin(host.project(), x.prompt) : [];
            return (
              <div key={i} className="space-y-1 rounded-lg border border-line p-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="mono text-2xs text-dim">{toTimecode(secondsToFrames(x.start, fps), fps)} · {Math.round(x.end - x.start)} s</span>
                </div>
                <p>{x.prompt}</p>
                {x.reason && <p className="text-2xs text-dim">{x.reason}</p>}
                <div className="flex gap-1.5">
                  <Button size="sm" variant="primary" onClick={() => broll(host, { prompt: x.prompt, quality: "saver", useFrame: false,
                    seconds: Math.max(1, Math.min(30, x.end - x.start)), at: secondsToFrames(x.start, fps) })}>Generate</Button>
                  <Button size="sm" variant="ghost" onClick={() => setFind(find === i ? null : i)}>Find in bin</Button>
                </div>
                {find === i && (matches.length ? (
                  <div className="space-y-0.5">
                    {matches.map(({ item }) => (
                      <div key={item.id} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{item.name}</span>
                        <button className="text-accent hover:underline" onClick={() => { placeIdea(host, item, x); host.toast(`${item.name} placed at ${toTimecode(secondsToFrames(x.start, fps), fps)}`, "ok"); }}>Place</button>
                      </div>
                    ))}
                  </div>
                ) : <Note>Nothing in the bin matches “{x.prompt.slice(0, 40)}…”.</Note>)}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// ── highlights → Shorts ──────────────────────────────────────────────────────

function HighlightsSection({ host, open, onToggle, tick }: SectionProps) {
  const segs = useTranscript(host, tick);
  const [target, setTarget] = useState(30);
  const [count, setCount] = useState(3);
  const [platform, setPlatform] = useState<Platform>("shorts");
  const [picks, setPicks] = useState<Highlight[] | null>(null);
  const [on, setOn] = useState<Set<number>>(new Set());
  const price = usePrice(host, open, () => (segs.length ? [{ tool: "highlights", params: { segments: segs, target_seconds: target, count, platform } }] : null),
    [segs.length, target, count, platform]);
  const chosen = (picks ?? []).filter((_, i) => on.has(i));
  return (
    <Section id="highlights" open={open} onToggle={onToggle} icon={<Scissors className="size-4" />} title="Highlights → Shorts" hint={`${segs.length} lines`}>
      {!segs.length ? <NeedCaptions host={host} /> : <Note>Picks self-contained moments with a hook from the captions. Each becomes its own 9:16 sequence (pictures fill the frame, the hook sits in the safe area).</Note>}
      <Row label={`Length ${target} s`}><input type="range" min={15} max={90} step={5} value={target} onChange={(e) => setTarget(Number(e.target.value))} className="w-full" /></Row>
      <Row label="Clips"><Segmented size="sm" value={count} onChange={setCount} options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))} /></Row>
      <Row label="For">
        <Select className="h-7 text-xs" value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
          <option value="shorts">YouTube Shorts</option><option value="reels">Instagram Reels</option><option value="tiktok">TikTok</option><option value="any">Any vertical video</option>
        </Select>
      </Row>
      <Go label="Find highlights" price={price} disabled={!segs.length}
        onClick={async () => { const r = await findHighlights(host, segs, { targetSeconds: target, count, platform }); if (r) { setPicks(r); setOn(new Set(r.map((_, i) => i))); } }} />
      {picks && !picks.length && <Note>No highlight fits that length.</Note>}
      {!!picks?.length && (
        <div className="space-y-1.5">
          {picks.map((h, i) => (
            <label key={i} className="flex items-start gap-2 rounded-lg border border-line p-2 text-xs">
              <input type="checkbox" className="mt-0.5" checked={on.has(i)} onChange={() => setOn((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })} />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block font-medium">{h.title}</span>
                <span className="mono block text-2xs text-dim">{secs(h.start)}–{secs(h.end)} · {Math.round(h.end - h.start)} s</span>
                {h.hook && <span className="block text-mute">“{h.hook}”</span>}
                {h.why && <span className="block text-2xs text-dim">{h.why}</span>}
              </span>
            </label>
          ))}
          <Go label={`Make ${chosen.length} Short${chosen.length === 1 ? "" : "s"} (9:16)`} disabled={!chosen.length}
            onClick={() => { const n = makeShorts(host, chosen); host.toast(n ? `${n} vertical sequence${n === 1 ? "" : "s"} added (Project panel)` : "Those ranges are outside the sequence", n ? "ok" : "warn"); }} />
        </div>
      )}
    </Section>
  );
}

// ── thumbnail ────────────────────────────────────────────────────────────────

function ThumbnailSection({ host, open, onToggle, tick }: SectionProps) {
  const [title, setTitle] = useState("");
  const [style, setStyle] = useState("");
  const [count, setCount] = useState(2);
  const [vertical, setVertical] = useState(false);
  const [made, setMade] = useState<MediaItem[]>([]);
  const pic = useMemo(() => pictureAtPlayhead(host), [tick]);  // eslint-disable-line react-hooks/exhaustive-deps
  const aspects: ("16:9" | "9:16")[] = vertical ? ["16:9", "9:16"] : ["16:9"];
  const price = usePrice(host, open, () => {
    const key = pic && knownKey(host, pic.part.mediaId);
    if (!pic || !key) return null;
    const isImage = host.project().media.find((m) => m.id === pic.part.mediaId)?.kind === "image";
    return [{ tool: "thumbnail", params: { ...(isImage ? { frame_key: key } : { key, at: pic.at }), title, style, count, aspects } }];
  }, [pic ? `${pic.part.mediaId}:${pic.at}:${knownKey(host, pic.part.mediaId) ?? ""}` : "", title, style, count, vertical]);
  return (
    <Section id="thumbnail" open={open} onToggle={onToggle} icon={<ImageIcon className="size-4" />} title="Thumbnail" hint={pic ? pic.part.name : "no picture"}>
      <Note>{pic ? `From the frame at the playhead (${pic.part.name}, ${pic.at.toFixed(2)} s). ` : "Put the playhead over a picture. "}The images go into the Thumbnails bin.</Note>
      <Row label="Title"><Input className="h-7 text-xs" value={title} maxLength={120} placeholder="Text on the thumbnail (optional)" onChange={(e) => setTitle(e.target.value)} /></Row>
      <Row label="Style"><Input className="h-7 text-xs" value={style} placeholder="bold, bright, close-up (optional)" onChange={(e) => setStyle(e.target.value)} /></Row>
      <Row label="Variations"><Segmented size="sm" value={count} onChange={setCount} options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))} /></Row>
      <Toggle checked={vertical} onChange={setVertical} label={<span className="text-xs">Also 9:16 (Shorts / Reels cover)</span>} />
      <Go label={`Make ${count * aspects.length} thumbnail${count * aspects.length === 1 ? "" : "s"}`} price={price} disabled={!pic}
        onClick={async () => { const r = await thumbnails(host, { title, style, count, aspects }); if (r.length) setMade(r); }} />
      {!!made.length && (
        <div className="grid grid-cols-2 gap-1.5">
          {made.map((m) => (m.url || m.thumb) && <img key={m.id} src={m.url || m.thumb} alt={m.name} title={m.name} className="w-full rounded-md border border-line object-contain" />)}
        </div>
      )}
    </Section>
  );
}

// ── clone a voice ────────────────────────────────────────────────────────────

function VoiceCloneSection({ host, open, onToggle, tick }: SectionProps) {
  const [name, setName] = useState("");
  const [consent, setConsent] = useState<number | "">("");
  const [rows, setRows] = useState<ConsentRow[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const part = useMemo(() => {
    const ps = soundParts(host.project(), host.sequence(), { clipIds: host.selection().clipIds });
    return ps.length === 1 ? ps[0] : null;
  }, [tick]);  // eslint-disable-line react-hooks/exhaustive-deps
  const load = () => voiceConsents().then((r) => { setRows(r.rows); setForbidden(r.forbidden); }).catch(() => setRows([]));
  useEffect(() => { if (open) void load(); }, [open]);  // eslint-disable-line react-hooks/exhaustive-deps
  const secsOf = part ? part.srcEnd - part.srcStart : 0;
  const price = usePrice(host, open, () => {
    const key = part && knownKey(host, part.mediaId);
    return key && part && consent && name.trim() ? [{ tool: "voice_clone", params: { sample_key: key, start: part.srcStart, end: part.srcEnd, name: name.trim(), consent_id: consent } }] : null;
  }, [part ? `${part.mediaId}:${part.srcStart}:${part.srcEnd}` : "", consent, name.trim().length > 0]);
  return (
    <Section id="voice_clone" open={open} onToggle={onToggle} icon={<Mic2 className="size-4" />} title="Clone a voice" hint={part ? part.name : "select one clip"}>
      <Note>Only with the speaker's signed consent record. The sample is the selected clip with their voice (10 s to 3 min of clean speech); the voice becomes a studio voice for voice-over and dubbing.</Note>
      <Row label="Sample">{part ? <span className="text-xs">{part.name} · {secsOf.toFixed(1)} s{secsOf < 10 ? " (too short)" : ""}</span> : <span className="text-xs text-dim">Select one clip with the voice</span>}</Row>
      <Row label="Name"><Input className="h-7 text-xs" value={name} maxLength={80} placeholder="e.g. Asha (narrator)" onChange={(e) => setName(e.target.value)} /></Row>
      <Row label="Consent">
        {forbidden ? <span className="text-xs text-dim">Only a producer can clone a voice</span> : (
          <Select className="h-7 text-xs" value={consent} onChange={(e) => setConsent(e.target.value ? Number(e.target.value) : "")}>
            <option value="">{rows === null ? "Loading…" : rows.length ? "Pick the speaker's consent" : "No voice consent on file"}</option>
            {(rows ?? []).map((r) => <option key={r.id} value={r.id}>{r.subject_name}{r.expires_on ? ` (until ${r.expires_on})` : ""}{r.scope ? ` · ${r.scope.slice(0, 40)}` : ""}</option>)}
          </Select>
        )}
      </Row>
      <p className="text-2xs text-dim">No record yet? <a href="/audit" target="_blank" rel="noreferrer" className="text-accent hover:underline">Record the speaker's consent</a> in the studio (Consent records, kind “Voice replication”), then <button className="text-accent hover:underline" onClick={() => void load()}>refresh</button>.</p>
      <Go label="Clone the voice" price={price} disabled={!part || !consent || !name.trim() || forbidden || secsOf < 10}
        onClick={() => part && consent && cloneVoice(host, part.clipId, { name: name.trim(), consentId: consent })} />
    </Section>
  );
}

// ── a mood per scene ─────────────────────────────────────────────────────────

function MoodSection({ host, open, onToggle, tick }: SectionProps) {
  const moods = useMoodNames();
  const segs = useTranscript(host, tick);
  const seq = host.sequence();
  const [studio, setStudio] = useState<SceneRange[] | null>(null);
  const [picks, setPicks] = useState<MoodPick[] | null>(null);
  const [applier, setApplier] = useState<Applier | null>(null);
  useEffect(() => { void moodApplier().then(setApplier); }, []);
  useEffect(() => {
    setStudio(null);
    const pid = host.studioProjectId(), src = seq.source;
    if (!open || !pid || !src?.eid) return;
    let alive = true;
    episodeScenes(pid, src.eid).then((r) => alive && setStudio(scenesFromEpisode(host.sequence(), r.scenes))).catch(() => alive && setStudio([]));
    return () => { alive = false; };
  }, [open, seq.id, host.studioProjectId()]);  // eslint-disable-line react-hooks/exhaustive-deps
  const scenes = useMemo(() => (studio?.length ? studio : scenesFromTimeline(host.sequence(), segs)), [studio, tick, segs]);  // eslint-disable-line react-hooks/exhaustive-deps
  const ids = moods.map((m) => m.id);
  const options = moodOptions(moods);
  const price = usePrice(host, open, () => (scenes.length ? [{ tool: "mood_suggest", params: {
    scenes: scenes.map((s) => ({ id: s.id, title: s.title, emotion: s.emotion, summary: s.summary })), moods: options } }] : null), [scenes.length, ids.join(",")]);
  const label = (id: string) => moods.find((m) => m.id === id)?.label ?? id;
  const fps = seq.fps;
  return (
    <Section id="moods" open={open} onToggle={onToggle} icon={<Palette className="size-4" />} title="Mood per scene" hint={`${scenes.length} scenes`}>
      <Note>{studio?.length ? "The studio scenes of this episode, with their emotions." : "Scenes from the markers (each runs to the next one), else the clips on V1, with the captions' words."} A mood is a look and a music feel{applier ? "" : "; the Moods panel applies the look"}.</Note>
      <Go label={`Suggest moods for ${scenes.length} scene${scenes.length === 1 ? "" : "s"}`} price={price} disabled={!scenes.length}
        onClick={async () => { const r = await suggestMoods(host, scenes, options); if (r) setPicks(r); }} />
      {!!picks?.length && (
        <div className="space-y-1.5">
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {picks.map((x, i) => {
              const sc = scenes.find((s) => s.id === x.scene_id);
              return (
                <div key={x.scene_id} className="space-y-0.5 rounded-lg border border-line p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{sc?.title ?? x.scene_id}</span>
                    {sc && <span className="mono text-2xs text-dim">{shortDuration(sc.start, fps)}</span>}
                  </div>
                  <Select className="h-7 text-xs" value={x.mood} onChange={(e) => setPicks(picks.map((y, j) => (j === i ? { ...y, mood: e.target.value } : y)))}>
                    {!ids.includes(x.mood) && <option value={x.mood}>{x.mood}</option>}
                    {moods.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </Select>
                  {x.why && <p className="text-2xs text-dim">{x.why}</p>}
                </div>
              );
            })}
          </div>
          <div className={applier ? "grid grid-cols-2 gap-1.5" : ""}>
            {applier && <Go label="Apply looks" onClick={() => { const n = applyMoodLooks(host, scenes, picks, applier.apply, applier.byId); host.toast(n ? `Moods applied to ${n} scene${n === 1 ? "" : "s"} (one undo step)` : "No clips in those scenes", n ? "ok" : "warn"); }} />}
            <Go label="Add as mood markers" onClick={() => { addMoodMarkers(host, scenes, picks.map((x) => ({ ...x, mood: label(x.mood) }))); host.toast(`${picks.length} mood markers added`, "ok"); }} />
          </div>
        </div>
      )}
    </Section>
  );
}

// ── backups ──────────────────────────────────────────────────────────────────

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function BackupsSection({ host, open, onToggle }: SectionProps) {
  const [rows, setRows] = useState<Backup[] | null>(null);
  const [local, setLocal] = useState<LocalVersion[] | null>(null);
  const [err, setErr] = useState("");
  const pid = host.studioProjectId();
  const load = async () => {
    setErr("");
    try { setRows(await listBackups(host)); } catch (e) { setErr(errMsg(e)); }
    setLocal(await localVersions(host));
  };
  useEffect(() => { if (open) void load(); }, [open, pid]);  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Section id="backups" open={open} onToggle={onToggle} icon={<Archive className="size-4" />} title="Backups" badge="studio" hint={rows ? `${rows.length} on the studio` : undefined}>
      <Note>A copy of the edit on the studio (the same content is kept once; the last 50 stay, plus one a day for 30 days). Media files stay on the PC.</Note>
      <Go label="Back up now" onClick={async () => { if (await backupNow(host)) await load(); }} />
      {err && <p className="text-2xs text-red-300">{err}</p>}
      {rows && !rows.length && <Note>No backups yet.</Note>}
      {!!rows?.length && (
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {rows.map((b) => (
            <div key={b.id} className="flex items-center gap-2 rounded-lg border border-line px-2 py-1.5 text-xs">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{b.created_at ? new Date(b.created_at).toLocaleString() : `#${b.id}`}</span>
                <span className="block truncate text-2xs text-dim">{b.device || "unknown device"} · {b.clip_count} clips · {secs(b.duration)} · {kb(b.size)}</span>
              </span>
              <a className="text-dim hover:text-ink" href={b.download_url} title="Download the .tatvamedit" download><Download className="size-3.5" /></a>
              <button className="text-dim hover:text-ink" title="Restore" onClick={() => void restoreBackup(host, b)}><RotateCcw className="size-3.5" /></button>
            </div>
          ))}
        </div>
      )}
      {local && (
        <div className="space-y-1">
          <p className="text-2xs uppercase tracking-wide text-dim">On this PC</p>
          {!local.length && <Note>No local versions yet.</Note>}
          {local.slice(0, 20).map((v) => (
            <div key={v.id} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate">{v.label || (v.modified ?? v.created ? new Date((v.modified ?? v.created)!).toLocaleString() : v.id)}</span>
              {v.size ? <span className="text-2xs text-dim">{kb(v.size)}</span> : null}
              <button className="text-dim hover:text-ink" title="Restore" onClick={() => void restoreLocal(host, v)}><RotateCcw className="size-3.5" /></button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ── timeline review comments (when the editor has no Comments panel) ─────────

function CommentsSection({ host, open, onToggle }: SectionProps) {
  const [rows, setRows] = useState<EditComment[] | null>(null);
  const [all, setAll] = useState(false);
  const [text, setText] = useState("");
  const pid = host.studioProjectId();
  const seq = host.sequence();
  const load = () => listComments(host, all).then(setRows).catch(() => setRows([]));
  useEffect(() => {
    if (!open) return;
    void load();
    const t = setInterval(() => void load(), 8000);  // others' comments come in while it's open
    return () => clearInterval(t);
  }, [open, pid, all, seq.id]);  // eslint-disable-line react-hooks/exhaustive-deps
  const open_ = (rows ?? []).filter((c) => !c.resolved).length;
  return (
    <Section id="comments" open={open} onToggle={onToggle} icon={<MessageSquare className="size-4" />} title="Review comments" badge="studio" hint={rows ? `${open_} open` : undefined}>
      <Note>Comments pinned to frames of this sequence, kept on the studio: everyone who opens this edit sees them, and @name mentions notify that teammate.</Note>
      <Textarea rows={2} value={text} placeholder={`At ${toTimecode(host.playhead(), seq.fps)}: what should change?`} onChange={(e) => setText(e.target.value)} />
      <Go label="Comment at the playhead" disabled={!text.trim()} onClick={async () => { if (await addComment(host, text.trim(), host.playhead())) { setText(""); await load(); } }} />
      <Toggle checked={all} onChange={setAll} label={<span className="text-xs">Every sequence</span>} />
      {rows && !rows.length && <Note>No comments yet.</Note>}
      {!!rows?.length && (
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {rows.map((c) => (
            <div key={c.id} className={`rounded-lg border border-line px-2 py-1.5 text-xs ${c.resolved ? "opacity-50" : ""}`}>
              <div className="flex items-center gap-2">
                <span className="mono text-2xs text-accent">{c.frame !== null ? toTimecode(c.frame, seq.fps) : c.timecode !== null ? secs(c.timecode) : "—"}</span>
                <span className="min-w-0 flex-1 truncate text-2xs text-dim">{c.user?.name ?? "Someone"}{all && c.sequence_id && c.sequence_id !== seq.id ? " · other sequence" : ""}</span>
                <label className="flex items-center gap-1 text-2xs text-dim">
                  <input type="checkbox" checked={c.resolved} onChange={() => resolveComment(c.id).then(load).catch(() => undefined)} />done
                </label>
              </div>
              <p className="whitespace-pre-wrap">{c.body}</p>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
