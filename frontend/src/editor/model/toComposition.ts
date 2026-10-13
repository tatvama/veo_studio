/**
 * A sequence → the engine's Composition (docs/ENGINE.md §3) for the program monitor and the export, plus the audio
 * mix plan (`toAudioMix`) the WebAudio preview and the FFmpeg mix use. Frames become seconds (exact NTSC rates),
 * media becomes URLs, motion keyframes become layer transform keyframes, effects become `fx`, transitions on V1 become
 * main-track `transitionIn` with the clips extended into their handles.
 *
 * What the engine can't draw yet is mapped to the nearest thing it can, with a warning (`TODO(engine)` below):
 * transitions on V2+ (layers have none), motion on V1 clips (they move to a layer just above V1 instead), keyframed
 * effect parameters (the value at the clip's first frame is used), adjustment layers (left out). Titles and colour
 * mattes are pictures the editor draws itself: they come back in `generated` and editor/engine.ts hands them to the
 * engine as custom sources. Nested sequences are flattened into layers. Pure.
 */
import type { Clip as EClip, Composition, Keyframe as EKeyframe, ParamKey, ShotFx, TimePoint, Track as ETrack, Transform } from "../../engine/types.ts";
import { clipEnd, ctxOf, seqEnd, sourceRate, trimEndBy, trimStartBy, tracksOf, transitionRange, type Ctx } from "./ops.ts";
import { ease, valueAt } from "./params.ts";
import { clipSpan, hasRamp, rampPieces } from "./remap.ts";
import { fpsExact, framesToSeconds } from "./time.ts";
import type { BlendMode, EditProject, Easing, Keyframe, MediaItem, Param, Sequence, TimelineClip, TitleSpec, Transition } from "./types.ts";
import type { GfxRenderInput } from "../newsroom/render/contract.ts";
import { ratioOf } from "../newsroom/render/layout.ts";
import { renderInputFor } from "../newsroom/resolve.ts";
import { slotMotion } from "../newsroom/slots.ts";

export type GeneratedSource =
  | { kind: "title"; spec: TitleSpec; width: number; height: number; duration: number }
  | { kind: "color"; color: string; width: number; height: number }
  /** Additive (News Room, docs/EDITOR.md §16.3): a broadcast graphic drawn by editor/newsroom/render. */
  | { kind: "graphic"; input: GfxRenderInput; width: number; height: number; duration: number };

export interface CompositionOptions {
  /** URL of a media file (default: MediaItem.url). */
  urlFor?(m: MediaItem): string | undefined;
  /** look id → .cube URL. */
  lutUrl?(look: string): string | undefined;
  /** Only this range of the sequence ([from, to) frames), starting at 0 (export in → out). */
  range?: [number, number];
  pixelScale?: number;
}
export interface CompositionResult { comp: Composition; generated: Record<string, GeneratedSource>; warnings: string[] }

const ENGINE_EASE = (e: Easing | undefined) => (e === "hold" || !e || !ENGINE_KEY_EASES.has(e) ? "linear" : e) as "linear" | "ease_in" | "ease_out" | "ease_in_out";
/** Keyframe eases the engine draws itself. */
const ENGINE_KEY_EASES = new Set<string>(["linear", "ease_in", "ease_out", "ease_in_out", "hold"]);

/**
 * Keyframes the engine can draw: a segment with a "bezier", "bounce" or "elastic" ease, or a curved motion path,
 * becomes a key on every frame (every few frames on very long segments), straight between them; the rest pass as they
 * are without handles. Frame-exact at whole frames (what the export samples).
 */
export function bakeKeys<T>(p: Param<T>): Keyframe<T>[] {
  const ks = p.keyframes ?? [];
  const out: Keyframe<T>[] = [];
  for (let i = 0; i < ks.length; i++) {
    const a = ks[i], b = ks[i + 1];
    const curved = !!b && (!ENGINE_KEY_EASES.has(a.ease) || (a.ease !== "hold" && (!!a.tangentOut || !!b.tangentIn)));
    if (!curved) { out.push({ frame: a.frame, value: a.value, ease: ENGINE_KEY_EASES.has(a.ease) ? a.ease : "linear" }); continue; }
    const len = b.frame - a.frame;
    const step = Math.max(1, Math.ceil(len / 2400));
    for (let f = a.frame; f < b.frame; f += step) out.push({ frame: f, value: valueAt(p, f), ease: "linear" });
  }
  return out;
}
const FADE_TYPES = new Set(["fade", "fadeblack", "fadewhite", "fadegrays", "dissolve", "fadefast", "fadeslow", "distance"]);

/** The share of the frame width a picture of w×h takes when fitted inside W×H (Motion scale 100 %). */
export function fitWidth(w: number, h: number, W: number, H: number): number {
  if (!(w > 0 && h > 0 && W > 0 && H > 0)) return 1;
  return Math.min(1, (H * w) / (h * W));
}

interface VClip { clip: TimelineClip; seq: Sequence; ctx: Ctx; /** frames on the root sequence */ start: number; duration: number; depth: number }
interface VTrack { id: string; root: boolean; index: number; hidden: boolean; clips: VClip[] }

/** Video tracks bottom → top, nested sequences flattened into the tracks right above the nest's track. */
function videoTracks(seq: Sequence, ctx: Ctx, warn: (s: string) => void, depth = 0, offset = 0, window?: [number, number]): VTrack[] {
  const out: VTrack[] = [];
  for (const t of tracksOf(seq, "video")) {
    const main: VTrack = { id: depth ? `${t.id}@${depth}:${offset}` : t.id, root: depth === 0, index: t.index, hidden: t.hidden, clips: [] };
    const extra: VTrack[] = [];
    for (const c0 of seq.clips) {
      if (c0.trackId !== t.id || !c0.enabled) continue;
      let c = c0;
      if (window) {  // inside a nest: keep the part within the nest's window
        const [a, b] = window;
        if (clipEnd(c) <= a || c.start >= b) continue;
        const r = sourceRate(c, seq, ctx);
        if (c.start < a) c = trimStartBy(c, a - c.start, r, seq.fps);
        if (clipEnd(c) > b) c = trimEndBy(c, b - clipEnd(c), r);
      }
      const start = offset + c.start - (window?.[0] ?? 0);
      if (c.source.type === "nested") {
        const ns = ctx.sequence(c.source.sequenceId);
        if (!ns || depth > 4) { warn(`Nested sequence of "${c.name}" is missing`); continue; }
        if (c.speed !== 1 || fpsExact(ns.fps) !== fpsExact(seq.fps)) warn(`TODO(engine): "${c.name}" is a nested sequence at another speed or frame rate; shown at 100 %`);
        if (!motionIsDefault(c, seq)) warn(`TODO(engine): motion and opacity on the nested clip "${c.name}" aren't applied yet`);
        const inner = videoTracks(ns, ctx, warn, depth + 1, start, [Math.round(c.source.in), Math.round(c.source.in) + c.duration]);
        extra.push(...inner);
        continue;
      }
      main.clips.push({ clip: c, seq, ctx, start, duration: c.duration, depth });
    }
    out.push(main, ...extra);
  }
  return out;
}

