/**
 * Motion blur along a direction. Port of MotionBlurFilter from pixi-filters 6.1.5
 * (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "motion_blur", label: "Motion blur", group: "Blur & Sharpen", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / MotionBlurFilter",
  params: [
    { name: "velocity", label: "Velocity", type: "vec2", default: [40, 0], min: -400, max: 400, step: 1, unit: "px" },
    { name: "kernelSize", label: "Samples", type: "int", default: 15, min: 3, max: 64, step: 1 },
    { name: "offset", label: "Offset", type: "float", default: 0, min: -200, max: 200, step: 1, unit: "px" },
  ],
  pad: (p) => Math.hypot(...((p.velocity as number[]) ?? [0, 0])) / 2,
  glsl: `
vec4 effect(vec2 uv) {
  vec4 color = getColor(uv);
  int ks = int(kernelSize);
  if (ks < 2) return color;
  vec2 vel = velocity * uScale / uResolution;
  float off = -offset / (length(velocity) + 1e-5) - 0.5;
  int k = ks - 1;
  for (int i = 0; i < 256; i++) {
    if (i == k) break;
    color += getColor(uv + vel * (float(i) / float(k) + off));
  }
  return color / float(ks);
}`,
};
export default def;
