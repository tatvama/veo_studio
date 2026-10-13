import assert from "node:assert/strict";
import { test } from "node:test";
import { BUGS } from "../newsroom/templates/bugs.ts";
import { DESIGN } from "../newsroom/templates/kit.ts";
import { TICKERS } from "../newsroom/templates/tickers.ts";
import { crawlSpeed, readableSpeed } from "../newsroom/tickers/math.ts";
import { tickerFieldRefs, tickerProps } from "../newsroom/tickers/props.ts";
import type { Box, GfxLayer, GfxListItem, GfxRatio, GfxTemplate } from "../newsroom/types.ts";

const ALL: GfxTemplate[] = [...TICKERS, ...BUGS];
const KINDS = new Set(["rect", "text", "image", "logo", "line", "icon", "ticker", "clock"]);
/** Plates and rules may bleed past the safe area (and a little past the frame); the rest carries content. */
const DECOR = new Set(["rect", "line"]);
const SYSTEMS = ["crawl", "flip", "stacked", "breaking", "category", "weather", "markets", "score", "election", "speed_news", "rates", "alert", "social", "now_next", "headline", "vertical"];

const tokens = (s: unknown): string[] => (typeof s === "string" ? [...s.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]) : []);
const designsOf = (t: GfxTemplate) => (["16:9", "9:16"] as GfxRatio[]).map((r) => [r, t.designs[r]!] as const);

/** The part of a layer that holds text or pictures (a ticker's band may bleed: its items stay inside). */
function contentBox(l: GfxLayer): Box {
  if (l.kind !== "ticker") return l.box;
  const p = tickerProps(l.p);
  const [x, y, w, h] = l.box;
  return [x + p.bleedL, y, w - p.bleedL - p.bleedR, h];
}

test("16 ticker systems and the bugs, with stable ids", () => {
  assert.equal(TICKERS.length, 16);
  assert.deepEqual(TICKERS.map((t) => t.id), SYSTEMS.map((s) => `nr.tickers.${s}`));
  assert.ok(BUGS.length >= 9);
  for (const id of ["logo", "live", "clock", "date", "clock_date", "temperature", "exclusive", "recorded", "breaking"]) assert.ok(BUGS.some((b) => b.id === `nr.bugs.${id}`), id);
  assert.equal(new Set(ALL.map((t) => t.id)).size, ALL.length);
  for (const t of TICKERS) { assert.equal(t.category, "Tickers"); assert.equal(t.role, "ticker"); assert.match(t.id, /^nr\.tickers\.[a-z_]+$/); }
  for (const t of BUGS) { assert.equal(t.category, "Bugs"); assert.equal(t.role, "bug"); assert.match(t.id, /^nr\.bugs\.[a-z_]+$/); }
  // the same every build
  assert.equal(JSON.stringify(TICKERS), JSON.stringify(TICKERS));
});

test("every template loops, fills or holds, and has both designs with unique layer ids", () => {
  for (const t of ALL) {
    assert.equal(t.loop, true, t.id);
    assert.equal(t.version, 1);
    assert.equal(t.source, "builtin");
    assert.ok(t.hold, `${t.id} hold`);
    if (t.hold === "fill" || t.hold === "until-next") assert.equal(t.seconds, 0, t.id);
    else assert.ok(t.seconds > 0, t.id);
    assert.ok(t.timing.in >= 0.4 && t.timing.in <= 1 && t.timing.out >= 0.3 && t.timing.out <= 0.45, `${t.id} timing`);
    const ids: string[][] = [];
    for (const [r, d] of designsOf(t)) {
      assert.ok(d && d.layers.length, `${t.id} ${r}`);
      const lids = d.layers.map((l) => l.id);
      assert.equal(new Set(lids).size, lids.length, `${t.id} ${r}: duplicate layer ids`);
      for (const l of d.layers) assert.ok(KINDS.has(l.kind), `${t.id} ${r} ${l.id}: kind ${l.kind}`);
      ids.push([...lids].sort());
    }
    // the same layers in both ratios ("the same layer" for the Designer and overrides)
    assert.deepEqual(ids[0], ids[1], `${t.id}: layers differ between 16:9 and 9:16`);
  }
});

test("every {field}, source and when names a field of its template", () => {
  for (const t of ALL) {
    const fields = new Set(t.fields.map((f) => f.id));
    assert.equal(fields.size, t.fields.length, `${t.id}: duplicate field ids`);
    for (const [r, d] of designsOf(t)) {
      for (const l of d.layers) {
        const refs = [
          ...Object.values(l.p).flatMap(tokens).filter((k) => !k.startsWith("$")),
          ...tokens(l.when), ...tickerFieldRefs(l.kind, l.p),
          ...(l.kind === "image" && typeof l.p.field === "string" ? [l.p.field] : []),
        ];
        for (const k of refs) assert.ok(fields.has(k), `${t.id} ${r} ${l.id}: unknown field "${k}"`);
        if (l.when) assert.match(l.when, /^!?\{[\w.-]+\}$/, `${t.id} ${l.id} when`);
      }
    }
    for (const f of t.fields) {
      if (f.type === "list") assert.ok(Array.isArray(f.default) && (f.default as GfxListItem[]).every((i) => typeof i.text === "string"), `${t.id} ${f.id}`);
      if (f.type === "choice") assert.ok(f.options?.some((o) => o.value === f.default), `${t.id} ${f.id}`);
    }
  }
});

