import assert from "node:assert/strict";
import { test } from "node:test";
import { place, rational, timecode, writeEdl, writeFcpxml, type EdlClip } from "../src/main/edl.ts";

const clips: EdlClip[] = [
  { name: "Kaali_S01E02_001_SC01_SH001_video_T01.mp4", path: "D:\\Tatvam\\Kaali (#1)\\Takes\\Kaali_S01E02_001_SC01_SH001_video_T01.mp4", srcIn: 0.5, duration: 4, mediaDuration: 8 },
  { name: "Kaali_S01E02_002_SC01_SH002_video_T03.mp4", path: "D:\\Tatvam\\Kaali (#1)\\Takes\\Kaali_S01E02_002_SC01_SH002_video_T03.mp4", srcIn: 0, duration: 3, transition: ["fade", 0.5] },
  { name: "Kaali_S01E02_003_SC02_SH003_video_T01.mp4", path: "D:\\Tatvam\\Kaali (#1)\\Takes\\Kaali_S01E02_003_SC02_SH003_video_T01.mp4", srcIn: 1, duration: 2, speed: 2 },
];

test("timecode and rational time", () => {
  assert.equal(timecode(0), "00:00:00:00");
  assert.equal(timecode(3725.5, 24), "01:02:05:12");
  assert.equal(timecode(1 / 24 * 23, 24), "00:00:00:23");
  assert.equal(timecode(10, 25), "00:00:10:00");
  assert.equal(rational(0), "0s");
  assert.equal(rational(5.5, 24), "132/24s");
});

test("placement: a dissolve starts the next clip before the previous one ends", () => {
  const p = place(clips);
  assert.deepEqual(p.map((x) => [x.start, x.end, x.visibleEnd]), [[0, 4, 3.5], [3.5, 6.5, 6.5], [6.5, 8.5, 8.5]]);
  assert.equal(p[0].srcOutVisible, 0.5 + 3.5);
  assert.equal(p[2].srcOutVisible, 1 + 2 * 2);
});

test("CMX3600: header, cut, dissolve with frames, clip names, speed", () => {
  const edl = writeEdl(clips, { title: "Kaali S01E02 kn", fps: 24 });
  const lines = edl.split("\r\n");
  assert.equal(lines[0], "TITLE: Kaali S01E02 kn");
  assert.equal(lines[1], "FCM: NON-DROP FRAME");
  assert.equal(lines[3], "001  AX       AA/V  C        00:00:00:12 00:00:04:00 00:00:00:00 00:00:03:12");
  assert.equal(lines[4], "* FROM CLIP NAME: Kaali_S01E02_001_SC01_SH001_video_T01.mp4");
  assert.ok(lines[5].startsWith("* SOURCE FILE: D:\\Tatvam"));
  // the dissolve: outgoing zero-length cut, then D with 12 frames (0.5 s at 24 fps)
  assert.equal(lines[7], "002  AX       AA/V  C        00:00:04:00 00:00:04:00 00:00:03:12 00:00:03:12");
  assert.equal(lines[8], "002  AX       AA/V  D    012 00:00:00:00 00:00:03:00 00:00:03:12 00:00:06:12");
  assert.equal(lines[9], "* FROM CLIP NAME: Kaali_S01E02_001_SC01_SH001_video_T01.mp4");
  assert.equal(lines[10], "* TO CLIP NAME: Kaali_S01E02_002_SC01_SH002_video_T03.mp4");
  assert.ok(edl.includes("003  AX       AA/V  C        00:00:01:00 00:00:05:00 00:00:06:12 00:00:08:12"));
  assert.match(edl, /\r\nM2 {3}AX {13}048\.0 {4}00:00:01:00\r\n/);
  const reels = writeEdl(clips, { title: "x", reel: "basename" });
  assert.ok(reels.includes("001  KAALI_S0 AA/V"));
});

test("FCPXML 1.10: assets with file URLs, spine of asset-clips, cross dissolve", () => {
  const x = writeFcpxml(clips, { title: "Kaali S01E02 & co", fps: 24, width: 3840, height: 2160 });
  assert.ok(x.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10">'));
  assert.ok(x.includes('<format id="r1" name="FFVideoFormat2160p24" frameDuration="1/24s" width="3840" height="2160"/>'));
  assert.match(x, /<media-rep kind="original-media" src="file:\/\/\/D:\/Tatvam\/Kaali%20\(%231\)\/Takes\/Kaali_S01E02_001_SC01_SH001_video_T01\.mp4"\/>/);
  assert.ok(x.includes('<asset id="r2" name="Kaali_S01E02_001_SC01_SH001_video_T01.mp4" start="0s" duration="192/24s"'), "asset duration = media duration");
  assert.ok(x.includes('<asset-clip ref="r2" name="Kaali_S01E02_001_SC01_SH001_video_T01.mp4" offset="0s" start="12/24s" duration="84/24s"'));
  assert.ok(x.includes('<transition name="Cross Dissolve" offset="84/24s" duration="12/24s"/>'));
  assert.ok(x.includes('<asset-clip ref="r3" name="Kaali_S01E02_002_SC01_SH002_video_T03.mp4" offset="84/24s" start="0s" duration="72/24s"'));
  assert.ok(x.includes('<sequence format="r1" duration="204/24s"'));
  assert.ok(x.includes('<event name="Kaali S01E02 &amp; co">'));
});
