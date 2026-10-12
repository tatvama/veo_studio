/**
 * Halftone (pro): print screening, CMYK dots at the classic screen angles (C 15°, M 75°, Y 0°, K 45°) or a mono
 * screen, round or line dots, antialiased, on a paper colour. Our own GLSL.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "halftone_pro", label: "Halftone (pro)", group: "Stylize", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "size", label: "Dot size", type: "float", default: 8, min: 2, max: 60, step: 0.5, unit: "px" },
    { name: "mode", label: "Screen", type: "enum", default: "cmyk", options: [{ value: "cmyk", label: "CMYK" }, { value: "mono", label: "Mono" }] },
    { name: "dot_", label: "Dot", type: "enum", default: "round", options: [{ value: "round", label: "Round" }, { value: "line", label: "Line" }] },
    { name: "angle", label: "Angle", type: "angle", default: 45, min: -90, max: 90, step: 1, unit: "°", description: "Mono screen angle" },
    { name: "paper", label: "Paper", type: "color", default: "#fbf8f0" },
    { name: "ink", label: "Ink (mono)", type: "color", default: "#111111" },
    { name: "amount", label: "Mix", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
  ],
  glsl: `
float screen(vec2 px, float ang, float v, float cell) {
  float c = cos(ang), s = sin(ang);
  vec2 p = vec2(c * px.x - s * px.y, s * px.x + c * px.y) / cell;
  vec2 f = fract(p) - 0.5;
  float d, r;
  if (dot_ > 0.5) { d = abs(f.y); r = v * 0.5; }
  else { d = length(f); r = sqrt(clamp(v, 0.0, 1.0)) * 0.70710678; }
  float aa = 0.75 / cell;
  return 1.0 - smoothstep(r - aa, r + aa, d);
}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec3 rgb = clamp(c.rgb, 0.0, 1.0);
  vec2 px = uv * uResolution;
  float cell = max(size * uScale, 1.5);
  vec3 outc;
  if (mode < 0.5) {
    float k = 1.0 - max(rgb.r, max(rgb.g, rgb.b));
    vec3 cmy = (1.0 - rgb - k) / max(1.0 - k, 1e-3);
    float C = screen(px, radians(15.0), cmy.x, cell), M = screen(px, radians(75.0), cmy.y, cell);
    float Y = screen(px, 0.0, cmy.z, cell), K = screen(px, radians(45.0), k, cell);
    outc = paper * vec3(1.0 - C, 1.0 - M, 1.0 - Y) * (1.0 - K * 0.92);
  } else {
    float l = 1.0 - dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    float d = screen(px, radians(angle), l, cell);
    outc = mix(paper, ink, d);
  }
  return vec4(mix(c.rgb, outc, amount), c.a);
}`,
};
export default def;
