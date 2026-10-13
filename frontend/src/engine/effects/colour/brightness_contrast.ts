/**
 * Brightness / contrast (additive brightness, contrast about 0.5). Port of brightnessContrast from glfx.js by Evan
 * Wallace (https://github.com/evanw/glfx.js): MIT License, Copyright (C) 2011 by Evan Wallace (full notice:
 * effects/licenses.ts).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "brightness_contrast", label: "Brightness / contrast", group: "Colour", author: "Evan Wallace", license: "MIT", source: "glfx.js / brightnessContrast",
  params: [
    { name: "brightness", label: "Brightness", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
    { name: "contrast", label: "Contrast", type: "float", default: 0, min: -1, max: 0.99, step: 0.01 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 color = getColor(uv);
  color.rgb += brightness;
  if (contrast > 0.0) color.rgb = (color.rgb - 0.5) / (1.0 - contrast) + 0.5;
  else color.rgb = (color.rgb - 0.5) * (1.0 + contrast) + 0.5;
  return color;
}`,
};
export default def;
