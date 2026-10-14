import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinLook, DEFAULT_LOOK_ID } from "../newsroom/looks.ts";
import { easeFn, layerTiming, loopMoving, loopPose, partProgress, phasesOf, poseOf, stepProgress } from "../newsroom/render/anim.ts";
import type { GfxRenderInput } from "../newsroom/render/contract.ts";
import { fillText, graphicFrameKey, hash01, layerState } from "../newsroom/render/index.ts";
import { applyOverrides, contentBox, designFor, designSpace, guessPin, liftFor, planOf, ratioOf, relayout, shownBy } from "../newsroom/render/layout.ts";
import { charParts, ellipsize, fitText, wordParts, wrapText } from "../newsroom/render/text.ts";
import { anim, field, rect, step, text, tpl } from "../newsroom/templates/kit.ts";
import type { Box } from "../newsroom/types.ts";

const look = builtinLook(DEFAULT_LOOK_ID)!;
/** A monospace measurer: every character is 0.5 em wide. */
const mono = (size: number) => (s: string) => s.length * size * 0.5;

const strap = tpl({
  id: "t.strap", name: "Strap", category: "Straps", role: "strap", seconds: 6, timing: { in: 0.6, out: 0.4 },
  fields: [field.text("name", "Name", "Priya Rao"), field.text("role", "Role", ""), field.number("n", "N", 1234567, { compact: true })],
  designs: {
    "16:9": [
      rect("plate", [120, 820, 760, 86], { fill: "@primary" }, { anim: anim(step("grow", { dur: 0.4 }), step("wipe", { dir: "left", dur: 0.3 })) }),
      text("name", [150, 820, 700, 86], "{name}", { size: 52 }, { anim: anim(step("stagger", { by: "word", delay: 0.2, dur: 0.4 }), step("fade")) }),
      text("role", [150, 906, 600, 40], "{role}", { size: 30 }, { when: "{role}" }),
    ],
    "9:16": [rect("plate", [60, 1300, 960, 100], { fill: "@primary" })],
  },
});
const input = (over: Partial<GfxRenderInput> = {}): GfxRenderInput => ({ template: strap, values: {}, look, images: {}, seed: 1, fps: 25, ...over });

test("phases: the in and out phases shrink on short clips; layer steps sit inside them", () => {
  assert.deepEqual(phasesOf(strap, 6), { inLen: 0.6, outStart: 5.6, k: 1 });
  const short = phasesOf(strap, 0.5);
  assert.ok(Math.abs(short.k - 0.5) < 1e-9 && Math.abs(short.inLen - 0.3) < 1e-9 && Math.abs(short.outStart - 0.3) < 1e-9);
  const lt = layerTiming(strap, strap.designs["16:9"]!.layers[1], 6);
  assert.equal(lt.in!.start, 0.2);
  assert.equal(lt.in!.dur, 0.4);
  assert.ok(Math.abs(lt.shownAt - 0.6) < 1e-9);
  assert.equal(lt.out!.start, 5.6);
  assert.equal(stepProgress(lt.in, 0.4), 0.5);
  assert.equal(stepProgress(lt.in, 0), 0);
  assert.equal(stepProgress(lt.in, 9), 1);
});

test("eases follow the look's motion; out steps accelerate", () => {
  const sharp = easeFn("look", "sharp"), smooth = easeFn(undefined, "smooth"), bouncy = easeFn("look", "bouncy");
  for (const f of [sharp, smooth, bouncy]) { assert.ok(Math.abs(f(0)) < 1e-9); assert.ok(Math.abs(f(1) - 1) < 1e-9); }
  assert.ok(smooth(0.3) > sharp(0.3));
  assert.ok(Math.max(...Array.from({ length: 50 }, (_, i) => bouncy(i / 49))) > 1.02, "bouncy overshoots");
  assert.ok(easeFn("look", "sharp", true)(0.3) < 0.1, "leaving starts slowly");
  assert.equal(easeFn("linear", "bouncy")(0.25), 0.25);
});

