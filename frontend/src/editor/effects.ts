/**
 * The effects the editor offers, with their declared parameters (name, type, default, range, label) the Effect
 * Controls build their controls from. Video effects are the engine's `listEffects()` (editor/engine.ts) joined with
 * these declarations; audio effects are the editor's own (the WebAudio preview plays gain, EQ, compressor and limiter).
 * TODO(engine): the engine's EffectInfo carries only `keys`; when it declares params (min/max/default) they win.
 */
import { ADJUST_INFO, MOVE_LABELS, type AdjustKey, type MoveKind } from "../lib/fx";
import { uid } from "./model/ids";
import type { EffectInstance, Param } from "./model/types";
import { effectGroups, listEffects, onCatalog, type EngineEffect, type EngineParam } from "./engine";

/** An engine-declared parameter as an editor control (image / matrix parameters aren't editable here). */
function fromEngineParam(p: EngineParam): ParamDef | null {
  const base = { name: p.name, label: p.label || p.name, default: p.default, min: p.min, max: p.max, unit: p.unit };
  switch (p.type) {
    case "float": case "angle": return { ...base, type: "number", step: p.step ?? 0.01, animatable: true };
    case "int": return { ...base, type: "number", step: p.step ?? 1, animatable: true };
    case "bool": return { ...base, type: "bool" };
    case "enum": return { ...base, type: "select", options: (p.options ?? []).map((o) => ({ value: String(o.value), label: o.label })) };
    case "color": case "rgb": case "rgba": return typeof p.default === "string" ? { ...base, type: "color" } : { ...base, type: "rgb", step: 0.01, animatable: true };
    case "vec2": case "point": return { ...base, type: "pair", step: p.step ?? 0.01, animatable: true };
    case "curve": return { ...base, type: "curve" };
    case "string": return { ...base, type: "text" };
    default: return null;
  }
}

export type ParamType = "number" | "select" | "bool" | "color" | "rgb" | "pair" | "curve" | "text";
export interface ParamDef {
  name: string; label: string; type: ParamType; default: unknown;
  min?: number; max?: number; step?: number; unit?: string; options?: { value: string; label: string }[];
  /** Can be keyframed (numbers and colours triples). */
  animatable?: boolean;
}
export interface EffectDef {
  id: string; label: string; group: string; kind: "video" | "audio"; params: ParamDef[]; gpuOnly?: boolean; note?: string;
  custom?: boolean; author?: string; license?: string; source?: string;
}

export const LOOKS: { value: string; label: string }[] = [
  ["none", "None"], ["cinematic", "Cinematic"], ["teal_orange", "Teal & orange"], ["warm", "Warm"], ["golden_hour", "Golden hour"], ["cool", "Cool"],
  ["moonlight", "Moonlight"], ["vivid", "Vivid"], ["pastel", "Pastel"], ["vintage", "Vintage"], ["faded_film", "Faded film"], ["cross_process", "Cross process"],
  ["bleach_bypass", "Bleach bypass"], ["high_contrast", "High contrast"], ["matte", "Matte"], ["noir", "Noir"], ["black_white", "Black & white"],
  ["sepia", "Sepia"], ["negative", "Negative"],
].map(([value, label]) => ({ value, label }));

const n = (name: string, label: string, def: number, min: number, max: number, step = 0.01, unit?: string): ParamDef =>
  ({ name, label, type: "number", default: def, min, max, step, unit, animatable: true });

const ADJUST: ParamDef[] = (Object.keys(ADJUST_INFO) as AdjustKey[]).map((k) => n(k, ADJUST_INFO[k].label, 0, ADJUST_INFO[k].min, 1));

