/**
 * Sketch: a pencil drawing, the colour-dodge of the grey picture with its blurred negative, plus hatching that follows
 * the shadows and a paper texture; optionally keeps some colour. Our own (three passes).
 */
import { NOISE_GLSL } from "../glsl.ts";
import { gaussian } from "../passes.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "sketch", label: "Pencil sketch", group: "Stylize", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "radius", label: "Line softness", type: "float", default: 6, min: 1, max: 30, step: 0.5, unit: "px" },
    { name: "strength", label: "Line strength", type: "float", default: 1, min: 0, max: 2, step: 0.01 },
    { name: "hatching", label: "Hatching", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "colour", label: "Colour", type: "float", default: 0, min: 0, max: 1, step: 0.01 },
    { name: "paper", label: "Paper", type: "color", default: "#f4efe4" },
  ],
  passes: [
    { glsl: `vec4 effect(vec2 uv) { vec4 c = getColor(uv); return vec4(vec3(1.0 - dot(c.rgb, vec3(0.299, 0.587, 0.114))), 1.0); }` },
    gaussian("radius", [1, 0]),
    gaussian("radius", [0, 1]),
    { glsl: `${NOISE_GLSL}
vec4 effect(vec2 uv) {
  vec4 o = getOriginal(uv);
  float g = dot(o.rgb, vec3(0.299, 0.587, 0.114));
  float inv = getColor(uv).r;
  float dodge = clamp(g / max(1.0 - inv, 1e-3), 0.0, 1.0);
  float line = pow(dodge, 1.0 + strength * 2.0);
  vec2 p = uv * uResolution / max(uScale, 1e-3);
  float h1 = step(0.55, fract((p.x + p.y) / 6.0)), h2 = step(0.55, fract((p.x - p.y) / 6.0));
  float shade = 1.0 - hatching * (smoothstep(0.6, 0.2, g) * h1 * 0.35 + smoothstep(0.35, 0.05, g) * h2 * 0.35);
  float grain = 0.94 + 0.06 * nNoise(p * 0.7);
  vec3 col = paper * line * shade * grain;
  col = mix(col, col * mix(vec3(1.0), o.rgb / max(g, 0.05), 0.8), colour);
  return vec4(col, o.a);
}` },
  ],
};
export default def;
