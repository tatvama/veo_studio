/**
 * Adjust: the 12 studio controls with the exact FFmpeg semantics of backend fx.adjust_filters (eq, colorbalance,
 * vibrance, hue, unsharp, gblur, vignette, noise). Built-in: runs the FFmpeg-matched pipeline.
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "adjust", label: "Adjust", group: "Colour", gpuOnly: false, author: "Tatvam", license: "Proprietary",
  description: "Exposure, contrast, colour and texture, as the server render draws them",
  params: [
    { name: "exposure", label: "Exposure", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
    { name: "contrast", label: "Contrast", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
    { name: "saturation", label: "Saturation", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
    { name: "temperature", label: "Temperature", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
    { name: "tint", label: "Tint", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
    { name: "vibrance", label: "Vibrance", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
    { name: "gamma", label: "Midtones", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
    { name: "hue", label: "Hue shift", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
    { name: "sharpen", label: "Sharpen", type: "float", default: 0, min: 0, max: 1, step: 0.01 },
    { name: "blur", label: "Blur", type: "float", default: 0, min: 0, max: 1, step: 0.01 },
    { name: "vignette", label: "Vignette", type: "float", default: 0, min: 0, max: 1, step: 0.01 },
    { name: "grain", label: "Film grain", type: "float", default: 0, min: 0, max: 1, step: 0.01 },
  ],
  render: (api) => api.legacy({ adjust: Object.fromEntries(Object.entries(api.values).filter(([, v]) => typeof v === "number" && v !== 0)) }),
};
export default def;
