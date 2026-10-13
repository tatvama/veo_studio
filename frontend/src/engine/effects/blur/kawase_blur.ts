/**
 * Kawase blur: a fast blur from repeated 4-tap passes. Port of KawaseBlurFilter from pixi-filters 6.1.5
 * (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts). Changed: alpha-correct sampling.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "kawase_blur", label: "Kawase blur", group: "Blur & Sharpen", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / KawaseBlurFilter",
  params: [
    { name: "strength", label: "Strength", type: "float", default: 4, min: 0, max: 40, step: 0.5, unit: "px" },
    { name: "quality", label: "Quality (passes)", type: "int", default: 3, min: 1, max: 10, step: 1 },
  ],
  pad: (p) => Number(p.strength) * Number(p.quality),
  passes: [{
    glsl: `
uniform vec2 kOffset;
vec4 pm(vec4 c) { return vec4(c.rgb * c.a, c.a); }
vec4 unpm(vec4 c) { return c.a > 1e-5 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
vec4 effect(vec2 uv) {
  vec2 o = kOffset;
  return unpm(0.25 * (pm(getColor(uv + vec2(-o.x, o.y))) + pm(getColor(uv + o)) + pm(getColor(uv + vec2(o.x, -o.y))) + pm(getColor(uv - o))));
}`,
    repeat: (p) => Math.max(1, Math.round(Number(p.quality))),
    uniforms: (p, c) => { const q = Math.max(1, Math.round(Number(p.quality))), k = Number(p.strength) * c.scale * (1 - c.iteration / q) + 0.5; return { kOffset: [k / c.w, k / c.h] }; },
  }],
};
export default def;
