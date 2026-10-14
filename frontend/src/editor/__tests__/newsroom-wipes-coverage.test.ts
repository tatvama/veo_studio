import assert from "node:assert/strict";
import { test } from "node:test";
import { STINGERS } from "../newsroom/templates/stingers.ts";
import { checkSpec, checkStinger, designShapes, stingerTemplate } from "../newsroom/wipes/designer.ts";
import {
  coverageOf, easeIn, easeOut, edgeProfile, MIN_HOLD, motionOf, panelShapes, PANEL_EASES, PANEL_EDGES, PANEL_EXITS, PANEL_LAYOUTS,
  ranks, stingerClock, travelAt,
} from "../newsroom/wipes/geometry.ts";

const FRAMES: [number, number][] = [[1920, 1080], [1080, 1920]];

test("every shape, edge, ease and exit covers the whole frame through the hold, in both ratios", () => {
  const eases = PANEL_EASES.filter((e) => e.value !== "sharp");  // sharp is expo's shape without the overshoot
  for (const L of PANEL_LAYOUTS) for (const E of PANEL_EDGES) for (const ease of eases) for (const exit of PANEL_EXITS) {
    for (const [W, H] of FRAMES) {
      const angle = (L.value.length * 37 + E.value.length * 11) % 360 - 180;
      const m = motionOf({ layout: L.value, edge: E.value, ease: ease.value, exit: exit.value, angle, count: 4, depth: 0.7, overshoot: 0.9, seed: 3 });
      const ck = stingerClock(m, 1.2);
      for (const t of [ck.inEnd, (ck.inEnd + ck.outStart) / 2, ck.outStart]) {
        const c = coverageOf(panelShapes(m, W, H, 1.2, t), W, H, 24);
        assert.equal(c.covered, 1, `${L.value}/${E.value}/${ease.value}/${exit.value} ${W}x${H} @${t.toFixed(3)}: ${c.where.join(", ")}`);
      }
    }
  }
});

test("before it starts and after it ends nothing is drawn; in between the picture shows through", () => {
  for (const L of PANEL_LAYOUTS) {
    const m = motionOf({ layout: L.value, edge: "slant", count: 3 });
    assert.ok(coverageOf(panelShapes(m, 1920, 1080, 1.2, 0), 1920, 1080, 40).covered < 1e-3, `${L.value} at the start`);
    assert.ok(coverageOf(panelShapes(m, 1920, 1080, 1.2, 1.2), 1920, 1080, 40).covered < 1e-3, `${L.value} at the end`);
    const mid = coverageOf(panelShapes(m, 1920, 1080, 1.2, 0.12), 1920, 1080, 40).covered;
    assert.ok(mid > 0 && mid < 1, `${L.value} part way in: ${mid}`);
  }
});

test("the hold is centred on the cut, at least MIN_HOLD long, and every panel is exactly in place there", () => {
  const m = motionOf({ layout: "bars", count: 6, stagger: 0.2, cut: 0.4, hold: 0.01, ease: "back", overshoot: 1 });
  const ck = stingerClock(m, 1.5);
  assert.ok(Math.abs((ck.inEnd + ck.outStart) / 2 - 0.6) < 1e-9);
  assert.ok(ck.outStart - ck.inEnd >= MIN_HOLD - 1e-9);
  const ein = easeIn(m.ease, m.overshoot), eout = easeOut(m.ease);
  for (const r of ranks(6, "random", 4)) {
    assert.equal(travelAt(ck, r, r, ck.inEnd, ein, eout), 1);
    assert.equal(travelAt(ck, r, r, ck.outStart, ein, eout), 1);
  }
  for (const e of PANEL_EASES) { assert.equal(easeIn(e.value, 0.8)(0), 0); assert.equal(easeIn(e.value, 0.8)(1), 1); assert.equal(easeOut(e.value)(1), 1); }
});

test("edge profiles are seeded (same seed, same edge) and circles' edges close up", () => {
  assert.deepEqual(edgeProfile("torn", 1080, 0.6, 7, 1), edgeProfile("torn", 1080, 0.6, 7, 1));
  assert.notDeepEqual(edgeProfile("torn", 1080, 0.6, 7, 1), edgeProfile("torn", 1080, 0.6, 8, 1));
  for (const e of PANEL_EDGES) { const p = edgeProfile(e.value, 3000, 0.8, 3, 1, true); assert.equal(p[0], p[p.length - 1], e.value); }
});

test("all 30 built-in stingers pass the coverage check in 16:9 and 9:16", () => {
  assert.equal(STINGERS.length, 30);
  for (const t of STINGERS) {
    const c = checkStinger(t, 8);
    assert.ok(c.ok, `${t.id}: ${c.reasons.join(" ")}`);
    assert.deepEqual(c.ratios.map((r) => r.ratio), ["16:9", "9:16"]);
  }
});

test("the check refuses a wipe that leaves part of the frame open, and says where", () => {
  const t = stingerTemplate({ layout: "stack", count: 2 }, { id: "my.half", name: "Half" });
  // shrink the 9:16 panels to the left half of the frame
  const l = t.designs["9:16"]!.layers[0];
  l.box = [0, 0, 540, 1920];
  const c = checkStinger(t);
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(" "), /9:16 frame isn't fully covered: 50 % shows through at the .*right/);
  assert.equal(c.ratios.find((r) => r.ratio === "16:9")!.covered, 1);
  // no cut point / no panels
  assert.equal(checkStinger({ ...t, cut: undefined }).ok, false);
  const bare = stingerTemplate({}, { id: "my.bare", name: "Bare" });
  bare.designs["16:9"] = { layers: [] };
  assert.match(checkStinger(bare).reasons.join(" "), /16:9 design has no panels/);
  // a cut that moved off the panels' hold is caught too
  const off = stingerTemplate({ cut: 0.5, hold: 0.15 }, { id: "my.off", name: "Off" });
  assert.equal(checkStinger({ ...off, cut: 0.2 }).ok, false);
});

test("design shapes sit where the layer's box is", () => {
  const t = stingerTemplate({ layout: "stack", count: 1, edge: "straight" }, { id: "x", name: "X" });
  t.designs["16:9"]!.layers[0].box = [100, 50, 800, 400];
  const s = designShapes(t, "16:9", t.cut! * t.seconds);
  const xs = s.flatMap((x) => x.pts.map((p) => p[0])), ys = s.flatMap((x) => x.pts.map((p) => p[1]));
  assert.ok(Math.min(...xs) < 100 && Math.max(...xs) > 900 && Math.min(...ys) <= 50 && Math.max(...ys) >= 450);
  assert.ok(checkSpec({ layout: "tiles", count: 12, edge: "round" }).ok);
});
