/**
 * Edge work: white-on-black line art of the picture's edges (a difference of blurs). Port of edgeWork from glfx.js
 * by Evan Wallace (https://github.com/evanw/glfx.js): MIT License, Copyright (C) 2011 by Evan Wallace (full
 * notice: effects/licenses.ts). Changed: radius in composition pixels; keeps the picture's alpha.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "edge_work", label: "Edge work", group: "Stylize", author: "Evan Wallace", license: "MIT", source: "glfx.js / edgeWork",
  params: [
    { name: "radius", label: "Radius", type: "float", default: 10, min: 1, max: 100, step: 0.5, unit: "px" },
  ],
  passes: [
    { glsl: `
float random(vec3 scale, float seed) { return fract(sin(dot(gl_FragCoord.xyz + seed, scale)) * 43758.5453 + seed); }
vec4 effect(vec2 uv) {
  vec2 delta = vec2(radius * uScale / uResolution.x, 0.0);
  vec2 color = vec2(0.0), total = vec2(0.0);
  float offset = random(vec3(12.9898, 78.233, 151.7182), 0.0);
  for (float t = -30.0; t <= 30.0; t++) {
    float percent = (t + offset - 0.5) / 30.0;
    float weight = 1.0 - abs(percent);
    vec3 s = getColor(uv + delta * percent).rgb;
    float average = (s.r + s.g + s.b) / 3.0;
    color.x += average * weight;
    total.x += weight;
    if (abs(t) < 15.0) { weight = weight * 2.0 - 1.0; color.y += average * weight; total.y += weight; }
  }
  return vec4(color / total, 0.0, 1.0);
}` },
    { glsl: `
float random(vec3 scale, float seed) { return fract(sin(dot(gl_FragCoord.xyz + seed, scale)) * 43758.5453 + seed); }
vec4 effect(vec2 uv) {
  vec2 delta = vec2(0.0, radius * uScale / uResolution.y);
  vec2 color = vec2(0.0), total = vec2(0.0);
  float offset = random(vec3(12.9898, 78.233, 151.7182), 0.0);
  for (float t = -30.0; t <= 30.0; t++) {
    float percent = (t + offset - 0.5) / 30.0;
    float weight = 1.0 - abs(percent);
    vec2 s = getColor(uv + delta * percent).xy;
    color.x += s.x * weight;
    total.x += weight;
    if (abs(t) < 15.0) { weight = weight * 2.0 - 1.0; color.y += s.y * weight; total.y += weight; }
  }
  float c = clamp(10000.0 * (color.y / total.y - color.x / total.x) + 0.5, 0.0, 1.0);
  return vec4(c, c, c, getOriginal(uv).a);
}` },
  ],
};
export default def;
