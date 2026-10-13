import assert from "node:assert/strict";
import { test } from "node:test";
import { convertFrames, fpsRational, framesToSeconds, isDropFrame, parseTimecode, secondsToFrames, toTimecode } from "../model/time.ts";

test("rates: NTSC rationals and drop-frame", () => {
  assert.deepEqual(fpsRational(29.97), [30000, 1001]);
  assert.deepEqual(fpsRational(23.976), [24000, 1001]);
  assert.deepEqual(fpsRational(59.94), [60000, 1001]);
  assert.deepEqual(fpsRational(25), [25, 1]);
  assert.equal(isDropFrame(29.97), true);
  assert.equal(isDropFrame(59.94), true);
  assert.equal(isDropFrame(23.976), false);
  assert.equal(isDropFrame(30), false);
});

test("frames ↔ seconds", () => {
  assert.equal(framesToSeconds(25, 25), 1);
  assert.ok(Math.abs(framesToSeconds(30, 29.97) - 1.001) < 1e-12);
  assert.equal(secondsToFrames(1.001, 29.97), 30);
  assert.equal(secondsToFrames(2, 24), 48);
  assert.equal(convertFrames(50, 25, 50), 100);
});

test("non-drop timecode", () => {
  assert.equal(toTimecode(0, 25), "00:00:00:00");
  assert.equal(toTimecode(24, 25), "00:00:00:24");
  assert.equal(toTimecode(25, 25), "00:00:01:00");
  assert.equal(toTimecode(25 * 3600 + 25 * 61 + 3, 25), "01:01:01:03");
  assert.equal(toTimecode(47, 23.976), "00:00:01:23");
  assert.equal(toTimecode(-30, 30), "-00:00:01:00");
});

test("drop-frame timecode at 29.97 skips ;00 and ;01 each minute except every tenth", () => {
  assert.equal(toTimecode(1799, 29.97), "00:00:59;29");
  assert.equal(toTimecode(1800, 29.97), "00:01:00;02");
  assert.equal(toTimecode(17982, 29.97), "00:10:00;00");
  assert.equal(toTimecode(17981, 29.97), "00:09:59;29");
  assert.equal(toTimecode(107892, 29.97), "01:00:00;00");
  assert.equal(toTimecode(3600, 59.94), "00:01:00;04");
});

test("parse round-trips (drop and non-drop)", () => {
  for (const fps of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]) {
    for (const f of [0, 1, 59, 1799, 1800, 1801, 17982, 54321, 107892, 250000]) {
      assert.equal(parseTimecode(toTimecode(f, fps), fps), f, `${fps} @ ${f}`);
    }
  }
  assert.equal(parseTimecode("1:00", 25), 25);
  assert.equal(parseTimecode("120", 25), 120);
  assert.equal(parseTimecode("+10", 25, 100), 110);
  assert.equal(parseTimecode("-00:00:01:00", 25, 100), 75);
  assert.equal(parseTimecode("abc", 25), null);
});
