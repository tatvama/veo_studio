/**
 * Screen layouts' video boxes (docs/EDITOR.md §16.6). Owner: nr-layouts. Pure.
 * A clip with `slot` is placed in box `slot.index` of the layout graphic on screen at that frame (the highest graphic
 * clip whose template has "slot" layers), in the frame's ratio. When the layout changes, boxes glide from the old to
 * the new place during the new layout's in phase (layout morph); with no layout before (or after), the main picture
 * squeezes in from (or back out to) the full frame. Frames without a layout show the picture full frame.
 *
 * The holes and the pictures agree to the pixel because both come from the same pose (layouts/geometry.ts slotPose)
 * at the same progress (render/anim.ts layerTiming), with the same design space and overrides (`layoutOverrides`,
 * which the composition hands the renderer as the layout graphic's overrides).
 */
import { clipEnd } from "../model/ops.ts";
import type { EditProject, Keyframe, Param, Sequence, TimelineClip } from "../model/types.ts";
import type { GraphicClip } from "./commands.ts";
import { FULL, HIDDEN, designToFrame, placePicture, slotPose, slotProps, toFrac, type Frac, type Placement, type SlotMorph, type Space } from "./layouts/geometry.ts";
import { resolveLook } from "./looks.ts";
import { clamp01, layerTiming } from "./render/anim.ts";
import { applyOverrides, designSpace, ratioOf, shownBy, valuesOf } from "./render/layout.ts";
import { builtinTemplate } from "./templates/index.ts";
import { DESIGN } from "./templates/kit.ts";
import type { AnimStep, Box, GfxLayer, GfxRatio, GfxTemplate } from "./types.ts";

export interface SlotPlacement {
  position: Param<[number, number]>;
  scale: Param<number>;
  /** Crop effect params, % of the picture. */
  crop: { left: Param<number>; right: Param<number>; top: Param<number>; bottom: Param<number> };
  /** Motion anchor: the picture's centre (picture px). Slot clips are placed about their centre, unrotated. */
  anchor: Param<[number, number]>;
}

export const RATIOS: GfxRatio[] = ["16:9", "9:16", "1:1", "4:5"];

// ── templates and layout clips ───────────────────────────────────────────────

/** A template by id: the edit's copy first, then the built-ins. */
export const templateById = (p: EditProject, id: string): GfxTemplate | undefined => p.newsroom?.templates?.[id] ?? builtinTemplate(id);

const layoutCache = new WeakMap<GfxTemplate, boolean>();
/** True for templates with video boxes ("slot" layers) in any design. */
export function isLayout(t: GfxTemplate | undefined): boolean {
  if (!t) return false;
  let v = layoutCache.get(t);
  if (v === undefined) { v = Object.values(t.designs).some((d) => d?.layers.some((l) => l.kind === "slot")); layoutCache.set(t, v); }
  return v;
}

export interface LayoutRef { clip: GraphicClip; template: GfxTemplate; track: number }

/** Every layout graphic of a sequence on a visible video track, top track first. */
export function layoutClips(p: EditProject, seq: Sequence): LayoutRef[] {
  const tracks = new Map(seq.tracks.filter((t) => t.kind === "video" && !t.hidden).map((t) => [t.id, t.index]));
  const out: LayoutRef[] = [];
  for (const c of seq.clips) {
    if (!c.enabled || c.source.type !== "graphic" || !tracks.has(c.trackId)) continue;
    const t = templateById(p, c.source.gfx.template);
    if (isLayout(t)) out.push({ clip: c as GraphicClip, template: t!, track: tracks.get(c.trackId)! });
  }
  return out.sort((a, b) => b.track - a.track || b.clip.start - a.clip.start);
}

const showsIn = (c: GraphicClip, r: GfxRatio) => !c.source.gfx.ratios?.length || c.source.gfx.ratios.includes(r);
const covers = (c: { start: number; duration: number }, f: number) => f >= c.start && f < c.start + c.duration;

/** The layout on screen at a sequence frame in a ratio (the highest one), optionally ignoring one clip. */
export function layoutAt(p: EditProject, seq: Sequence, frame: number, ratio: GfxRatio, except?: string, list = layoutClips(p, seq)): LayoutRef | null {
  return list.find((l) => l.clip.id !== except && covers(l.clip, frame) && showsIn(l.clip, ratio)) ?? null;
}

/** A clip bound to box `index` showing at `frame` (a picture on a visible video track). */
function slotClipAt(seq: Sequence, index: number, frame: number): boolean {
  const vis = new Set(seq.tracks.filter((t) => t.kind === "video" && !t.hidden).map((t) => t.id));
  return seq.clips.some((c) => c.enabled && c.slot?.index === index && vis.has(c.trackId) && covers(c, frame));
}

// ── the boxes of a design ────────────────────────────────────────────────────

