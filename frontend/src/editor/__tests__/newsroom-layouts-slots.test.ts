import assert from "node:assert/strict";
import { test } from "node:test";
import { baseClip } from "../model/defaults.ts";
import { addTrack, clipEnd } from "../model/ops.ts";
import { valueAt } from "../model/params.ts";
import type { EditProject, Sequence, TimelineClip } from "../model/types.ts";
import { DESIGN } from "../newsroom/templates/kit.ts";
import { builtinTemplate } from "../newsroom/templates/index.ts";
import { layoutOverrides, slotMotion, slotsAt, boxesOf, layoutAt, layoutClips, type SlotPlacement } from "../newsroom/slots.ts";
import { placePicture, slotProps } from "../newsroom/layouts/geometry.ts";
import type { GfxRatio, SlotBinding } from "../newsroom/types.ts";
import { project, put, seqOf, V } from "./fixtures.ts";

const near = (a: number, b: number, eps = 0.02) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

/** A 25 fps 1080p edit: m1 on V1 frames 0–250, a Layout track on top. */
function edit(): { p: EditProject; s: Sequence; layoutTrack: string } {
  const p = project();
  let s = seqOf(p);
  s = put(p, s, "m1", 0, { in: 0, out: 249 });
  const r = addTrack(s, "video");
  s = { ...r.seq, tracks: r.seq.tracks.map((t) => (t.id === r.trackId ? { ...t, name: "Layout", gfxRole: "layout" as const } : t)) };
  p.sequences = [s];
  return { p, s, layoutTrack: r.trackId };
}
function addLayout(s: Sequence, trackId: string, template: string, start: number, duration: number, extra: Partial<TimelineClip> = {}): { s: Sequence; id: string } {
  const c = { ...baseClip(s, trackId, start, duration, { type: "graphic", gfx: { template, values: {} } }, template), ...extra };
  return { s: { ...s, clips: [...s.clips, c] }, id: c.id };
}
const bind = (s: Sequence, clipId: string, slot: SlotBinding): Sequence => ({ ...s, clips: s.clips.map((c) => (c.id === clipId ? { ...c, slot } : c)) });
const v1 = (s: Sequence) => s.clips.find((c) => c.trackId === V(s, 0).id)!;
const at = (pl: SlotPlacement, f: number) => ({ pos: valueAt(pl.position, f), scale: valueAt(pl.scale, f), crop: [valueAt(pl.crop.left, f), valueAt(pl.crop.right, f), valueAt(pl.crop.top, f), valueAt(pl.crop.bottom, f)] });

test("no layout on screen: null (the clip keeps its own motion); no slot: null", () => {
  const { p, s } = edit();
  const c = v1(bind(s, v1(s).id, { index: 0 }));
  assert.equal(slotMotion(p, s, c, 1920, 1080, { w: 1920, h: 1080 }), null);
  assert.equal(slotMotion(p, s, v1(s), 1920, 1080, { w: 1920, h: 1080 }), null);
  assert.deepEqual(slotsAt(p, s, 10, 1920, 1080), []);
});

test("a clip under a layout for its whole length is placed in its box, static", () => {
  const e = edit();
  let { s } = e;
  ({ s } = addLayout(s, e.layoutTrack, "nr.layouts.two_way", 0, 250));
  s = bind(s, v1(s).id, { index: 1 });
  e.p.sequences = [s];
  const pl = slotMotion(e.p, s, v1(s), 1920, 1080, { w: 1920, h: 1080 })!;
  assert.ok(pl);
  // after the in phase, in box 1 of the 16:9 design
  const b = boxesOf(builtinTemplate("nr.layouts.two_way")!, "16:9").find((x) => x.index === 1)!;
  const want = placePicture(b.box, { w: 1920, h: 1080 }, 1920, 1080, {}, b.box, 1);
  const got = at(pl, 100);
  near(got.pos[0], want.position[0]); near(got.pos[1], want.position[1]); near(got.scale, want.scale);
  got.crop.forEach((v, i) => near(v, want.crop[i]));
  assert.deepEqual(pl.anchor.value, [960, 540]);
  // keyframes only on whole frames, inside the clip
  for (const k of pl.position.keyframes ?? []) { assert.ok(Number.isInteger(k.frame)); assert.ok(k.frame >= 0 && k.frame < 250); }
  // slotsAt agrees (fractions of the frame)
  const boxes = slotsAt(e.p, s, 100, 1920, 1080);
  assert.deepEqual(boxes.map((x) => x.index), [0, 1]);
  const f = boxes[1].box;
  near(f[0] * 1920, b.box[0], 0.01); near(f[2] * 1920, b.box[2], 0.01);
  assert.equal(boxes[1].hole, true);
});

