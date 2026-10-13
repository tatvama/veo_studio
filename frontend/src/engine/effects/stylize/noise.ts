/**
 * Noise: random brightness per pixel. Port of noise from glfx.js by Evan Wallace
 * (https://github.com/evanw/glfx.js): MIT License, Copyright (C) 2011 by Evan Wallace (full notice:
 * effects/licenses.ts). Changed: optional new noise every frame.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "noise", label: "Noise", group: "Stylize", author: "Evan Wallace", license: "MIT", source: "glfx.js / noise",
  params: [
    { name: "amount", label: "Amount", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
    { name: "animate", label: "New noise every frame", type: "bool", default: true },
  ],
  glsl: `
float rand(vec2 co) { return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453); }
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float diff = (rand(uv + (animate > 0.5 ? vec2(fract(uFrame * 0.0173), fract(uFrame * 0.0311)) : vec2(0.0))) - 0.5) * amount;
  return vec4(c.rgb + diff, c.a);
}`,
};
export default def;
