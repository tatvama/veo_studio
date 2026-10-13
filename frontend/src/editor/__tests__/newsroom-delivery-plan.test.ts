/**
 * News delivery (docs/EDITOR.md §16.11), the pure parts the render window and the panel share: names, the
 * spreadsheet reader, what a news export draws (language, graphics only, the black/white matte), the export options
 * per section, and the generated-sequence building blocks (graphics tracks in order, a range cut out and moved).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ctxOf, tracksOf } from "../model/ops.ts";
import type { TimelineClip } from "../model/types.ts";
import { blankSequence, gfxTrack, graphicsOf, sliceSequence, ROLE_ORDER } from "../newsroom/delivery/build.ts";
import { guessDelimiter, parseRecords, parseTable } from "../newsroom/delivery/csv.ts";
import { deliveryName, ratioTag, safeName, uniqueNames } from "../newsroom/delivery/names.ts";
import { bothRatios, generated, isAlpha, languageVersions, markedRange, transparent, tvDelivery, TV_OPTIONS } from "../newsroom/delivery/plan.ts";
import { editLanguages, graphicsOnly, hexRgb, matteFromPair, prepareNewsProject, seqRatio, withLanguage } from "../newsroom/delivery/prepare.ts";
import type { GfxRole } from "../newsroom/types.ts";
import { project, put, seqOf, V } from "./fixtures.ts";
import { newsProject } from "./newsroom-delivery-fixtures.ts";

test("names: safe, tagged, unique", () => {
  assert.equal(ratioTag("9:16"), "9x16");
  assert.equal(safeName('  Bulletin: "Mumbai / rains"?  '), "Bulletin - 'Mumbai - rains'");
  assert.equal(safeName("a<b>*c|d\\e"), "abc-d-e");
  assert.equal(safeName("con"), "_con");
  assert.equal(safeName("..."), "News");
  assert.equal(deliveryName("Evening bulletin", { ratio: "9:16", lang: "hi" }), "Evening bulletin_9x16_hi");
  assert.equal(deliveryName("Ticker", { suffix: "graphics" }), "Ticker_graphics");
  assert.deepEqual(uniqueNames(["Row", "row", "Row", "Other"]), ["Row", "row_2", "Row_3", "Other"]);
});

test("CSV: quotes, commas and line breaks in cells, semicolons, tabs, a BOM, blank and repeated headers", () => {
  const csv = '\uFEFFName,Role,"Quote, long"\r\nPriya Rao,Anchor,"She said ""hello""\nand left"\r\n\r\n"Amit, Jr",Reporter,\n';
  assert.equal(guessDelimiter(csv), ",");
  const t = parseTable(csv);
  assert.deepEqual(t.columns, ["Name", "Role", "Quote, long"]);
  assert.deepEqual(t.rows, [{ Name: "Priya Rao", Role: "Anchor", "Quote, long": 'She said "hello"\nand left' }, { Name: "Amit, Jr", Role: "Reporter", "Quote, long": "" }]);
  assert.equal(guessDelimiter("a;b;c\n1;2;3"), ";");
  assert.deepEqual(parseRecords("a\tb\n1\t2"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseTable("Name,,Name\nx,y,z").columns, ["Name", "Column 2", "Name 2"]);
  assert.deepEqual(parseTable(""), { columns: [], rows: [] });
});

test("graphics tracks go in the News Room's order; Background under V1", () => {
  let s = blankSequence("x", { width: 1920, height: 1080, fps: 25 });
  for (const r of ["bug", "strap", "background", "ticker", "layout"] as GfxRole[]) s = gfxTrack(s, r).seq;
  const order = tracksOf(s, "video").map((t) => t.gfxRole ?? t.name);
  assert.deepEqual(order, ["background", "V1", "layout", "strap", "ticker", "bug"]);
  assert.equal(gfxTrack(s, "strap").seq, s, "an existing role track is reused");
  assert.deepEqual(ROLE_ORDER, ["layout", "board", "strap", "ticker", "bug", "wipe"]);
});

test("a range cut out of a sequence: clips cut at the edges, moved, transitions inside kept", () => {
  const { p, s } = newsProject();
  const out = sliceSequence(p, s, 20, 80, 50, "Story");
  assert.notEqual(out.id, s.id);
  const v1 = V(out, 0).id;
  const pic = out.clips.find((c) => c.trackId === v1)!;
  assert.deepEqual([pic.start, pic.duration, (pic.source as { in: number }).in], [50, 60, 20]);
  const strap = graphicsOf(out, "strap")[0];
  assert.deepEqual([strap.start, strap.duration], [50, 40], "the strap 10..60 → 20..60 → moved to 50");
  assert.equal(graphicsOf(out, "ticker")[0].start, 50);
  assert.ok(out.clips.every((c) => c.start >= 50 && c.start + c.duration <= 110));
});

test("language versions: a graphic's langs values win; languages listed from the edit", () => {
  const { p, strapId } = newsProject();
  const hi = withLanguage(p, "hi");
  const c = hi.sequences[0].clips.find((x) => x.id === strapId)!;
  assert.deepEqual((c.source as { gfx: { values: Record<string, unknown> } }).gfx.values, { headline: "मुंबई में भारी बारिश" });
  assert.equal(withLanguage(p, "ta"), p, "nothing in that language: the same edit");
  assert.deepEqual(editLanguages(p), ["en", "kn", "hi"]);
});

test("graphics only: the graphics tracks (of some roles / clips), nothing else", () => {
  const { p, s, strapId, tickerId } = newsProject();
  const all = graphicsOnly(p, s.id).sequences[0];
  assert.deepEqual(all.clips.map((c) => c.id).sort(), [strapId, tickerId].sort());
  assert.deepEqual(graphicsOnly(p, s.id, { roles: ["ticker"] }).sequences[0].clips.map((c) => c.id), [tickerId]);
  assert.deepEqual(graphicsOnly(p, s.id, { clipIds: [strapId] }).sequences[0].clips.map((c) => c.id), [strapId]);
  const prep = prepareNewsProject(p, s.id, { only: "graphics", lang: "hi", roles: ["strap"] });
  assert.equal(prep.sequenceId, s.id);
  const g = prep.project.sequences[0].clips as TimelineClip[];
  assert.equal(g.length, 1);
  assert.equal((g[0].source as unknown as { gfx: { values: { headline: string } } }).gfx.values.headline, "मुंबई में भारी बारिश");
  assert.equal(prepareNewsProject(p, s.id, { ratio: "16:9" }).project, p, "the sequence is 16:9 already: no companion");
});

test("the black / white matte gives straight alpha", () => {
  // a 50 % red pixel, an opaque blue one, an empty one
  const black = new Uint8Array([128, 0, 0, 255, 0, 0, 255, 255, 0, 0, 0, 255]);
  const white = new Uint8Array([255, 127, 127, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  assert.deepEqual([...matteFromPair(black, white)], [255, 0, 0, 128, 0, 0, 255, 255, 0, 0, 0, 0]);
  const inPlace = black.slice();
  assert.equal(matteFromPair(inPlace, white, inPlace), inPlace);
  assert.deepEqual(hexRgb("#ff8000"), [1, 128 / 255, 0]);
  assert.deepEqual(hexRgb("red"), [0, 0, 0]);
  assert.equal(seqRatio(1920, 1080), "16:9");
  assert.equal(seqRatio(1080, 1920), "9:16");
  assert.equal(seqRatio(1080, 1350), "4:5");
});

test("export options: both ratios, transparent, language versions, TV, generated", () => {
  const { s } = newsProject();
  const b = { editPath: "C:/E/News.tatvamedit", sequence: { ...s, name: "Evening" } };
  const two = bothRatios(b, { loudness: "youtube" });
  assert.deepEqual(two.map((o) => [o.name, o.ratio ?? null, o.codec, o.only]), [["Evening_16x9", null, "mp4", "all"], ["Evening_9x16", "9:16", "mp4", "all"]]);
  const vert = bothRatios({ ...b, sequence: { ...b.sequence, width: 1080, height: 1920 } });
  assert.deepEqual(vert.map((o) => [o.name, o.ratio ?? null]), [["Evening_16x9", "16:9"], ["Evening_9x16", null]]);
  const tr = transparent(b, "webm_alpha", { roles: ["ticker"], suffix: "Ticker", ratio: "9:16" });
  assert.deepEqual([tr.codec, tr.only, tr.roles, tr.ratio, tr.name], ["webm_alpha", "graphics", ["ticker"], "9:16", "Evening_9x16_Ticker"]);
  const lv = languageVersions(b, ["hi", "kn"], { ratio: "9:16" });
  assert.deepEqual(lv.map((o) => [o.lang, o.name, o.only]), [["hi", "Evening_9x16_hi", "all"], ["kn", "Evening_9x16_kn", "all"]]);
  const tv = tvDelivery(b);
  assert.deepEqual([tv[0].preset, tv[0].loudness, tv[0].legal, tv[0].name], [TV_OPTIONS.preset, "ebu_r128", true, "Evening TV"]);
  assert.equal(tvDelivery(b, { both: true }).length, 2);
  const g = generated(b.editPath, s, { codec: "prores4444", name: "Row 1", range: { in: 5, out: 30 }, templates: {} });
  assert.deepEqual([g.only, g.sequenceId, g.sequences!.length, g.range, "templates" in g], ["graphics", s.id, 1, { in: 5, out: 30 }, false]);
  assert.ok(isAlpha("png") && !isAlpha("mp4"));
  assert.deepEqual(markedRange({ ...s, inPoint: 10, outPoint: 49 }), { in: 10, out: 50 });
  assert.equal(markedRange(s), undefined);
});

test("the slice keeps clips' sources right on a sped-up clip too", () => {
  const p = project();
  const s0 = put(p, seqOf(p), "m2", 0, { in: 50, out: 149 });
  const fast = { ...s0, clips: s0.clips.map((c) => ({ ...c, speed: 2, duration: 50 })) };
  const out = sliceSequence(p, fast, 10, 30, 0, "x");
  const v = out.clips.find((c) => c.trackId === V(out, 0).id)!;
  assert.deepEqual([v.start, v.duration, (v.source as { in: number }).in], [0, 20, 70]);
  assert.ok(ctxOf(p));
});
