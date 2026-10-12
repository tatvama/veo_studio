/**
 * Neon edges: glowing outlines in the picture's own colours (or a rainbow by direction) on a darkened picture. Our own:
 * Sobel edges, then a half-size glow blurred in two passes and added.
 */
import { COLOR_GLSL } from "../glsl.ts";
import { gaussian } from "../passes.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "neon_edges", label: "Neon edges", group: "Stylize", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "intensity", label: "Intensity", type: "float", default: 1.4, min: 0, max: 4, step: 0.01 },
    { name: "glow", label: "Glow", type: "float", default: 6, min: 0, max: 40, step: 0.5, unit: "px" },
    { name: "background", label: "Background", type: "float", default: 0.15, min: 0, max: 1, step: 0.01, description: "How much of the picture shows" },
    { name: "rainbow", label: "Rainbow", type: "bool", default: false, description: "Colour by edge direction" },
  ],
  passes: [
    { glsl: `${COLOR_GLSL}
vec4 effect(vec2 uv) {
  vec2 px = 1.0 * uScale / uResolution;
  float tl = cLuma(getColor(uv + vec2(-px.x, -px.y)).rgb), t = cLuma(getColor(uv + vec2(0.0, -px.y)).rgb), tr = cLuma(getColor(uv + vec2(px.x, -px.y)).rgb);
  float l = cLuma(getColor(uv + vec2(-px.x, 0.0)).rgb), r = cLuma(getColor(uv + vec2(px.x, 0.0)).rgb);
  float bl = cLuma(getColor(uv + vec2(-px.x, px.y)).rgb), b = cLuma(getColor(uv + vec2(0.0, px.y)).rgb), br = cLuma(getColor(uv + vec2(px.x, px.y)).rgb);
  vec2 g = vec2(-tl - 2.0 * l - bl + tr + 2.0 * r + br, -tl - 2.0 * t - tr + bl + 2.0 * b + br);
  float e = smoothstep(0.08, 0.5, length(g));
  vec3 src = getColor(uv).rgb;
  vec3 col = rainbow > 0.5 ? cHsv2Rgb(vec3(atan(g.y, g.x) / 6.2831853 + 0.5, 0.9, 1.0)) : normalize(max(src, 0.02)) * 1.6;
  return vec4(col * e, 1.0);
}` },
    gaussian("glow", [1, 0], { scale: 0.5 }),
    gaussian("glow", [0, 1], { scale: 0.5 }),
    { glsl: `
vec4 effect(vec2 uv) {
  vec4 o = getOriginal(uv);
  vec3 edge = texture(uPass0, uv).rgb;
  vec3 halo = getColor(uv).rgb;
  return vec4(o.rgb * background + (edge + halo * 1.5) * intensity, o.a);
}` },
  ],
};
export default def;
