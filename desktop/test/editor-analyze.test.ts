/**
 * Local analysis for the editor's AI tools (src/main/editor-analyze.ts): FFmpeg arguments, the silencedetect /
 * showinfo / ebur128 parsers on captured output, and the beat detector on synthetic click tracks.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BEAT_RATE, beatsArgs, detectBeats, loudnessArgs, parseEbur128, parseScenes, parseSilence, scenesArgs, silenceArgs,
} from "../src/main/editor-analyze.ts";

test("silence: arguments and segments (an unfinished silence runs to the end)", () => {
  assert.deepEqual(silenceArgs("a.wav"), ["-i", "a.wav", "-vn", "-af", "silencedetect=noise=-35dB:d=0.400", "-f", "null", "-"]);
  const lines = [
    "[silencedetect @ 000001] silence_start: -0.00266667",
    "[silencedetect @ 000001] silence_end: 0.81 | silence_duration: 0.812667",
    "size=N/A time=00:00:05.00 bitrate=N/A speed= 500x",
    "[silencedetect @ 000001] silence_start: 3.2",
    "[silencedetect @ 000001] silence_end: 3.9 | silence_duration: 0.7",
    "[silencedetect @ 000001] silence_start: 4.5",
  ];
  assert.deepEqual(parseSilence(lines, 5.0), [{ start: 0, end: 0.81 }, { start: 3.2, end: 3.9 }, { start: 4.5, end: 5 }]);
});

test("scenes: the scene score on a small copy, cut times from showinfo", () => {
  assert.deepEqual(scenesArgs("v.mp4", 0.4), ["-i", "v.mp4", "-an", "-sn", "-vf", "scale=320:-2,select='gt(scene,0.400)',showinfo", "-f", "null", "-"]);
  const lines = [
    "[Parsed_showinfo_2 @ 0000] config in time_base: 1/12800, frame_rate: 24/1",
    "[Parsed_showinfo_2 @ 0000] n:   0 pts:  25600 pts_time:2       duration:    512 duration_time:0.04    fmt:yuv420p",
    "[Parsed_showinfo_2 @ 0000] n:   1 pts:  25612 pts_time:2.00094 duration:    512 duration_time:0.04    fmt:yuv420p",
    "[Parsed_showinfo_2 @ 0000] n:   2 pts:  64000 pts_time:5       duration:    512 duration_time:0.04    fmt:yuv420p",
  ];
  assert.deepEqual(parseScenes(lines), [2, 5]);
});

test("loudness: the ebur128 summary", () => {
  assert.deepEqual(loudnessArgs("a.wav"), ["-nostats", "-i", "a.wav", "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"]);
  // a clip's range: a fast seek a second before, then a sample-accurate atrim
  assert.deepEqual(loudnessArgs("a.mp4", 12.5, 20.25), ["-nostats", "-ss", "11.5", "-i", "a.mp4", "-vn", "-af",
    "atrim=start=1:duration=7.75,asetpts=PTS-STARTPTS,ebur128=peak=true", "-f", "null", "-"]);
  assert.deepEqual(loudnessArgs("a.mp4", 0.4, 3), ["-nostats", "-i", "a.mp4", "-vn", "-af", "atrim=start=0.4:duration=2.6,asetpts=PTS-STARTPTS,ebur128=peak=true", "-f", "null", "-"]);
  const lines = `[Parsed_ebur128_0 @ 0000] t: 4.9      TARGET:-23 LUFS    M: -18.1 S: -18.0     I: -18.0 LUFS       LRA:   0.0 LU  FTPK: -15.0 dBFS  TPK: -15.0 dBFS
[Parsed_ebur128_0 @ 0000] Summary:

  Integrated loudness:
    I:         -18.0 LUFS
    Threshold: -28.1 LUFS

  Loudness range:
    LRA:         1.2 LU
    Threshold: -38.1 LUFS
    LRA low:   -18.5 LUFS
    LRA high:  -17.3 LUFS

  True peak:
    Peak:      -14.9 dBFS`.split("\n");
  assert.deepEqual(parseEbur128(lines), { lufs: -18, lra: 1.2, truePeak: -14.9 });
  assert.deepEqual(parseEbur128(["  Summary:", "    I:         -inf LUFS", "    LRA:  0.0 LU", "    Peak:   -inf dBFS"]), { lufs: null, lra: 0, truePeak: null });
});

/** Clicks (short decaying noise bursts) every `period` seconds from `offset`, over quiet noise. */
function clicks(seconds: number, period: number, offset = 0.1, seed = 7): Float32Array {
  const out = new Float32Array(Math.round(seconds * BEAT_RATE));
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
  for (let i = 0; i < out.length; i++) out[i] = rnd() * 0.01;
  for (let t = offset; t < seconds; t += period) {
    const at = Math.round(t * BEAT_RATE);
    for (let i = 0; i < 0.03 * BEAT_RATE && at + i < out.length; i++) out[at + i] += rnd() * 1.6 * Math.exp(-i / (0.006 * BEAT_RATE));
  }
  return out;
}

test("beats: tempo and beat times on click tracks at 120 and 90 BPM", () => {
  assert.deepEqual(beatsArgs("m.mp3"), ["-i", "m.mp3", "-vn", "-ac", "1", "-ar", "22050", "-f", "f32le", "-"]);
  for (const [bpm, offset] of [[120, 0.1], [90, 0.25]] as const) {
    const period = 60 / bpm;
    const r = detectBeats(clicks(12, period, offset));
    assert.ok(Math.abs(r.bpm - bpm) < 2, `bpm ${r.bpm} for ${bpm}`);
    assert.ok(r.beats.length >= Math.floor((12 - offset) / period) - 2, `${r.beats.length} beats`);
    for (const b of r.beats) {
      const k = Math.round((b - offset) / period);
      assert.ok(Math.abs(b - (offset + k * period)) < 0.015, `beat at ${b} is off the click grid (${bpm} BPM)`);
    }
  }
  assert.deepEqual(detectBeats(new Float32Array(100)), { beats: [], bpm: 0 });
});