const isDefaultPair = (p: Param<[number, number]>, v: [number, number]) => !p.keyframes?.length && Math.abs(p.value[0] - v[0]) < 0.01 && Math.abs(p.value[1] - v[1]) < 0.01;
const isStatic = (p: Param<number>, v: number) => !p.keyframes?.length && Math.abs(p.value - v) < 1e-6;

function picSize(c: TimelineClip, ctx: Ctx, seq: Sequence): { w: number; h: number } {
  if (c.source.type === "media") {
    const m = ctx.media(c.source.mediaId);
    if (m && m.width > 0 && m.height > 0) return { w: m.width, h: m.height };
  }
  // a nested clip's picture is its sequence (its anchor is in that sequence's pixels)
  if (c.source.type === "nested") {
    const ns = ctx.sequence(c.source.sequenceId);
    if (ns) return { w: ns.width, h: ns.height };
  }
  return { w: seq.width, h: seq.height };
}

export function motionIsDefault(c: TimelineClip, seq: Sequence, ctx?: Ctx): boolean {
  const m = c.motion;
  const pic = ctx ? picSize(c, ctx, seq) : { w: 0, h: 0 };
  const anchorOk = !m.anchor.keyframes?.length && (!ctx || (Math.abs(m.anchor.value[0] - pic.w / 2) < 0.5 && Math.abs(m.anchor.value[1] - pic.h / 2) < 0.5));
  return isDefaultPair(m.position, [seq.width / 2, seq.height / 2]) && isStatic(m.scale, 100) && isStatic(m.rotation, 0) && anchorOk
    && isStatic(m.opacity, 100) && m.blend === "normal";
}

/** Engine keyframes for one property: a hold keyframe gets a twin just before the next one. */
function kfs(p: Param<number>, key: "scale" | "rotation" | "opacity", fps: number, map: (v: number) => number): EKeyframe[] {
  const out: EKeyframe[] = [];
  const ks = bakeKeys(p);
  ks.forEach((k, i) => {
    out.push({ t: framesToSeconds(k.frame, fps), [key]: map(k.value), easing: ENGINE_EASE(k.ease) });
    if (k.ease === "hold" && ks[i + 1]) out.push({ t: framesToSeconds(ks[i + 1].frame, fps) - 1e-4, [key]: map(k.value), easing: "linear" });
  });
  return out;
}
function kfsPos(p: Param<[number, number]>, fps: number, map: (v: [number, number]) => [number, number]): EKeyframe[] {
  const out: EKeyframe[] = [];
  const ks = bakeKeys(p);
  ks.forEach((k, i) => {
    const [x, y] = map(k.value);
    out.push({ t: framesToSeconds(k.frame, fps), x, y, easing: ENGINE_EASE(k.ease) });
    if (k.ease === "hold" && ks[i + 1]) out.push({ t: framesToSeconds(ks[i + 1].frame, fps) - 1e-4, x, y, easing: "linear" });
  });
  return out;
}

/** Motion → the engine's layer transform (centre 0..1, scale = share of the frame width, degrees, opacity 0..1). */
export function layerTransform(c: TimelineClip, seq: Sequence, ctx: Ctx, root: Sequence, warn: (s: string) => void, offsetFrames = 0): Transform {
  const W = root.width, H = root.height, fps = root.fps;
  const pic = picSize(c, ctx, seq);
  const fit = fitWidth(pic.w, pic.h, W, H);
  const m = c.motion;
  const sx = W / seq.width, sy = H / seq.height;  // a nested sequence's pixels → the root's
  // the anchor: Premiere puts the anchor at the position; the engine draws about the picture's centre
  const pxScale = (fit * W) / pic.w;
  const anchorOff = (s: number, rot: number): [number, number] => {
    const ax = (m.anchor.value[0] - pic.w / 2) * pxScale * (s / 100), ay = (m.anchor.value[1] - pic.h / 2) * pxScale * (s / 100);
    const r = (rot * Math.PI) / 180;
    return [ax * Math.cos(r) - ay * Math.sin(r), ax * Math.sin(r) + ay * Math.cos(r)];
  };
  if (m.anchor.keyframes?.length) warn(`TODO(engine): anchor point keyframes on "${c.name}" aren't applied (the first value is used)`);
  const s0 = valueAt(m.scale, 0), r0 = valueAt(m.rotation, 0);
  const off = anchorOff(s0, r0);
  if ((off[0] || off[1]) && (m.scale.keyframes?.length || m.rotation.keyframes?.length)) warn(`TODO(engine): "${c.name}" scales or turns about a moved anchor point; it is drawn about its centre while animating`);
  const pos = (v: [number, number]): [number, number] => [(v[0] * sx - off[0]) / W, (v[1] * sy - off[1]) / H];
  const [x, y] = pos(m.position.value);
  const tr: Transform = { x, y, scale: (fit * m.scale.value) / 100, rotation: m.rotation.value, opacity: Math.max(0, Math.min(1, m.opacity.value / 100)) };
  const shift = (k: EKeyframe): EKeyframe => ({ ...k, t: k.t + framesToSeconds(offsetFrames, fps) });
  const keys = [
    ...kfsPos(m.position, seq.fps, pos),
    ...kfs(m.scale, "scale", seq.fps, (v) => (fit * v) / 100),
    ...kfs(m.rotation, "rotation", seq.fps, (v) => v),
    ...kfs(m.opacity, "opacity", seq.fps, (v) => Math.max(0, Math.min(1, v / 100))),
  ].map(offsetFrames ? shift : (k) => k).sort((a, b) => a.t - b.t);
  if (keys.length) tr.keyframes = keys;
  return tr;
}

/** EffectInstances → ShotFx (+ the camera move). Keyframed params use their first value (TODO(engine)). */
/** The keys of a studio shot's fx the engine draws per clip (speed / reverse / transition live on the clip). */
const SHOT_FX_KEYS = ["look", "lut_strength", "adjust", "flip_h", "flip_v", "wheels", "curves", "chroma", "mask", "glow", "fade_in", "fade_out"] as const;

