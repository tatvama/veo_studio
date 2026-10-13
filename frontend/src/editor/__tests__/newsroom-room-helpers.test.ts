/** News Room room helpers (editor/newsroom/room/*.ts): people / story → blanks, CSV and paste import, find and
 *  replace, the playlist, template picking and the starter set. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addGenerated, addTrack, ctxOf, seqEnd } from "../model/ops.ts";
import type { EditProject } from "../model/types.ts";
import type { AddGraphicOptions } from "../newsroom/commands.ts";
import { mapColumns, parseCsv, parseNumber, slugOf, splitCell, storiesFromLines, storiesFromRows, tableFromText } from "../newsroom/room/csv.ts";
import { airTimeOf, moveItem, updateGraphic, updateStory } from "../newsroom/room/doc.ts";
import { coerce, fillKey, fillSource, graphicLabel, lengthHint, valueIn, valuesFromPerson, valuesFromPlace, valuesFromStory } from "../newsroom/room/fields.ts";
import { findInGraphics, replaceInGraphics } from "../newsroom/room/textSearch.ts";
import { pickTemplate, WANT } from "../newsroom/room/pick.ts";
import { addEntry, moveEntry, removeEntry } from "../newsroom/room/playlist.ts";
import { applyStarterSet, contentEnd, fitLoopsToEnd, SAMPLE_LINES } from "../newsroom/room/starter.ts";
import { field, rect, tpl } from "../newsroom/templates/kit.ts";
import type { GfxTemplate, NewsroomDoc, Person } from "../newsroom/types.ts";
import { project, put, seqOf } from "./fixtures.ts";

const strap = tpl({ id: "nr.straps.guest", name: "Guest", category: "Straps", role: "strap", kind: "guest", seconds: 6,
  fields: [field.text("name", "Name", "Priya Rao", { fill: "person.name", maxLength: 10 }), field.text("role", "Role", "", { fill: "person.role" }),
    field.image("photo", "Photo", { fill: "person.photo" }), field.text("city", "City", "", { fill: "place" })],
  designs: { "16:9": [rect("p", [0, 0, 10, 10])] } });
const bare = tpl({ id: "x.bare", name: "Bare", category: "Straps", role: "strap", seconds: 6,
  fields: [field.text("headline", "Headline"), field.longtext("points", "Points"), field.text("location", "Where")], designs: {} });
const asha: Person = { id: "p1", name: "Asha Menon", role: "Correspondent", location: "Kochi", photo: { mediaId: "m9" }, names: { hi: "आशा मेनन" } };

test("fields: fill sources and keys, by fill or by id", () => {
  assert.equal(fillSource(strap.fields[0]), "person");
  assert.equal(fillSource(strap.fields[3]), "place");
  assert.equal(fillKey(bare.fields[0]), "story.headline");
  assert.equal(fillKey(bare.fields[2]), "place");
  assert.equal(fillKey(field.text("zzz", "Zzz")), null);
});

test("fields: a person fills name, role, photo and location together, in a language", () => {
  assert.deepEqual(valuesFromPerson(strap, asha), { name: "Asha Menon", role: "Correspondent", photo: { mediaId: "m9" }, city: "Kochi" });
  assert.equal(valuesFromPerson(strap, asha, "hi").name, "आशा मेनन");
  assert.equal(valuesFromPerson(strap, asha, "kn").name, "Asha Menon");
  assert.deepEqual(valuesFromPlace(strap, { id: "pl", name: "Mysuru", names: { kn: "ಮೈಸೂರು" } }, "kn"), { city: "ಮೈಸೂರು" });
});

test("fields: a story fills by id when the template has no fill hints; lines become the field's shape", () => {
  const v = valuesFromStory(bare, { id: "s", slug: "X", headline: "Rain in Pune", points: ["One", "Two"], location: "Pune" });
  assert.deepEqual(v, { headline: "Rain in Pune", points: "One\nTwo", location: "Pune" });
  assert.deepEqual(coerce(field.list("l", "L", [], { maxItems: 1 }), "a\nb"), [{ text: "a" }]);
  assert.equal(coerce(field.image("i", "I"), "x"), undefined);
});

test("fields: length hints count letters (not bytes) and lines; values per language fall back", () => {
  assert.deepEqual(lengthHint(strap.fields[0], "प्रिया राव"), { text: "5 / 10", over: false });
  assert.equal(lengthHint(strap.fields[0], "A very long name")?.over, true);
  assert.deepEqual(lengthHint(field.list("l", "L", [], { maxItems: 3 }), [{ text: "a" }, { text: "b" }]), { text: "2 / 3 lines", over: false });
  const g = { template: "t", values: { name: "Asha" }, langs: { hi: { name: "आशा" }, kn: { name: "" } } };
  assert.equal(valueIn(g, strap.fields[0], "hi"), "आशा");
  assert.equal(valueIn(g, strap.fields[0], "kn"), "Asha");
  assert.equal(valueIn(g, strap.fields[1]), "");
  assert.equal(graphicLabel(strap, { name: "" }), "Guest");
  assert.equal(graphicLabel(strap, {}), "Priya Rao");
});

test("csv: quotes, doubled quotes, new lines in cells, BOM, semicolons and tabs", () => {
  assert.deepEqual(parseCsv('﻿slug,headline\r\nA,"Rain, wind and ""floods"""\r\n\r\nB,"two\nlines"\n'), [["slug", "headline"], ["A", 'Rain, wind and "floods"'], ["B", "two\nlines"]]);
  assert.deepEqual(parseCsv("a;b;c\n1;2;3"), [["a", "b", "c"], ["1", "2", "3"]]);
  assert.deepEqual(parseCsv("a\tb\n1,5\t2"), [["a", "b"], ["1,5", "2"]]);
});

test("csv: rundown columns by header names; reporters matched or added", () => {
  const m = mapColumns(["Story Slug", "Title", "Strapline", "Correspondent", "Dateline", "Key points", "Ticker", "Remarks"]);
  assert.deepEqual([m.slug, m.headline, m.strap, m.reporter, m.location, m.points, m.ticker, m.notes, m.status], [0, 1, 2, 3, 4, 5, 6, 7, -1]);
  let n = 0;
  const id = (p: string) => `${p}_${++n}`;
  const rows = parseCsv("Slug,Headline,Reporter,Points\nRAINS,Rain in Pune,asha menon,One | Two\n,Sensex up 400,Ravi Kumar,\n,,,");
  const r = storiesFromRows(rows, [asha], id);
  assert.equal(r.stories.length, 2);
  assert.equal(r.stories[0].reporter, "p1");
  assert.deepEqual(r.stories[0].points, ["One", "Two"]);
  assert.equal(r.stories[1].slug, "SENSEX UP");
  assert.equal(r.people.length, 1);
  assert.equal(r.stories[1].reporter, r.people[0].id);
  // no header: columns in order
  const plain = storiesFromRows([["A", "Head A"]], [], id);
  assert.deepEqual([plain.stories[0].slug, plain.stories[0].headline], ["A", "Head A"]);
});

test("csv: pasted lines, cells with several lines, numbers, table pastes", () => {
  let n = 0;
  const id = (p: string) => `${p}_${++n}`;
  const st = storiesFromLines("1. Rain lashes Pune\n- MARKETS | Sensex up | Nifty too\n\nCRICKET\tIndia win", id);
  assert.deepEqual(st.map((s) => [s.slug, s.headline, s.strap]), [["RAIN LASHES", "Rain lashes Pune", undefined], ["MARKETS", "Sensex up", "Nifty too"], ["CRICKET", "India win", undefined]]);
  assert.deepEqual(splitCell("a • b • c"), ["a", "b", "c"]);
  assert.equal(slugOf("₹500 crore plan for metro"), "500 CRORE");
  assert.equal(parseNumber("₹1,23,456.50"), 123456.5);
  assert.equal(parseNumber("(12)"), -12);
  assert.equal(parseNumber("abc"), null);
  const f = { columns: [{ id: "party", label: "Party", type: "text" as const }, { id: "seats", label: "Seats", type: "number" as const }] };
  assert.deepEqual(tableFromText("Party\tSeats\nA\t1,204\nB\t88", f), [{ party: "A", seats: 1204 }, { party: "B", seats: 88 }]);
});

/** A project with two graphic clips. */
function withGraphics(): EditProject {
  const p = project();
  const r1 = addTrack(seqOf(p), "video");
  let s = r1.seq;
  s = addGenerated(s, ctxOf(p), r1.trackId, 0, 100, { type: "graphic", gfx: { template: "a", values: { name: "Asha Menon", __rundown: "s1:headline", _auto: "speaker Pune", items: [{ text: "Rain in Pune", tag: "PUNE" }] } } }, "Strap").seq;
  s = addGenerated(s, ctxOf(p), r1.trackId, 200, 100, { type: "graphic", gfx: { template: "b", values: { rows: [{ city: "Pune", n: 4 }] }, langs: { hi: { name: "पुणे Pune" } } } }, "Board").seq;
  p.sequences = [s];
  return p;
}

