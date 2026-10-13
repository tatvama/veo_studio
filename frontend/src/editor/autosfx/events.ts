/**
 * Auto SFX, step 1 (docs/EDITOR.md §15.2): the edit events that call for a sound, found in a sequence — transitions
 * and wipes, title and sticker animations, countdowns, punch-in jump cuts, slow-motion ramps and freezes, camera
 * shake, glitch and VHS effects, and (opt-in) strong beats. Each event says what it wants as tag preferences, never as
 * preset ids, so the SFX library can change. Pure.
 */
import { valueAt } from "../model/params.ts";
import { clipEnd, onTrack, trackById, transitionRange, tracksOf } from "../model/ops.ts";
import { rampPieces } from "../model/remap.ts";
import { isBeatMarker } from "../model/snapping.ts";
import { fpsExact } from "../model/time.ts";
import type { EditProject, EffectInstance, Marker, Sequence, TimelineClip, TitleSpec, Track } from "../model/types.ts";
import type { SfxRule } from "./types.ts";

/** One sound of an event. */
export interface SfxPart {
  /** Stable within its event ("whoosh", "impact", "in", "out", "tick3", "boom" …). */
  part: string;
  /** Tag sets in order of preference: the first set some preset has all of wins. */
  tags: string[][];
  /** Words that make a preset a better fit here (in its id, name or tags): "soft", "air" … */
  prefer?: string[];
  /** Words that make it a worse fit ("burst" for a single shutter, "large" for a ding …). */
  avoid?: string[];
  /** The sequence frame it is for. */
  hit: number;
  /** How the sound lines up with `hit`: it starts there, is centred on it, or ends on it. */
  align: "start" | "centre" | "end";
  /** Seconds the preset's `length` parameter should be (when it has one). */
  length?: number;
  /** Seconds to cut the sound at (typing bursts, ticks). */
  maxLength?: number;
  /** Wanted values by meaning ("count": keystrokes …), mapped onto whatever the preset calls them. */
  want?: { count?: number };
  /** dB relative to the intensity's level. */
  gain: number;
  /** For the preview: why this part ("at the cut", "when it covers the frame"). */
  reason: string;
}