test("the other ratio uses the 9:16 design", () => {
  const e = edit();
  let { s } = e;
  ({ s } = addLayout(s, e.layoutTrack, "nr.layouts.two_way", 0, 250));
  s = bind(s, v1(s).id, { index: 0 });
  e.p.sequences = [s];
  const pl = slotMotion(e.p, s, v1(s), 1080, 1920, { w: 1920, h: 1080 })!;
  const b = boxesOf(builtinTemplate("nr.layouts.two_way")!, "9:16").find((x) => x.index === 0)!;
  const want = placePicture(b.box, { w: 1920, h: 1080 }, 1080, 1920, {}, b.box, 1);
  near(at(pl, 120).pos[1], want.position[1]);
  near(at(pl, 120).scale, want.scale);
  const v = slotsAt(e.p, s, 120, 1080, 1920);
  near(v[0].box[1] * 1920, b.box[1], 0.01);
});

test("a layout shown only in 9:16 leaves the 16:9 picture alone", () => {
  const e = edit();
  let { s } = e;
  const r = addLayout(s, e.layoutTrack, "nr.layouts.two_way", 0, 250);
  s = { ...r.s, clips: r.s.clips.map((c) => (c.id === r.id && c.source.type === "graphic" ? { ...c, source: { ...c.source, gfx: { ...c.source.gfx, ratios: ["9:16" as GfxRatio] } } } : c)) };
  s = bind(s, v1(s).id, { index: 0 });
  e.p.sequences = [s];
  assert.equal(slotMotion(e.p, s, v1(s), 1920, 1080, { w: 1920, h: 1080 }), null);
  assert.ok(slotMotion(e.p, s, v1(s), 1080, 1920, { w: 1920, h: 1080 }));
});

test("squeeze: the main picture glides from full frame into its box over the in phase, on whole frames", () => {
  const e = edit();
  let { s } = e;
  ({ s } = addLayout(s, e.layoutTrack, "nr.layouts.two_way", 50, 150));
  s = bind(s, v1(s).id, { index: 0 });
  e.p.sequences = [s];
  const pl = slotMotion(e.p, s, v1(s), 1920, 1080, { w: 1920, h: 1080 })!;
  // before the layout: full frame
  const full = placePicture([0, 0, 1920, 1080], { w: 1920, h: 1080 }, 1920, 1080, {});
  near(at(pl, 20).scale, full.scale); near(at(pl, 20).pos[0], 960);
  // at its first frame the box is still the full frame, then it shrinks every frame until it sits
  near(at(pl, 50).scale, 100);
  const sc = [50, 52, 55, 58, 62, 66, 70].map((f) => at(pl, f).scale);
  for (let i = 1; i < sc.length; i++) assert.ok(sc[i] <= sc[i - 1] + 1e-6, `shrinks: ${sc}`);
  const ks = pl.scale.keyframes!;
  assert.ok(ks.length > 5);
  for (const k of ks) assert.ok(Number.isInteger(k.frame));
  // the glide keys are on neighbouring frames, linear between
  const moving = ks.filter((k) => k.frame >= 50 && k.frame < 64);
  for (let i = 1; i < moving.length; i++) assert.equal(moving[i].frame - moving[i - 1].frame, 1);
  // the layout gets the matching override: box0 glides in from the full frame, the backdrop doesn't fade
  const lay = layoutClips(e.p, s)[0].clip;
  const ov = layoutOverrides(e.p, s, lay)!;
  assert.deepEqual((ov.box0.p as { morph: { from: Record<string, number[]> } }).morph.from["16:9"], [0, 0, 1, 1]);
  // after the layout the picture carries on: it glides back out to the full frame and is full after it
  assert.deepEqual((ov.box0.p as { morph: { to: Record<string, number[]> } }).morph.to["16:9"], [0, 0, 1, 1]);
  near(at(pl, 210).scale, full.scale);
  // box 1 has no picture before: no glide
  assert.equal((ov.box1?.p as { morph?: unknown } | undefined)?.morph, undefined);
});