export function effectsToFx(c: TimelineClip, warn: (s: string) => void): { fx: ShotFx; move?: EClip["move"]; kenburns?: boolean } {
  const fx: ShotFx = {};
  let move: EClip["move"];
  let kenburns: boolean | undefined;
  const val = (e: TimelineClip["effects"][number], k: string) => {
    const p = e.params[k];
    if (!p) return undefined;
    if (p.keyframes?.length) warn(`TODO(engine): keyframes on ${e.type}.${k} ("${c.name}") aren't animated yet; the first value is used`);
    return valueAt(p, 0) as never;
  };
  const types = new Set<string>();
  for (const e of c.effects) {
    if (!e.enabled) continue;
    if (types.has(e.type)) warn(`"${c.name}" has ${e.type} twice; the engine applies one, the last wins`);
    types.add(e.type);
    switch (e.type) {
      case "look": fx.look = val(e, "look"); if (e.params.lut_strength) fx.lut_strength = val(e, "lut_strength"); break;
      case "adjust": fx.adjust = Object.fromEntries(Object.keys(e.params).map((k) => [k, val(e, k)]).filter(([, v]) => typeof v === "number" && v !== 0)); break;
      case "wheels": fx.wheels = { lift: val(e, "lift"), gamma: val(e, "gamma"), gain: val(e, "gain") }; break;
      case "curves": fx.curves = Object.fromEntries(["master", "r", "g", "b"].filter((k) => e.params[k]).map((k) => [k, val(e, k)])); break;
      case "chroma": fx.chroma = { color: val(e, "color") ?? "#00ff00", similarity: val(e, "similarity") ?? 0.3, smoothness: val(e, "smoothness") ?? 0.1, spill: val(e, "spill") ?? 0.3 }; break;
      case "mask": fx.mask = { shape: val(e, "shape") ?? "rect", x: val(e, "x") ?? 0.5, y: val(e, "y") ?? 0.5, w: val(e, "w") ?? 0.5, h: val(e, "h") ?? 0.5,
        rotation: val(e, "rotation") ?? 0, feather: val(e, "feather") ?? 0, invert: !!val(e, "invert") }; break;
      case "glow": fx.glow = { amount: val(e, "amount") ?? 0.5, threshold: val(e, "threshold") ?? 0.7, radius: val(e, "radius") ?? 0.3 }; break;
      case "flip": fx.flip_h = !!val(e, "flip_h"); fx.flip_v = !!val(e, "flip_v"); break;
      case "move": { const kind = val(e, "kind") ?? "none"; if (kind !== "none") move = { kind, amount: val(e, "amount") ?? 0.12 }; break; }
      case "fade": { const fi = val(e, "fade_in"), fo = val(e, "fade_out"); if (fi) fx.fade_in = fi; if (fo) fx.fade_out = fo; break; }
      case "shotfx": {
        // a studio shot's whole fx, kept as one effect by importEpisode
        const sf = (val(e, "fx") ?? {}) as ShotFx;
        for (const k of SHOT_FX_KEYS) if (sf[k] !== undefined) (fx as Record<string, unknown>)[k] = sf[k];
        if (sf.move && sf.move.kind !== "none") move = { ...sf.move };
        if (val(e, "kenburns")) kenburns = true;
        break;
      }
      default:
        if (e.type.startsWith("audio:")) break;
        warn(`TODO(engine): the "${e.type}" effect on "${c.name}" isn't drawn yet`);
    }
    if (e.mask && !fx.mask) fx.mask = { ...e.mask };
  }
  return { fx, move, kenburns };
}

function mediaFor(c: TimelineClip, ctx: Ctx, seq: Sequence, opts: CompositionOptions, gen: Record<string, GeneratedSource>, root: Sequence, warn: (s: string) => void):
  { media: EClip["media"]; in: number } | null {
  const s = c.source;
  if (s.type === "media") {
    const m = ctx.media(s.mediaId);
    if (!m) { warn(`"${c.name}": its media isn't in the project`); return null; }
    if (m.kind === "audio") return null;
    const url = opts.urlFor ? opts.urlFor(m) : m.url;
    if (!url) { warn(`"${c.name}": ${m.missing || m.offline ? "media offline" : "no URL for its media yet"}`); return null; }
    const f = m.fps > 0 ? m.fps : seq.fps;
    return { media: { url, kind: m.kind === "image" ? "image" : "video", width: m.width || undefined, height: m.height || undefined, duration: m.duration > 0 ? framesToSeconds(m.duration, f) : undefined },
      in: framesToSeconds(s.in, f) };
  }
  if (s.type === "title") {
    const url = `gen:title:${c.id}`;
    gen[url] = { kind: "title", spec: s.text, width: root.width, height: root.height, duration: framesToSeconds(c.duration, seq.fps) };
    return { media: { url, kind: "video", width: root.width, height: root.height, duration: framesToSeconds(c.duration, seq.fps) }, in: 0 };
  }
  if (s.type === "color") {
    const url = `gen:color:${s.color}`;
    gen[url] = { kind: "color", color: s.color, width: root.width, height: root.height };
    return { media: { url, kind: "image", width: root.width, height: root.height }, in: 0 };
  }
  if (s.type === "adjustment") { warn(`TODO(engine): adjustment layer "${c.name}" isn't drawn yet (effects on everything below)`); return null; }
  return null;
}

// ── News Room (docs/EDITOR.md §16.3, §16.6) ──────────────────────────────────

/**
 * A graphic clip as a generated picture at `gen:gfx:<path><clipId>` (W×H, the clip's length); null when its template
 * is missing or its `ratios` leave this frame's ratio out.
 */
function graphicMedia(project: EditProject, seq: Sequence, c: TimelineClip, opts: CompositionOptions, gen: Record<string, GeneratedSource>,
  url: string, W: number, H: number, warn: (s: string) => void): { media: EClip["media"]; in: number } | null {
  if (c.source.type !== "graphic") return null;
  const ratios = c.source.gfx.ratios;
  if (ratios?.length && !ratios.includes(ratioOf(W, H))) return null;
  const input = renderInputFor(project, seq, c, { urlFor: opts.urlFor, width: W, height: H });
  if (!input) { warn(`"${c.name}": its graphic template isn't in this edit`); return null; }
  const duration = framesToSeconds(c.duration, seq.fps);
  gen[url] = { kind: "graphic", input, width: W, height: H, duration };
  return { media: { url, kind: "video", width: W, height: H, duration }, in: 0 };
}

/** A clip in a screen layout's box (`slot`): its motion and a crop effect come from the layout on screen (slotMotion). */
export function slotted(project: EditProject, seq: Sequence, c: TimelineClip, ctx: Ctx, place: typeof slotMotion = slotMotion): TimelineClip {
  if (!c.slot || !project.newsroom) return c;
  const m = c.source.type === "media" ? ctx.media(c.source.mediaId) : undefined;
  const pic = m && m.width > 0 && m.height > 0 ? { w: m.width, h: m.height } : { w: seq.width, h: seq.height };
  const pl = place(project, seq, c, seq.width, seq.height, pic);
  if (!pl) return c;
  const crop = { id: `${c.id}~slotcrop`, type: "crop", enabled: true, params: { left: pl.crop.left, right: pl.crop.right, top: pl.crop.top, bottom: pl.crop.bottom } as Record<string, Param<unknown>> };
  return { ...c, motion: { ...c.motion, position: pl.position, scale: pl.scale, anchor: pl.anchor ?? { value: [pic.w / 2, pic.h / 2] }, rotation: { value: 0 } },
    effects: [...c.effects.filter((e) => e.type !== "crop"), crop] };
}

