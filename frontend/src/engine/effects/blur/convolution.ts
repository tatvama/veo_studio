/**
 * Convolution: a 3×3 kernel (sharpen, edge detect, emboss, box blur or your own). Port of ConvolutionFilter from
 * pixi-filters 6.1.5 (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad
 * Engler (full notice: effects/licenses.ts).
 */
import type { EffectDef } from "../registry.ts";

const PRESETS: Record<string, number[]> = {
  sharpen: [0, -1, 0, -1, 5, -1, 0, -1, 0], edges: [-1, -1, -1, -1, 8, -1, -1, -1, -1], emboss: [-2, -1, 0, -1, 1, 1, 0, 1, 2],
  box: [1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9], identity: [0, 0, 0, 0, 1, 0, 0, 0, 0],
};
const def: EffectDef = {
  id: "convolution", label: "Convolution", group: "Blur & Sharpen", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / ConvolutionFilter",
  params: [
    { name: "preset", label: "Kernel", type: "enum", default: "sharpen", options: [{ value: "sharpen", label: "Sharpen" }, { value: "edges", label: "Edge detect" },
      { value: "emboss", label: "Emboss" }, { value: "box", label: "Box blur" }, { value: "custom", label: "Custom" }] },
    { name: "matrix", label: "Custom kernel (row by row)", type: "matrix3", default: [0, 0, 0, 0, 1, 0, 0, 0, 0] },
    { name: "spread", label: "Spread", type: "float", default: 1, min: 0.5, max: 8, step: 0.5, unit: "px" },
  ],
  uniforms: (p) => ({ kernel: p.preset === "custom" ? ((p.matrix as number[]) ?? PRESETS.identity) : PRESETS[String(p.preset)] ?? PRESETS.identity }),
  glsl: `
uniform mat3 kernel;
vec4 effect(vec2 uv) {
  vec2 t = spread * uScale / uResolution;
  vec4 c22 = getColor(uv);
  vec4 o = getColor(uv - t) * kernel[0][0] + getColor(uv + vec2(0.0, -t.y)) * kernel[0][1] + getColor(uv + vec2(t.x, -t.y)) * kernel[0][2]
    + getColor(uv + vec2(-t.x, 0.0)) * kernel[1][0] + c22 * kernel[1][1] + getColor(uv + vec2(t.x, 0.0)) * kernel[1][2]
    + getColor(uv + vec2(-t.x, t.y)) * kernel[2][0] + getColor(uv + vec2(0.0, t.y)) * kernel[2][1] + getColor(uv + t) * kernel[2][2];
  return vec4(o.rgb, c22.a);
}`,
};
export default def;
