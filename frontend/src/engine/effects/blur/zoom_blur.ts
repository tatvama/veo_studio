/**
 * Zoom blur towards a centre. Port of ZoomBlurFilter from pixi-filters 6.1.5 (https://github.com/pixijs/filters):
 * MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full notice: effects/licenses.ts). Changed:
 * centre as a fraction of the frame.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "zoom_blur", label: "Zoom blur", group: "Blur & Sharpen", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / ZoomBlurFilter",
  params: [
    { name: "strength", label: "Strength", type: "float", default: 0.1, min: 0, max: 1, step: 0.01 },
    { name: "center", label: "Centre", type: "point", default: [0.5, 0.5] },
    { name: "innerRadius", label: "Inner radius", type: "float", default: 0, min: 0, max: 2000, step: 1, unit: "px" },
    { name: "radius", label: "Radius (-1: everywhere)", type: "float", default: -1, min: -1, max: 2000, step: 1, unit: "px" },
  ],
  glsl: `
float rnd(vec2 co, float seed) {
  float dt = dot(co + seed, vec2(12.9898, 78.233)), sn = mod(dt, 3.14159);
  return fract(sin(sn) * 43758.5453 + seed);
}
vec4 effect(vec2 uv) {
  const float MAXK = 32.0;
  float ir = innerRadius * uScale, r = radius * uScale;
  float minGradient = ir * 0.3;
  float innerR = (ir + minGradient * 0.5) / uResolution.x;
  float gradient = r * 0.3;
  float rr = (r - gradient * 0.5) / uResolution.x;
  float countLimit = MAXK;
  vec2 dir = center - uv;
  float dist = length(vec2(dir.x, dir.y * uResolution.y / uResolution.x));
  float st = strength, delta = 0.0, gap = 0.0;
  if (dist < innerR) { delta = innerR - dist; gap = minGradient; }
  else if (rr >= 0.0 && dist > rr) { delta = dist - rr; gap = gradient; }
  if (delta > 0.0) {
    float nc = gap / uResolution.x;
    delta = (nc - delta) / max(nc, 1e-5);
    countLimit *= delta; st *= delta;
    if (countLimit < 1.0) return getColor(uv);
  }
  float off = rnd(uv, 0.0), total = 0.0;
  vec4 color = vec4(0.0);
  dir *= st;
  for (float t = 0.0; t < MAXK; t++) {
    float pct = (t + off) / MAXK, w = 4.0 * (pct - pct * pct);
    color += getColor(uv + dir * pct) * w;
    total += w;
    if (t > countLimit) break;
  }
  return color / total;
}`,
};
export default def;
