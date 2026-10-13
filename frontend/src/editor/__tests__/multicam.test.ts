import assert from "node:assert/strict";
import { test } from "node:test";
import { unnestClip } from "../model/compound.ts";
import { angleCuts, createMulticamSequence, flattenMulticam, offsetsFromInPoints, offsetsFromTimeline, placeMulticam, switchAngle } from "../model/multicam.ts";
import { ctxOf, nestClips, tracksOf } from "../model/ops.ts";
import { parseProject } from "../model/serialize.ts";
import { toAudioMix, toVideoComposition } from "../model/toComposition.ts";
import { A, on, project, put, seqOf, spans, V } from "./fixtures.ts";

/** Two angles (m1, m2), m2 starting 2 s (50 frames) after m1 on the shared clock; a multicam clip on V1/A1. */
function setup() {
  const p0 = project();
  const s0 = seqOf(p0);
  const mc = createMulticamSequence(p0, "Interview", [{ mediaId: "m1", name: "Wide", offset: 0 }, { mediaId: "m2", name: "Close", offset: 2 }], s0, "audio");
  const placed = placeMulticam(mc.project, s0.id, mc.sequenceId, 0, V(s0, 0).id, A(s0, 0).id);
  return { p: placed.project, mcId: mc.sequenceId, ids: placed.clipIds };
}

test("a multicam sequence puts each angle on its own track in sync; the clip starts on angle 1", () => {
  const { p, mcId, ids } = setup();
  const mc = p.sequences.find((s) => s.id === mcId)!;
  assert.deepEqual(mc.multicam?.angles.map((a) => a.name), ["Wide", "Close"]);
  assert.deepEqual(spans(mc, tracksOf(mc, "video")[0].id), [[0, 250]]);
  assert.deepEqual(spans(mc, tracksOf(mc, "video")[1].id), [[50, 300]]);
  assert.deepEqual(spans(mc, tracksOf(mc, "audio")[1].id), [[50, 300]]);
  const s = p.sequences[0];
  assert.deepEqual(on(s, V(s, 0).id).map((c) => [c.start, c.duration, c.multicam?.angle]), [[0, 300, 0]]);
  assert.equal(ids.length, 2);
});

test("sync offsets from the timeline and from in points", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 30, out: 129 });
  s = put(p, s, "m2", 10, { in: 0, out: 99 }, 1, 1);
  const [a, b] = [on(s, V(s, 0).id)[0], on(s, V(s, 1).id)[0]];
  // m2 frame 0 plays at timeline 10, where m1 shows its frame 40 → m2 starts 1.6 s into m1
  assert.deepEqual(offsetsFromTimeline([a, b], s, ctx).map((x) => Math.round(x * 100) / 100), [0, 1.6]);
  assert.deepEqual(offsetsFromInPoints([a, b], s, ctx).map((x) => Math.round(x * 100) / 100), [0, 1.2]);
});

test("switching angles cuts the clip at the playhead; flatten gives the angles' media back", () => {
  const { p, mcId } = setup();
  const ctx = ctxOf(p);
  let s = p.sequences[0];
  s = switchAngle(s, ctx, V(s, 0).id, 100, 1);
  s = switchAngle(s, ctx, V(s, 0).id, 200, 0);
  s = switchAngle(s, ctx, V(s, 0).id, 200, 0);    // already on that angle: nothing
  assert.deepEqual(angleCuts(s, V(s, 0).id), [[0, 0], [100, 1], [200, 0]]);
  assert.equal(on(s, A(s, 0).id).length, 1, "the sound runs on across picture cuts");
  // the engine sees one angle per piece
  const p2 = { ...p, sequences: p.sequences.map((x) => (x.id === s.id ? s : x)) };
  const comp = toVideoComposition(p2, s.id).comp;
  const nested = comp.tracks[0].clips;
  assert.deepEqual(nested.map((c) => c.comp!.tracks.map((t) => !t.hidden)), [[true, false], [false, true], [true, false]]);
  // its sound in the preview mix: the audio angle's track
  const mix = toAudioMix(p2, s.id);
  assert.ok(mix.clips.length >= 1 && mix.clips.every((c) => c.url.includes("m1")));
  const flat = flattenMulticam(p2, s.id).sequences[0];
  const v = on(flat, V(flat, 0).id);
  assert.deepEqual(v.map((c) => [c.start, c.duration, (c.source as { mediaId: string }).mediaId, (c.source as { in: number }).in]),
    [[0, 100, "m1", 0], [100, 100, "m2", 50], [200, 50, "m1", 200]]);
  assert.ok(!v.some((c) => c.multicam), "flattened clips are plain media");
  assert.deepEqual(on(flat, A(flat, 0).id).map((c) => [c.start, c.duration, (c.source as { mediaId: string }).mediaId]), [[0, 250, "m1"]]);
  void mcId;
});

test("multicam, magnetic and ramp fields survive a save", () => {
  const { p } = setup();
  const s = { ...p.sequences[0], magnetic: true };
  const back = parseProject(JSON.parse(JSON.stringify({ ...p, sequences: [s, ...p.sequences.slice(1)] }))).project;
  assert.equal(back.sequences[0].magnetic, true);
  assert.equal(back.sequences[1].multicam?.angles.length, 2);
  assert.equal(on(back.sequences[0], V(back.sequences[0], 0).id)[0].multicam?.angle, 0);
});

test("nest then un-nest puts the clips back where they were", () => {
  const p = project();
  let s = put(p, seqOf(p), "m1", 20, { in: 0, out: 49 });
  s = put(p, s, "m2", 70, { in: 10, out: 59 });
  const p1 = { ...p, sequences: [s] };
  const ids = s.clips.map((c) => c.id);
  const nested = nestClips(p1, s.id, ids, "Scene 1");
  const ns = nested.project.sequences[0];
  assert.equal(on(ns, V(ns, 0).id).length, 1);
  const nc = on(ns, V(ns, 0).id)[0];
  const un = unnestClip(nested.project, s.id, nc.id).project.sequences[0];
  assert.deepEqual(spans(un, V(un, 0).id), [[20, 70], [70, 120]]);
  assert.deepEqual(spans(un, A(un, 0).id), [[20, 70], [70, 120]]);
  assert.equal((on(un, V(un, 0).id)[1].source as { in: number }).in, 10);
});

test("a multicam clip made over part of the timeline only replaces that part", () => {
  const p = project();
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  s = put(p, s, "m2", 100, { in: 0, out: 99 });     // what comes after must stay
  const p1 = { ...p, sequences: [s] };
  const mc = createMulticamSequence(p1, "Two", [{ mediaId: "m1", offset: 0 }, { mediaId: "m2", offset: 0 }], s, "timeline");
  const first = on(s, V(s, 0).id)[0];
  const placed = placeMulticam(mc.project, s.id, mc.sequenceId, 0, V(s, 0).id, A(s, 0).id, [first.id, ...s.clips.filter((c) => c.linkId === first.linkId).map((c) => c.id)], { in: 0, duration: 100 });
  const out = placed.project.sequences[0];
  assert.deepEqual(spans(out, V(out, 0).id), [[0, 100], [100, 200]]);
  assert.equal((on(out, V(out, 0).id)[1].source as { mediaId: string }).mediaId, "m2");
  assert.ok(on(out, V(out, 0).id)[0].multicam);
});
