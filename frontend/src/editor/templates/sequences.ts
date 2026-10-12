/**
 * The templates library (docs/EDITOR.md §10): small ready-made sequences — intros, outros, subscribe prompts and social
 * formats (Reel / Short, square, portrait with their safe areas) — made of title templates, stickers, colour mattes and
 * placeholder media slots ("Slot · Background clip", a dark matte to replace with a clip). Inserted at the playhead
 * flattened (onto new tracks) or nested (as one clip of a new sequence); a social format starts a new sequence of
 * that size, with the current sequence nested in its main slot when asked. Pure.
 */
import { newSequence } from "../model/defaults.ts";
import { addGenerated, addTrack, ctxOf, normalize, placeClips, seqEnd, tracksOf, type Ctx } from "../model/ops.ts";
import { baseClip } from "../model/defaults.ts";
import { secondsToFrames } from "../model/time.ts";
import { uid } from "../model/ids.ts";
import type { ClipSource, EditProject, EffectInstance, MediaItem, Sequence, TimelineClip, TitleSpec } from "../model/types.ts";
import { formatById, formatSize, SAFE_AREAS, type Format } from "./formats.ts";
import { STICKERS, stickerSpec, templateSpec, titleTemplate } from "./titles.ts";

export const SLOT_PREFIX = "Slot · ";
export const SLOT_COLOR = "#1f2937";
export const isSlot = (c: TimelineClip) => c.source.type === "color" && c.name.startsWith(SLOT_PREFIX);

export interface SeqField { key: string; label: string; value: string }
export interface SeqLayer {
  /** Seconds from the template's start. */
  start: number; dur: number;
  source: ClipSource; name: string;
  effects?: { type: string; params: Record<string, unknown> }[];
  /** Motion overrides: scale %, position as fractions of the frame, opacity %. */
  scale?: number; at?: [number, number]; opacity?: number;
}
export interface SeqTemplate {
  id: string; name: string; group: "Intros" | "Outros" | "Subscribe" | "Social"; seconds: number; blurb: string;
  /** Social formats make a new sequence of this format. */
  format?: Format["id"];
  fields: SeqField[];
  /** Tracks bottom → top, each a list of layers, for a W×H frame. */
  layers(f: Record<string, string>, W: number, H: number): SeqLayer[][];
}

const slot = (label: string, start: number, dur: number, extra: Partial<SeqLayer> = {}): SeqLayer =>
  ({ start, dur, source: { type: "color", color: SLOT_COLOR }, name: `${SLOT_PREFIX}${label}`, ...extra });
const matte = (color: string, start: number, dur: number, name = "Colour matte"): SeqLayer => ({ start, dur, source: { type: "color", color }, name });
const title = (tplId: string, start: number, dur: number, H: number, fields: { text?: string; sub?: string }, patch: Partial<TitleSpec> = {}): SeqLayer => {
  const t = titleTemplate(tplId);
  const spec = t ? { ...templateSpec(t, H, fields), ...patch } : { text: fields.text ?? "", font: "Inter Variable", size: 80, color: "#fff", weight: 700, align: "center" as const, box: [0.1, 0.4, 0.8, 0.2] as [number, number, number, number], ...patch };
  return { start, dur, source: { type: "title", text: spec }, name: (fields.text ?? t?.name ?? "Title").slice(0, 40) || "Title" };
};
const sticker = (id: string, start: number, dur: number, W: number, H: number, cx: number, cy: number, text?: string): SeqLayer => {
  const st = STICKERS.find((s) => s.id === id)!;
  const spec = stickerSpec(st, W, H, cx, cy);
  if (text !== undefined) spec.text = text;
  return { start, dur, source: { type: "title", text: spec }, name: st.name };
};
const box = (f: Format["id"], y: number, h: number): [number, number, number, number] => {
  const s = SAFE_AREAS[f];
  return [s.left, y, 1 - s.left - s.right, h];
};

