/**
 * Built-in impulse responses for `reverb` and `guitar_amp` (docs/EDITOR.md §11). The recipe is
 * frontend/src/editor/audiofx/ir.ts, copied VERBATIM to ./audiofx-ir.ts (a test checks the two are identical when the
 * frontend is next to this package), so the preview's ConvolverNode and the export's afir use bit-identical IRs: the
 * desktop writes `wavFloat32(makeIr(name))` for every name in IR_NAMES (9 reverbs, cab_1x12 / cab_2x12 / cab_4x12) to
 * userData/irs/<name>.wav and the gateway serves them at /__media/irs/<name>.wav. Every channel has unit energy, so
 * afir runs with irnorm=-1:irgain=1 (and the preview with ConvolverNode.normalize = false).
 */
import { IR_NAMES, IR_PRESETS, IR_RATE, makeIr, wavFloat32 } from "./audiofx-ir.ts";

export { IR_NAMES, IR_PRESETS, IR_RATE };

/** A built-in impulse response's name (a reverb preset or a cabinet). */
export type IrPreset = string;
export const isIrPreset = (v: unknown): v is IrPreset => typeof v === "string" && IR_NAMES.includes(v);
export const REVERB_IRS = IR_NAMES.filter((n) => IR_PRESETS[n].kind === "reverb");
export const CABINET_IRS = IR_NAMES.filter((n) => IR_PRESETS[n].kind === "cabinet");

export const IR_LABELS: Record<string, string> = {
  room: "Room", studio: "Studio", hall: "Concert hall", plate: "Plate", church: "Church", cathedral: "Cathedral", stage: "Stage", bathroom: "Bathroom",
  stairwell: "Stairwell", cab_1x12: "1×12 combo", cab_2x12: "2×12 open back", cab_4x12: "4×12 stack",
};

/** The WAV bytes of a preset (48 kHz stereo 32-bit float). */
export function presetWav(name: IrPreset): Buffer {
  const b = wavFloat32(makeIr(name));
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
}

/** Seconds of a preset's response. */
export function irSeconds(name: IrPreset): number {
  return Math.round((makeIr(name)[0].length / IR_RATE) * 1000) / 1000;
}
