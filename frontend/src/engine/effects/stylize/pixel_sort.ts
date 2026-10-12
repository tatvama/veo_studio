/**
 * Pixel sort: streaks where bright pixels "sort" along a direction, a glitch-art look. An approximation on the GPU (a
 * windowed maximum of brightness along the direction, within a brightness band). Our own GLSL.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "pixel_sort", label: "Pixel sort", group: "Stylize", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "length_", label: "Length", type: "float", default: 120, min: 4, max: 600, step: 1, unit: "px" },
    { name: "low", label: "Band low", type: "float", default: 0.35, min: 0, max: 1, step: 0.01 },
    { name: "high", label: "Band high", type: "float", default: 0.95, min: 0, max: 1, step: 0.01 },
    { name: "angle", label: "Direction", type: "angle", default: 90, min: -180, max: 180, step: 1, unit: "°" },
    { name: "amount", label: "Mix", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c0 = getColor(uv);
  vec2 dir = vec2(cos(radians(angle)), sin(radians(angle))) * length_ * uScale / uResolution;
  vec4 best = c0;
  float bl = dot(c0.rgb, vec3(0.2126, 0.7152, 0.0722));
  for (int i = 1; i <= 32; i++) {
    vec2 q = uv - dir * float(i) / 32.0;
    if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) break;
    vec4 c = getColor(q);
    float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    if (l < low || l > high) break;
    if (l > bl) { best = c; bl = l; }
  }
  return mix(c0, best, amount);
}`,
};
export default def;
