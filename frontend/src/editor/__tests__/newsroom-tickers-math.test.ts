import assert from "node:assert/strict";
import { test } from "node:test";
import {
  colonOn, crawlItemAt, crawlLoopSeconds, crawlOffset, crawlSpeed, crawlStart, crawlVisible, deltaParts, estimateLoop, estimateWidth,
  flashLevel, flipIndex, flipState, fmtMatch, frameSpeed, loopSpeed, matchTime, maxReadableSpeed, mirrorX, pagesOf, parseClock,
  readableSpeed, SPEED_SHARE,
} from "../newsroom/tickers/math.ts";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test("crawl presets are 0.10 / 0.14 / 0.19 of the frame height a second; vertical runs slower", () => {
  assert.deepEqual(SPEED_SHARE, { slow: 0.10, normal: 0.14, fast: 0.19 });
  close(crawlSpeed("slow", 1920, 1080), 108);
  close(crawlSpeed("normal", 1920, 1080), 151.2);
  close(crawlSpeed("fast", 1920, 1080), 205.2);
  close(crawlSpeed(undefined, 1920, 1080), 151.2);
  const v = crawlSpeed("normal", 1080, 1920);
  assert.ok(v < crawlSpeed("normal", 1920, 1080) && v > 100, `${v}`);
  assert.equal(crawlSpeed("custom", 1920, 1080, 222), 222);
  assert.equal(crawlSpeed(99, 1920, 1080), 99);
  // the same speed on a square frame as in 16:9 (short side 1080)
  close(crawlSpeed("normal", 1080, 1080), 151.2);
});

test("speeds snap to whole pixels a frame when that's close, and fit a perfect loop", () => {
  assert.equal(frameSpeed(151.2, 25), 150);   // 6 px a frame
  assert.equal(frameSpeed(151.2, 30), 150);   // 5 px a frame
  assert.equal(frameSpeed(151.2, 60), 151.2); // 2.52 px: rounding would change it too much
  assert.equal(frameSpeed(151.2, 0), 151.2);
  const s = loopSpeed(150, 2400, 60);
  close((s * 60) % 2400, 0);
  assert.ok(Math.abs(s - 150) / 150 < 0.1);
  assert.equal(loopSpeed(150, 0, 60), 150);
});

test("the crawl starts full or enters from the right, and repeats with no gap or jump", () => {
  const cycle = 2600, win = 1340, v = 150;
  assert.equal(crawlStart(0, v, cycle, win, true), 0);
  assert.equal(crawlStart(0, v, cycle, win, false), win);
  // entering: the first copy moves in from the right edge
  close(crawlStart(2, v, cycle, win, false), win - 300);
  // periodic part stays within one cycle and moves by exactly v·dt (mod cycle) every frame
  for (const full of [true, false]) {
    let prev = crawlStart(0, v, cycle, win, full);
    for (let f = 1; f < 25 * 120; f++) {
      const x = crawlStart(f / 25, v, cycle, win, full);
      assert.ok(x <= win && x > -cycle, `${x}`);
      const d = ((prev - x) % cycle + cycle) % cycle;
      close(d, 6, 1e-6);
      prev = x;
    }
  }
  // offset helper: 0 ≤ offset < cycle
  for (const t of [0, 1.3, 17.7, 3600]) { const o = crawlOffset(t, v, cycle, win, true); assert.ok(o >= 0 && o < cycle, `${o}`); }
});

test("visible pieces cover the window edge to edge, and one cycle later the picture is the same", () => {
  const widths = [900, 420, 1180, 640];
  const cycle = widths.reduce((a, b) => a + b, 0);
  const win = 1340, v = 151;
  for (const t of [0, 0.04, 3, 9.96, 27.3, 600]) {
    const s = crawlStart(t, v, cycle, win, true);
    const vis = crawlVisible(s, widths, win);
    assert.ok(vis.length > 0);
    assert.ok(vis[0].x <= 0, "the first piece starts at or before the left edge");
    const last = vis[vis.length - 1];
    assert.ok(last.x + widths[last.i] >= win, "the last piece reaches the right edge");
    for (let k = 1; k < vis.length; k++) close(vis[k].x, vis[k - 1].x + widths[vis[k - 1].i]);
    const later = crawlVisible(crawlStart(t + cycle / v, v, cycle, win, true), widths, win);
    assert.deepEqual(later.map((p) => [p.i, Math.round(p.x * 1000)]), vis.map((p) => [p.i, Math.round(p.x * 1000)]));
  }
  // a strip shorter than the window repeats to fill it
  const short = crawlVisible(0, [300], 1340);
  assert.equal(short.length, 5);
  // entering: nothing to the left of the first copy
  const enter = crawlVisible(1000, widths, 1340);
  assert.equal(enter[0].i, 0);
  assert.equal(enter[0].x, 1000);
  assert.deepEqual(crawlVisible(0, [], 100), []);
});

test("the item at a point of the window, and right-to-left mirroring", () => {
  const widths = [100, 200, 300];
  assert.deepEqual(crawlItemAt(0, 0, widths), { i: 0, into: 0 });
  assert.deepEqual(crawlItemAt(150, 0, widths), { i: 1, into: 50 });
  assert.deepEqual(crawlItemAt(10, -590, widths), { i: 0, into: 0 });
  assert.equal(crawlItemAt(10, 50, widths).i, -1);
  assert.equal(mirrorX(0, 100, 1000), 900);
});

