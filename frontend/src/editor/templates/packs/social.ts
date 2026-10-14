/**
 * Social templates (docs/EDITOR.md §15.3, presets-pack): sequence templates with slots, in the templates library's
 * conventions (templates/sequences.ts) — Shorts/Reels hook intros, animated subscribe and like prompts, end screens,
 * podcast audiograms, quote cards, before/after splits and countdowns. They're built from the title design system
 * (templates/design.ts): the restyled title templates, the type scale (scaled by the frame's short side, so one
 * template reads the same in a landscape edit and a vertical one), the palettes (text at 4.5:1 on its plate or
 * backdrop) and the motion presets. Every text box is inside the safe area of the frame it lands in (16:9, 9:16, 1:1
 * or 4:5: templates/formats.ts, at least EBU title safe).
 *
 * The audiograms draw the audio-reactive visualiser (§15.4, audio-tools2) when a provider is registered
 * (setVisualiserProvider: the generated source for a box of the frame); without one they fall back to a static
 * waveform (a line bent by two of the engine's `wave` distortions, with a glow). Pure: sequences.ts hands in its slot
 * and matte helpers, so this module doesn't import it back.
 */
import type { ClipSource, ShapeSpec, TitleLook, TitleSpec } from "../../model/types.ts";
import { contrast, MOTION, palette, plateColor, RADIUS, STROKE, SUB_STEP, TEXT_SHADOW, TYPE_SCALE, type MotionId, type PaletteId, type TypeStep } from "../design.ts";
import { fitBox, formatOf, SAFE_AREAS, type Safe } from "../formats.ts";
import type { SeqLayer, SeqTemplate } from "../sequences.ts";
import { STICKERS, stickerSpec, templateSpec, titleTemplate } from "../titles.ts";

export type PackSeqGroup = "Hooks" | "End screens" | "Audiograms" | "Quote cards" | "Before/after" | "Countdowns";
export const PACK_SEQ_GROUPS: PackSeqGroup[] = ["Hooks", "End screens", "Audiograms", "Quote cards", "Before/after", "Countdowns"];

/** What sequences.ts hands in (its own slot and matte builders, so slots keep one prefix and colour). */
export interface LayerKit {
  slot(label: string, start: number, dur: number, extra?: Partial<SeqLayer>): SeqLayer;
  matte(color: string, start: number, dur: number, name?: string): SeqLayer;
}

// ── the visualiser (audio-tools2) or a static waveform ──────────────────────

export interface VisualiserSpec { style: "bars" | "wave" | "circle" | "particles"; color: string; color2?: string }
/** A generated visualiser clip for `box` (fractions of a W×H frame), or null when it can't make one. */
export type VisualiserProvider = (spec: VisualiserSpec, box: [number, number, number, number], W: number, H: number) =>
  { source: ClipSource; name?: string; effects?: SeqLayer["effects"]; scale?: number; at?: [number, number] } | null;
let provider: VisualiserProvider | null = null;
/** Registers (or, with null, removes) the visualiser source the audiograms use. */
export function setVisualiserProvider(p: VisualiserProvider | null): void { provider = p; }
export const hasVisualiser = () => provider !== null;
export const STATIC_WAVEFORM = "Waveform (static)";

const STYLE_MAP: Record<VisualiserSpec["style"], string> = { bars: "mirror", wave: "line", circle: "circle", particles: "particles" };
/**
 * A provider over audio-tools2's public API (editor/audiotools: `makeVisualizerSource` and `VISUALIZER_STYLES`), fed
 * by `audio()` (a media item and the media seconds to start from; null = no sound yet, so the static waveform). The
 * source draws inside its own box on a full-frame clip.
 */
export function visualiserProviderFrom(make: (o: Record<string, unknown>) => ClipSource, styles: readonly { id: string }[],
  audio: () => { mediaId: string; offset: number } | null): VisualiserProvider {
  const ids = new Set(styles.map((s) => s.id));
  return (spec, box) => {
    const a = audio();
    if (!a) return null;
    const style = ids.has(STYLE_MAP[spec.style]) ? STYLE_MAP[spec.style] : [...ids][0];
    return { source: make({ mediaId: a.mediaId, offset: a.offset, style, colors: [spec.color, spec.color2 ?? spec.color], gradient: true, glow: 0.4, box }), name: "Visualiser" };
  };
}