export interface SlotLayers { ratio: GfxRatio; space: Space; layers: GfxLayer[] }

/** The slot layers a layout draws in a W×H frame (design space, overrides and `when` applied). */
export function slotLayersOf(t: GfxTemplate, W: number, H: number, overrides?: Record<string, Partial<GfxLayer>>, values: Record<string, unknown> = {}): SlotLayers {
  const ds = designSpace(t, W, H);
  const vals = valuesOf(t, values as never);
  const layers = applyOverrides(ds.layers, overrides, ds.ratio).filter((l) => l.kind === "slot" && !l.hidden && shownBy(l.when, vals));
  return { ratio: ds.ratio, space: { w: ds.w, h: ds.h }, layers };
}

/** Static boxes (design px) by index of a layout clip in a ratio's standard frame, with its own overrides. */
function staticBoxes(l: LayoutRef, r: GfxRatio): { space: Space; boxes: Map<number, Box> } {
  const D = DESIGN[r];
  const sl = slotLayersOf(l.template, D.w, D.h, l.clip.source.gfx.overrides, l.clip.source.gfx.values);
  const boxes = new Map<number, Box>();
  for (const layer of sl.layers) { const i = slotProps(layer).index; if (!boxes.has(i)) boxes.set(i, layer.box); }
  return { space: sl.space, boxes };
}

export interface BoxInfo { index: number; layerId: string; box: Box; frac: Frac; label: string }
/** A layout template's boxes in a ratio (design px and fractions), by index. */
export function boxesOf(t: GfxTemplate, ratio: GfxRatio): BoxInfo[] {
  const D = DESIGN[ratio];
  const sl = slotLayersOf(t, D.w, D.h);
  const seen = new Set<number>();
  const out: BoxInfo[] = [];
  for (const l of sl.layers) {
    const sp = slotProps(l);
    if (seen.has(sp.index)) continue;
    seen.add(sp.index);
    out.push({ index: sp.index, layerId: l.id, box: l.box, frac: toFrac(l.box, sl.space), label: sp.label });
  }
  return out.sort((a, b) => a.index - b.index);
}

// ── layout morph: what each layout graphic is told about its neighbours ──────

/** Layers that are the layout's backdrop: they stay put while boxes glide (no in / out of their own). */
export const isPlate = (l: GfxLayer, space: Space) =>
  l.kind === "backdrop" || /^bg(\b|_|$)/.test(l.id) || (l.box[2] >= space.w * 0.9 && l.box[3] >= space.h * 0.9);

/**
 * A layout graphic's overrides for the renderer: its own ("Change only this one") plus the layout morph. Each slot
 * layer's `p.morph` says, per ratio, the box it glides in from (the previous layout's, or the full frame when its
 * picture was on screen before), the box it glides out to (the full frame when its picture carries on after), or
 * that it holds its box (the next layout takes over). Plates lose their in / out where a layout replaces another or a
 * box glides, so the backdrop doesn't dip. The composition passes this as the layout's `overrides`.
 */
