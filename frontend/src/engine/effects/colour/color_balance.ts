/**
 * Colour balance: shadows, midtones and highlights per channel, with FFmpeg colorbalance's ramps (lightness = max
 * + min, as FFmpeg 7.1 measures).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "color_balance", label: "Colour balance", group: "Colour", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "shadows", label: "Shadows", type: "rgb", default: [0, 0, 0], min: -1, max: 1, step: 0.01 },
    { name: "midtones", label: "Midtones", type: "rgb", default: [0, 0, 0], min: -1, max: 1, step: 0.01 },
    { name: "highlights", label: "Highlights", type: "rgb", default: [0, 0, 0], min: -1, max: 1, step: 0.01 },
    { name: "preserve", label: "Preserve lightness", type: "bool", default: false },
  ],
  glsl: `
float cbComp(float v, float l, float s, float m, float h) {
  s *= clamp((0.333 - l) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  m *= clamp((l - 0.333) * 4.0 + 0.5, 0.0, 1.0) * clamp((1.0 - l - 0.333) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  h *= clamp((l + 0.333 - 1.0) * 4.0 + 0.5, 0.0, 1.0) * 0.7;
  return clamp(v + s + m + h, 0.0, 1.0);
}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec3 x = clamp(c.rgb, 0.0, 1.0);
  float mx = max(x.r, max(x.g, x.b)), mn = min(x.r, min(x.g, x.b));
  float l = mx + mn;
  vec3 o = vec3(cbComp(x.r, l, shadows.r, midtones.r, highlights.r), cbComp(x.g, l, shadows.g, midtones.g, highlights.g),
    cbComp(x.b, l, shadows.b, midtones.b, highlights.b));
  if (preserve > 0.5) {
    float l1 = max(o.r, max(o.g, o.b)) + min(o.r, min(o.g, o.b));
    o = clamp(o + (l - l1) * 0.5, 0.0, 1.0);
  }
  return vec4(o, c.a);
}`,
};
export default def;
