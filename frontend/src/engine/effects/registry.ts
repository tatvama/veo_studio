/**
 * The effect registry (docs/EDITOR.md §4, §6). An effect declares its parameters (the UI builds its controls from
 * them) and either GLSL — one pass, or several chained — or, for the built-in FFmpeg-matched ones, a render function
 * the renderer gives a small API. Custom GLSL effects register at runtime with the same shape.
 *
 * GLSL contract (GLSL ES 3.00; `texture2D` also works): define `vec4 effect(vec2 uv)`, uv 0..1 with y DOWN (row 0
 * at the top). Available: `getColor(uv)` (this pass's input), `getOriginal(uv)` (the effect's input), `uResolution`
 * (target pixels), `uInputSize` (input pixels), `uTime` (seconds into the clip), `uFrame`, `uScale` (render pixels per
 * composition pixel: multiply pixel-sized parameters by it), `uIteration` (repeated passes), `uPass0..2` (earlier
 * passes' outputs). Every parameter is a uniform of its own name, declared for you unless the GLSL declares it.
 * Pure module (no GPU): the renderer compiles and runs what it describes.
 */
import { bakeCurves } from "../curves.ts";
import { isParam, paramAt, parseHex } from "../keyframes.ts";
import type { EffectInstance } from "../types.ts";

export type EffectGroup = "Colour" | "Keying" | "Blur & Sharpen" | "Distort" | "Stylize" | "Light" | "Generate" | "Transform";
export const EFFECT_GROUPS: EffectGroup[] = ["Colour", "Keying", "Blur & Sharpen", "Distort", "Stylize", "Light", "Generate", "Transform"];

export type ParamType = "float" | "int" | "bool" | "angle" | "color" | "rgba" | "rgb" | "vec2" | "point" | "enum" | "curve" | "image" | "string" | "matrix3";

export interface EffectParamDef {
  name: string; label: string; type: ParamType; default: unknown;
  min?: number; max?: number; step?: number;
  /** enum: the choices (value sent to the shader: the number, else the choice's index). */
  options?: { value: string | number; label: string }[];
  /** A unit shown next to the control ("px", "%", "°"). Pixel values are composition pixels. */
  unit?: string;
  description?: string;
}

export type ParamValues = Record<string, unknown>;
export type UniformMap = Record<string, number | boolean | number[] | Float32Array>;

/** w, h: this pass's target; inW, inH: its input; t: seconds into the clip; frame: on the cut; scale: target pixels per
 *  composition pixel; iteration: of a repeated pass; duration: the clip's seconds. */
export interface PassContext { w: number; h: number; inW: number; inH: number; t: number; frame: number; scale: number; iteration: number; duration: number; fps: number }

export interface EffectPass {
  glsl: string;
  /** Target size as a factor of the effect's input (0.5 = half size). Default 1. */
  scale?: number;
  /** Run this pass n times in a row (each sees the last as getColor()). */
  repeat?: (p: ParamValues) => number;
  uniforms?: (p: ParamValues, c: PassContext) => UniformMap;
  /** Sample the input with nearest-neighbour filtering (pixel-art effects). */
  nearest?: boolean;
}

/** What a built-in effect's `render` gets from the renderer (opaque handles to GPU images). */
export interface EffectApi {
  input: unknown; w: number; h: number; values: ParamValues; t: number; frame: number; scale: number; duration: number; fps: number;
  /** The FFmpeg-matched clip pipeline (fx keys) on the input. */
  legacy(fx: Record<string, unknown>): unknown;
}

export interface EffectDef {
  id: string; label: string; group: EffectGroup; params: EffectParamDef[];
  description?: string; author?: string; license?: string;
  /** Where a port comes from ("pixi-filters 6.1.5 / BloomFilter"). */
  source?: string;
  /** One pass. */
  glsl?: string;
  /** Several passes (`glsl` is ignored). */
  passes?: EffectPass[];
  /** Computed uniforms for every pass (beyond the parameters). */
  uniforms?: (p: ParamValues, c: PassContext) => UniformMap;
  /** Built-in effects drive the renderer themselves. */
  render?: (api: EffectApi) => unknown;
  /** Composition pixels the effect draws outside the picture (shadows, glows, outlines). */
  pad?: (p: ParamValues) => number;
  /** False for the effects the FFmpeg render also draws (look, adjust). Default true. */
  gpuOnly?: boolean;
  /** Runtime-registered (custom GLSL). */
  custom?: boolean;
}

export interface EffectInfo {
  id: string; label: string; group: EffectGroup; params: EffectParamDef[]; gpuOnly: boolean; custom: boolean;
  description?: string; author?: string; license?: string; source?: string;
  /** The parameter names (the first listEffects() shape). */
  keys: string[];
}

const registry = new Map<string, EffectDef>();

const ID = /^[a-z][a-z0-9_.:-]{0,63}$/i;
const UNIFORM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Adds (or replaces) an effect. Throws on a malformed definition. */
export function registerEffect(def: EffectDef): void {
  if (!ID.test(def.id)) throw new Error(`Effect id "${def.id}" isn't valid`);
  if (!def.glsl && !def.passes?.length && !def.render) throw new Error(`Effect "${def.id}" has no GLSL`);
  for (const p of def.params) if (!UNIFORM_NAME.test(p.name)) throw new Error(`Effect "${def.id}": parameter "${p.name}" isn't a valid GLSL name`);
  registry.set(def.id, def);
}
export const getEffect = (id: string) => registry.get(id);
export const effectDefs = () => [...registry.values()];

