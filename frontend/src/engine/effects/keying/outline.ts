/**
 * Outline: a line of a colour around the picture's opaque parts (titles, keyed shots). Port of OutlineFilter from
 * pixi-filters 6.1.5 (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad
 * Engler (full notice: effects/licenses.ts). Original filter by mishaa. Changed: thickness in composition pixels;
 * straight alpha.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "outline", label: "Outline", group: "Keying", author: "mishaa, PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / OutlineFilter",
  params: [
    { name: "thickness", label: "Thickness", type: "float", default: 4, min: 0, max: 50, step: 0.5, unit: "px" },
    { name: "color", label: "Colour", type: "color", default: "#000000" },
    { name: "alpha", label: "Opacity", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
    { name: "quality", label: "Quality", type: "float", default: 0.1, min: 0.01, max: 1, step: 0.01 },
    { name: "knockout", label: "Outline only", type: "bool", default: false },
  ],
  pad: (p) => Number(p.thickness) + 2,
  uniforms: (p) => ({ angleStep: (Math.PI * 2) / Math.max(4, Math.round(Number(p.quality) * 100)) }),
  glsl: `
uniform float angleStep;
vec4 effect(vec2 uv) {
  vec2 th = thickness * uScale / uResolution;
  float maxA = 0.0;
  if (th.x > 0.0) for (float a = 0.0; a <= 6.2832; a += angleStep) maxA = max(maxA, getColor(uv + vec2(th.x * cos(a), th.y * sin(a))).a);
  vec4 src = getColor(uv);
  float oa = alpha * maxA * (1.0 - src.a);
  vec4 p = vec4(src.rgb * src.a, src.a) * float(knockout < 0.5) + vec4(color * oa, oa);
  return p.a > 1e-5 ? vec4(p.rgb / p.a, p.a) : vec4(0.0);
}`,
};
export default def;
