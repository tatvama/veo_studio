/**
 * Glitch: slices of the picture shifted sideways, with the colour channels split. Port of GlitchFilter from
 * pixi-filters 6.1.5 (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad
 * Engler (full notice: effects/licenses.ts). Changed: the slices come from a hash in the shader (no displacement
 * texture); the shift keeps its pixel length at any angle; optional new slices every frame.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "glitch", label: "Glitch", group: "Distort", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / GlitchFilter",
  params: [
    { name: "slices", label: "Slices", type: "int", default: 8, min: 2, max: 60, step: 1 },
    { name: "offset", label: "Shift", type: "float", default: 100, min: 0, max: 600, step: 1, unit: "px" },
    { name: "direction", label: "Direction", type: "angle", default: 0, min: -180, max: 180, step: 1, unit: "°" },
    { name: "seed", label: "Seed", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "animate", label: "New slices every frame", type: "bool", default: false },
    { name: "fillMode", label: "Edges", type: "enum", default: 3, options: [{ value: 0, label: "Transparent" }, { value: 1, label: "Original" }, { value: 2, label: "Loop" }, { value: 3, label: "Clamp" }, { value: 4, label: "Mirror" }] },
    { name: "red", label: "Red offset", type: "vec2", default: [-6, 0], min: -50, max: 50, step: 1, unit: "px" },
    { name: "green", label: "Green offset", type: "vec2", default: [0, 0], min: -50, max: 50, step: 1, unit: "px" },
    { name: "blue", label: "Blue offset", type: "vec2", default: [6, 0], min: -50, max: 50, step: 1, unit: "px" },
  ],
  glsl: `
float h1(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
vec4 effect(vec2 uv) {
  float sd = animate > 0.5 ? fract(seed + uFrame * 0.618034) : seed;
  float aspect = uResolution.y / uResolution.x;
  float dr = radians(direction), sinD = sin(dr), cosD = cos(dr);
  float cx = uv.x - 0.5, cy = (uv.y - 0.5) * aspect;
  float ny = (-sinD * cx + cosD * cy) / aspect + 0.5;
  ny = ny > 1.0 ? 2.0 - ny : (ny < 0.0 ? -ny : ny);
  float band = floor(ny * max(slices, 1.0));
  float r = h1(band + sd * 101.0), on = step(0.45, h1(band * 1.37 + sd * 57.0));
  float disp = (r * 2.0 - 1.0) * on * offset * uScale;
  vec2 q = uv + vec2(cosD * disp / uResolution.x, sinD * disp / uResolution.y);
  int fm = int(fillMode + 0.5);
  if (fm == 3) q = clamp(q, 0.0, 1.0);
  else if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) {
    if (fm == 0) return vec4(0.0);
    if (fm == 1) q = uv;
    if (fm == 2) q = fract(q);
    if (fm == 4) q = 1.0 - abs(1.0 - mod(q, 2.0));
  }
  vec2 px = uScale / uResolution;
  return vec4(getColor(q + red * px * (1.0 - sd * 0.4)).r, getColor(q + green * px * (1.0 - sd * 0.3)).g,
    getColor(q + blue * px * (1.0 - sd * 0.2)).b, getColor(q).a);
}`,
};
export default def;
