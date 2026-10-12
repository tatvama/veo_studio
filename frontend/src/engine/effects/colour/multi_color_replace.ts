/**
 * Multi colour replace: up to three colour swaps. Port of MultiColorReplaceFilter from pixi-filters 6.1.5
 * (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "multi_color_replace", label: "Multi colour replace", group: "Colour", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / MultiColorReplaceFilter",
  params: [
    { name: "count", label: "Colours", type: "int", default: 1, min: 1, max: 3, step: 1 },
    { name: "from1", label: "Colour 1", type: "color", default: "#ff0000" },
    { name: "to1", label: "→ 1", type: "color", default: "#0000ff" },
    { name: "from2", label: "Colour 2", type: "color", default: "#00ff00" },
    { name: "to2", label: "→ 2", type: "color", default: "#ffff00" },
    { name: "from3", label: "Colour 3", type: "color", default: "#0000ff" },
    { name: "to3", label: "→ 3", type: "color", default: "#ff00ff" },
    { name: "tolerance", label: "Tolerance", type: "float", default: 0.05, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec3 o[3] = vec3[](from1, from2, from3);
  vec3 t[3] = vec3[](to1, to2, to3);
  for (int i = 0; i < 3; i++) {
    if (float(i) >= count) break;
    vec3 diff = o[i] - c.rgb;
    if (length(diff) < tolerance) return vec4(t[i] + diff, c.a);
  }
  return c;
}`,
};
export default def;