/** Transitions of one track by clip id: {in: the one ending at the clip's start, out: at its end}. */
function transitionsByClip(seq: Sequence, trackId: string) {
  const into = new Map<string, Transition>(), outOf = new Map<string, Transition>();
  for (const t of seq.transitions) {
    if (t.trackId !== trackId) continue;
    if (t.toClipId) into.set(t.toClipId, t);
    if (t.fromClipId) outOf.set(t.fromClipId, t);
  }
  return { into, outOf };
}

/** The preset looks' LUTs as the studio server bakes them (GET /api/fx/looks/{look}.cube); imported LUTs need their own URL. */
export const defaultLutUrl = (look: string) => (look.startsWith("lut:") ? undefined : `/api/fx/looks/${encodeURIComponent(look)}.cube`);

/**
 * LUT URLs for a sequence: the caller's, else for "lut:<id>" the edit's imported LUT (its runtime url) or the studio
 * project's team LUT (sequences imported from an episode know their studio project), else a preset look's.
 */
function lutResolver(project: EditProject, seq: Sequence | undefined, given?: (look: string) => string | undefined) {
  return (look: string): string | undefined => {
    const u = given?.(look);
    if (u) return u;
    if (!look.startsWith("lut:")) return defaultLutUrl(look);
    const id = look.slice(4);
    const mine = project.luts?.find((l) => l.id === id)?.url;
    if (mine) return mine;
    const pid = seq?.source?.pid ?? project.studioProjectId;
    return pid ? `/media/projects/${pid}/luts/${encodeURIComponent(id)}.cube` : undefined;
  };
}

export function toComposition(project: EditProject, sequenceId: string, opts: CompositionOptions = {}): CompositionResult {
  opts = { ...opts, lutUrl: lutResolver(project, project.sequences.find((s) => s.id === sequenceId), opts.lutUrl) };
  const root = project.sequences.find((s) => s.id === sequenceId);
  if (!root) throw new Error(`No sequence ${sequenceId}`);
  const ctx = ctxOf(project);
  const warnings: string[] = [];
  const warn = (s: string) => { if (!warnings.includes(s)) warnings.push(s); };
  const gen: Record<string, GeneratedSource> = {};
  const fps = root.fps;
  const sec = (f: number) => framesToSeconds(f, fps);
  const vts = videoTracks(root, ctx, warn);
  const tracks: ETrack[] = [];
  const looks = new Set<string>();

  for (const vt of vts) {
    const isMain = vt.root && vt.index === 0;
    const trMap = vt.root ? transitionsByClip(root, vt.id) : { into: new Map<string, Transition>(), outOf: new Map<string, Transition>() };
    if (!vt.root && vt.clips.length && vt.clips.some((v) => v.seq.transitions.some((t) => t.toClipId === v.clip.id || t.fromClipId === v.clip.id))) {
      warn("TODO(engine): transitions inside nested sequences aren't drawn yet");
    }
    const main: EClip[] = [];
    const layers = new Map<BlendMode, EClip[]>();
    for (const v of vt.clips) {
      const c = slotted(project, v.seq, v.clip, v.ctx);
      const md = c.source.type === "graphic"
        ? graphicMedia(project, v.seq, c, opts, gen, `gen:gfx:${v.seq.id === root.id ? "" : `${v.seq.id}/`}${c.id}`, root.width, root.height, warn)
        : mediaFor(c, v.ctx, v.seq, opts, gen, root, warn);
      if (!md) continue;
      const { fx, move, kenburns } = effectsToFx(c, warn);
      if (fx.look && fx.look !== "none") looks.add(fx.look);
      // source seconds per sequence second is the clip's speed whatever the two frame rates are
      const speed = c.speed > 0 ? c.speed : 1;
      const ec: EClip = {
        id: c.id, media: md.media, start: sec(v.start), duration: sec(v.duration), in: md.in, speed, fit: "contain", fx, label: c.name,
      };
      if (c.reverse) ec.reverse = true;
      if (move) ec.move = move;
      if (kenburns && md.media.kind === "image") ec.kenburns = true;
      // edge transitions (fade from / to nothing) and V1 cuts
      const tin = trMap.into.get(c.id), tout = trMap.outOf.get(c.id);
      if (tin && !tin.fromClipId) { ec.fx = { ...ec.fx, fade_in: sec(tin.duration) }; if (!FADE_TYPES.has(tin.type)) warn(`"${tin.type}" at the start of "${c.name}" is shown as a fade (nothing comes before it)`); }
      if (tout && !tout.toClipId) { ec.fx = { ...ec.fx, fade_out: sec(tout.duration) }; if (!FADE_TYPES.has(tout.type)) warn(`"${tout.type}" at the end of "${c.name}" is shown as a fade`); }
      const plain = motionIsDefault(c, v.seq, v.ctx) && c.source.type !== "title";
      if (isMain && plain) {
        main.push(ec);
      } else {
        if (isMain && (tin?.fromClipId || tout?.toClipId)) warn(`TODO(engine): "${c.name}" has motion or opacity, so it is drawn as a layer above V1 and its V1 transition is left out`);
        else if (!isMain && ((tin && tin.fromClipId) || (tout && tout.toClipId))) warn("TODO(engine): transitions on V2 and above aren't drawn yet (layers have none)");
        ec.transform = layerTransform(c, v.seq, v.ctx, root, warn, 0);
        const b = c.motion.blend;
        if (!layers.has(b)) layers.set(b, []);
        layers.get(b)!.push(ec);
      }
    }
    // V1 cuts with a transition: the incoming clip starts early into its head, the outgoing ends late into its tail
    if (isMain) {
      const byId = new Map(main.map((x) => [x.id, x]));
      for (const t of root.transitions) {
        if (t.trackId !== vt.id || !t.fromClipId || !t.toClipId) continue;
        const a = byId.get(t.fromClipId), b = byId.get(t.toClipId);
        if (!a || !b) continue;
        const [x0, x1] = transitionRange(t);
        const pre = Math.max(0, t.at - x0), post = Math.max(0, x1 - t.at);
        if (post) { a.duration += sec(post); if (a.reverse) a.in -= sec(post) * a.speed; }
        if (pre) {
          b.start -= sec(pre); b.duration += sec(pre);
          b.in = b.reverse ? b.in : b.in - sec(pre) * b.speed;  // a negative in freezes the first frame (no head handle)
        }
        b.transitionIn = { type: t.type, duration: sec(t.duration), easing: ENGINE_EASE(t.easing) };
        if (t.params && Object.keys(t.params).length) b.transitionIn.params = t.params as never;
      }
      main.sort((p, q) => p.start - q.start);
      tracks.push({ id: vt.id, kind: "main", hidden: vt.hidden, clips: main });
      // V1 clips with motion go right above V1
      for (const [blend, cs] of layers) tracks.push({ id: `${vt.id}:${blend}`, kind: "layer", hidden: vt.hidden, blend, clips: cs.sort((p, q) => p.start - q.start) });
    } else {
      for (const [blend, cs] of layers) tracks.push({ id: blend === "normal" ? vt.id : `${vt.id}:${blend}`, kind: "layer", hidden: vt.hidden, blend, clips: cs.sort((p, q) => p.start - q.start) });
    }
  }
  if (!tracks.length || tracks[0].kind !== "main") tracks.unshift({ id: "main", kind: "main", clips: [] });

  let duration = sec(seqEnd(root));
  if (opts.range) {
    const [a, b] = opts.range.map(sec);
    for (const t of tracks) t.clips = t.clips.flatMap((c) => trimSeconds(c, a, b));
    duration = Math.max(0, b - a);
  }
  const comp: Composition = { width: root.width, height: root.height, fps: root.fps, duration, tracks, background: [0, 0, 0], warnings };
  if (opts.pixelScale) comp.pixelScale = opts.pixelScale;
  if (opts.lutUrl && looks.size) {
    comp.lutUrls = {};
    for (const l of looks) { const u = opts.lutUrl(l); if (u) comp.lutUrls[l] = u; }
  }
  return { comp, generated: gen, warnings };
}

