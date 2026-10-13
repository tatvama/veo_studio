/**
 * Vignette: darkens the corners. Port of vignette from glfx.js by Evan Wallace (https://github.com/evanw/glfx.js):
 * MIT License, Copyright (C) 2011 by Evan Wallace (full notice: effects/licenses.ts).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "vignette", label: "Vignette", group: "Stylize", author: "Evan Wallace", license: "MIT", source: "glfx.js / vignette",
  params: [
    { name: "size", label: "Size", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "amount", label: "Amount", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float d = distance(uv, vec2(0.5));
  c.rgb *= smoothstep(0.8, size * 0.799, d * (amount + size));
  return c;
}`,
};
export default def;
