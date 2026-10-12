/**
 * Halation: the red-orange glow film gets around bright highlights (light scattered back through the emulsion). Our
 * own: highlights extracted at half size, blurred in two passes, tinted and added.
 */
import { gaussian } from "../passes.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "halation", label: "Halation", group: "Film", author: "Tatvam", license: "Proprietary",
  description: "A red glow around bright highlights, as on film",
  params: [
    { name: "amount", label: "Amount", type: "float", default: 0.6, min: 0, max: 2, step: 0.01 },
    { name: "threshold", label: "Threshold", type: "float", default: 0.7, min: 0, max: 1, step: 0.01 },
    { name: "radius", label: "Radius", type: "float", default: 14, min: 1, max: 80, step: 0.5, unit: "px" },
    { name: "tint", label: "Tint", type: "color", default: "#ff4a1c" },
  ],
  passes: [
    { scale: 0.5, glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float l = max(c.r, max(c.g, c.b));
  float k = smoothstep(threshold, min(threshold + 0.25, 1.0), l);
  return vec4(c.rgb * k * c.a, 1.0);
}` },
    gaussian("radius", [1, 0], { scale: 0.5 }),
    gaussian("radius", [0, 1], { scale: 0.5 }),
    { glsl: `
vec4 effect(vec2 uv) {
  vec4 o = getOriginal(uv);
  vec3 h = getColor(uv).rgb;
  float e = dot(h, vec3(0.3, 0.5, 0.2));
  vec3 glow = tint * e * amount * 1.6;
  return vec4(o.rgb + glow * (1.0 - 0.5 * clamp(o.rgb, 0.0, 1.0)), o.a);
}` },
  ],
};
export default def;