export function layoutOverrides(p: EditProject, seq: Sequence, clip: TimelineClip, list = layoutClips(p, seq)): Record<string, Partial<GfxLayer>> | undefined {
  if (clip.source.type !== "graphic") return undefined;
  const gfx = clip.source.gfx;
  const t = templateById(p, gfx.template);
  if (!t || !isLayout(t)) return gfx.overrides;
  const me = clip as GraphicClip;
  const start = clip.start, end = clipEnd(clip);
  const morphs = new Map<string, SlotMorph>();
  let calmIn = false, calmOut = false, needIn = false, needOut = false;
  for (const r of RATIOS) {
    if (!showsIn(me, r)) continue;
    const D = DESIGN[r];
    const own = slotLayersOf(t, D.w, D.h, gfx.overrides, gfx.values);
    const prev = start > 0 ? layoutAt(p, seq, start - 1, r, clip.id, list) : null;
    const next = layoutAt(p, seq, end, r, clip.id, list);
    const pb = prev ? staticBoxes(prev, r) : null;
    const nb = next ? staticBoxes(next, r) : null;
    if (prev && clipEnd(prev.clip) <= start) calmIn = true;
    if (next && next.clip.start >= end) calmOut = true;
    for (const l of own.layers) {
      const i = slotProps(l).index;
      const m = morphs.get(l.id) ?? {};
      const fromBox = pb?.boxes.get(i);
      if (fromBox) (m.from ??= {})[r] = toFrac(fromBox, pb!.space);
      else if (!prev && start > 0 && slotClipAt(seq, i, start - 1)) (m.from ??= {})[r] = FULL;
      if (next && next.clip.start >= end) { if (nb!.boxes.has(i)) (m.hold ??= {})[r] = true; }
      else if (next) { const b = nb!.boxes.get(i); if (b) (m.to ??= {})[r] = toFrac(b, nb!.space); }
      else if (slotClipAt(seq, i, end)) (m.to ??= {})[r] = FULL;
      if (m.from) { needIn = true; calmIn = true; }
      if (m.to) { needOut = true; calmOut = true; }
      if (m.hold) calmOut = true;
      if (m.from || m.to || m.hold) morphs.set(l.id, m);
    }
  }
  if (!morphs.size && !calmIn && !calmOut) return gfx.overrides;
  const ov: Record<string, Partial<GfxLayer>> = { ...(gfx.overrides ?? {}) };
  // the layer as the template has it (first design that has it), for its animation
  const base = new Map<string, GfxLayer>();
  for (const r of RATIOS) for (const l of t.designs[r]?.layers ?? []) if (!base.has(l.id)) base.set(l.id, l);
  const animOf = (id: string) => ({ ...(base.get(id)?.anim ?? {}), ...(ov[id]?.anim ?? {}) });
  for (const [id, m] of morphs) {
    const a = animOf(id);
    const glideIn: AnimStep = { kind: "fade", delay: 0, dur: Math.max(0.3, t.timing?.in ?? 0.6) };
    const glideOut: AnimStep = { kind: "fade", delay: 0, dur: Math.max(0.25, t.timing?.out ?? 0.4) };
    const addIn = !!m.from && needIn && (!a.in || a.in.kind === "none"), addOut = !!m.to && needOut && (!a.out || a.out.kind === "none");
    ov[id] = { ...ov[id], p: { ...(ov[id]?.p ?? {}), morph: m }, ...(addIn || addOut ? { anim: { ...a, ...(addIn ? { in: glideIn } : {}), ...(addOut ? { out: glideOut } : {}) } } : {}) };
  }
  if (calmIn || calmOut) {
    for (const [id, l] of base) {
      const D = DESIGN[RATIOS.find((r) => t.designs[r]?.layers.some((x) => x.id === id)) ?? "16:9"];
      if (l.kind === "slot" || !isPlate(l, D)) continue;
      const anim = { ...animOf(id) };
      if (!(calmIn && anim.in) && !(calmOut && anim.out)) continue;
      if (calmIn) delete anim.in;
      if (calmOut) delete anim.out;
      ov[id] = { ...ov[id], anim };
    }
  }
  return ov;
}

// ── a frame's boxes ──────────────────────────────────────────────────────────

interface Resolved { ref: LayoutRef; sl: SlotLayers; look: ReturnType<typeof resolveLook> }
function resolve(p: EditProject, seq: Sequence, ref: LayoutRef, W: number, H: number, list: LayoutRef[], cache: Map<string, Resolved>): Resolved {
  let r = cache.get(ref.clip.id);
  if (!r) {
    const gfx = ref.clip.source.gfx;
    r = { ref, sl: slotLayersOf(ref.template, W, H, layoutOverrides(p, seq, ref.clip, list), gfx.values), look: resolveLook(p, gfx.look) };
    cache.set(ref.clip.id, r);
  }
  return r;
}

/** A slot layer's pose at a sequence frame (as the renderer draws it). */
function poseAt(r: Resolved, layer: GfxLayer, frame: number, fps: number) {
  const dur = Math.max(1e-3, r.ref.clip.duration / fps);
  const t = Math.max(0, Math.min(dur, (frame - r.ref.clip.start) / fps));
  const tm = layerTiming(r.ref.template, layer, dur);
  const inX = tm.in ? clamp01((t - tm.in.start) / tm.in.dur) : 1;
  const outX = tm.out ? clamp01((t - tm.out.start) / tm.out.dur) : 0;
  return { pose: slotPose(layer, inX, outX, r.sl.ratio, r.sl.space, r.look.motion), timing: tm };
}

/** Slot boxes as frame fractions [x, y, w, h] at a sequence frame for a W×H frame (`hole`: the layout is see-through there). */
export function slotsAt(p: EditProject, seq: Sequence, frame: number, W: number, H: number): { index: number; box: Box; hole: boolean }[] {
  const ratio = ratioOf(W, H);
  const list = layoutClips(p, seq);
  const ref = layoutAt(p, seq, frame, ratio, undefined, list);
  if (!ref) return [];
  const r = resolve(p, seq, ref, W, H, list, new Map());
  const seen = new Set<number>();
  const out: { index: number; box: Box; hole: boolean }[] = [];
  for (const l of r.sl.layers) {
    const sp = slotProps(l);
    if (seen.has(sp.index)) continue;
    seen.add(sp.index);
    const b = designToFrame(poseAt(r, l, frame, seq.fps).pose.box, r.sl.space, W, H);
    out.push({ index: sp.index, box: [b[0] / W, b[1] / H, b[2] / W, b[3] / H], hole: sp.hole });
  }
  return out.sort((a, b) => a.index - b.index);
}

