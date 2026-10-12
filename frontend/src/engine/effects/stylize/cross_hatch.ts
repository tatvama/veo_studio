/**
 * Cross hatch: pen hatching, denser in the darks. Port of CrossHatchFilter from pixi-filters 6.1.5
 * (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts). Changed: line spacing is a parameter (the original: 10 px).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "cross_hatch", label: "Cross hatch", group: "Stylize", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / CrossHatchFilter",
  params: [
    { name: "spacing", label: "Line spacing", type: "float", default: 10, min: 3, max: 60, step: 1, unit: "px" },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 src = getColor(uv);
  float lum = length(src.rgb);
  vec2 f = floor(gl_FragCoord.xy);
  float sp = max(2.0, floor(spacing * uScale + 0.5)), hs = floor(sp * 0.5);
  vec3 o = vec3(1.0);
  if (lum < 1.00 && mod(f.x + f.y, sp) == 0.0) o = vec3(0.0);
  if (lum < 0.75 && mod(f.x - f.y, sp) == 0.0) o = vec3(0.0);
  if (lum < 0.50 && mod(f.x + f.y - hs, sp) == 0.0) o = vec3(0.0);
  if (lum < 0.30 && mod(f.x - f.y - hs, sp) == 0.0) o = vec3(0.0);
  return vec4(o, src.a);
}`,
};
export default def;
