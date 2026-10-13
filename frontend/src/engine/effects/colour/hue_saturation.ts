/**
 * Hue / saturation (hue rotation on the RGB cube's grey axis). Port of hueSaturation from glfx.js by Evan Wallace
 * (https://github.com/evanw/glfx.js): MIT License, Copyright (C) 2011 by Evan Wallace (full notice:
 * effects/licenses.ts).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "hue_saturation", label: "Hue / saturation", group: "Colour", author: "Evan Wallace", license: "MIT", source: "glfx.js / hueSaturation",
  params: [
    { name: "hue", label: "Hue", type: "float", default: 0, min: -1, max: 1, step: 0.01, description: "-1..1 = -180..180°" },
    { name: "saturation", label: "Saturation", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 color = getColor(uv);
  float angle = hue * 3.14159265;
  float s = sin(angle), c = cos(angle);
  vec3 weights = (vec3(2.0 * c, -sqrt(3.0) * s - c, sqrt(3.0) * s - c) + 1.0) / 3.0;
  color.rgb = vec3(dot(color.rgb, weights.xyz), dot(color.rgb, weights.zxy), dot(color.rgb, weights.yzx));
  float average = (color.r + color.g + color.b) / 3.0;
  if (saturation > 0.0) color.rgb += (average - color.rgb) * (1.0 - 1.0 / (1.001 - saturation));
  else color.rgb += (average - color.rgb) * (-saturation);
  return color;
}`,
};
export default def;