/** Keeps the part of an engine clip inside [a, b) seconds and moves it to start at a = 0. */
function trimSeconds(c: EClip, a: number, b: number): EClip[] {
  const e = c.start + c.duration;
  if (e <= a || c.start >= b) return [];
  const x = { ...c, fx: { ...c.fx } };
  if (x.start < a) {
    const d = a - x.start;
    if (!x.reverse) x.in += d * x.speed;
    x.start = a; x.duration -= d;
    if (x.transform?.keyframes) x.transform = { ...x.transform, keyframes: x.transform.keyframes.map((k) => ({ ...k, t: k.t - d })) };
    // a speed ramp's time map is in seconds from the clip's start too (its source times stay)
    if (x.timeMap) x.timeMap = x.timeMap.map((q) => ({ t: q.t - d, s: q.s }));
    // generic tracks: motion and effect keyframes are clip-relative too
    const shift = (p: unknown): unknown => {
      const q = p as EParam;
      if (!q || typeof q !== "object" || !Array.isArray(q.keyframes)) return p;
      const fps = q.keyframes.length && q.keyframes[0].t > 0 ? q.keyframes[0].frame / q.keyframes[0].t : 0;
      return { ...q, keyframes: q.keyframes.map((k) => ({ ...k, t: k.t - d, frame: fps ? Math.round(k.frame - d * fps) : k.frame })) };
    };
    if (x.motion) x.motion = Object.fromEntries(Object.entries(x.motion).map(([k, v]) => [k, k === "blend" ? v : shift(v)])) as EClip["motion"];
    if (x.effects) x.effects = x.effects.map((e) => ({ ...e, params: e.params ? Object.fromEntries(Object.entries(e.params).map(([k, v]) => [k, shift(v)])) : e.params }));
    if (x.transitionIn) { const left = x.transitionIn.duration - d; if (left <= 0) delete x.transitionIn; else x.transitionIn = { ...x.transitionIn, duration: left }; }
    if (x.fx.fade_in) x.fx.fade_in = Math.max(0, x.fx.fade_in - d) || undefined;
  }
  if (x.start + x.duration > b) {
    const d = x.start + x.duration - b;
    if (x.reverse) x.in += d * x.speed;
    x.duration -= d;
  }
  x.start -= a;
  return [x];
}

// ── audio ────────────────────────────────────────────────────────────────────

export interface AudioClipPlan {
  clipId: string; trackId: string; url: string; name: string;
  /** Seconds on the sequence. */
  start: number; duration: number;
  /** Source seconds at the clip's start; playback rate; reverse (not playable live: muted in the preview). */
  in: number; rate: number; reverse: boolean;
  /** dB and -1..1 with keyframes in clip seconds. */
  gain: { value: number; keys: { t: number; v: number; ease: Easing }[] };
  pan: { value: number; keys: { t: number; v: number; ease: Easing }[] };
  /** Seconds, including edge transitions; crossfades at cuts: {seconds, curve} each side. */
  fadeIn: number; fadeOut: number;
  xIn?: { start: number; duration: number; curve: "power" | "gain" }; xOut?: { start: number; duration: number; curve: "power" | "gain" };
  effects: { type: string; params: Record<string, unknown> }[];
}
export interface AudioTrackPlan { id: string; name: string; index: number; volume: number; pan: number; muted: boolean; solo: boolean; audible: boolean }
export interface AudioMix { tracks: AudioTrackPlan[]; clips: AudioClipPlan[]; duration: number; warnings: string[] }

/** The sequence's sound: audio-track clips with their levels, fades and crossfades (solo and mute applied). A speed
 *  ramp plays as constant-rate pieces (pitch-corrected by the player, silent while frozen); a nested clip's sound is
 *  its sequence's audio tracks (a multicam clip: its audio angle's track) in its window. */