test("poses: slide, wipe, grow, pop, fade, flip, blur and sweep", () => {
  const box: Box = [100, 100, 400, 80];
  const s = poseOf({ kind: "slide", dir: "right" }, 0.5, box, false);
  assert.equal(s.dx, -200);  // comes from the left, travelling right
  assert.equal(poseOf({ kind: "slide", dir: "right" }, 0.5, box, true).dx, 200);  // leaves to the right
  assert.equal(poseOf({ kind: "slide", dir: "up", distance: 50 }, 0, box, false).dy, 50);
  assert.deepEqual(poseOf({ kind: "wipe", dir: "right" }, 0.25, box, false).reveal, [0, 0, 0.25, 1]);
  assert.deepEqual(poseOf({ kind: "wipe", dir: "left" }, 0.25, box, false).reveal, [0.75, 0, 1, 1]);
  assert.deepEqual(poseOf({ kind: "wipe", dir: "right" }, 0.25, box, true).reveal, [0.75, 0, 1, 1]);
  assert.deepEqual(poseOf({ kind: "grow" }, 0.5, box, false).size, { w: 0.5, h: 1, ax: 0, ay: 0.5 });
  assert.deepEqual(poseOf({ kind: "grow", dir: "left" }, 0.5, box, true).size, { w: 0.5, h: 1, ax: 0, ay: 0.5 });
  assert.equal(poseOf({ kind: "fade" }, 0.3, box, false).alpha, 0.3);
  assert.equal(poseOf({ kind: "pop" }, 1, box, false).sx, 1);
  assert.ok(poseOf({ kind: "pop" }, 0, box, false).sx < 0.6);
  assert.ok(poseOf({ kind: "flip", dir: "up" }, 0.5, box, false).sy < 1);
  assert.equal(poseOf({ kind: "blur" }, 0, box, false).blur, 24);
  assert.equal(poseOf({ kind: "sweep" }, 0.4, box, false).sweep, 0.4);
  assert.equal(poseOf({ kind: "rise" }, 0, box, false).dy, 40);
  assert.equal(poseOf({ kind: "drop" }, 0, box, false).dy, -40);
});

test("staggered parts start frame-snapped; typewriter parts appear whole; Indic never splits letters", () => {
  const st = { kind: "stagger", by: "word" as const, stagger: 0.1 };
  assert.equal(partProgress(st, 0, 0.6, 0, 3, 25), 0);
  assert.ok(partProgress(st, 0.1, 0.6, 1, 3, 25) === 0 && partProgress(st, 0.14, 0.6, 1, 3, 25) > 0);
  assert.equal(partProgress(st, 2, 0.6, 2, 3, 25), 1);
  const tw = { kind: "typewriter" };
  assert.deepEqual([0, 1, 2, 3].map((i) => partProgress(tw, 0.55, 1, i, 4, 25)), [1, 1, 1, 0]);
  assert.deepEqual(charParts("Hi!"), ["H", "i", "!"]);
  assert.deepEqual(charParts("मुंबई में बारिश"), ["मुंबई ", "में ", "बारिश"]);
  assert.deepEqual(wordParts("Breaking  news now"), ["Breaking  ", "news ", "now"]);
});

test("loops: blink snaps to frames, shine rests between sweeps, pulse and float move", () => {
  assert.equal(loopPose({ kind: "blink", period: 1 }, 0.2, 25).alpha, 1);
  assert.ok(loopPose({ kind: "blink", period: 1 }, 0.7, 25).alpha < 0.5);
  assert.ok(loopPose({ kind: "pulse", period: 2 }, 1, 25).sx > 1);
  assert.ok(Math.abs(loopPose({ kind: "float", period: 4 }, 1, 25).dy - 6) < 1e-9);
  assert.ok(Math.abs(loopPose({ kind: "shine", period: 8 }, 0.36, 25).sweep! - 0.4) < 1e-9);
  assert.equal(loopPose({ kind: "shine", period: 8 }, 3, 25).sweep, null);
  assert.equal(loopMoving({ kind: "shine", period: 8 }, 3, 25), false);
  assert.equal(loopMoving({ kind: "shine", period: 8 }, 8.2, 25), true);
  assert.equal(loopMoving({ kind: "blink", period: 1, delay: 2 }, 1, 25), false);
});

