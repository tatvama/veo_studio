import assert from "node:assert/strict";
import { test } from "node:test";
import { fmtNumber, zonedTimeToMs } from "../newsroom/format.ts";
import { BUILTIN_LOOKS, builtinLook } from "../newsroom/looks.ts";
import type { Ctx2D, LayerRenderContext } from "../newsroom/render/contract.ts";
import "../newsroom/render/kinds/clock.ts";
import { matchText, textRuns, timeRuns } from "../newsroom/render/kinds/clock.ts";
import "../newsroom/render/kinds/ticker.ts";
import { crawlPeriod, crawlStripWidth, tickerSpeed } from "../newsroom/render/kinds/ticker.ts";
import { cssFont, paintFor } from "../newsroom/render/paint.ts";
import { defaultProps, layerKind } from "../newsroom/render/registry.ts";
import { BUGS } from "../newsroom/templates/bugs.ts";
import { defaults, layer } from "../newsroom/templates/kit.ts";
import { TICKERS } from "../newsroom/templates/tickers.ts";
import { itemsOf } from "../newsroom/tickers/pieces.ts";
import { clockProps, decimalsFor, numProp, tickerFieldRefs, tickerProps } from "../newsroom/tickers/props.ts";
import type { Box, ChannelLook, GfxLayer, GfxRatio, GfxValue } from "../newsroom/types.ts";

// ── a canvas that records what it's asked to draw (Node has none) ────────────

function mockCtx(): { g: Ctx2D; log: string[] } {
  const log: string[] = [];
  let state: Record<string, unknown> = { font: "10px sans-serif", fillStyle: "#000", strokeStyle: "#000", globalAlpha: 1, letterSpacing: "0px", textAlign: "start", textBaseline: "alphabetic", lineWidth: 1, globalCompositeOperation: "source-over" };
  const stack: Record<string, unknown>[] = [];
  const px = () => parseFloat(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] ?? "10");
  const own: Record<string, unknown> = {
    save() { stack.push({ ...state }); },
    restore() { state = stack.pop() ?? state; },
    measureText(s: string) { const p = px(); return { width: [...s].length * p * 0.5, actualBoundingBoxAscent: p * 0.7, actualBoundingBoxDescent: 0, fontBoundingBoxAscent: p * 0.9, fontBoundingBoxDescent: p * 0.25 }; },
    createLinearGradient() { return { addColorStop() {} }; },
    fillText(s: string, x: number, y: number) { log.push(`text|${s}|${x.toFixed(2)}|${y.toFixed(2)}|${state.font}|${String(state.fillStyle)}|${(state.globalAlpha as number).toFixed(3)}`); },
  };
  const g = new Proxy(own, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k in state) return state[k];
      return (...a: unknown[]) => { log.push(`${k}|${a.map((x) => (typeof x === "number" ? x.toFixed(2) : typeof x)).join("|")}`); };
    },
    set(_t, k: string, v) { state[k] = v; return true; },
  }) as unknown as Ctx2D;
  return { g, log };
}

const CLASSIC = builtinLook("look.classic_red")!;
const AIR = zonedTimeToMs("2026-10-14T19:42:05", "Asia/Kolkata");

interface RcOpts { t?: number; dur?: number; phaseIn?: number; phaseOut?: number; shown?: number; look?: ChannelLook; ratio?: GfxRatio; fps?: number; box?: Box }
function rcFor(values: Record<string, GfxValue>, o: RcOpts = {}): LayerRenderContext {
  const look = o.look ?? CLASSIC;
  const ratio = o.ratio ?? "16:9";
  const t = o.t ?? 3;
  return {
    t, dur: o.dur ?? 60, phase: { in: o.phaseIn ?? 1, out: o.phaseOut ?? 1 }, shown: o.shown ?? Math.max(0, t - 0.8), look, ratio,
    designW: ratio === "9:16" ? 1080 : 1920, designH: ratio === "9:16" ? 1920 : 1080, scale: 1, seed: 7, fps: o.fps ?? 25,
    clock: AIR + t * 1000,
    value: (id) => values[id] ?? null,
    text: (s) => (s ?? "").replace(/\{([\w.-]+)\}/g, (_, k: string) => { const v = values[k]; return typeof v === "string" || typeof v === "number" ? String(v) : ""; }),
    paint: (p, fb) => paintFor(null, p, look, [0, 0, 0, 0], fb),
    font: (name, size, weight, sample) => cssFont(name, look, size, weight, sample),
    image: () => null, logo: () => null,
    number: (n, f) => fmtNumber(n, look, f),
    rand: () => 0.5,
    ease: (x) => Math.max(0, Math.min(1, x)),
    ...(o.box ? { box: o.box, pixel: 1 } : {}),
  } as LayerRenderContext;
}