export const SEQ_TEMPLATES: SeqTemplate[] = [
  { id: "intro.cinematic", name: "Cinematic intro", group: "Intros", seconds: 5, blurb: "A graded background clip, a tracking title and a tagline",
    fields: [{ key: "title", label: "Title", value: "The Last Light" }, { key: "tagline", label: "Tagline", value: "A Tatvam original" }],
    layers: (f, W, H) => [
      [slot("Background clip", 0, 5, { effects: [{ type: "look", params: { look: "cinematic", lut_strength: 0.8 } }, { type: "vignette", params: { size: 0.45, amount: 0.5 } }] })],
      [title("headline.cinematic.tracking", 0.4, 4.4, H, { text: f.title })],
      [title("headline.clean.fade", 1.6, 3.2, H, { text: f.tagline }, { size: Math.round(44 * H / 1080), box: [0.1, 0.6, 0.8, 0.1], weight: 400, color: "#e7e5e4" })],
    ] },
  { id: "intro.bold", name: "Bold intro", group: "Intros", seconds: 3, blurb: "A big punchy title with a burst sticker",
    fields: [{ key: "title", label: "Title", value: "Big News" }, { key: "badge", label: "Badge", value: "NEW!" }],
    layers: (f, W, H) => [
      [matte("#0b0b0f", 0, 3)],
      [title("headline.bold.pop", 0, 3, H, { text: f.title })],
      [sticker("burst", 0.4, 2.6, W, H, 0.78, 0.24, f.badge)],
    ] },
  { id: "intro.minimal", name: "Minimal intro", group: "Intros", seconds: 4, blurb: "A clean rising title over your clip",
    fields: [{ key: "title", label: "Title", value: "Summer in Goa" }, { key: "sub", label: "Sub line", value: "Episode 1" }],
    layers: (f, W, H) => [
      [slot("Background clip", 0, 4)],
      [title("chapter.underline", 0.3, 3.7, H, { text: f.title })],
      [title("headline.clean.fade", 1.2, 2.8, H, { text: f.sub }, { size: Math.round(42 * H / 1080), box: [0.1, 0.62, 0.8, 0.08], weight: 500 })],
    ] },
  { id: "outro.thanks", name: "Thanks for watching", group: "Outros", seconds: 6, blurb: "A blurred last clip, thanks and a subscribe button",
    fields: [{ key: "title", label: "Text", value: "Thanks for watching" }, { key: "sub", label: "Sub line", value: "See you in the next one" }],
    layers: (f, W, H) => [
      [slot("Last clip (blurred)", 0, 6, { effects: [{ type: "gaussian_blur", params: { radius: 14, horizontal: true, vertical: true } }, { type: "adjust", params: { exposure: -0.25 } }] })],
      [title("end.thanks", 0.3, 5.7, H, { text: f.title, sub: f.sub })],
      [title("social.subscribe.pop", 2.2, 3.8, H, { text: "SUBSCRIBE" })],
    ] },
  { id: "outro.next", name: "Watch next", group: "Outros", seconds: 8, blurb: "Two picture-in-picture slots for your next videos",
    fields: [{ key: "title", label: "Heading", value: "Watch next" }],
    layers: (f, W, H) => [
      [matte("#0f172a", 0, 8)],
      [slot("Next video 1", 0.4, 7.6, { scale: 38, at: [0.28, 0.58] })],
      [slot("Next video 2", 0.6, 7.4, { scale: 38, at: [0.72, 0.58] })],
      [title("end.next", 0, 8, H, { text: f.title, sub: "" })],
    ] },
  { id: "outro.follow", name: "Follow for more", group: "Outros", seconds: 5, blurb: "A bouncing call to follow, with your handle",
    fields: [{ key: "title", label: "Text", value: "Follow for more" }, { key: "handle", label: "Handle", value: "@tatvam" }],
    layers: (f, W, H) => [
      [slot("Background clip", 0, 5, { effects: [{ type: "adjust", params: { exposure: -0.3, saturation: -0.2 } }] })],
      [title("end.follow", 0.2, 4.8, H, { text: f.title })],
      [title("headline.clean.rise", 1, 4, H, { text: f.handle }, { size: Math.round(52 * H / 1080), box: [0.1, 0.62, 0.8, 0.1], color: "#fbbf24" })],
    ] },
  { id: "subscribe.corner", name: "Subscribe · corner", group: "Subscribe", seconds: 4, blurb: "A subscribe button and bell, bottom left",
    fields: [{ key: "label", label: "Button", value: "SUBSCRIBE" }],
    layers: (f, W, H) => [
      [title("social.subscribe.slide", 0, 4, H, { text: f.label })],
      [sticker("bell", 0.6, 3.4, W, H, 0.36, 0.83)],
    ] },
  { id: "subscribe.center", name: "Like and subscribe", group: "Subscribe", seconds: 4, blurb: "Like and subscribe buttons that pop in",
    fields: [{ key: "like", label: "Like button", value: "LIKE" }, { key: "sub", label: "Subscribe button", value: "SUBSCRIBE" }],
    layers: (f, W, H) => [
      [sticker("like", 0, 4, W, H, 0.36, 0.8, f.like)],
      [sticker("subscribe", 0.3, 3.7, W, H, 0.62, 0.8, f.sub)],
    ] },
  { id: "social.reel", name: "Reel / Short 9:16", group: "Social", seconds: 15, format: "9:16", blurb: "Vertical: a hook at the top, your clip, a closing call to follow — inside the Reels and Shorts safe area",
    fields: [{ key: "hook", label: "Hook", value: "Wait for the end…" }, { key: "cta", label: "Closing call", value: "Follow for part 2" }],
    layers: (f, W, H) => [
      [slot("Main clip", 0, 15)],
      [title("headline.bold.pop", 0, 3, H, { text: f.hook }, { box: box("9:16", 0.13, 0.12), size: Math.round(88 * H / 1920) })],
      [title("end.follow", 12.5, 2.5, H, { text: f.cta }, { box: box("9:16", 0.6, 0.12), size: Math.round(84 * H / 1920) })],
    ] },
  { id: "social.square", name: "Square post 1:1", group: "Social", seconds: 10, format: "1:1", blurb: "Square: your clip with a title band at the top",
    fields: [{ key: "title", label: "Title", value: "3 tips for better shots" }],
    layers: (f, W, H) => [
      [slot("Main clip", 0, 10)],
      [title("lower.box.wipe", 0.2, 9.8, H, { text: f.title, sub: "" }, { box: box("1:1", 0.07, 0.12), align: "center" })],
    ] },
  { id: "social.portrait", name: "Portrait post 4:5", group: "Social", seconds: 10, format: "4:5", blurb: "Portrait feed post: clip, a heading and a lower third",
    fields: [{ key: "title", label: "Heading", value: "Behind the scenes" }, { key: "name", label: "Name", value: "Asha Rao" }, { key: "role", label: "Role", value: "Director" }],
    layers: (f, W, H) => [
      [slot("Main clip", 0, 10)],
      [title("headline.clean.rise", 0.2, 4, H, { text: f.title }, { box: box("4:5", 0.08, 0.12) })],
      [title("lower.bar.slide_left", 1, 6, H, { text: f.name, sub: f.role }, { box: [0.08, 0.7, 0.6, 0.1] })],
    ] },
];
export const seqTemplate = (id: string) => SEQ_TEMPLATES.find((t) => t.id === id);

