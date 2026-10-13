/**
 * Denoise: an edge-preserving 9×9 smoothing (run twice). Port of denoise from glfx.js by Evan Wallace
 * (https://github.com/evanw/glfx.js): MIT License, Copyright (C) 2011 by Evan Wallace (full notice:
 * effects/licenses.ts).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "denoise", label: "Denoise", group: "Blur & Sharpen", author: "Evan Wallace", license: "MIT", source: "glfx.js / denoise",
  params: [{ name: "exponent", label: "Edge keeping", type: "float", default: 20, min: 0, max: 50, step: 0.5, description: "Higher keeps more detail" }],
  passes: [{
    repeat: () => 2,
    glsl: `
vec4 effect(vec2 uv) {
  vec4 center = getColor(uv);
  vec4 color = vec4(0.0);
  float total = 0.0;
  for (float x = -4.0; x <= 4.0; x += 1.0) for (float y = -4.0; y <= 4.0; y += 1.0) {
    vec4 smp = getColor(uv + vec2(x, y) / uResolution);
    float w = pow(max(1.0 - abs(dot(smp.rgb - center.rgb, vec3(0.25))), 0.0), exponent);
    color += smp * w;
    total += w;
  }
  return color / total;
}` }],
};
export default def;
