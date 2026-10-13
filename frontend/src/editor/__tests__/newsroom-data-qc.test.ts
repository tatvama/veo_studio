/**
 * The graphics check (docs/EDITOR.md §16.10) with a fake text measure and a fake letter finder: text cut off or shrunk
 * below 70 %, missing letters, layers outside the safe area (both ratios), a crawl too fast to read, holds shorter than
 * the reading time, graphics covering each other (tickers allowed with the collision rule), empty required fields, old
 * or failed data, AI media without a label; and the fixes (hold longer, move inside, slow the crawl, add AI labels).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addGenerated, addTrack, ctxOf } from "../model/ops.ts";
import type { EditProject } from "../model/types.ts";
import { applyFix, groupFindings, outputRatios, runQc, type Finding, type QcDeps } from "../newsroom/qc/checks.ts";
import { field, items, layer, rect, text, tpl } from "../newsroom/templates/kit.ts";
import type { GfxInstance, GfxTemplate, GfxValue } from "../newsroom/types.ts";
import { media, project, put, V } from "./fixtures.ts";

const STRAP = tpl({ id: "t.strap", name: "Name strap", category: "Straps", role: "strap", seconds: 6, hold: "auto",
  fields: [field.text("name", "Name", "Priya Rao", { required: true }), field.text("role", "Role", "Anchor")],
  designs: {
    "16:9": [rect("plate", [96, 820, 900, 130], { fill: "@primary" }), text("name", [120, 830, 600, 60], "{name}", { size: 52, maxLines: 1 }), text("role", [120, 890, 600, 40], "{role}", { size: 32 })],
    "9:16": [rect("plate", [70, 1250, 860, 150], { fill: "@primary" }), text("name", [90, 1260, 600, 64], "{name}", { size: 56, maxLines: 1 }), text("role", [90, 1330, 600, 44], "{role}", { size: 36 })],
  } });
const EDGE = tpl({ id: "t.edge", name: "Edge tag", category: "Straps", role: "strap", seconds: 5,
  fields: [field.text("t", "Tag", "LIVE")], designs: { "16:9": [rect("bg", [0, 30, 300, 60]), text("tag", [20, 40, 200, 40], "{t}", { size: 30 })] } });
const BOARD = tpl({ id: "t.board", name: "Key points", category: "Boards", role: "board", seconds: 8,
  fields: [field.longtext("points", "Points", "One\nTwo")], designs: { "16:9": [text("pts", [200, 600, 1000, 300], "{points}", { size: 40 })] } });
const CRAWL = tpl({ id: "t.crawl", name: "Fast crawl", category: "Tickers", role: "ticker", seconds: 0, loop: true,
  fields: [field.list("items", "Items", items("One", "Two"))],
  designs: { "16:9": [layer("ticker", "crawl", [0, 930, 1920, 80], { mode: "crawl", speed: "custom", speedPx: 600, size: 40 })] } });
const AI = tpl({ id: "nr.straps.ai_label", name: "AI-generated label", category: "Straps", role: "strap", kind: "ai_label", seconds: 0,
  fields: [field.text("text", "Text", "AI-GENERATED")], designs: { "16:9": [text("t", [1500, 60, 320, 40], "{text}", { size: 28 })] } });

/** Width = letters × size × 0.5; Bengali letters are "missing". */
const deps: QcDeps = {
  measure: (font, s) => [...s].length * Number(font.match(/([\d.]+)px/)![1]) * 0.5,
  missing: (_f, s) => [...new Set([...s].filter((ch) => /[ঀ-৿]/.test(ch)))],
  now: Date.parse("2026-10-14T12:00:00Z"),
};