test("flip pages hold, change with a transition, and loop; the first shows without one", () => {
  assert.deepEqual(flipState(0, 4, 5, 0.5), { index: 0, prev: 0, k: 1, step: 0 });
  const a = flipState(5.25, 4, 5, 0.5);
  assert.equal(a.index, 1); assert.equal(a.prev, 0); close(a.k, 0.5);
  assert.equal(flipState(5.6, 4, 5, 0.5).k, 1);
  assert.equal(flipState(20.1, 4, 5, 0.5).index, 0);   // back to the first
  assert.equal(flipState(20.1, 4, 5, 0.5).prev, 3);
  assert.equal(flipState(3, 1, 5, 0.5).k, 1);
  assert.equal(flipState(3, 0, 5, 0.5).index, -1);
  assert.equal(flipIndex(12, 3, 5), 2);
  // exact on whole frames (exports repeat)
  for (let f = 0; f < 600; f++) assert.deepEqual(flipState(f / 25, 5, 3, 0.4), flipState(f / 25, 5, 3, 0.4));
});

test("pages group items, and never mix tags when asked", () => {
  const its = [{ tag: "Delhi" }, { tag: "Delhi" }, { tag: "Delhi" }, { tag: "Mumbai" }, { tag: "Mumbai" }, {}];
  assert.deepEqual(pagesOf(its, 2), [[0, 1], [2, 3], [4, 5]]);
  assert.deepEqual(pagesOf(its, 4, true), [[0, 1, 2], [3, 4], [5]]);
  assert.deepEqual(pagesOf([], 3), []);
  assert.deepEqual(pagesOf(its, 0), [[0], [1], [2], [3], [4], [5]]);
});

test("priority items flash at most twice a second, the same on every export", () => {
  assert.equal(flashLevel(0.2, 1), 1);
  assert.equal(flashLevel(0.8, 1), 0);
  assert.ok(flashLevel(0.04, 1) > 0 && flashLevel(0.04, 1) < 1);
  // a period below 0.5 s is raised to 0.5 s
  assert.equal(flashLevel(0.3, 0.1), flashLevel(0.3, 0.5));
  assert.equal(flashLevel(1.013, 1, 25), flashLevel(1.0, 1, 25));
});

test("readability: the presets read comfortably; very fast crawls are flagged with a fix", () => {
  for (const [w, h, win, size] of [[1920, 1080, 1340, 40], [1080, 1920, 842, 46]] as const) {
    for (const sp of ["slow", "normal", "fast"] as const) {
      const r = readableSpeed(crawlSpeed(sp, w, h), size, win);
      assert.equal(r.level, "ok", `${sp} ${w}x${h}: ${JSON.stringify(r)}`);
    }
  }
  const bad = readableSpeed(420, 40, 1340);
  assert.equal(bad.level, "too-fast");
  assert.equal(bad.ok, false);
  assert.equal(readableSpeed(240, 40, 1340).level, "fast");
  // a narrow window flags a speed that's fine in a wide one
  assert.notEqual(readableSpeed(200, 40, 400).level, "ok");
  const fix = maxReadableSpeed(40, 1340);
  assert.equal(readableSpeed(fix, 40, 1340).level, "ok");
});

test("loop estimates for the item editor", () => {
  assert.ok(estimateWidth("NEWS", 40) > estimateWidth("news", 40));
  assert.ok(estimateWidth("दिल्ली में बारिश", 40) > 100);
  const one = estimateLoop([{ text: "IMD issues orange alert for Mumbai, Thane and Palghar" }]);
  const two = estimateLoop([{ text: "IMD issues orange alert for Mumbai, Thane and Palghar" }, { text: "Sensex ends 412 points higher" }]);
  assert.ok(one > 5 && two > one, `${one} ${two}`);
  assert.equal(crawlLoopSeconds(1500, 150), 10);
  assert.equal(crawlLoopSeconds(1500, 0), 0);
});

test("market changes: direction and size as points, percent, or both", () => {
  assert.deepEqual(deltaParts(81523.16, 412.3, "pct"), { dir: 1, pct: 412.3 });
  assert.deepEqual(deltaParts(100, -2, "abs"), { dir: -1, abs: 2 });
  const both = deltaParts(81523.16, 412.3, "abs+pct");
  assert.equal(both.dir, 1); assert.equal(both.abs, 412.3); close(both.pct!, (412.3 / (81523.16 - 412.3)) * 100);
  assert.deepEqual(deltaParts(10, 0, "abs"), { dir: 0, abs: 0 });
  assert.deepEqual(deltaParts(10, undefined, "abs"), { dir: 0 });
});

test("match clocks count up or down from the typed time; colons blink each half second", () => {
  assert.equal(parseClock("67:12"), 67 * 60 + 12);
  assert.equal(parseClock("1:05:10"), 3910);
  assert.equal(parseClock("45"), 2700);
  assert.equal(parseClock("abc"), null);
  assert.equal(fmtMatch(matchTime(parseClock("67:12")!, 3.9, false)), "67:15");
  assert.equal(fmtMatch(matchTime(parseClock("00:02")!, 10, true)), "00:00");
  assert.equal(fmtMatch(105 * 60 + 20), "105:20");
  assert.equal(colonOn(1_700_000_000_100), true);
  assert.equal(colonOn(1_700_000_000_600), false);
});
