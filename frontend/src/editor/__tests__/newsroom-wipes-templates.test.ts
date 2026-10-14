import assert from "node:assert/strict";
import { test } from "node:test";
import "../newsroom/render/kinds/index.ts";
import { countdownAt } from "../newsroom/render/kinds/bg.ts";
import { shineAt } from "../newsroom/render/kinds/shine.ts";
import { layerKind } from "../newsroom/render/registry.ts";
import { BACKGROUNDS } from "../newsroom/templates/backgrounds.ts";
import { OPENERS } from "../newsroom/templates/openers.ts";
import { STINGERS } from "../newsroom/templates/stingers.ts";
import { DESIGN } from "../newsroom/templates/kit.ts";
import type { GfxLayer, GfxRatio, GfxTemplate } from "../newsroom/types.ts";
import { bgParams, bgPhase, bgScene, BG_STYLES } from "../newsroom/wipes/bgscene.ts";

const ALL = [...STINGERS, ...OPENERS, ...BACKGROUNDS];
const RATIOS: GfxRatio[] = ["16:9", "9:16"];

const tokensOf = (l: GfxLayer): string[] => {
  const out: string[] = [];
  for (const s of [l.p.text, l.when]) if (typeof s === "string") for (const m of s.matchAll(/\{([^{}]+)\}/g)) out.push(m[1].trim());
  return out;
};

test("30 stingers, 8 openers, 10 backgrounds with unique, stable ids", () => {
  assert.equal(STINGERS.length, 30); assert.equal(OPENERS.length, 8); assert.equal(BACKGROUNDS.length, 10);
  assert.equal(new Set(ALL.map((t) => t.id)).size, ALL.length);
  const pre: [GfxTemplate[], string, string][] = [[STINGERS, "nr.stingers.", "Stingers"], [OPENERS, "nr.openers.", "Openers"], [BACKGROUNDS, "nr.backgrounds.", "Backgrounds"]];
  for (const [list, prefix, cat] of pre) for (const t of list) {
    assert.ok(t.id.startsWith(prefix) && /^[a-z0-9_.]+$/.test(t.id), t.id);
    assert.equal(t.category, cat);
    assert.equal(t.version, 1); assert.equal(t.source, "builtin");
    assert.ok(t.name && t.description, t.id);
    assert.equal(new Set(t.fields.map((f) => f.id)).size, t.fields.length, `${t.id} field ids`);
  }
});

test("every template has both designs, unique layer ids, registered kinds and fields for every {token}", () => {
  for (const t of ALL) {
    const fields = new Set(t.fields.map((f) => f.id));
    for (const r of RATIOS) {
      const d = t.designs[r];
      assert.ok(d && d.layers.length, `${t.id} ${r}`);
      const ids = d.layers.map((l) => l.id);
      assert.equal(new Set(ids).size, ids.length, `${t.id} ${r} layer ids`);
      for (const l of d.layers) {
        assert.ok(layerKind(l.kind), `${t.id} ${r} ${l.id}: kind ${l.kind}`);
        for (const k of tokensOf(l)) assert.ok(k.startsWith("$") || fields.has(k), `${t.id} ${r} ${l.id}: {${k}} has no field`);
        if (l.clip) assert.ok(ids.includes(l.clip), `${t.id} ${r} ${l.id}: clip ${l.clip}`);
        const [x, y, w, h] = l.box;
        assert.ok(w > 0 && h > 0 && x >= -1 && y >= -1 && x + w <= DESIGN[r].w + 1 && y + h <= DESIGN[r].h + 1, `${t.id} ${r} ${l.id} box ${l.box}`);
      }
    }
    // every field is used somewhere
    const used = new Set(RATIOS.flatMap((r) => t.designs[r]!.layers.flatMap(tokensOf)));
    for (const f of fields) assert.ok(used.has(f), `${t.id}: field ${f} is never shown`);
  }
});

test("stingers: role wipe, short, cut inside (0, 1), sound hints, one full-frame panels layer", () => {
  for (const t of STINGERS) {
    assert.equal(t.role, "wipe");
    assert.ok(t.seconds >= 0.8 && t.seconds <= 1.6, `${t.id} ${t.seconds}`);
    assert.ok(t.cut! > 0 && t.cut! < 1, t.id);
    assert.ok(t.sounds?.in && t.sounds.cut, t.id);
    for (const r of RATIOS) {
      const p = t.designs[r]!.layers.filter((l) => l.kind === "panels");
      assert.equal(p.length, 1, `${t.id} ${r}`);
      assert.deepEqual(p[0].box, [0, 0, DESIGN[r].w, DESIGN[r].h]);
      assert.equal(p[0].p.cut, t.cut, `${t.id}: the panels' cut is the template's`);
    }
  }
});

