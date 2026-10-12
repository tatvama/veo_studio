/**
 * Deflicker: evens out frame-to-frame brightness changes (time-lapse, mains-lit footage). Our own: the frame's mean
 * luma (a 1/16 reduction, then one value), smoothed over time against the clip's running mean (EffectDef.temporal
 * keeps it), and a gain toward it.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "deflicker", label: "Deflicker", group: "Clean-up", author: "Tatvam", license: "Proprietary",
  description: "Smooths frame-to-frame brightness changes",
  temporal: { pass: 1 },
  params: [
    { name: "smoothing", label: "Smoothing", type: "float", default: 0.85, min: 0, max: 0.98, step: 0.01, description: "How slowly the reference brightness follows the picture" },
    { name: "strength", label: "Strength", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
  ],
  passes: [
    { scale: 1 / 16, glsl: `
vec4 effect(vec2 uv) {
  vec2 px = 1.0 / max(uInputSize, vec2(1.0));
  float s = 0.0;
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) s += dot(getColor(uv + (vec2(float(x), float(y)) - 1.5) * px * 4.0).rgb, vec3(0.2126, 0.7152, 0.0722));
  return vec4(vec3(s / 16.0), 1.0);
}` },
    { size: [1, 1], glsl: `
vec4 effect(vec2 uv) {
  ivec2 n = textureSize(uInput, 0);
  float s = 0.0;
  for (int y = 0; y < 256; y++) {
    if (y >= n.y) break;
    for (int x = 0; x < 256; x++) { if (x >= n.x) break; s += texelFetch(uInput, ivec2(x, y), 0).r; }
  }
  float cur = s / float(max(n.x * n.y, 1));
  float ref = uHistoryValid > 0.5 ? mix(cur, texture(uHistory, vec2(0.5)).r, smoothing) : cur;
  return vec4(ref, cur, 0.0, 1.0);
}` },
    { glsl: `
vec4 effect(vec2 uv) {
  vec4 o = getOriginal(uv);
  vec2 m = texelFetch(uPass1, ivec2(0), 0).rg;
  float g = clamp(m.x / max(m.y, 1e-4), 0.5, 2.0);
  return vec4(o.rgb * mix(1.0, g, strength), o.a);
}` },
  ],
};
export default def;
