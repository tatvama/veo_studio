/**
 * Hue vs saturation, hue vs hue and luma vs saturation curves (Resolve-style). Each curve is points [x, y] with
 * y = 0.5 meaning "no change"; they are baked into a 256-entry lookup with curves.ts's monotone cubic (hue curves wrap
 * around: periodic). Greys are left alone (the effect fades in with saturation). Our own GLSL.
 */
import { COLOR_GLSL } from "../glsl.ts";
import type { EffectDef } from "../registry.ts";

const flat: [number, number][] = [[0, 0.5], [1, 0.5]];
const at = (tex: string, x: string) => `texture(${tex}, vec2(clamp(${x}, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).r`;

export const hueVsSat: EffectDef = {
  id: "hue_vs_sat", label: "Hue vs saturation", group: "Colour", author: "Tatvam", license: "Proprietary",
  description: "Saturation by hue: y 0.5 = unchanged, 1 = double, 0 = grey",
  params: [
    { name: "curve", label: "Curve", type: "curve", default: flat, periodic: true },
    { name: "amount", label: "Amount", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `${COLOR_GLSL}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec3 h = cRgb2Hsv(clamp(c.rgb, 0.0, 1.0));
  float k = 2.0 * ${at("curve", "h.x")};
  k = mix(1.0, k, amount * smoothstep(0.0, 0.08, h.y));
  return vec4(cSat(c.rgb, k), c.a);
}`,
};

export const hueVsHue: EffectDef = {
  id: "hue_vs_hue", label: "Hue vs hue", group: "Colour", author: "Tatvam", license: "Proprietary",
  description: "Shifts hues by hue: y 0.5 = unchanged, 0 / 1 = −/+ the range",
  params: [
    { name: "curve", label: "Curve", type: "curve", default: flat, periodic: true },
    { name: "range", label: "Range", type: "float", default: 60, min: 0, max: 180, step: 1, unit: "°" },
    { name: "amount", label: "Amount", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `${COLOR_GLSL}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec3 h = cRgb2Hsv(clamp(c.rgb, 0.0, 1.0));
  float shift = (${at("curve", "h.x")} - 0.5) * 2.0 * range / 360.0;
  vec3 o = cHsv2Rgb(vec3(fract(h.x + shift), h.y, h.z));
  float w = amount * smoothstep(0.0, 0.08, h.y);
  return vec4(mix(c.rgb, o + (c.rgb - clamp(c.rgb, 0.0, 1.0)), w), c.a);
}`,
};

export const lumaVsSat: EffectDef = {
  id: "luma_vs_sat", label: "Luma vs saturation", group: "Colour", author: "Tatvam", license: "Proprietary",
  description: "Saturation by brightness: y 0.5 = unchanged",
  params: [
    { name: "curve", label: "Curve", type: "curve", default: flat },
    { name: "amount", label: "Amount", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `${COLOR_GLSL}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float k = mix(1.0, 2.0 * ${at("curve", "cLuma(c.rgb)")}, amount);
  return vec4(cSat(c.rgb, k), c.a);
}`,
};

export const splitToning: EffectDef = {
  id: "split_toning", label: "Split toning", group: "Colour", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "shadows", label: "Shadows", type: "color", default: "#2a5d8a" },
    { name: "shadow_amount", label: "Shadow amount", type: "float", default: 0.35, min: 0, max: 1, step: 0.01 },
    { name: "highlights", label: "Highlights", type: "color", default: "#e8a15a" },
    { name: "highlight_amount", label: "Highlight amount", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
    { name: "balance", label: "Balance", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
  ],
  glsl: `${COLOR_GLSL}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float l = cLuma(clamp(c.rgb, 0.0, 1.0));
  float pivot = 0.5 + balance * 0.3;
  float ws = 1.0 - smoothstep(0.0, pivot, l), wh = smoothstep(pivot, 1.0, l);
  vec3 ts = shadows - vec3(cLuma(shadows)), th = highlights - vec3(cLuma(highlights));
  return vec4(c.rgb + ts * ws * shadow_amount + th * wh * highlight_amount, c.a);
}`,
};
