/**
 * Outer glow: a soft coloured halo around (and optionally inside) the picture's alpha. Port of GlowFilter from
 * pixi-filters 6.1.5 (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad
 * Engler (full notice: effects/licenses.ts). Original filter by mishaa. Changed: loop bounds as uniforms (GLSL ES
 * 3.00), distance in composition pixels.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "outer_glow", label: "Outer glow", group: "Keying", author: "mishaa, PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / GlowFilter",
  params: [
    { name: "distance", label: "Distance", type: "float", default: 10, min: 1, max: 60, step: 1, unit: "px" },
    { name: "outerStrength", label: "Outer strength", type: "float", default: 4, min: 0, max: 20, step: 0.1 },
    { name: "innerStrength", label: "Inner strength", type: "float", default: 0, min: 0, max: 20, step: 0.1 },
    { name: "color", label: "Colour", type: "color", default: "#ffffff" },
    { name: "alpha", label: "Opacity", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
    { name: "quality", label: "Quality", type: "float", default: 0.1, min: 0.01, max: 1, step: 0.01 },
    { name: "knockout", label: "Glow only", type: "bool", default: false },
  ],
  pad: (p) => Number(p.distance) + 2,
  uniforms: (p, c) => ({ angleStep: Math.min(1 / Math.max(Number(p.quality), 0.01) / Math.max(Number(p.distance) * c.scale, 1), Math.PI * 2) }),
  glsl: `
uniform float angleStep;
vec4 effect(vec2 uv) {
  float dist = max(1.0, floor(distance * uScale));
  float total = 0.0, steps = 0.0;
  for (float a = 0.0; a < 6.2832; a += angleStep) {
    vec2 dir = vec2(cos(a), sin(a)) / uResolution;
    for (float d = 0.0; d < 64.0; d++) {
      if (d >= dist) break;
      total += (dist - d) * getColor(clamp(uv + dir * (d + 1.0), 0.0, 1.0)).a;
    }
    steps += 1.0;
  }
  float ratio = total / max(steps * dist * (dist + 1.0) / 2.0, 1e-5);
  vec4 cur = getColor(uv);
  vec4 curP = vec4(cur.rgb * cur.a, cur.a);
  vec4 g = vec4(color * alpha, alpha);
  float innerA = (1.0 - ratio) * innerStrength * cur.a * alpha;
  vec4 inner = mix(curP, g, min(1.0, innerA));
  float outerA = ratio * outerStrength * (1.0 - cur.a) * alpha;
  vec4 res = knockout > 0.5 ? vec4(color, 1.0) * (outerA + innerA) : inner + g * min(1.0 - inner.a, outerA);
  return res.a > 1e-5 ? vec4(res.rgb / res.a, min(res.a, 1.0)) : vec4(0.0);
}`,
};
export default def;