const fieldValues = (t: SeqTemplate, given: Record<string, string> = {}) => Object.fromEntries(t.fields.map((f) => [f.key, given[f.key] ?? f.value]));

function layerClip(seq: Sequence, trackId: string, at: number, l: SeqLayer): TimelineClip {
  const fps = seq.fps;
  const c = baseClip(seq, trackId, at + secondsToFrames(l.start, fps), Math.max(1, secondsToFrames(l.dur, fps)), l.source, l.name);
  if (l.effects) c.effects = l.effects.map((e): EffectInstance => ({ id: uid("e"), type: e.type, enabled: true, params: Object.fromEntries(Object.entries(e.params).map(([k, v]) => [k, { value: v }])) }));
  if (l.scale !== undefined) c.motion = { ...c.motion, scale: { value: l.scale } };
  if (l.at) c.motion = { ...c.motion, position: { value: [Math.round(l.at[0] * seq.width), Math.round(l.at[1] * seq.height)] } };
  if (l.opacity !== undefined) c.motion = { ...c.motion, opacity: { value: l.opacity } };
  return c;
}

/** A template as its own sequence (W×H of `like`, its fps), every layer on its own track. */
export function templateSequence(t: SeqTemplate, like: { width: number; height: number; fps: number }, fields?: Record<string, string>): Sequence {
  const f = fieldValues(t, fields);
  const layers = t.layers(f, like.width, like.height);
  let s = newSequence(t.name, like, { video: Math.max(1, layers.length), audio: 1 });
  const vts = tracksOf(s, "video");
  const clips = layers.flatMap((ls, i) => ls.map((l) => layerClip(s, vts[i].id, 0, l)));
  s = { ...s, clips };
  return normalize(s, ctxOf({ media: [], sequences: [s] }));
}