export function toAudioMix(project: EditProject, sequenceId: string, opts: { urlFor?(m: MediaItem): string | undefined } = {}): AudioMix {
  const seq = project.sequences.find((s) => s.id === sequenceId);
  if (!seq) throw new Error(`No sequence ${sequenceId}`);
  const ctx = ctxOf(project);
  const warnings: string[] = [];
  const warn = (s: string) => { if (!warnings.includes(s)) warnings.push(s); };
  const fps = seq.fps;
  const sec = (f: number) => framesToSeconds(f, fps);
  const ats = tracksOf(seq, "audio");
  const anySolo = ats.some((t) => t.solo);
  const tracks: AudioTrackPlan[] = ats.map((t) => ({ id: t.id, name: t.name, index: t.index, volume: t.volume, pan: t.pan, muted: t.muted, solo: t.solo,
    audible: !t.muted && !t.hidden && (!anySolo || t.solo) }));
  const keyed = (p: Param<number>) => ({ value: p.value, keys: bakeKeys(p).map((k) => ({ t: sec(k.frame), v: k.value, ease: k.ease })) });
  const clips: AudioClipPlan[] = [];
  /** One clip's plan(s): `xs` is its sequence, `offset` moves it onto the root (frames), `trackId` the root track. */
  const add = (c: TimelineClip, xs: Sequence, offset: number, trackId: string, extra: { gainDb?: number; id?: string } = {}) => {
    if (c.source.type !== "media") return;
    const m = ctx.media(c.source.mediaId);
    if (!m) return;
    const url = opts.urlFor ? opts.urlFor(m) : m.url;
    if (!url) { warn(`"${c.name}": no URL for its media yet`); return; }
    const f = m.fps > 0 ? m.fps : fps;
    const a = c.audio ?? { gain: { value: 0 }, pan: { value: 0 }, fadeIn: 0, fadeOut: 0 };
    const id = extra.id ?? c.id;
    const plan: AudioClipPlan = {
      clipId: id, trackId, url, name: c.name, start: sec(c.start + offset), duration: sec(c.duration), in: framesToSeconds(c.source.in, f),
      rate: c.speed > 0 ? c.speed : 1, reverse: c.reverse, gain: keyed(a.gain), pan: keyed(a.pan),
      fadeIn: sec(a.fadeIn), fadeOut: sec(a.fadeOut), effects: c.effects.filter((e) => e.enabled).map((e) => ({ type: e.type, params: Object.fromEntries(Object.entries(e.params).map(([k, p]) => [k, p.value])) })),
    };
    const gd = extra.gainDb ?? 0;
    if (gd) plan.gain = { value: plan.gain.value + gd, keys: plan.gain.keys.map((k) => ({ ...k, v: k.v + gd })) };
    const { into, outOf } = transitionsByClip(xs, c.trackId);
    const tin = into.get(c.id), tout = outOf.get(c.id);
    const curve = (x: Transition) => (x.type === "audio:constant_gain" ? "gain" as const : "power" as const);
    // a crossfade at a cut plays the incoming clip early (into its head) and the outgoing one late (into its tail)
    const rin = tin?.fromClipId ? transitionRange(tin) : null, rout = tout?.toClipId ? transitionRange(tout) : null;
    const pre = rin ? Math.max(0, tin!.at - rin[0]) : 0, post = rout ? Math.max(0, rout[1] - tout!.at) : 0;
    if (pre) {
      plan.start -= sec(pre); plan.in -= sec(pre) * plan.rate;
      plan.gain.keys = plan.gain.keys.map((k) => ({ ...k, t: k.t + sec(pre) }));
      plan.pan.keys = plan.pan.keys.map((k) => ({ ...k, t: k.t + sec(pre) }));
    }
    plan.duration = sec(c.duration + pre + post);
    if (rin) plan.xIn = { start: sec(rin[0] - c.start + pre), duration: sec(rin[1] - rin[0]), curve: curve(tin!) };
    else if (tin) plan.fadeIn = Math.max(plan.fadeIn, sec(tin.duration));
    if (rout) plan.xOut = { start: sec(rout[0] - c.start + pre), duration: sec(rout[1] - rout[0]), curve: curve(tout!) };
    else if (tout) plan.fadeOut = Math.max(plan.fadeOut, sec(tout.duration));
    if (!hasRamp(c)) { clips.push(plan); return; }
    if (c.reverse) { warn(`"${c.name}": a reversed speed ramp's sound plays at its base speed`); clips.push(plan); return; }
    // a ramp: constant-rate pieces (the player keeps the pitch); a freeze is silence
    const pieces = rampPieces(c);
    const sp = c.speed > 0 ? c.speed : 1;
    const k = sp / fpsExact(fps);
    const inS = framesToSeconds(c.source.in, f);
    const preS = sec(pre);
    pieces.forEach((pc, i) => {
      if (pc.freeze) return;
      const first = i === 0, last = i === pieces.length - 1;
      const a0 = first ? 0 : preS + sec(c.start + pc.from) - sec(c.start), a1 = last ? plan.duration : preS + sec(c.start + pc.to) - sec(c.start);
      const rate = Math.max(0.0625, Math.min(16, pc.speed * sp));
      const shift = <K extends { t: number }>(ks: K[]) => ks.map((x) => ({ ...x, t: x.t - a0 }));
      clips.push({
        ...plan, clipId: first ? id : `${id}~${i}`, start: plan.start + a0, duration: Math.max(0, a1 - a0), rate,
        in: first ? inS - preS * rate : inS + pc.offset * k,
        gain: { value: plan.gain.value, keys: shift(plan.gain.keys) }, pan: { value: plan.pan.value, keys: shift(plan.pan.keys) },
        fadeIn: first ? plan.fadeIn : 0, fadeOut: last ? plan.fadeOut : 0,
        xIn: first ? plan.xIn : undefined, xOut: last && plan.xOut ? { ...plan.xOut, start: plan.xOut.start - a0 } : undefined,
      });
    });
  };
  for (const t of ats) {
    for (const c of seq.clips) {
      if (c.trackId !== t.id || !c.enabled) continue;
      if (c.source.type === "nested") {
        const ns = ctx.sequence(c.source.sequenceId);
        if (!ns || ns.id === seq.id) continue;
        if (c.speed !== 1 || hasRamp(c) || fpsExact(ns.fps) !== fpsExact(fps)) { warn(`TODO: the sound of nested sequence "${c.name}" at another speed or frame rate isn't mixed yet`); continue; }
        // the nested sequence's audio tracks (a multicam clip: the audio angle's track) within the clip's window
        const inner = tracksOf(ns, "audio");
        const angle = c.multicam && ns.multicam ? (c.multicam.audioAngle ?? c.multicam.angle) : -1;
        const solo = inner.some((x) => x.solo);
        const win0 = Math.round(c.source.in), win1 = win0 + c.duration;
        let outerGain = c.audio?.gain.value ?? 0;
        if (c.audio?.gain.keyframes?.length) { warn(`TODO: volume keyframes on the nested clip "${c.name}" aren't mixed yet`); outerGain = c.audio.gain.keyframes[0].value; }
        inner.forEach((it, i) => {
          if (angle >= 0 ? i !== angle : it.muted || (solo && !it.solo)) return;
          for (const x0 of ns.clips) {
            if (x0.trackId !== it.id || !x0.enabled || clipEnd(x0) <= win0 || x0.start >= win1) continue;
            if (x0.source.type === "nested") { warn(`TODO: the sound of a nest inside "${c.name}" isn't mixed yet`); continue; }
            const r = sourceRate(x0, ns, ctx);
            let x = x0;
            if (x.start < win0) x = trimStartBy(x, win0 - x.start, r);
            if (clipEnd(x) > win1) x = trimEndBy(x, win1 - clipEnd(x), r);
            add(x, ns, c.start - win0, t.id, { gainDb: (angle >= 0 ? 0 : it.volume) + outerGain, id: `${c.id}/${x.id}` });
          }
        });
        continue;
      }
      add(c, seq, 0, t.id);
    }
  }
  return { tracks, clips, duration: sec(seqEnd(seq)), warnings };
}

/** Linear gain multiplier of a clip at `t` seconds into it (level, fades, crossfades), without the track. */
export function clipGainAt(p: AudioClipPlan, t: number): number {
  const db = sampleKeys(p.gain, t);
  let g = Math.pow(10, db / 20);
  if (p.fadeIn > 0 && t < p.fadeIn) g *= Math.max(0, t / p.fadeIn);
  if (p.fadeOut > 0 && t > p.duration - p.fadeOut) g *= Math.max(0, (p.duration - t) / p.fadeOut);
  const x = (w: { start: number; duration: number; curve: "power" | "gain" }, rising: boolean) => {
    const q = Math.max(0, Math.min(1, (t - w.start) / w.duration));
    const k = rising ? q : 1 - q;
    return w.curve === "power" ? Math.sin((k * Math.PI) / 2) : k;
  };
  if (p.xIn && t < p.xIn.start + p.xIn.duration) g *= x(p.xIn, true);
  if (p.xOut && t > p.xOut.start) g *= x(p.xOut, false);
  return g;
}

