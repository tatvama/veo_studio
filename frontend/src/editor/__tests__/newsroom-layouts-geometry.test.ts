import assert from "node:assert/strict";
import { test } from "node:test";
import { designToFrame, intersect, placePicture, slotPose, toFrac, fromFrac, FULL } from "../newsroom/layouts/geometry.ts";
import type { Box, GfxLayer } from "../newsroom/types.ts";

const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const S16 = { w: 1920, h: 1080 };

/** Where the picture ends up on screen and what part of it shows (frame px), from a placement. */
function shown(pl: ReturnType<typeof placePicture>, pic: { w: number; h: number }, W: number, H: number) {
  const fit = Math.min(W / pic.w, H / pic.h);
  const dw = pic.w * fit * (pl.scale / 100), dh = pic.h * fit * (pl.scale / 100);
  const x0 = pl.position[0] - dw / 2, y0 = pl.position[1] - dh / 2;
  const [l, r, t, b] = pl.crop;
  return { dw, dh, rect: [x0, y0, dw, dh] as Box, vis: [x0 + (dw * l) / 100, y0 + (dh * t) / 100, dw * (1 - (l + r) / 100), dh * (1 - (t + b) / 100)] as Box };
}

test("cover: a 16:9 picture fills a 4:3 box, centred, cropped to the box", () => {
  const box: Box = [100, 100, 800, 600];
  const pic = { w: 1920, h: 1080 };
  const pl = placePicture(box, pic, 1920, 1080, {});
  const s = shown(pl, pic, 1920, 1080);
  near(s.dh, 600); near(s.dw, 600 * (16 / 9));
  near(pl.position[0], 500); near(pl.position[1], 400);
  // scale: % of the size fitted inside the frame (1920 wide): 1066.67 / 1920
  near(pl.scale, (1066.6667 / 1920) * 100, 0.01);
  // the sides are cropped equally, top and bottom not at all
  near(pl.crop[0], pl.crop[1]); near(pl.crop[2], 0); near(pl.crop[3], 0);
  s.vis.forEach((v, i) => near(v, box[i], 0.05));
});

test("contain: the whole picture inside the box, nothing cropped", () => {
  const box: Box = [100, 100, 800, 600];
  const pl = placePicture(box, { w: 1920, h: 1080 }, 1920, 1080, { fit: "contain" });
  assert.deepEqual(pl.crop, [0, 0, 0, 0]);
  const s = shown(pl, { w: 1920, h: 1080 }, 1920, 1080);
  near(s.dw, 800); near(s.dh, 450);
  near(pl.position[0], 500); near(pl.position[1], 400);
});

test("zoom enlarges about the aim and offset aims, never uncovering the box", () => {
  const box: Box = [0, 0, 960, 540];
  const pic = { w: 1920, h: 1080 };
  const z = placePicture(box, pic, 1920, 1080, { zoom: 2 });
  near(z.scale, 100);  // 2 × the 50 % that fills the box
  near(z.crop[0], 25); near(z.crop[1], 25); near(z.crop[2], 25); near(z.crop[3], 25);
  // aim at the picture's left quarter: the picture moves right by a quarter of its size
  const o = placePicture(box, pic, 1920, 1080, { zoom: 2, offset: [-0.25, 0] });
  near(o.position[0], 480 + 0.25 * 1920);
  near(o.crop[0], 0); near(o.crop[1], 50);
  // aiming past the edge is clamped: the box stays covered
  const far = placePicture(box, pic, 1920, 1080, { zoom: 2, offset: [-0.5, 0.5] });
  const s = shown(far, pic, 1920, 1080);
  assert.ok(s.rect[0] <= 0.001 && s.rect[0] + s.rect[2] >= 960 - 0.001 && s.rect[1] <= 0.001 && s.rect[1] + s.rect[3] >= 540 - 0.001);
});

