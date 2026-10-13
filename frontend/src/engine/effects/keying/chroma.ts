/**
 * Chroma key: OBS-style green / blue screen key (distance in CbCr, smoothness, spill). Built-in (the clip
 * pipeline's key, same as fx.chroma).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "chroma", label: "Chroma key", group: "Keying", author: "Tatvam", license: "Proprietary",
  params: [
    { name: "color", label: "Key colour", type: "color", default: "#00ff00" },
    { name: "similarity", label: "Similarity", type: "float", default: 0.4, min: 0, max: 1, step: 0.01 },
    { name: "smoothness", label: "Smoothness", type: "float", default: 0.08, min: 0, max: 1, step: 0.01 },
    { name: "spill", label: "Spill reduction", type: "float", default: 0.1, min: 0, max: 1, step: 0.01 },
  ],
  render: (api) => api.legacy({ chroma: { color: api.values.color, similarity: api.values.similarity, smoothness: api.values.smoothness, spill: api.values.spill } }),
};
export default def;
