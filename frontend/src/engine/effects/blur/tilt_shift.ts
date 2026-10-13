/**
 * Tilt shift: sharp along a line, blurring away from it (two passes). Port of TiltShiftFilter from pixi-filters
 * 6.1.5 (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts). The pixi filter is itself after glfx.js's tiltShift (Evan Wallace, MIT). Changed:
 * line ends as fractions of the frame.
 */
import type { EffectDef } from "../registry.ts";

const dirs = (p: Record<string, unknown>, w: number, h: number) => {
  const s = (p.start as number[]) ?? [0, 0.5], e = (p.end as number[]) ?? [1, 0.5];
  const dx = (e[0] - s[0]) * w, dy = (e[1] - s[1]) * h, l = Math.hypot(dx, dy) || 1;
  return [[dx / l, dy / l], [-dy / l, dx / l]];
};
const def: EffectDef = {
  id: "tilt_shift", label: "Tilt shift", group: "Blur & Sharpen", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / TiltShiftFilter",
  params: [
    { name: "blur", label: "Blur", type: "float", default: 30, min: 0, max: 200, step: 1, unit: "px" },
    { name: "gradientBlur", label: "Focus width", type: "float", default: 300, min: 1, max: 2000, step: 1, unit: "px" },
    { name: "start", label: "Line start", type: "point", default: [0, 0.5] },
    { name: "end", label: "Line end", type: "point", default: [1, 0.5] },
  ],
  passes: [
    { glsl: `
uniform vec2 delta;
float random(vec3 scale, float seed) { return fract(sin(dot(gl_FragCoord.xyz + seed, scale)) * 43758.5453 + seed); }
vec4 effect(vec2 uv) {
  vec4 color = vec4(0.0);
  float total = 0.0;
  float offset = random(vec3(12.9898, 78.233, 151.7182), 0.0);
  vec2 s = start * uResolution, e = end * uResolution;
  vec2 normal = normalize(vec2(s.y - e.y, e.x - s.x) + 1e-6);
  float radius = smoothstep(0.0, 1.0, abs(dot(uv * uResolution - s, normal)) / max(gradientBlur * uScale, 1.0)) * blur * uScale;
  for (float t = -30.0; t <= 30.0; t++) {
    float pct = (t + offset - 0.5) / 30.0, w = 1.0 - abs(pct);
    vec4 smp = getColor(uv + delta / uResolution * pct * radius);
    smp.rgb *= smp.a;
    color += smp * w;
    total += w;
  }
  color /= total;
  color.rgb /= color.a + 0.00001;
  return color;
}`, uniforms: (p, c) => ({ delta: dirs(p, c.w, c.h)[0] }) },
    { glsl: `
uniform vec2 delta;
float random(vec3 scale, float seed) { return fract(sin(dot(gl_FragCoord.xyz + seed, scale)) * 43758.5453 + seed); }
vec4 effect(vec2 uv) {
  vec4 color = vec4(0.0);
  float total = 0.0;
  float offset = random(vec3(12.9898, 78.233, 151.7182), 0.0);
  vec2 s = start * uResolution, e = end * uResolution;
  vec2 normal = normalize(vec2(s.y - e.y, e.x - s.x) + 1e-6);
  float radius = smoothstep(0.0, 1.0, abs(dot(uv * uResolution - s, normal)) / max(gradientBlur * uScale, 1.0)) * blur * uScale;
  for (float t = -30.0; t <= 30.0; t++) {
    float pct = (t + offset - 0.5) / 30.0, w = 1.0 - abs(pct);
    vec4 smp = getColor(uv + delta / uResolution * pct * radius);
    smp.rgb *= smp.a;
    color += smp * w;
    total += w;
  }
  color /= total;
  color.rgb /= color.a + 0.00001;
  return color;
}`, uniforms: (p, c) => ({ delta: dirs(p, c.w, c.h)[1] }) },
  ],
};
export default def;
