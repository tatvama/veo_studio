/**
 * Layer kind "bars" (docs/EDITOR.md §16.3, nr-boards): bar charts from a table blank (label, value and colour columns),
 * horizontal or vertical, growing one after another with their values counting along (numbers in the look's style,
 * or percents of the total that add up to 100); the leader can be picked out. "Seats" mode draws an election
 * half-donut: a segment per party sweeping in from the left, the majority line with its label, the declared total in
 * the middle and a legend with each party's count. Owns its in / out.
 */
import type { GfxLayer, NumberFormat } from "../../types.ts";
import type { Ctx2D, LayerRenderContext, PropDef } from "../contract.ts";
import { registerLayerKind } from "../registry.ts";
import {
  barFractions, countFormat, easeBy, fitText, growAt, leaderOf, majorityAngle, majorityOf, num, percents, progress, seatArcs, tableRows,
} from "../../boards/math.ts";
import { choices, fontsOf, fillPlate, fillTabular, inStart, layerMoves, measurer, P, rrPath, tabularWidth, resetDigitCells } from "../../boards/draw.ts";

const G = { d: "Data", s: "Bars", l: "Labels", v: "Values", a: "Animation", e: "Seats" };
const PROPS: PropDef[] = [
  { key: "field", label: "Table blank", type: "field", default: "data", group: G.d },
  { key: "labelCol", label: "Label column", type: "text", default: "label", group: G.d },
  { key: "valueCol", label: "Value column", type: "text", default: "value", group: G.d },
  { key: "colorCol", label: "Colour column", type: "text", default: "color", group: G.d, hint: "Optional: a colour per row" },
  { key: "mode", label: "Chart", type: "choice", default: "horizontal", group: G.d, options: choices("horizontal|Horizontal bars", "vertical|Columns", "seats|Election seats (half donut)") },
  { key: "scale", label: "Bar length", type: "choice", default: "max", group: G.s, options: choices("max|Largest = full", "total|Share of the total", "fixed|Of a fixed maximum") },
  { key: "max", label: "Fixed maximum", type: "number", default: 100, min: 0, group: G.s },
  { key: "barFill", label: "Bar colour", type: "paint", default: "@primary", group: G.s, hint: "Rows with a colour use theirs" },
  { key: "leader", label: "Pick out the leader", type: "bool", default: true, group: G.s },
  { key: "leaderFill", label: "Leader colour", type: "paint", default: "@accent", group: G.s },
  { key: "track", label: "Track colour", type: "paint", default: "@text/10", group: G.s },
  { key: "thickness", label: "Thickness", type: "number", default: 0.5, min: 0.1, max: 1, step: 0.02, group: G.s },
  { key: "radius", label: "Corner radius", type: "number", default: -1, min: -1, max: 60, group: G.s, hint: "−1 = the look's" },
  { key: "labelPos", label: "Labels", type: "choice", default: "above", group: G.l, options: choices("above|Above the bar", "left|Left of the bar") },
  { key: "labelFont", label: "Label font", type: "font", default: "@body", group: G.l },
  { key: "labelSize", label: "Label size", type: "number", default: 38, min: 10, max: 120, unit: "px", group: G.l },
  { key: "labelWeight", label: "Label weight", type: "number", default: 600, min: 100, max: 900, step: 100, group: G.l },
  { key: "labelColor", label: "Label colour", type: "paint", default: "@text", group: G.l },
  { key: "percent", label: "Show percents", type: "bool", default: false, group: G.v, hint: "Of the total; they add up to 100" },
  { key: "decimals", label: "Decimals", type: "number", default: -1, min: -1, max: 3, step: 1, group: G.v, hint: "−1 = as typed" },
  { key: "currency", label: "Currency sign", type: "bool", default: false, group: G.v },
  { key: "compact", label: "Lakh / crore", type: "bool", default: false, group: G.v },
  { key: "prefix", label: "Before", type: "text", default: "", group: G.v },
  { key: "suffix", label: "After", type: "text", default: "", group: G.v },
  { key: "valueFont", label: "Value font", type: "font", default: "@numbers", group: G.v },
  { key: "valueSize", label: "Value size", type: "number", default: 44, min: 10, max: 160, unit: "px", group: G.v },
  { key: "valueColor", label: "Value colour", type: "paint", default: "@text", group: G.v },
  { key: "delay", label: "Start after", type: "number", default: 0.2, min: 0, max: 20, step: 0.05, unit: "s", group: G.a },
  { key: "dur", label: "Grow over", type: "number", default: 1.1, min: 0.1, max: 10, step: 0.05, unit: "s", group: G.a },
  { key: "stagger", label: "Between bars", type: "number", default: 0.12, min: 0, max: 2, step: 0.02, unit: "s", group: G.a },
  { key: "total", label: "House size", type: "number", default: 0, min: 0, group: G.e, hint: "0 = the seats in the table" },
  { key: "totalField", label: "House size blank", type: "field", default: "", group: G.e, hint: "A number blank; wins over the size above" },
  { key: "majority", label: "Majority mark", type: "number", default: 0, min: 0, group: G.e, hint: "0 = half + 1" },
  { key: "majorityField", label: "Majority blank", type: "field", default: "", group: G.e },
  { key: "majorityLabel", label: "Majority label", type: "text", default: "Majority {n}", group: G.e },
  { key: "ring", label: "Ring thickness", type: "number", default: 0.36, min: 0.1, max: 0.9, step: 0.02, group: G.e },
  { key: "centerLabel", label: "Middle label", type: "text", default: "Seats", group: G.e, hint: "Under the declared total; empty = no total" },
  { key: "legend", label: "Legend", type: "bool", default: true, group: G.e },
  { key: "legendCols", label: "Legend columns", type: "number", default: 0, min: 0, max: 8, step: 1, group: G.e, hint: "0 = automatic" },
];

