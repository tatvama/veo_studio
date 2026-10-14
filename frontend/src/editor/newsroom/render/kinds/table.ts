/**
 * Layer kind "table" (docs/EDITOR.md §16.3, nr-boards): rows and columns from a table blank, for rates boards, market
 * tables and cricket scorecards. Columns (order and headings), alignment and widths are props; number columns are
 * written in the look's style (Indian grouping, ₹ for money columns, +/− with up / down colours and arrows for change
 * columns, % columns), with tabular figures. A header row, zebra rows, dividers, a highlighted row, and a row-by-row
 * build. The whole table shrinks to fit its box. Owns its in / out.
 */
import type { GfxLayer, GfxTableRow, NumberFormat } from "../../types.ts";
import type { Ctx2D, LayerRenderContext, PropDef } from "../contract.ts";
import { registerLayerKind } from "../registry.ts";
import { columnLayout, ellipsize, easeBy, idList, isNumericCol, num, parseAligns, parseColumns, progress, tableRows, wrapWords, type Align, type TableCol } from "../../boards/math.ts";
import { applyMove, choices, easeIn, fontsOf, fillPlate, fillTabular, inStart, P, rrPath, tabularWidth, triangle, resetDigitCells } from "../../boards/draw.ts";

const G = { d: "Data", c: "Columns", t: "Text", h: "Header", r: "Rows", b: "Build" };
const PROPS: PropDef[] = [
  { key: "field", label: "Table blank", type: "field", default: "rows", group: G.d },
  { key: "maxRows", label: "Most rows", type: "number", default: 0, min: 0, max: 30, step: 1, group: G.d, hint: "0 = all" },
  { key: "columns", label: "Columns", type: "text", default: "", group: G.c, hint: "id=Heading, … (empty = every column)" },
  { key: "align", label: "Alignment", type: "text", default: "auto", group: G.c, hint: "One letter per column: l, c, r" },
  { key: "widths", label: "Widths", type: "text", default: "auto", group: G.c, hint: "Shares per column, e.g. 3,1,1" },
  { key: "money", label: "Money columns", type: "text", default: "", group: G.c, hint: "Column ids shown with ₹" },
  { key: "signed", label: "Change columns", type: "text", default: "", group: G.c, hint: "Column ids with +/−, arrows and up / down colours" },
  { key: "percentCols", label: "Percent columns", type: "text", default: "", group: G.c },
  { key: "decimals", label: "Decimals", type: "number", default: -1, min: -1, max: 4, step: 1, group: G.c, hint: "−1 = as typed" },
  { key: "font", label: "Font", type: "font", default: "@body", group: G.t },
  { key: "numberFont", label: "Number font", type: "font", default: "@numbers", group: G.t },
  { key: "size", label: "Size", type: "number", default: 40, min: 10, max: 120, unit: "px", group: G.t },
  { key: "weight", label: "Weight", type: "number", default: 600, min: 100, max: 900, step: 100, group: G.t },
  { key: "color", label: "Colour", type: "paint", default: "@text", group: G.t },
  { key: "firstBold", label: "First column bold", type: "bool", default: true, group: G.t },
  { key: "header", label: "Header row", type: "bool", default: true, group: G.h },
  { key: "headerFill", label: "Header colour", type: "paint", default: "@primary", group: G.h },
  { key: "headerColor", label: "Header text", type: "paint", default: "@textOnPrimary", group: G.h },
  { key: "headerFont", label: "Header font", type: "font", default: "@headline", group: G.h },
  { key: "headerUpper", label: "Header in capitals (look)", type: "bool", default: true, group: G.h },
  { key: "rowFill", label: "Row colour", type: "paint", default: "@dark/60", group: G.r },
  { key: "zebra", label: "Zebra rows", type: "bool", default: true, group: G.r },
  { key: "zebraFill", label: "Zebra colour", type: "paint", default: "@light/8", group: G.r },
  { key: "lines", label: "Lines between rows", type: "bool", default: true, group: G.r },
  { key: "lineColor", label: "Line colour", type: "paint", default: "@text/12", group: G.r },
  { key: "highlight", label: "Highlight row", type: "number", default: 0, min: 0, max: 30, step: 1, group: G.r, hint: "Row number; 0 = none. Rows with a \"highlight\" column of 1 too" },
  { key: "hiFill", label: "Highlight colour", type: "paint", default: "@accent", group: G.r },
  { key: "hiColor", label: "Highlight text", type: "paint", default: "@dark", group: G.r },
  { key: "wrap", label: "Wrap long text", type: "bool", default: true, group: G.t, hint: "Two smaller lines in the row before cutting it short" },
  { key: "rowHeight", label: "Row height", type: "number", default: 1.9, min: 1.2, max: 3.5, step: 0.05, group: G.r, hint: "In text heights (rows shrink to fit)" },
  { key: "build", label: "Build", type: "choice", default: "row", group: G.b, options: choices("row|Row by row", "all|All together") },
  { key: "delay", label: "Start after", type: "number", default: 0.15, min: 0, max: 20, step: 0.05, unit: "s", group: G.b },
  { key: "stagger", label: "Between rows", type: "number", default: 0.08, min: 0, max: 2, step: 0.01, unit: "s", group: G.b },
  { key: "rowDur", label: "Row comes in over", type: "number", default: 0.42, min: 0.05, max: 3, step: 0.05, unit: "s", group: G.b },
];

