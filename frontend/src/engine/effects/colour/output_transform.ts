/**
 * Output transform: renders the grade for a delivery. From the working space (display, BT.1886) or scene-linear
 * BT.709 (input_profile's linear output) it tone-maps for the target and encodes:
 *   rec709 — SDR, highlights rolled off (or clipped) into 1.0, BT.1886 (the working space itself);
 *   srgb   — the same rendering, sRGB-encoded (IEC 61966-2-1) for stills and the web;
 *   hlg / pq — HDR: highlights kept up to the peak (1.0 = 203 cd/m², BT.2408) in the working space's headroom; set
 *            Composition.output to hlg / pq and readYuv420p10() turns it into the BT.2100 signal.
 * Our own, from the ITU-R / IEC specifications (colour.ts).
 */
import { TRANSFER_GLSL } from "../../colour.ts";
import type { EffectDef } from "../registry.ts";

const def: EffectDef = {
  id: "output_transform", label: "Output transform", group: "Colour", author: "Tatvam", license: "Proprietary",
  description: "Rec.709 SDR, sRGB, HLG or PQ with tone mapping",
  params: [
    { name: "target", label: "Output", type: "enum", default: "rec709", options: [{ value: "rec709", label: "Rec.709 SDR" }, { value: "srgb", label: "sRGB" },
      { value: "hlg", label: "HLG (HDR)" }, { value: "pq", label: "PQ (HDR)" }] },
    { name: "source", label: "Input", type: "enum", default: "display", options: [{ value: "display", label: "Working space (display)" }, { value: "linear", label: "Scene-linear Rec.709" }] },
    { name: "tone_map", label: "Tone mapping", type: "enum", default: "soft", options: [{ value: "soft", label: "Soft roll-off" }, { value: "none", label: "Clip" }] },
    { name: "peak", label: "HDR peak", type: "float", default: 1000, min: 203, max: 10000, step: 1, unit: "cd/m²" },
    { name: "exposure", label: "Exposure", type: "float", default: 0, min: -4, max: 4, step: 0.05, unit: "stops" },
  ],
  glsl: `${TRANSFER_GLSL}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec3 L = source < 0.5 ? tfEotf1886(c.rgb) : c.rgb;
  L *= exp2(exposure);
  bool hdr = target > 1.5;
  float P = hdr ? peak / 203.0 : 1.0;
  if (source > 0.5) L = tone_map < 0.5 ? (hdr ? tmHdr(L, P) : tmFilmic(L)) : L;
  else if (tone_map < 0.5) L = tmSoftClip(L, P);
  L = hdr ? clamp(L, 0.0, P) : clamp(L, 0.0, 1.0);
  vec3 o = target > 0.5 && target < 1.5 ? tfSrgbEncode(L) : tfInv1886(L);
  return vec4(o, c.a);
}`,
};
export default def;