function draw(l: GfxLayer, values: Record<string, GfxValue>, o: RcOpts = {}): string[] {
  const { g, log } = mockCtx();
  layerKind(l.kind)!.draw(g, l, rcFor(values, o));
  return log;
}
const texts = (log: string[]) => log.filter((x) => x.startsWith("text|")).map((x) => { const p = x.split("|"); return { s: p[1], x: Number(p[2]), y: Number(p[3]), font: p[4], color: p[5], alpha: Number(p[6]) }; });

const ITEMS = [
  { text: "IMD issues orange alert for Mumbai, Thane and Palghar" },
  { text: "दिल्ली-एनसीआर में सुबह हल्की बारिश" },
  { text: "Sensex ends 412 points higher; Nifty closes above 24,900" },
  { text: "Bengaluru: Namma Metro Yellow Line ridership crosses 1 lakh" },
];
const crawlLayer = (p: Record<string, unknown> = {}) => layer("ticker", "crawl", [352, 962, 1340, 64], { source: "items", mode: "crawl", size: 40, ...p });

// ── tests ────────────────────────────────────────────────────────────────────

test("the ticker and clock kinds register with their properties", () => {
  const tk = layerKind("ticker")!, ck = layerKind("clock")!;
  assert.equal(tk.group, "Data"); assert.equal(tk.ownsAnim, true);
  assert.equal(ck.group, "Data");
  assert.equal(defaultProps("ticker").mode, "crawl");
  assert.equal(defaultProps("ticker").speed, "normal");
  assert.equal(defaultProps("clock").show, "time");
  for (const p of [...tk.props, ...ck.props]) assert.ok(p.key && p.label && p.type, p.key);
  assert.equal(new Set(tk.props.map((p) => p.key)).size, tk.props.length);
  assert.equal(new Set(ck.props.map((p) => p.key)).size, ck.props.length);
});

test("props: defaults filled, values kept in range, field-driven numbers", () => {
  const p = tickerProps({ mode: "nope", size: -5, perPage: 99, decimals: -1, total: "{total}" });
  assert.equal(p.mode, "crawl");
  assert.equal(p.size, 4);
  assert.equal(p.perPage, 8);
  assert.equal(p.decimals, -1);
  assert.equal(numProp(p.total, (id) => (id === "total" ? 243 : null), 543), 243);
  assert.equal(numProp("{x}", () => null, 543), 543);
  assert.equal(numProp(100, () => null, 1), 100);
  assert.equal(decimalsFor(-1, 73450), 0);
  assert.equal(decimalsFor(-1, 94.72), 2);
  assert.equal(decimalsFor(1, 5), 1);
  assert.equal(clockProps({ show: "bad" }).show, "time");
  assert.deepEqual(tickerFieldRefs("ticker", { source: "parties", total: "{total}", label: "{title} live", tagFill: "{level}" }).sort(), ["level", "parties", "title", "total"]);
  assert.deepEqual(tickerFieldRefs("clock", { show: "temp", field: "temp", icon: "{icon}" }).sort(), ["icon", "temp"]);
});