type Box = [number, number, number, number];
interface Row { label: string; value: number; color?: string }

function rowsOf(layer: GfxLayer, rc: Pick<LayerRenderContext, "value">): Row[] {
  const p = layer.p;
  const L = P.str(p, "labelCol", "label"), V = P.str(p, "valueCol", "value"), C = P.str(p, "colorCol", "color");
  return tableRows(rc.value(P.str(p, "field", "data"))).map((r) => {
    const v = num(r[V]);
    const c = r[C];
    return { label: String(r[L] ?? ""), value: Number.isFinite(v) ? v : 0, ...(c ? { color: String(c) } : {}) };
  });
}

/** Value labels, counting with the growth (percents add to 100 when grown). */
function valueTexts(layer: GfxLayer, rc: LayerRenderContext, rows: Row[], grow: number[]): string[] {
  const p = layer.p, d = P.num(p, "decimals", -1);
  if (P.bool(p, "percent", false)) {
    const dec = d >= 0 ? Math.round(d) : 0;
    const pc = percents(rows.map((r) => r.value), dec);
    return pc.map((v, i) => rc.number(grow[i] >= 1 ? v : Math.round(v * grow[i] * 10 ** dec) / 10 ** dec, { decimals: dec, suffix: "%" }));
  }
  const f: NumberFormat = {
    ...(d >= 0 ? { decimals: Math.round(d) } : {}), ...(P.bool(p, "currency", false) ? { currency: true } : {}),
    ...(P.bool(p, "compact", false) ? { compact: true } : {}),
    ...(P.str(p, "prefix", "") ? { prefix: P.str(p, "prefix", "") } : {}), ...(P.str(p, "suffix", "") ? { suffix: P.str(p, "suffix", "") } : {}),
  };
  return rows.map((r, i) => {
    const cf = countFormat(r.value, f, rc.look.numbers.system);
    const dec = cf.f.decimals ?? 0, v = (r.value / cf.div) * grow[i];
    return rc.number(grow[i] >= 1 ? r.value / cf.div : Math.round(v * 10 ** dec) / 10 ** dec, cf.f);
  });
}

function colorOf(p: Record<string, unknown>, r: Row, lead: boolean): string {
  if (r.color) return r.color;
  return lead && P.bool(p, "leader", true) ? (P.paint(p, "leaderFill", "@accent") as string) : (P.paint(p, "barFill", "@primary") as string);
}

