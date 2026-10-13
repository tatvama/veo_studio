/**
 * VHS: a tape look, smeared and delayed chroma, soft luma, tracking lines and tape noise, a wobbling picture, a
 * head-switching band at the bottom and scan lines. Our own GLSL (two passes: chroma bleed, then the tape).
 */
import { NOISE_GLSL } from "../glsl.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "vhs", label: "VHS", group: "Stylize", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "amount", label: "Amount", type: "float", default: 0.7, min: 0, max: 1, step: 0.01 },
    { name: "bleed", label: "Colour bleed", type: "float", default: 6, min: 0, max: 30, step: 0.5, unit: "px" },
    { name: "tracking", label: "Tracking", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
    { name: "noise", label: "Tape noise", type: "float", default: 0.4, min: 0, max: 1, step: 0.01 },
    { name: "scanlines", label: "Scan lines", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
  ],
  passes: [
    { glsl: `
vec3 toY(vec3 c) { return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(-0.147, -0.289, 0.436)), dot(c, vec3(0.615, -0.515, -0.1))); }
vec3 fromY(vec3 y) { return vec3(y.x + 1.14 * y.z, y.x - 0.395 * y.y - 0.581 * y.z, y.x + 2.032 * y.y); }
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float px = bleed * uScale / uResolution.x;
  vec2 ch = vec2(0.0);
  float ws = 0.0;
  for (int i = 0; i < 12; i++) {
    float x = float(i) / 11.0;
    float w = exp(-x * 2.5);
    ch += toY(getColor(uv - vec2(x * px * 2.0 - px * 0.3, 0.0)).rgb).yz * w;
    ws += w;
  }
  float y = 0.0;
  for (int i = -2; i <= 2; i++) y += toY(getColor(uv + vec2(float(i) * 0.6 / uResolution.x * uScale, 0.0)).rgb).x;
  y /= 5.0;
  vec3 yy = vec3(mix(toY(c.rgb).x, y, amount), mix(toY(c.rgb).yz, ch / ws * 1.1, amount));
  return vec4(fromY(yy), c.a);
}` },
    { glsl: `${NOISE_GLSL}
vec4 effect(vec2 uv) {
  float f = uFrame;
  float wob = (nNoise(vec2(uv.y * 4.0, f * 0.3)) - 0.5) * 0.004 * amount;
  float band = fract(f * 0.013 + 0.3);
  float tr = exp(-pow((uv.y - band) * 14.0, 2.0)) * tracking;
  float shift = wob + tr * (nHash(vec2(floor(uv.y * 200.0), f)) - 0.5) * 0.05;
  float head = smoothstep(0.94, 0.97, uv.y) * amount;
  shift += head * (nNoise(vec2(uv.y * 40.0, f)) - 0.3) * 0.03;
  vec4 c = getColor(vec2(uv.x + shift, uv.y));
  float n = nHash(floor(uv * uResolution / max(uScale, 1e-3) * vec2(0.5, 1.0)) + f * 13.0) - 0.5;
  c.rgb += n * noise * 0.18 * amount;
  float streak = step(0.995 - tr * 0.03, nHash(vec2(floor(uv.y * 300.0), f * 7.0)));
  c.rgb = mix(c.rgb, vec3(0.9), streak * noise * amount);
  c.rgb *= 1.0 - scanlines * 0.25 * (0.5 + 0.5 * sin(uv.y * uResolution.y / max(uScale, 1e-3) * 3.14159));
  c.rgb = mix(c.rgb, c.rgb * vec3(1.02, 0.98, 1.04) + 0.02, amount * 0.6);
  return c;
}` },
  ],
};
export default def;
