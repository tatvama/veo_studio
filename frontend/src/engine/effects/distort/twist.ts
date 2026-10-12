/**
 * Twist: turns the picture around a point, most at the centre. Port of TwistFilter from pixi-filters 6.1.5
 * (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts). glfx.js's swirl is the same algorithm (one port for both). Changed: centre as a
 * fraction, angle in degrees.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "twist", label: "Twist / swirl", group: "Distort", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / TwistFilter",
  params: [
    { name: "center", label: "Centre", type: "point", default: [0.5, 0.5] },
    { name: "radius", label: "Radius", type: "float", default: 300, min: 0, max: 2000, step: 1, unit: "px" },
    { name: "angle", label: "Angle", type: "angle", default: 230, min: -720, max: 720, step: 1, unit: "°" },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec2 c = center * uResolution;
  vec2 p = uv * uResolution - c;
  float r = max(radius * uScale, 1e-3), d = length(p);
  if (d < r) {
    float k = (r - d) / r;
    float a = k * k * radians(angle);
    float s = sin(a), co = cos(a);
    p = vec2(p.x * co - p.y * s, p.x * s + p.y * co);
  }
  return getColor((p + c) / uResolution);
}`,
};
export default def;
