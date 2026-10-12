/**
 * Reflection: mirrors the top of the picture into the bottom like water, with waves. Port of ReflectionFilter from
 * pixi-filters 6.1.5 (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad
 * Engler (full notice: effects/licenses.ts). Changed: time = seconds into the clip × speed; straight alpha.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "reflection", label: "Water reflection", group: "Distort", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / ReflectionFilter",
  params: [
    { name: "mirror", label: "Mirror", type: "bool", default: true },
    { name: "boundary", label: "Water line", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "amplitude", label: "Amplitude (top, bottom)", type: "vec2", default: [0, 20], min: 0, max: 200, step: 1, unit: "px" },
    { name: "wavelength", label: "Wavelength (top, bottom)", type: "vec2", default: [30, 100], min: 1, max: 1000, step: 1, unit: "px" },
    { name: "alpha", label: "Opacity (top, bottom)", type: "vec2", default: [1, 1], min: 0, max: 1, step: 0.01 },
    { name: "speed", label: "Speed", type: "float", default: 2, min: 0, max: 20, step: 0.1 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  if (uv.y < boundary) return getColor(uv);
  float k = (uv.y - boundary) / (1.0 - boundary + 0.0001);
  float v = boundary + boundary - uv.y;
  float y = mirror > 0.5 ? v : uv.y;
  float amp = ((amplitude.y - amplitude.x) * k + amplitude.x) * uScale / uResolution.x;
  float wl = max(((wavelength.y - wavelength.x) * k + wavelength.x) * uScale / uResolution.y, 1e-4);
  float a = (alpha.y - alpha.x) * k + alpha.x;
  float x = clamp(uv.x + cos(v * 6.28 / wl - uTime * speed) * amp, 0.0, 1.0);
  vec4 c = getColor(vec2(x, y));
  return vec4(c.rgb, c.a * a);
}`,
};
export default def;
