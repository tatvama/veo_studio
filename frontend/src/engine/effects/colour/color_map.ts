/**
 * Colour map: a colour look-up from a strip image (size² × size, e.g. 256×16). Port of ColorMapFilter from
 * pixi-filters 6.1.5 (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad
 * Engler (full notice: effects/licenses.ts). Changed: the strip's size comes from the image; straight alpha.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "color_map", label: "Colour map (LUT image)", group: "Colour", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / ColorMapFilter",
  params: [
    { name: "map", label: "Map image", type: "image", default: "", description: "A colour strip: width = size², height = size" },
    { name: "amount", label: "Amount", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 color = getColor(uv);
  float size = float(textureSize(map, 0).y);
  if (size < 2.0) return color;
  float sliceSize = 1.0 / size;
  float slicePixelSize = sliceSize / size;
  float sliceInnerSize = slicePixelSize * (size - 1.0);
  float innerWidth = size - 1.0;
  vec3 c = clamp(color.rgb, 0.0, 1.0);
  float zSlice0 = min(floor(c.b * innerWidth), innerWidth);
  float zSlice1 = min(zSlice0 + 1.0, innerWidth);
  float xOffset = slicePixelSize * 0.5 + c.r * sliceInnerSize;
  float s0 = xOffset + zSlice0 * sliceSize;
  float s1 = xOffset + zSlice1 * sliceSize;
  float yOffset = sliceSize * 0.5 + c.g * (1.0 - sliceSize);
  vec4 adjusted = mix(texture(map, vec2(s0, yOffset)), texture(map, vec2(s1, yOffset)), fract(c.b * innerWidth));
  return vec4(mix(color.rgb, adjusted.rgb, amount), color.a);
}`,
};
export default def;
