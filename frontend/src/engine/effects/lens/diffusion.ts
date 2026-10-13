/**
 * Diffusion (mist filter): the soft halo and lowered contrast of a black-mist / Pro-Mist style filter, strongest
 * around highlights. Our own: a half-size blur in two passes, screened back with a highlight-weighted halo.
 */
import { gaussian } from "../passes.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "diffusion", label: "Diffusion (mist)", group: "Lens", author: "Tatvam", license: "Proprietary",
  description: "A mist filter: halos around highlights, softer contrast",
  params: [
    { name: "strength", label: "Strength", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "radius", label: "Halo size", type: "float", default: 20, min: 1, max: 100, step: 0.5, unit: "px" },
    { name: "threshold", label: "Halo threshold", type: "float", default: 0.55, min: 0, max: 1, step: 0.01 },
    { name: "warmth", label: "Warmth", type: "float", default: 0.1, min: -1, max: 1, step: 0.01 },
  ],
  passes: [
    { scale: 0.5, glsl: `vec4 effect(vec2 uv) { return getColor(uv); }` },
    gaussian("radius", [1, 0], { scale: 0.5 }),
    gaussian("radius", [0, 1], { scale: 0.5 }),
    { glsl: `
vec4 effect(vec2 uv) {
  vec4 o = getOriginal(uv);
  vec3 b = getColor(uv).rgb;
  float l = dot(b, vec3(0.2126, 0.7152, 0.0722));
  vec3 halo = b * smoothstep(threshold, 1.0, l) * (1.0 + vec3(warmth, 0.0, -warmth) * 0.3);
  vec3 soft = mix(o.rgb, b, 0.25 * strength);
  vec3 s = 1.0 - (1.0 - clamp(soft, 0.0, 1.0)) * (1.0 - clamp(halo * strength * 1.5, 0.0, 1.0));
  return vec4(s, o.a);
}` },
  ],
};
export default def;
