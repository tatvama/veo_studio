import assert from "node:assert/strict";
import { test } from "node:test";
import { SAFE_AREAS } from "../templates/formats.ts";
import { BOARD_FRAMES, BOARDS } from "../newsroom/templates/boards.ts";
import { STRAPS } from "../newsroom/templates/straps.ts";
import { DESIGN } from "../newsroom/templates/kit.ts";
import { contentBox } from "../newsroom/render/layout.ts";
import { defaultProps, layerKind } from "../newsroom/render/registry.ts";
import "../newsroom/render/kinds/index.ts";
import type { GfxLayer, GfxRatio, GfxTemplate } from "../newsroom/types.ts";

const STRAP_IDS = ["anchor", "reporter", "guest", "headline", "location", "phone", "video_call", "hashtag", "source", "file_footage", "translated", "sponsored", "ai_label", "slug"];
const BOARD_IDS = ["key_points", "big_number", "quote", "poll", "timeline", "versus", "fact_check", "rates", "weather", "election", "scorecard", "headlines", "profile", "countdown", "map", "gallery"];
const ALL = [...STRAPS, ...BOARDS];
const RATIOS: GfxRatio[] = ["16:9", "9:16"];
const DEVANAGARI = /[ऀ-ॿ]/;

/** Decorative layers that may bleed past the safe area: full-frame backgrounds and the code-drawn texture. */
const decorative = (l: GfxLayer, r: GfxRatio) => l.name === "texture" || (l.box[2] >= DESIGN[r].w * 0.9 && l.box[3] >= DESIGN[r].h * 0.4 && l.id.startsWith("bg"));

/** Every "{token}" a layer uses: text, when, icon names, the stamp's text. */
function tokensOf(l: GfxLayer): string[] {
  const out: string[] = [];
  const scan = (s: unknown) => { if (typeof s === "string") for (const m of s.matchAll(/\{([^{}]+)\}/g)) out.push(m[1].trim()); };
  scan(l.p.text); scan(l.p.icon); scan(l.when);
  return out;
}
/** Field ids a layer reads through props (kinds' "field" props). */
function fieldRefs(l: GfxLayer): string[] {
  const kind = layerKind(l.kind);
  return (kind?.props ?? []).filter((d) => d.type === "field").map((d) => l.p[d.key]).filter((v): v is string => typeof v === "string" && v !== "");
}

test("14 straps and 16 boards with stable ids", () => {
  assert.deepEqual(STRAPS.map((t) => t.id), STRAP_IDS.map((x) => `nr.straps.${x}`));
  assert.deepEqual(BOARDS.map((t) => t.id), BOARD_IDS.map((x) => `nr.boards.${x}`));
  assert.equal(new Set(ALL.map((t) => t.id)).size, ALL.length);
  for (const t of STRAPS) { assert.equal(t.category, "Straps"); assert.equal(t.role, "strap"); assert.equal(t.hold, "auto", t.id); }
  for (const t of BOARDS) { assert.equal(t.category, "Boards"); assert.equal(t.role, "board"); }
  for (const t of ALL) {
    assert.equal(t.version, 1);
    assert.equal(t.source, "builtin");
    assert.ok(t.name && t.description && t.tags?.length && t.sounds?.in, t.id);
    assert.ok(t.timing.in >= 0.4 && t.timing.in <= 1.2 && t.timing.out >= 0.3 && t.timing.out <= 0.6, `${t.id} timing`);
    assert.equal(new Set(t.fields.map((f) => f.id)).size, t.fields.length, `${t.id} field ids`);
  }
});

test("every template has a 16:9 and a 9:16 design with unique layer ids and known kinds", () => {
  for (const t of ALL) {
    for (const r of RATIOS) {
      const d = t.designs[r];
      assert.ok(d && d.layers.length > 0, `${t.id} ${r}`);
      const ids = d.layers.map((l) => l.id);
      assert.equal(new Set(ids).size, ids.length, `${t.id} ${r} duplicate layer ids: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`);
      for (const l of d.layers) assert.ok(layerKind(l.kind), `${t.id} ${r} ${l.id}: kind ${l.kind} isn't registered`);
    }
    // the same content layers in both ratios (decoration may differ)
    const content = (r: GfxRatio) => new Set(t.designs[r]!.layers.filter((l) => !decorative(l, r) && ["text", "number", "list", "bars", "table", "pins", "stamp"].includes(l.kind)).map((l) => l.id));
    const a = content("16:9"), b = content("9:16");
    for (const id of b) assert.ok(a.has(id), `${t.id}: 9:16 layer ${id} has no 16:9 twin`);
  }
});

test("every {field}, field prop, grow plate and clip refers to something that exists", () => {
  for (const t of ALL) {
    const fields = new Set(t.fields.map((f) => f.id));
    for (const r of RATIOS) {
      const layers = t.designs[r]!.layers;
      const ids = new Set(layers.map((l) => l.id));
      for (const l of layers) {
        for (const tok of tokensOf(l)) assert.ok(tok.startsWith("$") || fields.has(tok), `${t.id} ${r} ${l.id}: {${tok}} isn't a field`);
        for (const f of fieldRefs(l)) assert.ok(fields.has(f), `${t.id} ${r} ${l.id}: field "${f}" doesn't exist`);
        const grow = l.p.grow as { layers?: string[] } | undefined;
        for (const g of grow?.layers ?? []) assert.ok(ids.has(g), `${t.id} ${r} ${l.id}: grows missing layer ${g}`);
        if (l.clip) assert.ok(ids.has(l.clip), `${t.id} ${r} ${l.id}: clip ${l.clip} missing`);
      }
    }
  }
});

