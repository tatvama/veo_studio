/**
 * A studio episode's cut as a Tatvam Editor sequence (docs/EDITOR.md §3 "import a studio episode"). Pure: the episode
 * (GET /api/episodes/{eid}?lang=…) and its layers (GET /api/episodes/{eid}/layers) in, first the storage keys the
 * sequence needs (episodePlan), then the sequence once those keys are media items (episodeSequence).
 *
 * The timing is backend assembler.timeline() / the timeline's layoutClips(): trims, the speed effect, transitions that
 * start the next shot that much earlier (never longer than half of either clip). Here a cut is where the next shot
 * starts and its transition is "start"-aligned at that cut, so the outgoing shot's handle plays under it: the same
 * frames as the studio render. Which sound goes where follows assembler.plan():
 *   V1  the shots (lip-sync, else voice lock, else the video take; the keyframe still when there is no video)
 *   V2+ the picture layers, then a Titles track for the shots' titles and lower thirds
 *   A1  the clips' own sound, linked to V1 (−6 dB under narration, crossfaded at transitions)
 *   A2  voice takes laid over a video (and on stills) and narration takes, in extra lanes when they overlap
 *   A3  the music bed (looped to the cut, 2 s fade at the end; ducking under voices isn't applied)
 *   A4  sound effects
 *   A5+ the layers' sound (video layers' own sound and audio layers)
 * Each shot keeps its fx (look, adjust, wheels, curves, chroma, mask, glow, flips, fades, move) as one effect of type
 * "shotfx" ({fx, kenburns}); scenes become markers.
 */
import type { Bin, EffectInstance, MediaItem, Sequence, TimelineClip, Track, Transition } from "../shared/types.ts";
import { baseClip, newTrack, secondsToFrames, uid } from "./editor-model.ts";

// ── the studio's JSON (only what the import reads) ──
export interface StudioTake { id: number; kind?: string; path: string; url?: string; duration_s?: number }
export interface StudioShot {
  id: number; order: number; code: string; scene_id?: number | null; include: boolean; duration_s: number;
  trim_in?: number; trim_out?: number; fx?: Record<string, unknown> | null;
  dialogue?: Record<string, { line?: string }[]>; effective_voice_mode?: string;
  keyframe?: StudioTake | null; video?: StudioTake | null; voice?: StudioTake | null; narration_take?: StudioTake | null;
  lipsync?: StudioTake | null; voicelock?: StudioTake | null;
  sfx_track?: { path?: string; start?: number; volume_db?: number } | null;
  overlays?: { text: string; start?: number; end?: number; kind?: string; anim?: string }[] | null;
}
export interface StudioEpisode {
  id: number; project_id: number; number: number; season?: number; title: string; settings?: Record<string, unknown> | null;
  scenes?: { id: number; order: number; title: string }[]; shots?: StudioShot[];
  music?: { id: number; path: string; duration_s?: number; selected?: boolean }[];
}
export interface StudioLayerClip {
  id: string; src: string; kind: string; name: string; start: number; in?: number; dur: number;
  x?: number; y?: number; scale?: number; opacity?: number; rotation?: number; fade_in?: number; fade_out?: number; gain_db?: number; muted?: boolean;
  keyframes?: { t: number; x?: number; y?: number; scale?: number; opacity?: number; rotation?: number }[];
}
export interface StudioLayers {
  rev?: number;
  video?: { id: string; name: string; hidden?: boolean; muted?: boolean; gain_db?: number; clips: StudioLayerClip[] }[];
  audio?: { id: string; name: string; muted?: boolean; gain_db?: number; clips: StudioLayerClip[] }[];
}

export interface EpisodeOptions {
  lang: string; primaryLanguage: string; fps: number; width: number; height: number;
  /** the project title, for names */
  project?: string;
}