test("find and replace: text, list items and tags, table cells, languages; never the room's own tags", () => {
  const p = withGraphics();
  const hits = findInGraphics(p, "pune");
  assert.deepEqual(hits.map((h) => [h.field, h.lang, h.count]), [["items", "", 2], ["rows", "", 1], ["name", "hi", 1]]);
  assert.equal(findInGraphics(p, "pune", { matchCase: true }).length, 0);
  assert.equal(findInGraphics(p, "Rain").length, 1);
  assert.equal(findInGraphics(p, "headline").length, 0);
  const n = replaceInGraphics(p, "Pune", "Mumbai");
  assert.equal(n, 4);
  const [a, b] = seqOf(p).clips.filter((c) => c.source.type === "graphic");
  assert.ok(a.source.type === "graphic" && b.source.type === "graphic");
  assert.deepEqual(a.source.gfx.values.items, [{ text: "Rain in Mumbai", tag: "MUMBAI".replace("MUMBAI", "Mumbai") }]);
  assert.equal(a.source.gfx.values.__rundown, "s1:headline");
  assert.equal(a.source.gfx.values._auto, "speaker Pune");
  assert.deepEqual(b.source.gfx.values.rows, [{ city: "Mumbai", n: 4 }]);
  assert.equal(b.source.gfx.langs?.hi.name, "पुणे Mumbai");
  assert.equal(replaceInGraphics(p, "Asha", "A.", { wholeWord: true }), 1);
});

