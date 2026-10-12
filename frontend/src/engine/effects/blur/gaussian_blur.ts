/**
 * Gaussian blur, separable (two passes), alpha-correct.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "gaussian_blur", label: "Gaussian blur", group: "Blur & Sharpen", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "radius", label: "Radius (sigma)", type: "float", default: 8, min: 0, max: 32, step: 0.5, unit: "px" },
    { name: "horizontal", label: "Horizontal", type: "bool", default: true },
    { name: "vertical", label: "Vertical", type: "bool", default: true },
  ],
  pad: (p) => Number(p.radius) * 3,
  passes: [
    { glsl: `
uniform vec2 dir;
vec4 pm(vec4 c) { return vec4(c.rgb * c.a, c.a); }
vec4 unpm(vec4 c) { return c.a > 1e-5 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
vec4 effect(vec2 uv) {
  float sigma = max(radius * uScale, 0.01);
  float r = min(ceil(sigma * 3.0), 96.0);
  vec4 acc = pm(getColor(uv));
  float wsum = 1.0;
  for (float i = 1.0; i <= 96.0; i++) {
    if (i > r) break;
    float w = exp(-(i * i) / (2.0 * sigma * sigma));
    vec2 o = dir * i / uResolution;
    acc += (pm(getColor(uv + o)) + pm(getColor(uv - o))) * w;
    wsum += 2.0 * w;
  }
  return unpm(acc / wsum);
}`, uniforms: (p) => ({ dir: [p.horizontal === false ? 0 : 1, 0] }) },
    { glsl: `
uniform vec2 dir;
vec4 pm(vec4 c) { return vec4(c.rgb * c.a, c.a); }
vec4 unpm(vec4 c) { return c.a > 1e-5 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
vec4 effect(vec2 uv) {
  float sigma = max(radius * uScale, 0.01);
  float r = min(ceil(sigma * 3.0), 96.0);
  vec4 acc = pm(getColor(uv));
  float wsum = 1.0;
  for (float i = 1.0; i <= 96.0; i++) {
    if (i > r) break;
    float w = exp(-(i * i) / (2.0 * sigma * sigma));
    vec2 o = dir * i / uResolution;
    acc += (pm(getColor(uv + o)) + pm(getColor(uv - o))) * w;
    wsum += 2.0 * w;
  }
  return unpm(acc / wsum);
}`, uniforms: (p) => ({ dir: [0, p.vertical === false ? 0 : 1] }) },
  ],
};
export default def;
