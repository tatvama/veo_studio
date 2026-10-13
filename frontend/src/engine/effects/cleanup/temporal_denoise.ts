/**
 * Temporal denoise: a recursive filter that averages each pixel with the previous denoised frame where nothing moved
 * (motion-adaptive: the difference of 3×3 neighbourhoods decides), plus a light spatial pass. Needs the previous frame:
 * the renderer keeps it per clip (EffectDef.temporal). Our own GLSL.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "temporal_denoise", label: "Temporal denoise", group: "Clean-up", author: "Tatvam", license: "Proprietary",
  description: "Averages over frames where the picture is still",
  temporal: {},
  params: [
    { name: "strength", label: "Strength", type: "float", default: 0.75, min: 0, max: 0.97, step: 0.01, description: "Weight of the previous frame where nothing moves" },
    { name: "sensitivity", label: "Motion sensitivity", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "spatial", label: "Spatial", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
vec3 box3(sampler2D t, vec2 uv) {
  vec2 px = 1.0 / uResolution;
  vec3 s = vec3(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) s += texture(t, uv + vec2(float(x), float(y)) * px).rgb;
  return s / 9.0;
}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec3 avg = box3(uInput, uv);
  // spatial: pull toward the neighbourhood where it is close (edges stay)
  float sd = length(c.rgb - avg);
  vec3 cur = mix(c.rgb, avg, spatial * exp(-sd * sd * 60.0));
  if (uHistoryValid < 0.5) return vec4(cur, c.a);
  vec3 prev = texture(uHistory, uv).rgb;
  vec3 pavg = box3(uHistory, uv);
  float d = length(avg - pavg);
  float sigma = mix(0.15, 0.02, sensitivity);
  float k = strength * exp(-(d * d) / (sigma * sigma));
  return vec4(mix(cur, prev, k), c.a);
}`,
};
export default def;