function visualiser(start: number, dur: number, box: [number, number, number, number], W: number, H: number, spec: VisualiserSpec): SeqLayer {
  const got = provider?.(spec, box, W, H) ?? null;
  if (got) return { start, dur, source: got.source, name: got.name ?? "Visualiser", ...(got.effects ? { effects: got.effects } : {}), ...(got.scale !== undefined ? { scale: got.scale } : {}), ...(got.at ? { at: got.at } : {}) };
  const short = Math.min(W, H);
  const m = MOTION.wipe;
  const text: TitleSpec = { text: "", font: "Inter Variable", size: Math.round((TYPE_SCALE.body * short) / 108) / 10, color: spec.color, weight: 700, align: "center", box, animIn: "none", animOut: "none",
    shape: { kind: "line", stroke: spec.color, strokeWidth: Math.max(2, Math.round((STROKE.thin * short) / 1080)) }, look: { in: m.in, out: "fade", inDur: m.inDur, outDur: m.outDur }, template: "social.waveform" };
  return { start, dur, source: { type: "title", text }, name: STATIC_WAVEFORM, effects: [
    { type: "wave", params: { amplitude: Math.round(box[3] * H * 0.3), wavelength: Math.round(W * 0.045), speed: 0, direction: "vertical" } },
    { type: "wave", params: { amplitude: Math.round(box[3] * H * 0.14), wavelength: Math.round(W * 0.017), speed: 0, direction: "vertical" } },
    { type: "glow", params: { amount: 0.5, threshold: 0.4, radius: 0.3 } },
  ] };
}

// ── layout inside the safe area ──────────────────────────────────────────────

/** The safe area of a W×H frame (16:9's when it isn't one of the four formats; each is at least EBU title safe). */
export const safeOf = (W: number, H: number): Safe => SAFE_AREAS[formatOf({ width: W, height: H })?.id ?? "16:9"];

interface Frame { W: number; H: number; safe: Safe; short: number; k: number }
const frame = (W: number, H: number): Frame => ({ W, H, safe: safeOf(W, H), short: Math.min(W, H), k: Math.min(W, H) / 1080 });
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const px = (f: Frame, v: number) => Math.round(v * f.k * 10) / 10;
/** A box given as fractions of the safe area → fractions of the frame. */
function inSafe(f: Frame, fx: number, fy: number, fw: number, fh: number): [number, number, number, number] {
  const sw = 1 - f.safe.left - f.safe.right, sh = 1 - f.safe.top - f.safe.bottom;
  return [r4(f.safe.left + fx * sw), r4(f.safe.top + fy * sh), r4(fw * sw), r4(fh * sh)];
}

interface TitleOpts { box: [number, number, number, number]; size?: TypeStep; patch?: Partial<TitleSpec>; look?: Partial<TitleLook>; name?: string }
/**
 * A title template as a layer: the template's own type step (or `size`), scaled by the frame's short side, the sub
 * line one step down, the box pulled inside the safe area.
 */
function tt(f: Frame, tplId: string, start: number, dur: number, fields: { text?: string; sub?: string }, o: TitleOpts): SeqLayer {
  const t = titleTemplate(tplId);
  if (!t) throw new Error(`No title template ${tplId}`);
  const spec = templateSpec(t, f.short, fields);
  if (o.size !== undefined) {
    spec.size = px(f, TYPE_SCALE[o.size]);
    if (spec.look?.sub) spec.look.sub = { ...spec.look.sub, size: px(f, TYPE_SCALE[SUB_STEP[o.size]]) };
  }
  Object.assign(spec, o.patch ?? {});
  if (o.look) spec.look = { ...spec.look, ...o.look };
  if (fields.sub === "" && spec.look?.sub) { const { sub: _drop, ...rest } = spec.look; void _drop; spec.look = rest; }
  for (const key of Object.keys(spec) as (keyof TitleSpec)[]) if (spec[key] === undefined) delete spec[key];
  spec.box = fitBox(o.box, f.safe);
  return { start, dur, source: { type: "title", text: spec }, name: o.name ?? ((fields.text ?? t.name).slice(0, 40) || t.name) };
}

