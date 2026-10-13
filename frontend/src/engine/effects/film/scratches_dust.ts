/**
 * Scratches & dust: thin vertical scratches that wander and flicker, specks of dust and the odd hair, different every
 * frame. Our own GLSL.
 */
import { NOISE_GLSL } from "../glsl.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "scratches_dust", label: "Scratches & dust", group: "Film", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "scratches", label: "Scratches", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "dust", label: "Dust", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "hairs", label: "Hairs", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
    { name: "opacity", label: "Opacity", type: "float", default: 0.8, min: 0, max: 1, step: 0.01 },
    { name: "light", label: "Light specks", type: "bool", default: false, description: "White dirt (a print) instead of dark (a negative)" },
  ],
  glsl: `${NOISE_GLSL}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec2 res = uResolution / max(uScale, 1e-3);
  float f = uFrame;
  float dirt = 0.0;
  // scratches: a few columns, wobbling, each alive for a few frames
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float life = floor(f / (3.0 + fi * 2.0));
    if (nHash(vec2(life, fi + 1.0)) > scratches) continue;
    float x = nHash(vec2(life, fi + 7.0)) + (nNoise(vec2(uv.y * 3.0, life + fi)) - 0.5) * 0.02;
    float w = (0.8 + 1.8 * nHash(vec2(life, fi + 3.0))) / res.x;
    float on = smoothstep(0.2, 0.5, nNoise(vec2(uv.y * 8.0 + fi * 13.0, life)));
    dirt = max(dirt, (1.0 - smoothstep(w * 0.5, w * 1.5, abs(uv.x - x))) * on * 0.8);
  }
  // dust: sparse specks of different sizes
  vec2 g = uv * res / 9.0;
  vec2 cell = floor(g);
  float h = nHash(cell + vec2(f * 1.31, f * 0.77));
  if (h < dust * 0.06) {
    vec2 ctr = cell + 0.2 + 0.6 * nHash2(cell + f);
    float r = 0.3 + 1.8 * nHash(cell + f * 2.0);
    float d = length((g - ctr) * 9.0) - r * (0.8 + 0.4 * nNoise(g * 7.0));
    dirt = max(dirt, 1.0 - smoothstep(0.0, 1.2, d));
  }
  // hairs: thin curves for a frame or two
  float hl = floor(f / 2.0);
  if (nHash(vec2(hl, 91.0)) < hairs * 0.25) {
    vec2 p0 = nHash2(vec2(hl, 5.0));
    vec2 q = (uv - p0) * res / res.y;
    float a = nHash(vec2(hl, 9.0)) * 6.283;
    q = vec2(cos(a) * q.x - sin(a) * q.y, sin(a) * q.x + cos(a) * q.y);
    float curve = q.y - q.x * q.x * (nHash(vec2(hl, 13.0)) - 0.5) * 3.2;
    float len = 0.04 + 0.08 * nHash(vec2(hl, 17.0));
    dirt = max(dirt, (1.0 - smoothstep(0.0012, 0.003, abs(curve))) * step(abs(q.x), len) * 0.9);
  }
  dirt *= opacity;
  vec3 col = light > 0.5 ? mix(c.rgb, vec3(1.0), dirt) : c.rgb * (1.0 - dirt);
  return vec4(col, c.a);
}`,
};
export default def;
