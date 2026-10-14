/**
 * Every SFX preset rendered at its defaults (docs/EDITOR.md §15.1): finite samples, −16 ± 0.5 LUFS, true peak
 * ≤ −1 dBTP (checked against the meter of audiofx/loudness.ts too), its stated length, centred when not stereo,
 * seamless loops. Kept apart from sfx.test.ts so the two run side by side.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureLoudness } from "../audiofx/loudness.ts";
import { renderSfxInfo, SFX_PRESETS, sfxLoudness, sfxTruePeak } from "../sfx/index.ts";

const SR = 48000;

test("every preset renders at its defaults: finite, −16 ± 0.5 LUFS, true peak ≤ −1 dBTP, its stated length", () => {
  let checkedRef = 0;
  SFX_PRESETS.forEach((p, i) => {
    const { channels: ch, level } = renderSfxInfo(p.id, {}, 1);
    assert.equal(ch.length, 2, p.id);
    assert.equal(ch[0].length, ch[1].length);
    assert.ok(Math.abs(ch[0].length - p.duration * SR) <= 48, `${p.id}: ${ch[0].length} samples for ${p.duration} s`);
    for (const c of ch) for (let j = 0; j < c.length; j++) if (!Number.isFinite(c[j])) assert.fail(`${p.id}: sample ${j} is ${c[j]}`);
    const lufs = sfxLoudness(ch, SR), tp = sfxTruePeak(ch);
    assert.ok(Math.abs(lufs + 16) <= 0.5, `${p.id}: ${lufs.toFixed(2)} LUFS`);
    assert.ok(tp <= -1, `${p.id}: true peak ${tp.toFixed(2)} dBTP`);
    assert.ok(Math.abs(level.lufs - lufs) < 0.05, `${p.id}: the levelling's own reading`);
    if (!p.stereo) for (let j = 0; j < ch[0].length; j += 97) assert.equal(ch[0][j], ch[1][j], `${p.id}: centred`);
    if (p.loop) {
      // the seam is no louder a step than the sound's own steps
      let step = 0; for (let j = 1; j < ch[0].length; j++) step = Math.max(step, Math.abs(ch[0][j] - ch[0][j - 1]));
      assert.ok(Math.abs(ch[0][0] - ch[0][ch[0].length - 1]) <= step + 1e-6, `${p.id}: seamless`);
    }
    // the reference meter (audiofx/loudness.ts) agrees, on a spread of presets
    if (i % 6 === 0) {
      const m = measureLoudness(ch, SR);
      assert.ok(Math.abs(m.lufs - lufs) < 0.02 || ch[0].length < SR * 0.4, `${p.id}: meter ${m.lufs} vs ${lufs}`);
      assert.ok(Math.abs(m.truePeak - tp) < 0.01, `${p.id}: meter true peak ${m.truePeak} vs ${tp}`);
      checkedRef++;
    }
  });
  assert.ok(checkedRef >= 20);
});
