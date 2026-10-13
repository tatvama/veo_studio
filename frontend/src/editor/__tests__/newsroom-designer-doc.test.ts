/**
 * The Template Designer's document edits and geometry (newsroom/designer/doc.ts, geometry.ts, docs/EDITOR.md §16.8):
 * layers in every design, proportional sizes in both ratios, field renames carried into {tokens}, "Change only this
 * one" overrides (shared vs per ratio), the Designer's undo, safe areas, snapping, resizing and hit tests.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addField, addLayer, duplicateLayer, fieldIdFrom, fieldUses, history, layerIds, moveField, moveLayer, overridesBetween, removeField, removeLayer,
  setBox, setCommon, setProp, updateField, withOverrides,
} from "../newsroom/designer/doc.ts";
import { guidesFor, hitLayer, insideSafe, nudge, resizeBox, safeBox, snapMove, snapResize } from "../newsroom/designer/geometry.ts";
import type { GfxTemplate } from "../newsroom/types.ts";

const base = (): GfxTemplate => ({
  id: "nr.straps.test", name: "Test", category: "Straps", role: "strap", seconds: 6, timing: { in: 0.6, out: 0.4 },
  fields: [{ id: "name", label: "Name", type: "text", default: "Priya Rao" }, { id: "role", label: "Role", type: "text", default: "Anchor" }],
  designs: {
    "16:9": { layers: [
      { id: "plate", name: "Plate", kind: "rect", box: [120, 820, 760, 110], p: { fill: "@primary" } },
      { id: "name", name: "Name", kind: "text", box: [150, 830, 700, 60], p: { text: "{name} · {role}", size: 52 }, when: "{role}" },
    ] },
    "9:16": { layers: [
      { id: "plate", name: "Plate", kind: "rect", box: [80, 1300, 800, 126], p: { fill: "@primary" } },
      { id: "name", name: "Name", kind: "text", box: [110, 1310, 740, 70], p: { text: "{name} · {role}", size: 60 }, when: "{role}" },
    ] },
  },
  version: 1,
});

test("layers are added, duplicated, moved and removed in every design", () => {
  const t0 = base();
  const { t: t1, id } = addLayer(t0, "rect", { fill: "@accent" }, { above: "plate", name: "Stripe" });
  assert.equal(id, "rect_1");
  for (const r of ["16:9", "9:16"] as const) {
    assert.deepEqual(t1.designs[r]!.layers.map((l) => l.id), ["plate", "rect_1", "name"]);
    assert.ok(insideSafe(t1.designs[r]!.layers[1].box, r), `${r} new layer inside the safe area`);
  }
  assert.equal(t0.designs["16:9"]!.layers.length, 2, "input untouched");
  const { t: t2, id: dup } = duplicateLayer(t1, "name");
  assert.equal(dup, "name_1");
  assert.equal(t2.designs["9:16"]!.layers[3].name, "Name copy");
  const t3 = moveLayer(t2, "16:9", "name_1", 0);
  assert.deepEqual(t3.designs["16:9"]!.layers.map((l) => l.id), ["name_1", "plate", "rect_1", "name"]);
  assert.deepEqual(t3.designs["9:16"]!.layers.map((l) => l.id), ["name_1", "plate", "rect_1", "name"]);
  const t4 = moveLayer(t3, "9:16", "plate", 3);
  assert.deepEqual(t4.designs["16:9"]!.layers.map((l) => l.id), ["name_1", "rect_1", "name", "plate"]);
  const t5 = removeLayer(setCommon(t4, "all", "name", "clip", "plate"), "plate");
  assert.deepEqual(layerIds(t5), ["name_1", "rect_1", "name"]);
  assert.equal(t5.designs["16:9"]!.layers.find((l) => l.id === "name")!.clip, undefined, "clip to a removed layer dropped");
});

test("properties: this ratio or both, numbers in proportion", () => {
  const t = setProp(base(), "16:9", "all", "name", "size", 104, true);
  assert.equal(t.designs["16:9"]!.layers[1].p.size, 104);
  assert.equal(t.designs["9:16"]!.layers[1].p.size, 120, "doubled in 9:16 too");
  const r1 = setProp(base(), "16:9", "all", "plate", "radius", -1, true);
  assert.equal(r1.designs["9:16"]!.layers[0].p.radius, -1, "follow-the-look values are copied, not scaled");
  const r2 = setProp(r1, "16:9", "all", "plate", "radius", 12, true);
  assert.equal(r2.designs["9:16"]!.layers[0].p.radius, 12, "from a sentinel to a size: copied");
  assert.equal(setProp(base(), "16:9", "all", "plate", "cx", null).designs["9:16"]!.layers[0].p.cx, null, "null = automatic");
  const c = setProp(base(), "16:9", "all", "plate", "fill", "#112233");
  assert.equal(c.designs["9:16"]!.layers[0].p.fill, "#112233");
  const one = setProp(base(), "9:16", "this", "plate", "fill", "@secondary");
  assert.equal(one.designs["16:9"]!.layers[0].p.fill, "@primary");
  const b = setBox(base(), "16:9", "plate", [100, 800, 700, 100]);
  assert.deepEqual(b.designs["9:16"]!.layers[0].box, [80, 1300, 800, 126], "boxes belong to one design");
});

test("fields: ids from labels, renames follow {tokens} and when, uses, order, removal", () => {
  const t0 = base();
  assert.equal(fieldIdFrom(t0, "Reporter name"), "reporter_name");
  assert.equal(fieldIdFrom(t0, "Name"), "name_2");
  assert.equal(fieldIdFrom(t0, "2nd line"), "_2nd_line");
  const { t: t1, id } = addField(t0, "choice", "Tone");
  assert.equal(id, "tone");
  assert.equal(t1.fields[2].default, "one");
  assert.equal(fieldUses(t1, "role"), 1);
  const t2 = updateField(t1, "role", { id: "title", label: "Title" });
  const nm = t2.designs["9:16"]!.layers[1];
  assert.equal(nm.p.text, "{name} · {title}");
  assert.equal(nm.when, "{title}");
  assert.equal(t2.fields[1].label, "Title");
  assert.equal(updateField(t2, "title", { id: "name" }), t2, "a clash is refused");
  assert.equal(updateField(t2, "title", { id: "bad id" }), t2, "a bad id is refused");
  const t3 = updateField(t2, "title", { type: "number" });
  assert.equal(t3.fields[1].default, 0, "a new type gets its default");
  assert.deepEqual(moveField(t3, 2, 0).fields.map((f) => f.id), ["tone", "name", "title"]);
  assert.deepEqual(removeField(t3, "tone").fields.map((f) => f.id), ["name", "title"]);
});

test("change only this one: shared changes by id, per-ratio ones by id@ratio; applied back exactly", () => {
  const b = base();
  let e = setProp(b, "16:9", "all", "plate", "fill", "#FF0000");
  e = setProp(e, "16:9", "all", "name", "size", 78, true); // 1.5× in both: different numbers
  e = setBox(e, "9:16", "plate", [60, 1280, 840, 130]);
  e = setCommon(e, "all", "name", "opacity", 0.8);
  const ov = overridesBetween(b, e);
  assert.deepEqual(ov.plate, { p: { fill: "#FF0000" } });
  assert.deepEqual(ov["plate@9:16"], { box: [60, 1280, 840, 130] });
  assert.deepEqual(ov.name, { opacity: 0.8 });
  assert.deepEqual(ov["name@16:9"], { p: { size: 78 } });
  assert.deepEqual(ov["name@9:16"], { p: { size: 90 } });
  assert.deepEqual(withOverrides(b, ov), e);
  assert.deepEqual(overridesBetween(b, b), {});
  const hidden = setCommon(setCommon(b, "9:16", "plate", "hidden", true), "all", "name", "when", undefined);
  const ov2 = overridesBetween(b, hidden);
  assert.deepEqual(ov2, { "plate@9:16": { hidden: true }, name: { when: "" } });
  assert.deepEqual(overridesBetween(hidden, b), { "plate@9:16": { hidden: false }, name: { when: "{role}" } });
});

test("the Designer's undo: steps, coalescing drags, redo cleared by a new change", () => {
  let h = history.init(1);
  h = history.push(h, 2, undefined, 0);
  h = history.push(h, 3, "drag", 100);
  h = history.push(h, 4, "drag", 400);
  h = history.push(h, 5, "drag", 2000);
  assert.deepEqual(h.past, [1, 2, 4]);
  h = history.undo(history.undo(h));
  assert.equal(h.present, 2);
  h = history.redo(h);
  assert.equal(h.present, 4);
  h = history.push(h, 9, undefined, 3000);
  assert.deepEqual(h.future, []);
  assert.equal(history.undo(history.init(0)).present, 0);
});

test("safe areas, snapping, resizing, nudges and hits", () => {
  assert.deepEqual(safeBox("16:9"), [96, 54, 1728, 972]);
  assert.deepEqual(safeBox("9:16").map((v) => Math.round(v * 10) / 10), [54, 230.4, 853.2, 1267.2]);
  assert.deepEqual(safeBox("16:9", { safe: [10, 20, 30, 40] }), [40, 10, 1860, 1040]);
  const d = base().designs["16:9"]!;
  const g = guidesFor("16:9", d, new Set(["name"]));
  assert.ok(g.x.includes(96) && g.x.includes(960) && g.x.includes(120) && g.x.includes(880));
  const s = snapMove([99, 500, 200, 50], g, 6);
  assert.deepEqual(s.box, [96, 500, 200, 50]); assert.equal(s.lines.x, 96);
  const c = snapMove([858, 300, 200, 50], g, 6);
  assert.equal(c.box[0], 860, "centre to the frame centre"); assert.equal(c.lines.x, 960);
  assert.deepEqual(snapMove([410, 300, 200, 50], g, 6).lines, { x: undefined, y: undefined });
  assert.equal(snapMove([398, 300, 200, 50], g, 6).lines.x, 500, "centre to another layer's centre");
  assert.deepEqual(resizeBox([100, 100, 200, 100], "se", 20, 10), [100, 100, 220, 110]);
  assert.deepEqual(resizeBox([100, 100, 200, 100], "nw", 20, 10), [120, 110, 180, 90]);
  assert.deepEqual(resizeBox([100, 100, 200, 100], "se", 40, 0, { keepAspect: true }), [100, 100, 240, 120]);
  assert.deepEqual(resizeBox([100, 100, 200, 100], "e", 10, 0, { fromCenter: true }), [90, 100, 220, 100]);
  assert.deepEqual(resizeBox([100, 100, 200, 100], "w", 500, 0), [296, 100, 4, 100], "never below the minimum");
  assert.deepEqual(snapResize([100, 100, 1823, 100], "e", g, 6).box, [100, 100, 1820, 100], "right edge to the frame edge");
  assert.deepEqual(snapResize([98, 100, 300, 100], "w", g, 6).box, [96, 100, 302, 100], "left edge to the safe area");
  assert.deepEqual(nudge([10, 10, 5, 5], "ArrowLeft", true), [0, 10, 5, 5]);
  assert.equal(nudge([10, 10, 5, 5], "a", false), null);
  assert.equal(hitLayer(d.layers, 200, 850)!.id, "name", "topmost first");
  assert.equal(hitLayer(d.layers, 860, 920)!.id, "plate");
  assert.equal(hitLayer([{ ...d.layers[1], locked: true }], 200, 850), undefined, "locked layers aren't picked");
  assert.equal(hitLayer([{ ...d.layers[0], rotation: 90 }], 125, 875), undefined, "rotated box");
});