export function sampleKeys(p: { value: number; keys: { t: number; v: number; ease: Easing }[] }, t: number): number {
  const ks = p.keys;
  if (!ks.length) return p.value;
  if (t <= ks[0].t) return ks[0].v;
  for (let i = 1; i < ks.length; i++) {
    if (t < ks[i].t) {
      const a = ks[i - 1], b = ks[i];
      const span = b.t - a.t;
      if (span <= 0 || a.ease === "hold") return a.v;
      return a.v + (b.v - a.v) * ease(a.ease, (t - a.t) / span);
    }
  }
  return ks[ks.length - 1].v;
}

// ── generic editor tracks (engine "video" tracks, docs/EDITOR.md §6) ─────────

type EParam = { value: unknown; keyframes?: (ParamKey & { t: number; frame: number })[] };
/** Generic tracks: every effect runs in the clip's chain from the engine registry (look, adjust, mask … included, with
 *  keyframes); only a studio shot's fx stays the FFmpeg-matched `fx`. */
const LEGACY_FX = new Set(["shotfx"]);

/** Shifts a generic-track param's keyframes `d` seconds / `df` frames earlier (a ramp piece starts later in the clip). */
function shiftEParam(p: unknown, d: number, df: number): unknown {
  const q = p as EParam;
  if (!q || typeof q !== "object" || !Array.isArray(q.keyframes)) return p;
  return { ...q, keyframes: q.keyframes.map((k) => ({ ...k, t: k.t - d, frame: k.frame - df })) };
}

const third = (from: unknown, to: unknown): number[] | undefined =>
  (Array.isArray(from) && Array.isArray(to) ? from.map((v, j) => (Number(to[j]) - Number(v)) / 3) : undefined);

/**
 * A model param as the engine's (types.ts ParamKey): keys in seconds and frames with their eases passed through —
 * "bezier" with its `out` / `in` handles, "bounce", "elastic", "hold" — and the motion path's spatial tangents. The
 * engine has no default tangent, so a segment with only one side set gets the model's straight third on the other.
 */
export function engineParam<T>(p: Param<T>, fps: number): EParam {
  const ks = p.keyframes ?? [];
  if (!ks.length) return { value: p.value };
  return { value: p.value, keyframes: ks.map((k, i) => {
    const x: ParamKey & { t: number; frame: number } = { t: framesToSeconds(k.frame, fps), frame: k.frame, value: k.value, ease: k.ease };
    if (k.out) x.out = k.out;
    if (k.in) x.in = k.in;
    const next = ks[i + 1], prev = ks[i - 1];
    if (next && (k.tangentOut || next.tangentIn)) x.tangentOut = k.tangentOut ?? third(k.value, next.value);
    if (prev && (prev.tangentOut || k.tangentIn)) x.tangentIn = k.tangentIn ?? third(k.value, prev.value);
    return x;
  }) };
}

/** A speed ramp as the engine's time map (local seconds → source seconds from `base` at the clip's start): a point on
 *  every frame (every few on very long clips, plus every keyframe), the integral of the curve there. */
export function rampTimeMap(c: TimelineClip, base: number, fps: number): TimePoint[] {
  const k = (c.speed > 0 ? c.speed : 1) / fpsExact(fps);  // source seconds per speed-frame
  const D = Math.max(1, c.duration);
  const step = Math.max(1, Math.ceil(D / 2400));
  const frames = new Set<number>([D]);
  for (let f = 0; f < D; f += step) frames.add(f);
  for (const kf of c.timeRemap?.keyframes ?? []) if (kf.frame > 0 && kf.frame < D) frames.add(kf.frame);
  return [...frames].sort((a, b) => a - b).map((f) => ({ t: framesToSeconds(f, fps), s: base + clipSpan(c, 0, f) * k }));
}

/**
 * A speed-ramped clip for the engine: one clip with a time map (a frame hold: a freeze, speed 0, on its frame). The
 * engine's time maps only run forwards, so a reversed ramp is still constant-speed clips back to back (rampPieces),
 * "<id>~<n>" after the first, with freezes at speed 0.
 */
function rampClips(c: TimelineClip, ec: EClip, seq: Sequence, ctx: Ctx, warn: (s: string) => void): EClip[] {
  const fps = seq.fps;
  const sec = (f: number) => framesToSeconds(f, fps);
  const base = ec.in;
  const k = (c.speed > 0 ? c.speed : 1) / fpsExact(fps);  // source seconds per speed-frame
  const total = clipSpan(c, 0, c.duration);
  const m = c.source.type === "media" ? ctx.media(c.source.mediaId) : undefined;
  const mediaS = m && m.duration > 0 ? framesToSeconds(m.duration, m.fps > 0 ? m.fps : fps) : Infinity;
  if (base + total * k > mediaS + 0.05) warn(`"${c.name}": its speed ramp runs past the end of the media (the last frame holds)`);
  const remap = c.timeRemap!;
  if (!remap.keyframes?.length && !(remap.value > 0)) return [{ ...ec, speed: 0, reverse: undefined }];
  if (!c.reverse) return [{ ...ec, timeMap: rampTimeMap(c, base, fps) }];
  const pieces = rampPieces(c);
  return pieces.map((pc, i) => {
    const t0 = sec(c.start + pc.from), t1 = sec(c.start + pc.to);
    const d = t0 - sec(c.start);
    const x: EClip = {
      ...ec, id: i === 0 ? c.id : `${c.id}~${i}`, start: t0, duration: t1 - t0,
      motion: ec.motion ? Object.fromEntries(Object.entries(ec.motion).map(([key, v]) => [key, key === "blend" ? v : shiftEParam(v, d, pc.from)])) as EClip["motion"] : ec.motion,
      effects: ec.effects?.map((e) => ({ ...e, params: e.params ? Object.fromEntries(Object.entries(e.params).map(([key, v]) => [key, shiftEParam(v, d, pc.from)])) : e.params })),
    };
    let speed = pc.speed * (c.speed > 0 ? c.speed : 1);
    // a freeze (or a crawl slower than 1/16) is one held frame: speed 0 shows `in`
    if (pc.freeze || speed < 0.0625) {
      const at = base + (total - pc.offset - (pc.freeze ? 0 : clipSpan(c, pc.from, pc.to) / 2)) * k;
      return { ...x, in: Math.max(0, at), speed: 0 };
    }
    if (speed > 16) { warn(`"${c.name}": its speed ramp goes past 1600 %; shown at 1600 %`); speed = 16; }
    x.speed = speed;
    x.in = base + (total - pc.offset - clipSpan(c, pc.from, pc.to)) * k;
    return x;
  });
}

