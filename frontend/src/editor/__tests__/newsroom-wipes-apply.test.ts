import assert from "node:assert/strict";
import { test } from "node:test";
import { PACK, PACK_PREFIX } from "../../engine/transitions/pack/index.ts";
import { clipEnd, tracksOf } from "../model/ops.ts";
import { builtinLook } from "../newsroom/looks.ts";
import { STINGERS } from "../newsroom/templates/stingers.ts";
import { applyNewsTransition, applyStinger, cutsOf, NEWS_TRANSITIONS, nearestCut, rgb01, stingerPlacement } from "../newsroom/wipes/apply.ts";
import { project, put, seqOf, V } from "./fixtures.ts";

const look = builtinLook("look.classic_red")!;

/** A 25 fps edit with three shots on V1: cuts at 100 and 180. */
function edit() {
  const p = project();
  let s = seqOf(p);
  s = put(p, s, "m1", 0, { in: 0, out: 100 });
  s = put(p, s, "m2", 100, { in: 0, out: 80 });
  s = put(p, s, "m1", 180, { in: 120, out: 220 });
  p.sequences = [s];
  return p;
}

test("placement maths: the cut fraction lands on the cut frame (within half a frame)", () => {
  for (const fps of [23.976, 24, 25, 29.97, 30, 50, 60]) {
    for (const [sec, cut] of [[1.2, 0.5], [1.5, 0.45], [0.9, 0.55], [1.6, 0.375]] as const) {
      const pl = stingerPlacement(sec, cut, fps, 500)!;
      assert.equal(pl.start + pl.pre, 500);
      assert.equal(pl.duration, Math.round(sec * fps));
      // the clip time at the cut frame vs the cut point of the clip's own length
      const err = Math.abs(pl.pre / fps - cut * (pl.duration / fps));
      assert.ok(err <= 0.5 / fps + 1e-9, `${fps} ${sec} ${cut}: ${err}`);
    }
  }
  // near the start it gets a little shorter, never starts before 0
  const near = stingerPlacement(1.2, 0.5, 25, 10)!;
  assert.equal(near.start, 0); assert.equal(near.pre, 10); assert.equal(near.duration, 20);
  assert.equal(stingerPlacement(1.2, 0.5, 25, 1), null);
});

test("applyStinger puts the wipe on the Wipes track with its cut on the cut", () => {
  const p = edit();
  const s0 = seqOf(p);
  const t = STINGERS.find((x) => x.id === "nr.stingers.logo_wipe")!;
  const id = applyStinger(p, s0.id, 100, t.id)!;
  assert.ok(id);
  const s = seqOf(p);
  const c = s.clips.find((x) => x.id === id)!;
  const track = s.tracks.find((x) => x.id === c.trackId)!;
  assert.equal(track.gfxRole, "wipe");
  const pre = 100 - c.start;
  assert.equal(c.duration, Math.round(t.seconds * s.fps));
  assert.ok(Math.abs(pre / c.duration - t.cut!) <= 0.5 / c.duration + 1e-9);
  assert.ok(p.newsroom?.templates[t.id], "the template is copied into the edit");
  // not a stinger → nothing
  assert.equal(applyStinger(p, s0.id, 100, "nr.backgrounds.news_grid"), null);
});

test("nearest cut: true cuts on picture tracks first, graphics tracks ignored, edges as a fallback", () => {
  const p = edit();
  const s = seqOf(p);
  assert.deepEqual(cutsOf(s), [100, 180]);
  assert.equal(nearestCut(s, 0), 100);
  assert.equal(nearestCut(s, 139), 100);
  assert.equal(nearestCut(s, 141), 180);
  applyStinger(p, s.id, 180, "nr.stingers.blades");
  assert.deepEqual(cutsOf(seqOf(p)), [100, 180], "the wipe's own edges are not cuts");
  // one shot on V1, another later on V2: their edges
  const q = project();
  let s2 = seqOf(q);
  s2 = put(q, s2, "m1", 0, { in: 0, out: 100 });
  s2 = put(q, s2, "m2", 60, { in: 0, out: 50 }, 1);
  assert.deepEqual(cutsOf(s2), []);
  assert.equal(nearestCut(s2, 70), 60);
  assert.equal(nearestCut(seqOf(project()), 10), null);
});

test("every news transition is a real pack transition, and colour params come from the look", () => {
  const ids = new Set(PACK.map((t) => PACK_PREFIX + t.id));
  assert.ok(NEWS_TRANSITIONS.length >= 12);
  assert.equal(new Set(NEWS_TRANSITIONS.map((t) => t.id)).size, NEWS_TRANSITIONS.length);
  for (const t of NEWS_TRANSITIONS) {
    assert.ok(ids.has(t.type), `${t.id}: ${t.type} isn't in the pack`);
    const def = PACK.find((x) => PACK_PREFIX + x.id === t.type)!;
    for (const [k, v] of Object.entries(t.params?.(look) ?? {})) {
      const pd = def.params.find((x) => x.name === k);
      assert.ok(pd, `${t.id}: ${k} isn't a param of ${t.type}`);
      if (pd.color) assert.ok(Array.isArray(v) && v.length === 3 && v.every((x) => x >= 0 && x <= 1), `${t.id}.${k}`);
    }
  }
  assert.deepEqual(rgb01("#FF0000"), [1, 0, 0]);
  const leak = NEWS_TRANSITIONS.find((t) => t.id === "news.light_leak")!.params!(look);
  assert.deepEqual(leak.color1, rgb01(look.colors.primary));
});

test("applyNewsTransition adds the transition at the cut on the picture track", () => {
  const p = edit();
  const s0 = seqOf(p);
  const id = applyNewsTransition(p, s0.id, 100, "news.edge_wipe", look)!;
  assert.ok(id);
  const s = seqOf(p);
  const tr = s.transitions.find((x) => x.id === id)!;
  assert.equal(tr.trackId, V(s, 0).id);
  assert.equal(tr.at, 100);
  assert.equal(tr.type, "tv:matte_linear");
  assert.deepEqual((tr.params as { edge_color: number[] }).edge_color, rgb01(look.colors.accent));
  assert.equal(tr.easing, "ease_in_out");
  assert.equal(tr.fromClipId && clipEnd(s.clips.find((c) => c.id === tr.fromClipId)!), 100);
  // no cut there, or an unknown preset → nothing
  assert.equal(applyNewsTransition(p, s0.id, 37, "news.flip", look), null);
  assert.equal(applyNewsTransition(p, s0.id, 180, "news.nope", look), null);
  assert.equal(tracksOf(s, "video").length >= 1, true);
});
