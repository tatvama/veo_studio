/**
 * Prism: spectral dispersion, the picture split into a rainbow of offset copies along a direction (stronger toward the
 * edges if asked), as through a prism filter. Our own GLSL.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "prism", label: "Prism", group: "Lens", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "amount", label: "Spread", type: "float", default: 12, min: 0, max: 80, step: 0.5, unit: "px" },
    { name: "angle", label: "Angle", type: "angle", default: 0, min: -180, max: 180, step: 1, unit: "°" },
    { name: "radial", label: "Radial", type: "bool", default: false, description: "Spread outward from the centre instead" },
    { name: "mix_", label: "Mix", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
vec3 spectrum(float t) { return clamp(vec3(1.5 - abs(t * 4.0 - 1.0) * 1.2, 1.5 - abs(t * 4.0 - 2.0) * 1.2, 1.5 - abs(t * 4.0 - 3.0) * 1.2), 0.0, 1.0); }
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec2 dir = vec2(cos(radians(angle)), sin(radians(angle)));
  if (radial > 0.5) { vec2 d = uv - 0.5; dir = d / max(length(d), 1e-4) * min(length(d) * 2.0, 1.0); }
  vec2 o = dir * amount * uScale / uResolution;
  vec3 acc = vec3(0.0), wsum = vec3(0.0);
  for (int i = 0; i < 10; i++) {
    float t = float(i) / 9.0;
    vec3 w = spectrum(t);
    acc += getColor(uv + o * (t - 0.5)).rgb * w;
    wsum += w;
  }
  return vec4(mix(c.rgb, acc / wsum, mix_), c.a);
}`,
};
export default def;
