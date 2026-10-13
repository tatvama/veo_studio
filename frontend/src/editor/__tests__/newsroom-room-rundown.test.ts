/** News Room rundown Build (editor/newsroom/rundown.ts): story ranges, the dry run, re-running without doubling. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addGenerated, addTrack, ctxOf, tracksOf } from "../model/ops.ts";
import type { EditProject, Sequence } from "../model/types.ts";
import type { AddGraphicOptions } from "../newsroom/commands.ts";
import { applyBuild, BUILD_TAG, buildTagOf, builtClips, holdSeconds, planBuild, storyRanges } from "../newsroom/rundown.ts";
import { field, rect, text, tpl } from "../newsroom/templates/kit.ts";
import type { GfxTemplate, NewsroomDoc, RundownStory } from "../newsroom/types.ts";
import { media, project, put, seqOf } from "./fixtures.ts";

const headline = tpl({ id: "t.headline", name: "Two-line headline", category: "Straps", role: "strap", kind: "headline", seconds: 6,
  fields: [field.text("headline", "Headline", "", { fill: "story.headline" }), field.text("strap", "Second line", "", { fill: "story.strap" })],
  designs: { "16:9": [rect("plate", [100, 800, 900, 120]), text("h", [120, 800, 860, 70], "{headline}")] } });
const reporter = tpl({ id: "t.reporter", name: "Reporter", category: "Straps", role: "strap", kind: "reporter", seconds: 6,
  fields: [field.text("name", "Name", "", { fill: "person.name" }), field.text("role", "Role", "", { fill: "person.role" }), field.text("loc", "Location", "", { fill: "place" })],
  designs: { "16:9": [text("n", [120, 800, 860, 70], "{name}")] } });
const points = tpl({ id: "t.points", name: "Key points", category: "Boards", role: "board", kind: "key_points", seconds: 10,
  fields: [field.text("title", "Title", "", { fill: "story.headline" }), field.list("points", "Points", [], { fill: "story.points" })],
  designs: { "16:9": [text("t", [100, 100, 800, 80], "{title}")] } });
const crawl = tpl({ id: "t.crawl", name: "Crawl", category: "Tickers", role: "ticker", kind: "crawl", seconds: 0, loop: true,
  fields: [field.list("items", "Lines", [])], designs: { "16:9": [rect("band", [0, 1000, 1920, 80])] } });
const TEMPLATES = { headline, reporter, points, ticker: crawl };

function nrDoc(stories: RundownStory[]): NewsroomDoc {
  return { version: 1, look: "look.classic_red", looks: {}, templates: {}, ratio: "16:9", rundown: stories,
    people: [{ id: "p1", name: "Asha Menon", role: "Senior correspondent", location: "Kochi" }], places: [], sources: [], data: {},
    settings: { safeGuides: false, collision: true, readSpeed: 3, tickerSpeed: "normal", aiLabel: false } };
}

/** A 60 s sequence (m1 + a 50 s clip on V1, 25 fps) with a three-story rundown. */
function edit(): EditProject {
  const p = project();
  p.media.push(media("long", { duration: 1250 }));
  let s = put(p, seqOf(p), "m1", 0);
  s = put(p, s, "long", 250);
  p.sequences = [s];
  p.newsroom = nrDoc([
    { id: "s1", slug: "PUNE RAINS", headline: "Heavy rain lashes Pune, schools shut", strap: "IMD issues orange alert", reporter: "p1", location: "Pune",
      points: ["120 mm in 24 hours", "Schools shut on Friday"], ticker: ["Pune: schools shut tomorrow"] },
    { id: "s2", slug: "MARKETS", headline: "Sensex ends 400 points higher" },
    { id: "s3", slug: "CRICKET", headline: "India level the series", ticker: ["India win by 5 wickets"] },
  ]);
  return p;
}

