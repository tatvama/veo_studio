import assert from "node:assert/strict";
import { test } from "node:test";
import { baseClip } from "../model/defaults.ts";
import { addTrack, clipEnd, tracksOf } from "../model/ops.ts";
import type { EditProject, Sequence } from "../model/types.ts";
import { assignSlot, boxesOf, boxesOfClip, clearSlot, clipInBox, clipsUnder, layoutOf, placeInSlot, setSlotFraming } from "../newsroom/layouts/commands.ts";
import { builtinTemplate } from "../newsroom/templates/index.ts";
import { project, put, seqOf, V } from "./fixtures.ts";

/** m1 on V1 0–250, a two-way layout on a Layout track (above V3) from 50 for 100 frames. */
function edit(template = "nr.layouts.two_way"): { p: EditProject; layoutId: string } {
  const p = project();
  let s = seqOf(p);
  s = put(p, s, "m1", 0, { in: 0, out: 249 });
  const r = addTrack(s, "video");
  s = { ...r.seq, tracks: r.seq.tracks.map((t) => (t.id === r.trackId ? { ...t, name: "Layout", gfxRole: "layout" as const } : t)) };
  const c = baseClip(s, r.trackId, 50, 100, { type: "graphic", gfx: { template, values: {} } }, "Two-way");
  s = { ...s, clips: [...s.clips, c] };
  p.sequences = [s];
  return { p, layoutId: c.id };
}
const sq = (p: EditProject): Sequence => p.sequences[0];

test("assign, frame and clear a box", () => {
  const { p } = edit();
  const id = sq(p).clips.find((c) => c.trackId === V(sq(p), 0).id)!.id;
  assignSlot(p, sq(p).id, id, 1);
  assert.deepEqual(sq(p).clips.find((c) => c.id === id)!.slot, { index: 1 });
  setSlotFraming(p, sq(p).id, id, { zoom: 20, offset: [0.9, -0.2], fit: "contain" });
  assert.deepEqual(sq(p).clips.find((c) => c.id === id)!.slot, { index: 1, zoom: 8, offset: [0.5, -0.2], fit: "contain" });
  assignSlot(p, sq(p).id, id, 0);
  assert.equal(sq(p).clips.find((c) => c.id === id)!.slot!.zoom, 8, "re-assigning keeps the framing");
  clearSlot(p, sq(p).id, id);
  assert.equal("slot" in sq(p).clips.find((c) => c.id === id)!, false);
});

