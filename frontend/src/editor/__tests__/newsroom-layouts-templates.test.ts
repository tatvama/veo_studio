import assert from "node:assert/strict";
import { test } from "node:test";
import "../newsroom/render/kinds/slot.ts";
import { layerKind } from "../newsroom/render/registry.ts";
import { slotProps } from "../newsroom/layouts/geometry.ts";
import { LAYOUTS } from "../newsroom/templates/layouts.ts";
import { DESIGN } from "../newsroom/templates/kit.ts";
import type { GfxLayer, GfxRatio } from "../newsroom/types.ts";

const RATIOS: GfxRatio[] = ["16:9", "9:16"];
const STABLE = [
  "anchor_ots_left", "anchor_ots_right", "two_way", "three_way", "four_way", "six_way", "side_panel", "squeeze_back", "split_vs", "pip", "explainer",
  "video_wall", "speed_news", "v_headline_video", "v_two_way", "v_three_stack", "v_news_card", "v_quote_card", "v_breaking_card", "v_stat_card", "v_story_counter",
].map((x) => `nr.layouts.${x}`);

test("the layout set: stable ids, 13 made for 16:9 and 8 made for vertical, all on the Layout track", () => {
  assert.deepEqual(LAYOUTS.map((t) => t.id), STABLE);
  assert.equal(new Set(LAYOUTS.map((t) => t.id)).size, LAYOUTS.length);
  assert.equal(LAYOUTS.filter((t) => t.id.startsWith("nr.layouts.v_")).length, 8);
  for (const t of LAYOUTS) {
    assert.equal(t.category, "Layouts"); assert.equal(t.role, "layout");
    assert.ok(t.name && t.description && t.sounds?.in, t.id);
  }
});

test("both designs, unique layer ids, the same boxes by id in each, boxes 0..n-1 inside the frame", () => {
  for (const t of LAYOUTS) {
    const byRatio = new Map<GfxRatio, GfxLayer[]>();
    for (const r of RATIOS) {
      const d = t.designs[r];
      assert.ok(d?.layers.length, `${t.id} has a ${r} design`);
      const layers = d!.layers;
      byRatio.set(r, layers);
      const ids = layers.map((l) => l.id);
      assert.equal(new Set(ids).size, ids.length, `${t.id} ${r}: unique layer ids`);
      const slots = layers.filter((l) => l.kind === "slot");
      const idx = slots.map((l) => slotProps(l).index).sort((a, b) => a - b);
      assert.deepEqual(idx, idx.map((_, i) => i), `${t.id} ${r}: boxes 0..n-1`);
      const D = DESIGN[r];
      for (const l of slots) {
        const [x, y, w, h] = l.box;
        assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= D.w + 0.01 && y + h <= D.h + 0.01, `${t.id} ${r} ${l.id} inside the frame: ${l.box}`);
        assert.equal(l.id, `box${slotProps(l).index}`);
      }
      for (const l of layers) assert.ok(layerKind(l.kind) || ["rect", "text", "image", "line", "icon", "logo"].includes(l.kind), `${t.id}: kind ${l.kind}`);
    }
    const a = byRatio.get("16:9")!.filter((l) => l.kind === "slot").map((l) => l.id).sort();
    const b = byRatio.get("9:16")!.filter((l) => l.kind === "slot").map((l) => l.id).sort();
    assert.deepEqual(a, b, `${t.id}: the same boxes in both ratios`);
  }
});

test("every {field} a layer uses exists, and every field is used", () => {
  const tokens = (v: unknown): string[] => (typeof v === "string" ? [...v.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1].trim()) : []);
  for (const t of LAYOUTS) {
    const ids = new Set(t.fields.map((f) => f.id));
    assert.equal(ids.size, t.fields.length, `${t.id}: unique field ids`);
    const used = new Set<string>();
    for (const r of RATIOS) for (const l of t.designs[r]!.layers) {
      const refs = [...tokens(l.p.text), ...tokens(l.p.label), ...tokens(l.p.sub), ...tokens(l.p.tag), ...tokens(l.when?.replace(/^!/, ""))];
      for (const k of ["field", "tagOn", "at", "of"]) if (typeof l.p[k] === "string" && l.p[k]) refs.push(l.p[k] as string);
      for (const ref of refs) {
        if (ref.startsWith("$")) continue;
        assert.ok(ids.has(ref), `${t.id} ${r} ${l.id}: {${ref}} is a field`);
        used.add(ref);
      }
    }
    for (const f of t.fields) assert.ok(used.has(f.id), `${t.id}: field ${f.id} is shown somewhere`);
  }
});

test("text stays clear of the platforms' buttons in 9:16 and inside graphics-safe in 16:9", () => {
  for (const t of LAYOUTS) {
    for (const l of t.designs["9:16"]!.layers) {
      if (l.kind !== "text") continue;
      const [x, y, w, h] = l.box;
      assert.ok(y >= 1920 * 0.12 - 0.5 && y + h <= 1920 * 0.78 + 0.5 && x + w <= 1080 * 0.84 + 0.5 && x >= 1080 * 0.03, `${t.id} 9:16 ${l.id}: ${l.box}`);
    }
    for (const l of t.designs["16:9"]!.layers) {
      if (l.kind !== "text") continue;
      const [x, y, w, h] = l.box;
      assert.ok(x >= 1920 * 0.03 && x + w <= 1920 * 0.97 && y >= 1080 * 0.02 && y + h <= 1080 * 0.95, `${t.id} 16:9 ${l.id}: ${l.box}`);
    }
  }
});

test("the slot kind and its helpers are registered with their properties", () => {
  const k = layerKind("slot")!;
  assert.ok(k.ownsAnim);
  const keys = k.props.map((p) => p.key);
  for (const want of ["index", "hole", "frame", "frameColor", "radius", "label", "sub", "labelStyle", "labelPos", "tag", "tagStyle", "tagPos", "inner"]) assert.ok(keys.includes(want), want);
  assert.ok(layerKind("backdrop"));
  assert.ok(layerKind("progress"));
});