test("layout morph: boxes glide from the old layout's place to the new one; the old holds; plates don't dip", () => {
  const e = edit();
  let { s } = e;
  const a = addLayout(s, e.layoutTrack, "nr.layouts.two_way", 0, 100); s = a.s;
  const b = addLayout(s, e.layoutTrack, "nr.layouts.three_way", 100, 150); s = b.s;
  s = bind(s, v1(s).id, { index: 0 });
  e.p.sequences = [s];
  const ovB = layoutOverrides(e.p, s, s.clips.find((c) => c.id === b.id)!)!;
  const from = (ovB.box0.p as { morph: { from: Record<string, number[]> } }).morph.from;
  const twoBox = boxesOf(builtinTemplate("nr.layouts.two_way")!, "16:9")[0].frac;
  assert.deepEqual(from["16:9"], twoBox);
  assert.ok(from["9:16"], "the morph is set for the other ratio too");
  const ovA = layoutOverrides(e.p, s, s.clips.find((c) => c.id === a.id)!)!;
  assert.equal((ovA.box0.p as { morph: { hold: Record<string, boolean> } }).morph.hold["16:9"], true);
  assert.equal(ovB.bg?.anim?.in, undefined);
  const pl = slotMotion(e.p, s, v1(s), 1920, 1080, { w: 1920, h: 1080 })!;
  const old = placePicture(boxesOf(builtinTemplate("nr.layouts.two_way")!, "16:9")[0].box, { w: 1920, h: 1080 }, 1920, 1080, {});
  const neu = placePicture(boxesOf(builtinTemplate("nr.layouts.three_way")!, "16:9")[0].box, { w: 1920, h: 1080 }, 1920, 1080, {});
  near(at(pl, 99).scale, old.scale); near(at(pl, 100).scale, old.scale);
  near(at(pl, 140).scale, neu.scale); near(at(pl, 140).pos[0], neu.position[0]);
  const mid = at(pl, 108).pos[0];
  assert.ok(mid > Math.min(old.position[0], neu.position[0]) - 1 && mid < Math.max(old.position[0], neu.position[0]) + 1);
  assert.equal(layoutAt(e.p, s, 120, "16:9")?.clip.id, b.id);
});

test("a box the layout on screen doesn't have hides the picture", () => {
  const e = edit();
  let { s } = e;
  ({ s } = addLayout(s, e.layoutTrack, "nr.layouts.two_way", 0, 250));
  s = bind(s, v1(s).id, { index: 5 });
  e.p.sequences = [s];
  const pl = slotMotion(e.p, s, v1(s), 1920, 1080, { w: 1920, h: 1080 })!;
  assert.equal(at(pl, 100).scale, 0);
});

test("framing: zoom and offset move the picture inside its box", () => {
  const e = edit();
  let { s } = e;
  ({ s } = addLayout(s, e.layoutTrack, "nr.layouts.pip", 0, 250));
  s = bind(s, v1(s).id, { index: 1, zoom: 1.5, offset: [0.1, 0] });
  e.p.sequences = [s];
  const pl = slotMotion(e.p, s, v1(s), 1920, 1080, { w: 1280, h: 720 })!;
  const b = boxesOf(builtinTemplate("nr.layouts.pip")!, "16:9")[1];
  const want = placePicture(b.box, { w: 1280, h: 720 }, 1920, 1080, { zoom: 1.5, offset: [0.1, 0] }, b.box, 1);
  const got = at(pl, 200);
  near(got.scale, want.scale); near(got.pos[0], want.position[0]);
  assert.ok(got.crop[0] > got.crop[1], "aimed right of centre: more of the left is cut");
});

test("every built-in layout has box 0 and the slot props read back", () => {
  for (const r of ["16:9", "9:16"] as GfxRatio[]) {
    for (const id of ["nr.layouts.two_way", "nr.layouts.squeeze_back", "nr.layouts.v_quote_card"]) {
      const bs = boxesOf(builtinTemplate(id)!, r);
      assert.equal(bs[0].index, 0);
      for (const x of bs) { assert.ok(x.box[0] >= 0 && x.box[1] >= 0 && x.box[0] + x.box[2] <= DESIGN[r].w && x.box[1] + x.box[3] <= DESIGN[r].h); }
    }
  }
  assert.equal(slotProps({ p: { index: 2.4, hole: false } }).index, 2);
  assert.equal(slotProps({ p: {} }).hole, true);
  void clipEnd;
});

test("a box moved for one ratio only ('Change only this one') moves its picture in that ratio only", () => {
  const e = edit();
  let { s } = e;
  const r = addLayout(s, e.layoutTrack, "nr.layouts.two_way", 0, 250);
  s = { ...r.s, clips: r.s.clips.map((c) => (c.id === r.id && c.source.type === "graphic"
    ? { ...c, source: { ...c.source, gfx: { ...c.source.gfx, overrides: { "box1@16:9": { box: [1000, 200, 640, 360] as [number, number, number, number] } } } } } : c)) };
  s = bind(s, v1(s).id, { index: 1 });
  e.p.sequences = [s];
  const pl = slotMotion(e.p, s, v1(s), 1920, 1080, { w: 1920, h: 1080 })!;
  near(at(pl, 120).pos[0], 1320); near(at(pl, 120).pos[1], 380);
  const v = slotMotion(e.p, s, v1(s), 1080, 1920, { w: 1920, h: 1080 })!;
  const b9 = boxesOf(builtinTemplate("nr.layouts.two_way")!, "9:16")[1].box;
  near(at(v, 120).pos[1], b9[1] + b9[3] / 2, 0.5);
});