function edit(ratio: "16:9" | "both" = "16:9"): EditProject {
  const p = project();
  p.newsroom = { version: 1, look: "look.classic_red", looks: {}, templates: Object.fromEntries([STRAP, EDGE, BOARD, CRAWL, AI].map((t) => [t.id, t])), ratio, rundown: [],
    people: [], places: [], sources: [], data: {}, settings: { safeGuides: true, collision: true, readSpeed: 3, tickerSpeed: "normal", aiLabel: true } };
  p.sequences[0] = addTrack(p.sequences[0], "video").seq;
  return p;
}
/** Adds a graphic on video track `vi` (1-based above V1). */
function add(p: EditProject, t: GfxTemplate, at: number, dur: number, values: Record<string, GfxValue> = {}, vi = 1, extra: Partial<GfxInstance> = {}): string {
  const s = p.sequences[0];
  const r = addGenerated(s, ctxOf(p), V(s, vi).id, at, dur, { type: "graphic", gfx: { template: t.id, values, ...extra } }, t.name);
  p.sequences[0] = r.seq;
  return r.clipId;
}
const kinds = (fs: Finding[]) => fs.map((f) => `${f.kind}:${f.severity}`);
const of = (fs: Finding[], kind: string) => fs.filter((f) => f.kind === kind);

test("a clean graphic passes", () => {
  const p = edit();
  add(p, STRAP, 0, 150);
  assert.deepEqual(runQc(p, p.sequences[0].id, deps), []);
  assert.deepEqual(outputRatios(p, p.sequences[0]), ["16:9"]);
});

test("text: cut off, shrunk below 70 %, fine at 82 %; missing letters", () => {
  const p = edit();
  const a = add(p, STRAP, 0, 150, { name: "Venkataraghavan Subrahmanyam Iyer-Krishnamurthy" });
  const b = add(p, STRAP, 200, 150, { name: "Venkataraghavan Subrahmanyam Iyer K" });
  add(p, STRAP, 400, 150, { name: "Venkataraghavan Subrahmanyam" });
  const c = add(p, STRAP, 600, 150, { name: "রবি ঠাকুর" });
  const fs = runQc(p, p.sequences[0].id, deps);
  const fit = of(fs, "fit");
  assert.deepEqual(fit.map((f) => [f.clipId, f.severity]), [[a, "error"], [b, "warn"]]);
  assert.match(fit[0].message, /cut off/);
  assert.match(fit[1].message, /shrinks to 6\d %/);
  const gl = of(fs, "glyphs");
  assert.equal(gl.length, 1);
  assert.equal(gl[0].clipId, c);
  assert.match(gl[0].message, /র ব ি|র/);
  // without a letter finder, letters aren't checked
  assert.equal(of(runQc(p, p.sequences[0].id, { measure: deps.measure }), "glyphs").length, 0);
});

test("safe area: found per ratio, moved inside with one fix for that ratio only", () => {
  const p = edit();
  const id = add(p, EDGE, 0, 125);
  const fs = runQc(p, p.sequences[0].id, deps);
  const safe = of(fs, "safe");
  assert.equal(safe.length, 1);
  assert.match(safe[0].message, /tag is outside the safe area/);
  assert.deepEqual(safe[0].fix, { kind: "safe", label: "Move inside", clipId: id, ratio: "16:9", dx: 76, dy: 14 });
  applyFix(p, p.sequences[0].id, safe[0].fix!);
  const g = (p.sequences[0].clips.find((c) => c.id === id)!.source as { gfx: GfxInstance }).gfx;
  assert.deepEqual(g.overrides, { "bg@16:9": { box: [76, 44, 300, 60] }, "tag@16:9": { box: [96, 54, 200, 40] } });
  assert.equal(of(runQc(p, p.sequences[0].id, deps), "safe").length, 0);
  // both ratios: the made-up 9:16 design is checked too; each fix moves only its own ratio
  const q = edit("both");
  const qid = add(q, EDGE, 0, 125);
  assert.deepEqual(outputRatios(q, q.sequences[0]), ["16:9", "9:16"]);
  const both = of(runQc(q, q.sequences[0].id, deps), "safe");
  assert.ok(both.length >= 1);
  assert.ok(both.every((f) => f.fix?.kind === "safe" && f.fix.ratio === f.ratio));
  for (const f of both) applyFix(q, q.sequences[0].id, f.fix!);
  const keys = Object.keys((q.sequences[0].clips.find((c) => c.id === qid)!.source as { gfx: GfxInstance }).gfx.overrides ?? {});
  assert.ok(keys.length && keys.every((k) => /@(16:9|9:16)$/.test(k)), keys.join());
  assert.equal(of(runQc(q, q.sequences[0].id, deps), "safe").length, 0);
});

