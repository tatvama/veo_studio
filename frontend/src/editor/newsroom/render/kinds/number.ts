/**
 * Layer kind "number" (docs/EDITOR.md §16.3, nr-boards): a big figure that counts from → to after its delay (eased),
 * written in the look's number style (Indian grouping, lakh / crore, ₹, sign, decimals, prefix / suffix) with tabular
 * figures and the currency sign and unit set smaller; or a countdown timer (hh:mm:ss, optionally in flip tiles with
 * labels). An optional label sits above or below. Owns its in / out (the whole figure moves; the count runs on time).
 */
import type { GfxLayer, NumberFormat } from "../../types.ts";
import type { Ctx2D, LayerRenderContext, PropDef } from "../contract.ts";
import { registerLayerKind } from "../registry.ts";
import { digitScript, nativeDigits } from "../../format.ts";
import { countFormat, countValue, easeBy, num, pad2, parseDuration, progress, splitNumberText, timerLeft, timerParts } from "../../boards/math.ts";
import { choices, fontsOf, fillPlate, fillTabular, inStart, layerMoves, P, setTracking, tabularWidth, triangle, resetDigitCells } from "../../boards/draw.ts";

const G = { v: "Value", c: "Count", f: "Format", s: "Style", l: "Label", t: "Timer" };
const PROPS: PropDef[] = [
  { key: "field", label: "Number blank", type: "field", default: "", group: G.v, hint: "Empty = the value below" },
  { key: "value", label: "Value", type: "number", default: 0, group: G.v },
  { key: "mode", label: "Show", type: "choice", default: "count", group: G.v, options: choices("count|Count up", "static|Just the number", "timer|Countdown timer") },
  { key: "from", label: "Count from", type: "number", default: 0, group: G.c },
  { key: "delay", label: "Start after", type: "number", default: 0.15, min: 0, max: 20, step: 0.05, unit: "s", group: G.c },
  { key: "dur", label: "Count for", type: "number", default: 1.6, min: 0, max: 20, step: 0.1, unit: "s", group: G.c },
  { key: "ease", label: "Easing", type: "choice", default: "expo", group: G.c, options: choices("expo|Fast then slow", "quint|Smooth", "ease_in_out|Even", "linear|Steady", "look|The look's") },
  { key: "currency", label: "Currency sign", type: "bool", default: false, group: G.f },
  { key: "compact", label: "Lakh / crore", type: "bool", default: false, group: G.f, hint: "1,25,00,000 → 1.25 crore" },
  { key: "decimals", label: "Decimals", type: "number", default: -1, min: -1, max: 4, step: 1, group: G.f, hint: "−1 = as typed" },
  { key: "sign", label: "+ for positive", type: "bool", default: false, group: G.f },
  { key: "prefix", label: "Before", type: "text", default: "", group: G.f },
  { key: "suffix", label: "After", type: "text", default: "", group: G.f, hint: "%, crore, km …" },
  { key: "font", label: "Font", type: "font", default: "@numbers", group: G.s },
  { key: "size", label: "Size", type: "number", default: 180, min: 12, max: 600, unit: "px", group: G.s },
  { key: "weight", label: "Weight", type: "number", default: 700, min: 100, max: 900, step: 100, group: G.s },
  { key: "color", label: "Colour", type: "paint", default: "@text", group: G.s },
  { key: "signColors", label: "Up / down colours", type: "bool", default: false, group: G.s, hint: "Green above zero, red below" },
  { key: "arrow", label: "Up / down arrow", type: "bool", default: false, group: G.s, hint: "▲ or ▼ before the number" },
  { key: "align", label: "Align", type: "choice", default: "center", group: G.s, options: choices("left|Left", "center|Centre", "right|Right") },
  { key: "valign", label: "Vertical", type: "choice", default: "center", group: G.s, options: choices("top|Top", "center|Middle", "bottom|Bottom") },
  { key: "tracking", label: "Letter spacing", type: "number", default: 0, min: -10, max: 40, unit: "px", group: G.s },
  { key: "unitScale", label: "Sign and unit size", type: "number", default: 0.5, min: 0.2, max: 1, step: 0.05, group: G.s, hint: "₹ and \"crore\" next to the digits" },
  { key: "unitColor", label: "Sign and unit colour", type: "paint", default: "@accent", group: G.s },
  { key: "label", label: "Label", type: "text", default: "", group: G.l },
  { key: "labelPos", label: "Label sits", type: "choice", default: "below", group: G.l, options: choices("below|Below", "above|Above") },
  { key: "labelFont", label: "Label font", type: "font", default: "@body", group: G.l },
  { key: "labelSize", label: "Label size", type: "number", default: 40, min: 10, max: 200, unit: "px", group: G.l },
  { key: "labelWeight", label: "Label weight", type: "number", default: 600, min: 100, max: 900, step: 100, group: G.l },
  { key: "labelColor", label: "Label colour", type: "paint", default: "@text/80", group: G.l },
  { key: "labelUpper", label: "Label in capitals (look)", type: "bool", default: true, group: G.l },
  { key: "units", label: "Timer shows", type: "choice", default: "hms", group: G.t, options: choices("dhms|Days to seconds", "hms|Hours to seconds", "ms|Minutes and seconds") },
  { key: "tiles", label: "Tiles", type: "bool", default: false, group: G.t },
  { key: "tileFill", label: "Tile colour", type: "paint", default: "@dark/85", group: G.t },
  { key: "tileLabels", label: "Tile labels", type: "text", default: "Days, Hours, Minutes, Seconds", group: G.t, hint: "Comma separated, largest first" },
  { key: "flip", label: "Flip on change", type: "bool", default: true, group: G.t },
];