test("openers and backgrounds: lengths, roles, vertical content clear of the Reels / Shorts buttons", () => {
  for (const t of OPENERS) {
    assert.equal(t.role, "board");
    assert.ok(t.seconds >= 2 && t.seconds <= 10, t.id);
    // content (text, logos, the countdown) keeps clear; full-width plates and backgrounds may run under the buttons
    for (const l of t.designs["9:16"]!.layers) {
      if (!["text", "logo", "countdown"].includes(l.kind)) continue;
      const [x, y, w, h] = l.box;
      assert.ok(y >= 0.12 * 1920 - 1 && y + h <= 0.78 * 1920 + 1 && x + w <= 0.84 * 1080 + 1, `${t.id} 9:16 ${l.id} ${l.box}`);
    }
    for (const l of t.designs["16:9"]!.layers) {
      if (!["text", "logo", "countdown"].includes(l.kind)) continue;
      const [x, y, w, h] = l.box;
      assert.ok(x >= 96 - 1 && y >= 54 - 1 && x + w <= 1824 + 1 && y + h <= 1026 + 1, `${t.id} 16:9 ${l.id} ${l.box}`);
    }
  }
  for (const t of BACKGROUNDS) {
    assert.equal(t.role, "background"); assert.equal(t.loop, true); assert.equal(t.seconds, 0);
    for (const r of RATIOS) assert.equal(t.designs[r]!.layers[0].kind, "bg");
  }
});

test("backgrounds loop seamlessly: the picture at t and t + period is the same", () => {
  const near = (a: unknown, b: unknown, path: string): void => {
    if (typeof a === "number" && typeof b === "number") { assert.ok(Math.abs(a - b) < 1e-6, `${path}: ${a} vs ${b}`); return; }
    if (Array.isArray(a) && Array.isArray(b)) { assert.equal(a.length, b.length, path); a.forEach((x, i) => near(x, b[i], `${path}[${i}]`)); return; }
    if (a && b && typeof a === "object" && typeof b === "object") {
      assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), path);
      for (const k of Object.keys(a)) near((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      return;
    }
    assert.equal(a, b, path);
  };
  for (const t of BACKGROUNDS) {
    for (const r of RATIOS) {
      const l = t.designs[r]!.layers[0];
      const P = bgParams(l.p);
      for (const at of [0, 1.37, P.period * 0.5]) {
        near(bgScene(P, l.box[2], l.box[3], at), bgScene(P, l.box[2], l.box[3], at + P.period), `${t.id} ${r} @${at}`);
        near(bgScene(P, l.box[2], l.box[3], at), bgScene(P, l.box[2], l.box[3], at + 3 * P.period), `${t.id} ${r} @${at}+3P`);
      }
      // and it moves in between
      assert.notDeepEqual(bgScene(P, l.box[2], l.box[3], 0), bgScene(P, l.box[2], l.box[3], P.period * 0.25), `${t.id} moves`);
    }
  }
  assert.equal(BG_STYLES.length, 10);
  assert.equal(bgPhase(10, 0), 0); assert.equal(bgPhase(10, 10), 0); assert.equal(bgPhase(10, 25), 0.5);
});

test("the shine and countdown kinds are pure functions of time", () => {
  assert.equal(shineAt({ delay: 1, period: 0, duration: 0.5 }, 0.5), null);
  assert.equal(shineAt({ delay: 1, period: 0, duration: 0.5 }, 1.25), 0.5);
  assert.equal(shineAt({ delay: 1, period: 0, duration: 0.5 }, 2), null);
  assert.equal(shineAt({ delay: 0, period: 4, duration: 1 }, 8.5), shineAt({ delay: 0, period: 4, duration: 1 }, 0.5));
  assert.deepEqual(countdownAt({ from: 9, delay: 0.5 }, 0.2).n, 9);
  assert.equal(countdownAt({ from: 9, delay: 0.5 }, 1.6).n, 8);
  assert.equal(countdownAt({ from: 9, delay: 0.5 }, 9.5).n, 0);
  assert.equal(countdownAt({ from: 9, delay: 0.5 }, 30).n, 0);
});
