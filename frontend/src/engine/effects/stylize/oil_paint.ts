/**
 * Oil paint: thick, flat brush areas that keep the edges (a four-sector Kuwahara filter: each pixel takes the mean of
 * its least varied neighbourhood). Our own GLSL.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "oil_paint", label: "Oil paint", group: "Stylize", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "radius", label: "Brush size", type: "float", default: 5, min: 1, max: 12, step: 0.5, unit: "px" },
    { name: "sharpness", label: "Sharpness", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c0 = getColor(uv);
  float R = max(radius * uScale, 1.0);
  float st = R / 4.0;
  vec2 px = 1.0 / uResolution;
  vec3 m[4]; vec3 s[4];
  for (int k = 0; k < 4; k++) { m[k] = vec3(0.0); s[k] = vec3(0.0); }
  for (int j = 0; j <= 4; j++) for (int i = 0; i <= 4; i++) {
    vec2 o = vec2(float(i), float(j)) * st;
    vec3 a = getColor(uv + vec2(-o.x, -o.y) * px).rgb, b = getColor(uv + vec2(o.x, -o.y) * px).rgb;
    vec3 c = getColor(uv + vec2(-o.x, o.y) * px).rgb, d = getColor(uv + vec2(o.x, o.y) * px).rgb;
    m[0] += a; s[0] += a * a; m[1] += b; s[1] += b * b; m[2] += c; s[2] += c * c; m[3] += d; s[3] += d * d;
  }
  float best = 1e9;
  vec3 col = c0.rgb;
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  for (int k = 0; k < 4; k++) {
    vec3 mu = m[k] / 25.0;
    vec3 v = abs(s[k] / 25.0 - mu * mu);
    float sig = v.r + v.g + v.b;
    float w = 1.0 / (1.0 + pow(sig * 1000.0, 1.0 + sharpness * 6.0));
    acc += mu * w; ws += w;
    if (sig < best) { best = sig; col = mu; }
  }
  return vec4(mix(acc / ws, col, sharpness), c0.a);
}`,
};
export default def;
