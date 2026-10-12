/**
 * Anamorphic flare: long horizontal streaks from the highlights, as an anamorphic lens draws them (blue by default).
 * Our own: highlights at a quarter of the height, a long horizontal blur in two passes, tinted and added.
 */
import type { EffectDef, EffectPass } from "../registry.ts";

const streak = (k: number): EffectPass => ({
  scale: 0.25,
  glsl: `
vec4 effect(vec2 uv) {
  float len = length_ * uScale * ${k.toFixed(2)};
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  for (int i = -24; i <= 24; i++) {
    float x = float(i) / 24.0;
    float w = exp(-abs(x) * 3.0);
    acc += getColor(uv + vec2(x * len / uResolution.x, 0.0)).rgb * w;
    ws += w;
  }
  return vec4(acc / ws, 1.0);
}`,
});

const def: EffectDef = {
  id: "anamorphic_flare", label: "Anamorphic flare", group: "Lens", author: "Tatvam", license: "Proprietary",
  description: "Long horizontal streaks from the highlights",
  params: [
    { name: "intensity", label: "Intensity", type: "float", default: 0.8, min: 0, max: 3, step: 0.01 },
    { name: "threshold", label: "Threshold", type: "float", default: 0.75, min: 0, max: 1, step: 0.01 },
    { name: "length_", label: "Length", type: "float", default: 600, min: 20, max: 2000, step: 5, unit: "px" },
    { name: "tint", label: "Tint", type: "color", default: "#4d8cff" },
  ],
  passes: [
    { scale: 0.25, glsl: `
vec4 effect(vec2 uv) {
  vec3 c = getColor(uv).rgb;
  float l = max(c.r, max(c.g, c.b));
  return vec4(c * smoothstep(threshold, min(threshold + 0.2, 1.0), l), 1.0);
}` },
    streak(0.25), streak(1),
    { glsl: `
vec4 effect(vec2 uv) {
  vec4 o = getOriginal(uv);
  vec3 s = getColor(uv).rgb;
  float e = dot(s, vec3(0.33));
  vec3 glow = mix(s, tint * e * 2.0, 0.75) * intensity * 2.5;
  return vec4(o.rgb + glow, o.a);
}` },
  ],
};
export default def;