type Box = [number, number, number, number];

/** The number the layer shows (field first, else its own value). */
function target(layer: GfxLayer, rc: Pick<LayerRenderContext, "value">): unknown {
  const f = P.str(layer.p, "field", "");
  return f ? rc.value(f) : layer.p.value;
}
const fmtOf = (p: Record<string, unknown>): NumberFormat => {
  const d = P.num(p, "decimals", -1);
  return {
    ...(d >= 0 ? { decimals: Math.round(d) } : {}),
    ...(P.bool(p, "currency", false) ? { currency: true } : {}), ...(P.bool(p, "compact", false) ? { compact: true } : {}),
    ...(P.bool(p, "sign", false) ? { sign: true } : {}),
    ...(P.str(p, "prefix", "") ? { prefix: P.str(p, "prefix", "") } : {}), ...(P.str(p, "suffix", "") ? { suffix: P.str(p, "suffix", "") } : {}),
  };
};

/** The text a count shows at `t` (also its value, for up / down colours). */
export function numberText(layer: GfxLayer, rc: LayerRenderContext, final = false): { text: string; value: number } {
  const p = layer.p;
  const to = Number.isFinite(num(target(layer, rc))) ? num(target(layer, rc)) : 0;
  const cf = countFormat(to, fmtOf(p), rc.look.numbers.system);
  const mode = P.str(p, "mode", "count");
  const ease = P.str(p, "ease", "expo");
  const v = final || mode === "static" ? to / cf.div : countValue({
    from: P.num(p, "from", 0) / cf.div, to: to / cf.div, start: inStart(layer) + P.num(p, "delay", 0.15), dur: P.num(p, "dur", 1.6),
    decimals: cf.f.decimals ?? 0,
  }, rc.t, (x) => (ease === "look" ? rc.ease(x) : easeBy(ease, x)));
  return { text: rc.number(v, cf.f), value: v * cf.div };
}

/** Ascent of digits in the current font (falls back to 0.72 em). */
function capOf(g: Ctx2D, size: number): number {
  const m = g.measureText("8");
  const a = m.actualBoundingBoxAscent;
  return typeof a === "number" && a > 0 ? a : size * 0.72;
}

