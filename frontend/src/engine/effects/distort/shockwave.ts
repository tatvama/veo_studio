/**
 * Shockwave: a ring that ripples out from a point over time. Port of ShockwaveFilter from pixi-filters 6.1.5
 * (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts). Changed: centre as a fraction, time = seconds into the clip (after a delay), sizes
 * in composition pixels.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "shockwave", label: "Shockwave", group: "Distort", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / ShockwaveFilter",
  params: [
    { name: "center", label: "Centre", type: "point", default: [0.5, 0.5] },
    { name: "speed", label: "Speed", type: "float", default: 500, min: 0, max: 5000, step: 10, unit: "px/s" },
    { name: "amplitude", label: "Amplitude", type: "float", default: 30, min: -200, max: 200, step: 1, unit: "px" },
    { name: "wavelength", label: "Wavelength", type: "float", default: 160, min: 2, max: 1000, step: 1, unit: "px" },
    { name: "brightness", label: "Brightness", type: "float", default: 1, min: 0, max: 3, step: 0.01 },
    { name: "radius", label: "Max radius", type: "float", default: -1, min: -1, max: 4000, step: 1, unit: "px", description: "Below 0: no limit" },
    { name: "delay", label: "Delay", type: "float", default: 0, min: 0, max: 30, step: 0.05, unit: "s" },
  ],
  glsl: `
const float PI = 3.14159;
vec4 effect(vec2 uv) {
  vec2 size = uResolution;
  float t = max(uTime - delay, 0.0);
  float halfWl = wavelength * uScale * 0.5 / size.x;
  float maxR = radius * uScale / size.x;
  float curR = t * speed * uScale / size.x;
  float fade = 1.0;
  if (maxR > 0.0) {
    if (curR > maxR) return getColor(uv);
    fade = 1.0 - pow(curR / maxR, 2.0);
  }
  vec2 dir = uv - center;
  dir.y *= size.y / size.x;
  float dist = length(dir);
  if (dist <= 0.0 || dist < curR - halfWl || dist > curR + halfWl) return getColor(uv);
  vec2 dUv = normalize(dir);
  float diff = (dist - curR) / halfWl;
  float p = 1.0 - pow(abs(diff), 2.0);
  float powDiff = 1.25 * sin(diff * PI) * p * (amplitude * uScale * fade);
  vec2 q = uv + dUv * powDiff / size;
  vec2 cq = clamp(q, 0.0, 1.0);
  vec4 c = getColor(cq);
  if (q != cq) c.a *= max(0.0, 1.0 - length(q - cq));
  c.rgb *= 1.0 + (brightness - 1.0) * p * fade;
  return c;
}`,
};
export default def;