test("items come from lists or lines; empty ones are dropped", () => {
  assert.deepEqual(itemsOf("One\n\n Two "), [{ text: "One" }, { text: "Two" }]);
  assert.deepEqual(itemsOf([{ text: "a" }, { text: "  " }, { text: "", value: 5 }, "b"] as unknown as GfxValue), [{ text: "a" }, { text: "", value: 5 }, { text: "b" }]);
  assert.deepEqual(itemsOf(null), []);
});

test("a crawl draws the same picture for the same frame, starts full, and moves the same pixels every frame", () => {
  const l = crawlLayer();
  const v = { items: ITEMS };
  assert.deepEqual(draw(l, v, { t: 7.32 }), draw(l, v, { t: 7.32 }));
  // full on the first frame: the first item starts at the window's left edge
  const first = texts(draw(l, v, { t: 0 }));
  assert.ok(first.some((x) => x.s === ITEMS[0].text && Math.abs(x.x - 352) < 1), JSON.stringify(first.slice(0, 2)));
  // not full: nothing is in the window yet
  assert.equal(texts(draw(crawlLayer({ startFull: false }), v, { t: 0 })).length, 0);
  // 25 fps, normal speed → 6 design px a frame, for minutes, through many loops of the strip
  const speed = tickerSpeed(tickerProps(l.p), 1920, 1080, 25);
  assert.equal(speed, 150);
  let prev = new Map<string, number>();
  let loops = 0;
  for (let f = 0; f < 25 * 120; f++) {
    const now = new Map(texts(draw(l, v, { t: f / 25 })).map((x) => [x.s, x.x]));
    for (const [s, x] of now) {
      const p = prev.get(s);
      if (p !== undefined && x < p + 100) assert.ok(Math.abs(p - x - 6) < 1e-6, `frame ${f}: "${s}" moved ${p - x}`);
      else if (p !== undefined) loops++;
    }
    prev = now;
  }
  assert.ok(loops === 0, "pieces only ever move left");
});

test("a crawl that moves right mirrors the strip; a perfect loop ends where it began", () => {
  const v = { items: ITEMS };
  const r0 = texts(draw(crawlLayer({ direction: "right" }), v, { t: 0 }));
  const r1 = texts(draw(crawlLayer({ direction: "right" }), v, { t: 1 }));
  const a = r0.find((x) => x.s === ITEMS[0].text)!, b = r1.find((x) => x.s === ITEMS[0].text)!;
  assert.ok(b.x > a.x, "moves right");
  const l = crawlLayer({ loopFit: true });
  const dur = 37.4;
  const start = texts(draw(l, v, { t: 0, dur })).map((x) => [x.s, x.x.toFixed(1)]);
  const end = texts(draw(l, v, { t: dur, dur })).map((x) => [x.s, x.x.toFixed(1)]);
  assert.deepEqual(end, start);
});

test("priority items flash on a plate in the breaking colour", () => {
  const l = crawlLayer();
  const v = { items: [{ text: "Andheri subway shut", flash: true }, ...ITEMS] };
  const on = draw(l, v, { t: 0.2 }), off = draw(l, v, { t: 0.8 });
  assert.notDeepEqual(on, off);
  const t = texts(on).find((x) => x.s === "Andheri subway shut")!;
  assert.equal(t.color, "#FFFFFF");
});

test("market values: Indian grouping, ▲ / ▼ in the look's up / down colours", () => {
  const l = layer("ticker", "m", [336, 962, 1488, 64], { source: "items", mode: "crawl", size: 36, deltaStyle: "abs+pct", decimals: 2 });
  const out = texts(draw(l, { items: [{ text: "SENSEX", value: 81523.16, delta: 412.3 }, { text: "BANK NIFTY", value: 51812.25, delta: -96.3 }] }, { t: 0 }));
  const val = out.find((x) => x.s === "81,523.16");
  assert.ok(val, JSON.stringify(out.map((x) => x.s)));
  const up = out.find((x) => x.s.startsWith("412.30 ("))!;
  assert.equal(up.color, CLASSIC.colors.up);
  const down = out.find((x) => x.s.startsWith("96.30"));
  if (down) assert.equal(down.color, CLASSIC.colors.down);
  // ₹ and whole numbers without decimals for rates
  const r = texts(draw(layer("ticker", "r", [96, 954, 1728, 72], { source: "items", mode: "flip", perPage: 2, currency: true, decimals: -1 }), { items: [{ text: "Gold 22K", value: 73450 }, { text: "Petrol", value: 94.72 }] }, { t: 2 }));
  assert.ok(r.some((x) => x.s === "₹73,450") && r.some((x) => x.s === "₹94.72"), JSON.stringify(r.map((x) => x.s)));
});

