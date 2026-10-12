/**
 * The wave-3 transition pack ("tv:<id>", docs/EDITOR.md §10): 68 luma mattes, 14 light, 17 motion, 8 glitch & retro
 * and 13 3D transitions, all our own GLSL. Each compiles to `HEADER + PACK_PRELUDE + its uniforms + its GLSL`; the
 * luma mattes share one program and differ only in the matte texture the renderer generates (`u_matte`). Pure.
 */
import { HEADER } from "../../effects/shaders.ts";
import { COLOR_GLSL, GEOM_GLSL, NOISE_GLSL } from "../../effects/glsl.ts";
import { GLITCH } from "./glitch.ts";
import { LIGHT } from "./light.ts";
import { MATTE_HELPERS, MATTES, matteFunction, type MatteDef } from "./mattes.ts";
import { MOTION } from "./motion.ts";
import { THREED } from "./threed.ts";
import type { PackParam, PackTransition } from "./types.ts";

export type { PackGroup, PackParam, PackTransition } from "./types.ts";
export { PACK_GROUPS } from "./types.ts";

export const PACK_PREFIX = "tv:";

export const PACK_PRELUDE = `
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float progress;
uniform float ratio;
uniform float u_pm;   // the inputs are premultiplied layers (a track above another): the background is transparent
const float PI = 3.141592653589793;
vec4 getFromColor(vec2 uv) { return texture(u_from, uv); }
vec4 getToColor(vec2 uv) { return texture(u_to, uv); }
vec4 bgColor() { return u_pm > 0.5 ? vec4(0.0) : vec4(0.0, 0.0, 0.0, 1.0); }
${NOISE_GLSL}${GEOM_GLSL}${COLOR_GLSL}`;

/** One shader for every luma matte: the matte (equalised 0..1) sweeps from 0 to 1 with a soft or glowing edge. */
const MATTE_GLSL = `
uniform sampler2D u_matte;
vec4 transition(vec2 uv) {
  vec2 p = gRot(radians(angle)) * ((uv - 0.5) * vec2(ratio, 1.0));
  float m = texture(u_matte, clamp(p / vec2(ratio, 1.0) + 0.5, 0.0, 1.0)).r;
  if (invert > 0.5) m = 1.0 - m;
  float s = max(softness, 1e-4);
  float e = progress * (1.0 + s);
  float k = smoothstep(e - s, e, m);
  vec4 c = mix(getToColor(uv), getFromColor(uv), k);
  if (edge > 0.0) {
    float band = 1.0 - smoothstep(0.0, edge, abs(m - (e - s * 0.5)));
    c.rgb += edge_color * band * 1.6 * sin(progress * PI) * max(c.a, 0.0);
  }
  return c;
}`;

const matteParams = (d: MatteDef): PackParam[] => [
  { name: "softness", type: "float", default: d.softness ?? 0.04, min: 0, max: 0.5, step: 0.005 },
  { name: "invert", type: "bool", default: false, description: "Run the pattern the other way" },
  { name: "angle", type: "float", default: 0, min: -180, max: 180, step: 1, description: "Turn the pattern (degrees)" },
  { name: "edge", type: "float", default: d.edge?.[0] ?? 0, min: 0, max: 0.2, step: 0.005, description: "Glowing edge width" },
  { name: "edge_color", type: "vec3", default: d.edge ? d.edge.slice(1) : [1, 0.5, 0.1], color: true },
];

export const LUMA: PackTransition[] = MATTES.map((d) => ({ id: `matte_${d.id}`, label: d.label, group: "Luma mattes", glsl: MATTE_GLSL, params: matteParams(d), matte: d.id }));

export const PACK: PackTransition[] = [...LUMA, ...LIGHT, ...MOTION, ...GLITCH, ...THREED];
const byId = new Map(PACK.map((t) => [PACK_PREFIX + t.id, t]));
export const packTransition = (id: string) => byId.get(id);

const glslType = (t: PackParam["type"]) => (t === "vec2" || t === "vec3" || t === "vec4" ? t : "float");

/** The fragment shader of a pack transition. */
export function packSource(t: PackTransition): string {
  const decl = t.params.map((p) => `uniform ${glslType(p.type)} ${p.name};`).join("\n");
  return `${HEADER}${PACK_PRELUDE}\n${decl}\n#line 1\n${t.glsl}\nvoid main() { o_color = transition(v_uv); }\n`;
}

/** The matte generator: `uFinal` 0 writes the raw value, 1 the equalised one (through `uCurve` over `uRange`). */
export function matteSource(d: MatteDef): string {
  return `${HEADER}
uniform vec4 uSeed;
uniform float uAsp;
uniform float uFinal;
uniform vec2 uRange;
uniform sampler2D uCurve;
${NOISE_GLSL}${GEOM_GLSL}${MATTE_HELPERS}
#line 1
${matteFunction(d)}
void main() {
  vec2 uv = v_uv;
  float m = matteOf((uv - 0.5) * vec2(uAsp, 1.0), uv);
  if (uFinal > 0.5) {
    float x = clamp((m - uRange.x) / max(uRange.y - uRange.x, 1e-9), 0.0, 1.0);
    m = texture(uCurve, vec2(x * (1023.0 / 1024.0) + 0.5 / 1024.0, 0.5)).r;
  }
  o_color = vec4(m, m, m, 1.0);
}
`;
}
