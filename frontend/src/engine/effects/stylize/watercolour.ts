/**
 * Watercolour: simplified washes that bleed along a wobbly flow, darker pigment pooling at the edges, granulation and
 * a paper texture. Our own (two passes: the warped wash, then edges and paper).
 */
import { NOISE_GLSL } from "../glsl.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "watercolour", label: "Watercolour", group: "Stylize", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "wash", label: "Wash size", type: "float", default: 6, min: 1, max: 20, step: 0.5, unit: "px" },
    { name: "bleed", label: "Bleed", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "edges", label: "Edge darkening", type: "float", default: 0.6, min: 0, max: 1, step: 0.01 },
    { name: "granulation", label: "Granulation", type: "float", default: 0.4, min: 0, max: 1, step: 0.01 },
    { name: "paper", label: "Paper", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
  ],
  passes: [
    { glsl: `${NOISE_GLSL}
vec4 effect(vec2 uv) {
  vec2 p = uv * uResolution / max(uScale, 1e-3);
  vec2 flow = (vec2(nFbm(p / 80.0), nFbm(p / 80.0 + 17.0)) - 0.5) * bleed * 24.0 * uScale / uResolution;
  vec4 c0 = getColor(uv + flow);
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  vec2 px = wash * uScale / uResolution / 3.0;
  for (int y = -3; y <= 3; y++) for (int x = -3; x <= 3; x++) {
    vec3 c = getColor(uv + flow + vec2(float(x), float(y)) * px).rgb;
    float w = exp(-dot(c - c0.rgb, c - c0.rgb) * 12.0);
    acc += c * w; ws += w;
  }
  return vec4(acc / ws, c0.a);
}` },
    { glsl: `${NOISE_GLSL}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec2 px = 1.5 * uScale / uResolution;
  vec3 lap = 4.0 * c.rgb - getColor(uv + vec2(px.x, 0.0)).rgb - getColor(uv - vec2(px.x, 0.0)).rgb - getColor(uv + vec2(0.0, px.y)).rgb - getColor(uv - vec2(0.0, px.y)).rgb;
  float e = clamp(length(lap) * 3.0, 0.0, 1.0);
  vec3 col = c.rgb * (1.0 - e * edges * 0.5);
  vec2 p = uv * uResolution / max(uScale, 1e-3);
  float gr = nNoise(p * 0.45) * 0.6 + nNoise(p * 1.3) * 0.4;
  col *= 1.0 - granulation * 0.25 * (gr - 0.3) * (1.0 - dot(col, vec3(0.33)));
  float pap = nFbm(p / 6.0);
  col = mix(col, col * (0.9 + 0.12 * pap) + 0.04, paper);
  col = mix(vec3(dot(col, vec3(0.33))), col, 0.92) * 1.03 + 0.02;
  return vec4(col, c.a);
}` },
  ],
};
export default def;
