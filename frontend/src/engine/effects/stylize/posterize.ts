/**
 * Posterize: fewer colour levels per channel, with a gamma for where the steps fall and optional ordered dithering.
 * Our own GLSL.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "posterize", label: "Posterize", group: "Stylize", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "levels", label: "Levels", type: "int", default: 5, min: 2, max: 32, step: 1 },
    { name: "gamma", label: "Gamma", type: "float", default: 1, min: 0.3, max: 3, step: 0.01 },
    { name: "dither", label: "Dither", type: "float", default: 0, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
float bayer4(vec2 p) {
  ivec2 q = ivec2(mod(p, 4.0));
  int i = q.x + q.y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i]) + 0.5) / 16.0 - 0.5;
}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float n = max(levels - 1.0, 1.0);
  vec3 x = pow(clamp(c.rgb, 0.0, 1.0), vec3(1.0 / gamma));
  x += dither * bayer4(floor(uv * uResolution / max(uScale, 1.0))) / n;
  x = floor(x * n + 0.5) / n;
  return vec4(pow(clamp(x, 0.0, 1.0), vec3(gamma)), c.a);
}`,
};
export default def;
