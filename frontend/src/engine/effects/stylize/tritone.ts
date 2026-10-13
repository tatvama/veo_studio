/**
 * Tritone: the tones mapped through three colours (shadows, mid-tones, highlights), with a mid-point and a mix. Our own.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "tritone", label: "Tritone", group: "Stylize", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "shadows", label: "Shadows", type: "color", default: "#0b1d3a" },
    { name: "midtones", label: "Mid-tones", type: "color", default: "#b4505a" },
    { name: "highlights", label: "Highlights", type: "color", default: "#ffe7b3" },
    { name: "midpoint", label: "Mid-point", type: "float", default: 0.5, min: 0.1, max: 0.9, step: 0.01 },
    { name: "amount", label: "Mix", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float l = clamp(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  vec3 a = pow(shadows, vec3(2.2)), m = pow(midtones, vec3(2.2)), h = pow(highlights, vec3(2.2));
  vec3 lin = l < midpoint ? mix(a, m, smoothstep(0.0, 1.0, l / midpoint)) : mix(m, h, smoothstep(0.0, 1.0, (l - midpoint) / (1.0 - midpoint)));
  return vec4(mix(c.rgb, pow(lin, vec3(1.0 / 2.2)), amount), c.a);
}`,
};
export default def;
