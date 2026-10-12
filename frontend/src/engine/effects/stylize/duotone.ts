/**
 * Duotone: the picture's tones mapped between two colours (shadows → highlights), with contrast and a mix. Our own.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "duotone", label: "Duotone", group: "Stylize", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "shadows", label: "Shadows", type: "color", default: "#1b1464" },
    { name: "highlights", label: "Highlights", type: "color", default: "#ff7a59" },
    { name: "contrast", label: "Contrast", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
    { name: "amount", label: "Mix", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float l = clamp(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  l = clamp((l - 0.5) * (1.0 + contrast) + 0.5, 0.0, 1.0);
  vec3 lin = mix(pow(shadows, vec3(2.2)), pow(highlights, vec3(2.2)), l);
  return vec4(mix(c.rgb, pow(lin, vec3(1.0 / 2.2)), amount), c.a);
}`,
};
export default def;