test("flip pages change with a transition; the tag box follows the items", () => {
  const l = layer("ticker", "f", [376, 942, 1448, 84], { source: "items", mode: "flip", hold: 5, transDur: 0.5 });
  const v = { items: ITEMS };
  assert.deepEqual(texts(draw(l, v, { shown: 1 })).map((x) => x.s), [ITEMS[0].text]);
  const mid = texts(draw(l, v, { shown: 5.25 })).map((x) => x.s);
  assert.ok(mid.includes(ITEMS[0].text) && mid.includes(ITEMS[1].text), JSON.stringify(mid));
  assert.deepEqual(texts(draw(l, v, { shown: 6 })).map((x) => x.s), [ITEMS[1].text]);
  // a crawl's tag box shows the tag of the item at its start
  const c = layer("ticker", "c", [96, 962, 1728, 64], { source: "items", mode: "crawl", tags: "box", label: "News" });
  const tagged = [{ tag: "National", text: "Parliament session from 24 November" }, { tag: "Sports", text: "India beat Malaysia 4–1" }];
  const boxAt = (t: number) => texts(draw(c, { items: tagged }, { t })).find((x) => x.s === "NATIONAL" || x.s === "SPORTS")?.s;
  assert.equal(boxAt(0), "NATIONAL");
  let changed = false;
  for (let f = 1; f < 25 * 30 && !changed; f++) changed = boxAt(f / 25) === "SPORTS";
  assert.ok(changed, "the box changes to the next tag as its item arrives");
});

test("stack rolls up an item at a time; tally and seats draw results and the majority", () => {
  const s = layer("ticker", "s", [300, 914, 1524, 112], { source: "items", mode: "stack", rows: 2, hold: 4, transDur: 0.45 });
  assert.deepEqual(texts(draw(s, { items: ITEMS }, { shown: 1 })).map((x) => x.s), [ITEMS[0].text, ITEMS[1].text]);
  assert.deepEqual(texts(draw(s, { items: ITEMS }, { shown: 5 })).map((x) => x.s), [ITEMS[1].text, ITEMS[2].text]);
  const parties = [{ text: "NDA", value: 240, delta: 52, color: "#F47C20" }, { text: "INDIA", value: 180, delta: 38, color: "#1F6FD1" }];
  const tl = texts(draw(layer("ticker", "t", [96, 952, 1060, 70], { source: "p", mode: "tally", perPage: 3 }), { p: parties }));
  assert.ok(tl.some((x) => x.s === "292") && tl.some((x) => x.s === "Won 240") && tl.some((x) => x.s === "Lead 52"), JSON.stringify(tl.map((x) => x.s)));
  const st = texts(draw(layer("ticker", "b", [1184, 952, 640, 70], { source: "p", mode: "seats", total: "{total}", majority: "{majority}" }), { p: parties, total: 543, majority: 272 }));
  assert.ok(st.some((x) => x.s === "Majority 272"), JSON.stringify(st.map((x) => x.s)));
});

test("the ticker wipes on (owning its entrance) and its items follow the plates", () => {
  const l = crawlLayer({ fill: "@secondary", label: "Top news" });
  l.anim = { in: { kind: "wipe", dir: "right", dur: 0.6 } };
  const log = draw(l, { items: ITEMS }, { t: 0, phaseIn: 0 });
  const clipRect = log.find((x) => x.startsWith("rect|"))!.split("|");
  assert.equal(Number(clipRect[3]), 0, "nothing shown at the start of the wipe");
  const half = texts(draw(l, { items: ITEMS }, { t: 0.3, phaseIn: 0.5 })).filter((x) => x.s === ITEMS[0].text);
  const full = texts(draw(l, { items: ITEMS }, { t: 0.6, phaseIn: 1 })).filter((x) => x.s === ITEMS[0].text);
  assert.ok(half[0].alpha < full[0].alpha);
});

