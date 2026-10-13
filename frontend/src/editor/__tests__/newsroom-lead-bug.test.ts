/** News Room: the logo bug follows the look's corner, scale and opacity (render/layout.ts placeBug). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeBug } from "../newsroom/render/layout.ts";
import type { GfxLayer } from "../newsroom/types.ts";

const L: GfxLayer = { id: "logo", name: "logo", kind: "logo", box: [1584, 62, 240, 90], p: { align: "right" }, opacity: 0.9 };
const bug = { role: "bug" as const, kind: "logo" };
const look = (corner: "tl" | "tr" | "bl" | "br", scale = 1, opacity = 1) => ({ bug: { corner, scale, opacity } });

test("top right stays as designed", () => {
  assert.deepEqual(placeBug(bug, [L], look("tr"), 1920, 1080), [L]);
});

test("mirrors to the other corners and aligns left on the left", () => {
  const [tl] = placeBug(bug, [L], look("tl"), 1920, 1080);
  assert.deepEqual(tl.box, [96, 62, 240, 90]);
  assert.equal(tl.p.align, "left");
  const [br] = placeBug(bug, [L], look("br"), 1920, 1080);
  assert.deepEqual(br.box, [1584, 928, 240, 90]);
  assert.equal(br.p.align, "right");
});

test("scales about the frame corner and fades by the look's opacity", () => {
  const [tr] = placeBug(bug, [L], look("tr", 0.5, 0.5), 1920, 1080);
  assert.deepEqual(tr.box, [1704, 62, 120, 45]);
  assert.equal(tr.opacity, 0.45);
  const [bl] = placeBug(bug, [L], look("bl", 2), 1920, 1080);
  assert.deepEqual(bl.box, [96, 838, 480, 180]);
});

test("other templates are left alone", () => {
  assert.deepEqual(placeBug({ role: "bug", kind: "live" }, [L], look("bl", 2, 0.5), 1920, 1080), [L]);
  assert.deepEqual(placeBug({ role: "strap", kind: "logo" }, [L], look("bl"), 1920, 1080), [L]);
});