/**
 * The same sequence for the engine's generic "video" tracks: every video track bottom → top with its clips placed by
 * `motion` (Premiere-style pixels and % of the fitted size, keyframed), an `effects` chain with keyframed parameters
 * (the FFmpeg-matched ones — look, adjust, wheels, curves, chroma, mask, glow, flips, camera move, a studio shot's fx —
 * go into `fx`), the track's transitions at cuts and clip edges, titles, colour mattes, adjustment clips and nested
 * sequences as nested compositions. editor/engine.ts uses it once the engine says it draws these tracks.
 */
export function toVideoComposition(project: EditProject, sequenceId: string, opts: CompositionOptions = {}): CompositionResult {
  opts = { ...opts, lutUrl: lutResolver(project, project.sequences.find((s) => s.id === sequenceId), opts.lutUrl) };
  const ctx = ctxOf(project);
  const warnings: string[] = [];
  const warn = (s: string) => { if (!warnings.includes(s)) warnings.push(s); };
  const looks = new Set<string>();
  const gen: Record<string, GeneratedSource> = {};
  const build = (seq: Sequence, depth: number, path = ""): Composition => {
    const sec = (f: number) => framesToSeconds(f, seq.fps);
    const param = <T>(p: Param<T>): EParam => engineParam(p, seq.fps);
    /** A reversed ramp's last piece (transitions out of the clip leave from it). */
    const lastPiece = new Map<string, string>();
    const tracks: ETrack[] = tracksOf(seq, "video").map((t) => {
      const clips: EClip[] = [];
      for (const c0 of seq.clips) {
        if (c0.trackId !== t.id || !c0.enabled) continue;
        const c = slotted(project, seq, c0, ctx);
        const legacy = effectsToFx({ ...c, effects: c.effects.filter((e) => LEGACY_FX.has(e.type)) }, warn);
        if (legacy.fx.look && legacy.fx.look !== "none") looks.add(legacy.fx.look);
        for (const e of c.effects) if (e.type === "look" && e.enabled && typeof e.params.look?.value === "string" && e.params.look.value !== "none") looks.add(e.params.look.value);
        const ec: EClip = {
          id: c.id, media: { url: "", kind: "image" }, start: sec(c.start), duration: sec(c.duration), in: 0, speed: c.speed > 0 ? c.speed : 1,
          fit: "contain", fx: legacy.fx, label: c.name,
          motion: { position: param(c.motion.position), scale: param(c.motion.scale), rotation: param(c.motion.rotation), anchor: param(c.motion.anchor),
            opacity: { ...param(c.motion.opacity) }, blend: c.motion.blend } as EClip["motion"],
          effects: c.effects.filter((e) => !LEGACY_FX.has(e.type) && !e.type.startsWith("audio:")).map((e) => ({
            id: e.id, type: e.type, enabled: e.enabled, params: Object.fromEntries(Object.entries(e.params).map(([k, p]) => [k, param(p)])), ...(e.mask ? { mask: { ...e.mask } } : {}),
          })) as EClip["effects"],
        };
        if (c.reverse) ec.reverse = true;
        if (legacy.move) ec.move = legacy.move;
        const s = c.source;
        if (s.type === "media") {
          const md = mediaFor(c, ctx, seq, opts, {}, seq, warn);
          if (!md) continue;
          ec.media = md.media; ec.in = md.in;
          if (legacy.kenburns && md.media.kind === "image") ec.kenburns = true;
          if (hasRamp(c) && md.media.kind === "video") {
            const ps = rampClips(c, ec, seq, ctx, warn);
            if (ps.length > 1) lastPiece.set(c.id, ps[ps.length - 1].id);
            clips.push(...ps);
            continue;
          }
        } else if (s.type === "graphic") {
          const md = graphicMedia(project, seq, c, opts, gen, `gen:gfx:${path}${c.id}`, seq.width, seq.height, warn);
          if (!md) continue;
          ec.media = md.media; ec.in = 0;
        } else if (s.type === "title") { ec.type = "title"; ec.title = { ...s.text } as EClip["title"]; }
        else if (s.type === "color") { ec.type = "color"; ec.color = s.color; }
        else if (s.type === "adjustment") ec.type = "adjustment";
        else if (s.type === "nested") {
          const ns = ctx.sequence(s.sequenceId);
          if (!ns || depth > 4 || ns.id === seq.id) { warn(`Nested sequence of "${c.name}" is missing`); continue; }
          ec.type = "nested"; ec.comp = build(ns, depth + 1, `${path}${c.id}/`); ec.in = framesToSeconds(s.in, ns.fps);
          // a multicam clip shows one angle: its video track of the multicam sequence
          if (c.multicam && ns.multicam) {
            const a = c.multicam.angle;
            ec.comp = { ...ec.comp, tracks: ec.comp.tracks.map((x, i) => (i === a ? x : { ...x, hidden: true })) };
          }
          if (hasRamp(c)) warn(`TODO(engine): the speed ramp on the nested clip "${c.name}" isn't drawn yet (it plays at ${Math.round(c.speed * 100)} %)`);
        }
        clips.push(ec);
      }
      const transitions = seq.transitions.filter((x) => x.trackId === t.id && !x.type.startsWith("audio:")).map((x) => {
        // `start` is exact: the engine would centre at at − d/2, while a centred transition here starts floor(d/2) frames early
        const tr: NonNullable<ETrack["transitions"]>[number] = { id: x.id, type: x.type, at: sec(x.at), duration: sec(x.duration), alignment: x.alignment,
          start: sec(transitionRange(x)[0]), easing: x.easing === "hold" ? "hold" : ENGINE_EASE(x.easing) };
        if (x.fromClipId) tr.from = lastPiece.get(x.fromClipId) ?? x.fromClipId;
        if (x.toClipId) tr.to = x.toClipId;
        if (x.params && Object.keys(x.params).length) tr.params = x.params as never;
        return tr;
      });
      return { id: t.id, kind: "video", hidden: t.hidden, clips: clips.sort((a, b) => a.start - b.start), transitions };
    });
    return { width: seq.width, height: seq.height, fps: seq.fps, duration: sec(seqEnd(seq)), tracks, background: [0, 0, 0] };
  };
  const root = project.sequences.find((s) => s.id === sequenceId);
  if (!root) throw new Error(`No sequence ${sequenceId}`);
  const comp = build(root, 0);
  if (opts.range) {
    const [a, b] = opts.range.map((f) => framesToSeconds(f, root.fps));
    for (const t of comp.tracks) {
      t.clips = t.clips.flatMap((c) => trimSeconds(c, a, b));
      t.transitions = (t.transitions ?? []).filter((x) => x.at + x.duration >= a && x.at - x.duration <= b)
        .map((x) => ({ ...x, at: x.at - a, ...(x.start !== undefined ? { start: x.start - a } : {}) }));
    }
    comp.duration = Math.max(0, b - a);
  }
  comp.warnings = warnings;
  if (opts.pixelScale) comp.pixelScale = opts.pixelScale;
  if (opts.lutUrl && looks.size) { comp.lutUrls = {}; for (const l of looks) { const u = opts.lutUrl(l); if (u) comp.lutUrls[l] = u; } }
  return { comp, generated: gen, warnings };
}
