/**
 * HSL qualifier (secondary correction): selects colours by hue, saturation and lightness with soft edges and
 * shifts only them.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "hsl_qualifier", label: "HSL qualifier", group: "Colour", author: "Tatvam", license: "Proprietary",
  description: "Pick a colour range (hue, saturation, lightness) and correct just that",
  params: [
    { name: "hue", label: "Hue centre", type: "angle", default: 120, min: 0, max: 360, step: 1, unit: "°" },
    { name: "hueWidth", label: "Hue width", type: "float", default: 40, min: 1, max: 360, step: 1, unit: "°" },
    { name: "satMin", label: "Saturation from", type: "float", default: 0.15, min: 0, max: 1, step: 0.01 },
    { name: "satMax", label: "Saturation to", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
    { name: "lumMin", label: "Lightness from", type: "float", default: 0.05, min: 0, max: 1, step: 0.01 },
    { name: "lumMax", label: "Lightness to", type: "float", default: 0.95, min: 0, max: 1, step: 0.01 },
    { name: "softness", label: "Softness", type: "float", default: 0.1, min: 0, max: 1, step: 0.01 },
    { name: "hueShift", label: "Hue shift", type: "angle", default: 0, min: -180, max: 180, step: 1, unit: "°" },
    { name: "saturation", label: "Saturation", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
    { name: "lightness", label: "Lightness", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
    { name: "invert", label: "Invert selection", type: "bool", default: false },
    { name: "showMask", label: "Show the selection", type: "bool", default: false },
  ],
  glsl: `
vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5, d = mx - mn, h = 0.0, s = 0.0;
  if (d > 1e-5) {
    s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}
vec3 hsl2rgb(vec3 q) {
  vec3 rgb = clamp(abs(mod(q.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return q.z + q.y * (rgb - 0.5) * (1.0 - abs(2.0 * q.z - 1.0));
}
float band(float x, float lo, float hi, float soft) {
  return smoothstep(lo - soft, lo + soft + 1e-4, x) * (1.0 - smoothstep(hi - soft - 1e-4, hi + soft, x));
}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec3 x = clamp(c.rgb, 0.0, 1.0);
  vec3 h = rgb2hsl(x);
  float dh = abs(fract(h.x - hue / 360.0 + 0.5) - 0.5) * 360.0;
  float m = (1.0 - smoothstep(hueWidth * 0.5, hueWidth * 0.5 + softness * 90.0 + 1e-3, dh)) * step(1e-3, h.y)
    * band(h.y, satMin, satMax, softness * 0.5) * band(h.z, lumMin, lumMax, softness * 0.5);
  if (invert > 0.5) m = 1.0 - m;
  if (showMask > 0.5) return vec4(vec3(m), c.a);
  vec3 q = vec3(fract(h.x + hueShift / 360.0), clamp(h.y * (1.0 + saturation), 0.0, 1.0), clamp(h.z + lightness * 0.5, 0.0, 1.0));
  return vec4(mix(x, hsl2rgb(q), m), c.a);
}`,
};
export default def;
