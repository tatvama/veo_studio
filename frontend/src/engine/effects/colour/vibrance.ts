/**
 * Vibrance: saturates the less saturated colours more. Port of vibrance from glfx.js by Evan Wallace
 * (https://github.com/evanw/glfx.js): MIT License, Copyright (C) 2011 by Evan Wallace (full notice:
 * effects/licenses.ts).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "vibrance", label: "Vibrance", group: "Colour", author: "Evan Wallace", license: "MIT", source: "glfx.js / vibrance",
  params: [{ name: "amount", label: "Amount", type: "float", default: 0.5, min: -1, max: 1, step: 0.01 }],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 color = getColor(uv);
  float average = (color.r + color.g + color.b) / 3.0;
  float mx = max(color.r, max(color.g, color.b));
  float amt = (mx - average) * (-amount * 3.0);
  color.rgb = mix(color.rgb, vec3(mx), amt);
  return color;
}`,
};
export default def;
