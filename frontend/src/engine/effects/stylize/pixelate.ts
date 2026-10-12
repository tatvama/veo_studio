/**
 * Pixelate: big square pixels. Port of PixelateFilter from pixi-filters 6.1.5 (https://github.com/pixijs/filters):
 * MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full notice: effects/licenses.ts). Changed:
 * samples each cell's first pixel exactly.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "pixelate", label: "Pixelate", group: "Stylize", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / PixelateFilter",
  params: [
    { name: "size", label: "Pixel size", type: "vec2", default: [16, 16], min: 1, max: 200, step: 1, unit: "px" },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec2 s = max(size * uScale, vec2(1.0));
  vec2 p = floor(uv * uResolution / s) * s;
  return getColor((p + 0.5) / uResolution);
}`,
};
export default def;
