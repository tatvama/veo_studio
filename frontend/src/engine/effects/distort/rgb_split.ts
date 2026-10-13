/**
 * RGB split: the red, green and blue channels offset from each other (chromatic aberration). Port of
 * RGBSplitFilter from pixi-filters 6.1.5 (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025
 * Mathew Groves, Chad Engler (full notice: effects/licenses.ts).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "rgb_split", label: "RGB split", group: "Distort", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / RGBSplitFilter",
  params: [
    { name: "red", label: "Red offset", type: "vec2", default: [-10, 0], min: -100, max: 100, step: 1, unit: "px" },
    { name: "green", label: "Green offset", type: "vec2", default: [0, 10], min: -100, max: 100, step: 1, unit: "px" },
    { name: "blue", label: "Blue offset", type: "vec2", default: [0, 0], min: -100, max: 100, step: 1, unit: "px" },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec2 px = uScale / uResolution;
  return vec4(getColor(uv + red * px).r, getColor(uv + green * px).g, getColor(uv + blue * px).b, getColor(uv).a);
}`,
};
export default def;
