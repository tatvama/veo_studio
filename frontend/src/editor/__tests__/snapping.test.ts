import assert from "node:assert/strict";
import { test } from "node:test";
import { snapBlock, snapFrame, snapPoints } from "../model/snapping.ts";
import { project, put, seqOf } from "./fixtures.ts";

test("snap points: cuts, markers, playhead, in / out, without the dragged clips", () => {
  const p = project();
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  s = put(p, s, "m2", 100, { in: 0, out: 49 });
  s = { ...s, markers: [{ id: "x", frame: 120, duration: 10, name: "", color: "#fff" }], inPoint: 30, outPoint: 59 };
  const moving = s.clips.filter((c) => c.start === 100).map((c) => c.id);
  const pts = snapPoints(s, { playhead: 77, exclude: moving });
  assert.deepEqual(pts.map((x) => [x.frame, x.kind]), [[0, "cut"], [30, "in"], [60, "out"], [77, "playhead"], [100, "cut"], [120, "marker"], [130, "marker"]]);
});

test("snapFrame finds the nearest point within the pixel threshold", () => {
  const pts = [{ frame: 0, kind: "cut" as const }, { frame: 100, kind: "cut" as const }, { frame: 104, kind: "marker" as const }];
  assert.equal(snapFrame(97, pts, 2)?.frame, 100);       // 3 frames = 6 px
  assert.equal(snapFrame(103, pts, 2)?.frame, 104);
  assert.equal(snapFrame(90, pts, 2), null);             // 10 frames = 20 px
  assert.equal(snapFrame(90, pts, 0.5, 8)?.frame, 100);   // zoomed out: 10 frames = 5 px
});

test("snapBlock snaps whichever edge is closer", () => {
  const pts = [{ frame: 100, kind: "cut" as const }, { frame: 300, kind: "cut" as const }];
  assert.deepEqual(snapBlock(98, 50, pts, 2).start, 100);
  assert.deepEqual(snapBlock(251, 50, pts, 2).start, 250);  // end 301 → 300
  assert.equal(snapBlock(180, 50, pts, 2).at, null);
});