/** A stand-in for nr-core's addGraphic: the clip on a track per role, overwriting. */
function fakeAdd(p: EditProject, t: GfxTemplate | string, o: AddGraphicOptions): string {
  const tp = typeof t === "string" ? undefined : t;
  const i = p.sequences.findIndex((s) => s.id === (o.seqId ?? p.activeSequenceId));
  let s: Sequence = p.sequences[i];
  let track = s.tracks.find((x) => x.gfxRole === tp?.role);
  if (!track) { const r = addTrack(s, "video"); s = { ...r.seq, tracks: r.seq.tracks.map((x) => (x.id === r.trackId ? { ...x, gfxRole: tp?.role } : x)) }; track = s.tracks.find((x) => x.id === r.trackId)!; }
  const r = addGenerated(s, ctxOf(p), track.id, o.at, o.duration ?? 100, { type: "graphic", gfx: { template: tp?.id ?? String(t), values: { ...(o.values ?? {}) } } }, tp?.name ?? "Graphic");
  p.sequences[i] = r.seq;
  return r.clipId;
}

test("ranges: an even split snapped to the cut on V1, in rundown order", () => {
  const p = edit();
  const r = storyRanges(seqOf(p), p.newsroom!.rundown, "auto");
  assert.equal(r.length, 3);
  assert.equal(r[0].start, 0);
  // 1500 frames / 3 = 500 → no cut near 500 (cuts at 0, 250, 1500): the 1st boundary snaps to 250? only within half a share
  assert.equal(r[0].end, 250);
  assert.equal(r[0].from, "cuts");
  assert.equal(r[2].end, 1500);
  for (let i = 1; i < r.length; i++) assert.equal(r[i].start, r[i - 1].end);
  const even = storyRanges(seqOf(p), p.newsroom!.rundown, "even");
  assert.deepEqual(even.map((x) => [x.start, x.end]), [[0, 500], [500, 1000], [1000, 1500]]);
});

test("ranges: a story's own range and markers named like the slug win", () => {
  const p = edit();
  const s = seqOf(p);
  s.markers = [{ id: "m1", frame: 900, duration: 0, name: "Markets", color: "#fff" }];
  const st = p.newsroom!.rundown;
  st[0] = { ...st[0], start: 10, end: 400 };
  const r = storyRanges(s, st, "auto");
  assert.deepEqual([r[0].start, r[0].end, r[0].from], [10, 400, "story"]);
  assert.deepEqual([r[1].start, r[1].end, r[1].from], [900, 1500, "marker"]);
  // markers mode ignores the story's own range
  assert.equal(storyRanges(s, st, "markers")[0].from, "cuts");
});

test("hold: words at the reading speed, within limits; fixed templates keep their length", () => {
  assert.equal(holdSeconds(headline, { headline: "One two three" }), 4);
  const long = Array.from({ length: 40 }, () => "word").join(" ");
  assert.equal(holdSeconds(headline, { headline: long }), 12);
  assert.equal(holdSeconds({ ...headline, hold: "fixed", seconds: 7 }, {}), 7);
});

test("plan: each story's straps, board and ticker inside its range, tagged", () => {
  const p = edit();
  const plan = planBuild(p, { templates: TEMPLATES, ranges: "even" });
  const s1 = plan.items.filter((x) => x.storyId === "s1");
  assert.deepEqual(s1.map((x) => x.part), ["headline", "reporter", "points", "ticker"]);
  const [h, r, pts, tk] = s1;
  assert.equal(h.at, 13);                       // half a second in
  assert.equal(h.values.headline, "Heavy rain lashes Pune, schools shut");
  assert.equal(h.values.strap, "IMD issues orange alert");
  assert.equal(r.values.name, "Asha Menon");
  assert.equal(r.values.role, "Senior correspondent");
  assert.equal(r.values.loc, "Pune");
  assert.ok(r.at >= h.at + h.duration);
  assert.deepEqual(pts.values.points, [{ text: "120 mm in 24 hours" }, { text: "Schools shut on Friday" }]);
  assert.ok(pts.at >= r.at + r.duration && pts.at + pts.duration <= 500);
  assert.deepEqual([tk.at, tk.duration], [0, 500]);
  assert.deepEqual(tk.values.items, [{ text: "Pune: schools shut tomorrow" }]);
  for (const it of plan.items) assert.equal(it.values[BUILD_TAG], `${it.storyId}:${it.part}`);
  // the story with only a headline gets only its strap
  assert.deepEqual(plan.items.filter((x) => x.storyId === "s2").map((x) => x.part), ["headline"]);
  assert.equal(plan.remove.length, 0);
});

