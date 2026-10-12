/**
 * Old film: sepia, scratches, grain and a vignette, different every frame. Port of OldFilmFilter from pixi-filters
 * 6.1.5 (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts). Changed: the seed follows the frame number; sizes in composition pixels.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "old_film", label: "Old film", group: "Stylize", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / OldFilmFilter",
  params: [
    { name: "sepia", label: "Sepia", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
    { name: "noise", label: "Grain", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
    { name: "noiseSize", label: "Grain size", type: "float", default: 1, min: 1, max: 10, step: 0.1, unit: "px" },
    { name: "scratch", label: "Scratches", type: "float", default: 0.5, min: -1, max: 1, step: 0.01 },
    { name: "scratchDensity", label: "Scratch density", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
    { name: "scratchWidth", label: "Scratch width", type: "float", default: 1, min: 1, max: 20, step: 0.5, unit: "px" },
    { name: "vignetting", label: "Vignette", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
    { name: "vignettingAlpha", label: "Vignette opacity", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
    { name: "vignettingBlur", label: "Vignette softness", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
const float SQRT_2 = 1.414213;
const vec3 SEPIA_RGB = vec3(112.0 / 255.0, 66.0 / 255.0, 20.0 / 255.0);
float rand(vec2 co) { return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 overlay(vec3 src, vec3 dst) {
  return vec3(dst.x <= 0.5 ? 2.0 * src.x * dst.x : 1.0 - 2.0 * (1.0 - dst.x) * (1.0 - src.x),
              dst.y <= 0.5 ? 2.0 * src.y * dst.y : 1.0 - 2.0 * (1.0 - dst.y) * (1.0 - src.y),
              dst.z <= 0.5 ? 2.0 * src.z * dst.z : 1.0 - 2.0 * (1.0 - dst.z) * (1.0 - src.z));
}
vec4 effect(vec2 uv) {
  vec4 fc = getColor(uv);
  vec3 color = fc.rgb;
  float seed = fract(sin(uFrame * 12.9898 + 1.0) * 43758.5453);
  vec2 dim = uResolution / max(uScale, 1e-3);
  if (sepia > 0.0) {
    vec3 g = vec3((color.x + color.y + color.z) / 3.0);
    color = g + sepia * (overlay(SEPIA_RGB, g) - g);
  }
  vec2 coord = uv;
  if (vignetting > 0.0) {
    float outer = SQRT_2 - vignetting * SQRT_2;
    vec2 dir = vec2(0.5) - coord;
    dir.y *= dim.y / dim.x;
    float darker = clamp((outer - length(dir) * SQRT_2) / (0.00001 + vignettingBlur * SQRT_2), 0.0, 1.0);
    color *= darker + (1.0 - darker) * (1.0 - vignettingAlpha);
  }
  if (scratchDensity > seed && scratch != 0.0) {
    float phase = seed * 256.0;
    float s = mod(floor(phase), 2.0);
    float dist = 1.0 / scratchDensity;
    float d = distance(coord, vec2(seed * dist, abs(s - seed * dist)));
    if (d < seed * 0.6 + 0.4) {
      float period = scratchDensity * 10.0;
      float xx = coord.x * period + phase;
      float aa = abs(mod(xx, 0.5) * 4.0);
      float bb = mod(floor(xx / 0.5), 2.0);
      float yy = (1.0 - bb) * aa + bb * (2.0 - aa);
      float kk = 2.0 * period;
      float dw = scratchWidth / dim.x * (0.75 + seed);
      float dh = dw * kk;
      float tine = yy - (2.0 - dh);
      if (tine > 0.0) {
        float sg = sign(scratch);
        tine = s * tine / period + scratch + 0.1;
        tine = clamp(tine + 1.0, 0.5 + sg * 0.5, 1.5 + sg * 0.5);
        color *= tine;
      }
    }
  }
  if (noise > 0.0 && noiseSize > 0.0) {
    vec2 pc = floor(uv * dim / noiseSize);
    color += (rand(pc * noiseSize * (seed + 0.01)) - 0.5) * noise;
  }
  return vec4(color, fc.a);
}`,
};
export default def;
