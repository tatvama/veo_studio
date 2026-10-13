/**
 * Bevel: light and shadow along the edges of the picture's alpha. Port of BevelFilter from pixi-filters 6.1.5
 * (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "bevel", label: "Bevel", group: "Keying", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / BevelFilter",
  params: [
    { name: "rotation", label: "Light angle", type: "angle", default: 45, min: -180, max: 180, step: 1, unit: "°" },
    { name: "thickness", label: "Thickness", type: "float", default: 3, min: 0, max: 30, step: 0.5, unit: "px" },
    { name: "lightColor", label: "Light", type: "color", default: "#ffffff" },
    { name: "lightAlpha", label: "Light amount", type: "float", default: 0.7, min: 0, max: 1, step: 0.01 },
    { name: "shadowColor", label: "Shadow", type: "color", default: "#000000" },
    { name: "shadowAlpha", label: "Shadow amount", type: "float", default: 0.7, min: 0, max: 1, step: 0.01 },
  ],
  pad: (p) => Number(p.thickness) + 1,
  glsl: `
vec4 effect(vec2 uv) {
  float r = radians(rotation);
  vec2 t = vec2(cos(r), sin(r)) * thickness * uScale / uResolution;
  vec4 c = getColor(uv);
  float light = getColor(uv - t).a, shadow = getColor(uv + t).a;
  c.rgb = mix(c.rgb, lightColor, clamp((c.a - light) * lightAlpha, 0.0, 1.0));
  c.rgb = mix(c.rgb, shadowColor, clamp((c.a - shadow) * shadowAlpha, 0.0, 1.0));
  return c;
}`,
};
export default def;