function drawCount(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext): void {
  const p = layer.p, [x, y, w, h] = layer.box as Box;
  const { text, value } = numberText(layer, rc);
  const parts = splitNumberText(text);
  const font = P.str(p, "font", "@numbers"), weight = P.num(p, "weight", 700), us = P.num(p, "unitScale", 0.5);
  const label = P.str(p, "label", "") ? rc.text(P.str(p, "label", ""), P.bool(p, "labelUpper", true)) : "";
  const lSize = P.num(p, "labelSize", 40), lFont = P.str(p, "labelFont", "@body"), lWeight = P.num(p, "labelWeight", 600);
  const lBlock = label ? lSize * 1.15 + lSize * 0.45 : 0;
  // the final text decides the size, so the figure doesn't grow while it counts
  const fin = splitNumberText(numberText(layer, rc, true).text);
  const widthAt = (s: number, q: typeof parts) => {
    g.font = rc.font(font, s, weight, text);
    const core = tabularWidth(g, q.core) + (q.sign ? g.measureText(q.sign).width : 0);
    g.font = rc.font(font, s * us, weight, text);
    const lead = q.lead ? g.measureText(q.lead.trim()).width + s * 0.05 : 0;
    const tail = q.tail ? g.measureText(q.tail.trim()).width + (/^\s/.test(q.tail) ? s * 0.1 : s * 0.02) : 0;
    return core + lead + tail;
  };
  let size = P.num(p, "size", 180);
  const maxH = Math.max(10, h - lBlock);
  size = Math.min(size, maxH / 0.95);
  const need = widthAt(size, fin) + (P.bool(p, "arrow", false) ? size * 0.62 : 0);
  if (need > w) size *= Math.max(0.35, w / need);
  setTracking(g, P.num(p, "tracking", 0));
  g.font = rc.font(font, size, weight, text);
  const cap = capOf(g, size);
  const blockH = cap + lBlock;
  const va = P.str(p, "valign", "center");
  const top = va === "top" ? y : va === "bottom" ? y + h - blockH : y + (h - blockH) / 2;
  const labelAbove = P.str(p, "labelPos", "below") === "above";
  const base = (labelAbove ? top + lBlock : top) + cap;
  const arrow = P.bool(p, "arrow", false) && value !== 0 ? size * 0.62 : 0;
  const total = widthAt(size, parts) + arrow;
  const al = P.str(p, "align", "center");
  let at = al === "left" ? x : al === "right" ? x + w - total : x + (w - total) / 2;
  const col = P.bool(p, "signColors", false) && value !== 0 ? (value > 0 ? "@up" : "@down") : P.paint(p, "color", "@text");
  g.textBaseline = "alphabetic"; g.textAlign = "left";
  if (arrow) {
    g.fillStyle = rc.paint(value > 0 ? "@up" : "@down");
    triangle(g, at + size * 0.24, base - cap * 0.5, size * 0.42, value > 0);
    at += arrow;
  }
  if (parts.sign) { g.font = rc.font(font, size, weight, text); g.fillStyle = rc.paint(col); g.fillText(parts.sign, at, base); at += g.measureText(parts.sign).width; }
  if (parts.lead) {
    g.font = rc.font(font, size * us, weight, text);
    const capS = capOf(g, size * us);
    g.fillStyle = rc.paint(P.paint(p, "unitColor", "@accent"));
    g.fillText(parts.lead.trim(), at, base - cap + capS);          // tops line up (₹ raised)
    at += g.measureText(parts.lead.trim()).width + size * 0.05;
  }
  g.font = rc.font(font, size, weight, text);
  g.fillStyle = rc.paint(col);
  at += fillTabular(g, parts.core, at, base);
  if (parts.tail) {
    const gap = /^\s/.test(parts.tail) ? size * 0.1 : size * 0.02;
    g.font = rc.font(font, size * us, weight, text);
    g.fillStyle = rc.paint(P.paint(p, "unitColor", "@accent"));
    // degrees and primes sit up at the top of the digits; units sit on the baseline
    const raised = /^[°′″]/.test(parts.tail.trim());
    g.fillText(parts.tail.trim(), at + gap, raised ? base - cap + capOf(g, size * us) : base);
  }
  setTracking(g, 0);
  if (label) {
    g.font = rc.font(lFont, lSize, lWeight, label);
    g.fillStyle = rc.paint(P.paint(p, "labelColor", "@text/80"));
    g.textAlign = al === "left" ? "left" : al === "right" ? "right" : "center";
    const lx = al === "left" ? x : al === "right" ? x + w : x + w / 2;
    const ly = labelAbove ? top + lSize * 0.95 : base + lSize * 0.45 + lSize * 0.95;
    g.fillText(label, lx, ly);
    g.textAlign = "left";
  }
}

const UNIT_NAMES = { dhms: ["Days", "Hours", "Minutes", "Seconds"], hms: ["Hours", "Minutes", "Seconds"], ms: ["Minutes", "Seconds"] };