function bar(g: Ctx2D, rc: LayerRenderContext, p: Record<string, unknown>, x: number, y: number, w: number, h: number, paint: string): void {
  if (w <= 0.5 || h <= 0.5) return;
  const r = P.num(p, "radius", -1);
  const rad = r >= 0 ? r : rc.look.plate === "rounded" || rc.look.plate === "glass" ? Math.min(rc.look.radius, Math.min(w, h) / 2) : 0;
  rrPath(g, x, y, w, h, rad);
  g.fillStyle = rc.paint(paint);
  g.fill();
  // a soft light along the top edge so bars read as solid, not flat boxes
  const lg = g.createLinearGradient(0, y, 0, y + h);
  lg.addColorStop(0, "rgba(255,255,255,0.18)"); lg.addColorStop(0.5, "rgba(255,255,255,0)"); lg.addColorStop(1, "rgba(0,0,0,0.12)");
  g.fillStyle = lg;
  rrPath(g, x, y, w, h, rad);
  g.fill();
}

function drawHorizontal(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext, rows: Row[]): void {
  const p = layer.p, [x, y, w, h] = layer.box as Box;
  const n = rows.length;
  const start = inStart(layer) + P.num(p, "delay", 0.2), dur = P.num(p, "dur", 1.1), st = P.num(p, "stagger", 0.12);
  const grow = rows.map((_, i) => growAt(rc.t, start, i, st, dur));
  const fr = barFractions(rows.map((r) => r.value), P.str(p, "scale", "max") as "max" | "total" | "fixed", P.num(p, "max", 100));
  const lead = leaderOf(rows.map((r) => r.value));
  const texts = valueTexts(layer, rc, rows, grow);
  const finals = valueTexts(layer, rc, rows, rows.map(() => 1));
  const rowH = h / n;
  const left = P.str(p, "labelPos", "above") === "left";
  const lFont = P.str(p, "labelFont", "@body"), lWeight = P.num(p, "labelWeight", 600);
  const vFont = P.str(p, "valueFont", "@numbers");
  let ls = Math.min(P.num(p, "labelSize", 38), left ? rowH * 0.5 : rowH * 0.34);
  const vs = Math.min(P.num(p, "valueSize", 44), left ? rowH * 0.6 : rowH * 0.5);
  g.font = rc.font(vFont, vs, 700, finals.join(""));
  const vw = Math.max(...finals.map((s) => tabularWidth(g, s))) + vs * 0.5;
  let lw = 0;
  if (left) {
    const m = measurer(g, rc, lFont, lWeight, rows.map((r) => r.label).join(" "));
    lw = Math.min(w * 0.34, Math.max(...rows.map((r) => m(rc.text(r.label), ls))) + ls * 0.8);
    const longest = Math.max(...rows.map((r) => m(rc.text(r.label), ls)));
    if (longest + ls * 0.8 > lw) ls *= Math.max(0.6, (lw - ls * 0.8) / longest);
  }
  const bx = x + lw, bw = Math.max(10, w - lw - vw);
  const thick = P.num(p, "thickness", 0.5);
  for (let i = 0; i < n; i++) {
    const r = rows[i], ry = y + i * rowH;
    const appear = progress(rc.t, start + i * st, 0.25);
    if (appear <= 0) continue;
    g.save();
    g.globalAlpha *= appear;
    const lblH = left ? 0 : ls * 1.3;
    const bh = left ? rowH * thick : Math.min((rowH - lblH) * thick * 1.6, rowH - lblH - rowH * 0.18);
    const by = left ? ry + (rowH - bh) / 2 : ry + lblH + (rowH - lblH - bh) * 0.35;
    // label
    const lab = rc.text(r.label);
    const lf = fitText(lab, { maxW: left ? lw - ls * 0.8 : bw, maxH: ls * 1.3, size: ls, maxLines: 1 }, measurer(g, rc, lFont, lWeight, lab));
    g.font = rc.font(lFont, lf.size, lWeight, lab);
    g.fillStyle = rc.paint(P.paint(p, "labelColor", "@text"));
    g.textBaseline = "middle"; g.textAlign = "left";
    g.fillText(lf.lines[0] ?? "", x, left ? by + bh / 2 : ry + lblH * 0.45);
    // track, bar, value
    g.fillStyle = rc.paint(P.paint(p, "track", "@text/10"));
    rrPath(g, bx, by, bw, bh, P.num(p, "radius", -1) >= 0 ? P.num(p, "radius", -1) : rc.look.plate === "rounded" || rc.look.plate === "glass" ? Math.min(rc.look.radius, bh / 2) : 0);
    g.fill();
    const len = bw * fr[i] * grow[i];
    bar(g, rc, p, bx, by, len, bh, colorOf(p, r, i === lead));
    g.font = rc.font(vFont, vs, 700, texts[i]);
    g.fillStyle = rc.paint(i === lead && P.bool(p, "leader", true) ? P.paint(p, "leaderFill", "@accent") : P.paint(p, "valueColor", "@text"));
    g.textBaseline = "middle";
    fillTabular(g, texts[i], bx + len + vs * 0.35, by + bh / 2 + vs * 0.04, "left");
    g.restore();
  }
}