export type NeedRole = "picture" | "still" | "voice" | "narration" | "sfx" | "music" | "layer";
export interface MediaNeed { key: string; role: NeedRole; name: string; kind: "video" | "audio" | "image"; seconds?: number }

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const extOf = (key: string, dflt: string) => /\.[A-Za-z0-9]{1,5}$/.exec(key)?.[0].toLowerCase() ?? dflt;
const clampSpeed = (s: number) => Math.min(4, Math.max(0.25, s || 1));

interface PlannedShot {
  shot: StudioShot; picture: StudioTake | null; still: boolean; ownAudio: boolean; gainDb: number;
  voice: StudioTake | null; narration: StudioTake | null; sfx: { key: string; start: number; gain: number } | null;
  speed: number; trimIn: number; len: number; start: number; overlap: number; transition: Record<string, unknown> | null;
}

export interface EpisodePlan { shots: PlannedShot[]; needs: MediaNeed[]; music: { key: string; seconds?: number } | null; warnings: string[] }

/** Which take, voice, effect and sound each included shot uses, its place on the cut, and every key to fetch. */
export function episodePlan(ep: StudioEpisode, layers: StudioLayers | null | undefined, o: EpisodeOptions): EpisodePlan {
  const warnings: string[] = [];
  const shots = (ep.shots ?? []).filter((s) => s.include).sort((a, b) => a.order - b.order || a.id - b.id);
  const useSfx = (ep.settings ?? {}).sfx !== false;
  const out: PlannedShot[] = [];
  let t = 0;
  let prevLen = 0;
  for (const [i, s] of shots.entries()) {
    const lines = (s.dialogue?.[o.lang] ?? []).filter((l) => l?.line);
    const vm = s.effective_voice_mode ?? "";
    const fx = (s.fx ?? {}) as Record<string, unknown>;
    const video = s.video?.path ? s.video : null;
    const voice = s.voice?.path ? s.voice : null;
    const narration = s.narration_take?.path ? s.narration_take : null;
    let picture: StudioTake | null = null;
    let still = false;
    let ownAudio = false;
    let gainDb = 0;
    let overVoice: StudioTake | null = null;
    let len: number;
    let trimIn = 0;
    let speed = 1;
    if (!video) {
      still = true;
      picture = s.keyframe?.path ? s.keyframe : null;
      if (!picture) warnings.push(`${s.code}: no video or keyframe yet (left empty)`);
      len = num(s.duration_s, 4);
      if (voice) len = Math.max(len, num(voice.duration_s) + 0.2);
      overVoice = voice;
    } else {
      const vdur = Math.max(num(video.duration_s, num(s.duration_s, 4)), 0.5);
      trimIn = Math.max(num(s.trim_in), 0);
      const dur = Math.max(vdur - trimIn - Math.max(num(s.trim_out), 0), 0.5);
      speed = clampSpeed(num(fx.speed, 1));
      len = dur / speed;
      if (lines.length && s.lipsync?.path) { picture = s.lipsync; ownAudio = true; }
      else if (lines.length && s.voicelock?.path) { picture = s.voicelock; ownAudio = true; }
      else if (lines.length && vm === "native" && o.lang === o.primaryLanguage) { picture = video; ownAudio = true; }
      else if (lines.length && voice) { picture = video; overVoice = voice; warnings.push(`${s.code}: no lip-sync for ${o.lang}: the voice is laid over the video`); }
      else { picture = video; ownAudio = true; gainDb = !lines.length && vm === "narration" ? -6 : 0; }
    }
    const tr = i > 0 ? (fx.transition as Record<string, unknown> | undefined) : undefined;
    const trOk = tr && typeof tr.type === "string" && tr.type !== "none" && tr.type !== "cut" && num(tr.duration, 0.5) > 0;
    const overlap = trOk ? Math.max(0.1, Math.min(num(tr!.duration, 0.5), len / 2, prevLen / 2)) : 0;
    t -= overlap;
    const sfx = useSfx && s.sfx_track?.path ? { key: s.sfx_track.path, start: num(s.sfx_track.start), gain: num(s.sfx_track.volume_db, -8) } : null;
    out.push({ shot: s, picture, still, ownAudio, gainDb, voice: overVoice, narration, sfx, speed, trimIn, len, start: t, overlap,
      transition: trOk ? tr! : null });
    t += len;
    prevLen = len;
  }
  const music = [...(ep.music ?? [])].filter((m) => m.path).sort((a, b) => Number(Boolean(b.selected)) - Number(Boolean(a.selected)) || b.id - a.id)[0];
  const needs: MediaNeed[] = [];
  const seen = new Set<string>();
  const need = (n: MediaNeed) => { if (!seen.has(n.key)) { seen.add(n.key); needs.push(n); } };
  for (const p of out) {
    const code = p.shot.code || `SH${p.shot.id}`;
    if (p.picture) {
      need({ key: p.picture.path, role: p.still ? "still" : "picture", kind: p.still ? "image" : "video", seconds: p.picture.duration_s,
        name: `${code}_${p.still ? "keyframe" : p.picture.kind || "video"}_${p.picture.id}${extOf(p.picture.path, p.still ? ".png" : ".mp4")}` });
    }
    if (p.voice) need({ key: p.voice.path, role: "voice", kind: "audio", seconds: p.voice.duration_s, name: `${code}_voice_${p.voice.id}${extOf(p.voice.path, ".wav")}` });
    if (p.narration) need({ key: p.narration.path, role: "narration", kind: "audio", seconds: p.narration.duration_s, name: `${code}_narration_${p.narration.id}${extOf(p.narration.path, ".wav")}` });
    if (p.sfx) need({ key: p.sfx.key, role: "sfx", kind: "audio", name: `${code}_sfx${extOf(p.sfx.key, ".wav")}` });
  }
  if (music) need({ key: music.path, role: "music", kind: "audio", seconds: music.duration_s, name: `music_${music.id}${extOf(music.path, ".mp3")}` });
  for (const tk of [...(layers?.video ?? []), ...(layers?.audio ?? [])]) {
    for (const c of tk.clips ?? []) {
      if (!c.src) continue;
      const kind = c.kind === "image" ? "image" : c.kind === "video" ? "video" : "audio";
      const base = c.src.split("/").pop() || `${c.id}${extOf(c.src, "")}`;
      need({ key: c.src, role: "layer", kind, name: base });
    }
  }
  return { shots: out, needs, music: music ? { key: music.path, seconds: music.duration_s } : null, warnings };
}

