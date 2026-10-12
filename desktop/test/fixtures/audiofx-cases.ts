/**
 * The audio effect cases of test/editor-audiofx.test.ts: every effect id with its defaults, and with the values below.
 * `npm run snapshot:audiofx` is not a script: regenerate audiofx-snapshots.json with
 *   node test/fixtures/audiofx-cases.ts --write
 * after a deliberate mapping change, and review the diff.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIO_FX, buildFx, layChain } from "../../src/main/editor-audiofx.ts";

/** Values that make an effect do something when its defaults are a no-op, and the select / mode variants. */
export const OVERRIDES: Record<string, Record<string, unknown>> = {
  gain: { gain: -6 }, eq3: { low: 3, mid: -2, high: 4 }, eq_graphic: { b125: 3, b4k: -3 }, eq_param: { gain2: 3, type3: "notch", type6: "lowpass", gain6: 2 },
  tilt: { gain: 3 }, mastering: { low: 2, mid: 1, high: 2, excite: 0.5, width: 0.4, boost: 3 }, noise_print: { noiseStart: 12.5, noiseEnd: 13.25 },
  pitch_shift: { semitones: 3, cents: 20 }, time_stretch: { tempo: 1.2 }, pitch_bend: { semitones: 2 }, delay_sync: { delay: 20 }, mono: { amount: 0.5 },
  reverb: { preset: "hall", predelay: 10, width: 1.5 }, invert: { channel: "left" }, haas: { channel: "left" }, bitcrusher: { samples: 4, mix: 0.6 },
  center_extract: { mode: "keep", amount: 0.8 }, doppler: { path: "approach" }, distortion: { type: "hard" }, guitar_amp: { cabinet: "cab_1x12", mid: 3 },
  invert_polarity: { channel: "right" }, auto_level: { window: 30 }, multiband: { lowGain: 2, highGain: -3 },
};

export function render(id: string, values: Record<string, unknown>): { graph: string; warnings: string[]; changesLength: boolean } {
  const params = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v }]));
  const warnings: string[] = [];
  const fx = buildFx([{ id: "e", type: `audio:${id}`, enabled: true, params }], { uid: "c0", duration: 3, fps: 25, shift: 0, irFile: (n) => `irs/${n}.wav`,
    warn: (w) => warnings.push(w), source: { file: "D:/m/src.wav" } });
  return { graph: layChain("0:a", [], fx.steps, [], "out", "c0").join(";"), warnings, changesLength: fx.changesLength };
}

export function snapshots(): Record<string, { defaults: string; values?: string }> {
  const out: Record<string, { defaults: string; values?: string }> = {};
  for (const d of AUDIO_FX) {
    out[d.id] = { defaults: render(d.id, {}).graph };
    if (OVERRIDES[d.id]) out[d.id].values = render(d.id, OVERRIDES[d.id]).graph;
  }
  return out;
}

if (process.argv.includes("--write")) {
  const f = path.join(path.dirname(fileURLToPath(import.meta.url)), "audiofx-snapshots.json");
  writeFileSync(f, `${JSON.stringify(snapshots(), null, 1)}\n`);
  console.log(`wrote ${f}`);
}
