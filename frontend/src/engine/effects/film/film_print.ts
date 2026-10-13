/**
 * Film print: a print-film response, an S-curve with a soft highlight shoulder and lifted, tinted blacks, plus the
 * slight colour crossover of a print stock. Our own maths.
 */
import { COLOR_GLSL } from "../glsl.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "film_print", label: "Film print", group: "Film", author: "Tatvam", license: "Proprietary",
  description: "Print-film contrast, a soft highlight shoulder, lifted and tinted blacks",
  params: [
    { name: "amount", label: "Amount", type: "float", default: 0.8, min: 0, max: 1, step: 0.01 },
    { name: "contrast", label: "Contrast", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "black", label: "Black lift", type: "float", default: 0.04, min: 0, max: 0.2, step: 0.005 },
    { name: "shadow_tint", label: "Shadow tint", type: "color", default: "#1a3a4a" },
    { name: "highlight_tint", label: "Highlight tint", type: "color", default: "#fff2dc" },
  ],
  glsl: `${COLOR_GLSL}
vec3 sCurve(vec3 x, float k) { x = clamp(x, 0.0, 1.0); vec3 a = pow(x, vec3(1.0 + k)); vec3 b = 1.0 - pow(1.0 - x, vec3(1.0 + k)); return mix(a, b, x); }
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec3 x = c.rgb;
  x = x / (1.0 + max(x - 0.8, 0.0) * 1.5);
  vec3 y = sCurve(x, contrast * 1.2);
  // crossover: the print's red a touch slower than its blue
  y = vec3(pow(y.r, 1.03), y.g, pow(y.b, 0.97));
  float l = cLuma(y);
  y = mix(y, y * highlight_tint, smoothstep(0.5, 1.0, l) * 0.6);
  y = mix(shadow_tint * 0.5 + black, y, smoothstep(0.0, 0.35, l) * (1.0 - black) + black);
  return vec4(mix(c.rgb, y, amount), c.a);
}`,
};
export default def;