test("clocks follow the look's 12 / 24 h, zone and digits; match clocks run by sport", () => {
  const classic = timeRuns(AIR, CLASSIC, false).map((r) => r.text).join("");
  assert.equal(classic, "19:42");
  const blue = builtinLook("look.modern_blue")!;
  assert.equal(timeRuns(AIR, blue, true).map((r) => r.text).join(""), "7:42:05PM");
  const native = { ...CLASSIC, numbers: { ...CLASSIC.numbers, digits: "native" as const } };
  assert.equal(timeRuns(AIR, native, false).map((r) => r.text).join(""), "१९:४२");
  assert.deepEqual(textRuns("14 Oct 2026").map((r) => r.kind), ["digits", "text", "digits"]);
  assert.equal(matchText("cricket", "67:12", "38.2", 10), "38.2 OV");
  assert.equal(matchText("football", "67:12", "", 3.5), "67:15");
  assert.equal(matchText("kabaddi", "12:40", "", 40), "12:00");
  assert.equal(matchText("kabaddi", "00:05", "", 40), "00:00");
  // the clock kind draws each digit in its own cell (no jitter as they change)
  const c = layer("clock", "c", [1712, 962, 112, 64], { show: "time", size: 36, blink: true });
  const a = texts(draw(c, {}, { t: 0 })), b = texts(draw(c, {}, { t: 0.6 }));
  assert.deepEqual(a.map((x) => x.s), ["1", "9", ":", "4", "2"]);
  assert.notEqual(a.find((x) => x.s === ":")!.alpha, b.find((x) => x.s === ":")!.alpha);
  assert.deepEqual(a.filter((x) => x.s !== ":").map((x) => x.x), b.filter((x) => x.s !== ":").map((x) => x.x));
  const temp = texts(draw(layer("clock", "t", [100, 64, 150, 60], { show: "temp", field: "temp" }), { temp: 34 }));
  assert.equal(temp.map((x) => x.s).join(""), "34°C");
});

test("kinds report what moves, their fonts (per script) and pictures", () => {
  const tk = layerKind("ticker")!;
  const ctx = (v: Record<string, GfxValue>) => ({ value: (id: string) => v[id] ?? null, dur: 10 });
  assert.equal(tk.animates!(crawlLayer(), ctx({ items: ITEMS })), true);
  assert.equal(tk.animates!(crawlLayer(), ctx({ items: [] })), false);
  assert.equal(tk.animates!(layer("ticker", "f", [0, 0, 100, 50], { mode: "flip" }), ctx({ items: [{ text: "One" }] })), false);
  assert.equal(tk.animates!(layer("ticker", "f", [0, 0, 100, 50], { mode: "flip" }), ctx({ items: ITEMS })), true);
  assert.equal(tk.animates!(layer("ticker", "s", [0, 0, 100, 50], { mode: "stack", rows: 2 }), ctx({ items: ITEMS.slice(0, 2) })), false);
  assert.equal(tk.animates!(layer("ticker", "s", [0, 0, 100, 50], { mode: "seats" }), ctx({ items: ITEMS })), false);
  const rcLike = { look: CLASSIC, value: (id: string) => (id === "items" ? ITEMS : null), text: (s: string) => s };
  const fonts = tk.fonts!(crawlLayer({ font: "@body", weight: 600 }), rcLike as never);
  assert.ok(fonts.some((f) => f.startsWith(`600 40px "Anek Devanagari`)), JSON.stringify(fonts));
  assert.ok(fonts.some((f) => f.includes("Inter")));
  const logoLook = { ...CLASSIC, separator: "logo" as const, logo: { mediaId: "m1" } };
  assert.deepEqual(tk.images!(crawlLayer(), { look: logoLook, value: () => null } as never), ["m1"]);
  const ck = layerKind("clock")!;
  assert.equal(ck.animates!(layer("clock", "c", [0, 0, 1, 1], { show: "time" }), ctx({})), true);
  assert.equal(ck.animates!(layer("clock", "c", [0, 0, 1, 1], { show: "date" }), ctx({})), false);
  assert.equal(ck.animates!(layer("clock", "c", [0, 0, 1, 1], { show: "match" }), ctx({ sport: "cricket" })), false);
  assert.equal(ck.animates!(layer("clock", "c", [0, 0, 1, 1], { show: "match" }), ctx({ sport: "football" })), true);
});

