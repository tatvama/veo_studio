/**
 * Light map: multiplies the picture by a light image plus an ambient colour. Port of SimpleLightmapFilter from
 * pixi-filters 6.1.5 (https://github.com/pixijs/filters): MIT License, Copyright (c) 2013-2025 Mathew Groves, Chad
 * Engler (full notice: effects/licenses.ts). Without a map image the picture is lit evenly (white).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "simple_lightmap", label: "Light map", group: "Light", author: "PixiJS filters contributors", license: "MIT", source: "pixi-filters 6.1.5 / SimpleLightmapFilter",
  params: [
    { name: "map", label: "Light image", type: "image", default: "" },
    { name: "color", label: "Ambient colour", type: "color", default: "#000000" },
    { name: "alpha", label: "Ambient amount", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 d = getColor(uv);
  vec3 light = texture(map, uv).rgb;
  return vec4(d.rgb * (color * alpha + light), d.a);
}`,
};
export default def;
