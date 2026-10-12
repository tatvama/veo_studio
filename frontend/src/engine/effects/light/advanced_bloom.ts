/**
 * Advanced bloom: only the parts brighter than a threshold, blurred and added back. Port of AdvancedBloomFilter
 * from pixi-filters 6.1.5 (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves,
 * Chad Engler (full notice: effects/licenses.ts). Changed: Kawase passes at half size; straight alpha.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "advanced_bloom", label: "Advanced bloom", group: "Light", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / AdvancedBloomFilter",
  params: [
    { name: "threshold", label: "Threshold", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "bloomScale", label: "Bloom", type: "float", default: 1, min: 0, max: 3, step: 0.01 },
    { name: "brightness", label: "Brightness", type: "float", default: 1, min: 0, max: 3, step: 0.01 },
    { name: "blur", label: "Blur", type: "float", default: 8, min: 0, max: 60, step: 0.5, unit: "px" },
    { name: "quality", label: "Quality", type: "int", default: 4, min: 1, max: 10, step: 1 },
  ],
  pad: (p) => Number(p.blur) * Number(p.quality) * 0.5,
  passes: [
    { glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float b = (max(c.r, max(c.g, c.b)) + min(c.r, min(c.g, c.b))) * 0.5;
  return b > threshold ? vec4(c.rgb * c.a, 1.0) : vec4(0.0, 0.0, 0.0, 1.0);
}`, scale: 0.5 },
    { glsl: `
uniform vec2 kOffset;
vec4 effect(vec2 uv) {
  vec2 o = kOffset;
  return 0.25 * (getColor(uv + vec2(-o.x, o.y)) + getColor(uv + o) + getColor(uv + vec2(o.x, -o.y)) + getColor(uv - o));
}`, scale: 0.5, repeat: (p) => Math.max(1, Math.round(Number(p.quality))), uniforms: (p, c) => { const q = Math.max(1, Math.round(Number(p.quality))), k = Number(p.blur) * c.scale * (1 - c.iteration / q) + 0.5; return { kOffset: [k / c.w, k / c.h] }; } },
    { glsl: `
vec4 effect(vec2 uv) {
  vec4 o = getOriginal(uv);
  vec3 b = getColor(uv).rgb * bloomScale;
  vec3 rgb = o.rgb * o.a * brightness + b;
  float a = clamp(max(o.a, max(b.r, max(b.g, b.b))), 0.0, 1.0);
  return a > 1e-5 ? vec4(rgb / a, a) : vec4(0.0);
}` },
  ],
};
export default def;
