/** News Room: screen layouts keep clear of the bugs and the crawl (templates/layouts.ts clearOfBugs). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUGS } from "../newsroom/templates/bugs.ts";
import { LAYOUTS } from "../newsroom/templates/layouts.ts";
import { TICKERS } from "../newsroom/templates/tickers.ts";
import type { Box, GfxDesign } from "../newsroom/types.ts";

const full = (b: Box, w: number, h: number) => b[2] >= w * 0.9 && b[3] >= h * 0.9;
const overlap = (a: Box, b: Box) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const extent = (d: GfxDesign | undefined): Box => {
  const bs = (d?.layers ?? []).map((l) => l.box);
  const x0 = Math.min(...bs.map((b) => b[0])), y0 = Math.min(...bs.map((b) => b[1]));
  return [x0, y0, Math.max(...bs.map((b) => b[0] + b[2])) - x0, Math.max(...bs.map((b) => b[1] + b[3])) - y0];
};

test("16:9 headers and kickers stay clear of the LIVE and logo bugs", () => {
  const bugs = ["nr.bugs.live", "nr.bugs.logo"].map((id) => extent(BUGS.find((b) => b.id === id)!.designs["16:9"]));
  for (const t of LAYOUTS) {
    for (const l of t.designs["16:9"]!.layers) {
      const [, y, w, h] = l.box;
      if (full(l.box, 1920, 1080) || w >= 1920 * 0.9 || y + h > 200) continue;
      for (const b of bugs) assert.ok(!overlap(l.box, b), `${t.id} ${l.id} ${l.box} under a bug ${b}`);
    }
  }
});

test("9:16 layouts fit between the bugs and the crawl", () => {
  const crawl = TICKERS.find((x) => x.id === "nr.tickers.crawl")!.designs["9:16"]!;
  const crawlTop = Math.min(...crawl.layers.map((l) => l.box[1]));
  for (const t of LAYOUTS) {
    for (const l of t.designs["9:16"]!.layers) {
      if (full(l.box, 1080, 1920)) continue;
      assert.ok(l.box[1] >= 372 - 0.5, `${t.id} ${l.id} starts at ${l.box[1]}`);
      assert.ok(l.box[1] + l.box[3] <= Math.min(1330, crawlTop) + 0.5, `${t.id} ${l.id} ends at ${l.box[1] + l.box[3]}`);
    }
  }
});
