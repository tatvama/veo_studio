/**
 * 8 mm: home-movie film, warm faded colour, heavy grain, a soft image, gate jitter and flicker, a dark rounded gate
 * and a little light leaking at the edge. Our own GLSL.
 */
import { NOISE_GLSL } from "../glsl.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "film_8mm", label: "8 mm film", group: "Stylize", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "amount", label: "Amount", type: "float", default: 0.8, min: 0, max: 1, step: 0.01 },
    { name: "grain", label: "Grain", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "jitter", label: "Jitter", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "gate", label: "Gate", type: "float", default: 0.6, min: 0, max: 1, step: 0.01, description: "The rounded dark frame edge" },
    { name: "warmth", label: "Warmth", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `${NOISE_GLSL}
vec4 effect(vec2 uv) {
  float f = uFrame;
  vec2 j = (vec2(nHash(vec2(f, 1.0)), nHash(vec2(f, 2.0))) - 0.5) * vec2(0.003, 0.006) * jitter * amount;
  vec2 q = uv + j;
  vec4 c = vec4(0.0);
  vec2 px = 1.2 * uScale / uResolution;
  c += getColor(q) * 0.4;
  c += (getColor(q + vec2(px.x, 0.0)) + getColor(q - vec2(px.x, 0.0)) + getColor(q + vec2(0.0, px.y)) + getColor(q - vec2(0.0, px.y))) * 0.15;
  vec3 col = c.rgb;
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(l), 0.25 * amount);
  col = mix(col, col * vec3(1.12, 1.0, 0.78) + vec3(0.05, 0.03, 0.0), warmth * amount);
  col = mix(col, 0.08 + col * 0.88, amount * 0.6);
  vec2 g = uv * uResolution / max(uScale, 1e-3) / 2.5 + f * 11.3;
  col += (nNoise(g) + nNoise(g * 2.3) * 0.5 - 0.75) * grain * 0.22 * amount;
  col *= 1.0 + (nNoise(vec2(f * 0.8, 7.0)) - 0.5) * 0.18 * amount;
  vec2 d = (uv - 0.5) * 2.0;
  float rr = pow(pow(abs(d.x), 6.0) + pow(abs(d.y), 6.0), 1.0 / 6.0);
  col *= 1.0 - smoothstep(0.82, 1.0, rr) * gate * amount;
  col *= 1.0 - smoothstep(0.4, 1.3, length(d)) * 0.35 * amount;
  col += vec3(1.0, 0.45, 0.1) * exp(-(1.0 - uv.x) * 9.0) * 0.25 * amount * nNoise(vec2(f * 0.1, 3.0));
  return vec4(col, c.a);
}`,
};
export default def;
