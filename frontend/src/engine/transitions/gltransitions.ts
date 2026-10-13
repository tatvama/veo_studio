/**
 * The transition catalogue: the 58 xfade ids (plain names), the 125 gl-transitions ("gl:<name>") and the wave-3 pack
 * ("tv:<name>": luma mattes, light, motion, glitch & retro, 3D; transitions/pack), each with the program source the
 * renderer compiles. gl-transitions loads on first use (its own chunk, ~215 KB). Those GLSL
 * sources are GLSL ES 1.00 (WebGL1 style: texture2D, no #version) and run as written: WebGL2 compiles them with a
 * 1.00 vertex shader. The two that need an extra texture (luma, displacement) get a generated noise image.
 */
import type { Transition as GlTransition } from "gl-transitions";
import { HEADER } from "../effects/shaders";
import type { TransitionParam } from "../types";
import { XFADE_GLSL, XFADE_GROUPS, XFADE_IDS, XFADE_MIPS, XFADE_PRELUDE, XFADE_TEXTURES } from "./xfade";
import { PACK, PACK_PREFIX, packSource, packTransition } from "./pack/index";

export interface TransitionParamInfo {
  name: string; type: string; default: TransitionParam; min?: number; max?: number; step?: number; color?: boolean; description?: string;
}
export interface TransitionInfo {
  id: string; label: string; group: string; tags: string[]; params: TransitionParamInfo[]; kind: "xfade" | "gl" | "custom" | "tv";
  author?: string; license?: string; description?: string;
  /** Extra sampler inputs the engine fills with a generated texture. */
  textures?: string[];
}
export interface TransitionProgram {
  id: string; name: string; source: string; glsl1: boolean;
  /** The inputs need a mip chain. */
  mips: boolean;
  /** Uniform defaults (gl-transitions params). */
  defaults: Record<string, TransitionParam>;
  types: Record<string, string>;
  /** Extra samplers: gl-transitions' own (a generated noise image), u_rand / u_rand2 (FFmpeg's frand tables) or
   *  u_matte (a pack luma matte). */
  textures: string[];
  /** Pack luma mattes: which matte the renderer generates into u_matte. */
  matte?: string;
}

let glList: GlTransition[] | null = null;

/** A transition registered at runtime: gl-transitions GLSL (`vec4 transition(vec2 uv)`, getFromColor / getToColor,
 *  `progress`, `ratio`; uv y up), its own uniforms declared in the GLSL and described by `params`. */
export interface CustomTransition {
  id: string; label: string; glsl: string; params?: TransitionParamInfo[];
  group?: string; author?: string; license?: string; description?: string;
}
const customs = new Map<string, CustomTransition>();