function drawVertical(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext, rows: Row[]): void {
  const p = layer.p, [x, y, w, h] = layer.box as Box;
  const n = rows.length;
  const start = inStart(layer) + P.num(p, "delay", 0.2), dur = P.num(p, "dur", 1.1), st = P.num(p, "stagger", 0.12);
  const grow = rows.map((_, i) => growAt(rc.t, start, i, st, dur));
  const fr = barFractions(rows.map((r) => r.value), P.str(p, "scale", "max") as "max" | "total" | "fixed", P.num(p, "max", 100));
  const lead = leaderOf(rows.map((r) => r.value));
  const texts = valueTexts(layer, rc, rows, grow);
  const colW = w / n;
  const lFont = P.str(p, "labelFont", "@body"), lWeight = P.num(p, "labelWeight", 600), vFont = P.str(p, "valueFont", "@numbers");
  const ls = Math.min(P.num(p, "labelSize", 38), colW * 0.24), vs = Math.min(P.num(p, "valueSize", 44), colW * 0.32);
  const labH = ls * 2.6, valH = vs * 1.4;
  const base = y + h - labH, top = y + valH;
  const bw = colW * P.num(p, "thickness", 0.5);
  // baseline
  g.fillStyle = rc.paint(P.paint(p, "track", "@text/10"));
  g.fillRect(x, base, w, 3);
  for (let i = 0; i < n; i++) {
    const r = rows[i], cx = x + colW * (i + 0.5);
    const appear = progress(rc.t, start + i * st, 0.25);
    if (appear <= 0) continue;
    g.save();
    g.globalAlpha *= appear;
    const bh = (base - top) * fr[i] * grow[i];
    bar(g, rc, p, cx - bw / 2, base - bh, bw, bh, colorOf(p, r, i === lead));
    g.font = rc.font(vFont, vs, 700, texts[i]);
    g.fillStyle = rc.paint(i === lead && P.bool(p, "leader", true) ? P.paint(p, "leaderFill", "@accent") : P.paint(p, "valueColor", "@text"));
    g.textBaseline = "alphabetic";
    fillTabular(g, texts[i], cx, base - bh - vs * 0.3, "center");
    const lab = rc.text(r.label);
    const lf = fitText(lab, { maxW: colW * 0.94, maxH: labH * 0.92, size: ls, maxLines: 2, lineH: 1.12 }, measurer(g, rc, lFont, lWeight, lab));
    g.font = rc.font(lFont, lf.size, lWeight, lab);
    g.fillStyle = rc.paint(P.paint(p, "labelColor", "@text"));
    g.textAlign = "center"; g.textBaseline = "top";
    lf.lines.forEach((ln, k) => g.fillText(ln, cx, base + ls * 0.45 + k * lf.size * 1.12));
    g.restore();
  }
}