test("playlist: F1–F12 in list order, full at twelve", () => {
  let l = addEntry(undefined, { template: "t", values: { a: 1 }, name: "One" })!;
  l = addEntry(l, { template: "t2", values: {} })!;
  assert.deepEqual(l.map((e) => e.key), ["F1", "F2"]);
  l = moveEntry(l, 1, 0);
  assert.deepEqual(l.map((e) => [e.key, e.template]), [["F1", "t2"], ["F2", "t"]]);
  assert.deepEqual(removeEntry(l, 0).map((e) => [e.key, e.template]), [["F1", "t"]]);
  let full = l;
  for (let i = 0; i < 10; i++) full = addEntry(full, { template: `x${i}`, values: {} })!;
  assert.equal(full.length, 12);
  assert.equal(addEntry(full, { template: "y", values: {} }), null);
});

const T = (id: string, category: GfxTemplate["category"], role: GfxTemplate["role"], kind: string | undefined, extra: Partial<GfxTemplate> = {}) =>
  ({ ...tpl({ id, name: id.split(".").pop()!.replace(/_/g, " "), category, role, kind, seconds: 0, fields: [], designs: {} }), ...extra });
const LIB: GfxTemplate[] = [
  T("nr.bugs.clock", "Bugs", "bug", "clock"), T("nr.bugs.logo_bug", "Bugs", "bug", undefined), T("nr.bugs.live_clock", "Bugs", "bug", "live_clock"),
  T("nr.tickers.flip", "Tickers", "ticker", "flip"), T("nr.tickers.crawl", "Tickers", "ticker", "crawl", { fields: [field.list("items", "Lines", [])] }),
  T("nr.tickers.breaking_bar", "Tickers", "ticker", "breaking"), T("nr.straps.anchor", "Straps", "strap", "anchor"),
];

test("pick: by kind, then words in the id or name, within the category", () => {
  assert.equal(pickTemplate(LIB, WANT.logoBug)?.id, "nr.bugs.logo_bug");
  assert.equal(pickTemplate(LIB, WANT.liveBug)?.id, "nr.bugs.live_clock");
  assert.equal(pickTemplate(LIB, WANT.crawl)?.id, "nr.tickers.crawl");
  assert.equal(pickTemplate(LIB, WANT.breaking)?.id, "nr.tickers.breaking_bar");
  assert.equal(pickTemplate(LIB, WANT.nameStrap)?.id, "nr.straps.anchor");
  assert.equal(pickTemplate(LIB, WANT.keyPoints), undefined);
});

function fakeDeps() {
  const added: { id: string; at: number; duration?: number; values?: unknown; trackId?: string }[] = [];
  const nr: NewsroomDoc = { version: 1, look: "look.classic_red", looks: {}, templates: {}, ratio: "16:9", rundown: [], people: [], places: [], sources: [], data: {},
    settings: { safeGuides: false, collision: true, readSpeed: 3, tickerSpeed: "normal", aiLabel: false } };
  return {
    added,
    deps: {
      ensureNewsroom: (p: EditProject) => (p.newsroom ??= nr),
      addGraphic: (_p: EditProject, t: GfxTemplate | string, o: AddGraphicOptions) => { const id = typeof t === "string" ? t : t.id; added.push({ id, at: o.at, duration: o.duration, values: o.values, trackId: o.trackId }); return `c${added.length}`; },
      ensureGfxTrack: (p: EditProject, seqId: string, role: GfxTemplate["role"]) => {
        const i = p.sequences.findIndex((s) => s.id === seqId);
        const have = p.sequences[i].tracks.find((t) => t.gfxRole === role);
        if (have) return have.id;
        const r = addTrack(p.sequences[i], "video");
        p.sequences[i] = { ...r.seq, tracks: r.seq.tracks.map((t) => (t.id === r.trackId ? { ...t, gfxRole: role, name: "Bug" } : t)) };
        return r.trackId;
      },
      applyLook: (p: EditProject, id: string) => { p.newsroom!.look = id; },
      templates: LIB,
    },
  };
}

