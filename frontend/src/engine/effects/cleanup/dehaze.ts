/**
 * Dehaze: removes (or adds) atmospheric haze with a simplified dark-channel prior (He, Sun & Tang 2009): the darkest
 * channel over a neighbourhood estimates the haze, the picture is restored as J = (I − A) / t + A. Our own GLSL (a
 * quarter-size dark channel, then the restore).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "dehaze", label: "Dehaze", group: "Clean-up", author: "Tatvam", license: "Proprietary",
  description: "Removes haze (negative amounts add it)",
  params: [
    { name: "amount", label: "Amount", type: "float", default: 0.5, min: -1, max: 1, step: 0.01 },
    { name: "airlight", label: "Haze colour", type: "color", default: "#e6ecf2" },
    { name: "radius", label: "Radius", type: "float", default: 12, min: 2, max: 60, step: 0.5, unit: "px" },
  ],
  passes: [
    { scale: 0.25, glsl: `
vec4 effect(vec2 uv) {
  float R = radius * uScale;
  vec2 px = R / 3.0 / uResolution;
  float m = 1.0;
  for (int y = -3; y <= 3; y++) for (int x = -3; x <= 3; x++) {
    vec3 c = getColor(uv + vec2(float(x), float(y)) * px).rgb / max(airlight, 0.05);
    m = min(m, min(c.r, min(c.g, c.b)));
  }
  return vec4(vec3(clamp(m, 0.0, 1.0)), 1.0);
}` },
    { glsl: `
vec4 effect(vec2 uv) {
  vec4 o = getOriginal(uv);
  float dark = getColor(uv).r;
  if (amount >= 0.0) {
    float t = max(1.0 - 0.95 * amount * dark, 0.12);
    return vec4((o.rgb - airlight) / t + airlight, o.a);
  }
  float h = -amount * 0.7 * (0.4 + 0.6 * (1.0 - dark));
  return vec4(mix(o.rgb, airlight, h), o.a);
}` },
  ],
};
export default def;
