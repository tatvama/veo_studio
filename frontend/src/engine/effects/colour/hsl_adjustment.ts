/**
 * HSL adjustment (hue, saturation, lightness, colourize). Port of HslAdjustmentFilter from pixi-filters 6.1.5
 * (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts). Changed: straight alpha.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "hsl_adjustment", label: "HSL adjustment", group: "Colour", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / HslAdjustmentFilter",
  params: [
    { name: "hue", label: "Hue", type: "angle", default: 0, min: -180, max: 180, step: 1, unit: "°" },
    { name: "saturation", label: "Saturation", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
    { name: "lightness", label: "Lightness", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
    { name: "colorize", label: "Colourize", type: "bool", default: false },
    { name: "alpha", label: "Amount", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
const vec3 weight = vec3(0.299, 0.587, 0.114);
const vec3 k = vec3(0.57735, 0.57735, 0.57735);
vec3 hueShift(vec3 color, float angle) {
  float cosAngle = cos(angle);
  return color * cosAngle + cross(k, color) * sin(angle) + k * dot(k, color) * (1.0 - cosAngle);
}
vec4 effect(vec2 uv) {
  vec4 color = getColor(uv);
  vec3 rgb = color.rgb;
  if (colorize > 0.5) rgb = vec3(dot(rgb, weight), 0.0, 0.0);
  rgb = hueShift(rgb, radians(hue));
  float average = (rgb.r + rgb.g + rgb.b) / 3.0;
  if (saturation > 0.0) rgb += (average - rgb) * (1.0 - 1.0 / (1.001 - saturation));
  else rgb -= (average - rgb) * saturation;
  rgb = mix(rgb, vec3(ceil(lightness)), abs(lightness));
  return mix(color, vec4(rgb, color.a), alpha);
}`,
};
export default def;
