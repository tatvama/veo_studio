/**
 * Light flicker: the brightness pumping of an old projector lamp or a hand-cranked camera, with a hint of colour,
 * varying frame to frame (smooth noise plus jumps). Our own GLSL.
 */
import { NOISE_GLSL } from "../glsl.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "light_flicker", label: "Light flicker", group: "Film", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "amount", label: "Amount", type: "float", default: 0.25, min: 0, max: 1, step: 0.01 },
    { name: "speed", label: "Speed", type: "float", default: 1, min: 0, max: 4, step: 0.05 },
    { name: "colour", label: "Colour shift", type: "float", default: 0.2, min: 0, max: 1, step: 0.01 },
    { name: "uneven", label: "Uneven", type: "float", default: 0.3, min: 0, max: 1, step: 0.01, description: "Brighter in one part of the frame" },
  ],
  glsl: `${NOISE_GLSL}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float t = uFrame * speed;
  float n = (nNoise(vec2(t * 0.6, 1.0)) - 0.5) * 1.4 + (nHash(vec2(floor(t), 2.0)) - 0.5) * 0.6;
  vec3 tint = 1.0 + colour * 0.15 * (vec3(nNoise(vec2(t * 0.5, 7.0)), nNoise(vec2(t * 0.5, 9.0)), nNoise(vec2(t * 0.5, 13.0))) - 0.5);
  vec2 hot = vec2(nNoise(vec2(t * 0.2, 21.0)), nNoise(vec2(t * 0.2, 33.0)));
  float spot = 1.0 + uneven * 0.3 * (0.5 - length(uv - hot)) * n;
  float k = 1.0 + n * amount * 0.6;
  return vec4(c.rgb * k * tint * spot, c.a);
}`,
};
export default def;
