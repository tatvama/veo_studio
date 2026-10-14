/**
 * News Room data (docs/EDITOR.md §16.10): CSV / TSV edge cases (quotes, embedded line breaks, BOM, separator sniffing,
 * numbers), JSON root paths, RSS 2.0 / RSS 1.0 / Atom samples with the XML quirks feeds have, Google Sheet links, and
 * source text → snapshot (kinds recognised, web pages explained, errors kept plain).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cellValue, csvRows, parseDelimited, sniffDelimiter, toDelimited } from "../newsroom/feeds/csv.ts";
import { decodeEntities, feedDate, parseFeed, parseXml, plainText, textOf } from "../newsroom/feeds/feed.ts";
import { findLists, getPath, jsonRows, parsePath } from "../newsroom/feeds/json.ts";
import { sheetCsvUrl } from "../newsroom/feeds/sheet.ts";
import { asOf, detectKind, failedSnapshot, snapshotFrom } from "../newsroom/feeds/snapshot.ts";
import type { DataSource } from "../newsroom/types.ts";

test("CSV: quotes, doubled quotes, embedded line breaks, CRLF and a BOM", () => {
  const text = '\uFEFFheadline,city,"note"\r\n"Rain, then sun",Mumbai,"He said ""wait"""\r\n"Two\nlines",Pune,\r\n';
  assert.deepEqual(parseDelimited(text), [["headline", "city", "note"], ["Rain, then sun", "Mumbai", 'He said "wait"'], ["Two\nlines", "Pune", ""]]);
  const { columns, rows } = csvRows(text);
  assert.deepEqual(columns, ["headline", "city", "note"]);
  assert.equal(rows[1].headline, "Two\nlines");
  // blank lines and rows of empty cells are dropped; short rows get empty cells; extra cells get names
  const r = csvRows("a,b\n\n1\n,,\n2,3,4\n");
  assert.deepEqual(r.columns, ["a", "b", "Column 3"]);
  assert.deepEqual(r.rows, [{ a: 1, b: "", "Column 3": "" }, { a: 2, b: 3, "Column 3": 4 }]);
  // a last line without a newline, a lone CR line ending, a quoted empty field
  assert.deepEqual(parseDelimited('x,y\r1,""'), [["x", "y"], ["1", ""]]);
  // spaces around unquoted cells are trimmed, a quote in the middle of a cell is kept
  assert.deepEqual(parseDelimited(' 5" screen , ok \n'), [['5" screen', "ok"]]);
});

test("CSV: the separator is sniffed (comma, tab, semicolon, pipe) and quotes don't fool it", () => {
  assert.equal(sniffDelimiter("a\tb\tc\n1\t2\t3\n"), "\t");
  assert.equal(sniffDelimiter("a;b;c\n1,5;2,5;3\n"), ";");
  assert.equal(sniffDelimiter("a|b\n1|2\n"), "|");
  assert.equal(sniffDelimiter('"x,y";z\n"1,2";3\n'), ";");
  assert.equal(sniffDelimiter("just one column\nsecond\n"), ",");
  const excel = "city\ttemp\tcondition\nबेंगलुरु\t24\tबादल\n";
  assert.deepEqual(csvRows(excel).rows, [{ city: "बेंगलुरु", temp: 24, condition: "बादल" }]);
});

test("CSV: numbers become numbers only when they are plain numbers", () => {
  assert.equal(cellValue("42"), 42);
  assert.equal(cellValue("-3.5"), -3.5);
  assert.equal(cellValue("1,23,456"), 123456);
  assert.equal(cellValue("12,345,678.9"), 12345678.9);
  assert.equal(cellValue("0712"), "0712");
  assert.equal(cellValue("+0.4%"), "+0.4%");
  assert.equal(cellValue("12,34"), "12,34");
  assert.equal(cellValue("98765432109876543210"), "98765432109876543210");
  assert.equal(toDelimited(["a", "b"], [{ a: 'x"y', b: "1\t2" }]), 'a\tb\n"x""y"\t"1\t2"');
  assert.deepEqual(csvRows(toDelimited(["a", "b"], [{ a: 'x"y', b: "line\nbreak" }], ",")).rows, [{ a: 'x"y', b: "line\nbreak" }]);
});

test("JSON: root paths, flattening and list suggestions", () => {
  assert.deepEqual(parsePath('data.items[0].list'), ["data", "items", 0, "list"]);
  assert.deepEqual(parsePath('$.results["top stories"][-1]'), ["results", "top stories", -1]);
  assert.deepEqual(parsePath("items.0.name"), ["items", 0, "name"]);
  const v = { data: { items: [{ list: [{ name: "Sensex", price: { value: 81234.5 }, tags: ["bse", "india"], up: true }, { name: "Nifty", price: { value: 24810 }, extra: null }] }] } };
  assert.equal(getPath(v, "data.items[0].list[-1].name"), "Nifty");
  assert.equal(getPath(v, "data.nothing.here"), undefined);
  const { columns, rows } = jsonRows(getPath(v, "data.items[0].list"));
  assert.deepEqual(columns, ["name", "price.value", "tags", "up", "extra"]);
  assert.deepEqual(rows[0], { name: "Sensex", "price.value": 81234.5, tags: "bse, india", up: "yes" });
  assert.deepEqual(rows[1], { name: "Nifty", "price.value": 24810, extra: "" });
  // a map of objects gets a key column; a list of plain values a value column; one object one row
  assert.deepEqual(jsonRows({ mumbai: { t: 31 }, delhi: { t: 38 } }).rows, [{ key: "mumbai", t: 31 }, { key: "delhi", t: 38 }]);
  assert.deepEqual(jsonRows(["a", 2]).rows, [{ value: "a" }, { value: 2 }]);
  assert.deepEqual(jsonRows({ city: "Pune", temp: 29 }).rows, [{ city: "Pune", temp: 29 }]);
  assert.deepEqual(findLists(v), ["data.items", "data.items[0].list"]);
  assert.deepEqual(findLists({ "top stories": [{ a: 1 }] }), ['["top stories"]']);
});

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE rss>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Tatvam News &amp; Views</title>
  <!-- a comment <item> that isn't one -->
  <item>
    <title><![CDATA[Mumbai rains: local trains run late & roads flood]]></title>
    <link>https://example.com/mumbai-rains</link>
    <pubDate>Tue, 14 Oct 2026 19:42:00 +0530</pubDate>
    <description>&lt;p&gt;Heavy rain since &lt;b&gt;morning&lt;/b&gt;.&lt;/p&gt;</description>
    <category>Mumbai</category>
    <media:thumbnail url="https://example.com/rain.jpg" width="320"/>
  </item>
  <item>
    <title>सेंसेक्स 400 अंक चढ़ा</title>
    <guid isPermaLink="true">https://example.com/sensex</guid>
    <dc:date>2026-10-14T10:00:00Z</dc:date>
    <content:encoded><![CDATA[<p>Markets <br>closed higher</p>]]></content:encoded>
    <enclosure url="https://example.com/s.png" type="image/png" length="1"/>
  </item>
  <item><title>Stray tags</b> are fine &hellip; &#8377;5 &#x20B9;6</title><link>https://example.com/3</link></item>
</channel>
</rss>`;

test("RSS 2.0: titles, links, dates, summaries, categories and images", () => {
  const f = parseFeed(RSS)!;
  assert.equal(f.kind, "rss");
  assert.equal(f.title, "Tatvam News & Views");
  assert.equal(f.items.length, 3);
  assert.deepEqual(f.items[0], {
    title: "Mumbai rains: local trains run late & roads flood", link: "https://example.com/mumbai-rains", date: "2026-10-14T14:12:00.000Z",
    summary: "Heavy rain since morning.", category: "Mumbai", image: "https://example.com/rain.jpg",
  });
  assert.equal(f.items[1].title, "सेंसेक्स 400 अंक चढ़ा");
  assert.equal(f.items[1].link, "https://example.com/sensex");
  assert.equal(f.items[1].date, "2026-10-14T10:00:00.000Z");
  assert.equal(f.items[1].summary, "Markets closed higher");
  assert.equal(f.items[1].image, "https://example.com/s.png");
  assert.equal(f.items[2].title, "Stray tags are fine … ₹5 ₹6");
});

test("Atom and RSS 1.0 (RDF) feeds", () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title type="text">Election desk</title>
    <entry><title type="html">BJP leads in &lt;b&gt;120&lt;/b&gt; seats</title>
      <link rel="self" href="https://example.com/self"/><link rel="alternate" href="https://example.com/e1"/>
      <updated>2026-10-14T08:30:00+05:30</updated><summary>Counting on</summary><category term="politics" label="Politics"/></entry>
    <entry><title>Second</title><link href="https://example.com/e2"/><published>2026-10-13T12:00:00Z</published><content type="html">&lt;p&gt;Body&lt;/p&gt;</content></entry>
  </feed>`;
  const a = parseFeed(atom)!;
  assert.equal(a.kind, "atom");
  assert.equal(a.title, "Election desk");
  assert.deepEqual(a.items[0], { title: "BJP leads in 120 seats", link: "https://example.com/e1", date: "2026-10-14T03:00:00.000Z", summary: "Counting on", category: "Politics" });
  assert.deepEqual(a.items[1], { title: "Second", link: "https://example.com/e2", date: "2026-10-13T12:00:00.000Z", summary: "Body" });
  const rdf = `<rdf:RDF xmlns:rdf="x" xmlns="http://purl.org/rss/1.0/"><channel><title>Old style</title></channel>
    <item rdf:about="1"><title>One</title><link>https://example.com/1</link><dc:date>2026-10-01</dc:date></item></rdf:RDF>`;
  const r = parseFeed(rdf)!;
  assert.equal(r.kind, "rdf");
  assert.equal(r.title, "Old style");
  assert.deepEqual(r.items, [{ title: "One", link: "https://example.com/1", date: "2026-10-01T00:00:00.000Z" }]);
  assert.equal(parseFeed("<html><body>no</body></html>"), null);
  assert.equal(parseFeed("not xml at all"), null);
});

test("the XML reader is tolerant", () => {
  const d = parseXml(`<a x='1' y="two &amp; three" z=bare><b>one<br>two</b><c/>tail</a></nope><d>unclosed`);
  const a = d.children[0];
  assert.deepEqual(a.attrs, { x: "1", y: "two & three", z: "bare" });
  assert.equal(textOf(a), "onetwotail");
  assert.equal(a.children.map((c) => c.name).join(","), "b,c");
  assert.equal(textOf(d.children[1]), "unclosed");
  assert.equal(decodeEntities("&lt;&#65;&#x42;&unknown;&amp;"), "<AB&unknown;&");
  assert.equal(plainText("<p>Hi <b>there</b>,<br/>friend<script>x()</script></p><p>Next</p>"), "Hi there, friend Next");
  assert.equal(feedDate("Mon, 13 Oct 2026 21:00:00 IST"), "2026-10-13T15:30:00.000Z");
  assert.equal(feedDate("sometime"), "sometime");
});

test("Google Sheet links become CSV addresses (tab kept)", () => {
  assert.deepEqual(sheetCsvUrl("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit#gid=123"),
    { url: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/export?format=csv&gid=123", kind: "shared", gid: "123" });
  assert.deepEqual(sheetCsvUrl("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit?usp=sharing"),
    { url: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/export?format=csv", kind: "shared" });
  assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/u/1/d/1AbCdEfGhIjKlMnOp/view?gid=7")?.url,
    "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/export?format=csv&gid=7");
  assert.deepEqual(sheetCsvUrl("https://docs.google.com/spreadsheets/d/e/2PACX-1vQ_abc-XYZ/pubhtml?gid=0&single=true"),
    { url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ_abc-XYZ/pub?gid=0&single=true&output=csv", kind: "published", gid: "0" });
  assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/d/e/2PACX-1vQ_abc-XYZ/pubhtml")?.url,
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ_abc-XYZ/pub?output=csv");
  // already CSV: kept as it is
  const pub = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ_abc-XYZ/pub?gid=5&single=true&output=csv";
  assert.equal(sheetCsvUrl(pub)?.url, pub);
  assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/export?format=tsv&gid=2")?.url,
    "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/export?format=tsv&gid=2");
  assert.equal(sheetCsvUrl("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit"), null);
  assert.equal(sheetCsvUrl("https://evil.example/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit"), null);
  assert.equal(sheetCsvUrl("not a link"), null);
});

const src = (o: Partial<DataSource>): DataSource => ({ id: "src.x", name: "X", kind: "csv", ...o });

test("snapshots: each kind, recognised kinds, web pages and errors", () => {
  const at = "2026-10-14T14:12:00.000Z";
  const c = snapshotFrom(src({}), "headline\nOne\nTwo\n", at);
  assert.deepEqual(c, { source: "src.x", at, rows: [{ headline: "One" }, { headline: "Two" }] });
  const j = snapshotFrom(src({ kind: "json", root: "data.items" }), '{"data":{"items":[{"n":"A","v":1}]}}', at);
  assert.deepEqual(j.rows, [{ n: "A", v: 1 }]);
  // no root: the first list of objects is used
  assert.deepEqual(snapshotFrom(src({ kind: "json" }), '{"meta":1,"results":[{"a":1}]}', at).rows, [{ a: 1 }]);
  assert.match(snapshotFrom(src({ kind: "json", root: "nope" }), '{"a":[]}', at).error ?? "", /Nothing was found at "nope"/);
  assert.match(snapshotFrom(src({ kind: "json" }), "{oops", at).error ?? "", /can't be read/);
  const r = snapshotFrom(src({ kind: "rss" }), RSS, at);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.items?.[0], { text: "Mumbai rains: local trains run late & roads flood", tag: "Mumbai" });
  // a CSV source that answers JSON or a feed is read as what it is
  assert.equal(snapshotFrom(src({}), '[{"a":1}]', at).rows[0].a, 1);
  assert.equal(snapshotFrom(src({ kind: "sheet" }), RSS, at).items?.length, 3);
  assert.equal(detectKind("[Name],x\n1,2"), "csv");
  // a sheet that isn't published gives its sign-in page
  assert.match(snapshotFrom(src({ kind: "sheet" }), "<!DOCTYPE html><html><head><title>Google Sheets</title>", at).error ?? "", /Publish to web/);
  assert.match(snapshotFrom(src({}), "  ", at).error ?? "", /empty/);
  assert.match(snapshotFrom(src({}), "only,a,header\n", at).error ?? "", /No rows/);
  // a failed refresh keeps the last good rows
  assert.deepEqual(failedSnapshot(src({}), "Offline", c), { ...c, error: "Offline" });
  assert.deepEqual(failedSnapshot(src({}), "Offline", undefined, at), { source: "src.x", at, rows: [], error: "Offline" });
});

test("as of: today shows the time, another day the date too", () => {
  const at = "2026-10-14T14:12:00.000Z";
  assert.equal(asOf(at, Date.parse("2026-10-14T16:00:00Z"), "Asia/Kolkata"), "as of 19:42");
  assert.equal(asOf(at, Date.parse("2026-10-15T16:00:00Z"), "Asia/Kolkata"), "as of 14 Oct, 19:42");
  assert.equal(asOf("garbage"), "");
});