test("text fits: shrink to 60 %, wrap to max lines, then an ellipsis", () => {
  const o = { size: 50, lineHeight: 1.2, maxLines: 1, fit: "shrink" as const, minScale: 0.6 };
  assert.deepEqual(fitText("Short", 400, 60, o, mono).lines, ["Short"]);
  const shrunk = fitText("A name that is long", 400, 60, o, mono);  // 19 chars × 25 = 475 → 400
  assert.ok(shrunk.size < 50 && shrunk.size >= 30 && !shrunk.ellipsized);
  const cut = fitText("A name that is far far far too long for it", 400, 60, o, mono);
  assert.equal(cut.size, 30);
  assert.ok(cut.ellipsized && cut.lines[0].endsWith("…"));
  assert.ok(mono(30)(cut.lines[0]) <= 400);
  const two = fitText("Heavy rain shuts schools in Mumbai", 500, 130, { ...o, maxLines: 2 }, mono);
  assert.equal(two.size, 50);
  assert.equal(two.lines.length, 2);
  assert.deepEqual(wrapText("a b\nc", 1000, mono(10)), ["a b", "c"]);
  assert.equal(ellipsize("abcdefghij", 45, mono(10)), "abcdefgh…");
  assert.equal(ellipsize("abcdefghij", 50, mono(10)), "abcdefghij");
  assert.deepEqual(fitText("x y", 1, 10, { ...o, fit: "none" }, mono).lines, ["x y"]);
});

test("designs: ratio of a frame, automatic designs by pins keep groups together", () => {
  assert.equal(ratioOf(1920, 1080), "16:9");
  assert.equal(ratioOf(1080, 1920), "9:16");
  assert.equal(ratioOf(1080, 1350), "4:5");
  assert.equal(ratioOf(1080, 1080), "1:1");
  assert.deepEqual(guessPin([120, 820, 760, 86], 1920, 1080), { x: "left", y: "bottom" });
  assert.deepEqual(guessPin([0, 980, 1920, 100], 1920, 1080), { x: "stretch", y: "bottom" });
  const L = strap.designs["16:9"]!.layers;
  const moved = relayout(L, 1920, 1080, 1440, 1440);
  // the strap's plate and texts move together, kept to the bottom-left
  assert.equal(moved[0].box[0], 120);
  assert.equal(moved[0].box[1], 820 + 360);
  assert.equal(moved[1].box[1] - moved[0].box[1], 0);
  assert.equal(moved[2].box[1] - moved[0].box[1], 86);
  // a full-width bar stretches
  const bar = relayout([rect("bar", [0, 980, 1920, 100])], 1920, 1080, 1440, 1440)[0];
  assert.deepEqual(bar.box, [0, 1340, 1440, 100]);
  // 1:1 is made from 16:9 in its own (larger) space, 9:16 is the template's own
  const sq = designSpace(strap, 1080, 1080);
  assert.equal(sq.auto, true);
  assert.equal(Math.round(sq.w), 1440);
  assert.equal(designSpace(strap, 1080, 1920).layers.length, 1);
  // Make vertical: a design in the target's own space with sizes scaled
  const d = designFor({ ...strap, designs: { "16:9": strap.designs["16:9"] } }, "9:16");
  assert.equal(d.layers.length, 3);
  assert.ok((d.layers[1].p.size as number) < 52);
});

test("layers: when, overrides, collision lift above a ticker", () => {
  assert.equal(shownBy("{role}", { role: "" }), false);
  assert.equal(shownBy("!{role}", { role: "" }), true);
  assert.equal(shownBy("{photo}", { photo: { mediaId: "m1" } }), true);
  const ov = applyOverrides(strap.designs["16:9"]!.layers, { plate: { p: { fill: "#00ff00" } } });
  assert.equal(ov[0].p.fill, "#00ff00");
  const L = strap.designs["16:9"]!.layers;
  const cb = contentBox(L, 1920, 1080)!;
  assert.ok(Math.abs(cb[1] - 820 / 1080) < 1e-9);
  assert.equal(liftFor("strap", L, 1920, 1080, [{ role: "ticker", box: [0, 0.9, 1, 0.1] }]), 0);
  const lift = liftFor("strap", L, 1920, 1080, [{ role: "ticker", box: [0, 0.82, 1, 0.1] }]);
  assert.ok(Math.abs(lift - (946 - (0.82 * 1080 - 14))) < 1e-6);
  assert.equal(liftFor("ticker", L, 1920, 1080, [{ role: "ticker", box: [0, 0.82, 1, 0.1] }]), 0);
  // the plan hides the empty role line and applies the lift
  const plan = planOf(input({ avoid: [{ role: "ticker", box: [0, 0.82, 1, 0.1] }] }), 1920, 1080, 6);
  assert.deepEqual(plan.layers.map((x) => x.layer.id), ["plate", "name"]);
  assert.ok(plan.lift > 0);
});

