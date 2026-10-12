/**
 * Auto edit's one-pass analysis (src/main/autoedit-analyze.ts): the FFmpeg graph, and the parser on captured output
 * of blackdetect, freezedetect, blurdetect + scene score at 2 fps and astats per half second (FFmpeg 7.1, a testsrc2
 * clip with a black second, a frozen stretch, a blurred end and a clipped burst). Plus the jobs registry and series order.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { flaggedRanges, naturalCompare, parseQuality, qualityArgs } from "../src/main/autoedit-analyze.ts";
import { McpJobs } from "../src/main/mcp/jobs.ts";
import { timecode, at } from "../src/main/mcp/format.ts";

test("one pass: video and audio branches, the null muxer", () => {
  const a = qualityArgs("in.mp4", { video: true, audio: true });
  assert.equal(a[0], "-i");
  const g = a[a.indexOf("-filter_complex") + 1];
  assert.match(g, /blackdetect=d=0\.4:pix_th=0\.10/);
  assert.match(g, /freezedetect=n=-60dB:d=1\.0/);
  assert.match(g, /fps=2,format=gray,select='gte\(scene\\,0\)',blurdetect/);
  assert.match(g, /asetnsamples=n=24000:p=0,astats=metadata=1:reset=1/);
  assert.deepEqual(a.slice(-7), ["-map", "[qv]", "-map", "[qaud]", "-f", "null", "-"], "both outputs to the null muxer");
  assert.ok(!qualityArgs("a.wav", { video: false, audio: true }).join(" ").includes("blackdetect"));
  assert.throws(() => qualityArgs("x", { video: false, audio: false }));
});

const META = (n: number, t: number, kv: Record<string, number | string>) => [
  `[Parsed_metadata_${n} @ 000001] frame:${Math.round(t * 2)}    pts:${Math.round(t * 2)}       pts_time:${t}`,
  ...Object.entries(kv).map(([k, v]) => `[Parsed_metadata_${n} @ 000001] ${k}=${v}`),
];
const AMETA = (t: number, peak: number, rms: number, flat: number) => [
  `[Parsed_ametadata_13 @ 000002] frame:${Math.round(t * 2)}    pts:${Math.round(t * 24000)}   pts_time:${t}`,
  `[Parsed_ametadata_13 @ 000002] lavfi.astats.Overall.Peak_level=${peak}`,
  `[Parsed_ametadata_13 @ 000002] lavfi.astats.Overall.RMS_level=${rms}`,
  `[Parsed_ametadata_13 @ 000002] lavfi.astats.Overall.Flat_factor=${flat}`,
];

test("parse: black, frozen, blurred, clipped, the energy and motion curves, the tags", () => {
  const lines = [
    "    creation_time   : 2026-10-01T08:30:00.000000Z",
    "      timecode        : 01:00:10:05",
    "[blackdetect @ 0001] black_start:2 black_end:3.04 black_duration:1.04",
    "[freezedetect @ 0002] lavfi.freezedetect.freeze_start: 4",
    "[freezedetect @ 0002] lavfi.freezedetect.freeze_duration: 2.04",
    "[freezedetect @ 0002] lavfi.freezedetect.freeze_end: 6.04",
    "[freezedetect @ 0002] lavfi.freezedetect.freeze_start: 7.5",
  ];
  for (let i = 0; i < 16; i++) {
    const t = i / 2;
    lines.push(...META(8, t, { "lavfi.scene_score": i === 0 ? 0 : t < 2 ? 0.05 : 0.001, "lavfi.blur": t >= 2 && t < 3 ? "nan" : t >= 6 ? 20 : 5 }));
    lines.push(...AMETA(t, t >= 1 && t < 2 ? 0.0003 : -9.8, t >= 1 && t < 2 ? -1.5 : -13.1, t >= 1 && t < 2 ? 32.6 : 3.5));
  }
  const q = parseQuality(lines, 8);
  assert.deepEqual(q.black, [{ start: 2, end: 3.04 }]);
  assert.deepEqual(q.freeze, [{ start: 4, end: 6.04 }, { start: 7.5, end: 8 }], "an open freeze runs to the end");
  assert.deepEqual(q.blur, [{ start: 6, end: 8 }], "soft from 6 s (20 against a median of 5)");
  assert.equal(q.blurScore, 5);
  assert.deepEqual(q.clipped, [{ start: 1, end: 2 }], "peak at 0 dBFS with a flat top");
  assert.equal(q.peakDb, 0);
  assert.equal(q.energy.length, 16);
  assert.equal(q.energy[2], -1.5);
  assert.equal(q.motion[1], 0.05);
  assert.equal(q.created, "2026-10-01T08:30:00.000000Z");
  assert.equal(q.timecode, "01:00:10:05");
});

test("flagged ranges join small gaps and drop blips", () => {
  const s = [0, 0.5, 1, 2, 2.5, 5].map((t) => ({ t, on: true }));
  assert.deepEqual(flaggedRanges(s, 0.5, { join: 0.25, min: 1 }), [{ start: 0, end: 1.5 }, { start: 2, end: 3 }], "the lone 5 s sample is a blip");
  assert.deepEqual(flaggedRanges(s, 0.5, { join: 0.5, min: 1 }), [{ start: 0, end: 3 }], "a half-second gap is joined");
});

test("series order is natural: _2 before _10, case-insensitive", () => {
  const names = ["Clip_10.mp4", "clip_2.mp4", "Clip_1.mp4", "S01E01_003_SC02.mp4", "S01E01_001_SC01.mp4"];
  assert.deepEqual([...names].sort(naturalCompare), ["Clip_1.mp4", "clip_2.mp4", "Clip_10.mp4", "S01E01_001_SC01.mp4", "S01E01_003_SC02.mp4"]);
});

test("jobs: start, progress, wait, result, cancel", async () => {
  const jobs = new McpJobs();
  const j = jobs.start({ kind: "analysis", label: "A" }, async ({ update }) => { update({ progress: 0.5, message: "half" }); await new Promise((r) => setTimeout(r, 30)); return 42; });
  const seen: number[] = [];
  const end = await jobs.wait(j.id, 5, (x) => seen.push(x.progress));
  assert.equal(end?.status, "done");
  assert.equal(end?.result, 42);
  const k = jobs.start({ kind: "x", label: "B" }, ({ signal }) => new Promise((_r, rej) => signal.addEventListener("abort", () => rej(new Error("cancelled")))));
  assert.equal(jobs.cancel(k.id), true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(jobs.get(k.id)?.status, "cancelled");
  const m = jobs.create({ kind: "ai", label: "C" });
  jobs.update(m.id, { status: "awaiting_approval", message: "Waiting for you in Tatvam" });
  assert.equal(jobs.get(m.id)?.status, "awaiting_approval");
});

test("times read as seconds and timecode", () => {
  assert.equal(timecode(0, 25), "00:00:00:00");
  assert.equal(timecode(12.48, 25), "00:00:12:12");
  assert.equal(timecode(3661.5, 30), "01:01:01:15");
  assert.equal(timecode(10, 29.97), "00:00:09:29", "non-drop count at 29.97");
  assert.equal(at(12.48, 25), "12.48 s (00:00:12:12)");
});
