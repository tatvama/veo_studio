import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_LOOKS } from "../newsroom/looks.ts";
import { STINGERS } from "../newsroom/templates/stingers.ts";
import {
  checkSpec, describeSpec, panelsProps, randomSpec, rng, specFromTemplate, stingerTemplate, wipeSpec, WIPE_DEFAULTS,
} from "../newsroom/wipes/designer.ts";

const look = BUILTIN_LOOKS[0];

test("a spec has about 18 parameters and makes a stinger template with both ratios and a cut", () => {
  assert.ok(Object.keys(WIPE_DEFAULTS).length >= 18);
  const t = stingerTemplate({ layout: "bars", count: 5, text: "BREAKING NEWS", logo: true, seconds: 1.4, cut: 0.45 }, { id: "my.x", name: "Mine" });
  assert.equal(t.category, "Stingers"); assert.equal(t.role, "wipe"); assert.equal(t.cut, 0.45); assert.equal(t.seconds, 1.4);
  assert.ok(t.designs["16:9"] && t.designs["9:16"]);
  assert.deepEqual(t.fields.map((f) => f.id), ["text"]);
  const p = t.designs["16:9"]!.layers[0].p;
  assert.equal(p.text, "{text}"); assert.equal(p.cut, 0.45); assert.equal(p.color1, "@accent");
  assert.ok(Math.abs(t.timing.in + t.timing.out - 1.4) < 1e-9);
  assert.equal(t.sounds?.cut, "impact");
});

test("spec → template → spec round-trips (the Designer can open any stinger it made)", () => {
  const s = wipeSpec({ layout: "circles", edge: "brush", count: 3, angle: 15, depth: 0.7, order: "center", stagger: 0.05, seconds: 1.3, cut: 0.52, hold: 0.3,
    ease: "back", overshoot: 0.6, exit: "back", colors: ["dark", "accent", "primary"], finish: "glass", line: 6, lineColor: "light", logo: true, flash: 0.4,
    text: "EXCLUSIVE", textPlate: "breaking", textStyle: "rise", blur: 0.4, shadow: 0.2, seed: 77, cx: 0.3, cy: 0.6, sweep: true, vertical: { count: 2, cx: 0.5 } });
  const back = specFromTemplate(stingerTemplate(s, { id: "my.r", name: "R" }))!;
  assert.deepEqual(back, s);
  for (const t of STINGERS) assert.ok(specFromTemplate(t), t.id);
});

test("Randomise is seeded: the same seed gives the same wipe, others differ, all are tasteful and cover the cut", () => {
  assert.deepEqual(randomSpec(look, 42), randomSpec(look, 42));
  assert.notDeepEqual(randomSpec(look, 42), randomSpec(look, 43));
  const r = rng(5); const a = [r(), r(), r()]; const r2 = rng(5); assert.deepEqual([r2(), r2(), r2()], a);
  const seen = new Set<string>();
  for (const l of BUILTIN_LOOKS) {
    for (let seed = 1; seed <= 24; seed++) {
      const s = randomSpec(l, seed, { logo: seed % 3 === 0, text: seed % 5 === 0 ? "LIVE" : "" });
      seen.add(s.layout);
      assert.ok(checkSpec(s, 16).ok, `${l.id} seed ${seed}: ${describeSpec(s)}`);
      assert.ok(s.seconds >= 0.9 && s.seconds <= 1.6 && s.cut >= 0.45 && s.cut <= 0.55, `${seed} timing`);
      assert.ok(s.colors.length >= 1 && s.colors.length <= 4, `${seed} colours`);
      if (s.logo || s.text) assert.ok(["primary", "secondary", "dark", "breaking"].includes(s.colors[s.colors.length - 1]), `${seed}: the logo lands on a dark plate`);
      if (l.motion === "bouncy") assert.ok(s.ease === "back" || s.ease === "elastic");
      if (l.motion === "sharp") assert.ok(s.ease === "expo" || s.ease === "sharp");
      // the user's choices are kept
      assert.equal(s.logo, seed % 3 === 0);
      assert.equal(s.text, seed % 5 === 0 ? "LIVE" : "");
    }
  }
  assert.ok(seen.size >= 6, `variety: ${[...seen]}`);
});

test("vertical overrides only change the 9:16 design", () => {
  const s = wipeSpec({ layout: "tiles", count: 10, vertical: { count: 6 } });
  assert.equal(panelsProps(s, "16:9").count, 10);
  assert.equal(panelsProps(s, "9:16").count, 6);
  assert.match(describeSpec(wipeSpec({ layout: "stack", edge: "slant", count: 3, angle: 180, seconds: 1.2 })), /3 slanted panels, right to left, 1\.2 s/);
});
