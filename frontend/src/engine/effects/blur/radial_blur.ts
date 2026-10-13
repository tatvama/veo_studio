/**
 * Radial (spin) blur about a centre. Port of RadialBlurFilter from pixi-filters 6.1.5
 * (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts). Changed: centre as a fraction of the frame, angle in degrees.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "radial_blur", label: "Radial blur", group: "Blur & Sharpen", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / RadialBlurFilter",
  params: [
    { name: "angle", label: "Angle", type: "angle", default: 15, min: -180, max: 180, step: 1, unit: "°" },
    { name: "center", label: "Centre", type: "point", default: [0.5, 0.5] },
    { name: "radius", label: "Radius (-1: everywhere)", type: "float", default: -1, min: -1, max: 2000, step: 1, unit: "px" },
    { name: "kernelSize", label: "Samples", type: "int", default: 15, min: 3, max: 64, step: 1 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 color = getColor(uv);
  int ks = int(kernelSize);
  if (ks < 2 || angle == 0.0) return color;
  float aspect = uResolution.y / uResolution.x;
  float rad = radius * uScale;
  float gradient = rad / uResolution.x * 0.3;
  float rr = rad / uResolution.x - gradient * 0.5;
  int k = ks - 1;
  vec2 coord = uv;
  vec2 d = center - coord;
  float dist = length(vec2(d.x, d.y * aspect));
  float st = radians(angle);
  if (rr >= 0.0 && dist > rr) {
    float scale = 1.0 - abs((dist - rr) / max(gradient, 1e-5));
    if (scale <= 0.0) return color;
    st *= scale;
  }
  st /= float(k);
  float s = sin(st), c = cos(st);
  mat2 m = mat2(vec2(c, -s), vec2(s, c));
  for (int i = 0; i < 256; i++) {
    if (i == k) break;
    coord -= center; coord.y *= aspect; coord = m * coord; coord.y /= aspect; coord += center;
    color += getColor(coord);
  }
  return color / float(ks);
}`,
};
export default def;