test("everything stays inside the safe area (plates at their widest too)", () => {
  const eps = 1;
  for (const t of ALL) {
    for (const r of RATIOS) {
      const { w, h } = DESIGN[r];
      const s = SAFE_AREAS[r as "16:9" | "9:16"];
      const [L, T, R, B] = [s.left * w, s.top * h, w - s.right * w, h - s.bottom * h];
      const layers = t.designs[r]!.layers;
      const byId = new Map(layers.map((l) => [l.id, l]));
      for (const l of layers) {
        if (decorative(l, r)) continue;
        const [x, y, bw, bh] = l.box;
        assert.ok(x >= L - eps && y >= T - eps && x + bw <= R + eps && y + bh <= B + eps,
          `${t.id} ${r} ${l.id} [${l.box.map(Math.round)}] leaves the safe area [${[L, T, R, B].map(Math.round)}]`);
        const grow = l.p.grow as { layers?: string[]; max?: number } | undefined;
        for (const id of grow?.layers ?? []) {
          const plate = byId.get(id)!;
          const right = (l.p.align === "right") ? plate.box[0] + plate.box[2] : plate.box[0] + (grow?.max ?? plate.box[2]);
          const left = (l.p.align === "right") ? plate.box[0] + plate.box[2] - (grow?.max ?? plate.box[2]) : plate.box[0];
          assert.ok(right <= R + eps && left >= L - eps, `${t.id} ${r} ${id} can grow past the safe area (${Math.round(left)}..${Math.round(right)})`);
        }
      }
    }
  }
});

test("sample values read like Indian news; people fields say where they're filled from", () => {
  const text = (t: GfxTemplate) => JSON.stringify(t.fields.map((f) => f.default));
  assert.ok(STRAPS.filter((t) => DEVANAGARI.test(text(t))).length >= 1, "a Hindi strap sample");
  assert.ok(BOARDS.filter((t) => DEVANAGARI.test(text(t))).length >= 4, "Hindi lines in board samples");
  assert.ok(BOARDS.filter((t) => /₹|lakh|crore/.test(text(t)) || t.fields.some((f) => f.format?.currency)).length >= 5, "₹ / lakh / crore samples");
  const fills: Record<string, string> = { name: "person.name", role: "person.role", photo: "person.photo", location: "place" };
  for (const t of STRAPS) for (const f of t.fields) if (fills[f.id]) assert.equal(f.fill, fills[f.id], `${t.id}.${f.id}`);
  assert.equal(STRAPS.find((t) => t.id === "nr.straps.headline")!.fields.find((f) => f.id === "headline")!.fill, "story.headline");
  // long names for testing fit
  assert.ok(STRAPS.some((t) => t.fields.some((f) => f.id === "name" && String(f.default).length >= 28)));
});

test("straps: plates lead, text follows 60–120 ms later; everything leaves", () => {
  for (const t of STRAPS) {
    for (const r of RATIOS) {
      const layers = t.designs[r]!.layers;
      for (const l of layers) assert.ok(l.anim?.in && l.anim?.out, `${t.id} ${r} ${l.id} needs in and out`);
      for (const l of layers.filter((x) => x.kind === "text" && x.clip)) {
        const plate = layers.find((x) => x.id === l.clip)!;
        const gap = (l.anim!.in!.delay ?? 0) - (plate.anim!.in!.delay ?? 0);
        assert.ok(gap >= 0.06 - 1e-9 && gap <= 0.2, `${t.id} ${r} ${l.id} follows its plate by ${gap.toFixed(2)} s`);
      }
    }
  }
});

test("board kinds describe every prop with a default", () => {
  for (const k of ["number", "list", "bars", "table", "pins", "stamp"]) {
    const def = layerKind(k);
    assert.ok(def, k);
    assert.ok(def.ownsAnim, `${k} owns its animation`);
    const keys = def.props.map((p) => p.key);
    assert.equal(new Set(keys).size, keys.length, `${k} prop keys`);
    for (const p of def.props) {
      assert.ok(p.label && p.type && p.default !== undefined, `${k}.${p.key}`);
      if (p.type === "choice") assert.ok(p.options?.some((o) => o.value === p.default), `${k}.${p.key} default is an option`);
    }
    assert.equal(Object.keys(defaultProps(k)).length, keys.length);
  }
});

test("boards keep their content above the footer and clear of the ticker zone (no collision lift)", () => {
  const FRAME = /^(bg|dots\d|rule\d?|kicker|kickerbg|title|hair|foot|source|logo)$/;
  const tickerTop = { "16:9": 962, "9:16": 1386 } as const;
  for (const t of BOARDS) {
    for (const r of RATIOS) {
      const f = BOARD_FRAMES[r as "16:9" | "9:16"];
      const layers = t.designs[r]!.layers;
      for (const l of layers) {
        if (FRAME.test(l.id) || decorative(l, r)) continue;
        assert.ok(l.box[1] + l.box[3] <= f.footY - 12 + 1, `${t.id} ${r} ${l.id} runs into the footer (${l.box[1] + l.box[3]} > ${f.footY - 12})`);
      }
      const { w, h } = DESIGN[r];
      const cb = contentBox(layers, w, h)!;
      assert.ok((cb[1] + cb[3]) * h <= tickerTop[r as "16:9" | "9:16"] - 14 + 0.5, `${t.id} ${r} reaches the ticker zone (${Math.round((cb[1] + cb[3]) * h)})`);
    }
  }
});
