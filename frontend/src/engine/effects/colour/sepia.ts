/**
 * Sepia tone. Port of sepia from glfx.js by Evan Wallace (https://github.com/evanw/glfx.js): MIT License,
 * Copyright (C) 2011 by Evan Wallace (full notice: effects/licenses.ts).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "sepia", label: "Sepia", group: "Colour", author: "Evan Wallace", license: "MIT", source: "glfx.js / sepia",
  params: [{ name: "amount", label: "Amount", type: "float", default: 1, min: 0, max: 1, step: 0.01 }],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 color = getColor(uv);
  float r = color.r, g = color.g, b = color.b;
  color.r = min(1.0, (r * (1.0 - (0.607 * amount))) + (g * (0.769 * amount)) + (b * (0.189 * amount)));
  color.g = min(1.0, (r * 0.349 * amount) + (g * (1.0 - (0.314 * amount))) + (b * 0.168 * amount));
  color.b = min(1.0, (r * 0.272 * amount) + (g * 0.534 * amount) + (b * (1.0 - (0.869 * amount))));
  return color;
}`,
};
export default def;