test("starter set: logo bug, LIVE bug and a crawl with sample lines over the sequence (a minute when empty)", () => {
  const { added, deps } = fakeDeps();
  const p = project();
  const r = applyStarterSet(p, seqOf(p).id, { ratio: "both", look: "look.sports", airTime: "2026-10-14T19:00:00" }, deps);
  assert.deepEqual(added.map((a) => [a.id, a.at, a.duration]), [["nr.bugs.logo_bug", 0, 1500], ["nr.bugs.live_clock", 0, 1500], ["nr.tickers.crawl", 0, 1500]]);
  assert.deepEqual(added[2].values, { items: SAMPLE_LINES.map((text) => ({ text })) });
  assert.deepEqual([p.newsroom!.ratio, p.newsroom!.look, p.newsroom!.airTime], ["both", "look.sports", "2026-10-14T19:00:00"]);
  assert.equal(r.clipIds.length, 3);
  assert.equal(r.notes.length, 0);
  // the LIVE bug on a bug track of its own, right above the logo's
  const live = seqOf(p).tracks.find((t) => t.id === added[1].trackId)!;
  const bug = seqOf(p).tracks.find((t) => t.gfxRole === "bug" && t.id !== live.id)!;
  assert.deepEqual([live.gfxRole, live.name, live.index], ["bug", "LIVE", bug.index + 1]);
  // with footage: to its end
  const q = project();
  q.sequences = [put(q, seqOf(q), "m1", 0)];
  const f2 = fakeDeps();
  applyStarterSet(q, seqOf(q).id, { ratio: "16:9", look: "look.classic_red" }, f2.deps);
  assert.ok(f2.added.every((a) => a.duration === seqEnd(seqOf(q))));
});

test("starter set: missing templates are noted, not fatal; loops fit to the end of the pictures", () => {
  const { deps } = fakeDeps();
  const p = project();
  const r = applyStarterSet(p, seqOf(p).id, { ratio: "16:9", look: "look.classic_red" }, { ...deps, templates: [] });
  assert.equal(r.clipIds.length, 0);
  assert.equal(r.notes.length, 3);
  // fit: a 100-frame bug before 250 frames of pictures grows to 250
  const q = project();
  let s = put(q, seqOf(q), "m1", 0);
  const t = addTrack(s, "video");
  s = addGenerated(t.seq, ctxOf(q), t.trackId, 0, 100, { type: "graphic", gfx: { template: "nr.bugs.logo_bug", values: {} } }, "Bug").seq;
  q.sequences = [s];
  assert.equal(contentEnd(s), 250);
  assert.equal(fitLoopsToEnd(q, s.id, (id) => LIB.find((x) => x.id === id)?.role), 1);
  assert.equal(seqOf(q).clips.find((c) => c.source.type === "graphic")?.duration, 250);
});

test("doc: immutable story and graphic updates, list moves, air time", () => {
  const p = withGraphics();
  p.newsroom = fakeDeps().deps.ensureNewsroom(p);
  p.newsroom.rundown = [{ id: "s1", slug: "A", headline: "a" }];
  const q = updateStory(p, "s1", { headline: "b" });
  assert.notEqual(q, p);
  assert.equal(p.newsroom.rundown[0].headline, "a");
  assert.equal(q.newsroom!.rundown[0].headline, "b");
  const id = seqOf(p).clips.find((c) => c.source.type === "graphic")!.id;
  const r = updateGraphic(p, id, (g) => ({ ...g, values: { ...g.values, name: "Ravi" } }));
  const c = seqOf(r).clips.find((x) => x.id === id)!;
  assert.ok(c.source.type === "graphic" && c.source.gfx.values.name === "Ravi");
  assert.equal(updateGraphic(p, "nope", (g) => g), p);
  assert.deepEqual(moveItem([1, 2, 3], 0, 2), [2, 3, 1]);
  assert.equal(airTimeOf(new Date(2026, 9, 14, 19, 42, 40)), "2026-10-14T19:43:00");
});