/** Lanes of one role: a clip goes on the first lane where it doesn't overlap, a new lane when none is free. */
class Lanes {
  readonly tracks: { track: Track; clips: TimelineClip[] }[] = [];
  private make: (n: number) => Track;
  constructor(make: (n: number) => Track) { this.make = make; }
  first(): Track {
    if (!this.tracks.length) this.tracks.push({ track: this.make(0), clips: [] });
    return this.tracks[0].track;
  }
  place(start: number, dur: number): { track: Track; add(c: TimelineClip): void } {
    let lane = this.tracks.find((l) => l.clips.every((c) => c.start + c.duration <= start || c.start >= start + dur));
    if (!lane) {
      lane = { track: this.make(this.tracks.length), clips: [] };
      this.tracks.push(lane);
    }
    const l = lane;
    return { track: l.track, add: (c) => l.clips.push(c) };
  }
}

function shotFx(fx: Record<string, unknown>, still: boolean): EffectInstance | null {
  const keep = Object.fromEntries(Object.entries(fx).filter(([k]) => !["transition", "speed", "reverse", "stabilize"].includes(k)));
  const move = keep.move as { kind?: string } | undefined;
  const kenburns = still && !(move && move.kind && move.kind !== "none");
  if (!Object.keys(keep).length && !kenburns) return null;
  const params: EffectInstance["params"] = { fx: { value: keep } };
  if (kenburns) params.kenburns = { value: true };
  return { id: uid("e"), type: "shotfx", enabled: true, params };
}