test("plan: parts can be left out, and short stories are skipped with a note", () => {
  const p = edit();
  const plan = planBuild(p, { templates: TEMPLATES, parts: { ticker: false, points: false }, ranges: "even" });
  assert.ok(!plan.items.some((x) => x.part === "ticker" || x.part === "points"));
  p.newsroom!.rundown[1] = { ...p.newsroom!.rundown[1], start: 600, end: 630 };
  const short = planBuild(p, { templates: TEMPLATES });
  assert.ok(short.notes.some((n) => n.startsWith("MARKETS")));
  assert.ok(!short.items.some((x) => x.storyId === "s2"));
});

test("apply: places the plan, remembers ranges, and building again replaces instead of doubling", () => {
  const p = edit();
  const plan = planBuild(p, { templates: TEMPLATES, ranges: "even" });
  const ids = applyBuild(p, plan, { addGraphic: fakeAdd });
  assert.equal(ids.length, plan.items.length);
  const s = seqOf(p);
  assert.equal(builtClips(s).length, plan.items.length);
  assert.ok(builtClips(s, "s1").every((c) => c.source.type === "graphic" && buildTagOf(c.source.gfx)?.startsWith("s1:")));
  assert.deepEqual([p.newsroom!.rundown[0].start, p.newsroom!.rundown[0].end], [0, 500]);
  // run again: the earlier ones are replaced
  const again = planBuild(p, { templates: TEMPLATES });
  assert.equal(again.remove.length, ids.length);
  applyBuild(p, again, { addGraphic: fakeAdd });
  assert.equal(builtClips(seqOf(p)).length, again.items.length);
  // the pictures are untouched
  const v1 = tracksOf(seqOf(p), "video")[0];
  assert.equal(seqOf(p).clips.filter((c) => c.trackId === v1.id).length, 2);
});

test("apply: building one story leaves the others; a deleted story's graphics go on a full build", () => {
  const p = edit();
  applyBuild(p, planBuild(p, { templates: TEMPLATES, ranges: "even" }), { addGraphic: fakeAdd });
  const before = builtClips(seqOf(p)).length;
  const one = planBuild(p, { templates: TEMPLATES, only: ["s3"] });
  assert.ok(one.remove.length > 0 && one.items.every((x) => x.storyId === "s3"));
  applyBuild(p, one, { addGraphic: fakeAdd });
  assert.equal(builtClips(seqOf(p)).length, before);
  p.newsroom!.rundown = p.newsroom!.rundown.filter((x) => x.id !== "s2");
  const full = planBuild(p, { templates: TEMPLATES });
  assert.ok(builtClips(seqOf(p), "s2").every((c) => full.remove.includes(c.id)));
});

test("plan: a story's own templates take over their part", () => {
  const p = edit();
  const alt = { ...headline, id: "t.alt", name: "Alt headline" };
  p.newsroom!.rundown[1].graphics = ["t.alt"];
  const plan = planBuild(p, { templates: TEMPLATES, templateById: (id) => (id === "t.alt" ? alt : undefined), ranges: "even" });
  assert.equal(plan.items.find((x) => x.storyId === "s2")?.template.id, "t.alt");
  assert.equal(plan.items.find((x) => x.storyId === "s1")?.template.id, "t.headline");
});

test("plan: an edit without a rundown says so", () => {
  const p = project();
  const plan = planBuild(p, { templates: TEMPLATES });
  assert.equal(plan.items.length, 0);
  assert.ok(plan.notes.length);
});
