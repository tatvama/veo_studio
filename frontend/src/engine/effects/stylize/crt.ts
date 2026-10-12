/**
 * CRT: a curved tube's scan lines, noise and vignette. Port of CRTFilter from pixi-filters 6.1.5
 * (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts). Changed: the lines move with the clip's time × speed, new noise every frame, sizes
 * in composition pixels; noise added to colour only.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "crt", label: "CRT screen", group: "Stylize", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / CRTFilter",
  params: [
    { name: "curvature", label: "Curvature", type: "float", default: 1, min: 0, max: 10, step: 0.1 },
    { name: "lineWidth", label: "Line width", type: "float", default: 1, min: 0, max: 5, step: 0.1 },
    { name: "lineContrast", label: "Line contrast", type: "float", default: 0.25, min: 0, max: 1, step: 0.01 },
    { name: "verticalLine", label: "Vertical lines", type: "bool", default: false },
    { name: "noise", label: "Noise", type: "float", default: 0.15, min: 0, max: 1, step: 0.01 },
    { name: "noiseSize", label: "Noise size", type: "float", default: 1, min: 1, max: 10, step: 0.1, unit: "px" },
    { name: "vignetting", label: "Vignette", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
    { name: "vignettingAlpha", label: "Vignette opacity", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
    { name: "vignettingBlur", label: "Vignette softness", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
    { name: "speed", label: "Line speed", type: "float", default: 10, min: 0, max: 60, step: 0.5 },
  ],
  glsl: `
const float SQRT_2 = 1.414213;
float rand(vec2 co) { return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453); }
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec2 dim = uResolution / max(uScale, 1e-3);
  float seed = fract(uFrame * 0.1234567 + 0.5) + 0.1;
  if (noise > 0.0 && noiseSize > 0.0) {
    vec2 pc = floor(uv * dim / noiseSize);
    c.rgb += (rand(pc * noiseSize * seed) - 0.5) * noise;
  }
  if (vignetting > 0.0) {
    float outer = SQRT_2 - vignetting * SQRT_2;
    vec2 dir = vec2(0.5) - uv;
    dir.y *= dim.y / dim.x;
    float darker = clamp((outer - length(dir) * SQRT_2) / (0.00001 + vignettingBlur * SQRT_2), 0.0, 1.0);
    c.rgb *= darker + (1.0 - darker) * (1.0 - vignettingAlpha);
  }
  if (lineWidth > 0.0) {
    vec2 dir = uv - 0.5;
    float cv = curvature > 0.0 ? curvature : 1.0;
    float k = curvature > 0.0 ? (length(dir * dir) * 0.25 * cv * cv + 0.935 * cv) : 1.0;
    vec2 q = dir * k;
    float v = verticalLine > 0.5 ? q.x * dim.x : q.y * dim.y;
    v *= min(1.0, 2.0 / lineWidth) / cv;
    c.rgb *= 1.0 + cos(v * 1.2 - uTime * speed) * 0.5 * lineContrast;
    float seg = verticalLine > 0.5 ? mod((dir.x + 0.5) * dim.x, 4.0) : mod((dir.y + 0.5) * dim.y, 4.0);
    c.rgb *= 0.99 + ceil(seg) * 0.015;
  }
  return c;
}`,
};
export default def;
