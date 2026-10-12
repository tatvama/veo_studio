/**
 * ASCII: the picture as characters (. : * o & 8 @ #) by brightness. Port of AsciiFilter from pixi-filters 6.1.5
 * (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad Engler (full
 * notice: effects/licenses.ts). Original filter by Vico (@vicocotea), original shader by movAX13h. Changed:
 * straight alpha.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "ascii", label: "ASCII", group: "Stylize", author: "Vico (@vicocotea), original shader by movAX13h, PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / AsciiFilter",
  params: [
    { name: "size", label: "Character size", type: "float", default: 8, min: 2, max: 64, step: 1, unit: "px" },
    { name: "color", label: "Colour", type: "color", default: "#ffffff" },
    { name: "replaceColor", label: "Use the colour", type: "bool", default: false },
  ],
  glsl: `
float character(float n, vec2 p) {
  p = floor(p * vec2(4.0, 4.0) + 2.5);
  if (clamp(p.x, 0.0, 4.0) == p.x && clamp(p.y, 0.0, 4.0) == p.y) {
    if (int(mod(n / exp2(p.x + 5.0 * p.y), 2.0)) == 1) return 1.0;
  }
  return 0.0;
}
vec4 effect(vec2 uv) {
  float s = max(size * uScale, 2.0);
  vec2 px = uv * uResolution;
  vec4 c = getColor((floor(px / s) * s + 0.5) / uResolution);
  float gray = 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
  float n = 65536.0;
  if (gray > 0.2) n = 65600.0;
  if (gray > 0.3) n = 332772.0;
  if (gray > 0.4) n = 15255086.0;
  if (gray > 0.5) n = 23385164.0;
  if (gray > 0.6) n = 15252014.0;
  if (gray > 0.7) n = 13199452.0;
  if (gray > 0.8) n = 11512810.0;
  float ch = character(n, vec2(-1.0) + mod(px, s) / s * 2.0);
  return vec4(replaceColor > 0.5 ? color : c.rgb, c.a * ch);
}`,
};
export default def;
