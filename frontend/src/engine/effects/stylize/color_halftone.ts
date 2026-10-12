/**
 * Colour halftone: CMYK print dots at four screen angles. Port of colorHalftone from glfx.js by Evan Wallace
 * (https://github.com/evanw/glfx.js): MIT License, Copyright (C) 2011 by Evan Wallace (full notice:
 * effects/licenses.ts). Changed: angle in degrees, dot size in composition pixels.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "color_halftone", label: "Colour halftone", group: "Stylize", author: "Evan Wallace", license: "MIT", source: "glfx.js / colorHalftone",
  params: [
    { name: "center", label: "Centre", type: "point", default: [0.5, 0.5] },
    { name: "angle", label: "Angle", type: "angle", default: 15, min: -180, max: 180, step: 1, unit: "°" },
    { name: "size", label: "Dot size", type: "float", default: 4, min: 1, max: 40, step: 0.5, unit: "px" },
  ],
  glsl: `
float pattern(vec2 uv, float a) {
  float s = sin(a), c = cos(a);
  vec2 tex = (uv - center) * uResolution;
  vec2 p = vec2(c * tex.x - s * tex.y, s * tex.x + c * tex.y) * (3.14159265 / max(size * uScale, 0.5));
  return sin(p.x) * sin(p.y) * 4.0;
}
vec4 effect(vec2 uv) {
  vec4 color = getColor(uv);
  float ang = radians(angle);
  vec3 cmy = 1.0 - clamp(color.rgb, 0.0, 1.0);
  float k = min(cmy.x, min(cmy.y, cmy.z));
  cmy = (cmy - k) / max(1.0 - k, 1e-4);
  cmy = clamp(cmy * 10.0 - 3.0 + vec3(pattern(uv, ang + 0.26179), pattern(uv, ang + 1.30899), pattern(uv, ang)), 0.0, 1.0);
  k = clamp(k * 10.0 - 5.0 + pattern(uv, ang + 0.78539), 0.0, 1.0);
  return vec4(1.0 - cmy - k, color.a);
}`,
};
export default def;