export function listEffectInfos(): EffectInfo[] {
  return effectDefs().map((d) => ({
    id: d.id, label: d.label, group: d.group, params: d.params.map((p) => ({ ...p, options: p.options?.map((o) => ({ ...o })) })),
    gpuOnly: d.gpuOnly !== false, custom: !!d.custom, description: d.description, author: d.author, license: d.license, source: d.source,
    keys: d.params.map((p) => p.name),
  }));
}

/** The instance's parameter values `t` seconds into the clip (defaults for the ones it doesn't set). */
export function paramValues(def: EffectDef, inst: EffectInstance | undefined, t: number, fps: number): ParamValues {
  const out: ParamValues = {};
  for (const p of def.params) {
    const raw = inst?.params?.[p.name];
    let v = raw === undefined ? p.default : isParam(raw) ? paramAt(raw, t, fps) : raw;
    if (v === undefined || v === null) v = p.default;
    if (typeof v === "number" && (p.type === "float" || p.type === "int" || p.type === "angle")) {
      if (p.type === "int") v = Math.round(v);
    }
    out[p.name] = v;
  }
  return out;
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "boolean" ? (v ? 1 : 0) : d);
const vec = (v: unknown, n: number, d: number[]) =>
  Array.isArray(v) ? Array.from({ length: n }, (_, i) => num(v[i], d[i] ?? 0)) : d.slice(0, n);

/** "#RRGGBB" | [r, g, b(, a)] → n components (alpha 1 when missing). */
export function colorOf(v: unknown, n: 3 | 4): number[] {
  const h = parseHex(v);
  if (h) return h.slice(0, n);
  if (Array.isArray(v)) return vec(v, n, [0, 0, 0, 1]);
  if (typeof v === "number") return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1].slice(0, n);
  return [0, 0, 0, 1].slice(0, n);
}

/** GLSL type of a parameter's uniform (null: not a uniform). */
export function glslType(t: ParamType): string | null {
  switch (t) {
    case "float": case "int": case "bool": case "angle": case "enum": return "float";
    case "color": case "rgb": return "vec3";
    case "rgba": return "vec4";
    case "vec2": case "point": return "vec2";
    case "matrix3": return "mat3";
    case "curve": case "image": return "sampler2D";
    default: return null;
  }
}

/** Parameter values → uniform values (textures — curves, images — are left to the renderer). */
export function paramUniforms(def: EffectDef, v: ParamValues): UniformMap {
  const u: UniformMap = {};
  for (const p of def.params) {
    const x = v[p.name];
    switch (p.type) {
      case "float": case "int": case "angle": u[p.name] = num(x, num(p.default)); break;
      case "bool": u[p.name] = x ? 1 : 0; break;
      case "enum": {
        const opts = p.options ?? [];
        const o = opts.find((q) => q.value === x) ?? opts.find((q) => String(q.value) === String(x)) ?? opts[0];  // a select hands back strings
        u[p.name] = o ? (typeof o.value === "number" ? o.value : opts.indexOf(o)) : num(x);
        break;
      }
      case "color": u[p.name] = colorOf(x, 3); break;
      case "rgba": u[p.name] = colorOf(x, 4); break;
      case "rgb": u[p.name] = vec(x, 3, vec(p.default, 3, [0, 0, 0])); break;
      case "vec2": case "point": u[p.name] = vec(x, 2, vec(p.default, 2, [0, 0])); break;
      case "matrix3": u[p.name] = vec(x, 9, vec(p.default, 9, [0, 0, 0, 0, 1, 0, 0, 0, 0])); break;
      default: break;
    }
  }
  return u;
}

/** A curve parameter baked for its sampler (256×1 RGBA float: the same curve on r, g, b). */
export function curveTexels(points: unknown): Float32Array {
  const pts: [number, number][] = Array.isArray(points) ? (points as [number, number][]) : [[0, 0], [1, 1]];
  return bakeCurves({ master: pts });
}

export const EFFECT_PRELUDE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_uv;
out vec4 o_color;
uniform sampler2D uInput;
uniform sampler2D uOriginal;
uniform vec2 uResolution;
uniform vec2 uInputSize;
uniform float uTime;
uniform float uFrame;
uniform float uScale;
uniform float uIteration;
#define texture2D texture
vec4 getColor(vec2 uv) { return texture(uInput, uv); }
vec4 getOriginal(vec2 uv) { return texture(uOriginal, uv); }
`;

/** The full fragment shader of one pass: prelude, the parameters' uniforms the GLSL doesn't declare, the body. */
export function effectSource(def: EffectDef, glsl: string): string {
  const decl: string[] = [];
  for (const p of def.params) {
    const ty = glslType(p.type);
    if (!ty || new RegExp(`uniform\\s+(?:(?:lowp|mediump|highp)\\s+)?\\w+\\s+${p.name}\\b`).test(glsl)) continue;
    decl.push(`uniform ${ty} ${p.name};`);
  }
  for (const k of [0, 1, 2]) if (glsl.includes(`uPass${k}`) && !new RegExp(`uniform\\s+sampler2D\\s+uPass${k}\\b`).test(glsl)) decl.push(`uniform sampler2D uPass${k};`);
  return `${EFFECT_PRELUDE}${decl.join("\n")}\n#line 1\n${glsl}\nvoid main() { o_color = effect(v_uv); }\n`;
}

/** The passes an effect runs (one for a plain `glsl`). */
export const passesOf = (def: EffectDef): EffectPass[] => def.passes?.length ? def.passes : def.glsl ? [{ glsl: def.glsl }] : [];
