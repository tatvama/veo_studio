/**
 * Bulge / pinch: pushes the picture out of (or into) a circle. Port of BulgePinchFilter from pixi-filters 6.1.5
 * (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts). glfx.js's bulgePinch is the same algorithm (one port for both). Changed: centre as
 * a fraction, radius in composition pixels.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "bulge_pinch", label: "Bulge / pinch", group: "Distort", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / BulgePinchFilter",
  params: [
    { name: "center", label: "Centre", type: "point", default: [0.5, 0.5] },
    { name: "radius", label: "Radius", type: "float", default: 300, min: 0, max: 2000, step: 1, unit: "px" },
    { name: "strength", label: "Strength", type: "float", default: 0.5, min: -1, max: 1, step: 0.01, description: "Above 0 bulges, below 0 pinches" },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec2 c = center * uResolution;
  vec2 coord = uv * uResolution - c;
  float r = max(radius * uScale, 1e-3);
  float d = length(coord);
  if (d < r && d > 0.0) {
    float percent = d / r;
    if (strength > 0.0) coord *= mix(1.0, smoothstep(0.0, r / d, percent), strength * 0.75);
    else coord *= mix(1.0, pow(percent, 1.0 + strength * 0.75) * r / d, 1.0 - percent);
  }
  vec2 q = (coord + c) / uResolution;
  vec2 cq = clamp(q, 0.0, 1.0);
  vec4 col = getColor(cq);
  if (q != cq) col.a *= max(0.0, 1.0 - length(q - cq));
  return col;
}`,
};
export default def;
