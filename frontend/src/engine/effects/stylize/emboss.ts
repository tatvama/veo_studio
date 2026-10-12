/**
 * Emboss: a grey relief from the picture's edges. Port of EmbossFilter from pixi-filters 6.1.5
 * (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts). Changed: straight alpha.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "emboss", label: "Emboss", group: "Stylize", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / EmbossFilter",
  params: [
    { name: "strength", label: "Strength", type: "float", default: 5, min: 0, max: 20, step: 0.1 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec2 one = vec2(max(uScale, 1.0)) / uResolution;
  vec3 c = vec3(0.5) - getColor(uv - one).rgb * strength + getColor(uv + one).rgb * strength;
  float g = (c.r + c.g + c.b) / 3.0;
  return vec4(vec3(g), getColor(uv).a);
}`,
};
export default def;