test("crop keeps only the window (and a bleed), percentages of the picture", () => {
  const box: Box = [200, 100, 800, 450];
  const win: Box = [200, 100, 400, 450];  // the left half is open (a wipe)
  const pl = placePicture(box, { w: 1920, h: 1080 }, 1920, 1080, {}, win);
  near(pl.crop[1], 50); near(pl.crop[0], 0);
  const b = placePicture(box, { w: 1920, h: 1080 }, 1920, 1080, {}, box, 1);
  near(b.crop[0], 0); near(b.crop[2], 0);  // a bleed can't crop below 0
  const tiny = placePicture(box, { w: 1920, h: 1080 }, 1920, 1080, {}, [200, 100, 0, 450]);
  assert.equal(tiny.scale, 0, "a closed window hides the picture");
});

test("a picture in a vertical frame: scale is % of the size fitted in that frame", () => {
  const pl = placePicture([0, 0, 1080, 1920], { w: 1920, h: 1080 }, 1080, 1920, {});
  // fitted: 1080 wide (k = 0.5625); covering 1080×1920: k = 1.7778 → 316 %
  near(pl.scale, (1920 / 1080 / 0.5625) * 100, 0.05);
});

test("design boxes map like the renderer: fitted and centred", () => {
  assert.deepEqual(designToFrame([960, 540, 960, 540], S16, 3840, 2160), [1920, 1080, 1920, 1080]);
  // a 4:3 frame drawing the 16:9 design: letterboxed
  const b = designToFrame([0, 0, 1920, 1080], S16, 1440, 1080);
  near(b[1], (1080 - 810) / 2); near(b[2], 1440);
  assert.deepEqual(fromFrac(toFrac([480, 270, 960, 540], S16), S16), [480, 270, 960, 540]);
  assert.deepEqual(intersect([0, 0, 10, 10], [5, 5, 10, 10]), [5, 5, 5, 5]);
});

const slot = (p: Record<string, unknown>, anim?: GfxLayer["anim"]): GfxLayer => ({ id: "box1", name: "b", kind: "slot", box: [960, 100, 800, 450], p: { index: 1, ...p }, anim });

test("poses: a glide from the previous box, holds, reveals and a plain box", () => {
  const morph = { from: { "16:9": toFrac([0, 0, 1920, 1080], S16) } };
  const l = slot({ morph }, { in: { kind: "fade", dur: 0.6 } });
  const a = slotPose(l, 0, 0, "16:9", S16, "sharp");
  assert.deepEqual(a.box, [0, 0, 1920, 1080]);
  const mid = slotPose(l, 0.5, 0, "16:9", S16, "sharp");
  assert.deepEqual(mid.box.map((v) => Math.round(v)), [480, 50, 1360, 765]);
  assert.deepEqual(slotPose(l, 1, 0, "16:9", S16, "sharp").box, [960, 100, 800, 450]);
  // another ratio has no glide: the step's own fade
  assert.ok(slotPose(l, 0.3, 0, "9:16", S16, "sharp").alpha < 1);
  // hold: the box stays while its tag fades
  const h = slotPose(slot({}, { out: { kind: "hold", dur: 0.4 } }), 1, 0.5, "16:9", S16, "sharp");
  assert.deepEqual(h.box, [960, 100, 800, 450]);
  assert.ok(h.deco < 1);
  // wipe right: the window opens from the left edge, the picture stays put
  const w = slotPose(slot({}, { in: { kind: "wipe", dir: "right", dur: 0.5 } }), 0.5, 0, "16:9", S16, "sharp");
  assert.deepEqual(w.box, [960, 100, 800, 450]);
  assert.equal(w.win[0], 960);
  assert.ok(w.win[2] > 0 && w.win[2] < 800);
  // closed before it starts
  assert.equal(slotPose(slot({}, { in: { kind: "wipe", dir: "right", dur: 0.5 } }), 0, 0, "16:9", S16, "sharp").win[2], 0);
  const still = slotPose(slot({}), 0.2, 0, "16:9", S16, "smooth");
  assert.deepEqual(still, { box: [960, 100, 800, 450], win: [960, 100, 800, 450], alpha: 1, deco: 1 });
  // glide out to the full frame
  const to = slotPose(slot({ morph: { to: { "16:9": FULL } } }, { out: { kind: "hold", dur: 0.4 } }), 1, 1, "16:9", S16, "sharp");
  assert.deepEqual(to.box, [0, 0, 1920, 1080]);
});
