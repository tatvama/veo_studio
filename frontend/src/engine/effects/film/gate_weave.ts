/**
 * Gate weave: the slow drift of film in a projector gate, a little translation and rotation that wanders smoothly from
 * frame to frame. Our own GLSL.
 */
import { NOISE_GLSL } from "../glsl.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "gate_weave", label: "Gate weave", group: "Film", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "amount", label: "Amount", type: "float", default: 3, min: 0, max: 20, step: 0.1, unit: "px" },
    { name: "rotation", label: "Rotation", type: "float", default: 0.15, min: 0, max: 2, step: 0.01, unit: "°" },
    { name: "speed", label: "Speed", type: "float", default: 1, min: 0, max: 5, step: 0.05 },
    { name: "zoom", label: "Zoom", type: "float", default: 1.01, min: 1, max: 1.1, step: 0.001, description: "Hides the edges" },
  ],
  glsl: `${NOISE_GLSL}
vec4 effect(vec2 uv) {
  float t = uFrame * speed * 0.35;
  vec2 o = vec2(nNoise(vec2(t, 3.7)) - 0.5, nNoise(vec2(t, 11.3)) - 0.5) * 2.0 + vec2(nHash(vec2(uFrame, 1.0)) - 0.5, nHash(vec2(uFrame, 2.0)) - 0.5) * 0.35;
  float a = radians(rotation) * (nNoise(vec2(t * 0.7, 19.1)) - 0.5) * 2.0;
  vec2 asp = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * asp / zoom;
  p = vec2(cos(a) * p.x - sin(a) * p.y, sin(a) * p.x + cos(a) * p.y);
  vec2 q = p / asp + 0.5 + o * amount * uScale / uResolution;
  return getColor(clamp(q, 0.0, 1.0));
}`,
};
export default def;
