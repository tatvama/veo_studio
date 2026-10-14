/**
 * News Room data (docs/EDITOR.md §16.10): numbers as newsrooms write them, columns found by name (English and Hindi),
 * the six mappers (headlines, weather, markets, score, election, rates), template → mapper suggestions, binding paths,
 * and sources in an edit: add, bind, refresh (frozen snapshot, failed refresh keeps the last rows), remove.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addGenerated, ctxOf } from "../model/ops.ts";
import type { EditProject } from "../model/types.ts";
import { addSource, applyBindings, bindField, graphicsUsing, parseBindPath, refreshSource, removeSource, suggestBindings, valueFor } from "../newsroom/feeds/bind.ts";
import { conditionIcon, findCol, latinDigits, MAPPERS, num, suggestMapper } from "../newsroom/feeds/mappers.ts";
import { snapshotFrom } from "../newsroom/feeds/snapshot.ts";
import { field, items, text, tpl } from "../newsroom/templates/kit.ts";
import type { DataSnapshot, GfxInstance, GfxTableRow } from "../newsroom/types.ts";
import { project, V } from "./fixtures.ts";

test("numbers: rupees, grouping, signs, arrows, brackets and native digits", () => {
  assert.equal(num("₹ 1,23,456.50"), 123456.5);
  assert.equal(num("−0.42%"), -0.42);
  assert.equal(num("▼ 12.5"), -12.5);
  assert.equal(num("▲ 3"), 3);
  assert.equal(num("(3.5)"), -3.5);
  assert.equal(num("+412 pts"), 412);
  assert.equal(num("Rs. 96.72/litre"), 96.72);
  assert.equal(num("२४°"), 24);
  assert.equal(num(".5"), 0.5);
  assert.equal(num("n/a"), undefined);
  assert.equal(num(""), undefined);
  assert.equal(num(Infinity), undefined);
  assert.equal(latinDigits("೨೦೨೬ / ௧௨"), "2026 / 12");
});

test("columns are found by name, English or Hindi, exact before partial", () => {
  const cols = ["City Name", "Temp (°C)", "Max Temp", "Min Temp", "मौसम"];
  assert.equal(findCol(cols, ["temp", "temperature"]), "Temp (°C)");
  assert.equal(findCol(cols, ["max"]), "Max Temp");
  assert.equal(findCol(cols, ["condition", "मौसम"]), "मौसम");
  assert.equal(findCol(cols, ["city"]), "City Name");
  assert.equal(findCol(cols, ["temp"], ["Temp (°C)"]), "Max Temp", "contains, when nothing matches exactly");
  assert.equal(findCol(["a", "b"], ["zzz"]), undefined);
});

test("weather: city, temperature, condition → icon (English and Hindi)", () => {
  const rows: GfxTableRow[] = [
    { City: "Mumbai", "Temp °C": 31, Condition: "Heavy rain" }, { City: "Delhi", "Temp °C": "38", Condition: "Haze" },
    { City: "बेंगलुरु", "Temp °C": "२४", Condition: "बादल" }, { City: "", "Temp °C": 1, Condition: "x" },
  ];
  const m = MAPPERS.weather.map(rows);
  assert.deepEqual(m.items, [
    { text: "Mumbai", icon: "rain", value: 31 }, { text: "Delhi", icon: "fog", value: 38 }, { text: "बेंगलुरु", icon: "cloud", value: 24 },
  ]);
  assert.deepEqual(m.rows[0], { city: "Mumbai", temp: 31, min: "", max: "", condition: "Heavy rain", icon: "rain" });
  assert.equal(conditionIcon("Thunderstorms likely"), "storm");
  assert.equal(conditionIcon("Partly cloudy"), "cloud_sun");
  assert.equal(conditionIcon("Clear"), "sun");
  assert.equal(conditionIcon("आंधी"), "storm");
  // min / max columns don't get taken for the temperature
  const mm = MAPPERS.weather.map([{ city: "Pune", min: 19, max: 30, sky: "Sunny" }]);
  assert.deepEqual(mm.items[0], { text: "Pune", icon: "sun", value: 30 });
  assert.deepEqual(mm.rows[0], { city: "Pune", temp: 30, min: 19, max: 30, condition: "Sunny", icon: "sun" });
});

test("markets: value, change and change % (either one fills the other)", () => {
  const m = MAPPERS.markets.map([
    { Index: "SENSEX", Value: "81,234.56", Change: "+412.30", "Change %": "0.51%" },
    { Index: "NIFTY 50", Value: 24810, Change: "−88.1", "Change %": "" },
  ]);
  assert.deepEqual(m.items[0], { text: "SENSEX", value: 81234.56, delta: 412.3 });
  assert.equal(m.items[1].delta, -88.1);
  assert.equal(m.rows[1].pct, -0.35);
  const gold = MAPPERS.markets.map([{ Name: "Gold", Price: 7250, "%": "-1.2" }]);
  assert.deepEqual(gold.items[0], { text: "Gold", value: 7250, delta: -88.06 });
  assert.deepEqual(gold.rows[0], { name: "Gold", value: 7250, change: -88.06, pct: -1.2 });
  assert.deepEqual(m.rows[0], { name: "SENSEX", value: 81234.56, change: 412.3, pct: 0.51 });
});

test("score, election and rates", () => {
  const s = MAPPERS.score.map([{ Team: "India", Runs: 245, Wkts: 3, Overs: "42.1", Status: "Batting" }]);
  assert.deepEqual(s.items[0], { text: "India", value: 245, tag: "245/3 (42.1)" });
  assert.deepEqual(s.rows[0], { team: "India", score: "245/3 (42.1)", detail: "Batting" });
  assert.deepEqual(MAPPERS.score.map([{ Team: "Australia", Score: "198/10" }]).items[0], { text: "Australia", value: 198, tag: "198/10" });
  const e = MAPPERS.election.map([{ Party: "BJP", Won: 120, Leading: 12, Colour: "ff9933" }, { Party: "INC", Won: "45", Leading: "", Colour: "#19AAED" }]);
  assert.deepEqual(e.items[0], { text: "BJP", value: 120, delta: 12, color: "#ff9933" });
  assert.deepEqual(e.rows[1], { party: "INC", won: 45, leading: 0, total: 45, color: "#19AAED" });
  assert.deepEqual(MAPPERS.election.map([{ दल: "दल X", जीते: 3, आगे: "२" }]).rows[0], { party: "दल X", won: 3, leading: 2, total: 5, color: "" });
  const r = MAPPERS.rates.map([{ Item: "Petrol", City: "Delhi", Price: "₹94.72", Change: "0", Unit: "litre" }]);
  assert.deepEqual(r.items[0], { text: "Petrol /litre", tag: "Delhi", value: 94.72, delta: 0 });
  assert.deepEqual(MAPPERS.rates.map([{ Commodity: "Gold 24K", Rate: "72,500" }]).items[0], { text: "Gold 24K", value: 72500 });
  const t = MAPPERS.ticker.map([{ Headline: "One", Category: "Sports", Breaking: "yes" }, { Headline: "", Category: "x" }, { Headline: "Two" }]);
  assert.deepEqual(t.items, [{ text: "One", tag: "Sports", flash: true }, { text: "Two" }]);
  // no headline column: the first text column
  assert.deepEqual(MAPPERS.ticker.map([{ id: 1, says: "Hello" }]).items, [{ text: "Hello" }]);
});

test("templates suggest their mapper", () => {
  const t = (o: { id: string; kind?: string; role?: "ticker" | "board" | "strap"; tags?: string[] }) => ({ name: "", role: "board" as const, ...o });
  assert.equal(suggestMapper(t({ id: "nr.tickers.weather", role: "ticker" })), "weather");
  assert.equal(suggestMapper(t({ id: "nr.tickers.markets", kind: "markets", role: "ticker" })), "markets");
  assert.equal(suggestMapper(t({ id: "nr.boards.cricket", kind: "scorecard" })), "score");
  assert.equal(suggestMapper(t({ id: "nr.boards.seats", tags: ["election"] })), "election");
  assert.equal(suggestMapper(t({ id: "nr.boards.rates" })), "rates");
  assert.equal(suggestMapper(t({ id: "nr.tickers.crawl", role: "ticker" })), "ticker");
  assert.equal(suggestMapper(t({ id: "nr.straps.anchor", role: "strap" })), null);
});

// ── bindings in an edit ──────────────────────────────────────────────────────

const CRAWL = tpl({ id: "test.crawl", name: "Crawl", category: "Tickers", role: "ticker", seconds: 0, loop: true,
  fields: [field.list("items", "Lines", items("Sample one", "Sample two"), { maxItems: 3 }), field.text("label", "Label", "NEWS")],
  designs: { "16:9": [text("t", [0, 980, 1920, 60], "{label}")] } });
const WEATHER = tpl({ id: "test.weather", name: "Weather board", category: "Boards", role: "board", kind: "weather", seconds: 8,
  fields: [field.table("cities", "Cities", [{ id: "city", label: "City", type: "text" }, { id: "temp", label: "Temp", type: "number" }]), field.text("title", "Title", "Weather"), field.number("top", "Top temp", 0)],
  designs: { "16:9": [text("t", [100, 100, 800, 80], "{title}")] } });

function edit(): { p: EditProject; crawl: string; weather: string } {
  const p = project();
  p.newsroom = { version: 1, look: "look.classic_red", looks: {}, templates: { [CRAWL.id]: CRAWL, [WEATHER.id]: WEATHER }, ratio: "16:9", rundown: [], people: [], places: [], sources: [], data: {},
    settings: { safeGuides: true, collision: true, readSpeed: 3, tickerSpeed: "normal", aiLabel: true } };
  let s = p.sequences[0];
  const g = (template: string, values = {}): { type: "graphic"; gfx: GfxInstance } => ({ type: "graphic", gfx: { template, values } });
  const a = addGenerated(s, ctxOf(p), V(s, 1).id, 0, 250, g(CRAWL.id), "Crawl");
  s = a.seq;
  const b = addGenerated(s, ctxOf(p), V(s, 2).id, 50, 200, g(WEATHER.id, { title: "Mausam" }), "Weather");
  p.sequences[0] = b.seq;
  return { p, crawl: a.clipId, weather: b.clipId };
}
const gfxOf = (p: EditProject, id: string) => (p.sequences[0].clips.find((c) => c.id === id)!.source as { gfx: GfxInstance }).gfx;

test("binding paths", () => {
  assert.deepEqual(parseBindPath(), {});
  assert.deepEqual(parseBindPath("@markets"), { mapper: "markets" });
  assert.deepEqual(parseBindPath("@ticker:Title"), { mapper: "ticker", column: "Title" });
  assert.deepEqual(parseBindPath("Headline#3"), { column: "Headline", row: 2 });
  assert.deepEqual(parseBindPath("Price"), { column: "Price" });
  const snap: DataSnapshot = { source: "s", at: "", rows: [{ Headline: "A", n: "1,200" }, { Headline: "B", n: 7 }, { Headline: "C", n: 9 }, { Headline: "D", n: 1 }] };
  assert.deepEqual(valueFor(CRAWL.fields[0], { source: "s", path: "Headline" }, snap), [{ text: "A" }, { text: "B" }, { text: "C" }], "list capped at maxItems");
  assert.deepEqual(valueFor(CRAWL.fields[0], { source: "s", path: "Headline#2" }, snap), [{ text: "B" }]);
  assert.equal(valueFor(CRAWL.fields[1], { source: "s", path: "Headline#4" }, snap), "D");
  assert.equal(valueFor(WEATHER.fields[2], { source: "s", path: "n" }, snap), 1200);
  assert.equal(valueFor(CRAWL.fields[1], { source: "s", path: "nope" }, snap), undefined);
  assert.equal(valueFor(CRAWL.fields[0], { source: "s" }, undefined), undefined);
  assert.equal(valueFor(field.longtext("body", "Body"), { source: "s", path: "Headline" }, snap), "A\nB\nC\nD");
  // numbered fields take that row of a column (a score bug's team1 / score2)
  const SCORE = tpl({ id: "t.score", name: "Score bug", category: "Tickers", role: "ticker", kind: "score", seconds: 0,
    fields: [field.text("team1", "Team 1", "IND"), field.text("score1", "Score 1", ""), field.text("team2", "Team 2", ""), field.text("score2", "Score 2", ""), field.text("overs", "Overs", "")],
    designs: { "16:9": [text("t", [100, 60, 400, 60], "{team1}")] } });
  const sc: DataSnapshot = { source: "s", at: "", rows: [{ Team: "IND", Score: "245/4", Overs: "38.2" }, { Team: "AUS", Score: "", Overs: "" }] };
  assert.deepEqual(suggestBindings(SCORE, "s", sc), {
    team1: { source: "s", path: "Team" }, score1: { source: "s", path: "Score" }, team2: { source: "s", path: "Team#2" }, score2: { source: "s", path: "Score#2" }, overs: { source: "s", path: "Overs" } });
  assert.equal(valueFor(SCORE.fields[2], { source: "s", path: "Team#2" }, sc), "AUS");
});

test("sources: add, bind with suggestions, refresh freezes and updates graphics, a failed refresh keeps rows, remove", () => {
  const { p, crawl, weather } = edit();
  const news = addSource(p, { name: "Top stories", kind: "rss", url: "https://example.com/rss" });
  const wx = addSource(p, { name: "Weather", kind: "csv", url: "https://example.com/w.csv" });
  assert.equal(news, "src.top_stories");
  assert.equal(addSource(p, { name: "Top stories", kind: "csv" }), "src.top_stories_2");
  // bind before any refresh: nothing changes yet
  bindField(p, crawl, "items", { source: news });
  assert.deepEqual(gfxOf(p, crawl).bind, { items: { source: news } });
  assert.deepEqual(gfxOf(p, crawl).values, {});
  const rss = `<rss><channel><item><title>Mumbai rains</title><category>City</category></item><item><title>Sensex up</title></item></channel></rss>`;
  const n = refreshSource(p, news, snapshotFrom(p.newsroom!.sources[0], rss, "2026-10-14T14:12:00.000Z"));
  assert.equal(n, 1);
  assert.deepEqual(gfxOf(p, crawl).values.items, [{ text: "Mumbai rains", tag: "City" }, { text: "Sensex up" }]);
  assert.equal(p.newsroom!.data[news].at, "2026-10-14T14:12:00.000Z");
  // the weather board: suggestions by its kind, then a refresh fills the table through the weather mapper
  const csv = "City,Temp,Sky\nMumbai,31,Rain\nDelhi,38,Haze\n";
  const snap = snapshotFrom(p.newsroom!.sources[1], csv, "2026-10-14T14:00:00.000Z");
  const sug = suggestBindings(WEATHER, wx, snap);
  assert.deepEqual(sug, { cities: { source: wx, path: "@weather" } });
  for (const [f, b] of Object.entries(sug)) bindField(p, weather, f, b);
  bindField(p, weather, "top", { source: wx, path: "Temp#2" });
  refreshSource(p, wx, snap);
  assert.deepEqual(gfxOf(p, weather).values.cities, [{ city: "Mumbai", temp: 31 }, { city: "Delhi", temp: 38 }]);
  assert.equal(gfxOf(p, weather).values.top, 38);
  assert.equal(gfxOf(p, weather).values.title, "Mausam", "unbound values stay");
  assert.equal(applyBindings(p, weather), false, "nothing new");
  assert.deepEqual(graphicsUsing(p, wx).map((g) => [g.clipId, g.fields]), [[weather, ["cities", "top"]]]);
  // a failed refresh keeps the last good rows and says why
  assert.equal(refreshSource(p, wx, { source: wx, at: "2026-10-15T10:00:00.000Z", rows: [], error: "Offline" }), 0);
  assert.equal(p.newsroom!.data[wx].rows.length, 2);
  assert.equal(p.newsroom!.data[wx].error, "Offline");
  assert.equal(p.newsroom!.data[wx].at, "2026-10-14T14:00:00.000Z");
  // a good refresh clears the error
  refreshSource(p, wx, snapshotFrom(p.newsroom!.sources[1], "City,Temp\nPune,29\n", "2026-10-15T11:00:00.000Z"));
  assert.equal(p.newsroom!.data[wx].error, undefined);
  assert.deepEqual(gfxOf(p, weather).values.cities, [{ city: "Pune", temp: 29 }]);
  // unbinding keeps the value; removing a source drops its bindings and snapshot
  bindField(p, weather, "top", null);
  assert.equal(gfxOf(p, weather).values.top, 38);
  removeSource(p, wx);
  assert.equal(gfxOf(p, weather).bind, undefined);
  assert.equal(p.newsroom!.data[wx], undefined);
  assert.deepEqual(gfxOf(p, weather).values.cities, [{ city: "Pune", temp: 29 }]);
});
