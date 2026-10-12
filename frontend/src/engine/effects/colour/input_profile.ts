/**
 * Input profile: camera log footage → scene-linear (the camera's own gamut, through its published curve) → BT.709
 * primaries → a display rendering (filmic SDR, HDR with highlights kept for an HLG / PQ output, or none) → the working
 * space (BT.1886). Or stop at scene-linear BT.709 for output_transform. Curves and gamuts: colour.ts, each cited from
 * its maker's specification (S-Log3, LogC3, LogC4, V-Log, Canon Log 3, D-Log, Blackmagic Film Gen 5).
 */
import { cameraToRec709, LOG_CURVES, TRANSFER_GLSL } from "../../colour.ts";
import type { EffectDef } from "../registry.ts";

const decoders = LOG_CURVES.map((c) => c.glsl.replace("decodeLog(", `decode_${c.id}(`)).join("\n");
const chain = LOG_CURVES.map((c, i) => `  ${i ? "else " : ""}if (profile < ${i}.5) return decode_${c.id}(x);`).join("\n");
const colMajor = (m: number[]) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const MATS = LOG_CURVES.map((c) => colMajor(cameraToRec709(c)));

const def: EffectDef = {
  id: "input_profile", label: "Input profile (camera log)", group: "Colour", author: "Tatvam", license: "Proprietary",
  description: "Camera log → scene-linear → Rec.709 display (or linear for an output transform)",
  params: [
    { name: "profile", label: "Camera", type: "enum", default: "slog3", options: LOG_CURVES.map((c) => ({ value: c.id, label: c.label })) },
    { name: "exposure", label: "Exposure", type: "float", default: 0, min: -4, max: 4, step: 0.05, unit: "stops" },
    { name: "tone_map", label: "Tone mapping", type: "enum", default: "filmic", options: [{ value: "filmic", label: "Filmic (SDR)" },
      { value: "hdr", label: "HDR (keep highlights)" }, { value: "none", label: "None" }] },
    { name: "peak", label: "HDR peak", type: "float", default: 1000, min: 203, max: 10000, step: 1, unit: "cd/m²" },
    { name: "target", label: "Output", type: "enum", default: "display", options: [{ value: "display", label: "Rec.709 display" }, { value: "linear", label: "Scene-linear Rec.709" }] },
    { name: "saturation", label: "Saturation", type: "float", default: 1, min: 0, max: 2, step: 0.01 },
  ],
  uniforms: (p) => {
    const i = Math.max(0, LOG_CURVES.findIndex((c) => c.id === p.profile));
    return { uCam: MATS[i] };
  },
  glsl: `
uniform mat3 uCam;
${decoders}
${TRANSFER_GLSL}
float decodeAny(float x) {
${chain}
  return x;
}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec3 lin = vec3(decodeAny(c.r), decodeAny(c.g), decodeAny(c.b)) * exp2(exposure);
  lin = uCam * lin;
  float l = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  lin = vec3(l) + (lin - vec3(l)) * saturation;
  if (target > 0.5) return vec4(lin, c.a);
  vec3 disp = tone_map < 0.5 ? tmFilmic(lin) : tone_map < 1.5 ? tmHdr(lin, peak / 203.0) : lin;
  return vec4(tfInv1886(disp), c.a);
}`,
};
export default def;
