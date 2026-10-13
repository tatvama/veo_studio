/**
 * Lens blur: a hexagonal bokeh blur that brightens highlights. Port of lensBlur from glfx.js by Evan Wallace
 * (https://github.com/evanw/glfx.js): MIT License, Copyright (C) 2011 by Evan Wallace (full notice:
 * effects/licenses.ts). Changed: the five glfx passes chained through the registry's pass outputs; radius in
 * composition pixels.
 */
import type { EffectDef } from "../registry.ts";

const deltas = (p: Record<string, unknown>, c: { w: number; h: number; scale: number }) => {
  const r = Number(p.radius) * c.scale, a = (Number(p.angle) * Math.PI) / 180;
  return [0, 1, 2].map((g) => { const n = a + (2 * g * Math.PI) / 3; return [(r * Math.sin(n)) / c.w, (r * Math.cos(n)) / c.h]; });
};
const u = (p: Record<string, unknown>, c: { w: number; h: number; scale: number }) => {
  const d = deltas(p, c);
  return { d0: d[0], d1: d[1], d2: d[2], power: Math.pow(10, Math.max(-1, Math.min(1, Number(p.brightness)))) };
};
const def: EffectDef = {
  id: "lens_blur", label: "Lens blur", group: "Blur & Sharpen", author: "Evan Wallace", license: "MIT", source: "glfx.js / lensBlur",
  params: [
    { name: "radius", label: "Radius", type: "float", default: 12, min: 0, max: 100, step: 0.5, unit: "px" },
    { name: "brightness", label: "Highlight bloom", type: "float", default: 0.5, min: -1, max: 1, step: 0.01 },
    { name: "angle", label: "Angle", type: "angle", default: 0, min: -180, max: 180, step: 1, unit: "°" },
  ],
  uniforms: u,
  passes: [
    { glsl: `
uniform vec2 d0;
uniform vec2 d1;
uniform vec2 d2;
uniform float power;
float random(vec3 scale, float seed) { return fract(sin(dot(gl_FragCoord.xyz + seed, scale)) * 43758.5453 + seed); }
vec4 sampleTex(sampler2D tex, vec2 uv, vec2 delta) {
  float offset = random(vec3(delta, 151.7182), 0.0);
  vec4 color = vec4(0.0);
  for (float t = 0.0; t <= 30.0; t++) color += texture(tex, uv + delta * (t + offset) / 30.0);
  return color / 31.0;
}
vec4 effect(vec2 uv) { return pow(max(getColor(uv), 0.0), vec4(power)); }` },
    { glsl: `
uniform vec2 d0;
uniform vec2 d1;
uniform vec2 d2;
uniform float power;
float random(vec3 scale, float seed) { return fract(sin(dot(gl_FragCoord.xyz + seed, scale)) * 43758.5453 + seed); }
vec4 sampleTex(sampler2D tex, vec2 uv, vec2 delta) {
  float offset = random(vec3(delta, 151.7182), 0.0);
  vec4 color = vec4(0.0);
  for (float t = 0.0; t <= 30.0; t++) color += texture(tex, uv + delta * (t + offset) / 30.0);
  return color / 31.0;
}
vec4 effect(vec2 uv) { return sampleTex(uInput, uv, d0); }` },
    { glsl: `
uniform vec2 d0;
uniform vec2 d1;
uniform vec2 d2;
uniform float power;
float random(vec3 scale, float seed) { return fract(sin(dot(gl_FragCoord.xyz + seed, scale)) * 43758.5453 + seed); }
vec4 sampleTex(sampler2D tex, vec2 uv, vec2 delta) {
  float offset = random(vec3(delta, 151.7182), 0.0);
  vec4 color = vec4(0.0);
  for (float t = 0.0; t <= 30.0; t++) color += texture(tex, uv + delta * (t + offset) / 30.0);
  return color / 31.0;
}
vec4 effect(vec2 uv) { return (sampleTex(uInput, uv, d1) + sampleTex(uInput, uv, d2)) * 0.5; }` },
    { glsl: `
uniform vec2 d0;
uniform vec2 d1;
uniform vec2 d2;
uniform float power;
float random(vec3 scale, float seed) { return fract(sin(dot(gl_FragCoord.xyz + seed, scale)) * 43758.5453 + seed); }
vec4 sampleTex(sampler2D tex, vec2 uv, vec2 delta) {
  float offset = random(vec3(delta, 151.7182), 0.0);
  vec4 color = vec4(0.0);
  for (float t = 0.0; t <= 30.0; t++) color += texture(tex, uv + delta * (t + offset) / 30.0);
  return color / 31.0;
}
uniform sampler2D uPass0;
vec4 effect(vec2 uv) { return sampleTex(uPass0, uv, d1); }` },
    { glsl: `
uniform vec2 d0;
uniform vec2 d1;
uniform vec2 d2;
uniform float power;
float random(vec3 scale, float seed) { return fract(sin(dot(gl_FragCoord.xyz + seed, scale)) * 43758.5453 + seed); }
vec4 sampleTex(sampler2D tex, vec2 uv, vec2 delta) {
  float offset = random(vec3(delta, 151.7182), 0.0);
  vec4 color = vec4(0.0);
  for (float t = 0.0; t <= 30.0; t++) color += texture(tex, uv + delta * (t + offset) / 30.0);
  return color / 31.0;
}
uniform sampler2D uPass2;
vec4 effect(vec2 uv) { vec4 c = (sampleTex(uInput, uv, d2) + 2.0 * texture(uPass2, uv)) / 3.0; return pow(max(c, 0.0), vec4(1.0 / power)); }` },
  ],
};
export default def;
