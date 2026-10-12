/**
 * Perspective (corner pin): moves the picture's four corners (fractions of the picture). Port of perspective from
 * glfx.js by Evan Wallace (https://github.com/evanw/glfx.js): MIT License, Copyright (C) 2011 by Evan Wallace
 * (full notice: effects/licenses.ts). Changed: the corners are parameters; outside the quad is transparent.
 */
import type { EffectDef } from "../registry.ts";

import { inv3 } from "../../yuv.ts";

/** glfx.js getSquareToQuad: the column-major 3×3 that takes the unit square to the quad (x0,y0 … x3,y3). */
export function squareToQuad(q: number[]): number[] {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
  const dx1 = x1 - x2, dy1 = y1 - y2, dx2 = x3 - x2, dy2 = y3 - y2, dx3 = x0 - x1 + x2 - x3, dy3 = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  const a = det ? (dx3 * dy2 - dx2 * dy3) / det : 0, b = det ? (dx1 * dy3 - dx3 * dy1) / det : 0;
  return [x1 - x0 + a * x1, y1 - y0 + a * y1, a, x3 - x0 + b * x3, y3 - y0 + b * y3, b, x0, y0, 1];
}
const pt = (v: unknown, d: [number, number]) => (Array.isArray(v) && v.length >= 2 ? [Number(v[0]) || 0, Number(v[1]) || 0] : d);

const def: EffectDef = {
  id: "perspective", label: "Perspective (corner pin)", group: "Transform", author: "Evan Wallace", license: "MIT", source: "glfx.js / perspective",
  params: [
    { name: "topLeft", label: "Top left", type: "point", default: [0, 0] },
    { name: "topRight", label: "Top right", type: "point", default: [1, 0] },
    { name: "bottomRight", label: "Bottom right", type: "point", default: [1, 1] },
    { name: "bottomLeft", label: "Bottom left", type: "point", default: [0, 1] },
  ],
  uniforms: (p) => {
    const q = [...pt(p.topLeft, [0, 0]), ...pt(p.topRight, [1, 0]), ...pt(p.bottomRight, [1, 1]), ...pt(p.bottomLeft, [0, 1])];
    return { uWarp: inv3(squareToQuad(q)) };
  },
  glsl: `
uniform mat3 uWarp;
vec4 effect(vec2 uv) {
  vec3 w = uWarp * vec3(uv, 1.0);
  vec2 s = w.xy / w.z;
  vec2 e = clamp((0.5 - abs(s - 0.5)) * uResolution + 0.5, 0.0, 1.0);
  vec4 c = getColor(clamp(s, 0.0, 1.0));
  return vec4(c.rgb, c.a * e.x * e.y * step(0.0, w.z));
}`,
};
export default def;
