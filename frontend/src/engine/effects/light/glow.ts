/**
 * Glow: the highlights, blurred and screened back over the picture. Built-in (the clip pipeline's glow, same as
 * fx.glow).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "glow", label: "Glow", group: "Light", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "amount", label: "Amount", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    { name: "threshold", label: "Threshold", type: "float", default: 0.7, min: 0, max: 1, step: 0.01 },
    { name: "radius", label: "Radius", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
  ],
  render: (api) => api.legacy({ glow: { amount: api.values.amount, threshold: api.values.threshold, radius: api.values.radius } }),
};
export default def;
