/**
 * Vignette (pro): darken or lighten toward the edges with control over size, roundness, feather and colour, keeping
 * the highlights if asked; works in display light so it looks like a lens falloff. Our own GLSL.
 */
import { COLOR_GLSL } from "../glsl.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "vignette_pro", label: "Vignette (pro)", group: "Lens", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "amount", label: "Amount", type: "float", default: 0.5, min: -1, max: 1, step: 0.01, description: "Negative lightens the edges" },
    { name: "size", label: "Size", type: "float", default: 0.55, min: 0, max: 1.5, step: 0.01 },
    { name: "roundness", label: "Roundness", type: "float", default: 0.5, min: 0, max: 1, step: 0.01, description: "0 follows the frame, 1 is a circle" },
    { name: "feather", label: "Feather", type: "float", default: 0.5, min: 0.01, max: 1, step: 0.01 },
    { name: "centre", label: "Centre", type: "point", default: [0.5, 0.5] },
    { name: "color", label: "Colour", type: "color", default: "#000000" },
    { name: "highlights", label: "Protect highlights", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `${COLOR_GLSL}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec2 asp = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 d = (uv - centre) * 2.0;
  vec2 dr = d * mix(vec2(1.0), asp / max(asp.x, 1.0), roundness);
  float sq = pow(pow(abs(dr.x), 4.0) + pow(abs(dr.y), 4.0), 0.25);
  float r = mix(sq, length(dr), roundness);
  float m = smoothstep(size, size + feather * 1.2, r);
  vec3 lin = pow(max(c.rgb, 0.0), vec3(2.4));
  float prot = 1.0 - highlights * smoothstep(0.6, 1.0, cLuma(clamp(c.rgb, 0.0, 1.0)));
  vec3 outc;
  if (amount >= 0.0) outc = mix(lin, pow(color, vec3(2.4)), m * amount * prot);
  else outc = mix(lin, vec3(1.0), m * -amount * 0.6);
  return vec4(pow(max(outc, 0.0), vec3(1.0 / 2.4)), c.a);
}`,
};
export default def;
