/**
 * Wave: a travelling sine ripple across the picture (horizontal or vertical).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "wave", label: "Wave", group: "Distort", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "amplitude", label: "Amplitude", type: "float", default: 12, min: 0, max: 200, step: 0.5, unit: "px" },
    { name: "wavelength", label: "Wavelength", type: "float", default: 180, min: 4, max: 2000, step: 1, unit: "px" },
    { name: "speed", label: "Speed", type: "float", default: 1, min: -10, max: 10, step: 0.05, unit: "waves/s" },
    { name: "direction", label: "Direction", type: "enum", default: "horizontal", options: [{ value: "horizontal", label: "Horizontal" }, { value: "vertical", label: "Vertical" }] },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec2 p = uv * uResolution / max(uScale, 1e-3);
  float wl = max(wavelength, 1.0), ph = uTime * speed * 6.2831853;
  vec2 q = uv;
  if (direction < 0.5) q.x += sin(p.y / wl * 6.2831853 - ph) * amplitude * uScale / uResolution.x;
  else q.y += sin(p.x / wl * 6.2831853 - ph) * amplitude * uScale / uResolution.y;
  return getColor(q);
}`,
};
export default def;