// ── a picture's motion ───────────────────────────────────────────────────────

/** Keyframes from per-frame values: linear between neighbouring frames, held across still spans; null = constant. */
function keys<T>(frames: number[], values: T[], eq: (a: T, b: T) => boolean): Param<T> {
  type K = Keyframe<T>;
  let ks: K[] = frames.map((f, i) => ({ frame: f, value: values[i], ease: "linear" as const }));
  for (let i = 0; i < ks.length - 1; i++) if (eq(ks[i].value, ks[i + 1].value) || ks[i + 1].frame - ks[i].frame > 1) ks[i].ease = "hold";
  const out: K[] = [];
  for (const k of ks) {
    const last = out[out.length - 1];
    // a held key followed by a held key of the same value says nothing new
    if (last && last.ease === "hold" && k.ease === "hold" && eq(last.value, k.value)) continue;
    out.push({ ...k });
  }
  ks = out;
  if (ks.length <= 1 || ks.every((k) => eq(k.value, ks[0].value))) return { value: values[0] };
  ks[ks.length - 1].ease = "linear";
  return { value: ks[0].value, keyframes: ks };
}

/**
 * Motion and crop for a slot clip in a W×H frame (keyframed over the clip where layouts change or morph), for a
 * picture of pic.w × pic.h. null = no layout on screen during the clip (it keeps its own motion).
 */
export function slotMotion(p: EditProject, seq: Sequence, clip: TimelineClip, W: number, H: number, pic: { w: number; h: number }): SlotPlacement | null {
  const slot = clip.slot;
  if (!slot || !(W > 0 && H > 0)) return null;
  const ratio = ratioOf(W, H);
  const start = clip.start, end = clipEnd(clip);
  const list = layoutClips(p, seq);
  const over = list.filter((l) => showsIn(l.clip, ratio) && l.clip.start < end && clipEnd(l.clip) > start);
  if (!over.length) return null;
  const fps = seq.fps;
  const cache = new Map<string, Resolved>();
  const layerOf = (r: Resolved) => r.sl.layers.find((l) => slotProps(l).index === slot.index);
  // the frames where something can change: each layout span's first frame and every frame of a box's in / out
  const cuts = new Set<number>([start]);
  for (const l of over) for (const f of [l.clip.start, clipEnd(l.clip)]) if (f > start && f < end) cuts.add(f);
  const bounds = [...cuts].sort((a, b) => a - b);
  const frames = new Set<number>();
  for (let i = 0; i < bounds.length; i++) {
    const a = bounds[i], b = i + 1 < bounds.length ? bounds[i + 1] : end;
    frames.add(a);
    const ref = layoutAt(p, seq, a, ratio, undefined, list);
    if (!ref) continue;
    const r = resolve(p, seq, ref, W, H, list, cache);
    const layer = layerOf(r);
    if (!layer) continue;
    const { timing } = poseAt(r, layer, a, fps);
    for (const st of [timing.in, timing.out]) {
      if (!st) continue;
      const f0 = ref.clip.start + Math.floor(st.start * fps), f1 = ref.clip.start + Math.ceil((st.start + st.dur) * fps);
      for (let f = Math.max(a, f0); f <= Math.min(b - 1, f1); f++) frames.add(f);
    }
  }
  const full: Box = [0, 0, W, H];
  const stateAt = (f: number): Placement => {
    const ref = layoutAt(p, seq, f, ratio, undefined, list);
    if (!ref) return placePicture(full, pic, W, H, slot);
    const r = resolve(p, seq, ref, W, H, list, cache);
    const layer = layerOf(r);
    if (!layer) return HIDDEN(W, H);
    const { pose } = poseAt(r, layer, f, fps);
    const box = designToFrame(pose.box, r.sl.space, W, H), win = designToFrame(pose.win, r.sl.space, W, H);
    return placePicture(box, pic, W, H, slot, win, slotProps(layer).hole ? 1 : 0);
  };
  const fs = [...frames].sort((a, b) => a - b);
  const st = fs.map(stateAt);
  const rel = fs.map((f) => f - start);
  const eqN = (a: number, b: number) => Math.abs(a - b) < 1e-4;
  const eqP = (a: [number, number], b: [number, number]) => eqN(a[0], b[0]) && eqN(a[1], b[1]);
  const crop = (i: 0 | 1 | 2 | 3) => keys(rel, st.map((s) => s.crop[i]), eqN);
  const pw = pic.w > 0 ? pic.w : W, ph = pic.h > 0 ? pic.h : H;
  return {
    position: keys(rel, st.map((s) => s.position), eqP),
    scale: keys(rel, st.map((s) => s.scale), eqN),
    crop: { left: crop(0), right: crop(1), top: crop(2), bottom: crop(3) },
    anchor: { value: [pw / 2, ph / 2] },
  };
}