test("crawl too fast: found and slowed down", () => {
  const p = edit();
  const id = add(p, CRAWL, 0, 500, {}, 2);
  const cr = of(runQc(p, p.sequences[0].id, deps), "crawl");
  assert.equal(cr.length, 1);
  assert.match(cr[0].message, /30 letters a second/);
  assert.deepEqual(cr[0].fix, { kind: "crawl", label: "Slow it down", clipId: id, ratio: "16:9", layerId: "crawl", speedPx: 220 });
  applyFix(p, p.sequences[0].id, cr[0].fix!);
  assert.equal(of(runQc(p, p.sequences[0].id, deps), "crawl").length, 0);
});

test("holds shorter than the reading time: extended, up to the next graphic", () => {
  const p = edit();
  const a = add(p, STRAP, 0, 50);
  const b = add(p, STRAP, 300, 50);
  add(p, STRAP, 370, 150);
  const h = of(runQc(p, p.sequences[0].id, deps), "hold");
  assert.deepEqual(h.map((f) => f.clipId), [a, b]);
  assert.match(h[0].message, /on screen for 2\.0 s; reading it takes about 4\.0 s/);
  assert.deepEqual(h[0].fix, { kind: "extend", label: "Hold 4.0 s", clipId: a, duration: 100 });
  assert.deepEqual(h[1].fix, { kind: "extend", label: "Hold 2.8 s (up to the next graphic)", clipId: b, duration: 70 });
  applyFix(p, p.sequences[0].id, h[0].fix!);
  assert.equal(p.sequences[0].clips.find((c) => c.id === a)!.duration, 100);
});

test("overlaps: board over a strap is found; straps over a ticker are fine with the collision rule", () => {
  const p = edit();
  add(p, CRAWL, 0, 500, {}, 2);
  add(p, STRAP, 0, 150, {}, 1);
  add(p, BOARD, 100, 200, {}, 3);
  let fs = of(runQc(p, p.sequences[0].id, deps), "overlap");
  assert.equal(fs.length, 1);
  assert.equal(fs[0].frame, 100);
  assert.match(fs[0].message, /“Name strap” and “Key points” cover each other at 00:00:04:00/);
  p.newsroom!.settings.collision = false;
  fs = of(runQc(p, p.sequences[0].id, deps), "overlap");
  assert.equal(fs.length, 2, "without the collision rule the ticker counts too");
});

test("overlaps: plates that fit their text are measured as drawn, not at their widest", () => {
  const GROW = tpl({ id: "t.grow", name: "Grow strap", category: "Straps", role: "strap", seconds: 6, fields: [field.text("name", "Name", "Priya Rao")],
    designs: { "16:9": [rect("plate", [96, 880, 1700, 90]), text("name", [120, 880, 600, 90], "{name}", { size: 52, grow: { layers: ["plate"], pad: 24, max: 1700 } })] } });
  const TAG = tpl({ id: "t.tag", name: "Corner tag", category: "Straps", role: "strap", seconds: 6, fields: [field.text("t", "Tag", "AI-GENERATED")],
    designs: { "16:9": [text("t", [1500, 900, 320, 60], "{t}", { size: 28 })] } });
  const p = edit();
  p.newsroom!.templates[GROW.id] = GROW;
  p.newsroom!.templates[TAG.id] = TAG;
  add(p, GROW, 0, 150, {}, 1);
  add(p, TAG, 0, 150, {}, 2);
  assert.equal(of(runQc(p, p.sequences[0].id, deps), "overlap").length, 0, "“Priya Rao” makes a short plate");
  add(p, GROW, 200, 150, { name: "A very long name that pushes the plate all the way across the frame" }, 1);
  add(p, TAG, 200, 150, {}, 2);
  assert.equal(of(runQc(p, p.sequences[0].id, deps), "overlap").length, 1, "a long name grows it under the tag");
});