/** A sticker centred at (fx, fy) of the safe area, `h` (a fraction of the frame's height) tall, kept inside it. */
function st(f: Frame, id: string, start: number, dur: number, fx: number, fy: number, h: number, text?: string): SeqLayer {
  const s = STICKERS.find((x) => x.id === id);
  if (!s) throw new Error(`No sticker ${id}`);
  const [cx, cy] = inSafe(f, fx, fy, 0, 0);
  const w = (h * f.H * (s.aspect ?? 1)) / f.W;
  const spec = stickerSpec({ ...s, w }, f.W, f.H, cx, cy);
  if (text !== undefined) spec.text = text;
  // text on the sticker reads on its fill: white, or ink on a light fill
  const fill = s.shape.fill && s.shape.fill !== "none" ? s.shape.fill : null;
  if (fill && spec.text.trim()) spec.color = contrast("#ffffff", fill.slice(0, 7)) >= 4.5 ? "#ffffff" : palette("paper").text;
  spec.size = px(f, TYPE_SCALE.title);
  const m = MOTION.pop;
  spec.look = { ...spec.look, in: m.in, out: m.out, inDur: m.inDur, outDur: m.outDur };
  spec.box = fitBox(spec.box, f.safe);
  return { start, dur, source: { type: "title", text: spec }, name: s.name };
}

const motionLook = (id: MotionId): TitleLook => {
  const m = MOTION[id];
  return { in: m.in, out: m.out, inDur: m.inDur, outDur: m.outDur, stagger: m.stagger, ...(m.step !== undefined ? { staggerStep: m.step } : {}) };
};

/** A shape (a card, a button, a divider) with optional text in the palette. `bleed`: a graphic that may cross the safe area. */
function shapeLayer(f: Frame, start: number, dur: number, box: [number, number, number, number], shape: ShapeSpec,
  o: { text?: string; color?: string; size?: TypeStep; motion?: MotionId; loop?: string; bleed?: boolean; name: string }): SeqLayer {
  const sh: ShapeSpec = { ...shape, ...(shape.strokeWidth ? { strokeWidth: px(f, shape.strokeWidth) } : {}), ...(shape.radius ? { radius: px(f, shape.radius) } : {}) };
  const text: TitleSpec = { text: o.text ?? "", font: "Montserrat Variable", size: px(f, TYPE_SCALE[o.size ?? "body"]), color: o.color ?? "#ffffff", weight: 700, align: "center",
    box: o.bleed ? box : fitBox(box, f.safe), animIn: "none", animOut: "none", shape: sh, look: { ...motionLook(o.motion ?? "pop"), ...(o.loop ? { loop: o.loop } : {}) } };
  return { start, dur, source: { type: "title", text }, name: o.name };
}

/** A small label (BEFORE / AFTER, LIVE IN …): capitals on a pill plate of the palette (or its accent). */
function label(f: Frame, start: number, dur: number, text: string, box: [number, number, number, number], pal: PaletteId = "ink", accent = false): SeqLayer {
  const p = palette(pal);
  const spec: TitleSpec = { text, font: "Montserrat Variable", size: px(f, TYPE_SCALE.body), color: accent ? p.onAccent : p.text, weight: 700, align: "left", box: fitBox(box, f.safe),
    animIn: "none", animOut: "none", look: { ...motionLook("slide"), upper: true, tracking: 0.08, decor: { kind: "pill", color: accent ? p.accent : plateColor(p.bg) } } };
  return { start, dur, source: { type: "title", text: spec }, name: text };
}

const gradientMatte = (kit: LayerKit, c1: string, c2: string, dur: number, name = "Background"): SeqLayer => ({ ...kit.matte(c1, 0, dur, name),
  effects: [{ type: "color_gradient", params: { type: 0, angle: 135, color1: c1, alpha1: 1, color2: c2, alpha2: 1, midpoint: 0.5, color3: c2, alpha3: 1, alpha: 1, maxColors: 0, replace: true } }] });

/** The text shadow token, for the layers over footage. */
export const SOCIAL_SHADOW = TEXT_SHADOW;