function drawTimer(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext): void {
  const p = layer.p, [x, y, w, h] = layer.box as Box;
  const units = (["dhms", "hms", "ms"].includes(P.str(p, "units", "hms")) ? P.str(p, "units", "hms") : "hms") as "dhms" | "hms" | "ms";
  const total = parseDuration(target(layer, rc));
  const from = Number.isFinite(total) ? Math.max(0, total) : 0;
  const start = inStart(layer) + P.num(p, "delay", 0.15);
  const left = timerLeft(from, rc.t, start);
  const ds = digitScript(rc.look);
  const nat = (s: string) => (ds === "latn" ? s : nativeDigits(s, ds));
  const parts = timerParts(left, units).map(pad2).map(nat);
  const prev = timerParts(Math.min(from, left + 1), units).map(pad2).map(nat);
  const since = rc.t - start;
  const tick = since >= 1 && left < from ? since - Math.floor(since) : 1;   // seconds since the last change
  const flipP = P.bool(p, "flip", true) ? progress(tick, 0, 0.28) : 1;
  const font = P.str(p, "font", "@numbers"), weight = P.num(p, "weight", 700);
  const col = rc.paint(P.paint(p, "color", "@text"));
  const sep = P.paint(p, "unitColor", "@accent");
  if (!P.bool(p, "tiles", false)) {
    const s = parts.join(":");
    let size = Math.min(P.num(p, "size", 180), h / 0.95);
    g.font = rc.font(font, size, weight, s);
    const need = tabularWidth(g, s);
    if (need > w) { size *= w / need; g.font = rc.font(font, size, weight, s); }
    const cap = capOf(g, size);
    const al = P.str(p, "align", "center");
    const tw = tabularWidth(g, s);
    let at = al === "left" ? x : al === "right" ? x + w - tw : x + (w - tw) / 2;
    const base = y + (h - cap) / 2 + cap;
    parts.forEach((part, i) => {
      if (i) { g.fillStyle = rc.paint(sep); at += fillTabular(g, ":", at, base - size * 0.04); }
      g.fillStyle = col;
      at += fillTabular(g, part, at, base);
    });
    return;
  }
  // tiles: one per unit with its label underneath, colons between
  const n = parts.length;
  const labels = (P.str(p, "tileLabels", "") || UNIT_NAMES.dhms.join(",")).split(",").map((s) => s.trim());
  const names = labels.length >= 4 ? labels.slice(4 - n) : UNIT_NAMES[units];
  const lSize = P.num(p, "labelSize", 34), lFont = P.str(p, "labelFont", "@body"), lWeight = P.num(p, "labelWeight", 600);
  const colonW = Math.min(w * 0.06, h * 0.35);
  const tileW = (w - colonW * (n - 1)) / n, tileH = Math.max(20, h - lSize * 1.9);
  let size = Math.min(P.num(p, "size", 180), tileH * 0.78);
  g.font = rc.font(font, size, weight, "00");
  const dw = tabularWidth(g, parts.reduce((a, b) => (b.length > a.length ? b : a), "00"));
  if (dw > tileW * 0.84) { size *= (tileW * 0.84) / dw; g.font = rc.font(font, size, weight, "00"); }
  const cap = capOf(g, size);
  for (let i = 0; i < n; i++) {
    const tx = x + i * (tileW + colonW);
    fillPlate(g, rc, tx, y, tileW, tileH, P.paint(p, "tileFill", "@dark/85"), { slant: 0 });
    // the flip line across the middle
    g.fillStyle = "rgba(0,0,0,0.28)";
    g.fillRect(tx, y + tileH / 2 - 1.5, tileW, 3);
    g.save();
    g.beginPath(); g.rect(tx, y, tileW, tileH); g.clip();
    g.font = rc.font(font, size, weight, "00");
    g.fillStyle = col;
    const base = y + (tileH - cap) / 2 + cap;
    if (flipP < 1 && prev[i] !== parts[i]) {
      // a rolling counter: the old value rolls down out of the tile as the new one rolls in from the top
      const e = easeBy("quint", flipP), a0 = g.globalAlpha;
      g.globalAlpha = a0 * (1 - e * 0.6);
      fillTabular(g, prev[i], tx + tileW / 2, base + e * tileH, "center");
      g.globalAlpha = a0 * (0.4 + 0.6 * e);
      fillTabular(g, parts[i], tx + tileW / 2, base - (1 - e) * tileH, "center");
      g.globalAlpha = a0;
    } else fillTabular(g, parts[i], tx + tileW / 2, base, "center");
    g.restore();
    if (i < n - 1) {
      g.fillStyle = rc.paint(sep);
      const cx = tx + tileW + colonW / 2, r = Math.max(3, Math.min(colonW * 0.16, size * 0.06));
      for (const k of [-1, 1]) { g.beginPath(); g.arc(cx, y + tileH / 2 + k * tileH * 0.14, r, 0, Math.PI * 2); g.fill(); }
    }
    const nm = names[i] ?? "";
    if (nm) {
      const s = rc.text(nm, P.bool(p, "labelUpper", true));
      g.font = rc.font(lFont, lSize, lWeight, s);
      g.fillStyle = rc.paint(P.paint(p, "labelColor", "@text/80"));
      g.textAlign = "center";
      g.fillText(s, tx + tileW / 2, y + tileH + lSize * 1.35);
      g.textAlign = "left";
    }
  }
}

registerLayerKind({
  kind: "number", label: "Counting number", group: "Data", props: PROPS, ownsAnim: true,
  animates: () => true,
  draw(g, layer, rc) {
    resetDigitCells();
    g.save();
    if (layerMoves(g, layer, rc, "rise")) (P.str(layer.p, "mode", "count") === "timer" ? drawTimer : drawCount)(g, layer, rc);
    g.restore();
  },
  measure(g, layer, rc) {
    const p = layer.p;
    const s = numberText(layer, rc, true).text;
    g.font = rc.font(P.str(p, "font", "@numbers"), P.num(p, "size", 180), P.num(p, "weight", 700), s);
    return tabularWidth(g, s);
  },
  fonts: (layer, rc) => fontsOf(rc.look, [[layer.p.font ?? "@numbers", P.num(layer.p, "weight", 700)], [layer.p.labelFont ?? "@body", P.num(layer.p, "labelWeight", 600)]], [rc.text(P.str(layer.p, "label", ""))]),
});
