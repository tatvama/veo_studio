/**
 * Skin smoothing: a bilateral blur (separable, edge-preserving) applied through a soft skin-tone mask (hue, saturation
 * and brightness ranges of skin), keeping some fine detail. Our own GLSL (three passes).
 */
import { COLOR_GLSL } from "../glsl.ts";
import type { EffectDef, EffectPass } from "../registry.ts";

const bilateral = (dir: [number, number]): EffectPass => ({
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c0 = getColor(uv);
  float R = max(radius * uScale, 0.5);
  vec2 d = vec2(${dir[0].toFixed(1)}, ${dir[1].toFixed(1)}) / uResolution * (R / 7.0);
  vec3 acc = c0.rgb;
  float ws = 1.0;
  for (int i = 1; i <= 7; i++) {
    float fi = float(i);
    float wsp = exp(-fi * fi / 18.0);
    vec3 a = getColor(uv + d * fi).rgb, b = getColor(uv - d * fi).rgb;
    float wa = wsp * exp(-dot(a - c0.rgb, a - c0.rgb) / (2.0 * tolerance * tolerance));
    float wb = wsp * exp(-dot(b - c0.rgb, b - c0.rgb) / (2.0 * tolerance * tolerance));
    acc += a * wa + b * wb;
    ws += wa + wb;
  }
  return vec4(acc / ws, c0.a);
}`,
});

const def: EffectDef = {
  id: "skin_smoothing", label: "Skin smoothing", group: "Clean-up", author: "Tatvam", license: "Proprietary",
  description: "Softens skin, keeps edges and the rest of the picture",
  params: [
    { name: "amount", label: "Amount", type: "float", default: 0.7, min: 0, max: 1, step: 0.01 },
    { name: "radius", label: "Radius", type: "float", default: 8, min: 1, max: 30, step: 0.5, unit: "px" },
    { name: "tolerance", label: "Edge tolerance", type: "float", default: 0.12, min: 0.02, max: 0.5, step: 0.005 },
    { name: "detail", label: "Keep detail", type: "float", default: 0.25, min: 0, max: 1, step: 0.01 },
    { name: "range", label: "Skin range", type: "float", default: 0.5, min: 0, max: 1, step: 0.01, description: "How wide a range of tones counts as skin" },
    { name: "show_mask", label: "Show the mask", type: "bool", default: false },
  ],
  passes: [
    bilateral([1, 0]),
    bilateral([0, 1]),
    { glsl: `${COLOR_GLSL}
float skinMask(vec3 c) {
  vec3 h = cRgb2Hsv(clamp(c, 0.0, 1.0));
  float hue = h.x > 0.5 ? h.x - 1.0 : h.x;          // red wraps to negative
  float w = mix(0.05, 0.14, range);
  float mh = 1.0 - smoothstep(w, w + 0.06, abs(hue - 0.055));
  float ms = smoothstep(0.08, 0.18, h.y) * (1.0 - smoothstep(0.65 + range * 0.2, 0.9, h.y));
  float mv = smoothstep(0.15, 0.35, h.z);
  return mh * ms * mv;
}
vec4 effect(vec2 uv) {
  vec4 o = getOriginal(uv);
  vec3 s = getColor(uv).rgb;
  float m = skinMask(o.rgb) * amount;
  if (show_mask > 0.5) return vec4(vec3(m), 1.0);
  vec3 detailHi = (o.rgb - s) * detail;
  return vec4(mix(o.rgb, s + detailHi, m), o.a);
}` },
  ],
};
export default def;
