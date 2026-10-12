/**
 * Camera move (Ken Burns): a zoom or pan over the clip's length, the same maths as fx.move (FFmpeg zoompan).
 */
import type { EffectDef } from "../registry.ts";

import { cameraAt } from "../../framing.ts";
import type { MoveKind } from "../../types.ts";

const def: EffectDef = {
  id: "move", label: "Camera move (Ken Burns)", group: "Transform", gpuOnly: false, author: "Tatvam", license: "Proprietary",
  params: [
    { name: "kind", label: "Move", type: "enum", default: "zoom_in", options: [{ value: "none", label: "None" }, { value: "zoom_in", label: "Zoom in" },
      { value: "zoom_out", label: "Zoom out" }, { value: "pan_left", label: "Pan left" }, { value: "pan_right", label: "Pan right" },
      { value: "pan_up", label: "Pan up" }, { value: "pan_down", label: "Pan down" }] },
    { name: "amount", label: "Amount", type: "float", default: 0.12, min: 0, max: 0.5, step: 0.01 },
  ],
  uniforms: (p, c) => {
    const cam = cameraAt({ move: { kind: String(p.kind) as MoveKind, amount: Number(p.amount) || 0 }, duration: c.duration, kenburns: false }, c.t, c.fps);
    return { uCam: [cam.z, cam.ox, cam.oy] };
  },
  glsl: `
uniform vec3 uCam;
vec4 effect(vec2 uv) { return getColor(uCam.yz + uv / uCam.x); }`,
};
export default def;
