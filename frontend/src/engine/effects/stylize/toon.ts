/**
 * Cartoon: flat, posterised colour regions with ink outlines. Our own: an edge-preserving smoothing pass, then colour
 * quantisation in HSV and Sobel outlines.
 */
import { COLOR_GLSL } from "../glsl.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "toon", label: "Cartoon", group: "Stylize", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "levels", label: "Colour levels", type: "int", default: 6, min: 2, max: 16, step: 1 },
    { name: "edges", label: "Outlines", type: "float", default: 0.7, min: 0, max: 1, step: 0.01 },
    { name: "thickness", label: "Outline width", type: "float", default: 1.5, min: 0.5, max: 5, step: 0.1, unit: "px" },
    { name: "smooth_", label: "Smoothing", type: "float", default: 0.6, min: 0, max: 1, step: 0.01 },
    { name: "saturation", label: "Saturation", type: "float", default: 1.2, min: 0, max: 2, step: 0.01 },
  ],
  passes: [
    { glsl: `
vec4 effect(vec2 uv) {
  vec4 c0 = getColor(uv);
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  vec2 px = 1.5 * uScale / uResolution;
  for (int y = -3; y <= 3; y++) for (int x = -3; x <= 3; x++) {
    vec3 c = getColor(uv + vec2(float(x), float(y)) * px).rgb;
    float d = length(c - c0.rgb);
    float w = exp(-d * d * 30.0) * exp(-float(x * x + y * y) * 0.08);
    acc += c * w; ws += w;
  }
  return vec4(mix(c0.rgb, acc / ws, smooth_), c0.a);
}` },
    { glsl: `${COLOR_GLSL}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec3 h = cRgb2Hsv(clamp(c.rgb, 0.0, 1.0));
  float n = max(levels, 2.0);
  h.z = floor(h.z * n + 0.5) / n;
  h.y = clamp(floor(h.y * n * 0.5 + 0.5) / (n * 0.5) * saturation, 0.0, 1.0);
  vec3 q = cHsv2Rgb(h);
  vec2 px = thickness * uScale / uResolution;
  float tl = cLuma(getColor(uv + vec2(-px.x, -px.y)).rgb), t = cLuma(getColor(uv + vec2(0.0, -px.y)).rgb), tr = cLuma(getColor(uv + vec2(px.x, -px.y)).rgb);
  float l = cLuma(getColor(uv + vec2(-px.x, 0.0)).rgb), r = cLuma(getColor(uv + vec2(px.x, 0.0)).rgb);
  float bl = cLuma(getColor(uv + vec2(-px.x, px.y)).rgb), b = cLuma(getColor(uv + vec2(0.0, px.y)).rgb), br = cLuma(getColor(uv + vec2(px.x, px.y)).rgb);
  float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br, gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
  float e = smoothstep(0.15, 0.45, length(vec2(gx, gy)));
  return vec4(mix(q, vec3(0.05), e * edges), c.a);
}` },
  ],
};
export default def;