test("boxesOf: indices 0..n-1 per ratio, by template or by clip", () => {
  const t = builtinTemplate("nr.layouts.six_way")!;
  assert.deepEqual(boxesOf(t, "16:9").map((b) => b.index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(boxesOf(t, "9:16").map((b) => b.index), [0, 1, 2, 3, 4, 5]);
  const { p, layoutId } = edit();
  assert.equal(boxesOfClip(p, sq(p), layoutId).length, 2);
  assert.ok(layoutOf(p, sq(p), layoutId));
  assert.equal(layoutOf(p, sq(p), sq(p).clips[0].id), null);
});

test("placeInSlot: a video goes on a free picture track under the layout, spanning it, bound, with its sound", () => {
  const { p, layoutId } = edit();
  const id = placeInSlot(p, sq(p).id, "m2", layoutId, 1);
  const s = sq(p);
  const c = s.clips.find((x) => x.id === id)!;
  assert.deepEqual(c.slot, { index: 1 });
  assert.equal(c.start, 50); assert.equal(c.duration, 100);
  const vt = tracksOf(s, "video");
  const lay = s.clips.find((x) => x.id === layoutId)!;
  const idx = (tid: string) => vt.find((t) => t.id === tid)!.index;
  assert.ok(idx(c.trackId) < idx(lay.trackId), "below the layout");
  assert.notEqual(c.trackId, V(s, 0).id, "not over the clip on V1");
  const sound = s.clips.find((x) => x.linkId && x.linkId === c.linkId && x.id !== c.id);
  assert.ok(sound, "its sound is linked on an audio track");
  assert.deepEqual(clipsUnder(p, s, layoutId).map((x) => x.id).includes(id), true);
  assert.equal(clipInBox(p, s, layoutId, 1)?.id, id);
  // a new picture for the same box replaces it there (and its sound)
  const id2 = placeInSlot(p, sq(p).id, "still", layoutId, 1);
  const s2 = sq(p);
  const c2 = s2.clips.find((x) => x.id === id2)!;
  assert.equal(c2.trackId, c.trackId);
  assert.equal(c2.duration, 100, "a picture spans the layout");
  assert.equal(s2.clips.some((x) => x.id === id), false);
  assert.equal(s2.clips.some((x) => x.linkId === c.linkId), false);
  assert.equal(clipInBox(p, s2, layoutId, 1)?.id, id2);
});

test("placeInSlot: a short video lasts as long as it does; a new track when none is free", () => {
  const { p, layoutId } = edit();
  p.media.push({ ...p.media[0], id: "short", name: "short", duration: 40 });
  // fill V2 and V3 under the layout's range
  let s = sq(p);
  s = put(p, s, "m2", 0, { in: 0, out: 249 }, 1, 1);
  s = put(p, s, "m2", 0, { in: 0, out: 249 }, 2, 2);
  p.sequences = [s];
  const before = tracksOf(s, "video").length;
  const id = placeInSlot(p, sq(p).id, "short", layoutId, 1);
  const s2 = sq(p);
  assert.equal(tracksOf(s2, "video").length, before + 1);
  const c = s2.clips.find((x) => x.id === id)!;
  assert.equal(c.duration, 40);
  const vt = tracksOf(s2, "video");
  const lay = s2.clips.find((x) => x.id === layoutId)!;
  assert.ok(vt.find((t) => t.id === c.trackId)!.index < vt.find((t) => t.id === lay.trackId)!.index, "the layout stays on top");
  assert.throws(() => placeInSlot(p, sq(p).id, "music", layoutId, 0));
  void clipEnd;
});

test("placeInSlot keeps an inset above the big box it sits on", () => {
  const p = project();
  let s = seqOf(p);
  s = put(p, s, "m1", 0, { in: 0, out: 249 }, 1, 0);  // the main picture on V2; V1 is free
  const r = addTrack(s, "video");
  s = { ...r.seq, tracks: r.seq.tracks.map((t) => (t.id === r.trackId ? { ...t, gfxRole: "layout" as const } : t)) };
  const lay = baseClip(s, r.trackId, 0, 200, { type: "graphic", gfx: { template: "nr.layouts.pip", values: {} } }, "PiP");
  s = { ...s, clips: [...s.clips.map((c) => (c.trackId === V(s, 1).id ? { ...c, slot: { index: 0 } } : c)), lay] };
  p.sequences = [s];
  const id = placeInSlot(p, s.id, "m2", lay.id, 1);
  const s2 = sq(p);
  const idx = (tid: string) => s2.tracks.find((t) => t.id === tid)!.index;
  const main = s2.clips.find((c) => c.slot?.index === 0)!;
  assert.ok(idx(s2.clips.find((c) => c.id === id)!.trackId) > idx(main.trackId), "the inset is above the main picture");
  // and the main picture placed after an inset goes under it
  const p2 = edit("nr.layouts.pip").p;
  const L2 = p2.sequences[0].clips.find((c) => c.source.type === "graphic")!.id;
  const inset = placeInSlot(p2, p2.sequences[0].id, "m2", L2, 1);
  const big = placeInSlot(p2, p2.sequences[0].id, "still", L2, 0);
  const s3 = p2.sequences[0];
  const i3 = (cid: string) => s3.tracks.find((t) => t.id === s3.clips.find((c) => c.id === cid)!.trackId)!.index;
  assert.ok(i3(big) < i3(inset));
});
