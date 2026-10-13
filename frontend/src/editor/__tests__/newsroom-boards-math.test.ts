import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autoEvery, barFractions, buildTimes, columnLayout, compactUnit, countFormat, countValue, decimalsOf, easeBy, ellipsize, fitRect, fitText,
  growAt, highlightAt, highlightWeight, isNumericCol, latestItem, layoutColumns, layoutList, leaderOf, listItems, majorityAngle, majorityOf, num,
  outShare, parseAligns, parseColumns, parseDuration, percents, pinDrop, pinsFrom, placeTags, pulseAt, seatArcs, splitNumberText, tableRows, tagRect, timerLeft,
  timerParts, timerText, wrapWords,
} from "../newsroom/boards/math.ts";
import { fmtNumber } from "../newsroom/format.ts";
import { builtinLook } from "../newsroom/looks.ts";

const look = builtinLook("look.classic_red")!;
/** A fake measure: every character is half the size wide. */
const half = (s: string, size: number) => [...s].length * size * 0.5;

test("values from fields: numbers, list items, rows", () => {
  assert.equal(num("₹ 1,23,456.5"), 123456.5);
  assert.equal(num("-3.2%"), -3.2);
  assert.equal(num(42), 42);
  assert.ok(Number.isNaN(num("DNB")));
  assert.deepEqual(listItems("- Schools shut\n• NDRF on standby\n2. Helpline 1077\n\n").map((i) => i.text), ["Schools shut", "NDRF on standby", "Helpline 1077"]);
  assert.deepEqual(listItems(["a", "", "b"]).map((i) => i.text), ["a", "b"]);
  assert.equal(listItems([{ text: "x", tag: "2019" }])[0].tag, "2019");
  assert.deepEqual(tableRows([{ a: 1 }, "x" as never, null as never]), [{ a: 1 }]);
});

test("a count runs eased from → to, keeps its decimals and its lakh / crore unit", () => {
  const c = { from: 0, to: 1.95, start: 1, dur: 2, decimals: 2 };
  assert.equal(countValue(c, 0), 0);
  assert.equal(countValue(c, 1), 0);
  assert.equal(countValue(c, 3), 1.95);
  assert.equal(countValue(c, 9), 1.95);
  let prev = -1;
  for (let t = 1; t <= 3; t += 0.04) {
    const v = countValue(c, t);
    assert.ok(v >= prev, "never goes back");
    assert.equal(decimalsOf(v) <= 2, true);
    prev = v;
  }
  // ₹1.95 lakh crore: the unit stays for the whole count
  const cf = countFormat(1.95e12, { currency: true, compact: true }, "indian");
  assert.equal(cf.div, 1e12);
  assert.equal(cf.f.decimals, 2);
  assert.equal(fmtNumber(1.95e12 / cf.div, look, cf.f), "₹1.95 lakh crore");
  assert.equal(fmtNumber(0, look, cf.f), "₹0.00 lakh crore");
  const cr = countFormat(12_50_00_000, { compact: true }, "indian");
  assert.equal(fmtNumber(12_50_00_000 / cr.div, look, cr.f), "12.5 crore");
  assert.deepEqual(compactUnit(4_50_000, "indian"), { div: 1e5, label: " lakh" });
  assert.equal(compactUnit(99_999, "indian"), null);
  // plain numbers keep the target's decimals; Indian grouping
  const pl = countFormat(127450, { currency: true }, "indian");
  assert.equal(fmtNumber(127450, look, pl.f), "₹1,27,450");
  assert.equal(countFormat(90.03, {}, "indian").f.decimals, 2);
});

test("splitting a number for drawing: sign, currency, digits, unit", () => {
  assert.deepEqual(splitNumberText("₹1.95 lakh crore"), { sign: "", lead: "₹", core: "1.95", tail: " lakh crore" });
  assert.deepEqual(splitNumberText("-₹1,234"), { sign: "-", lead: "₹", core: "1,234", tail: "" });
  assert.deepEqual(splitNumberText("+9.1%"), { sign: "+", lead: "", core: "9.1", tail: "%" });
  assert.equal(splitNumberText("१२,३४५").core, "१२,३४५");
});

