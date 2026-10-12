/**
 * Lens distortion: barrel (positive) or pincushion (negative), a Brown–Conrady radial model (each output pixel
 * samples radius r·(1 + k1·r² + k2·r⁴)), with an optional zoom so a barrel never shows the edge. Our own GLSL.
 */
import type { EffectDef, ParamValues, PassContext } from "../registry.ts";

/** The zoom s (≤ 1) at which the corner samples exactly the corner: s·(1 + k1 s²R² + k2 s⁴R⁴) = 1. */
export function fillZoom(k1: number, k2: number, R: number): number {
  const f = (s: number) => s * (1 + k1 * s * s * R * R + k2 * s ** 4 * R ** 4);
  if (f(1) <= 1) return 1;
  let lo = 0.05, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (f(m) > 1) hi = m; else lo = m; }
  return lo;
}

const coeffs = (p: ParamValues) => [Number(p.amount) * 0.5, Number(p.cubic) * 0.3];

const def: EffectDef = {
  id: "lens_distortion", label: "Lens distortion", group: "Lens", author: "Tatvam", license: "Proprietary",
  description: "Barrel (positive) or pincushion (negative) distortion",
  params: [
    { name: "amount", label: "Amount", type: "float", default: 0.25, min: -1, max: 1, step: 0.01 },
    { name: "cubic", label: "Edge", type: "float", default: 0.1, min: -1, max: 1, step: 0.01, description: "The r⁴ term" },
    { name: "fill", label: "Zoom to fill", type: "bool", default: true },
    { name: "centre", label: "Centre", type: "point", default: [0.5, 0.5] },
  ],
  uniforms: (p: ParamValues, c: PassContext) => {
    const [k1, k2] = coeffs(p), asp = c.w / Math.max(c.h, 1);
    return { uK: [k1, k2], uZoom: p.fill === false ? 1 : fillZoom(k1, k2, Math.hypot(asp / 2, 0.5)) };
  },
  glsl: `
uniform vec2 uK;
uniform float uZoom;
vec4 effect(vec2 uv) {
  vec2 asp = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 d = (uv - centre) * asp * uZoom;
  float r2 = dot(d, d);
  vec2 q = d * (1.0 + uK.x * r2 + uK.y * r2 * r2) / asp + centre;
  if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) return vec4(0.0);
  return getColor(q);
}`,
};
export default def;
