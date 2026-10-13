/**
 * Make my look's colours (newsroom/designer/palette.ts, docs/EDITOR.md §16.8): k-means on a logo's pixels is
 * deterministic and finds its main colours (without the flat background), and the look palette always has readable
 * text (WCAG ≥ 4.5) on its plates.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { brandColors, contrast, contrastChecks, kmeans, logoPalette, lookColors, lookFromLogo, parseHex, rgbToOklab, withContrast, type Lab } from "../newsroom/designer/palette.ts";
import { BUILTIN_LOOKS } from "../newsroom/looks.ts";

/** A W×H logo: a white background with bands of colours (fractions of the inner area). */
function logo(W: number, H: number, bands: [string, number][], bg: string | null = "#FFFFFF"): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  const cols = bands.map(([c, f]) => [parseHex(c)!, f] as const);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const inner = x >= 4 && x < W - 4 && y >= 4 && y < H - 4;
    let c: [number, number, number] | null = bg ? parseHex(bg)! : null;
    if (inner) {
      const u = (x - 4) / (W - 8);
      let acc = 0;
      for (const [rgb, f] of cols) { acc += f; if (u < acc) { c = rgb; break; } }
    }
    if (c) { px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255; }
  }
  return px;
}

test("contrast maths matches WCAG", () => {
  assert.equal(Math.round(contrast("#000000", "#FFFFFF")), 21);
  assert.equal(contrast("#777777", "#777777"), 1);
  assert.ok(Math.abs(contrast("#FFFFFF", "#C8102E") - 5.9) < 0.2);
});

test("k-means is deterministic and separates clear clusters", () => {
  const pts: Lab[] = [];
  for (let i = 0; i < 300; i++) pts.push(rgbToOklab(200 + (i % 5), 16, 46), rgbToOklab(16, 26 + (i % 3), 51), rgbToOklab(255, 194, 14 + (i % 4)));
  const a = kmeans(pts, 3), b = kmeans(pts, 3);
  assert.deepEqual(a.centers, b.centers);
  assert.deepEqual([...a.counts].sort(), [300, 300, 300]);
});

test("a logo's main colours, biggest first, without its white background", () => {
  const px = logo(120, 60, [["#C8102E", 0.6], ["#101A33", 0.3], ["#FFC20E", 0.1]]);
  const sw = logoPalette(px, 120, 60);
  assert.ok(sw.length >= 3 && sw.length <= 5, `${sw.length} swatches`);
  const near = (hex: string, want: string) => contrast(hex, want) < 1.15;
  assert.ok(near(sw[0].hex, "#C8102E"), sw[0].hex);
  assert.ok(sw.some((s) => near(s.hex, "#101A33")));
  assert.ok(sw.some((s) => near(s.hex, "#FFC20E")));
  assert.ok(!sw.some((s) => near(s.hex, "#FFFFFF")), "background left out");
  assert.deepEqual(logoPalette(px, 120, 60), sw, "same logo, same colours");
  // transparent PNG: the transparent pixels are ignored
  const t = logo(80, 40, [["#1255CC", 0.7], ["#22C7F2", 0.3]], null);
  const st = logoPalette(t, 80, 40);
  assert.ok(near(st[0].hex, "#1255CC"), st[0].hex);
});

test("brand colours: the colourful one is primary; dark secondary; contrasting accent", () => {
  const sw = logoPalette(logo(120, 60, [["#0E9F4A", 0.55], ["#111111", 0.35], ["#D7FF2F", 0.1]]), 120, 60);
  const b = brandColors(sw);
  assert.ok(contrast(b.primary, "#0E9F4A") < 1.2, b.primary);
  assert.ok(contrast(b.secondary, "#111111") < 1.3, b.secondary);
  assert.ok(contrast(b.accent, "#D7FF2F") < 1.2, b.accent);
  assert.deepEqual(brandColors([]), { primary: "#C8102E", secondary: "#101A33", accent: "#FFC20E" });
});

test("every look palette has readable text on its plates (≥ 4.5)", () => {
  const base = BUILTIN_LOOKS[0].colors;
  const cases: [string, string, string][] = [
    ["#FFD400", "#FFF6A0", "#FF8800"], // a yellow logo: dark text on the primary
    ["#E35D0A", "#F5A623", "#7ED321"], // orange: white text after darkening
    ["#9AD7FF", "#BEE6FF", "#FFFFFF"], // pale blues: deep secondary made
    ["#C8102E", "#101A33", "#FFC20E"],
  ];
  for (const [p, s, a] of cases) {
    const c = lookColors({ primary: p, secondary: s, accent: a }, base);
    for (const chk of contrastChecks(c).filter((x) => x.label !== "Text on breaking")) assert.ok(chk.ratio >= 4.5, `${p}: ${chk.label} ${chk.ratio}`);
  }
  const yellow = lookColors({ primary: "#FFD400", secondary: "#222222", accent: "#FF0000" }, base);
  assert.notEqual(yellow.textOnPrimary, "#FFFFFF", "dark text on yellow");
  const red = lookColors({ primary: "#C8102E", secondary: "#101A33", accent: "#FFC20E" }, base);
  assert.equal(red.textOnPrimary, "#FFFFFF");
  assert.equal(red.primary, "#C8102E", "already readable: unchanged");
});

test("withContrast keeps the hue and only moves as far as needed", () => {
  const out = withContrast("#FF7A00", "#FFFFFF", 4.5);
  assert.ok(contrast(out, "#FFFFFF") >= 4.5 && contrast(out, "#FFFFFF") < 5.2, `${out}`);
  const [r, g, b] = parseHex(out)!;
  assert.ok(r > g && g > b, "still orange");
});

test("a look from a logo keeps the base style and gets the new colours", () => {
  const base = BUILTIN_LOOKS.find((l) => l.id === "look.sports")!;
  const sw = logoPalette(logo(100, 50, [["#6A1B9A", 0.7], ["#FFD54A", 0.3]]), 100, 50);
  const l = lookFromLogo(base, sw, { id: "look.my.abcd1234", name: "My channel", logo: { text: "MY TV" } });
  assert.equal(l.id, "look.my.abcd1234"); assert.equal(l.builtIn, undefined);
  assert.equal(l.fonts.headline.family, base.fonts.headline.family);
  assert.equal(l.motion, base.motion);
  assert.ok(contrast(l.colors.primary, "#6A1B9A") < 1.3);
  assert.equal(base.colors.primary, "#0E9F4A", "the base look is untouched");
});
