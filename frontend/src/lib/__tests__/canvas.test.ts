/**
 * The Shots canvas logic (pages/project/canvas/model.ts): the five dots of a shot, the scene-row layout and where a
 * dragged shot or scene lands, search, the undo stack and the saved camera.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LAYOUT, boxAtY, createUndoStack, groupWidth, layoutGroups, lengthLabel, makeBody, moveTo, nextLinkMode, orderAfterDrag,
  orderAfterMove, parseViewport, searchShots, shotDots, shotFlags, shotSlot, slotAt, stepBody, whereIs,
  type ShotInfo,
} from "../../pages/project/canvas/model.ts";

const info = (over: Partial<ShotInfo> = {}): ShotInfo => ({ voice: "need", mouth: "need", sound: "need", problems: {}, ...over });
const states = (dots: { state: string }[]) => dots.map((d) => d.state).join(" ");

test("dots: done, empty and not needed", () => {
  assert.equal(states(shotDots({ keyframe: {}, video: null })), "done empty empty empty empty");
  assert.equal(states(shotDots({ keyframe: {}, video: {}, voice: {}, lipsync: {}, sfx_track: { path: "a.wav" } }, info())),
    "done done done done done");
  // a voice-over shot: voice needed, no lips to sync; a silent shot with no sound notes: nothing to voice or sync
  assert.equal(states(shotDots({}, info({ mouth: "none" }))), "empty empty empty none empty");
  assert.equal(states(shotDots({}, info({ voice: "none", mouth: "none", sound: "none" }))), "empty empty none none none");
  // the video engine speaks the lines: still a dot, marked optional
  const d = shotDots({}, info({ voice: "optional", mouth: "optional" }));
  assert.equal(d[2].need, "optional");
  assert.equal(d[2].state, "empty");
  // a narration take counts as the voice
  assert.equal(shotDots({ narration_take: {} }, info())[2].state, "done");
});

test("dots: running beats failed beats out of date beats done", () => {
  const failed = info({ problems: { video: { job_id: 7, error: "Safety filter", at: null } } });
  const v = shotDots({ keyframe: {}, video: { stale: true, stale_reason: "prompt changed" } }, failed)[1];
  assert.equal(v.state, "failed");
  assert.equal(v.error, "Safety filter");
  assert.equal(v.jobId, 7);
  assert.equal(shotDots({ video: {}, active_jobs: ["video"] }, failed)[1].state, "running");
  const stale = shotDots({ keyframe: { stale: true, stale_reason: "cast changed" } })[0];
  assert.equal(stale.state, "stale");
  assert.equal(stale.staleReason, "cast changed");
  // a video a safety filter stopped is a failure too
  assert.equal(shotDots({ blocked: { error: "blocked" } })[1].state, "failed");
  // an endframe job is the picture step running
  assert.equal(shotDots({ active_jobs: ["endframe"] })[0].state, "running");
  const flags = shotFlags(shotDots({ keyframe: { stale: true }, video: {} }, failed));
  assert.equal(flags.stale.length, 1);
  assert.equal(flags.failed.length, 1);
  assert.equal(flags.running, false);
});

test("step and make bodies", () => {
  assert.deepEqual(stepBody("picture", 3), { action: "keyframes", shot_ids: [3] });
  assert.deepEqual(stepBody("mouth", 3), { action: "lipsync", shot_ids: [3] });
  assert.deepEqual(stepBody("sound", 3), { action: "produce", steps: ["sound"], shot_ids: [3] });
  const m = makeBody([1, 2]);
  assert.equal(m.action, "produce");
  assert.deepEqual(m.shot_ids, [1, 2]);
  assert.ok(!m.steps.includes("export" as never) && !m.steps.includes("music" as never));
});

test("length labels and link modes", () => {
  assert.equal(lengthLabel(8), "8s");
  assert.equal(lengthLabel(8, 0), "8s");
  assert.equal(lengthLabel(8, 15), "8s → 15s");
  assert.equal(nextLinkMode("last_frame"), "end_frame");
  assert.equal(nextLinkMode("end_frame"), "extend");
  assert.equal(nextLinkMode("extend"), "last_frame");
});

test("layout: scenes as rows, shots left to right", () => {
  const boxes = layoutGroups([{ key: "a", count: 3, collapsed: false }, { key: "b", count: 0, collapsed: true }, { key: "c", count: 1, collapsed: false }]);
  assert.deepEqual(boxes.map((b) => b.key), ["a", "b", "c"]);
  assert.equal(boxes[0].y, 0);
  const full = LAYOUT.headerH + LAYOUT.shotH + LAYOUT.padBottom;
  assert.equal(boxes[0].h, full);
  assert.equal(boxes[1].y, full + LAYOUT.gapY);
  assert.equal(boxes[1].h, LAYOUT.collapsedH);
  assert.equal(boxes[2].y, full + LAYOUT.gapY + LAYOUT.collapsedH + LAYOUT.gapY);
  // three shots + the "add a shot" slot; an empty scene is still two slots wide
  assert.equal(boxes[0].w, groupWidth(3));
  assert.equal(groupWidth(3), LAYOUT.padX * 2 + 4 * LAYOUT.shotW + 3 * LAYOUT.gapX);
  assert.equal(groupWidth(0), groupWidth(1));
  assert.deepEqual(shotSlot(0), { x: LAYOUT.padX, y: LAYOUT.headerH });
  assert.equal(shotSlot(2).x - shotSlot(1).x, LAYOUT.shotW + LAYOUT.gapX);
});

test("drops: which row, which slot, the new scene order", () => {
  const boxes = layoutGroups([{ key: "a", count: 2, collapsed: false }, { key: "b", count: 2, collapsed: false }, { key: "c", count: 2, collapsed: false }]);
  assert.equal(boxAtY(boxes, 10), 0);
  assert.equal(boxAtY(boxes, boxes[1].y + 5), 1);
  assert.equal(boxAtY(boxes, boxes[1].y - 3), 1, "a gap goes to the nearest row");
  assert.equal(boxAtY(boxes, 99999), 2);
  assert.equal(boxAtY([], 0), -1);
  assert.equal(slotAt(shotSlot(1).x + 30, 3), 1);
  assert.equal(slotAt(-500, 3), 0);
  assert.equal(slotAt(99999, 3), 3);
  // drag scene c above a
  assert.deepEqual(orderAfterDrag(boxes, "c", -20), ["c", "a", "b"]);
  // drag scene a just below b's centre
  assert.deepEqual(orderAfterDrag(boxes, "a", boxes[1].y + boxes[1].h / 2 + 1), ["b", "a", "c"]);
  assert.deepEqual(orderAfterDrag(boxes, "b", boxes[1].y + boxes[1].h / 2), ["a", "b", "c"], "dropped where it was");
});

test("moving a shot inside the film", () => {
  const groups = [{ key: "a", ids: [1, 2, 3] }, { key: "b", ids: [4, 5] }, { key: "c", ids: [] }];
  assert.deepEqual(moveTo([1, 2, 3], 3, 0), [3, 1, 2]);
  assert.deepEqual(moveTo([1, 2, 3], 1, 99), [2, 3, 1]);
  assert.deepEqual(orderAfterMove(groups, 1, "a", 2), [2, 3, 1, 4, 5]);
  assert.deepEqual(orderAfterMove(groups, 2, "b", 1), [1, 3, 4, 2, 5]);
  assert.deepEqual(orderAfterMove(groups, 5, "c", 0), [1, 2, 3, 4, 5], "into an empty scene at the end");
  assert.deepEqual(orderAfterMove(groups, 4, "a", 0), [4, 1, 2, 3, 5]);
  assert.deepEqual(whereIs(groups, 5), { key: "b", slot: 1 });
  assert.equal(whereIs(groups, 42), null);
});

test("search by code or words", () => {
  const items = [
    { id: 1, code: "E01-SH01", text: "Ravi opens the pickle jar" },
    { id: 2, code: "E01-SH02", text: "Steam rises over the stove" },
    { id: 3, code: "E01-SH12", text: "Meera laughs. Ravi: fifty years!" },
  ];
  assert.deepEqual(searchShots(items, "sh01"), [1]);
  assert.deepEqual(searchShots(items, "ravi"), [1, 3]);
  assert.deepEqual(searchShots(items, "  RAVI   jar "), [1]);
  assert.deepEqual(searchShots(items, "   "), []);
  assert.deepEqual(searchShots(items, "(.*a){20}"), [], "plain text, never a pattern");
});

test("undo stack: undo, redo, limit, a new edit clears redo", () => {
  const s = createUndoStack(3);
  let ticks = 0;
  const off = s.subscribe(() => ticks++);
  const log: string[] = [];
  const entry = (n: string) => ({ label: n, undo: () => log.push(`undo ${n}`), redo: () => log.push(`redo ${n}`) });
  s.push(entry("a"));
  s.push(entry("b"));
  assert.equal(s.size, 2);
  assert.equal(s.peek()?.label, "b");
  const b = s.takeUndo();
  b?.undo();
  assert.equal(s.size, 1);
  assert.equal(s.redoSize, 1);
  s.takeRedo()?.redo?.();
  assert.deepEqual(log, ["undo b", "redo b"]);
  assert.equal(s.size, 2);
  s.takeUndo();
  s.push(entry("c"));
  assert.equal(s.redoSize, 0, "a new edit clears what was undone");
  s.push(entry("d"));
  s.push(entry("e"));
  assert.equal(s.size, 3, "only the newest edits are kept");
  assert.deepEqual([s.takeUndo()?.label, s.takeUndo()?.label, s.takeUndo()?.label, s.takeUndo()], ["e", "d", "c", undefined]);
  // an entry without redo can't be redone
  s.push({ label: "x", undo: () => {} });
  s.takeUndo();
  assert.equal(s.takeRedo(), undefined);
  assert.ok(ticks > 0);
  off();
  const before = ticks;
  s.clear();
  assert.equal(ticks, before, "unsubscribed");
  assert.equal(s.size, 0);
});

test("saved camera", () => {
  assert.deepEqual(parseViewport('{"x":10,"y":-4,"zoom":0.8}'), { x: 10, y: -4, zoom: 0.8 });
  assert.equal(parseViewport(null), null);
  assert.equal(parseViewport("not json"), null);
  assert.equal(parseViewport('{"x":1,"y":2}'), null);
  assert.equal(parseViewport('{"x":1,"y":2,"zoom":0}'), null);
});
