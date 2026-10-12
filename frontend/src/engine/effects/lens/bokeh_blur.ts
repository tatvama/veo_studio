/**
 * Bokeh blur: a defocus blur whose highlights open into round or hexagonal discs, like an aperture. Our own: a
 * golden-angle spiral gather (96 taps) at half size, highlights weighted up, then back to full size.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "bokeh_blur", label: "Bokeh blur", group: "Lens", author: "Tatvam", license: "Proprietary",
  description: "Defocus with round or hexagonal highlight discs",
  params: [
    { name: "radius", label: "Radius", type: "float", default: 16, min: 0, max: 80, step: 0.5, unit: "px" },
    { name: "shape", label: "Aperture", type: "enum", default: "round", options: [{ value: "round", label: "Round" }, { value: "hexagon", label: "Hexagonal" }] },
    { name: "rotation", label: "Rotation", type: "angle", default: 0, min: -180, max: 180, step: 1, unit: "°" },
    { name: "highlights", label: "Highlight boost", type: "float", default: 0.6, min: 0, max: 2, step: 0.01 },
    { name: "threshold", label: "Highlight threshold", type: "float", default: 0.7, min: 0, max: 1, step: 0.01 },
  ],
  pad: (p) => Number(p.radius),
  passes: [
    { scale: 0.5, glsl: `
const float GOLDEN = 2.39996323;
// radius of the hexagon of circumradius 1 in direction a
float hexR(float a) { float s = 1.0471976; float b = mod(a, s) - s * 0.5; return cos(s * 0.5) / cos(b); }
vec4 effect(vec2 uv) {
  float R = radius * uScale;
  if (R < 0.5) return getColor(uv);
  vec3 acc = vec3(0.0);
  float ws = 0.0, alpha = 0.0;
  float rot = radians(rotation);
  for (int i = 0; i < 96; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / 96.0);
    float a = fi * GOLDEN;
    if (shape > 0.5) r *= hexR(a - rot);
    vec2 o = vec2(cos(a), sin(a)) * r * R / uResolution;
    vec4 c = getColor(uv + o);
    float l = max(c.r, max(c.g, c.b));
    float w = 1.0 + highlights * 8.0 * smoothstep(threshold, 1.0, l);
    acc += c.rgb * c.a * w;
    alpha += c.a * w;
    ws += w;
  }
  return alpha > 1e-5 ? vec4(acc / alpha, alpha / ws) : vec4(0.0);
}` },
    { glsl: `vec4 effect(vec2 uv) { return getColor(uv); }` },
  ],
};
export default def;