test("countdown timers", () => {
  assert.equal(parseDuration("02:14:30"), 8070);
  assert.equal(parseDuration("4:05"), 245);
  assert.equal(parseDuration("1d 02:00:00"), 93600);
  assert.equal(parseDuration(90), 90);
  assert.ok(Number.isNaN(parseDuration("soon")));
  assert.equal(timerLeft(8070, 0, 1), 8070);
  assert.equal(timerLeft(8070, 1.5, 1), 8070);   // the first second is still running
  assert.equal(timerLeft(8070, 2, 1), 8069);
  assert.equal(timerLeft(5, 99, 0), 0);
  assert.deepEqual(timerParts(8070, "hms"), [2, 14, 30]);
  assert.deepEqual(timerParts(93600 + 65, "dhms"), [1, 2, 1, 5]);
  assert.equal(timerText(245, "ms"), "04:05");
});

test("items build one by one: stagger, paced (auto), all; highlight follows", () => {
  assert.deepEqual(buildTimes({ n: 3, start: 0.5, mode: "stagger", stagger: 0.1, every: 0, clipDur: 8 }).map((x) => +x.toFixed(3)), [0.5, 0.6, 0.7]);
  assert.deepEqual(buildTimes({ n: 3, start: 0.5, mode: "all", stagger: 0.1, every: 0, clipDur: 8 }), [0.5, 0.5, 0.5]);
  assert.deepEqual(buildTimes({ n: 3, start: 0, mode: "paced", stagger: 0, every: 1.5, clipDur: 8 }), [0, 1.5, 3]);
  // auto: items arrive over the first ~45 % of the clip, 0.35–2.5 s apart
  const auto = buildTimes({ n: 5, start: 0.6, mode: "paced", stagger: 0, every: 0, clipDur: 12 });
  assert.ok(auto[4] <= 12 * 0.45 + 1e-9 && auto[4] > 4, `${auto}`);
  assert.equal(autoEvery(10, 0, 4), 0.35);
  assert.equal(autoEvery(2, 0, 100), 2.5);
  const times = [0, 1, 2];
  assert.equal(latestItem(-1, times), -1);
  assert.equal(latestItem(1.5, times), 1);
  assert.equal(highlightAt(1.5, times, "latest", 2), 1);
  assert.equal(highlightAt(4.6, times, "cycle", 2), 0);   // after the last, the highlight moves on
  assert.equal(highlightAt(6.6, times, "cycle", 2), 1);
  // weights cross-fade and never exceed 1; one item lit at a time once settled
  for (let t = 0; t < 10; t += 0.05) {
    const w = times.map((_, i) => highlightWeight(t, times, "cycle", 2, i));
    w.forEach((x) => assert.ok(x >= 0 && x <= 1));
    const lit = w.filter((x) => x > 0.99).length;
    assert.ok(lit <= 1, `t=${t} ${w}`);
  }
  assert.equal(highlightWeight(5, times, "none", 2, 0), 0);
  // leaving: the last item goes first, all gone at the end
  assert.equal(outShare(1, 0, 4), 1);
  assert.equal(outShare(0, 0, 4), 0);
  assert.ok(outShare(0.7, 3, 4) < outShare(0.7, 0, 4));
});

test("bars: lengths, percents that add to 100, growth", () => {
  assert.deepEqual(barFractions([41, 33, 17, 9], "max"), [1, 33 / 41, 17 / 41, 9 / 41]);
  assert.deepEqual(barFractions([50, 50], "total"), [0.5, 0.5]);
  assert.deepEqual(barFractions([150, -3], "fixed", 100), [1, 0]);
  assert.deepEqual(barFractions([0, 0], "max"), [0, 0]);
  for (const vals of [[1, 1, 1], [41, 33, 17, 9], [2, 3, 7, 11, 13], [0.4, 0.4, 0.2]]) {
    for (const d of [0, 1]) {
      const p = percents(vals, d);
      assert.equal(Math.round(p.reduce((a, b) => a + b, 0) * 10 ** d), 100 * 10 ** d, `${vals} ${p}`);
    }
  }
  assert.deepEqual(percents([1, 1, 1]), [34, 33, 33]);
  assert.equal(growAt(0, 1, 0, 0.1, 1), 0);
  assert.equal(growAt(5, 1, 3, 0.1, 1), 1);
  assert.ok(growAt(1.5, 1, 0, 0.1, 1) > growAt(1.5, 1, 1, 0.1, 1));
});