/** Adds (or replaces) a transition. Its id can't be an xfade id or start with "gl:" or "tv:". */
export function registerTransition(t: CustomTransition): void {
  if (!/^[a-z][a-z0-9_.:-]{0,63}$/i.test(t.id) || t.id.startsWith("gl:") || t.id.startsWith(PACK_PREFIX) || XFADE_IDS.includes(t.id)) throw new Error(`Transition id "${t.id}" isn't available`);
  if (!/vec4\s+transition\s*\(/.test(t.glsl)) throw new Error(`Transition "${t.id}" has no vec4 transition(vec2 uv)`);
  customs.set(t.id, { ...t, params: (t.params ?? []).map((p) => ({ ...p })) });
  cache.delete(t.id);
}
let loading: Promise<GlTransition[]> | null = null;

/** Loads gl-transitions (once). */
export function loadGl(): Promise<GlTransition[]> {
  if (glList) return Promise.resolve(glList);
  loading ??= import("gl-transitions").then((m) => {
    const list = (m as unknown as { default: GlTransition[] }).default ?? (m as unknown as GlTransition[]);
    glList = Array.isArray(list) ? list : [];
    return glList;
  });
  return loading;
}

const human = (name: string) => {
  const s = name.replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
};
const GROUP_TAGS: [string, string[]][] = [
  ["3D & flips", ["3d", "cube", "flip", "page", "curl", "fold", "rotate", "spin", "cards", "doors"]],
  ["Glitch & noise", ["glitch", "noise", "static", "datamosh", "flicker", "scanlines", "retro", "chromatic"]],
  ["Distort & warp", ["distort", "warp", "wave", "ripple", "water", "swirl", "displace", "melt", "morph", "lens", "kaleidoscope", "psychedelic"]],
  ["Zoom & blur", ["zoom", "blur", "motion-blur"]],
  ["Slides & pushes", ["slide", "push", "directional", "swap", "split", "bounce", "squeeze"]],
  ["Shapes & patterns", ["shape", "circle", "iris", "heart", "star", "hexagon", "pattern", "dots", "grid", "tiles", "squares", "blocks", "mosaic",
    "pixelate", "blinds", "stripes", "slices", "columns", "lines", "radial", "clock", "polar", "pinwheel", "shatter", "fragments", "box"]],
  ["Wipes", ["wipe", "mask", "luma"]],
  ["Light & colour", ["light", "light-leak", "flash", "burn", "fire", "glow", "color", "hue", "grayscale", "film", "fade", "dissolve", "blend"]],
];
const groupOf = (tags: string[]) => GROUP_TAGS.find(([, ts]) => tags.some((t) => ts.includes(t)))?.[0] ?? "Other";

function glParams(t: GlTransition): TransitionParamInfo[] {
  const ps = t.params && Object.keys(t.params).length ? t.params : null;
  const names = Object.keys(ps ?? t.paramsTypes ?? {});
  return names.filter((n) => !(t.textures ?? []).includes(n)).map((n) => {
    const p = ps?.[n];
    const type = p?.type ?? t.paramsTypes[n];
    const info: TransitionParamInfo = { name: n, type, default: (p?.default ?? t.defaultParams?.[n] ?? (type === "bool" ? false : 0)) as TransitionParam };
    if (p?.min !== undefined) info.min = p.min;
    if (p?.max !== undefined) info.max = p.max;
    if (p?.step !== undefined) info.step = p.step;
    if (p?.color) info.color = true;
    if (p?.description) info.description = p.description;
    return info;
  });
}

function xfadeInfos(): TransitionInfo[] {
  return XFADE_GROUPS.flatMap(([group, items]) => items.map(([id, label]) => ({ id, label, group, tags: ["ffmpeg"], params: [], kind: "xfade" as const })));
}

const packInfos = (): TransitionInfo[] => PACK.map((t) => ({
  id: PACK_PREFIX + t.id, label: t.label, group: t.group, tags: ["tatvam", ...(t.tags ?? []), ...(t.matte ? ["luma", "matte"] : [])], kind: "tv",
  author: "Tatvam", license: "Proprietary",
  params: t.params.map((p) => ({ name: p.name, type: p.type, default: (Array.isArray(p.default) ? [...p.default] : p.default) as TransitionParam,
    ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}), ...(p.step !== undefined ? { step: p.step } : {}),
    ...(p.color ? { color: true } : {}), ...(p.description ? { description: p.description } : {}) })),
}));

/** Every transition (xfade first, then gl-transitions, the tv: pack and the registered ones). Before gl-transitions has
 *  loaded, without the gl: ones. */
export function transitionInfos(): TransitionInfo[] {
  const gl = (glList ?? []).map((t): TransitionInfo => ({
    id: `gl:${t.name}`, label: human(t.name), group: groupOf(t.tags ?? []), tags: t.tags ?? [], params: glParams(t), kind: "gl",
    author: t.author, license: t.license, description: t.description, textures: t.textures?.length ? t.textures : undefined,
  }));
  const own = [...customs.values()].map((t): TransitionInfo => ({
    id: t.id, label: t.label, group: t.group ?? "Custom", tags: ["custom"], params: (t.params ?? []).map((p) => ({ ...p })), kind: "custom",
    author: t.author, license: t.license, description: t.description,
  }));
  return [...xfadeInfos(), ...gl, ...packInfos(), ...own];
}

