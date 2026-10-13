/**
 * Look / LUT: a preset look (run as the server's FFmpeg filters, or its exact .cube) or a team LUT (lut:<id>, from
 * Composition.lutUrls), with strength. Built-in: the FFmpeg-matched clip pipeline (tetrahedral LUT).
 */
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "look", label: "Look / LUT", group: "Colour", gpuOnly: false, author: "Tatvam", license: "Proprietary",
  description: "A preset look or one of your .cube LUTs (lut:<id>)",
  params: [
    { name: "look", label: "Look", type: "enum", default: "cinematic", options: [{ value: "none", label: "Natural" }, { value: "cinematic", label: "Cinematic" }, { value: "teal_orange", label: "Teal & orange" }, { value: "warm", label: "Warm" }, { value: "golden_hour", label: "Golden hour" }, { value: "cool", label: "Cool" }, { value: "moonlight", label: "Moonlight" }, { value: "vivid", label: "Vivid" }, { value: "pastel", label: "Pastel" }, { value: "vintage", label: "Vintage" }, { value: "faded_film", label: "Faded film" }, { value: "cross_process", label: "Cross process" }, { value: "bleach_bypass", label: "Bleach bypass" }, { value: "high_contrast", label: "Punchy" }, { value: "matte", label: "Matte" }, { value: "noir", label: "Noir" }, { value: "black_white", label: "Black & white" }, { value: "sepia", label: "Sepia" }, { value: "negative", label: "Negative" }],
      description: "A preset, or lut:<id> for a team LUT (its URL in Composition.lutUrls)" },
    { name: "lut_strength", label: "Strength", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
  ],
  render: (api) => api.legacy({ look: api.values.look, lut_strength: api.values.lut_strength }),
};
export default def;
