/**
 * Light leak: soft drifting blooms of warm (or any) light screened over the picture, as from a leaky camera body,
 * changing over time. Our own GLSL.
 */
import { NOISE_GLSL } from "../glsl.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "light_leak", label: "Light leak", group: "Light", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "color1", label: "Colour 1", type: "color", default: "#ff7a1f" },
    { name: "color2", label: "Colour 2", type: "color", default: "#ffd36b" },
    { name: "intensity", label: "Intensity", type: "float", default: 0.7, min: 0, max: 2, step: 0.01 },
    { name: "speed", label: "Speed", type: "float", default: 0.3, min: 0, max: 3, step: 0.01 },
    { name: "side", label: "From", type: "enum", default: "left", options: [{ value: "left", label: "Left" }, { value: "right", label: "Right" }, { value: "top", label: "Top" }, { value: "bottom", label: "Bottom" }] },
    { name: "seed", label: "Seed", type: "float", default: 3, min: 0, max: 100, step: 1 },
  ],
  glsl: `${NOISE_GLSL}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float t = uTime * speed;
  vec2 asp = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * asp;
  vec3 leak = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    vec2 h = nHash2(vec2(fi, seed));
    vec2 ctr = (h - 0.5) * asp * 0.9 + vec2(sin(t * (0.4 + h.x) + fi), cos(t * (0.3 + h.y) + fi * 2.0)) * 0.25;
    float rad = 0.25 + 0.3 * nHash(vec2(fi, seed + 5.0));
    vec2 d = (p - ctr) / vec2(1.6, 1.0);
    leak += mix(color1, color2, nHash(vec2(fi, seed + 9.0))) * exp(-dot(d, d) / (rad * rad)) * (0.6 + 0.4 * nNoise(vec2(t + fi, seed)));
  }
  float e = side < 0.5 ? uv.x : side < 1.5 ? 1.0 - uv.x : side < 2.5 ? uv.y : 1.0 - uv.y;
  leak = leak * smoothstep(1.0, 0.0, e) * 1.4 + color1 * exp(-e * 7.0) * 0.6;
  leak *= intensity * (0.8 + 0.2 * nNoise(vec2(t * 2.0, seed + 1.0)));
  vec3 s = 1.0 - (1.0 - clamp(c.rgb, 0.0, 1.0)) * (1.0 - clamp(leak, 0.0, 1.0));
  return vec4(s + max(c.rgb - 1.0, 0.0), c.a);
}`,
};
export default def;
