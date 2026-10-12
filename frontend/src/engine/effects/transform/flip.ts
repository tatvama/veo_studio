/**
 * Flip: mirrors the picture horizontally and / or vertically (the same as fx.flip_h / flip_v).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "flip", label: "Flip", group: "Transform", gpuOnly: false, author: "Tatvam", license: "Proprietary",
  params: [
    { name: "flip_h", label: "Horizontal", type: "bool", default: true },
    { name: "flip_v", label: "Vertical", type: "bool", default: false },
  ],
  glsl: `
vec4 effect(vec2 uv) { return getColor(vec2(flip_h > 0.5 ? 1.0 - uv.x : uv.x, flip_v > 0.5 ? 1.0 - uv.y : uv.y)); }`,
};
export default def;
