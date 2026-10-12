/**
 * Mask: keeps a rectangle or ellipse (centre and size as fractions of the picture, rotated, feathered, optionally
 * inverted) and makes the rest transparent. To confine one effect to a shape instead, give that effect a `mask`.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "mask", label: "Mask", group: "Keying", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "shape", label: "Shape", type: "enum", default: "ellipse", options: [{ value: "rect", label: "Rectangle" }, { value: "ellipse", label: "Ellipse" }] },
    { name: "x", label: "Centre X", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "y", label: "Centre Y", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "w", label: "Width", type: "float", default: 0.6, min: 0, max: 1, step: 0.01 },
    { name: "h", label: "Height", type: "float", default: 0.6, min: 0, max: 1, step: 0.01 },
    { name: "rotation", label: "Rotation", type: "angle", default: 0, min: -180, max: 180, step: 0.5, unit: "°" },
    { name: "feather", label: "Feather", type: "float", default: 0.1, min: 0, max: 1, step: 0.01 },
    { name: "invert", label: "Invert", type: "bool", default: false },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec2 p = (uv - vec2(x, y)) * uResolution;
  float r = radians(rotation), cr = cos(r), sr = sin(r);
  p = vec2(cr * p.x + sr * p.y, -sr * p.x + cr * p.y);
  vec2 hs = max(vec2(w, h) * uResolution * 0.5, vec2(1.0));
  float d;
  if (shape > 0.5) d = (length(p / hs) - 1.0) * min(hs.x, hs.y);
  else { vec2 q = abs(p) - hs; d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); }
  float band = max(feather * min(hs.x, hs.y), 0.75);
  float m = 1.0 - smoothstep(-band, band, d);
  if (invert > 0.5) m = 1.0 - m;
  return vec4(c.rgb, c.a * m);
}`,
};
export default def;