test("text and items stay inside each design's safe area; plates stay on the frame", () => {
  for (const t of ALL) {
    for (const [r, d] of designsOf(t)) {
      const { w, h } = DESIGN[r];
      const safe = d.safe!;
      assert.ok(safe, `${t.id} ${r}: safe area`);
      const [top, right, bottom, left] = safe;
      for (const l of d.layers) {
        const [x, y, bw, bh] = l.box;
        assert.ok(bw > 0 && bh > 0, `${t.id} ${r} ${l.id}: empty box`);
        if (DECOR.has(l.kind)) {
          assert.ok(x >= -40 && y >= 0 && x + bw <= w + 40 && y + bh <= h, `${t.id} ${r} ${l.id}: plate off the frame ${l.box}`);
          continue;
        }
        const [cx, cy, cw, ch] = contentBox(l);
        assert.ok(cx >= left - 0.5 && cy >= top - 0.5 && cx + cw <= w - right + 0.5 && cy + ch <= h - bottom + 0.5,
          `${t.id} ${r} ${l.id}: ${[cx, cy, cw, ch]} outside the safe area ${safe}`);
      }
    }
    // the platform safe areas: 9:16 clears the top 12 %, bottom 22 % and right 16 %
    const v = t.designs["9:16"]!.safe!;
    assert.ok(v[0] >= 1920 * 0.12 && v[1] >= 1080 * 0.16 && v[2] >= 1920 * 0.22, t.id);
  }
});

test("tickers read comfortably, and vertical designs are bigger and no faster", () => {
  for (const t of TICKERS) {
    for (const [r, d] of designsOf(t)) {
      const { w, h } = DESIGN[r];
      for (const l of d.layers.filter((x) => x.kind === "ticker")) {
        const p = tickerProps(l.p);
        if (p.mode !== "crawl") continue;
        const rd = readableSpeed(crawlSpeed(p.speed, w, h, p.speedPx), p.size, contentBox(l)[2] * 0.75);
        assert.equal(rd.level, "ok", `${t.id} ${r} ${l.id}: ${JSON.stringify(rd)}`);
      }
    }
    const a = t.designs["16:9"]!.layers.find((l) => l.kind === "ticker");
    const b = t.designs["9:16"]!.layers.find((l) => l.kind === "ticker");
    if (a && b) assert.ok(tickerProps(b.p).size >= tickerProps(a.p).size * 0.9, `${t.id}: 9:16 text smaller`);
  }
  assert.ok(crawlSpeed("normal", 1080, 1920) < crawlSpeed("normal", 1920, 1080));
});

test("sample values read like Indian news: Hindi lines, ₹, lakh / crore, party colours", () => {
  const texts = TICKERS.flatMap((t) => t.fields.flatMap((f) => (f.type === "list" ? (f.default as GfxListItem[]).map((i) => i.text) : typeof f.default === "string" ? [f.default] : [])));
  assert.ok(texts.some((s) => /[ऀ-ॿ]/.test(s)), "a Hindi line");
  assert.ok(texts.some((s) => /[஀-௿ఀ-౿ಀ-೿]/.test(s)), "a Tamil, Telugu or Kannada line");
  assert.ok(texts.some((s) => s.includes("₹")));
  assert.ok(texts.some((s) => /lakh|crore/.test(s)));
  const crawl = TICKERS.find((t) => t.id === "nr.tickers.crawl")!;
  assert.ok((crawl.fields.find((f) => f.id === "items")!.default as GfxListItem[]).some((i) => i.flash), "a priority item");
  const parties = TICKERS.find((t) => t.id === "nr.tickers.election")!.fields.find((f) => f.id === "parties")!.default as GfxListItem[];
  assert.ok(parties.every((p) => /^#[0-9a-f]{6}$/i.test(p.color ?? "") && typeof p.value === "number"));
  const speed = TICKERS.find((t) => t.id === "nr.tickers.speed_news")!.fields.find((f) => f.id === "items")!.default as GfxListItem[];
  assert.equal(speed.length, 20);
  for (const t of TICKERS) assert.ok(t.sounds?.in, `${t.id} sound hint`);
});

test("score bug has the three sports and the logo bug can follow the look's corner", () => {
  const score = TICKERS.find((t) => t.id === "nr.tickers.score")!;
  assert.deepEqual(score.fields.find((f) => f.id === "sport")!.options!.map((o) => o.value), ["cricket", "football", "kabaddi"]);
  const logo = BUGS.find((b) => b.id === "nr.bugs.logo")!;
  assert.equal(logo.kind, "logo");
  const l = logo.designs["16:9"]!.layers[0];
  assert.equal(l.kind, "logo");
  assert.equal(l.anim?.loop?.kind, "shine");
  assert.ok(l.anim!.loop!.period >= 8 && l.anim!.loop!.period <= 12);
  // drawn top right, so the renderer can mirror it to another corner
  assert.ok(l.box[0] + l.box[2] > DESIGN["16:9"].w * 0.8 && l.box[1] < 200);
});
