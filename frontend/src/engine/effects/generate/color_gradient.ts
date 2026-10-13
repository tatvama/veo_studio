/**
 * Colour gradient: a linear, radial or conic gradient of three colours over (or instead of) the picture. Port of
 * ColorGradientFilter from pixi-filters 6.1.5 (https://github.com/pixijs/filters): MIT License, Copyright (c)
 * 2013-2025 Mathew Groves, Chad Engler (full notice: effects/licenses.ts). Original filter by Hakan Bilgin
 * (@hakanbilgin). Changed: three stops (start, middle, end) as parameters instead of a stop list.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "color_gradient", label: "Colour gradient", group: "Generate", author: "Hakan Bilgin (@hakanbilgin), PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / ColorGradientFilter",
  params: [
    { name: "type", label: "Type", type: "enum", default: 0, options: [{ value: 0, label: "Linear" }, { value: 1, label: "Radial" }, { value: 2, label: "Conic" }] },
    { name: "angle", label: "Angle", type: "angle", default: 90, min: -360, max: 360, step: 1, unit: "°" },
    { name: "color1", label: "Start colour", type: "color", default: "#ff8a00" },
    { name: "alpha1", label: "Start opacity", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
    { name: "color2", label: "Middle colour", type: "color", default: "#e52e71" },
    { name: "alpha2", label: "Middle opacity", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
    { name: "midpoint", label: "Middle at", type: "float", default: 0.5, min: 0.01, max: 0.99, step: 0.01 },
    { name: "color3", label: "End colour", type: "color", default: "#3b2cff" },
    { name: "alpha3", label: "End opacity", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
    { name: "alpha", label: "Opacity", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "maxColors", label: "Bands (0: smooth)", type: "int", default: 0, min: 0, max: 32, step: 1 },
    { name: "replace", label: "Replace the picture", type: "bool", default: false },
  ],
  glsl: `
const float PI = 3.1415926538;
float project(vec2 pos) {
  int t = int(type + 0.5);
  float a = radians(angle);
  if (t == 0) { vec2 r = mat2(cos(a), -sin(a), sin(a), cos(a)) * (pos - 0.5); return clamp(r.x + 0.5, 0.0, 1.0); }
  if (t == 1) return clamp(2.0 * distance(pos, vec2(0.5)), 0.0, 1.0);
  vec2 c = pos - 0.5;
  return mod(atan(-c.y, c.x) + a, 2.0 * PI) / (2.0 * PI);
}
vec4 effect(vec2 uv) {
  vec4 cur = getColor(uv);
  if (alpha <= 0.0) return cur;
  float y = project(uv);
  if (maxColors > 0.0) { float st = 1.0 / maxColors; y = st * (floor(y / st) + 0.5); }
  float m = clamp(midpoint, 0.001, 0.999);
  vec4 c1 = vec4(color1 * alpha1, alpha1), c2 = vec4(color2 * alpha2, alpha2), c3 = vec4(color3 * alpha3, alpha3);
  vec4 g = (y < m ? mix(c1, c2, y / m) : mix(c2, c3, (y - m) / (1.0 - m))) * alpha * cur.a;
  vec4 o = replace > 0.5 ? g : g + vec4(cur.rgb * cur.a, cur.a) * (1.0 - g.a);
  return o.a > 1e-5 ? vec4(o.rgb / o.a, o.a) : vec4(0.0);
}`,
};
export default def;
