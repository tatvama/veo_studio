/**
 * Greyscale (Rec. 601 luma). Port of GrayscaleFilter from pixi-filters 6.1.5 (https://github.com/pixijs/filters):
 * MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full notice: effects/licenses.ts). Added:
 * amount.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "grayscale", label: "Greyscale", group: "Colour", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / GrayscaleFilter",
  params: [{ name: "amount", label: "Amount", type: "float", default: 1, min: 0, max: 1, step: 0.01 }],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  return vec4(mix(c.rgb, vec3(dot(c.rgb, vec3(0.299, 0.587, 0.114))), amount), c.a);
}`,
};
export default def;
