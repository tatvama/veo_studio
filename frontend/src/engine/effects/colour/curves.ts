/**
 * Curves: master and per-channel monotone cubic curves (2..16 points). Built-in (the clip pipeline's curves).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "curves", label: "Curves", group: "Colour", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "master", label: "Master", type: "curve", default: [[0, 0], [1, 1]] },
    { name: "r", label: "Red", type: "curve", default: [[0, 0], [1, 1]] },
    { name: "g", label: "Green", type: "curve", default: [[0, 0], [1, 1]] },
    { name: "b", label: "Blue", type: "curve", default: [[0, 0], [1, 1]] },
  ],
  render: (api) => api.legacy({ curves: { master: api.values.master, r: api.values.r, g: api.values.g, b: api.values.b } }),
};
export default def;
