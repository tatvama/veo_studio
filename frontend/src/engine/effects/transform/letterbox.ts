/**
 * Letterbox: bars to a wider (or taller: pillarbox) aspect ratio, a colour and opacity, shiftable. Our own GLSL.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "letterbox", label: "Letterbox", group: "Transform", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "aspect", label: "Aspect ratio", type: "float", default: 2.39, min: 0.3, max: 4, step: 0.01, description: "Width / height of the picture inside the bars" },
    { name: "color", label: "Colour", type: "color", default: "#000000" },
    { name: "opacity", label: "Opacity", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
    { name: "offset", label: "Offset", type: "float", default: 0, min: -0.5, max: 0.5, step: 0.005 },
    { name: "feather", label: "Feather", type: "float", default: 0, min: 0, max: 40, step: 0.5, unit: "px" },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float fa = uResolution.x / uResolution.y;
  float f = max(feather * uScale, 0.5);
  float m;
  if (aspect >= fa) {
    float h = fa / aspect * 0.5;
    float y = (uv.y - 0.5 - offset) * uResolution.y;
    m = smoothstep(h * uResolution.y - f, h * uResolution.y + f, abs(y));
  } else {
    float w = aspect / fa * 0.5;
    float x = (uv.x - 0.5 - offset) * uResolution.x;
    m = smoothstep(w * uResolution.x - f, w * uResolution.x + f, abs(x));
  }
  return vec4(mix(c.rgb, color, m * opacity), max(c.a, m * opacity));
}`,
};
export default def;
