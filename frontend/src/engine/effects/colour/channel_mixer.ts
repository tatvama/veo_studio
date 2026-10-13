/**
 * Channel mixer: each output channel as a mix of the input's red, green and blue.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "channel_mixer", label: "Channel mixer", group: "Colour", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "red", label: "Red from (R, G, B)", type: "rgb", default: [1, 0, 0], min: -2, max: 2, step: 0.01 },
    { name: "green", label: "Green from (R, G, B)", type: "rgb", default: [0, 1, 0], min: -2, max: 2, step: 0.01 },
    { name: "blue", label: "Blue from (R, G, B)", type: "rgb", default: [0, 0, 1], min: -2, max: 2, step: 0.01 },
    { name: "monochrome", label: "Monochrome (use the red row)", type: "bool", default: false },
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec3 o = monochrome > 0.5 ? vec3(dot(c.rgb, red)) : vec3(dot(c.rgb, red), dot(c.rgb, green), dot(c.rgb, blue));
  return vec4(o, c.a);
}`,
};
export default def;