test("text tokens: fields in their format, the air-time clock", () => {
  const f = new Map(strap.fields.map((x) => [x.id, x]));
  const clock = Date.UTC(2026, 0, 1, 13, 30);
  assert.equal(fillText("{name} · {n} · {$time} · {missing}", { name: "Priya", n: 1234567 }, f, look, clock), "Priya · 12.35 lakh · 19:00 · {missing}");
  assert.equal(fillText("{$date}", {}, f, look, clock), "1 Jan 2026");
});

test("layer state: in, shown, out, gone; part-animated text keeps still and gets its step", () => {
  const plan = planOf(input(), 1920, 1080, 6);
  const plate = plan.layers[0], name = plan.layers[1];
  const at = (t: number) => layerState(plate, plate.layer.box, t, look, 25);
  assert.ok(at(0.2)!.pose.size!.w > 0 && at(0.2)!.pose.size!.w < 1);
  assert.equal(at(0.2)!.box[2] < 760, true);  // a plate grows by resizing
  assert.equal(at(3)!.pose.size!.w >= 0.999, true);
  assert.deepEqual(at(3)!.rect, [120, 820, 760, 86]);
  assert.ok(at(5.75)!.pose.reveal![2] < 1);  // wiping out to the left
  assert.equal(at(6), null);
  const ns = layerState(name, name.layer.box, 0.3, look, 25)!;
  assert.equal(ns.pose.dx, 0);
  assert.ok(Math.abs(ns.parts!.in!.local - 0.1) < 1e-9);
});

test("frame keys: static between animations, the frame while moving, repeatable", () => {
  const inp = input();
  const k = (t: number) => graphicFrameKey(inp, 1920, 1080, t, 6);
  assert.equal(k(2), k(4.5), "held still: one picture");
  assert.notEqual(k(0.2), k(0.24), "coming in: every frame");
  assert.notEqual(k(2), k(5.7));
  assert.equal(k(0.2), graphicFrameKey(input(), 1920, 1080, 0.2, 6), "the same input draws the same");
  assert.notEqual(k(2), graphicFrameKey(inp, 960, 540, 2, 6));
  // a looping layer moves while shown
  const bug = tpl({ id: "t.bug", name: "Bug", category: "Bugs", role: "bug", seconds: 0, loop: true, fields: [],
    designs: { "16:9": [rect("dot", [10, 10, 20, 20], {}, { anim: anim(undefined, undefined, { kind: "blink", period: 1 }) })] } });
  const bi = input({ template: bug });
  assert.notEqual(graphicFrameKey(bi, 1920, 1080, 3, 10), graphicFrameKey(bi, 1920, 1080, 3.6, 10));
  // a clock changes its key by the minute only
  const clk = tpl({ id: "t.clock", name: "Clock", category: "Bugs", role: "bug", seconds: 0, fields: [], designs: { "16:9": [text("c", [0, 0, 200, 50], "{$time}")] } });
  const ci = input({ template: clk, clockAt: Date.UTC(2026, 0, 1, 13, 30) });
  assert.equal(graphicFrameKey(ci, 1920, 1080, 10, 600), graphicFrameKey(ci, 1920, 1080, 50, 600));
  assert.notEqual(graphicFrameKey(ci, 1920, 1080, 10, 600), graphicFrameKey(ci, 1920, 1080, 70, 600));
  assert.equal(hash01(3, 7), hash01(3, 7));
  assert.ok(hash01(3, 7) >= 0 && hash01(3, 7) < 1 && hash01(3, 7) !== hash01(3, 8));
});
