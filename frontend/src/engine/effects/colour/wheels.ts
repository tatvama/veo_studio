/**
 * Colour wheels: lift, gamma and gain per channel. Built-in (the clip pipeline's wheels).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "wheels", label: "Colour wheels", group: "Colour", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "lift", label: "Lift", type: "rgb", default: [0, 0, 0], min: -1, max: 1, step: 0.01 },
    { name: "gamma", label: "Gamma", type: "rgb", default: [0, 0, 0], min: -1, max: 1, step: 0.01 },
    { name: "gain", label: "Gain", type: "rgb", default: [0, 0, 0], min: -1, max: 1, step: 0.01 },
  ],
  render: (api) => api.legacy({ wheels: { lift: api.values.lift, gamma: api.values.gamma, gain: api.values.gain } }),
};
export default def;