export const EFFECT_DEFS: Record<string, EffectDef> = {
  look: { id: "look", label: "Look / LUT", group: "Colour", kind: "video", params: [
    { name: "look", label: "Look", type: "select", default: "cinematic", options: LOOKS }, n("lut_strength", "Strength", 1, 0, 1)] },
  adjust: { id: "adjust", label: "Adjust", group: "Colour", kind: "video", params: ADJUST },
  wheels: { id: "wheels", label: "Colour wheels", group: "Colour", kind: "video", gpuOnly: true, params: [
    { name: "lift", label: "Lift", type: "rgb", default: [0, 0, 0], min: -1, max: 1, step: 0.01, animatable: true },
    { name: "gamma", label: "Gamma", type: "rgb", default: [0, 0, 0], min: -1, max: 1, step: 0.01, animatable: true },
    { name: "gain", label: "Gain", type: "rgb", default: [0, 0, 0], min: -1, max: 1, step: 0.01, animatable: true }] },
  curves: { id: "curves", label: "Curves", group: "Colour", kind: "video", gpuOnly: true, params: [
    { name: "master", label: "Master", type: "curve", default: [[0, 0], [1, 1]] }, { name: "r", label: "Red", type: "curve", default: [[0, 0], [1, 1]] },
    { name: "g", label: "Green", type: "curve", default: [[0, 0], [1, 1]] }, { name: "b", label: "Blue", type: "curve", default: [[0, 0], [1, 1]] }] },
  chroma: { id: "chroma", label: "Chroma key", group: "Keying", kind: "video", gpuOnly: true, params: [
    { name: "color", label: "Key colour", type: "color", default: "#00ff00" }, n("similarity", "Similarity", 0.3, 0, 1), n("smoothness", "Smoothness", 0.1, 0, 1), n("spill", "Spill", 0.3, 0, 1)] },
  mask: { id: "mask", label: "Mask", group: "Keying", kind: "video", gpuOnly: true, params: [
    { name: "shape", label: "Shape", type: "select", default: "ellipse", options: [{ value: "rect", label: "Rectangle" }, { value: "ellipse", label: "Ellipse" }] },
    n("x", "Centre X", 0.5, 0, 1), n("y", "Centre Y", 0.5, 0, 1), n("w", "Width", 0.6, 0, 1), n("h", "Height", 0.6, 0, 1),
    n("rotation", "Rotation", 0, -180, 180, 0.5, "°"), n("feather", "Feather", 0.1, 0, 1), { name: "invert", label: "Invert", type: "bool", default: false }] },
  glow: { id: "glow", label: "Glow", group: "Stylize", kind: "video", gpuOnly: true, params: [n("amount", "Amount", 0.5, 0, 1), n("threshold", "Threshold", 0.7, 0, 1), n("radius", "Radius", 0.3, 0, 1)] },
  flip: { id: "flip", label: "Flip", group: "Transform", kind: "video", params: [
    { name: "flip_h", label: "Horizontal", type: "bool", default: true }, { name: "flip_v", label: "Vertical", type: "bool", default: false }] },
  move: { id: "move", label: "Camera move (Ken Burns)", group: "Transform", kind: "video", params: [
    { name: "kind", label: "Move", type: "select", default: "zoom_in", options: (Object.keys(MOVE_LABELS) as MoveKind[]).map((k) => ({ value: k, label: MOVE_LABELS[k] })) },
    n("amount", "Amount", 0.12, 0, 0.5)] },
  // audio (the editor's own; the export mixes them with FFmpeg)
  "audio:gain": { id: "audio:gain", label: "Gain", group: "Audio", kind: "audio", params: [n("gain", "Gain", 0, -24, 24, 0.1, "dB")] },
  "audio:eq": { id: "audio:eq", label: "EQ (3-band)", group: "Audio", kind: "audio", params: [n("low", "Low", 0, -12, 12, 0.1, "dB"), n("mid", "Mid", 0, -12, 12, 0.1, "dB"), n("high", "High", 0, -12, 12, 0.1, "dB")] },
  "audio:compressor": { id: "audio:compressor", label: "Compressor", group: "Audio", kind: "audio", params: [
    n("threshold", "Threshold", -24, -60, 0, 0.5, "dB"), n("ratio", "Ratio", 4, 1, 20, 0.1, ":1"), n("attack", "Attack", 0.01, 0, 1, 0.001, "s"), n("release", "Release", 0.25, 0, 1, 0.01, "s")] },
  "audio:limiter": { id: "audio:limiter", label: "Limiter", group: "Audio", kind: "audio", params: [n("ceiling", "Ceiling", -1, -12, 0, 0.1, "dB")] },
  "audio:gate": { id: "audio:gate", label: "Noise gate", group: "Audio", kind: "audio", note: "Applied in the export (not in the preview)", params: [n("threshold", "Threshold", -50, -90, 0, 0.5, "dB")] },
};

/** Effects the editor handles elsewhere: speed (Time) and fades (transitions / Opacity). */
const HIDDEN = new Set(["speed", "fade"]);

let videoP: Promise<EffectDef[]> | null = null;
let known: EffectDef[] = [];
// a custom shader registered: list again
onCatalog(() => { videoP = null; });
/** The video effects: the engine's list, with the declared params (an engine effect without a declaration gets number sliders). */
export function videoEffects(): Promise<EffectDef[]> {
  videoP ??= Promise.all([listEffects(), effectGroups()]).then(([list, groups]: [EngineEffect[], readonly string[]]) => {
    const out: EffectDef[] = [];
    const seen = new Set<string>();
    for (const e of list) {
      if (HIDDEN.has(e.id)) continue;
      seen.add(e.id);
      // the engine's declared parameters win; else the editor's own declaration; else plain sliders from the keys
      const declared = e.params?.map(fromEngineParam).filter((x): x is ParamDef => !!x);
      const mine = EFFECT_DEFS[e.id];
      out.push({
        id: e.id, label: e.label || mine?.label || e.id, group: e.group ?? mine?.group ?? "Other", kind: "video", gpuOnly: e.gpuOnly,
        params: declared?.length || e.params ? declared ?? [] : mine?.params ?? (e.keys ?? []).map((k) => n(k, k, 0, -1, 1)), note: e.description,
        custom: e.custom, author: e.author, license: e.license, source: e.source,
      });
    }
    if (!list.length) for (const d of Object.values(EFFECT_DEFS)) if (d.kind === "video" && !seen.has(d.id)) out.push(d);
    // the registry's group order, custom effects last
    const gi = (g: string) => { const i = groups.indexOf(g); return i < 0 ? groups.length : i; };
    out.sort((a, b) => Number(!!a.custom) - Number(!!b.custom) || gi(a.group) - gi(b.group) || a.label.localeCompare(b.label));
    known = out;
    return out;
  });
  return videoP;
}
export const audioEffects = (): EffectDef[] => Object.values(EFFECT_DEFS).filter((d) => d.kind === "audio");

export const effectDef = (type: string): EffectDef | undefined => EFFECT_DEFS[type];

/** A new instance of an effect with its defaults. */
export function makeEffect(type: string, defs: EffectDef[] = known): EffectInstance {
  const d = defs.find((x) => x.id === type) ?? EFFECT_DEFS[type];
  const params: Record<string, Param<unknown>> = {};
  for (const p of d?.params ?? []) params[p.name] = { value: Array.isArray(p.default) ? JSON.parse(JSON.stringify(p.default)) : p.default };
  return { id: uid("e"), type, enabled: true, params };
}

/** Effect defaults (Reset). */
export function effectDefaults(type: string): Record<string, Param<unknown>> { return makeEffect(type).params; }
