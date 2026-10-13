/**
 * Dot screen: a black-and-white (or colour) halftone dot pattern. Port of DotFilter from pixi-filters 6.1.5
 * (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts). Original filter by Evan Wallace (glfx.js dotScreen). Port of glfx.js's dotScreen
 * too (the same shader; one port for both). Changed: angle in degrees, dot size in composition pixels.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "dot_screen", label: "Dot screen", group: "Stylize", author: "Evan Wallace (glfx.js dotScreen), PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / DotFilter",
  params: [
    { name: "size", label: "Dot size", type: "float", default: 3, min: 1, max: 40, step: 0.5, unit: "px" },
    { name: "angle", label: "Angle", type: "angle", default: 15, min: -180, max: 180, step: 1, unit: "°" },
    { name: "grayscale", label: "Greyscale", type: "bool", default: true },
  ],
  glsl: `
float pattern(vec2 uv) {
  float r = radians(angle), s = sin(r), c = cos(r);
  vec2 tex = uv * uResolution;
  vec2 p = vec2(c * tex.x - s * tex.y, s * tex.x + c * tex.y) * (3.14159265 / max(size * uScale, 0.5));
  return sin(p.x) * sin(p.y) * 4.0;
}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec3 rgb = grayscale > 0.5 ? vec3((c.r + c.g + c.b) / 3.0) : c.rgb;
  return vec4(clamp(rgb * 10.0 - 5.0 + pattern(uv), 0.0, 1.0), c.a);
}`,
};
export default def;
