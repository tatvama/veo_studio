/**
 * Film damage: a worn print, blotches of damaged emulsion, a burnt edge, vertical jumps, flicker, fine lines and
 * fading, driven by one amount. Our own GLSL.
 */
import { NOISE_GLSL } from "../glsl.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "film_damage", label: "Film damage", group: "Film", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "amount", label: "Amount", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "blotches", label: "Blotches", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "jumps", label: "Frame jumps", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
    { name: "fade", label: "Fade", type: "float", default: 0.4, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `${NOISE_GLSL}
vec4 effect(vec2 uv) {
  float f = uFrame;
  float jump = nHash(vec2(floor(f), 4.0)) < jumps * amount * 0.15 ? (nHash(vec2(f, 5.0)) - 0.5) * 0.06 : 0.0;
  vec2 q = vec2(uv.x + (nNoise(vec2(f * 0.3, 2.0)) - 0.5) * 0.004 * amount, fract(uv.y + jump));
  vec4 c = getColor(q);
  vec3 col = c.rgb;
  // fading toward a yellowed base
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(l) * vec3(1.05, 0.98, 0.85), fade * amount * 0.6);
  col = mix(col, vec3(0.5), fade * amount * 0.15);
  // blotches of damaged emulsion, a few per frame
  vec2 asp = vec2(uResolution.x / uResolution.y, 1.0);
  float life = floor(f / 2.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    if (nHash(vec2(life, fi + 40.0)) > blotches * amount) continue;
    vec2 ctr = nHash2(vec2(life, fi + 50.0));
    float rad = 0.02 + 0.08 * nHash(vec2(life, fi + 60.0));
    float d = length((uv - ctr) * asp) + (nFbm(uv * 30.0 + life) - 0.5) * rad * 0.8;
    float m = 1.0 - smoothstep(rad * 0.7, rad, d);
    vec3 bc = nHash(vec2(life, fi + 70.0)) > 0.5 ? vec3(0.95, 0.92, 0.8) : vec3(0.08, 0.06, 0.04);
    col = mix(col, bc, m * 0.85);
  }
  // a burnt, darkened edge that breathes
  float edge = max(abs(uv.x - 0.5), abs(uv.y - 0.5)) * 2.0;
  float burn = smoothstep(0.86 - 0.08 * nFbm(uv * 6.0 + f * 0.05), 1.02, edge) * amount;
  col *= 1.0 - burn * 0.85;
  col += vec3(0.3, 0.12, 0.0) * burn * (1.0 - burn) * 0.8;
  // flicker and fine vertical lines
  col *= 1.0 + (nHash(vec2(f, 9.0)) - 0.5) * 0.12 * amount;
  float line = step(0.997 - 0.004 * amount, nHash(vec2(floor(uv.x * uResolution.x / max(uScale, 1e-3) / 2.0), floor(f / 3.0))));
  col *= 1.0 - line * 0.5 * amount;
  return vec4(col, c.a);
}`,
};
export default def;