test("election seats: arcs over the half donut, the majority line, the leader", () => {
  const rows = [{ label: "A", seats: 68 }, { label: "B", seats: 51 }, { label: "C", seats: 14 }, { label: "D", seats: 7 }];
  const arcs = seatArcs(rows, 140);
  assert.equal(arcs[0].a0, Math.PI);
  assert.ok(Math.abs(arcs[3].a1 - 2 * Math.PI) < 1e-9);
  for (let i = 1; i < arcs.length; i++) assert.ok(Math.abs(arcs[i].a0 - arcs[i - 1].a1) < 1e-9);
  assert.ok(Math.abs(arcs[0].a1 - arcs[0].a0 - (Math.PI * 68) / 140) < 1e-9);
  // undeclared seats stay empty; reveal sweeps from the left
  assert.ok(seatArcs([{ label: "A", seats: 30 }], 140)[0].a1 < 1.3 * Math.PI);
  const half = seatArcs(rows, 140, 0.5);
  assert.ok(half.every((a) => a.a1 <= 1.5 * Math.PI + 1e-9));
  assert.equal(majorityOf(140), 71);
  assert.equal(majorityOf(543), 272);
  assert.equal(majorityOf(243), 122);
  assert.ok(Math.abs(majorityAngle(543) - 1.5 * Math.PI) < 1e-9);
  assert.ok(Math.abs(majorityAngle(140, 71) - 1.5 * Math.PI) < 0.02);
  assert.equal(leaderOf([68, 51, 14, 7]), 0);
  assert.equal(leaderOf([0, 0]), -1);
});

test("tables: columns, alignment, widths", () => {
  const rows = [{ item: "Gold 24K", rate: 127450, change: 850 }, { item: "Petrol", rate: "103.50", change: "-" }];
  assert.deepEqual(parseColumns("", rows), [{ id: "item", label: "Item" }, { id: "rate", label: "Rate" }, { id: "change", label: "Change" }]);
  assert.deepEqual(parseColumns("item=Item, rate=Rate (₹)", rows), [{ id: "item", label: "Item" }, { id: "rate", label: "Rate (₹)" }]);
  assert.deepEqual(parseColumns("left=, label=", rows), [{ id: "left", label: "Left" }, { id: "label", label: "Label" }]);
  assert.ok(isNumericCol(rows, "rate") && isNumericCol(rows, "change") && !isNumericCol(rows, "item"));
  const cols = parseColumns("", rows);
  assert.deepEqual(parseAligns("auto", cols, rows), ["left", "right", "right"]);
  assert.deepEqual(parseAligns("lcr", cols, rows), ["left", "center", "right"]);
  const w = columnLayout("2,1,1", [10, 10, 10], 400, 0);
  assert.deepEqual(w.map((c) => c.w), [200, 100, 100]);
  assert.equal(w[2].x, 300);
  const auto = columnLayout("auto", [300, 120, 100], 1000, 0);
  assert.ok(Math.abs(auto.reduce((a, c) => a + c.w, 0) - 1000) < 1e-6);
  assert.ok(auto[0].w >= 300 && auto[1].w >= 120);
});