function drawSeats(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext, rows: Row[]): void {
  const p = layer.p, [x, y, w, h] = layer.box as Box;
  const n = rows.length;
  const start = inStart(layer) + P.num(p, "delay", 0.2), dur = P.num(p, "dur", 1.1) * 1.4;
  const reveal = growAt(rc.t, start, 0, 0, dur, "quint");
  const seats = rows.map((r) => Math.max(0, Math.round(r.value)));
  const sum = seats.reduce((a, b) => a + b, 0);
  const fromField = (k: string, d: number) => { const f = P.str(p, k, ""); const v = f ? num(rc.value(f)) : NaN; return Number.isFinite(v) ? v : d; };
  const house = Math.max(sum, Math.round(fromField("totalField", P.num(p, "total", 0))));
  const majSet = Math.round(fromField("majorityField", P.num(p, "majority", 0)));
  const maj = majSet > 0 ? majSet : majorityOf(house);
  const lead = leaderOf(seats);
  const lFont = P.str(p, "labelFont", "@body"), lWeight = P.num(p, "labelWeight", 600), vFont = P.str(p, "valueFont", "@numbers");
  const ls = P.num(p, "labelSize", 38), vs = P.num(p, "valueSize", 44);
  // legend rows under the arc
  const legend = P.bool(p, "legend", true) && n > 0;
  const cols = Math.max(1, Math.min(n, Math.round(P.num(p, "legendCols", 0)) || Math.max(1, Math.floor(w / 380))));
  const lines = legend ? Math.ceil(n / cols) : 0;
  const lineH = Math.max(ls, vs) * 1.55;
  const legendH = lines * lineH + (legend ? ls * 0.6 : 0);
  const topPad = ls * 1.9;
  const R = Math.max(20, Math.min(w / 2 * 0.94, h - legendH - topPad - ls * 0.2));
  const cx = x + w / 2, cy = y + topPad + R;
  const ring = R * P.num(p, "ring", 0.36), r0 = R - ring;
  // the empty arc
  g.beginPath(); g.arc(cx, cy, R, Math.PI, Math.PI * 2); g.arc(cx, cy, r0, Math.PI * 2, Math.PI, true); g.closePath();
  g.fillStyle = rc.paint(P.paint(p, "track", "@text/10"));
  g.fill();
  const arcs = seatArcs(rows.map((r, i) => ({ label: r.label, seats: seats[i], ...(r.color ? { color: r.color } : {}) })), house, reveal);
  const gap = Math.min(0.012, 2 / R);
  arcs.forEach((a, i) => {
    if (a.a1 - a.a0 <= 0.0005) return;
    const a0 = a.a0 + (i > 0 ? gap / 2 : 0), a1 = Math.max(a0, a.a1 - (i < arcs.length - 1 && a.a1 < Math.PI * 2 - 1e-6 ? gap / 2 : 0));
    g.beginPath(); g.arc(cx, cy, R, a0, a1); g.arc(cx, cy, r0, a1, a0, true); g.closePath();
    g.fillStyle = rc.paint(rows[i].color ?? colorOf(p, rows[i], i === lead));
    g.fill();
  });
  // majority line and label
  const ma = majorityAngle(house, maj);
  const lineIn = progress(rc.t, start + dur * 0.5, 0.4);
  if (lineIn > 0) {
    g.save();
    g.globalAlpha *= lineIn;
    const ux = Math.cos(ma), uy = Math.sin(ma);
    g.strokeStyle = rc.paint("@text");
    g.lineWidth = Math.max(3, R * 0.012);
    g.setLineDash([R * 0.035, R * 0.022]);
    g.beginPath(); g.moveTo(cx + ux * (r0 - R * 0.06), cy + uy * (r0 - R * 0.06)); g.lineTo(cx + ux * (R + R * 0.05), cy + uy * (R + R * 0.05)); g.stroke();
    g.setLineDash([]);
    const ml = rc.text(P.str(p, "majorityLabel", "Majority {n}").replace("{n}", rc.number(maj)), true);
    if (ml) {
      g.font = rc.font(lFont, ls * 0.82, 700, ml);
      const tw = g.measureText(ml).width;
      const tx = cx + ux * (R + R * 0.05), ty = cy + uy * (R + R * 0.05) - ls * 0.9;
      fillPlate(g, rc, tx - tw / 2 - ls * 0.45, ty - ls * 0.62, tw + ls * 0.9, ls * 1.24, "@light", { slant: 0, radius: ls * 0.2 });
      g.fillStyle = rc.paint("@dark");
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(ml, tx, ty + ls * 0.02);
    }
    g.restore();
  }
  // the declared total in the middle
  const cl = P.str(p, "centerLabel", "Seats");
  if (cl) {
    const shown = Math.round(sum * reveal);
    const big = Math.min(r0 * 0.62, P.num(p, "valueSize", 44) * 2.6);
    g.font = rc.font(vFont, big, 700, "0");
    g.fillStyle = rc.paint(P.paint(p, "valueColor", "@text"));
    g.textBaseline = "alphabetic";
    const lab = rc.text(cl, true);
    fillTabular(g, `${rc.number(shown)}/${rc.number(house)}`, cx, cy - ls * 1.05, "center");
    g.font = rc.font(lFont, ls * 0.8, 600, lab);
    g.fillStyle = rc.paint(P.paint(p, "labelColor", "@text"));
    g.globalAlpha *= 0.8;
    g.textAlign = "center";
    g.fillText(lab, cx, cy - ls * 0.1);
    g.globalAlpha /= 0.8;
  }
  if (!legend) return;
  const ly = cy + ls * 0.9;
  const cw = w / cols;
  for (let i = 0; i < n; i++) {
    const c = i % cols, rr = Math.floor(i / cols);
    const rowN = Math.min(cols, n - rr * cols);
    const lx = x + (w - rowN * cw) / 2 + c * cw, yy = ly + rr * lineH;
    const appear = progress(rc.t, start + dur * 0.35 + i * 0.06, 0.35);
    if (appear <= 0) continue;
    g.save();
    g.globalAlpha *= appear;
    g.translate(0, (1 - easeBy("quint", appear)) * 18);
    const chip = ls * 0.7;
    const isLead = i === lead && P.bool(p, "leader", true);
    if (isLead) fillPlate(g, rc, lx, yy, cw - ls * 0.4, lineH * 0.86, "@text/10", { slant: 0, radius: 6 });
    rrPath(g, lx + ls * 0.35, yy + (lineH * 0.86 - chip) / 2, chip, chip, chip * 0.2);
    g.fillStyle = rc.paint(rows[i].color ?? colorOf(p, rows[i], i === lead)); g.fill();
    const count = rc.number(Math.round(seats[i] * reveal));
    g.font = rc.font(vFont, vs, 700, count);
    const cwid = tabularWidth(g, count);
    const lab = rc.text(rows[i].label);
    const lf = fitText(lab, { maxW: Math.max(20, cw - chip - cwid - ls * 1.9), maxH: lineH, size: ls, maxLines: 1 }, measurer(g, rc, lFont, isLead ? 700 : lWeight, lab));
    g.font = rc.font(lFont, lf.size, isLead ? 700 : lWeight, lab);
    g.fillStyle = rc.paint(P.paint(p, "labelColor", "@text"));
    g.textAlign = "left"; g.textBaseline = "middle";
    g.fillText(lf.lines[0] ?? "", lx + ls * 0.35 + chip + ls * 0.4, yy + lineH * 0.43);
    g.font = rc.font(vFont, vs, 700, count);
    g.fillStyle = rc.paint(isLead ? P.paint(p, "leaderFill", "@accent") : P.paint(p, "valueColor", "@text"));
    fillTabular(g, count, lx + cw - ls * 0.8, yy + lineH * 0.45, "right");
    g.restore();
  }
}

registerLayerKind({
  kind: "bars", label: "Bars and seats", group: "Data", props: PROPS, ownsAnim: true,
  animates: () => true,
  draw(g, layer, rc) {
    resetDigitCells();
    const rows = rowsOf(layer, rc);
    if (!rows.length) return;
    g.save();
    if (layerMoves(g, layer, rc, "fade")) {
      const m = P.str(layer.p, "mode", "horizontal");
      (m === "seats" ? drawSeats : m === "vertical" ? drawVertical : drawHorizontal)(g, layer, rc, rows);
    }
    g.restore();
  },
  fonts: (layer, rc) => fontsOf(rc.look, [[layer.p.labelFont ?? "@body", P.num(layer.p, "labelWeight", 600)], [layer.p.labelFont ?? "@body", 700], [layer.p.valueFont ?? "@numbers", 700]], rowsOf(layer, rc).map((r) => r.label)),
});

