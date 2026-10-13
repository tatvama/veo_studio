/**
 * Colour overlay: tints the picture with a colour. Port of ColorOverlayFilter from pixi-filters 6.1.5
 * (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "color_overlay", label: "Colour overlay", group: "Colour", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / ColorOverlayFilter",
  params: [
    { name: "color", label: "Colour", type: "color", default: "#ff6a00" },
    { name: "alpha", label: "Amount", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  return vec4(mix(c.rgb, color, alpha), c.a);
}`,
};
export default def;
