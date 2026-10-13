/**
 * Hexagonal pixelate: the picture as hexagon cells. Port of hexagonalPixelate from glfx.js by Evan Wallace
 * (https://github.com/evanw/glfx.js): MIT License, Copyright (C) 2011 by Evan Wallace (full notice:
 * effects/licenses.ts). Changed: centre as a fraction, cell size in composition pixels.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "hexagonal_pixelate", label: "Hexagonal pixelate", group: "Stylize", author: "Evan Wallace", license: "MIT", source: "glfx.js / hexagonalPixelate",
  params: [
    { name: "center", label: "Centre", type: "point", default: [0.5, 0.5] },
    { name: "scale", label: "Cell size", type: "float", default: 20, min: 2, max: 200, step: 1, unit: "px" },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec2 ts = uResolution;
  vec2 c = center * ts;
  float sc = max(scale * uScale, 1.0);
  vec2 tex = (uv * ts - c) / sc;
  tex.y /= 0.866025404;
  tex.x -= tex.y * 0.5;
  vec2 a;
  if (tex.x + tex.y - floor(tex.x) - floor(tex.y) < 1.0) a = vec2(floor(tex.x), floor(tex.y));
  else a = vec2(ceil(tex.x), ceil(tex.y));
  vec2 b = vec2(ceil(tex.x), floor(tex.y));
  vec2 cc = vec2(floor(tex.x), ceil(tex.y));
  vec3 T = vec3(tex.x, tex.y, 1.0 - tex.x - tex.y);
  vec3 A = vec3(a.x, a.y, 1.0 - a.x - a.y);
  vec3 B = vec3(b.x, b.y, 1.0 - b.x - b.y);
  vec3 C = vec3(cc.x, cc.y, 1.0 - cc.x - cc.y);
  float al = length(T - A), bl = length(T - B), cl = length(T - C);
  vec2 ch;
  if (al < bl) { if (al < cl) ch = a; else ch = cc; }
  else { if (bl < cl) ch = b; else ch = cc; }
  ch.x += ch.y * 0.5;
  ch.y *= 0.866025404;
  ch *= sc / ts;
  return getColor(ch + c / ts);
}`,
};
export default def;