/**
 * The sequence (and a bin for its media) from the plan. `media(key)` is the imported item for a storage key (missing
 * keys leave their clips out, with a warning).
 */
export function episodeSequence(ep: StudioEpisode, layers: StudioLayers | null | undefined, plan: EpisodePlan, o: EpisodeOptions,
  media: (key: string) => MediaItem | undefined): { sequence: Sequence; bin: Bin; warnings: string[] } {
  const fps = o.fps;
  const F = (s: number) => secondsToFrames(s, fps);
  const warnings = [...plan.warnings];
  const season = ep.season ?? 1;
  const label = `S${String(season).padStart(2, "0")}E${String(ep.number).padStart(2, "0")}`;
  const seq: Sequence = {
    id: uid("s"), name: `${label} ${ep.title || "Episode"}`.trim(), width: o.width, height: o.height, fps, sampleRate: 48000,
    tracks: [], clips: [], transitions: [], markers: [], playhead: 0, workArea: { zoom: 0, scroll: 0 },
    source: { pid: ep.project_id, eid: ep.id, lang: o.lang },
  };
  const geo = { width: o.width, height: o.height };
  const vTrack = (name: string, over: Partial<Track> = {}) => newTrack("video", 0, { name, ...over });
  const aTrack = (name: string, over: Partial<Track> = {}) => newTrack("audio", 0, { name, ...over });
  const v1 = vTrack("V1 Shots");
  const a1 = aTrack("A1 Sound");
  const voice = new Lanes((n) => aTrack(n ? `Voice ${n + 1}` : "A2 Voice"));
  const music = aTrack("A3 Music");
  const sfx = new Lanes((n) => aTrack(n ? `SFX ${n + 1}` : "A4 SFX"));
  voice.first();
  sfx.first();
  const clips: TimelineClip[] = [];
  const transitions: Transition[] = [];
  const item = (key: string | undefined) => {
    if (!key) return undefined;
    const m = media(key);
    if (!m) warnings.push(`${key.split("/").pop()}: couldn't be fetched, so it's left out`);
    return m;
  };
  const srcFrames = (m: MediaItem, seconds: number) => Math.round(seconds * (m.fps > 0 ? m.fps : fps));

  // ── V1 / A1 ──
  const sF = plan.shots.map((p) => F(p.start));
  const total = plan.shots.length ? F(plan.shots[plan.shots.length - 1].start + plan.shots[plan.shots.length - 1].len) : 0;
  let prevV: TimelineClip | null = null;
  let prevA: TimelineClip | null = null;
  plan.shots.forEach((p, i) => {
    const start = sF[i];
    const end = i < plan.shots.length - 1 ? sF[i + 1] : total;
    const dur = Math.max(1, end - start);
    const fx = (p.shot.fx ?? {}) as Record<string, unknown>;
    const m = p.picture ? item(p.picture.path) : undefined;
    let v: TimelineClip | null = null;
    if (m) {
      v = baseClip(geo, v1, start, dur, { type: "media", mediaId: m.id, in: p.still ? 0 : srcFrames(m, p.trimIn) }, p.shot.code || m.name, m);
      v.speed = p.speed;
      v.reverse = !p.still && Boolean(fx.reverse);
      const e = shotFx(fx, p.still);
      if (e) v.effects.push(e);
      clips.push(v);
      if (p.overlap && prevV && p.transition) {
        const tr = p.transition;
        transitions.push({ id: uid("t"), trackId: v1.id, at: start, duration: Math.max(1, F(p.overlap)), alignment: "start",
          type: String(tr.type), params: (tr.params as Record<string, unknown> | undefined) ?? undefined,
          easing: (["linear", "ease_in", "ease_out", "ease_in_out"].includes(String(tr.easing)) ? tr.easing : "linear") as Transition["easing"],
          fromClipId: prevV.id, toClipId: v.id });
      }
    }
    let a: TimelineClip | null = null;
    if (m && v && p.ownAudio && m.hasAudio) {
      a = baseClip(geo, a1, start, dur, { type: "media", mediaId: m.id, in: v.source.type === "media" ? v.source.in : 0 }, p.shot.code || m.name);
      a.speed = v.speed;
      a.reverse = v.reverse;
      a.audio = { gain: { value: p.gainDb }, pan: { value: 0 }, fadeIn: F(num(fx.fade_in)), fadeOut: F(num(fx.fade_out)) };
      const link = uid("l");
      v.linkId = link;
      a.linkId = link;
      clips.push(a);
      if (p.overlap && prevA && prevA.start + prevA.duration === start) {
        transitions.push({ id: uid("t"), trackId: a1.id, at: start, duration: Math.max(1, F(p.overlap)), alignment: "start",
          type: "audio:constant_gain", easing: "linear", fromClipId: prevA.id, toClipId: a.id });
      }
    }
    prevV = v;
    prevA = a;
    // ── A2 voice / narration (cut at the shot's length on the cut, sped up with the shot like the render) ──
    for (const take of [p.voice, p.narration]) {
      if (!take) continue;
      const vm = item(take.path);
      if (!vm || !vm.hasAudio) continue;
      const secs = vm.seconds ?? (vm.fps > 0 ? vm.duration / vm.fps : num(take.duration_s));
      const d = Math.max(1, Math.min(F(secs / p.speed), F(p.len)));
      const lane = voice.place(start, d);
      const c = baseClip(geo, lane.track, start, d, { type: "media", mediaId: vm.id, in: 0 }, `${p.shot.code} ${take === p.voice ? "voice" : "narration"}`);
      c.speed = p.speed;
      clips.push(c);
      lane.add(c);
    }
    // ── A4 SFX ──
    if (p.sfx) {
      const sm = item(p.sfx.key);
      if (sm && sm.hasAudio) {
        const off = F(p.sfx.start / p.speed);
        const secs = sm.seconds ?? (sm.fps > 0 ? sm.duration / sm.fps : p.len);
        const d = Math.min(F(secs / p.speed), F(p.len) - off);
        if (d > 0) {
          const lane = sfx.place(start + off, d);
          const c = baseClip(geo, lane.track, start + off, d, { type: "media", mediaId: sm.id, in: 0 }, `${p.shot.code} SFX`);
          c.speed = p.speed;
          c.audio!.gain = { value: p.sfx.gain };
          clips.push(c);
          lane.add(c);
        }
      }
    }
  });

  // ── A3 music: looped to the cut, the last 2 s faded ──
  if (plan.music && total > 0) {
    const mm = item(plan.music.key);
    if (mm && mm.hasAudio) {
      const secs = mm.seconds ?? (mm.fps > 0 ? mm.duration / mm.fps : 0);
      const len = secs > 0.5 ? F(secs) : total;
      const vol = num((ep.settings ?? {}).music_volume_db, -16);
      let at = 0;
      let last: TimelineClip | null = null;
      while (at < total) {
        const d = Math.min(len, total - at);
        const c = baseClip(geo, music, at, d, { type: "media", mediaId: mm.id, in: 0 }, "Music");
        c.audio!.gain = { value: vol };
        clips.push(c);
        last = c;
        at += d;
      }
      if (last) last.audio!.fadeOut = Math.min(F(2), last.duration);
      if ((ep.settings ?? {}).duck !== false) warnings.push("The music isn't ducked under the voices in the edit: lower it with volume keyframes where needed");
    }
  }

  // ── V2+ picture layers, their sound, audio layers ──
  const layerV: Track[] = [];
  const layerA: Track[] = [];
  for (const tk of layers?.video ?? []) {
    const vt = vTrack(tk.name || `Layer ${layerV.length + 1}`, { hidden: Boolean(tk.hidden) });
    layerV.push(vt);
    let st: Track | null = null;
    for (const c of tk.clips ?? []) {
      const lm = item(c.src);
      if (!lm) continue;
      const start = F(num(c.start));
      const dur = Math.max(1, F(num(c.dur, 1)));
      const clip = baseClip(geo, vt, start, dur, { type: "media", mediaId: lm.id, in: lm.kind === "video" ? srcFrames(lm, num(c.in)) : 0 }, c.name || lm.name, lm);
      layerMotion(clip, c, o, lm, F);
      if (num(c.fade_in) > 0 || num(c.fade_out) > 0) {
        clip.effects.push({ id: uid("e"), type: "shotfx", enabled: true, params: { fx: { value: { ...(num(c.fade_in) > 0 ? { fade_in: num(c.fade_in) } : {}),
          ...(num(c.fade_out) > 0 ? { fade_out: num(c.fade_out) } : {}) } } } });
      }
      clips.push(clip);
      if (lm.kind === "video" && lm.hasAudio && !c.muted && !tk.muted) {
        if (!st) { st = aTrack(`${tk.name || "Layer"} sound`, { volume: num(tk.gain_db) }); layerA.push(st); }
        const a = baseClip(geo, st, start, dur, { type: "media", mediaId: lm.id, in: clip.source.type === "media" ? clip.source.in : 0 }, clip.name);
        a.audio = { gain: { value: num(c.gain_db) }, pan: { value: 0 }, fadeIn: F(num(c.fade_in)), fadeOut: F(num(c.fade_out)) };
        const link = uid("l");
        clip.linkId = link;
        a.linkId = link;
        clips.push(a);
      }
    }
  }
  for (const tk of layers?.audio ?? []) {
    const at = aTrack(tk.name || `Audio layer ${layerA.length + 1}`, { muted: Boolean(tk.muted), volume: num(tk.gain_db) });
    layerA.push(at);
    for (const c of tk.clips ?? []) {
      const lm = item(c.src);
      if (!lm) continue;
      const a = baseClip(geo, at, F(num(c.start)), Math.max(1, F(num(c.dur, 1))), { type: "media", mediaId: lm.id, in: srcFrames(lm, num(c.in)) }, c.name || lm.name);
      a.audio = { gain: { value: num(c.gain_db) }, pan: { value: 0 }, fadeIn: F(num(c.fade_in)), fadeOut: F(num(c.fade_out)) };
      clips.push(a);
    }
  }

  // ── titles and lower thirds (drawn by the engine) ──
  const titles = vTrack("Titles");
  let hasTitles = false;
  plan.shots.forEach((p, i) => {
    for (const ov of p.shot.overlays ?? []) {
      if (!ov?.text) continue;
      const a = sF[i] + F(num(ov.start));
      const b = sF[i] + F(ov.end ? num(ov.end) : p.len);
      if (b <= a) continue;
      const lower = ov.kind === "lower_third";
      const c = baseClip(geo, titles, a, b - a, { type: "title", text: {
        text: ov.text, font: "Inter Variable", size: Math.round((lower ? 52 : 96) * (Math.min(o.width, o.height) / 1080)), color: "#ffffff", weight: 700,
        align: lower ? "left" : "center", shadow: { color: "#000000aa", blur: 12, x: 0, y: 4 },
        ...(lower ? { background: { color: "#000000aa", padding: 16, radius: 8 } } : {}),
        box: lower ? [0.05, 0.74, 0.6, 0.14] : [0.1, 0.38, 0.8, 0.24], animIn: "fade", animOut: "fade" } }, ov.text.slice(0, 40));
      clips.push(c);
      hasTitles = true;
    }
  });

  // ── tracks in order, with their indexes; at least V1–V3 and A1–A4 ──
  const vids = [v1, ...layerV, ...(hasTitles ? [titles] : [])];
  while (vids.length < 3) vids.push(vTrack(`V${vids.length + 1}`));
  const auds = [a1, voice.tracks[0].track, music, sfx.tracks[0].track, ...voice.tracks.slice(1).map((l) => l.track), ...sfx.tracks.slice(1).map((l) => l.track), ...layerA];
  vids.forEach((t, i) => Object.assign(t, { index: i, targeted: i === 0 }));
  auds.forEach((t, i) => Object.assign(t, { index: i, targeted: i === 0 }));
  seq.tracks = [...vids, ...auds];
  seq.clips = clips.sort((x, y) => x.start - y.start);
  seq.transitions = transitions;

  // ── scene markers ──
  const scenes = [...(ep.scenes ?? [])].sort((a, b) => a.order - b.order);
  const colors = ["#22d3ee", "#fbbf24", "#34d399", "#fb7185", "#a78bfa", "#60a5fa"];
  for (const sc of scenes) {
    const i = plan.shots.findIndex((p) => p.shot.scene_id === sc.id);
    if (i < 0) continue;
    seq.markers.push({ id: uid("k"), frame: sF[i], duration: 0, name: `Scene ${sc.order}${sc.title ? `: ${sc.title}` : ""}`, color: colors[(sc.order - 1 + colors.length) % colors.length] });
  }
  const bin: Bin = { id: uid("b"), name: `${label} ${ep.title || ""}`.trim(), parentId: null };
  return { sequence: seq, bin, warnings };
}