type Box = [number, number, number, number];

interface Cell { text: string; num: number; numeric: boolean; signed: boolean }
function rowsOf(layer: GfxLayer, rc: Pick<LayerRenderContext, "value">): GfxTableRow[] {
  const all = tableRows(rc.value(P.str(layer.p, "field", "rows")));
  const max = Math.round(P.num(layer.p, "maxRows", 0));
  return max > 0 ? all.slice(0, max) : all;
}

/** The cells as they're written (numbers in the look's style). */
export function tableCells(layer: GfxLayer, rc: Pick<LayerRenderContext, "value" | "number">, rows: GfxTableRow[], cols: TableCol[]): Cell[][] {
  const p = layer.p;
  const money = new Set(idList(p.money)), signed = new Set(idList(p.signed)), pct = new Set(idList(p.percentCols));
  const d = P.num(p, "decimals", -1);
  const numericCols = cols.map((c) => isNumericCol(rows, c.id));
  return rows.map((r) => cols.map((c, j) => {
    const raw = r[c.id];
    const v = num(raw);
    if (!numericCols[j] || !Number.isFinite(v)) return { text: raw === undefined ? "" : String(raw), num: NaN, numeric: false, signed: false };
    const f: NumberFormat = {
      ...(d >= 0 ? { decimals: Math.round(d) } : {}), ...(money.has(c.id) ? { currency: true } : {}),
      ...(signed.has(c.id) ? { sign: true } : {}), ...(pct.has(c.id) ? { suffix: "%" } : {}),
    };
    return { text: rc.number(v, f), num: v, numeric: true, signed: signed.has(c.id) };
  }));
}

