import assert from "node:assert/strict";
import { test } from "node:test";
import { magnetize, magnetizeProject } from "../model/magnetic.ts";
import { clipsFromMedia, ctxOf, moveClips, placeClips, rearrange, removeClips, tracksOf, trimClip } from "../model/ops.ts";
import type { Sequence } from "../model/types.ts";
import { A, on, project, put, seqOf, spans, V } from "./fixtures.ts";

/** V1: m1 [0,100) and m2 [150,250) with their sound on A1; a title-like clip of m2 on V2 at 170 (30 long). */
function setup() {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  s = put(p, s, "m2", 150, { in: 0, out: 99 });
  const over = clipsFromMedia(s, p.media[1], 170, { videoTrackId: V(s, 1).id, range: { in: 0, out: 29 } });
  s = placeClips(s, ctx, over, "overwrite");
  return { p, ctx, s };
}
const on1 = (s: Sequence) => magnetize(undefined, { ...s, magnetic: true }, ctxOf({ media: [], sequences: [] }));

test("turning magnetic on closes V1's gaps; the A/V halves and connected clips move with their V1 clip", () => {
  const { s, ctx } = setup();
  const m = magnetize(undefined, { ...s, magnetic: true }, ctx);
  assert.deepEqual(spans(m, V(m, 0).id), [[0, 100], [100, 200]]);
  assert.deepEqual(spans(m, A(m, 0).id), [[0, 100], [100, 200]], "the sound halves follow");
  const top = on(m, V(m, 1).id)[0];
  assert.equal(top.start, 120, "the connected clip keeps its place on its V1 clip");
  assert.equal(top.connectedTo, on(m, V(m, 0).id)[1].id);
  assert.equal(top.connectOffset, 20);
  void on1;
});

test("deleting a V1 clip closes the storyline: everything after it moves up, connected clips ride along", () => {
  const { s, ctx } = setup();
  const m = magnetize(undefined, { ...s, magnetic: true }, ctx);
  const first = on(m, V(m, 0).id)[0];
  const del = magnetize(m, removeClips(m, ctx, [first.id]), ctx);
  assert.deepEqual(spans(del, V(del, 0).id), [[0, 100]]);
  assert.equal(on(del, V(del, 1).id)[0].start, 20);
  // the deleted picture's sound (an unlinked delete) stays; the next clip's sound comes along with its picture, and the
  // orphan, now in its way, goes up a track
  assert.deepEqual(spans(del, A(del, 0).id), [[0, 100]]);
  assert.equal((on(del, A(del, 0).id)[0].source as { mediaId: string }).mediaId, "m2");
  assert.deepEqual(spans(del, A(del, 1).id), [[0, 100]]);
});

test("trimming a V1 clip shorter ripples the storyline; moving a connected clip reconnects it where it lands", () => {
  const { s, ctx } = setup();
  const m = magnetize(undefined, { ...s, magnetic: true }, ctx);
  const [a] = on(m, V(m, 0).id);
  const t = magnetize(m, trimClip(m, ctx, a.id, "end", -40), ctx);
  assert.deepEqual(spans(t, V(t, 0).id), [[0, 60], [60, 160]]);
  assert.equal(on(t, V(t, 1).id)[0].start, 80);
  // drag the V2 clip onto the first V1 clip: it connects there and then rides with that clip
  const top = on(t, V(t, 1).id)[0];
  const moved = magnetize(t, moveClips(t, ctx, [top.id], -70), ctx);
  const nt = on(moved, V(moved, 1).id)[0];
  assert.equal(nt.start, 10);
  assert.equal(nt.connectedTo, on(moved, V(moved, 0).id)[0].id);
  // rearranging the storyline (the second clip first) carries the connected clip of the first one along
  const [x, y] = on(moved, V(moved, 0).id);
  const re = magnetize(moved, rearrange(moved, ctx, [y.id, ...on(moved, A(moved, 0).id).filter((c) => c.start === y.start).map((c) => c.id)], 0), ctx);
  assert.deepEqual(on(re, V(re, 0).id).map((c) => c.id), [y.id, x.id]);
  assert.equal(on(re, V(re, 1).id)[0].start, 100 + 10, "it stayed on its clip, which now comes second");
});

test("a connected clip that would land on a busy stretch goes up to a free track", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 }, 0, 0, false);
  s = put(p, s, "m2", 200, { in: 0, out: 99 }, 0, 0, false);
  // V2: one clip under the first V1 clip (unconnected stays), one on the second V1 clip
  s = placeClips(s, ctx, clipsFromMedia(s, p.media[0], 20, { videoTrackId: V(s, 1).id, range: { in: 0, out: 59 } }), "overwrite");
  s = placeClips(s, ctx, clipsFromMedia(s, p.media[1], 210, { videoTrackId: V(s, 1).id, range: { in: 0, out: 49 } }), "overwrite");
  const n = tracksOf(s, "video").length;
  const m = magnetize(undefined, { ...s, magnetic: true }, ctx);
  // the second V1 clip closes up to 100; its V2 clip moves to 110 — free on V2 (the other one ends at 80)
  assert.equal(on(m, V(m, 1).id).map((c) => c.start).join(), "20,110");
  // now make the first V1 clip longer: the second (and its V2 clip) move later; shorten so they collide
  const busy = magnetize(m, trimClip(m, ctx, on(m, V(m, 0).id)[0].id, "end", -60, { ripple: false }), ctx);
  // V1: [0,40) [40,140); its V2 clip goes to 50, which overlaps [20,80) on V2: it moves up to V3
  const v3 = on(busy, V(busy, 2).id);
  assert.equal(v3.length, 1); assert.equal(v3[0].start, 50);
  assert.equal(tracksOf(busy, "video").length, Math.max(n, 3));
});

test("magnetizeProject leaves sequences in position mode alone", () => {
  const { p, s } = setup();
  const p2 = { ...p, sequences: [s] };
  assert.equal(magnetizeProject(p, p2, ctxOf(p2)), p2);
  const m = magnetizeProject(p2, { ...p2, sequences: [{ ...s, magnetic: true }] }, ctxOf(p2));
  assert.deepEqual(spans(m.sequences[0], V(m.sequences[0], 0).id), [[0, 100], [100, 200]]);
});