test("empty required fields, old and failed data", () => {
  const p = edit();
  const a = add(p, STRAP, 0, 150, { name: "" });
  const b = add(p, BOARD, 200, 200, {}, 3, { bind: { points: { source: "src.news", path: "Headline" } } });
  add(p, BOARD, 500, 200, {}, 3, { bind: { points: { source: "src.manual" } } });
  const nr = p.newsroom!;
  nr.sources.push({ id: "src.news", name: "Top stories", kind: "rss", url: "https://example.com/rss" }, { id: "src.manual", name: "Typed", kind: "manual" });
  nr.data["src.news"] = { source: "src.news", at: "2026-10-11T09:00:00Z", rows: [{ Headline: "x" }] };
  nr.data["src.manual"] = { source: "src.manual", at: "2026-01-01T00:00:00Z", rows: [{ a: 1 }] };
  const fs = runQc(p, p.sequences[0].id, deps);
  assert.deepEqual(of(fs, "empty").map((f) => [f.clipId, f.severity, f.message]), [[a, "error", "“Name strap”: Name is empty. Fill it in."]]);
  const st = of(fs, "stale");
  assert.equal(st.length, 1, "typed tables never go old");
  assert.equal(st[0].clipId, b);
  assert.equal(st[0].message, "“Top stories” is 3 days old.");
  assert.deepEqual(st[0].fix, { kind: "refresh", label: "Refresh", sourceId: "src.news" });
  nr.data["src.news"] = { ...nr.data["src.news"], at: "2026-10-14T10:00:00Z", error: "Offline" };
  assert.match(of(runQc(p, p.sequences[0].id, deps), "stale")[0].message, /last refresh failed \(Offline\)/);
  delete nr.data["src.news"];
  assert.match(of(runQc(p, p.sequences[0].id, deps), "stale")[0].message, /never been refreshed/);
});

test("AI media without a label: found, fixed with labels, quiet when the setting is off", () => {
  const p = edit();
  p.media.push(media("ai", { path: "studio:shot" }));
  p.sequences[0] = put(p, p.sequences[0], "ai", 50, { in: 0, out: 99 });
  const fs = of(runQc(p, p.sequences[0].id, deps), "ai-label");
  assert.equal(fs.length, 1);
  assert.equal(fs[0].frame, 50);
  assert.equal(fs[0].severity, "error");
  assert.match(fs[0].message, /00:00:02:00 to 00:00:06:00/);
  applyFix(p, p.sequences[0].id, fs[0].fix!);
  assert.equal(of(runQc(p, p.sequences[0].id, deps), "ai-label").length, 0);
  p.newsroom!.settings.aiLabel = false;
  p.sequences[0] = { ...p.sequences[0], clips: p.sequences[0].clips.filter((c) => c.source.type !== "graphic") };
  assert.equal(of(runQc(p, p.sequences[0].id, deps), "ai-label").length, 0);
});

test("findings are sorted by frame, errors first, and grouped for the panel", () => {
  const p = edit();
  add(p, STRAP, 100, 50, { name: "" });
  add(p, EDGE, 0, 125, {}, 2);
  const fs = runQc(p, p.sequences[0].id, deps);
  assert.deepEqual(kinds(fs), ["safe:warn", "empty:error", "hold:warn"]);
  assert.deepEqual(groupFindings(fs).map((g) => [g.label, g.items.length]), [["Empty fields", 1], ["Outside the safe area", 1], ["Too short to read", 1]]);
});