/** A layer clip's place, size, opacity and rotation (with keyframes) as Motion: pixels, percent of the fitted size, 0..100. */
function layerMotion(clip: TimelineClip, c: StudioLayerClip, o: EpisodeOptions, m: MediaItem, F: (s: number) => number): void {
  const W = o.width;
  const H = o.height;
  const aspect = m.width > 0 && m.height > 0 ? m.width / m.height : W / H;
  const fittedW = Math.min(W, H * aspect);
  const pct = (scale: number) => Math.round(((scale * W) / fittedW) * 100 * 100) / 100;
  const pos = (x: number, y: number): [number, number] => [Math.round(x * W * 100) / 100, Math.round(y * H * 100) / 100];
  const x0 = num(c.x, 0.5);
  const y0 = num(c.y, 0.5);
  clip.motion.position = { value: pos(x0, y0) };
  clip.motion.scale = { value: pct(num(c.scale, 0.35)) };
  clip.motion.opacity = { value: Math.round(num(c.opacity, 1) * 100) };
  clip.motion.rotation = { value: num(c.rotation) };
  const kfs = [...(c.keyframes ?? [])].sort((a, b) => a.t - b.t);
  if (kfs.length) {
    const has = (k: "x" | "y" | "scale" | "opacity" | "rotation") => kfs.some((f) => typeof f[k] === "number");
    if (has("x") || has("y")) {
      let lx = x0;
      let ly = y0;
      clip.motion.position.keyframes = kfs.filter((f) => typeof f.x === "number" || typeof f.y === "number").map((f) => {
        lx = num(f.x, lx);
        ly = num(f.y, ly);
        return { frame: F(f.t), value: pos(lx, ly), ease: "linear" as const };
      });
    }
    if (has("scale")) clip.motion.scale.keyframes = kfs.filter((f) => typeof f.scale === "number").map((f) => ({ frame: F(f.t), value: pct(f.scale!), ease: "linear" as const }));
    if (has("opacity")) clip.motion.opacity.keyframes = kfs.filter((f) => typeof f.opacity === "number").map((f) => ({ frame: F(f.t), value: Math.round(f.opacity! * 100), ease: "linear" as const }));
    if (has("rotation")) clip.motion.rotation.keyframes = kfs.filter((f) => typeof f.rotation === "number").map((f) => ({ frame: F(f.t), value: f.rotation!, ease: "linear" as const }));
  }
}

/** Even pixel size for an aspect at a short side (backend ffmpeg.dims_for). */
export function dimsFor(aspect: string | undefined, short = 1080): { width: number; height: number } {
  if (aspect === "9:16") return { width: short, height: Math.floor((short * 16) / 9 / 2) * 2 };
  if (aspect === "1:1") return { width: short, height: short };
  return { width: Math.floor((short * 16) / 9 / 2) * 2, height: short };
}
