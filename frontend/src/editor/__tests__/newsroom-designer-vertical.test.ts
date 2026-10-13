/**
 * "Make vertical" (newsroom/designer/makeVertical.ts, docs/EDITOR.md §16.8): a 16:9 strap, bug, ticker and background
 * become a 9:16 design inside its safe area (clear of the top 12 %, bottom 22 % and right 16 %), groups stay together,
 * sizes grow about 1.15×, explicit pins win, rebuilding keeps vertical-only layers. Deterministic.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { inferPin, makeVertical, withVertical } from "../newsroom/designer/makeVertical.ts";
import { insideSafe, safeBox } from "../newsroom/designer/geometry.ts";
import type { GfxLayer, GfxTemplate } from "../newsroom/types.ts";

const L = (id: string, kind: string, box: [number, number, number, number], p: Record<string, unknown> = {}, extra: Partial<GfxLayer> = {}): GfxLayer =>
  ({ id, name: id, kind, box, p, ...extra });

const strap: GfxTemplate = {
  id: "my.test-strap", name: "Strap", category: "Straps", role: "strap", seconds: 6, timing: { in: 0.6, out: 0.4 },
  fields: [{ id: "name", label: "Name", type: "text", default: "Priya Rao" }],
  designs: {
    "16:9": {
      layers: [
        L("bg", "bg", [0, 0, 1920, 1080]),
        L("plate", "rect", [120, 820, 760, 110], { fill: "@primary", radius: 6 }),
        L("stripe", "rect", [860, 820, 20, 110], { fill: "@accent" }),
        L("name", "text", [150, 830, 700, 60], { text: "{name}", size: 52, grow: { layers: ["plate"], pad: 30, max: 1400 } }, { shadow: { color: "#0008", blur: 10, x: 0, y: 4 } }),
        L("bug", "logo", [1640, 70, 180, 90]),
        L("ticker", "ticker", [0, 960, 1920, 64], { size: 40 }),
      ],
    },
  },
  version: 1,
};

test("pins are guessed from where a layer sits", () => {
  assert.deepEqual(inferPin([120, 820, 760, 110], 1920, 1080), { x: "left", y: "bottom" });
  assert.deepEqual(inferPin([1640, 70, 180, 90], 1920, 1080), { x: "right", y: "top" });
  assert.deepEqual(inferPin([0, 960, 1920, 64], 1920, 1080), { x: "stretch", y: "bottom" });
  assert.deepEqual(inferPin([660, 440, 600, 200], 1920, 1080), { x: "center", y: "center" });
});

test("a strap, bug and ticker land inside the 9:16 safe area; the background fills the frame", () => {
  const v = makeVertical(strap);
  const by = (id: string) => v.layers.find((l) => l.id === id)!;
  const S = safeBox("9:16");
  assert.deepEqual(S.map(Math.round), [54, 230, 853, 1267]);
  assert.deepEqual(by("bg").box, [0, 0, 1080, 1920]);
  for (const id of ["plate", "stripe", "name", "bug"]) assert.ok(insideSafe(by(id).box, "9:16"), `${id} ${by(id).box} inside the safe area`);
  const t = by("ticker").box;
  assert.equal(t[0], 0); assert.equal(t[2], 1080, "ticker spans the width");
  assert.ok(t[1] + t[3] <= 1920 * 0.78 + 1, "ticker clear of the bottom 22 %");
  const bug = by("bug").box;
  assert.ok(bug[0] + bug[2] > 700 && bug[1] < 400, "bug stays top right");
  assert.deepEqual(v.layers.map((l) => l.id), strap.designs["16:9"]!.layers.map((l) => l.id), "same ids, same order");
});

test("groups stay together and sizes grow ~1.15×", () => {
  const v = makeVertical(strap);
  const by = (id: string) => v.layers.find((l) => l.id === id)!;
  const plate = by("plate").box, name = by("name").box, stripe = by("stripe").box;
  assert.ok(name[0] > plate[0] && name[0] + name[2] <= plate[0] + plate[2] + 1, "the name stays on its plate");
  assert.ok(name[1] >= plate[1] && name[1] + name[3] <= plate[1] + plate[3] + 1);
  assert.ok(Math.abs(stripe[0] + stripe[2] - (plate[0] + plate[2])) <= 2, "the stripe stays at the plate's end");
  assert.ok(Math.abs(plate[3] - 110 * 1.15) <= 2, `plate height ${plate[3]}`);
  const size = by("name").p.size as number;
  assert.ok(size > 52 && size <= 52 * 1.15 + 0.01, `text size ${size}`);
  assert.ok((by("name").p.grow as { max: number }).max <= safeBox("9:16")[2], "grow limit fits the frame");
  assert.equal(by("name").shadow!.blur, 11.5);
  assert.equal(by("plate").p.radius, 6.9);
});

test("explicit pins win over guesses; deterministic", () => {
  const t: GfxTemplate = JSON.parse(JSON.stringify(strap));
  t.designs["16:9"]!.layers.push(L("tag", "text", [1500, 820, 300, 60], { size: 30 }, { pin: { x: "left", y: "top" } }));
  const a = makeVertical(t), b = makeVertical(t);
  assert.deepEqual(a, b);
  const tag = a.layers.find((l) => l.id === "tag")!.box;
  assert.ok(Math.abs(tag[1] - (230.4 + (820 - 54) * 1.15)) <= 2, `keeps its scaled distance from the top safe edge (${tag[1]})`);
  assert.ok(insideSafe(tag, "9:16"), "too far right for the frame: slid back inside");
  const guessed = makeVertical(strap).layers.find((l) => l.id === "name")!.box;
  assert.ok(guessed[1] + guessed[3] <= 1920 * 0.78 + 1, "the guessed bottom pin keeps clear of the bottom 22 %");
});

test("rebuild keeps vertical-only layers and what hidden said there", () => {
  const first = withVertical(strap);
  first.designs["9:16"]!.layers.push(L("swipe", "text", [100, 300, 500, 80], { text: "Swipe up" }));
  first.designs["9:16"]!.layers.find((l) => l.id === "stripe")!.hidden = true;
  first.designs["16:9"]!.layers.find((l) => l.id === "plate")!.box = [100, 800, 700, 110];
  const again = withVertical(first);
  const ids = again.designs["9:16"]!.layers.map((l) => l.id);
  assert.ok(ids.includes("swipe"));
  assert.equal(again.designs["9:16"]!.layers.find((l) => l.id === "stripe")!.hidden, true);
  assert.notDeepEqual(again.designs["9:16"]!.layers.find((l) => l.id === "plate")!.box, first.designs["9:16"]!.layers.find((l) => l.id === "plate")!.box, "follows the new 16:9");
  assert.ok(again.designs["16:9"], "16:9 untouched");
});

test("custom size keys", () => {
  const v = makeVertical(strap, { sizeKeys: (k) => (k === "ticker" ? ["size"] : []) });
  assert.equal(v.layers.find((l) => l.id === "plate")!.p.radius, 6, "not a size key here");
  assert.ok((v.layers.find((l) => l.id === "ticker")!.p.size as number) > 40);
});
