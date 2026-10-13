/**
 * Crop: cuts the picture's edges away (transparent), in % of its size, with a soft edge.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "crop", label: "Crop", group: "Transform", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "left", label: "Left", type: "float", default: 0, min: 0, max: 100, step: 0.1, unit: "%" },
    { name: "right", label: "Right", type: "float", default: 0, min: 0, max: 100, step: 0.1, unit: "%" },
    { name: "top", label: "Top", type: "float", default: 0, min: 0, max: 100, step: 0.1, unit: "%" },
    { name: "bottom", label: "Bottom", type: "float", default: 0, min: 0, max: 100, step: 0.1, unit: "%" },
    { name: "feather", label: "Edge softness", type: "float", default: 0, min: 0, max: 200, step: 0.5, unit: "px" },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec2 lo = vec2(left, top) / 100.0, hi = 1.0 - vec2(right, bottom) / 100.0;
  vec2 f = max(vec2(feather * uScale), vec2(1.0)) / uResolution;
  vec2 a = clamp((uv - lo) / f + 0.5, 0.0, 1.0) * clamp((hi - uv) / f + 0.5, 0.0, 1.0);
  return vec4(c.rgb, c.a * a.x * a.y);
}`,
};
export default def;
