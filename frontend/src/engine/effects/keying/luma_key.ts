/**
 * Luma key: makes dark (or bright) parts transparent, with a soft edge.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "luma_key", label: "Luma key", group: "Keying", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "threshold", label: "Threshold", type: "float", default: 0.1, min: 0, max: 1, step: 0.01 },
    { name: "softness", label: "Softness", type: "float", default: 0.1, min: 0, max: 1, step: 0.01 },
    { name: "invert", label: "Key out the bright parts", type: "bool", default: false },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float y = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  float a = smoothstep(threshold - softness * 0.5, threshold + softness * 0.5 + 1e-4, y);
  if (invert > 0.5) a = 1.0 - a;
  return vec4(c.rgb, c.a * a);
}`,
};
export default def;
