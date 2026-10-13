/**
 * Ink: darkens edges like an ink drawing. Port of ink from glfx.js by Evan Wallace
 * (https://github.com/evanw/glfx.js): MIT License, Copyright (C) 2011 by Evan Wallace (full notice:
 * effects/licenses.ts).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "ink", label: "Ink", group: "Stylize", author: "Evan Wallace", license: "MIT", source: "glfx.js / ink",
  params: [
    { name: "strength", label: "Strength", type: "float", default: 0.25, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec2 dx = vec2(max(uScale, 1.0) / uResolution.x, 0.0), dy = vec2(0.0, max(uScale, 1.0) / uResolution.y);
  vec4 color = getColor(uv);
  float bigT = 0.0, smallT = 0.0;
  vec3 bigA = vec3(0.0), smallA = vec3(0.0);
  for (float x = -2.0; x <= 2.0; x += 1.0) {
    for (float y = -2.0; y <= 2.0; y += 1.0) {
      vec3 s = getColor(uv + dx * x + dy * y).rgb;
      bigA += s; bigT += 1.0;
      if (abs(x) + abs(y) < 2.0) { smallA += s; smallT += 1.0; }
    }
  }
  vec3 edge = max(vec3(0.0), bigA / bigT - smallA / smallT);
  return vec4(color.rgb - dot(edge, edge) * pow(strength, 5.0) * 100000.0, color.a);
}`,
};
export default def;
