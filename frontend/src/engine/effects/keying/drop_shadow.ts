/**
 * Drop shadow: an offset, blurred, coloured copy of the picture's alpha behind it. Port of DropShadowFilter from
 * pixi-filters 6.1.5 (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad
 * Engler (full notice: effects/licenses.ts). Changed: angle and distance instead of an offset; Kawase blur passes
 * on straight alpha.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "drop_shadow", label: "Drop shadow", group: "Keying", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / DropShadowFilter",
  params: [
    { name: "angle", label: "Angle", type: "angle", default: 45, min: -180, max: 180, step: 1, unit: "°" },
    { name: "distance", label: "Distance", type: "float", default: 12, min: 0, max: 200, step: 1, unit: "px" },
    { name: "color", label: "Colour", type: "color", default: "#000000" },
    { name: "alpha", label: "Opacity", type: "float", default: 0.6, min: 0, max: 1, step: 0.01 },
    { name: "blur", label: "Softness", type: "float", default: 6, min: 0, max: 50, step: 0.5, unit: "px" },
    { name: "quality", label: "Quality", type: "int", default: 3, min: 1, max: 8, step: 1 },
    { name: "shadowOnly", label: "Shadow only", type: "bool", default: false },
  ],
  pad: (p) => Number(p.distance) + Number(p.blur) * Number(p.quality) + 2,
  passes: [
    { glsl: `
vec4 effect(vec2 uv) {
  float r = radians(angle);
  vec2 off = vec2(cos(r), sin(r)) * distance * uScale / uResolution;
  return vec4(color, getColor(uv - off).a * alpha);
}` },
    { glsl: `
uniform vec2 kOffset;
vec4 pm(vec4 c) { return vec4(c.rgb * c.a, c.a); }
vec4 unpm(vec4 c) { return c.a > 1e-5 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
vec4 effect(vec2 uv) {
  vec2 o = kOffset;
  return unpm(0.25 * (pm(getColor(uv + vec2(-o.x, o.y))) + pm(getColor(uv + o)) + pm(getColor(uv + vec2(o.x, -o.y))) + pm(getColor(uv - o))));
}`,
      repeat: (p) => Math.max(1, Math.round(Number(p.quality))),
      uniforms: (p, c) => { const q = Math.max(1, Math.round(Number(p.quality))), k = Number(p.blur) * c.scale * (1 - c.iteration / q) + 0.5; return { kOffset: [k / c.w, k / c.h] }; } },
    { glsl: `
vec4 effect(vec2 uv) {
  vec4 o = getOriginal(uv), s = getColor(uv);
  if (shadowOnly > 0.5) return s;
  float a = o.a + s.a * (1.0 - o.a);
  return a > 1e-5 ? vec4((o.rgb * o.a + s.rgb * s.a * (1.0 - o.a)) / a, a) : vec4(0.0);
}` },
  ],
};
export default def;