test("pins: positions, fitting the map, the drop and the pulse", () => {
  const p = pinsFrom([{ label: "Kochi", x: 0.4, y: 0.58 }, { label: "Idukki", x: 66, y: 56, color: "#f00" }, { label: "bad", x: "?", y: 1 }]);
  assert.equal(p.length, 2);
  assert.deepEqual([p[1].x, p[1].y, p[1].color], [0.66, 0.56, "#f00"]);
  assert.deepEqual(fitRect(200, 100, [0, 0, 400, 400], "contain"), [0, 100, 400, 200]);
  assert.deepEqual(fitRect(200, 100, [0, 0, 400, 400], "cover"), [-200, 0, 800, 400]);
  assert.deepEqual(pinDrop(0, 1, 0.5), { y: -1.6, a: 0, s: 1 });
  const end = pinDrop(2, 1, 0.5);
  assert.ok(Math.abs(end.y) < 1e-6 && end.a === 1 && end.s === 1);
  // tags: right by default; a pin near the right edge or next to another pin's tag gets another side
  const area: [number, number, number, number] = [0, 0, 1000, 800];
  assert.deepEqual(placeTags([[200, 400]], [[200, 50]], area, 48), ["right"]);
  assert.deepEqual(placeTags([[950, 400]], [[200, 50]], area, 48), ["left"]);
  const pts: [number, number][] = [[400, 400], [430, 405]];
  const two = placeTags(pts, [[200, 50], [200, 50]], area, 48);
  const [ra, rb] = two.map((side, i) => tagRect(side, pts[i][0], pts[i][1], 200, 50, 48));
  const cover = Math.max(0, Math.min(ra[0] + ra[2], rb[0] + rb[2]) - Math.max(ra[0], rb[0])) * Math.max(0, Math.min(ra[1] + ra[3], rb[1] + rb[3]) - Math.max(ra[1], rb[1]));
  assert.equal(cover, 0, `${two}`);
  const r = tagRect("left", 500, 400, 200, 50, 48);
  assert.ok(r[0] + r[2] <= 500);
  assert.equal(pulseAt(0, 2), 0);
  assert.equal(pulseAt(3, 2), 0.5);
});

test("text: wrapping at spaces (never inside Indic words), shrinking, ellipsis", () => {
  assert.deepEqual(wrapWords("aa bb cc", 5 * 0.5 * 10, (s) => half(s, 10)), ["aa bb", "cc"]);
  assert.deepEqual(wrapWords("किसान क्रेडिट कार्ड", 1, (s) => half(s, 10)), ["किसान", "क्रेडिट", "कार्ड"]);
  const fit = fitText("Dr. Venkataraghavan Subramaniam", { maxW: 400, maxH: 60, size: 50, maxLines: 1 }, half);
  assert.ok(fit.size < 50 && fit.size >= 30);
  assert.equal(fit.lines.length, 1);
  const cut = fitText("one two three four five six seven eight nine ten", { maxW: 100, maxH: 40, size: 30, maxLines: 1 }, half);
  assert.ok(cut.cut && cut.lines[0].endsWith("…"));
  assert.equal(ellipsize("short", 1000, (s) => s.length), "short");
  // a list shrinks until it fits its box and spreads the spare room
  const items = ["Income up to ₹12 lakh a year stays tax-free", "Standard deduction raised", "₹11.2 lakh crore for roads"];
  const lay = layoutList(items, { w: 600, h: 400, size: 46, maxLines: 2, spread: true }, half);
  const last = lay.rows[lay.rows.length - 1];
  assert.ok(last.y + last.h <= 400 + 0.5, JSON.stringify(lay));
  assert.ok(lay.size <= 46 && lay.size >= 46 * 0.6);
  const tight = layoutList(items.concat(items, items), { w: 300, h: 200, size: 46, maxLines: 2 }, half);
  assert.ok(tight.cut || tight.rows[tight.rows.length - 1].y + tight.rows[tight.rows.length - 1].h <= 200.5);
  const cols = layoutColumns(["2008 water found on the Moon", "2019 orbiter", "2023 landing"], { colW: 200, h: 300, size: 40, maxLines: 4, head: 2 }, half);
  assert.equal(cols.cols.length, 3);
  assert.ok(cols.cols.every((c) => c.length <= 4));
});

test("easings end where they should", () => {
  for (const k of ["linear", "ease_in", "ease_out", "ease_in_out", "quint", "expo", "back", "elastic", "bounce", "other"]) {
    assert.equal(+easeBy(k, 0).toFixed(6), 0, k);
    assert.equal(+easeBy(k, 1).toFixed(6), 1, k);
  }
});
