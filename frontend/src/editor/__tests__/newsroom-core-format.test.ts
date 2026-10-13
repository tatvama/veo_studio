import assert from "node:assert/strict";
import { test } from "node:test";
import { fmtClock, fmtDate, fmtNumber, groupDigits, nativeDigits, scriptOf, zonedTimeToMs } from "../newsroom/format.ts";
import { BUILTIN_LOOKS, builtinLook, DEFAULT_LOOK_ID, resolveLook } from "../newsroom/looks.ts";
import { color, cssFont, fontFace, withAlpha } from "../newsroom/render/paint.ts";
import { project } from "./fixtures.ts";

const L = builtinLook(DEFAULT_LOOK_ID)!;
const intl = { numbers: { ...L.numbers, system: "international" as const } };

test("five ready looks with every colour and font", () => {
  assert.deepEqual(BUILTIN_LOOKS.map((l) => l.id), ["look.classic_red", "look.modern_blue", "look.business", "look.sports", "look.regional"]);
  for (const l of BUILTIN_LOOKS) {
    for (const k of ["primary", "secondary", "accent", "dark", "light", "text", "textOnPrimary", "breaking", "live", "up", "down"] as const) assert.match(l.colors[k], /^#[0-9A-F]{6}$/i, `${l.id} ${k}`);
    assert.ok(l.fonts.headline.family && l.fonts.body.family && l.fonts.numbers.family);
    assert.ok(l.fonts.scripts?.deva && l.fonts.scripts.knda && l.fonts.scripts.telu && l.fonts.scripts.taml);
  }
  assert.equal(builtinLook("look.sports")!.fonts.headline.family, "Teko Variable");
  assert.equal(builtinLook("look.regional")!.numbers.digits, "latin");
});

test("resolveLook: the edit's copy, then built-ins, then the edit's look, then the default", () => {
  const p = project();
  assert.equal(resolveLook(p).id, DEFAULT_LOOK_ID);
  p.newsroom = { look: "look.business", looks: { "my.look": { ...L, id: "my.look", name: "Mine" } } } as never;
  assert.equal(resolveLook(p).id, "look.business");
  assert.equal(resolveLook(p, "my.look").name, "Mine");
  assert.equal(resolveLook(p, "look.sports").id, "look.sports");
  assert.equal(resolveLook(p, "nope").id, "look.business");
});

test("numbers: Indian grouping, lakh / crore, K / M / B, sign, currency, native digits", () => {
  assert.equal(groupDigits("1234567", "indian"), "12,34,567");
  assert.equal(groupDigits("1234567", "international"), "1,234,567");
  assert.equal(fmtNumber(1234567, L), "12,34,567");
  assert.equal(fmtNumber(999, L), "999");
  assert.equal(fmtNumber(100000, L), "1,00,000");
  assert.equal(fmtNumber(1234567, L, { compact: true }), "12.35 lakh");
  assert.equal(fmtNumber(123456789, L, { compact: true, currency: true }), "₹12.35 crore");
  assert.equal(fmtNumber(2.5e12, L, { compact: true }), "2.5 lakh crore");
  assert.equal(fmtNumber(45000, L, { compact: true }), "45,000");
  assert.equal(fmtNumber(1234567, intl, { compact: true }), "1.23M");
  assert.equal(fmtNumber(1500, intl, { compact: true }), "1.5K");
  assert.equal(fmtNumber(2.5e9, intl, { compact: true }), "2.5B");
  assert.equal(fmtNumber(1.25, L, { sign: true, decimals: 2, suffix: "%" }), "+1.25%");
  assert.equal(fmtNumber(-0.8, L, { sign: true, decimals: 2 }), "-0.80");
  assert.equal(fmtNumber(0, L, { sign: true }), "0");
  assert.equal(fmtNumber(72.4, L), "72.4");
  assert.equal(fmtNumber(1234567, { ...L, numbers: { ...L.numbers, digits: "native" } }), "१२,३४,५६७");
  assert.equal(fmtNumber(2026, { ...L, numbers: { ...L.numbers, digits: "native" } }, {}, "knda"), "೨,೦೨೬");
  assert.equal(nativeDigits("19:42", "taml"), "௧௯:௪௨");
  assert.equal(fmtNumber(Number.NaN, L), "–");
});

test("clocks and dates in the look's zone, the same on every machine", () => {
  const t = zonedTimeToMs("2026-01-01T19:00", "Asia/Kolkata");
  assert.equal(new Date(t).toISOString(), "2026-01-01T13:30:00.000Z");
  assert.equal(fmtClock(t, L), "19:00");
  assert.equal(fmtClock(t + 42 * 60000 + 7000, L, true), "19:42:07");
  assert.equal(fmtClock(t, builtinLook("look.modern_blue")!), "7:00 PM");
  assert.equal(fmtClock(zonedTimeToMs("2026-03-05T00:15", "Asia/Kolkata"), { ...L, clock: { ...L.clock, hours: 12 } }), "12:15 AM");
  assert.equal(fmtDate(t, L), "1 Jan 2026");
  assert.equal(fmtDate(t, { clock: { ...L.clock, date: "mdy" } }), "Jan 1, 2026");
  assert.equal(fmtDate(t, builtinLook("look.regional")!), "Thursday, 1 January 2026");
  // another zone: London is 8:00 the same moment... 13:30 UTC
  assert.equal(fmtClock(t, { ...L, clock: { ...L.clock, zone: "Europe/London" } }), "13:30");
  // an unknown zone falls back to UTC instead of throwing
  assert.equal(fmtClock(t, { ...L, clock: { ...L.clock, zone: "Mars/Olympus" } }), "13:30");
});

test("scripts by Unicode block", () => {
  assert.equal(scriptOf("Mumbai"), "latn");
  assert.equal(scriptOf("Breaking: मुंबई"), "deva");
  assert.equal(scriptOf("ಬೆಂಗಳೂರು"), "knda");
  assert.equal(scriptOf("హైదరాబాద్"), "telu");
  assert.equal(scriptOf("சென்னை"), "taml");
  assert.equal(scriptOf("কলকাতা"), "beng");
  assert.equal(scriptOf("123 !"), "latn");
});

test("look tokens: colours with opacity, fonts per script", () => {
  assert.equal(color("@primary", L), L.colors.primary);
  assert.equal(color("@textOnPrimary/80", L), "rgba(255,255,255,0.8)");
  assert.equal(color("#ff000080", L), "#ff000080");
  assert.equal(withAlpha("#ff000080", 0.5), "rgba(255,0,0,0.251)");
  assert.equal(color("@nope", L, "@accent"), L.colors.accent);
  assert.equal(color("", L), "");
  assert.deepEqual(fontFace("@headline", L), { family: "Oswald Variable", weight: 700 });
  assert.deepEqual(fontFace("@headline", L, undefined, "मुंबई"), { family: "Anek Devanagari Variable", weight: 700 });
  assert.deepEqual(fontFace("@body", L, 500, "ಬೆಂಗಳೂರು"), { family: "Anek Kannada Variable", weight: 500 });
  assert.deepEqual(fontFace("Bebas Neue", L, 400), { family: "Bebas Neue", weight: 400 });
  assert.match(cssFont("@headline", L, 52), /^700 52px "Oswald Variable", "Anek Devanagari Variable"/);
});
