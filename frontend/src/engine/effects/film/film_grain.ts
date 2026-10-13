/**
 * Film grain: grain of a film stock (fine, 35 mm, 16 mm, 8 mm), strongest in the mid-tones, new every frame, sized in
 * composition pixels. Our own GLSL (value-noise octaves on an integer hash).
 */
import { COLOR_GLSL, NOISE_GLSL } from "../glsl.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "film_grain", label: "Film grain", group: "Film", author: "Tatvam", license: "Proprietary",
  description: "Grain of a film stock, strongest in the mid-tones",
  params: [
    { name: "stock", label: "Stock", type: "enum", default: "35mm", options: [{ value: "fine", label: "Fine" }, { value: "35mm", label: "35 mm" }, { value: "16mm", label: "16 mm" }, { value: "8mm", label: "8 mm" }] },
    { name: "amount", label: "Amount", type: "float", default: 0.35, min: 0, max: 1, step: 0.01 },
    { name: "size", label: "Size", type: "float", default: 1, min: 0.25, max: 4, step: 0.05, description: "Multiplies the stock's grain size" },
    { name: "colour", label: "Colour grain", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
    { name: "shadows", label: "Shadows", type: "float", default: 0.6, min: 0, max: 1, step: 0.01, description: "Grain in the shadows" },
    { name: "highlights", label: "Highlights", type: "float", default: 0.4, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `${NOISE_GLSL}${COLOR_GLSL}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  // per stock: grain size (composition px), strength, softness
  vec3 st = stock < 0.5 ? vec3(0.7, 0.55, 0.0) : stock < 1.5 ? vec3(1.1, 0.8, 0.3) : stock < 2.5 ? vec3(1.8, 1.0, 0.5) : vec3(3.0, 1.25, 0.7);
  vec2 px = uv * uResolution / max(uScale, 1e-3) / (st.x * size);
  vec2 seed = vec2(mod(uFrame, 997.0) * 7.31, mod(uFrame, 991.0) * 3.17);
  float g = nNoise(px + seed) * 0.6 + nNoise(px * 2.1 + seed.yx) * 0.3 + nNoise(px * 4.3 - seed) * 0.1;
  g = mix(g, nHash(floor(px * 1.7) + seed), 0.35 * (1.0 - st.z)) - 0.5;
  vec3 gc = vec3(nNoise(px + seed + 31.0), nNoise(px + seed + 57.0), nNoise(px + seed + 83.0)) - 0.5;
  float l = cLuma(clamp(c.rgb, 0.0, 1.0));
  float resp = mix(shadows, 1.0, smoothstep(0.0, 0.35, l)) * mix(1.0, highlights, smoothstep(0.6, 1.0, l)) * 4.0 * l * (1.0 - l) + 0.15;
  vec3 n = mix(vec3(g), gc, colour) * amount * st.y * 0.5 * resp;
  return vec4(c.rgb + n, c.a);
}`,
};
export default def;
