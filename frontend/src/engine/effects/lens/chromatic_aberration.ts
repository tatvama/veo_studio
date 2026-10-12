/**
 * Chromatic aberration: colour fringes growing toward the corners (red out, blue in, or the other way), as a real
 * lens shows them, with optional softening of the fringe. Our own GLSL.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "chromatic_aberration", label: "Chromatic aberration", group: "Lens", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "amount", label: "Amount", type: "float", default: 6, min: -40, max: 40, step: 0.1, unit: "px", description: "Fringe width at the corners" },
    { name: "falloff", label: "Falloff", type: "float", default: 1.5, min: 0.5, max: 4, step: 0.05, description: "How fast it grows toward the edges" },
    { name: "centre", label: "Centre", type: "point", default: [0.5, 0.5] },
    { name: "soft", label: "Soft fringe", type: "bool", default: true },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec2 asp = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 d = (uv - centre) * asp;
  float r = length(d) / length(0.5 * asp);
  vec2 dir = d / max(length(d), 1e-6) / asp;
  float k = amount * uScale * pow(r, falloff) / uResolution.y;
  vec4 c = getColor(uv);
  if (soft > 0.5) {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 6; i++) {
      float f = float(i) / 5.0;
      acc.r += getColor(uv + dir * k * mix(0.6, 1.0, f)).r;
      acc.g += getColor(uv + dir * k * mix(-0.15, 0.15, f)).g;
      acc.b += getColor(uv - dir * k * mix(0.6, 1.0, f)).b;
    }
    return vec4(acc / 6.0, c.a);
  }
  return vec4(getColor(uv + dir * k).r, c.g, getColor(uv - dir * k).b, c.a);
}`,
};
export default def;