export async function listTransitions(): Promise<TransitionInfo[]> {
  await loadGl().catch(() => []);
  return transitionInfos();
}

const GL_PRELUDE = `precision highp float;
precision highp int;
varying vec2 v_uv;
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float progress;
uniform float ratio;
vec4 getFromColor(vec2 uv) { return texture2D(u_from, vec2(uv.x, 1.0 - uv.y)); }
vec4 getToColor(vec2 uv) { return texture2D(u_to, vec2(uv.x, 1.0 - uv.y)); }
`;

const cache = new Map<string, TransitionProgram | null>();

/** The program for a transition id (null = unknown, or gl-transitions not loaded yet). */
export function transitionProgram(id: string): TransitionProgram | null {
  if (cache.has(id)) return cache.get(id)!;
  let out: TransitionProgram | null = null;
  const own = customs.get(id);
  if (own) {
    const params = own.params ?? [];
    out = { id, name: `custom:${id}`, glsl1: true, mips: false, textures: [],
      source: GL_PRELUDE + own.glsl + "\nvoid main() { gl_FragColor = transition(vec2(v_uv.x, 1.0 - v_uv.y)); }\n",
      defaults: Object.fromEntries(params.map((p) => [p.name, p.default])), types: Object.fromEntries(params.map((p) => [p.name, p.type])) };
  } else if (id.startsWith(PACK_PREFIX)) {
    const t = packTransition(id);
    if (t) out = { id, name: t.matte ? "tv:matte" : id, source: packSource(t), glsl1: false, mips: !!t.mips, textures: t.matte ? ["u_matte"] : [], matte: t.matte,
      defaults: Object.fromEntries(t.params.map((p) => [p.name, (Array.isArray(p.default) ? [...p.default] : p.default) as TransitionParam])),
      types: Object.fromEntries(t.params.map((p) => [p.name, p.type])) };
  } else if (XFADE_GLSL[id]) {
    out = { id, name: `xfade:${id}`, source: HEADER + XFADE_PRELUDE + XFADE_GLSL[id] + "\nvoid main() { o_color = transition(v_uv); }\n",
      glsl1: false, mips: XFADE_MIPS.has(id), defaults: {}, types: {}, textures: XFADE_TEXTURES[id] ?? [] };
  } else if (id.startsWith("gl:") && glList) {
    const t = glList.find((x) => x.name === id.slice(3));
    if (t) {
      const params = glParams(t);
      out = {
        id, name: id, glsl1: true, mips: false, textures: t.textures ?? [],
        source: GL_PRELUDE + t.glsl + "\nvoid main() { gl_FragColor = transition(vec2(v_uv.x, 1.0 - v_uv.y)); }\n",
        defaults: Object.fromEntries(params.map((p) => [p.name, p.default])), types: Object.fromEntries(params.map((p) => [p.name, p.type])),
      };
    }
  }
  if (out || glList || !id.startsWith("gl:")) cache.set(id, out);
  return out;
}

/** Uniform values: the defaults with the clip's params laid over them (unknown names and wrong shapes dropped). */
export function transitionUniforms(tp: TransitionProgram, params: Record<string, unknown> | undefined): Record<string, number | boolean | number[]> {
  const out: Record<string, number | boolean | number[]> = {};
  for (const [k, d] of Object.entries(tp.defaults)) {
    const v = params?.[k];
    const ok = v !== undefined && (Array.isArray(d) ? Array.isArray(v) && v.length === d.length && v.every((x) => Number.isFinite(Number(x)))
      : typeof d === "boolean" ? typeof v === "boolean" || typeof v === "number" : Number.isFinite(Number(v)));
    out[k] = (ok ? (Array.isArray(v) ? v.map(Number) : typeof d === "boolean" ? !!v : Number(v)) : d) as number | boolean | number[];
  }
  return out;
}

export const isKnownTransition = (id: string) => XFADE_IDS.includes(id) || customs.has(id) || !!packTransition(id) || (id.startsWith("gl:") && (!glList || glList.some((t) => t.name === id.slice(3))));