/**
 * Puts a template at `at` in a sequence: flattened onto new video tracks above the others (one per layer), or nested
 * (the template becomes its own sequence and one clip of it goes on a free track at the top). One command's worth.
 */
export function insertTemplate(p: EditProject, seqId: string, t: SeqTemplate, at: number, mode: "flatten" | "nest", fields?: Record<string, string>): { project: EditProject; clipIds: string[] } {
  const seq = p.sequences.find((s) => s.id === seqId);
  if (!seq) return { project: p, clipIds: [] };
  const ctx = ctxOf(p);
  if (mode === "nest") {
    const inner = templateSequence(t, seq, fields);
    const p2 = { ...p, sequences: [...p.sequences, inner] };
    const r = addTrack(seq, "video");
    const s = { ...r.seq, tracks: r.seq.tracks.map((x) => (x.id === r.trackId ? { ...x, name: t.name } : x)) };
    const c = baseClip(s, r.trackId, at, Math.max(1, secondsToFrames(t.seconds, seq.fps)), { type: "nested", sequenceId: inner.id, in: 0 }, t.name, { width: inner.width, height: inner.height });
    const placed = placeClips(s, ctxOf(p2), [c], "overwrite");
    return { project: { ...p2, sequences: p2.sequences.map((x) => (x.id === seqId ? placed : x)) }, clipIds: [c.id] };
  }
  const f = fieldValues(t, fields);
  const layers = t.layers(f, seq.width, seq.height);
  let s = seq;
  const ids: string[] = [];
  for (const ls of layers) {
    const r = addTrack(s, "video");
    s = r.seq;
    for (const l of ls) {
      const c = layerClip(s, r.trackId, at, l);
      s = placeClips(s, ctx, [c], "overwrite");
      ids.push(c.id);
    }
  }
  return { project: { ...p, sequences: p.sequences.map((x) => (x.id === seqId ? s : x)) }, clipIds: ids };
}

/**
 * A social-format template as a new sequence (the format's size for the current sequence's resolution). With
 * `nest`, the current sequence goes into the "Main clip" slot as a nested clip that fills the frame.
 */
export function socialSequence(p: EditProject, fromSeqId: string, t: SeqTemplate, opts: { nest?: boolean; fields?: Record<string, string> } = {}): { project: EditProject; sequenceId: string } {
  const from = p.sequences.find((s) => s.id === fromSeqId) ?? p.sequences[0];
  const fmt = formatById(t.format ?? "9:16")!;
  const size = formatSize(from, fmt);
  let s = templateSequence(t, { ...size, fps: from.fps }, opts.fields);
  s = { ...s, name: `${from.name} · ${t.name}` };
  if (opts.nest) {
    const main = s.clips.find((c) => isSlot(c) && c.name.endsWith("Main clip"));
    if (main) {
      const len = Math.max(main.duration, seqEnd(from));
      const k = Math.max(size.width / from.width, size.height / from.height) / Math.min(size.width / from.width, size.height / from.height);
      const nested: TimelineClip = { ...main, name: from.name, duration: len, source: { type: "nested", sequenceId: from.id, in: 0 },
        motion: { ...main.motion, scale: { value: Math.round(k * 10000) / 100 }, anchor: { value: [from.width / 2, from.height / 2] } } };
      s = { ...s, clips: s.clips.map((c) => (c.id === main.id ? nested : c)) };
    }
  }
  const p2 = { ...p, sequences: [...p.sequences, s], activeSequenceId: s.id };
  const ctx = ctxOf(p2);
  return { project: { ...p2, sequences: p2.sequences.map((x) => (x.id === s.id ? normalize(x, ctx) : x)) }, sequenceId: s.id };
}

/** Puts a media item into a slot: same place, length and effects; the slot's motion is kept. */
export function fillSlot(seq: Sequence, ctx: Ctx, clipId: string, m: MediaItem): Sequence {
  return normalize({ ...seq, clips: seq.clips.map((c) => (c.id === clipId && isSlot(c)
    ? { ...c, name: m.name, source: { type: "media" as const, mediaId: m.id, in: m.inPoint ?? 0 }, motion: { ...c.motion, anchor: { value: [(m.width || seq.width) / 2, (m.height || seq.height) / 2] as [number, number] } } }
    : c)) }, ctx);
}

export { addGenerated };
