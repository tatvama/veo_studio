/**
 * Unsharp mask: sharpens by pushing away from a triangle-blurred copy. Port of unsharpMask from glfx.js by Evan
 * Wallace (https://github.com/evanw/glfx.js): MIT License, Copyright (C) 2011 by Evan Wallace (full notice:
 * effects/licenses.ts).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "unsharp_mask", label: "Unsharp mask", group: "Blur & Sharpen", author: "Evan Wallace", license: "MIT", source: "glfx.js / unsharpMask",
  params: [
    { name: "radius", label: "Radius", type: "float", default: 20, min: 0, max: 200, step: 1, unit: "px" },
    { name: "strength", label: "Strength", type: "float", default: 1, min: 0, max: 5, step: 0.01 },
  ],
  passes: [
    { glsl: `
uniform vec2 delta;
float random(vec3 scale, float seed) { return fract(sin(dot(gl_FragCoord.xyz + seed, scale)) * 43758.5453 + seed); }
vec4 effect(vec2 uv) {
  vec4 color = vec4(0.0);
  float total = 0.0;
  float offset = random(vec3(12.9898, 78.233, 151.7182), 0.0);
  for (float t = -30.0; t <= 30.0; t++) {
    float pct = (t + offset - 0.5) / 30.0, w = 1.0 - abs(pct);
    vec4 smp = getColor(uv + delta * pct);
    smp.rgb *= smp.a;
    color += smp * w;
    total += w;
  }
  color /= total;
  color.rgb /= color.a + 0.00001;
  return color;
}`, uniforms: (p, c) => ({ delta: [(Number(p.radius) * c.scale) / c.w, 0] }) },
    { glsl: `
uniform vec2 delta;
float random(vec3 scale, float seed) { return fract(sin(dot(gl_FragCoord.xyz + seed, scale)) * 43758.5453 + seed); }
vec4 effect(vec2 uv) {
  vec4 color = vec4(0.0);
  float total = 0.0;
  float offset = random(vec3(12.9898, 78.233, 151.7182), 0.0);
  for (float t = -30.0; t <= 30.0; t++) {
    float pct = (t + offset - 0.5) / 30.0, w = 1.0 - abs(pct);
    vec4 smp = getColor(uv + delta * pct);
    smp.rgb *= smp.a;
    color += smp * w;
    total += w;
  }
  color /= total;
  color.rgb /= color.a + 0.00001;
  return color;
}`, uniforms: (p, c) => ({ delta: [0, (Number(p.radius) * c.scale) / c.h] }) },
    { glsl: `
vec4 effect(vec2 uv) { return mix(getColor(uv), getOriginal(uv), 1.0 + strength); }` },
  ],
};
export default def;
