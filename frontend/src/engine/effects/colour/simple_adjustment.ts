/**
 * Simple adjustment (gamma, saturation, contrast, brightness, channel gains). Port of AdjustmentFilter from
 * pixi-filters 6.1.5 (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad
 * Engler (full notice: effects/licenses.ts). Changed: straight alpha instead of premultiplied.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "simple_adjustment", label: "Simple adjustment", group: "Colour", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / AdjustmentFilter",
  params: [
    { name: "gamma", label: "Gamma", type: "float", default: 1, min: 0.1, max: 5, step: 0.01 },
    { name: "saturation", label: "Saturation", type: "float", default: 1, min: 0, max: 5, step: 0.01 },
    { name: "contrast", label: "Contrast", type: "float", default: 1, min: 0, max: 5, step: 0.01 },
    { name: "brightness", label: "Brightness", type: "float", default: 1, min: 0, max: 5, step: 0.01 },
    { name: "red", label: "Red", type: "float", default: 1, min: 0, max: 5, step: 0.01 },
    { name: "green", label: "Green", type: "float", default: 1, min: 0, max: 5, step: 0.01 },
    { name: "blue", label: "Blue", type: "float", default: 1, min: 0, max: 5, step: 0.01 },
    { name: "alpha", label: "Opacity", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec3 rgb = pow(max(c.rgb, 0.0), vec3(1.0 / max(gamma, 1e-4)));
  rgb = mix(vec3(0.5), mix(vec3(dot(vec3(0.2125, 0.7154, 0.0721), rgb)), rgb, saturation), contrast);
  rgb *= vec3(red, green, blue);
  return vec4(rgb * brightness, c.a * alpha);
}`,
};
export default def;