export interface SfxEvent {
  /** "<rule>:<source>" — stable across runs (ids of clips, transitions, markers). */
  id: string;
  rule: SfxRule;
  sourceId: string;
  /** The main moment (sorting, ranges). */
  hit: number;
  parts: SfxPart[];
  /** Set when the event is known but gets no sound (a fade, a disabled clip …): shown as skipped. */
  skip?: string;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
/** A camera shake's boom: low and rumbling rather than an explosion. */
const SHAKE_BOOM = ["deep", "sub", "rumble", "low", "distant"];
const pct = (v: number) => `${Math.round(v)} %`;
const short = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ── classifying ids ──────────────────────────────────────────────────────────

/** Title in-animations that pop or scale in. */
const POP_IN = /^(pop|zoom|bounce|elastic|spin|flip|scale|grow|burst|punch)/;
/** Title animations that move, wipe or reveal. */
const SWISH_IN = /(slide|wipe|mask|reveal|rise|drop|slice|push|tracking|swipe|stroke|kinetic|sweep|roll|split|fly)/;
/** Animations with no sound of their own. */
const QUIET = /^(none|fade|blur|dissolve|opacity)$/;

export type TransitionKind = "glitch" | "tape" | "stinger" | "wipe" | "shake" | "soft" | "move";
const SOFT_XFADE = new Set(["fade", "dissolve", "fadeblack", "fadewhite", "fadegrays", "fadefast", "fadeslow", "hblur", "distance"]);
const GLITCHY = /glitch|vhs|rgb_?split|smear|static|scanline|pixel_?sort|digital|datamosh|noise|tracking/i;

/** What sort of sound a video transition gets. */
export function transitionKind(type: string): TransitionKind {
  const t = type.trim();
  const id = t.replace(/^(tv:|gl:|stinger:)/i, "");
  if (/^stinger:|(^|[:_])stinger/i.test(t)) return "stinger";
  if (/^tv:matte_/i.test(t)) return "wipe";
  if (/^tv:shake$/i.test(t)) return "shake";
  if (/^tv:tv_off$/i.test(t) || /tape_?stop|power_?off/i.test(id)) return "tape";
  if (GLITCHY.test(id)) return "glitch";
  if (SOFT_XFADE.has(id.toLowerCase()) || /^(crosswarp|dreamy|fade|luminance_melt|burn)$/i.test(id)) return "soft";
  return "move";
}

/** A video effect that is a glitch / VHS look ("vhs" for the tape-ish ones). */
export function glitchEffect(type: string): "glitch" | "vhs" | null {
  if (/^(vhs|crt|tape|vcr|analog_?tv|8mm_?glitch)/i.test(type)) return "vhs";
  if (/glitch|rgb_?split|pixel_?sort|datamosh|digital_?(noise|glitch)|chromatic_?glitch/i.test(type)) return "glitch";
  return null;
}
export const isShakeEffect = (type: string) => /shake|camera_?wobble|earthquake/i.test(type);

// ── titles: the renderer's timing (editor/render/title.ts timing()) ─────────

const LEGACY_IN: Record<string, string> = { fade: "fade", slide_up: "rise", typewriter: "typewriter", pop: "pop" };
const LEGACY_OUT: Record<string, string> = { fade: "fade", slide_down: "rise" };

export interface TitleTiming { inId: string; outId: string; inDur: number; outDur: number; chars: number }

/** A title's in / out animations and their lengths in seconds, the way render/title.ts draws them. */
export function titleTiming(s: TitleSpec, dur: number): TitleTiming {
  const text = s.karaoke?.words.length ? s.karaoke.words.map((w) => w.text).join(" ") : s.text ?? "";
  const chars = [...text.replace(/\s+/g, "")].length;
  const anim = Math.min(0.5, dur / 3);
  const typeT = Math.max(anim, Math.min(dur * 0.4, 0.04 * [...text].length));
  const plain = !s.look && !s.karaoke?.words.length && !s.shape;
  const L = s.look ?? {};
  const inId = (plain ? undefined : L.in) ?? LEGACY_IN[s.animIn ?? "none"] ?? "none";
  const outId = (plain ? undefined : L.out) ?? LEGACY_OUT[s.animOut ?? "none"] ?? "none";
  if (plain) {
    return { inId, outId, chars, inDur: inId === "none" ? 0 : inId === "typewriter" ? typeT : anim, outDur: outId === "none" ? 0 : anim };
  }
  const inDur = inId === "none" ? 0 : Math.min(dur * 0.45, L.inDur ?? (inId === "typewriter" ? typeT : anim));
  const outDur = outId === "none" ? 0 : Math.min(dur * 0.3, L.outDur ?? anim);
  return { inId, outId, inDur, outDur, chars };
}

/** The number a counter shows at t seconds (render/title.ts countAt). */
function countAt(c: { from: number; to: number }, t: number, dur: number): number {
  const k = Math.max(0, Math.min(1, t / Math.max(1e-3, dur)));
  const v = c.from + (c.to - c.from) * k;
  return c.to < c.from ? Math.max(c.to, Math.ceil(v - 1e-9)) : Math.min(c.to, Math.floor(v + 1e-9));
}

type StickerKind = "subscribe" | "like" | "bell" | "emoji" | "shape";
function stickerKind(s: TitleSpec): StickerKind | null {
  const k = s.shape?.kind;
  if (k === "subscribe" || k === "like" || k === "bell" || k === "emoji") return k;
  const tpl = s.template ?? "";
  if (/subscribe/i.test(tpl)) return "subscribe";
  if (/(^|\.)like/i.test(tpl)) return "like";
  if (/bell/i.test(tpl)) return "bell";
  if (/emoji/i.test(tpl)) return "emoji";
  if (k || /^sticker\./i.test(tpl)) return "shape";
  return null;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Speech: what the dialogue clips cover (clip role, else track role, else a dialogue-sounding track name). */
export function isDialogue(seq: Sequence, c: TimelineClip): boolean {
  const t = trackById(seq, c.trackId);
  if (!t || t.kind !== "audio") return false;
  if (c.role) return c.role === "dialogue";
  if (t.role) return t.role === "dialogue";
  return /dialog|voice|\bvo\b|speech|interview|narrat/i.test(t.name);
}

const playable = (seq: Sequence, c: TimelineClip) => {
  const t = trackById(seq, c.trackId);
  return !!t && c.enabled && !(t.kind === "video" ? t.hidden : t.muted);
};

const isCaptionTrack = (t: Track | undefined) => !!t && /caption|subtitle|subs\b/i.test(t.name);

function hasScaleChange(a: TimelineClip, b: TimelineClip): [number, number] | null {
  const sa = Number(valueAt(a.motion.scale, Math.max(0, a.duration - 1))) || 100;
  const sb = Number(valueAt(b.motion.scale, 0)) || 100;
  return Math.abs(sa / sb - 1) >= 0.03 ? [sa, sb] : null;
}

/** The first clip frame an effect is on (its first keyframe with a non-zero amount, else 0). */
function effectStart(e: EffectInstance): number {
  for (const key of ["amount", "intensity", "strength", "mix", "opacity"]) {
    const p = e.params[key];
    if (p?.keyframes?.length) {
      const k = p.keyframes.find((x) => Number(x.value) > 0);
      if (k) return Math.max(0, k.frame);
    }
  }
  return 0;
}

// ── the events ───────────────────────────────────────────────────────────────

export interface FindOptions {
  /** The fps of the sequence the times are in (nested sequences are mapped). */
  fps: number;
  /** Include beat markers. */
  beats: boolean;
  project: Pick<EditProject, "media" | "sequences">;
}

function transitionEvents(seq: Sequence, fps: number, out: SfxEvent[]) {
  const S = (f: number) => f / fps;
  for (const tr of seq.transitions) {
    const t = trackById(seq, tr.trackId);
    if (!t || t.kind !== "video" || tr.type.startsWith("audio:")) continue;
    const [a, b] = transitionRange(tr);
    const mid = Math.round((a + b) / 2);
    const secs = S(tr.duration);
    const kind = transitionKind(tr.type);
    const rule: SfxRule = kind === "stinger" || kind === "wipe" ? "stingers" : kind === "glitch" || kind === "tape" ? "glitch" : kind === "shake" ? "shake" : "transitions";
    const base = { id: `${rule}:${tr.id}`, rule, sourceId: tr.id, hit: kind === "shake" ? a : mid };
    // at a clip's edge (from or to nothing) a whoosh or a wipe has nothing to move between; a shake, a glitch or a
    // tape stop still happens
    const edge = !tr.fromClipId || !tr.toClipId;
    if (edge && kind !== "shake" && kind !== "glitch" && kind !== "tape") { out.push({ ...base, parts: [], skip: `${tr.type} at a clip's edge (a fade from or to nothing)` }); continue; }
    if (t.hidden) { out.push({ ...base, parts: [], skip: `${tr.type} is on a hidden track` }); continue; }
    const len = r1(secs + 0.2);
    const whoosh = (prefer?: string[], gain = 0): SfxPart => ({ part: "whoosh", tags: [["whoosh"], ["swish"]], prefer, hit: mid, align: "centre", length: len, gain,
      reason: `${tr.type} (${r1(secs)} s): a whoosh centred on the cut` });
    if (kind === "glitch") {
      out.push({ ...base, parts: [{ part: "glitch", tags: [["glitch"], ["static"]], hit: mid, align: "centre", length: len, gain: -2, reason: `Glitch transition ${tr.type} (${r1(secs)} s)` }] });
    } else if (kind === "tape") {
      out.push({ ...base, parts: [{ part: "tape", tags: [["tape_stop"], ["glitch"], ["static"]], hit: mid, align: "end", length: r1(secs / 2 + 0.2), gain: -2, reason: `${tr.type}: a tape stop as the picture goes off` }] });
    } else if (kind === "shake") {
      out.push({ ...base, hit: a, parts: [{ part: "boom", tags: [["boom"], ["impact"], ["sub_drop"]], prefer: SHAKE_BOOM, hit: a, align: "start", gain: 1, reason: `Camera shake transition ${tr.type}: a boom as it starts` }] });
    } else if (kind === "stinger" || kind === "wipe") {
      const cover = typeof tr.params?.cover === "number" ? Math.max(0, Math.min(1, tr.params.cover as number)) : kind === "stinger" ? 0.5 : 1;
      const at = Math.min(b - 1, Math.round(a + cover * (b - a)));
      out.push({ ...base, parts: [
        whoosh(),
        { part: "impact", tags: [["impact"], ["hit"], ["boom"]], prefer: ["soft", "light", "small", "low", "thud", "muffled"], hit: at, align: "start", gain: -4,
          reason: `${tr.type}: a soft impact when it covers the frame` },
      ] });
    } else {
      out.push({ ...base, parts: [kind === "soft" ? whoosh(["soft", "air", "gentle", "light", "breath"], -3) : whoosh()] });
    }
  }
}

function titleEvents(seq: Sequence, fps: number, out: SfxEvent[]) {
  for (const t of tracksOf(seq, "video")) {
    for (const c of onTrack(seq, t.id)) {
      if (c.source.type !== "title") continue;
      const s = c.source.text;
      const name = short(s.text || s.template || c.name || "title");
      const dur = c.duration / fps;
      const F = (sec: number) => c.start + Math.round(sec * fps);
      const tm = titleTiming(s, dur);
      const sticker = stickerKind(s);
      const count = s.look?.count;
      const rule: SfxRule = count && count.to < count.from ? "countdowns" : sticker ? "stickers" : "titles";
      const id = `${rule}:${c.id}`;
      if (!playable(seq, c)) { out.push({ id, rule, sourceId: c.id, hit: c.start, parts: [], skip: `"${name}" is disabled or on a hidden track` }); continue; }
      if (s.karaoke?.words.length || isCaptionTrack(t)) continue;          // captions: never a sound each
      const parts: SfxPart[] = [];
      let quiet = "";
      if (rule === "countdowns") {
        // a tick on every number (at most one a second), then a boom when it reaches the end ("zero")
        const D = c.duration;
        const words = s.text.replace(/#/g, "").trim();
        const what = words ? `Countdown "${short(s.text.replace(/#/g, "…"))}"` : "Countdown";
        let prev = countAt(count!, 0, dur), last = -1e9;
        const ticks: number[] = [0];
        let boom = D;
        for (let f = 1; f < D; f++) {
          const v = countAt(count!, f / fps, dur);
          if (v === prev) continue;
          prev = v;
          if (v === count!.to) { boom = f; break; }
          ticks.push(f);
        }
        for (const [i, f] of ticks.entries()) {
          if (f - last < Math.round(0.9 * fps)) continue;            // a tick a second at most (fast counters skip numbers)
          last = f;
          parts.push({ part: `tick${i}`, tags: [["tick"], ["click"], ["countdown"]], avoid: ["loop", "timer"], hit: c.start + f, align: "start", maxLength: 0.6, gain: -4,
            reason: `${what} shows ${countAt(count!, f / fps, dur)}` });
        }
        parts.push({ part: "boom", tags: [["boom"], ["impact"], ["braam"], ["sub_drop"]], prefer: ["deep", "cinematic", "trailer"], hit: c.start + Math.min(boom, D), align: "start", gain: 2,
          reason: `${what} reaches ${count!.to}` });
      } else {
        // the entrance
        if (tm.inId === "typewriter" || /type/.test(tm.inId)) {
          parts.push({ part: "in", tags: [["typing"], ["click"]], hit: c.start, align: "start", length: r1(Math.max(0.2, tm.inDur)), maxLength: tm.inDur + 0.12,
            want: { count: Math.max(1, tm.chars) }, gain: -4, reason: `"${name}" types ${tm.chars} characters in ${r1(tm.inDur)} s` });
        } else if (sticker) {
          const swish = SWISH_IN.test(tm.inId);
          parts.push(sticker === "bell"
            ? { part: "in", tags: [["ding"], ["pop"]], prefer: ["bell", "notification"], avoid: ["large", "chime", "cash", "carriage"], hit: c.start, align: "start", gain: -3, reason: `Bell sticker rings in` }
            : swish
              ? { part: "in", tags: [["swish"], ["whoosh"]], hit: c.start, align: "start", length: r1(Math.max(0.25, tm.inDur + 0.1)), gain: -3, reason: `Sticker "${name}" slides in (${tm.inId})` }
              : { part: "in", tags: [["pop"], ["click"]], avoid: ["bubbles", "message"], hit: c.start, align: "start", gain: -2, reason: `Sticker "${name}" pops in` });
          if (sticker === "subscribe" || sticker === "like") {
            const at = tm.inDur + 0.75;
            if (at < dur - 0.05) parts.push({ part: "click", tags: [["click"], ["pop"]], prefer: ["click", "tap"], avoid: ["toggle", "back", "hover", "select"], hit: F(at), align: "start", maxLength: 0.5, gain: -3, reason: `The ${sticker} button is clicked` });
          }
        } else if (tm.inId === "glitch") {
          parts.push({ part: "in", tags: [["glitch"], ["static"]], hit: c.start, align: "start", length: r1(Math.max(0.2, tm.inDur)), gain: -4, reason: `"${name}" glitches in` });
        } else if (POP_IN.test(tm.inId)) {
          parts.push({ part: "in", tags: [["pop"], ["click"]], avoid: ["bubbles", "message"], hit: c.start, align: "start", gain: -3, reason: `"${name}" ${tm.inId}s in` });
        } else if (SWISH_IN.test(tm.inId)) {
          parts.push({ part: "in", tags: [["swish"], ["whoosh"]], hit: c.start, align: "start", length: r1(Math.max(0.25, tm.inDur + 0.1)), gain: -3,
            reason: `"${name}" ${tm.inId.replace(/_/g, " ")} in (${r1(tm.inDur)} s)` });
        } else if (tm.inId !== "none") quiet = `"${name}" ${tm.inId} in: no sound for a ${tm.inId}`;
        // the exit: a reverse swish that ends with the title
        if (tm.outId !== "none" && !QUIET.test(tm.outId)) {
          const how = (s.look?.out ?? s.animOut ?? tm.outId).replace(/_/g, " ");
          parts.push({ part: "out", tags: [["reverse", "swish"], ["reverse", "whoosh"], ["reverse"], ["swish"], ["whoosh"]], hit: clipEnd(c), align: "end",
            length: r1(Math.max(0.25, tm.outDur + 0.1)), gain: -5, reason: `"${name}" ${how} out: a reverse swish` });
        }
      }
      out.push({ id, rule, sourceId: c.id, hit: parts[0]?.hit ?? c.start, parts, ...(parts.length ? {} : { skip: quiet || `"${name}" has no in or out animation` }) });
    }
  }
}

function punchInEvents(seq: Sequence, out: SfxEvent[]) {
  for (const t of tracksOf(seq, "video")) {
    const cs = onTrack(seq, t.id);
    for (let i = 1; i < cs.length; i++) {
      const a = cs[i - 1], b = cs[i];
      if (clipEnd(a) !== b.start || a.source.type !== "media" || b.source.type !== "media" || a.source.mediaId !== b.source.mediaId) continue;
      const sc = hasScaleChange(a, b);
      if (!sc) continue;
      const id = `punch_ins:${a.id}>${b.id}`;
      if (seq.transitions.some((tr) => tr.trackId === t.id && tr.fromClipId === a.id && tr.toClipId === b.id)) continue; // the transition rule has it
      if (!playable(seq, b)) continue;
      out.push({ id, rule: "punch_ins", sourceId: b.id, hit: b.start, parts: [{ part: "swish", tags: [["swish"], ["whoosh"]], prefer: ["soft", "air", "short", "light", "small"],
        hit: b.start, align: "centre", length: 0.35, gain: -6, reason: `Jump cut with a punch-in (${pct(sc[0])} → ${pct(sc[1])}) on ${short(b.name)}` }] });
    }
  }
}

function retimeEvents(seq: Sequence, fps: number, out: SfxEvent[]) {
  for (const c of seq.clips) {
    if (!c.timeRemap || trackById(seq, c.trackId)?.kind !== "video" || !playable(seq, c)) continue;
    const name = short(c.name);
    // slow motion: a ramp from about normal speed down into slow motion (riser over the ramp-in, impact at full slow)
    const ks = [...(c.timeRemap.keyframes ?? [])].sort((x, y) => x.frame - y.frame);
    for (let i = 0; i + 1 < ks.length; i++) {
      const k0 = ks[i], k1 = ks[i + 1];
      if (!(Number(k0.value) >= 80 && Number(k1.value) <= 60 && Number(k1.value) > 1)) continue;
      if (k1.frame <= 0 || k1.frame >= c.duration) continue;
      const a = c.start + Math.max(0, k0.frame), b = c.start + k1.frame;
      const len = Math.max(0.5, (b - a) / fps);
      out.push({ id: `speed_ramps:${c.id}:${k1.frame}`, rule: "speed_ramps", sourceId: c.id, hit: b, parts: [
        { part: "riser", tags: [["riser"], ["whoosh"]], hit: b, align: "end", length: r1(len), gain: -2, reason: `${name} ramps into slow motion (${Math.round(Number(k0.value))} % → ${Math.round(Number(k1.value))} %): a riser over the ramp` },
        { part: "impact", tags: [["impact"], ["boom"], ["hit"]], prefer: ["cinematic", "trailer", "boom"], hit: b, align: "start", gain: 0, reason: `${name} reaches full slow motion` },
      ] });
    }
    // freezes: a stretch of the ramp at 0 % (frame holds, a held last frame, a whole-clip frame hold)
    for (const p of rampPieces(c, { maxPieces: 64 })) {
      if (!p.freeze || p.from >= c.duration) continue;
      const at = c.start + p.from;
      out.push({ id: `freeze_frames:${c.id}:${p.from}`, rule: "freeze_frames", sourceId: c.id, hit: at, parts: [
        { part: "shutter", tags: [["shutter"], ["click"]], avoid: ["burst"], hit: at, align: "start", gain: -2, reason: `Freeze frame on ${name} (${r1((p.to - p.from) / fps)} s)` },
      ] });
    }
  }
}

function effectEvents(seq: Sequence, out: SfxEvent[]) {
  for (const t of tracksOf(seq, "video")) {
    const cs = onTrack(seq, t.id);
    cs.forEach((c, i) => {
      if (!playable(seq, c)) return;
      const prev = i > 0 && clipEnd(cs[i - 1]) === c.start ? cs[i - 1] : undefined;
      for (const e of c.effects) {
        if (!e.enabled) continue;
        const shake = isShakeEffect(e.type), gl = glitchEffect(e.type);
        if (!shake && !gl) continue;
        const rule: SfxRule = shake ? "shake" : "glitch";
        const id = `${rule}:${c.id}:${e.id}`;
        if (prev?.effects.some((x) => x.enabled && x.type === e.type)) { out.push({ id, rule, sourceId: c.id, hit: c.start, parts: [], skip: `${e.type} carries on from the clip before` }); continue; }
        const at = c.start + Math.min(c.duration - 1, effectStart(e));
        out.push({ id, rule, sourceId: c.id, hit: at, parts: [shake
          ? { part: "boom", tags: [["boom"], ["impact"], ["sub_drop"]], prefer: SHAKE_BOOM, hit: at, align: "start", gain: 1, reason: `Camera shake on ${short(c.name)}: a boom as it starts` }
          : gl === "vhs"
            ? { part: "glitch", tags: [["static"], ["glitch"], ["tape_stop"]], hit: at, align: "start", maxLength: 1.2, gain: -3, reason: `${e.type} on ${short(c.name)}: tape noise as it starts` }
            : { part: "glitch", tags: [["glitch"], ["static"]], hit: at, align: "start", maxLength: 1.2, gain: -2, reason: `${e.type} on ${short(c.name)}: a glitch as it starts` }] });
      }
    });
  }
}

/** Strong beats: the louder beats of the music under them (its waveform), else every 4th beat (the downbeats). */
function beatEvents(seq: Sequence, project: Pick<EditProject, "media">, fps: number, out: SfxEvent[]) {
  const beats = seq.markers.filter(isBeatMarker).sort((a, b) => a.frame - b.frame);
  if (!beats.length) return;
  const music = seq.clips.filter((c) => {
    const t = trackById(seq, c.trackId);
    return t?.kind === "audio" && c.source.type === "media" && (c.role ?? t.role) === "music";
  });
  const strength = (m: Marker): number | null => {
    const c = music.find((x) => x.start <= m.frame && m.frame < clipEnd(x));
    if (!c || c.source.type !== "media") return null;
    const media = project.media.find((x) => x.id === (c.source as { mediaId: string }).mediaId);
    const pk = media?.peaks;
    if (!media || !pk?.length || !(media.duration > 0)) return null;
    const srcRate = media.fps > 0 ? media.fps : fps;
    const pos = (c.source.in + ((m.frame - c.start) * c.speed * srcRate) / fps) / media.duration;
    const i = Math.round(pos * pk.length);
    let v = 0;
    for (let k = Math.max(0, i - 1); k <= Math.min(pk.length - 1, i + 1); k++) v = Math.max(v, pk[k]);
    return v;
  };
  const st = beats.map(strength);
  const known = st.filter((x): x is number => x !== null).sort((a, b) => a - b);
  const cut = known.length >= 4 ? known[Math.floor(known.length * 0.7)] : null;
  beats.forEach((m, i) => {
    const s = st[i];
    const strong = cut !== null && s !== null ? s >= cut : i % 4 === 0;
    const id = `beats:${m.id}`;
    if (!strong) return;
    out.push({ id, rule: "beats", sourceId: m.id, hit: m.frame, parts: [
      { part: "hit", tags: [["hit"], ["impact"], ["click"]], prefer: ["short", "tight", "punch"], hit: m.frame, align: "start", maxLength: 1, gain: -4,
        reason: cut !== null && s !== null ? `Strong beat (${m.name || "beat"}, ${Math.round(s * 100)} % level)` : `Downbeat (${m.name || "beat"} ${i + 1})` },
    ] });
  });
}

/** Every event of a sequence (and of the sequences nested in it, mapped onto its timeline). */
export function findEvents(seq: Sequence, o: FindOptions, depth = 0, seen: Set<string> = new Set([seq.id])): SfxEvent[] {
  const out: SfxEvent[] = [];
  transitionEvents(seq, o.fps, out);
  titleEvents(seq, o.fps, out);
  punchInEvents(seq, out);
  retimeEvents(seq, o.fps, out);
  effectEvents(seq, out);
  if (o.beats) beatEvents(seq, o.project, o.fps, out);
  // nested sequences (templates inserted nested, compound clips): their events where the clip shows them
  if (depth < 2) {
    for (const c of seq.clips) {
      if (c.source.type !== "nested" || c.multicam || trackById(seq, c.trackId)?.kind !== "video" || !playable(seq, c)) continue;
      const ns = o.project.sequences.find((x) => x.id === (c.source as { sequenceId: string }).sequenceId);
      if (!ns || seen.has(ns.id)) continue;
      const k = fpsExact(o.fps) / fpsExact(ns.fps) / (c.speed > 0 ? c.speed : 1);
      const inF = (c.source as { in: number }).in;
      const map = (f: number) => c.start + Math.round((f - inF) * k);
      const inner = findEvents(ns, { ...o, fps: ns.fps, beats: false }, depth + 1, new Set([...seen, ns.id]));
      for (const e of inner) {
        const hit = map(e.hit);
        if (hit < c.start || hit >= clipEnd(c)) continue;
        out.push({ ...e, id: `${e.id}@${c.id}`, sourceId: e.sourceId, hit,
          parts: e.parts.map((p) => ({ ...p, hit: map(p.hit), reason: `${p.reason} (in ${short(c.name, 20)})` })).filter((p) => p.hit >= c.start && p.hit <= clipEnd(c)) });
      }
    }
  }
  return out;
}