test("every ticker and clock layer of every template draws in both ratios and every look, the same each time", () => {
  for (const t of [...TICKERS, ...BUGS]) {
    const values = defaults(t);
    for (const r of ["16:9", "9:16"] as GfxRatio[]) {
      for (const l of t.designs[r]!.layers.filter((x) => x.kind === "ticker" || x.kind === "clock")) {
        for (const look of BUILTIN_LOOKS) {
          for (const tt of [0, 0.35, 2.5, 7.75, 31]) {
            const o = { t: tt, shown: Math.max(0, tt - 0.8), phaseIn: Math.min(1, tt / 0.8), look, ratio: r, box: l.box };
            const a = draw(l, values, o);
            assert.deepEqual(draw(l, values, o), a, `${t.id} ${r} ${l.id} ${look.id} t=${tt}`);
            if (tt >= 2.5 && l.kind === "ticker") assert.ok(texts(a).length > 0, `${t.id} ${r} ${l.id} ${look.id}: nothing drawn`);
          }
        }
      }
    }
  }
});

test("crawlPeriod: one pass of a crawl in seconds, after which the picture repeats exactly", () => {
  const l = crawlLayer();
  const v = { items: ITEMS };
  const measure = (font: string, s: string) => [...s].length * parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)![1]) * 0.5;
  const strip = crawlStripWidth(l, v, CLASSIC, measure)!;
  assert.ok(strip > 1340);
  const period = crawlPeriod(l, v, CLASSIC, { designW: 1920, designH: 1080, fps: 25, measure })!;
  assert.equal(period, strip / 150);
  assert.equal(crawlPeriod(l, v, CLASSIC, { designW: 1920, designH: 1080, fps: 25, stripW: 3000 }), 20);
  const at = (t: number) => texts(draw(l, v, { t })).map((x) => [x.s, x.x.toFixed(3)]);
  assert.deepEqual(at(3 + period), at(3));
  assert.deepEqual(at(3 + 2 * period), at(3));
  // flip, stack and still tickers
  assert.equal(crawlPeriod(layer("ticker", "f", [0, 0, 100, 50], { mode: "flip", hold: 5 }), v, CLASSIC, { designW: 1920, designH: 1080, fps: 25 }), 20);
  assert.equal(crawlPeriod(layer("ticker", "s", [0, 0, 100, 50], { mode: "stack", rows: 2, hold: 4 }), v, CLASSIC, { designW: 1920, designH: 1080, fps: 25 }), 16);
  assert.equal(crawlPeriod(layer("ticker", "s", [0, 0, 100, 50], { mode: "stack", rows: 4 }), v, CLASSIC, { designW: 1920, designH: 1080, fps: 25 }), 0);
  assert.equal(crawlPeriod(layer("ticker", "b", [0, 0, 100, 50], { mode: "seats" }), v, CLASSIC, { designW: 1920, designH: 1080, fps: 25 }), 0);
  // Node has no canvas: without a measurer the strip can't be known
  assert.equal(crawlPeriod(l, v, CLASSIC, { designW: 1920, designH: 1080, fps: 25 }), null);
  assert.equal(crawlPeriod(l, { items: [] }, CLASSIC, { designW: 1920, designH: 1080, fps: 25 }), 0);
});
