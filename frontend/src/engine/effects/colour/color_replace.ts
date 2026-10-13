/**
 * Colour replace: swaps one colour (within a tolerance) for another. Port of ColorReplaceFilter from pixi-filters
 * 6.1.5 (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts). Original filter by mishaa, updated by timetocode.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "color_replace", label: "Colour replace", group: "Colour", author: "mishaa, updated by timetocode, PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / ColorReplaceFilter",
  params: [
    { name: "original", label: "Colour to replace", type: "color", default: "#ff0000" },
    { name: "target", label: "Replace with", type: "color", default: "#0000ff" },
    { name: "tolerance", label: "Tolerance", type: "float", default: 0.4, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec3 diff = original - c.rgb;
  float doReplace = step(length(diff), tolerance);
  return vec4(mix(c.rgb, target + diff, doReplace), c.a);
}`,
};
export default def;