// ── the templates ────────────────────────────────────────────────────────────

export function socialPack(kit: LayerKit): SeqTemplate[] {
  const T = (t: SeqTemplate) => t;
  const paper = palette("paper"), broadcast = palette("broadcast"), amber = palette("amber"), ink = palette("ink");
  return [
    // hooks: the first seconds of a Short or Reel, over your clip
    T({ id: "hook.question", name: "Hook · Question", group: "Hooks", seconds: 4, blurb: "A question on a white plate, with an arrow down to your clip",
      fields: [{ key: "hook", label: "Hook", value: "Did you know this?" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [kit.slot("Main clip", 0, 4)],
        [tt(f, "headline.clean.pop", 0, 4, { text: v.hook }, { box: inSafe(f, 0, 0.02, 1, 0.18), size: "headline", patch: { color: paper.text, shadow: undefined },
          look: { decor: { kind: "pill", color: paper.bg } } })],
        [st(f, "arrow-down", 0.5, 3.5, 0.5, 0.33, 0.14)],
      ]; } }),
    T({ id: "hook.stop", name: "Hook · Stop scrolling", group: "Hooks", seconds: 3, blurb: "Big capitals across the top and a badge",
      fields: [{ key: "hook", label: "Hook", value: "Stop scrolling" }, { key: "badge", label: "Badge", value: "WAIT!" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [kit.slot("Main clip", 0, 3)],
        [tt(f, "fitness.power.pop", 0, 3, { text: v.hook }, { box: inSafe(f, 0, 0.03, 1, 0.2), size: "display" })],
        [st(f, "burst", 0.4, 2.6, 0.82, 0.34, 0.22, v.badge)],
      ]; } }),
    T({ id: "hook.watch_end", name: "Hook · Watch till the end", group: "Hooks", seconds: 4, blurb: "A neon line with a small 3-2-1 ring in the corner",
      fields: [{ key: "hook", label: "Hook", value: "Watch till the end" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [kit.slot("Main clip", 0, 4)],
        [tt(f, "headline.neon.flicker", 0, 4, { text: v.hook }, { box: inSafe(f, 0, 0.02, 1, 0.18), size: "headline" })],
        [tt(f, "count.ring", 0.5, 3.5, { text: "#" }, { box: inSafe(f, 0.76, 0.24, 0.22, 0.14), size: "title", look: { count: { from: 3, to: 0 } } })],
      ]; } }),
    T({ id: "hook.pov", name: "Hook · POV", group: "Hooks", seconds: 4, blurb: "A typed POV line at the top",
      fields: [{ key: "hook", label: "Hook", value: "POV: you finally tried it" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [kit.slot("Main clip", 0, 4)],
        [tt(f, "headline.clean.typewriter", 0, 4, { text: v.hook }, { box: inSafe(f, 0, 0.03, 1, 0.16), size: "headline", patch: { align: "left" } })],
      ]; } }),
    T({ id: "hook.top3", name: "Hook · Top 3", group: "Hooks", seconds: 4, blurb: "A big number with the list's promise",
      fields: [{ key: "number", label: "Number", value: "3" }, { key: "hook", label: "Promise", value: "things you need to know" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [kit.slot("Main clip", 0, 4)],
        [tt(f, "chapter.number", 0, 4, { text: v.number, sub: v.hook }, { box: inSafe(f, 0, 0.02, 1, 0.34), size: "hero" })],
      ]; } }),
    // subscribe and like
    T({ id: "subscribe.click", name: "Subscribe · click and bell", group: "Subscribe", seconds: 4, blurb: "The subscribe button is clicked, then the bell rings",
      fields: [{ key: "label", label: "Button", value: "SUBSCRIBE" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [tt(f, "social.subscribe.pop", 0, 4, { text: v.label }, { box: inSafe(f, 0.28, 0.84, 0.36, 0.12) })],
        [st(f, "bell", 1.1, 2.9, 0.72, 0.9, 0.09)],
      ]; } }),
    T({ id: "subscribe.like_comment_share", name: "Like, comment, share", group: "Subscribe", seconds: 4, blurb: "Three buttons that pop in one after another",
      fields: [{ key: "like", label: "Like", value: "LIKE" }, { key: "comment", label: "Comment", value: "COMMENT" }, { key: "share", label: "Share", value: "SHARE" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [shapeLayer(f, 0, 4, inSafe(f, 0.02, 0.84, 0.28, 0.12), { kind: "like", fill: paper.accent, stroke: "#ffffff" }, { text: v.like, name: "Like" })],
        [shapeLayer(f, 0.25, 3.75, inSafe(f, 0.36, 0.82, 0.28, 0.15), { kind: "callout", fill: paper.bg, stroke: paper.text, strokeWidth: STROKE.thin, radius: RADIUS.lg },
          { text: v.comment, color: paper.text, name: "Comment" })],
        [shapeLayer(f, 0.5, 3.5, inSafe(f, 0.7, 0.84, 0.28, 0.12), { kind: "rect", fill: ink.accent, radius: RADIUS.pill }, { text: v.share, color: ink.onAccent, name: "Share" })],
      ]; } }),
    T({ id: "subscribe.bar", name: "Subscribe bar", group: "Subscribe", seconds: 5, blurb: "A lower-third bar with your channel and a bell",
      fields: [{ key: "text", label: "Text", value: "Subscribe for more" }, { key: "channel", label: "Channel", value: "@tatvam" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [tt(f, "lower.pill.slide_left", 0, 5, { text: v.text, sub: v.channel }, { box: inSafe(f, 0, 0.8, 0.62, 0.17) })],
        [st(f, "bell", 0.6, 4.4, 0.7, 0.88, 0.09)],
      ]; } }),
    T({ id: "subscribe.follow_like", name: "Follow and like (Shorts)", group: "Subscribe", seconds: 4, blurb: "A follow button and a heart, clear of the Shorts and Reels buttons",
      fields: [{ key: "label", label: "Button", value: "Follow" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [shapeLayer(f, 0, 4, inSafe(f, 0.3, 0.87, 0.4, 0.1), { kind: "rect", fill: broadcast.accent, radius: RADIUS.pill }, { text: v.label, color: broadcast.onAccent, name: "Follow" })],
        [st(f, "heart", 0.4, 3.6, 0.88, 0.64, 0.1)],
      ]; } }),
    // end screens (YouTube allows 5–20 s)
    T({ id: "end.two_videos", name: "End screen · two videos", group: "End screens", seconds: 12, blurb: "Two video slots, a heading and a subscribe button",
      fields: [{ key: "title", label: "Heading", value: "Watch next" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [kit.matte(ink.bg, 0, 12, "Background")],
        [kit.slot("Video 1", 0.3, 11.7, { scale: 36, at: [0.28, 0.5] })],
        [kit.slot("Video 2", 0.5, 11.5, { scale: 36, at: [0.72, 0.5] })],
        [tt(f, "end.next", 0, 12, { text: v.title, sub: "" }, { box: inSafe(f, 0, 0.02, 1, 0.16), size: "headline" })],
        [tt(f, "social.subscribe.pop", 0.8, 11.2, { text: "SUBSCRIBE" }, { box: inSafe(f, 0.33, 0.84, 0.34, 0.12) })],
      ]; } }),
    T({ id: "end.big_video", name: "End screen · one big video", group: "End screens", seconds: 10, blurb: "Your last clip blurred, one big video slot and a subscribe circle",
      fields: [{ key: "title", label: "Heading", value: "Up next" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [kit.slot("Background clip (blurred)", 0, 10, { effects: [{ type: "gaussian_blur", params: { radius: 16, horizontal: true, vertical: true } }, { type: "adjust", params: { exposure: -0.35 } }] })],
        [kit.slot("Next video", 0.3, 9.7, { scale: 52, at: [0.37, 0.54] })],
        [st(f, "ring", 0.6, 9.4, 0.82, 0.5, 0.26)],
        [tt(f, "headline.clean.rise", 0, 10, { text: v.title }, { box: inSafe(f, 0, 0.02, 0.7, 0.14), size: "headline", patch: { align: "left" } })],
        [tt(f, "social.subscribe.pop", 0.9, 9.1, { text: "SUBSCRIBE" }, { box: inSafe(f, 0.66, 0.74, 0.32, 0.1) })],
      ]; } }),
    T({ id: "end.playlist", name: "End screen · playlist grid", group: "End screens", seconds: 15, blurb: "Four video slots in a grid under the series name",
      fields: [{ key: "title", label: "Heading", value: "More from the series" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [kit.matte(ink.bg, 0, 15, "Background")],
        [kit.slot("Video 1", 0.2, 14.8, { scale: 30, at: [0.3, 0.42] })],
        [kit.slot("Video 2", 0.35, 14.65, { scale: 30, at: [0.7, 0.42] })],
        [kit.slot("Video 3", 0.5, 14.5, { scale: 30, at: [0.3, 0.74] })],
        [kit.slot("Video 4", 0.65, 14.35, { scale: 30, at: [0.7, 0.74] })],
        [tt(f, "corporate.bold.fade", 0, 15, { text: v.title }, { box: inSafe(f, 0, 0.01, 1, 0.14), size: "title" })],
      ]; } }),
    T({ id: "end.thanks", name: "End screen · thanks and socials", group: "End screens", seconds: 8, blurb: "Thanks, your handle and a subscribe button over your last clip",
      fields: [{ key: "title", label: "Text", value: "Thanks for watching" }, { key: "handle", label: "Handle", value: "@tatvam · instagram · youtube" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [kit.slot("Last clip (darkened)", 0, 8, { effects: [{ type: "gaussian_blur", params: { radius: 10, horizontal: true, vertical: true } }, { type: "adjust", params: { exposure: -0.4 } }] })],
        [tt(f, "end.thanks", 0.2, 7.8, { text: v.title, sub: v.handle }, { box: inSafe(f, 0, 0.3, 1, 0.3), size: "headline" })],
        [tt(f, "social.subscribe.pop", 1.2, 6.8, { text: "SUBSCRIBE" }, { box: inSafe(f, 0.33, 0.8, 0.34, 0.12) })],
      ]; } }),
    // podcast audiograms
    T({ id: "audiogram.square", name: "Podcast audiogram · square", group: "Audiograms", seconds: 30, format: "1:1", blurb: "Cover art, the visualiser and the episode, for feed posts",
      fields: [{ key: "show", label: "Show", value: "The Long Game" }, { key: "episode", label: "Episode", value: "Episode 12 · Patience" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [gradientMatte(kit, "#1b2a4a", ink.bg, 30)],
        [kit.slot("Cover art", 0, 30, { scale: 40, at: [0.5, 0.33] })],
        [visualiser(0, 30, inSafe(f, 0.04, 0.6, 0.92, 0.12), W, H, { style: "bars", color: ink.accent, color2: "#a5b4fc" })],
        [tt(f, "podcast.episode.fade", 0, 30, { text: v.show, sub: v.episode }, { box: inSafe(f, 0, 0.76, 1, 0.22), size: "headline" })],
      ]; } }),
    T({ id: "audiogram.vertical", name: "Podcast audiogram · vertical", group: "Audiograms", seconds: 30, format: "9:16", blurb: "Cover art, a pull quote, the visualiser and the show, for Reels and Shorts",
      fields: [{ key: "quote", label: "Pull quote", value: "“Patience is a strategy, not a delay.”" }, { key: "show", label: "Show", value: "The Long Game · Ep. 12" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [gradientMatte(kit, "#1b2a4a", ink.bg, 30)],
        [kit.slot("Cover art", 0, 30, { scale: 56, at: [0.47, 0.3] })],
        [tt(f, "quote.serif", 0.3, 29.7, { text: v.quote, sub: "" }, { box: inSafe(f, 0, 0.5, 1, 0.2), size: "title" })],
        [visualiser(0, 30, inSafe(f, 0.02, 0.73, 0.96, 0.1), W, H, { style: "wave", color: ink.accent, color2: "#a5b4fc" })],
        [tt(f, "podcast.studio.fade", 0, 30, { text: v.show }, { box: inSafe(f, 0, 0.86, 1, 0.12), size: "title" })],
      ]; } }),
    // quote cards
    T({ id: "quote.card_serif", name: "Quote card · serif", group: "Quote cards", seconds: 6, blurb: "A classic serif quote on a warm dark card",
      fields: [{ key: "quote", label: "Quote", value: "“The best stories are the ones we live.”" }, { key: "author", label: "Author", value: "— Asha Rao" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [kit.matte(amber.bg, 0, 6, "Background")],
        [tt(f, "quote.serif", 0, 6, { text: v.quote, sub: v.author }, { box: inSafe(f, 0.04, 0.25, 0.92, 0.5), size: "headline" })],
      ]; } }),
    T({ id: "quote.card_bold", name: "Quote card · bold", group: "Quote cards", seconds: 6, blurb: "Heavy dark words on a bright amber card",
      fields: [{ key: "quote", label: "Quote", value: "Make it simple. Make it memorable." }, { key: "author", label: "Author", value: "Brand book" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [kit.matte(amber.accent, 0, 6, "Background")],
        [(() => {
          const l = tt(f, "quote.modern", 0, 6, { text: v.quote, sub: v.author }, { box: inSafe(f, 0.04, 0.25, 0.9, 0.5), size: "headline", patch: { color: amber.onAccent, shadow: undefined },
            look: { decor: { kind: "bar", color: amber.onAccent, size: 0.12 } } });
          const s = (l.source as { text: TitleSpec }).text;
          if (s.look?.sub) s.look.sub = { ...s.look.sub, color: amber.onAccent };
          return l;
        })()],
      ]; } }),
    T({ id: "quote.photo", name: "Quote card · over a photo", group: "Quote cards", seconds: 7, blurb: "Your clip, darkened and softened, with a quote over it",
      fields: [{ key: "quote", label: "Quote", value: "“Collect moments, not things.”" }, { key: "author", label: "Author", value: "— Travel diaries" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [kit.slot("Background clip", 0, 7, { effects: [{ type: "adjust", params: { exposure: -0.4, saturation: -0.3 } }, { type: "gaussian_blur", params: { radius: 6, horizontal: true, vertical: true } }] })],
        [tt(f, "quote.serif", 0.2, 6.8, { text: v.quote, sub: v.author }, { box: inSafe(f, 0.04, 0.28, 0.92, 0.44), size: "headline" })],
      ]; } }),
    T({ id: "quote.post", name: "Quote card · post", group: "Quote cards", seconds: 6, blurb: "A white post card with the quote and a handle",
      fields: [{ key: "quote", label: "Quote", value: "Ship it, then make it better." }, { key: "handle", label: "Handle", value: "@tatvam" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [kit.matte("#e2e8f0", 0, 6, "Background")],
        [shapeLayer(f, 0, 6, inSafe(f, 0.04, 0.22, 0.92, 0.56), { kind: "rect", fill: "#ffffff", stroke: "#cbd5e1", strokeWidth: STROKE.hair, radius: RADIUS.lg }, { name: "Card", motion: "rise" })],
        [tt(f, "headline.clean.fade", 0.2, 5.8, { text: v.quote }, { box: inSafe(f, 0.1, 0.3, 0.8, 0.3), size: "title", patch: { color: paper.text, align: "left", shadow: undefined } })],
        [tt(f, "headline.clean.fade", 0.5, 5.5, { text: v.handle }, { box: inSafe(f, 0.1, 0.64, 0.8, 0.08), size: "body", patch: { color: paper.sub, align: "left", weight: 500, shadow: undefined } })],
      ]; } }),
    // before / after
    T({ id: "compare.side", name: "Before / after · side by side", group: "Before/after", seconds: 6, blurb: "Before on the left, after on the right, with a divider and labels",
      fields: [{ key: "before", label: "Left label", value: "BEFORE" }, { key: "after", label: "Right label", value: "AFTER" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [kit.slot("Before", 0, 6, { effects: [{ type: "crop", params: { left: 0, right: 50, top: 0, bottom: 0, feather: 0 } }] })],
        [kit.slot("After", 0, 6, { effects: [{ type: "crop", params: { left: 50, right: 0, top: 0, bottom: 0, feather: 0 } }] })],
        [shapeLayer(f, 0, 6, [0.4985, 0, 0.003, 1], { kind: "rect", fill: "#ffffff" }, { name: "Divider", bleed: true, motion: "wipe" })],
        [label(f, 0.3, 5.7, v.before, inSafe(f, 0.02, 0.02, 0.4, 0.1))],
        [label(f, 0.5, 5.5, v.after, inSafe(f, 0.54, 0.02, 0.4, 0.1), "ink", true)],
      ]; } }),
    T({ id: "compare.stacked", name: "Before / after · top and bottom", group: "Before/after", seconds: 6, blurb: "Before above, after below: made for vertical videos",
      fields: [{ key: "before", label: "Top label", value: "BEFORE" }, { key: "after", label: "Bottom label", value: "AFTER" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [kit.slot("Before", 0, 6, { effects: [{ type: "crop", params: { left: 0, right: 0, top: 0, bottom: 50, feather: 0 } }] })],
        [kit.slot("After", 0, 6, { effects: [{ type: "crop", params: { left: 0, right: 0, top: 50, bottom: 0, feather: 0 } }] })],
        [shapeLayer(f, 0, 6, [0, 0.4985, 1, 0.003], { kind: "rect", fill: "#ffffff" }, { name: "Divider", bleed: true, motion: "wipe" })],
        [label(f, 0.3, 5.7, v.before, inSafe(f, 0.02, 0.02, 0.5, 0.08))],
        [label(f, 0.5, 5.5, v.after, inSafe(f, 0.02, 0.9, 0.5, 0.08), "ink", true)],
      ]; } }),
    // countdowns
    T({ id: "countdown.starting", name: "Countdown · starting soon", group: "Countdowns", seconds: 10, blurb: "A ten-second ring under “Starting soon”, for streams and premieres",
      fields: [{ key: "title", label: "Text", value: "Starting soon" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [gradientMatte(kit, "#0c1a33", ink.bg, 10)],
        [tt(f, "headline.cinematic.fade", 0, 10, { text: v.title }, { box: inSafe(f, 0, 0.06, 1, 0.2), size: "headline" })],
        [tt(f, "count.ring", 0, 10, { text: "#" }, { box: inSafe(f, 0.3, 0.36, 0.4, 0.46), size: "hero", look: { count: { from: 10, to: 0 } } })],
      ]; } }),
    T({ id: "countdown.leader", name: "Countdown · film leader", group: "Countdowns", seconds: 3, blurb: "An old film leader counting 3-2-1",
      fields: [],
      layers: (v, W, H) => { const f = frame(W, H); void v; return [
        [{ ...kit.matte("#d6d3d1", 0, 3, "Leader"), effects: [{ type: "old_film", params: { sepia: 0.5, noise: 0.35, noiseSize: 1, scratch: 0.5, scratchDensity: 0.4, scratchWidth: 1, vignetting: 0.45, vignettingAlpha: 1, vignettingBlur: 0.3 } }] }],
        [st(f, "ring", 0, 3, 0.5, 0.5, 0.6)],
        [tt(f, "count.big", 0, 3, { text: "#" }, { box: inSafe(f, 0.25, 0.2, 0.5, 0.6), size: "hero", patch: { color: amber.bg, outline: undefined, shadow: undefined }, look: { count: { from: 3, to: 0 } } })],
      ]; } }),
    T({ id: "countdown.launch", name: "Countdown · launch", group: "Countdowns", seconds: 6, blurb: "LIVE IN, five numbers, then GO! with a burst",
      fields: [{ key: "label", label: "Label", value: "LIVE IN" }, { key: "go", label: "Last word", value: "GO!" }],
      layers: (v, W, H) => { const f = frame(W, H); return [
        [kit.matte("#000000", 0, 6, "Background")],
        [label(f, 0, 5, v.label, inSafe(f, 0.32, 0.08, 0.36, 0.1), "broadcast", true)],
        [st(f, "burst", 5, 1, 0.5, 0.5, 0.5, "")],
        [tt(f, "count.big", 0, 5, { text: "#" }, { box: inSafe(f, 0.25, 0.22, 0.5, 0.56), size: "hero", look: { count: { from: 5, to: 0 } } }),
          tt(f, "headline.bold.pop", 5, 1, { text: v.go }, { box: inSafe(f, 0, 0.3, 1, 0.4), size: "hero" })],
      ]; } }),
  ];
}