function draw(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext): void {
  const p = layer.p, [x, y, w, h] = layer.box as Box;
  const rows = rowsOf(layer, rc);
  if (!rows.length) return;
  const cols = parseColumns(p.columns, rows);
  if (!cols.length) return;
  const aligns: Align[] = parseAligns(p.align, cols, rows);
  const cells = tableCells(layer, rc, rows, cols);
  const header = P.bool(p, "header", true);
  const font = P.str(p, "font", "@body"), nFont = P.str(p, "numberFont", "@numbers"), hFont = P.str(p, "headerFont", "@headline");
  const weight = P.num(p, "weight", 600), firstBold = P.bool(p, "firstBold", true);
  const heads = cols.map((c) => rc.text(c.label, P.bool(p, "headerUpper", true)));
  const n = rows.length;
  // size: rows fit the height, columns fit the width
  let size = P.num(p, "size", 40);
  const rhK = P.num(p, "rowHeight", 1.9), hK = 1.55;
  const hRows = (header ? hK : 0) + n * rhK;
  if (hRows * size > h) size = h / hRows;
  const wrap = P.bool(p, "wrap", true) && P.num(p, "rowHeight", 1.9) >= 1.6;
  const contentAt = (s: number) => cols.map((_, j) => {
    let m = 0;
    if (header) { g.font = rc.font(hFont, s * 0.72, 700, heads[j]); m = g.measureText(heads[j]).width; }
    for (let i = 0; i < n; i++) {
      const c = cells[i][j];
      g.font = rc.font(c.numeric ? nFont : font, s, j === 0 && firstBold ? 700 : weight, c.text);
      const tw = c.numeric ? tabularWidth(g, c.text) : g.measureText(c.text).width;
      // text that may wrap needs about half its width (but its longest word whole)
      const need = !c.numeric && wrap && c.text.includes(" ") ? Math.max(tw * 0.56, ...c.text.split(/\s+/).map((wd) => g.measureText(wd).width)) : tw;
      m = Math.max(m, need + (c.signed ? s * 0.75 : 0));
    }
    return m + s * 1.1;
  });
  let content = contentAt(size);
  const sum = content.reduce((a, b) => a + b, 0);
  if (sum > w) {
    // shrink (to 70 %) before the first column starts to be cut short
    const k = Math.max(0.7, w / sum);
    if (k < 1) { size *= k; content = contentAt(size); }
  }
  const lay = columnLayout(p.widths, content, w, 0);
  const headH = header ? size * hK : 0;
  const rowH = Math.min(size * rhK * 1.25, (h - headH) / n);
  const start = inStart(layer) + P.num(p, "delay", 0.15), st = P.num(p, "stagger", 0.08), rd = P.num(p, "rowDur", 0.42);
  const all = P.str(p, "build", "row") === "all";
  const radius = rc.look.plate === "rounded" || rc.look.plate === "glass" ? rc.look.radius : rc.look.plate === "flat" ? 2 : 0;
  const pad = size * 0.55;
  const hiRow = Math.round(P.num(p, "highlight", 0)) - 1;
  // the whole table is clipped to its rounded outline
  const totalH = headH + rowH * n;
  g.save();
  rrPath(g, x, y, w, totalH, radius);
  g.clip();
  const textAt = (s: string, j: number, cy: number, numeric: boolean, signed: boolean, value: number) => {
    const { x: cx, w: cw } = lay[j];
    const al = aligns[j];
    const inner = cw - pad * 2;
    const tw = numeric ? tabularWidth(g, s) : g.measureText(s).width;
    if (!numeric && tw > inner && wrap && s.includes(" ")) {
      // two smaller lines inside the row
      const font0 = g.font, sz = size * 0.84;
      g.font = font0.replace(/(\d+(?:\.\d+)?)px/, `${sz.toFixed(2)}px`);
      const lines = wrapWords(s, inner, (q) => g.measureText(q).width);
      const two = lines.length <= 2 ? lines : [lines[0], ellipsize(lines.slice(1).join(" "), inner, (q) => g.measureText(q).width)];
      two.forEach((ln, k) => {
        const lw = Math.min(inner, g.measureText(ln).width);
        const shownLn = g.measureText(ln).width > inner ? ellipsize(ln, inner, (q) => g.measureText(q).width) : ln;
        const lx = al === "right" ? x + cx + cw - pad - lw : al === "center" ? x + cx + (cw - lw) / 2 : x + cx + pad;
        g.fillText(shownLn, lx, cy + (k - (two.length - 1) / 2) * sz * 1.08 + size * 0.03);
      });
      g.font = font0;
      return;
    }
    const shown = !numeric && tw > inner ? ellipsize(s, inner, (q) => g.measureText(q).width) : s;
    const sw = numeric ? tw : Math.min(tw, inner);
    let tx = al === "right" ? x + cx + cw - pad - sw : al === "center" ? x + cx + (cw - sw) / 2 : x + cx + pad;
    if (signed && Number.isFinite(value) && value !== 0) {
      const tri = size * 0.42;
      const keep = g.fillStyle;
      g.fillStyle = rc.paint(value > 0 ? "@up" : "@down");
      if (al === "left") { triangle(g, tx + tri / 2, cy, tri, value > 0); tx += tri + size * 0.25; }
      else triangle(g, tx - size * 0.25 - tri / 2, cy, tri, value > 0);
      g.fillStyle = keep;
    }
    if (numeric) fillTabular(g, shown, tx, cy + size * 0.03, "left");
    else g.fillText(shown, tx, cy + size * 0.03);
  };
  g.textBaseline = "middle"; g.textAlign = "left";
  if (header) {
    const e = all ? 1 : easeBy("quint", progress(rc.t, start, rd));
    if (e > 0) {
      g.save();
      g.beginPath(); g.rect(x, y, w * e, headH); g.clip();
      fillPlate(g, rc, x, y, w, headH, P.paint(p, "headerFill", "@primary"), { slant: 0, radius: 0 });
      g.fillStyle = rc.paint(P.paint(p, "headerColor", "@textOnPrimary"));
      for (let j = 0; j < cols.length; j++) {
        g.font = rc.font(hFont, size * 0.72, 700, heads[j]);
        textAt(heads[j], j, y + headH / 2, false, false, NaN);
      }
      g.restore();
    }
  }
  for (let i = 0; i < n; i++) {
    const t0 = all ? start : start + (header ? st * 1.5 : 0) + i * st;
    const pr = progress(rc.t, t0, rd);
    if (pr <= 0) continue;
    const ry = y + headH + i * rowH;
    const e = easeIn(rc, pr);
    g.save();
    // the row wipes in from the left, its text slides a little behind
    g.beginPath(); g.rect(x, ry, w * easeBy("quint", Math.min(1, pr * 1.3)), rowH + 1); g.clip();
    const hi = i === hiRow || num(rows[i].highlight) === 1;
    fillPlate(g, rc, x, ry, w, rowH, P.paint(p, "rowFill", "@dark/60"), { slant: 0, radius: 0 });
    if (P.bool(p, "zebra", true) && i % 2 === 1) fillPlate(g, rc, x, ry, w, rowH, P.paint(p, "zebraFill", "@light/8"), { slant: 0, radius: 0 });
    const hiIn = hi ? easeBy("quint", progress(rc.t, t0 + rd * 0.6, 0.35)) : 0;
    if (hiIn > 0) { g.globalAlpha *= hiIn; fillPlate(g, rc, x, ry, w, rowH, P.paint(p, "hiFill", "@accent"), { slant: 0, radius: 0 }); g.globalAlpha /= hiIn; }
    if (P.bool(p, "lines", true) && i > 0) { g.fillStyle = rc.paint(P.paint(p, "lineColor", "@text/12")); g.fillRect(x, ry, w, Math.max(1, size * 0.04)); }
    applyMove(g, "slide", e, [x, ry, w, rowH], "left", size * 0.8);
    for (let j = 0; j < cols.length; j++) {
      const c = cells[i][j];
      g.font = rc.font(c.numeric ? nFont : font, size, j === 0 && firstBold ? 700 : weight, c.text);
      const base = c.signed && Number.isFinite(c.num) && c.num !== 0 ? (c.num > 0 ? "@up" : "@down") : P.paint(p, "color", "@text");
      g.fillStyle = rc.paint(hiIn > 0.5 ? P.paint(p, "hiColor", "@dark") : base);
      textAt(c.text, j, ry + rowH / 2, c.numeric, c.signed, c.num);
    }
    g.restore();
  }
  g.restore();
}

registerLayerKind({
  kind: "table", label: "Table", group: "Data", props: PROPS, ownsAnim: true,
  animates: () => true,
  draw(g, layer, rc) {
    resetDigitCells();
    g.save();
    const ao = layer.anim?.out;
    if (rc.phase.out >= 1 || applyMove(g, ao?.kind && ao.kind !== "stagger" ? ao.kind : "fade", easeIn(rc, rc.phase.out), layer.box, ao?.dir ?? "left")) {
      if (rc.phase.in < 1 && layer.anim?.in && !["stagger", "none", "wipe", "grow"].includes(layer.anim.in.kind)) {
        applyMove(g, layer.anim.in.kind, easeIn(rc, rc.phase.in), layer.box, layer.anim.in.dir ?? "left");
      }
      draw(g, layer, rc);
    }
    g.restore();
  },
  fonts: (layer, rc) => fontsOf(rc.look, [[layer.p.font ?? "@body", P.num(layer.p, "weight", 600)], [layer.p.font ?? "@body", 700], [layer.p.numberFont ?? "@numbers", 600], [layer.p.numberFont ?? "@numbers", 700], [layer.p.headerFont ?? "@headline", 700]],
    rowsOf(layer, rc).flatMap((r) => Object.values(r).map(String))),
});
