/**
 * Layer kind "list" (docs/EDITOR.md §16.3, nr-boards): bullet, numbered, tick, node or icon lists from a list blank (or
 * the lines of a long text), in rows or side by side in columns (timelines, cards). Items build one by one (a quick
 * stagger, a paced build across the hold, or all at once) with the layer's in move per item; the newest item can be
 * highlighted (or the highlight can cycle); a rail can join the markers as they arrive (timelines). Long items wrap
 * and the whole list shrinks to fit its box. Items with a tag get a kicker (a date, a category). Owns its in / out.
 */
import type { GfxLayer, GfxListItem } from "../../types.ts";
import type { Ctx2D, LayerRenderContext, PropDef } from "../contract.ts";
import { layerKind, registerLayerKind } from "../registry.ts";
import { buildTimes, clamp01, easeBy, highlightWeight, layoutColumns, layoutList, lerp, listItems, outShare, pad2, progress } from "../../boards/math.ts";
import { applyMove, choices, easeIn, fillPlate, fontsOf, inStart, P, tick } from "../../boards/draw.ts";
import "../../boards/stamp.ts";   // registers the "stamp" kind (fact-check verdicts) with the board kinds

const G = { c: "Content", m: "Markers", t: "Text", pl: "Plates", b: "Build", h: "Highlight" };
const PROPS: PropDef[] = [
  { key: "field", label: "List blank", type: "field", default: "points", group: G.c, hint: "A list, or a long text (one item per line)" },
  { key: "maxItems", label: "Most items", type: "number", default: 0, min: 0, max: 20, step: 1, group: G.c, hint: "0 = all" },
  { key: "layout", label: "Layout", type: "choice", default: "rows", group: G.c, options: choices("rows|One under another", "columns|Side by side") },
  { key: "style", label: "Markers", type: "choice", default: "bullet", group: G.m,
    options: choices("bullet|Dots", "node|Timeline nodes", "square|Squares", "diamond|Diamonds", "dash|Dashes", "number|Numbers in badges", "numeral|Big numerals", "check|Ticks", "arrow|Arrows", "icon|Icons", "none|None") },
  { key: "icon", label: "Icon", type: "icon", default: "check", group: G.m, hint: "Items with their own icon use it" },
  { key: "markerColor", label: "Marker colour", type: "paint", default: "@accent", group: G.m },
  { key: "markerText", label: "Number colour", type: "paint", default: "@dark", group: G.m },
  { key: "markerFont", label: "Number font", type: "font", default: "@numbers", group: G.m },
  { key: "rail", label: "Join the markers", type: "bool", default: false, group: G.m, hint: "A line through the markers (timelines)" },
  { key: "railColor", label: "Line colour", type: "paint", default: "@accent/70", group: G.m },
  { key: "font", label: "Font", type: "font", default: "@body", group: G.t },
  { key: "size", label: "Size", type: "number", default: 46, min: 10, max: 160, unit: "px", group: G.t },
  { key: "weight", label: "Weight", type: "number", default: 600, min: 100, max: 900, step: 100, group: G.t },
  { key: "color", label: "Colour", type: "paint", default: "@text", group: G.t },
  { key: "lineH", label: "Line height", type: "number", default: 1.22, min: 0.9, max: 2, step: 0.02, group: G.t },
  { key: "maxLines", label: "Lines per item", type: "number", default: 2, min: 1, max: 8, step: 1, group: G.t },
  { key: "gap", label: "Space between", type: "number", default: 0.6, min: 0, max: 3, step: 0.05, group: G.t, hint: "In text heights" },
  { key: "spread", label: "Fill the box", type: "bool", default: true, group: G.t, hint: "Spare height goes between items" },
  { key: "valign", label: "Vertical", type: "choice", default: "top", group: G.t, options: choices("top|Top", "center|Middle") },
  { key: "tagColor", label: "Tag colour", type: "paint", default: "@accent", group: G.t },
  { key: "tagSize", label: "Tag size", type: "number", default: 0.56, min: 0.3, max: 1.5, step: 0.02, group: G.t, hint: "Of the text size" },
  { key: "plate", label: "Item plates", type: "bool", default: false, group: G.pl },
  { key: "plateFill", label: "Plate colour", type: "paint", default: "@dark/60", group: G.pl },
  { key: "plateAccent", label: "Plate edge", type: "bool", default: true, group: G.pl, hint: "A thin accent edge on the left" },
  { key: "divider", label: "Lines between", type: "bool", default: false, group: G.pl },
  { key: "dividerColor", label: "Line colour", type: "paint", default: "@text/16", group: G.pl },
  { key: "build", label: "Build", type: "choice", default: "paced", group: G.b, options: choices("stagger|Quickly, one after another", "paced|One by one while it holds", "all|All together") },
  { key: "delay", label: "Start after", type: "number", default: 0.2, min: 0, max: 20, step: 0.05, unit: "s", group: G.b },
  { key: "stagger", label: "Quick gap", type: "number", default: 0.12, min: 0, max: 2, step: 0.02, unit: "s", group: G.b },
  { key: "every", label: "Paced gap", type: "number", default: 0, min: 0, max: 10, step: 0.1, unit: "s", group: G.b, hint: "0 = spread over the first half" },
  { key: "itemDur", label: "Item comes in over", type: "number", default: 0.5, min: 0.05, max: 3, step: 0.05, unit: "s", group: G.b },
  { key: "enter", label: "Item move", type: "choice", default: "slide", group: G.b, options: choices("slide|Slide", "wipe|Wipe", "rise|Rise", "fade|Fade", "pop|Pop") },
  { key: "highlight", label: "Highlight", type: "choice", default: "none", group: G.h, options: choices("none|None", "latest|The newest item", "cycle|Each in turn") },
  { key: "hiFill", label: "Highlight colour", type: "paint", default: "@primary", group: G.h },
  { key: "hiColor", label: "Highlight text", type: "paint", default: "@textOnPrimary", group: G.h },
  { key: "dim", label: "Others dim to", type: "number", default: 0.6, min: 0.1, max: 1, step: 0.05, group: G.h },
  { key: "cycleEvery", label: "Cycle every", type: "number", default: 2.5, min: 0.5, max: 20, step: 0.1, unit: "s", group: G.h },
];

type Box = [number, number, number, number];
const INDENT: Record<string, number> = { none: 0, bullet: 1.0, node: 1.2, square: 1.0, diamond: 1.0, dash: 1.1, number: 1.55, numeral: 1.75, check: 1.15, arrow: 1.05, icon: 1.25 };
/** Where the marker's centre sits in the indent column (fraction of the size). */
const MARK_X: Record<string, number> = { number: 0.62, numeral: 0.7, node: 0.45, icon: 0.5 };

function itemsOf(layer: GfxLayer, rc: Pick<LayerRenderContext, "value">): GfxListItem[] {
  const all = listItems(rc.value(P.str(layer.p, "field", "points")));
  const max = Math.round(P.num(layer.p, "maxItems", 0));
  return max > 0 ? all.slice(0, max) : all;
}

/** When each item starts (seconds into the clip). */
export function listTimes(layer: GfxLayer, n: number, clipDur: number): number[] {
  const p = layer.p, mode = P.str(p, "build", "paced");
  const by = layer.anim?.in?.stagger;
  return buildTimes({
    n, start: inStart(layer) + P.num(p, "delay", 0.2), mode: mode === "all" || mode === "stagger" ? mode : "paced",
    stagger: by ?? P.num(p, "stagger", 0.12), every: P.num(p, "every", 0), clipDur,
  });
}

function marker(g: Ctx2D, rc: LayerRenderContext, p: Record<string, unknown>, style: string, i: number, it: GfxListItem, cx: number, cy: number, size: number, e: number): void {
  if (style === "none" || e <= 0) return;
  const k = easeBy("back", e);
  g.save();
  g.translate(cx, cy); g.scale(k, k);
  g.globalAlpha *= clamp01(e * 2);
  const paint = it.color ?? P.paint(p, "markerColor", "@accent");
  const col = rc.paint(paint);
  g.fillStyle = col; g.strokeStyle = col;
  switch (style) {
    case "square": g.fillRect(-size * 0.14, -size * 0.14, size * 0.28, size * 0.28); break;
    case "diamond": g.rotate(Math.PI / 4); g.fillRect(-size * 0.13, -size * 0.13, size * 0.26, size * 0.26); break;
    case "dash": g.fillRect(-size * 0.3, -size * 0.05, size * 0.5, size * 0.1); break;
    case "node": {
      g.beginPath(); g.arc(0, 0, size * 0.38, 0, Math.PI * 2); g.fill();
      g.fillStyle = rc.paint("@dark");
      g.beginPath(); g.arc(0, 0, size * 0.24, 0, Math.PI * 2); g.fill();
      g.fillStyle = col;
      g.beginPath(); g.arc(0, 0, size * 0.12, 0, Math.PI * 2); g.fill();
      break;
    }
    case "number": {
      const b = size * 1.08;
      fillPlate(g, rc, -b / 2, -b / 2, b, b, paint, { slant: b * 0.18 });
      g.font = rc.font(P.str(p, "markerFont", "@numbers"), size * 0.66, 700, "1");
      g.fillStyle = rc.paint(P.paint(p, "markerText", "@dark"));
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(String(i + 1), 0, size * 0.03);
      break;
    }
    case "numeral": {
      g.font = rc.font(P.str(p, "markerFont", "@numbers"), size * 1.2, 700, "01");
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(pad2(i + 1), 0, size * 0.04);
      break;
    }
    case "check": g.lineWidth = size * 0.13; tick(g, 0, 0, size * 0.78, e); break;
    case "arrow": g.beginPath(); g.moveTo(-size * 0.14, -size * 0.22); g.lineTo(size * 0.2, 0); g.lineTo(-size * 0.14, size * 0.22); g.closePath(); g.fill(); break;
    case "icon": {
      const kind = layerKind("icon");
      const s = size * 0.9;
      if (kind) kind.draw(g, { id: "_icon", name: "icon", kind: "icon", box: [-s / 2, -s / 2, s, s], p: { icon: it.icon || P.str(p, "icon", "check"), color: paint } }, rc);
      else { g.beginPath(); g.arc(0, 0, size * 0.16, 0, Math.PI * 2); g.fill(); }
      break;
    }
    default: g.beginPath(); g.arc(0, 0, size * 0.15, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

/** The item move: the layer's own in step when it names one, else the "enter" prop. */
const moveOf = (layer: GfxLayer, def: string) => {
  const ai = layer.anim?.in;
  return ai && ai.kind !== "stagger" && ai.kind !== "none" ? ai.kind : P.str(layer.p, "enter", def);
};

function drawText(g: Ctx2D, rc: LayerRenderContext, p: Record<string, unknown>, lines: string[], x: number, top: number, size: number, lineH: number, hw: number, align: "left" | "center" = "left"): void {
  g.textBaseline = "middle"; g.textAlign = align;
  lines.forEach((ln, k) => {
    const ly = top + (k + 0.5) * size * lineH;
    if (hw < 1) { g.fillStyle = rc.paint(P.paint(p, "color", "@text")); g.fillText(ln, x, ly); }
    if (hw > 0) {
      const a = g.globalAlpha;
      g.globalAlpha = a * hw;
      g.fillStyle = rc.paint(P.paint(p, "hiColor", "@textOnPrimary"));
      g.fillText(ln, x, ly);
      g.globalAlpha = a;
    }
  });
  g.textAlign = "left";
}

function drawRows(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext, items: GfxListItem[]): void {
  const p = layer.p, [x, y, w, h] = layer.box as Box;
  const n = items.length;
  const style = P.str(p, "style", "bullet");
  const font = P.str(p, "font", "@body"), weight = P.num(p, "weight", 600);
  const plate = P.bool(p, "plate", false), lineH = P.num(p, "lineH", 1.22);
  const texts = items.map((it) => rc.text(it.text));
  const tags = items.map((it) => (it.tag ? rc.text(it.tag, true) : ""));
  const tk = P.num(p, "tagSize", 0.56);
  const padX = plate ? 0.5 : 0, padY = plate ? 0.42 : 0;
  const lay = layoutList(texts, {
    w, h, size: P.num(p, "size", 46), lineH, maxLines: Math.round(P.num(p, "maxLines", 2)),
    indent: INDENT[style] ?? 1, padX, padY, gap: P.num(p, "gap", 0.6), spread: P.bool(p, "spread", true),
    valign: P.str(p, "valign", "top") === "center" ? "center" : "top", extra: tags.map((s) => (s ? tk * 1.4 : 0)),
  }, (s, size) => { g.font = rc.font(font, size, weight, s); return g.measureText(s).width; });
  const size = lay.size;
  const times = listTimes(layer, n, rc.dur);
  const dur = P.num(p, "itemDur", 0.5);
  const hiMode = P.str(p, "highlight", "none") as "none" | "latest" | "cycle";
  const dim = P.num(p, "dim", 0.6), every = P.num(p, "cycleEvery", 2.5);
  const move = moveOf(layer, "slide");
  const ao = layer.anim?.out;
  const latest = times.reduce((k, s, i) => (rc.t >= s ? i : k), -1);
  const mx = x + size * padX + size * (MARK_X[style] ?? 0.42);
  const markY = (i: number) => y + lay.rows[i].y + size * padY + (tags[i] ? size * tk * 1.4 : 0) + (size * lineH) / 2;
  // the rail runs from the first marker to the newest one as they arrive
  if (P.bool(p, "rail", false) && n > 1 && latest >= 0) {
    const reach = latest + Math.min(1, easeBy("quint", progress(rc.t, times[Math.min(n - 1, latest + 1)] - dur * 0.6, dur * 0.6)) * (latest < n - 1 ? 1 : 0));
    const k = Math.min(n - 1, Math.floor(reach)), f = reach - k;
    const y1 = k >= n - 1 ? markY(n - 1) : markY(k) + (markY(k + 1) - markY(k)) * f;
    g.save();
    g.globalAlpha *= clamp01(rc.phase.out * 1.5);
    g.fillStyle = rc.paint(P.paint(p, "railColor", "@accent/70"));
    g.fillRect(mx - Math.max(2, size * 0.05), markY(0), Math.max(4, size * 0.1), Math.max(0, y1 - markY(0)));
    g.restore();
  }
  for (let i = 0; i < n; i++) {
    const row = lay.rows[i];
    const pin = progress(rc.t, times[i], dur);
    if (pin <= 0) continue;
    const share = outShare(rc.phase.out, i, n);
    if (share <= 0) continue;
    const ry = y + row.y, rh = row.h;
    const hw = highlightWeight(rc.t, times, hiMode, every, i);
    g.save();
    if (share < 1 && !applyMove(g, ao?.kind && ao.kind !== "stagger" ? ao.kind : "slide", easeIn(rc, share), [x, ry, w, rh], ao?.dir ?? "left")) { g.restore(); continue; }
    if (hiMode !== "none" && hw < 1 && (latest > i || (hiMode === "cycle" && latest === n - 1))) g.globalAlpha *= lerp(dim, 1, hw);
    const e = easeIn(rc, pin);
    if (plate || hw > 0) {
      const pe = easeBy("quint", clamp01(pin * 1.4));
      g.save();
      g.beginPath(); g.rect(x - 2, ry - 2, (w + 4) * pe, rh + 4); g.clip();
      if (plate) fillPlate(g, rc, x, ry, w, rh, P.paint(p, "plateFill", "@dark/60"), { slant: 0 });
      if (hw > 0) { g.globalAlpha *= hw; fillPlate(g, rc, x, ry, w, rh, P.paint(p, "hiFill", "@primary"), { slant: 0 }); }
      g.restore();
      if (plate && P.bool(p, "plateAccent", true)) {
        g.fillStyle = rc.paint(items[i].color ?? P.paint(p, "markerColor", "@accent"));
        g.fillRect(x, ry + (rh * (1 - easeBy("quint", pin))) / 2, Math.max(4, size * 0.1), rh * easeBy("quint", pin));
      }
    }
    const tx = x + size * padX + size * (INDENT[style] ?? 1);
    const top = ry + size * padY;
    const kick = tags[i] ? size * tk * 1.4 : 0;
    marker(g, rc, p, style, i, items[i], mx, markY(i), size, progress(rc.t, times[i], dur * 0.7));
    g.save();
    if (applyMove(g, move, e, [tx, ry, Math.max(10, x + w - tx), rh], layer.anim?.in?.dir ?? "left", Math.min(90, size * 1.6))) {
      if (move === "slide") { g.beginPath(); g.rect(tx - 4, ry - 4, x + w - tx + 8, rh + 8); g.clip(); }
      if (kick) {
        g.font = rc.font(font, size * tk, 700, tags[i]);
        g.fillStyle = rc.paint(P.paint(p, "tagColor", "@accent"));
        g.textBaseline = "middle"; g.textAlign = "left";
        g.fillText(tags[i], tx, top + kick * 0.45);
      }
      g.font = rc.font(font, size, weight, texts[i]);
      drawText(g, rc, p, row.lines, tx, top + kick, size, lineH, hw);
    }
    g.restore();
    if (P.bool(p, "divider", false) && i < n - 1) {
      const gy = ry + rh + (lay.rows[i + 1].y - row.y - rh) / 2;
      g.fillStyle = rc.paint(P.paint(p, "dividerColor", "@text/16"));
      g.fillRect(x, gy - 1, w * easeBy("quint", pin), 2);
    }
    g.restore();
  }
}

function drawColumns(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext, items: GfxListItem[]): void {
  const p = layer.p, [x, y, w, h] = layer.box as Box;
  const n = items.length;
  const style = P.str(p, "style", "node");
  const font = P.str(p, "font", "@body"), weight = P.num(p, "weight", 600), lineH = P.num(p, "lineH", 1.22);
  const plate = P.bool(p, "plate", false);
  const colW = w / n, pad = Math.min(colW * 0.08, 24);
  const texts = items.map((it) => rc.text(it.text));
  const tags = items.map((it) => (it.tag ? rc.text(it.tag, true) : ""));
  const tk = P.num(p, "tagSize", 0.56);
  const anyTag = tags.some(Boolean);
  // marker row, then the tag, then the text
  const head = (style === "none" ? 0 : 1.5) + (anyTag ? tk * 1.9 : 0) + (plate ? 0.8 : 0.2);
  const lay = layoutColumns(texts, { colW: colW - pad * 2 - (plate ? pad : 0), h, size: P.num(p, "size", 40), lineH, maxLines: Math.round(P.num(p, "maxLines", 4)), head },
    (s, size) => { g.font = rc.font(font, size, weight, s); return g.measureText(s).width; });
  const size = lay.size;
  const times = listTimes(layer, n, rc.dur);
  const dur = P.num(p, "itemDur", 0.5);
  const hiMode = P.str(p, "highlight", "none") as "none" | "latest" | "cycle";
  const dim = P.num(p, "dim", 0.6), every = P.num(p, "cycleEvery", 2.5);
  const move = moveOf(layer, "rise");
  const latest = times.reduce((k, s, i) => (rc.t >= s ? i : k), -1);
  // cards as tall as the longest item, the whole row centred when asked
  const markH = style === "none" ? 0 : size * 1.5;
  const textTop = (plate ? size * 0.6 : size * 0.15) + (anyTag ? size * tk * 1.9 : 0);
  const cardH = Math.min(h - markH, textTop + Math.max(1, ...lay.cols.map((c) => c.length)) * size * lineH + size * 0.6);
  const oy = P.str(p, "valign", "top") === "center" ? Math.max(0, (h - markH - cardH) / 2) : 0;
  const my = y + oy + size * 0.75;
  const cx = (i: number) => x + colW * (i + 0.5);
  if (P.bool(p, "rail", false) && n > 1 && latest >= 0 && style !== "none") {
    const nextAt = times[Math.min(n - 1, latest + 1)];
    const f = latest < n - 1 ? easeBy("quint", progress(rc.t, nextAt - dur * 0.6, dur * 0.6)) : 0;
    const x1 = cx(latest) + (latest < n - 1 ? (cx(latest + 1) - cx(latest)) * f : 0);
    g.save();
    g.globalAlpha *= clamp01(rc.phase.out * 1.5);
    g.fillStyle = rc.paint(P.paint(p, "railColor", "@accent/70"));
    // a faint full track, then the travelled part
    g.globalAlpha *= 0.25; g.fillRect(x + colW * 0.5, my - Math.max(2, size * 0.05), colW * (n - 1), Math.max(4, size * 0.1));
    g.globalAlpha /= 0.25; g.fillRect(x + colW * 0.5, my - Math.max(2, size * 0.05), Math.max(0, x1 - x - colW * 0.5), Math.max(4, size * 0.1));
    g.restore();
  }
  const ao = layer.anim?.out;
  for (let i = 0; i < n; i++) {
    const pin = progress(rc.t, times[i], dur);
    if (pin <= 0) continue;
    const share = outShare(rc.phase.out, i, n);
    if (share <= 0) continue;
    const hw = highlightWeight(rc.t, times, hiMode, every, i);
    const colX = x + colW * i;
    g.save();
    if (share < 1 && !applyMove(g, ao?.kind && ao.kind !== "stagger" ? ao.kind : "fade", easeIn(rc, share), [colX, y, colW, h], ao?.dir ?? "down")) { g.restore(); continue; }
    if (hiMode !== "none" && hw < 1 && (latest > i || (hiMode === "cycle" && latest === n - 1))) g.globalAlpha *= lerp(dim, 1, hw);
    marker(g, rc, p, style, i, items[i], cx(i), my, size, progress(rc.t, times[i], dur * 0.7));
    const e = easeIn(rc, pin);
    const cardY = y + oy + markH;
    g.save();
    if (applyMove(g, move, e, [colX, cardY, colW, cardH], layer.anim?.in?.dir ?? "up", Math.min(70, size * 1.4))) {
      if (plate || hw > 0) {
        const ph = cardH;
        if (plate) fillPlate(g, rc, colX + pad / 2, cardY, colW - pad, ph, P.paint(p, "plateFill", "@dark/60"), { slant: 0 });
        if (hw > 0) { const a = g.globalAlpha; g.globalAlpha = a * hw; fillPlate(g, rc, colX + pad / 2, cardY, colW - pad, ph, P.paint(p, "hiFill", "@primary"), { slant: 0 }); g.globalAlpha = a; }
        if (plate && P.bool(p, "plateAccent", true)) { g.fillStyle = rc.paint(items[i].color ?? P.paint(p, "markerColor", "@accent")); g.fillRect(colX + pad / 2, cardY, colW - pad, Math.max(4, size * 0.1)); }
      }
      let ty = cardY + (plate ? size * 0.6 : size * 0.15);
      if (tags[i]) {
        g.font = rc.font(font, size * tk * 1.25, 800, tags[i]);
        g.fillStyle = rc.paint(P.paint(p, "tagColor", "@accent"));
        g.textBaseline = "middle"; g.textAlign = "center";
        g.fillText(tags[i], cx(i), ty + size * tk * 0.75);
        ty += size * tk * 1.9;
      }
      g.font = rc.font(font, size, weight, texts[i]);
      drawText(g, rc, p, lay.cols[i], cx(i), ty, size, lineH, hw, "center");
    }
    g.restore();
    g.restore();
  }
}

registerLayerKind({
  kind: "list", label: "List", group: "Data", props: PROPS, ownsAnim: true,
  animates: () => true,
  draw(g, layer, rc) {
    const items = itemsOf(layer, rc);
    if (!items.length) return;
    g.save();
    (P.str(layer.p, "layout", "rows") === "columns" ? drawColumns : drawRows)(g, layer, rc, items);
    g.restore();
  },
  measure(g, layer, rc) {
    const p = layer.p;
    let w = 0;
    for (const it of itemsOf(layer, rc)) {
      const s = rc.text(it.text);
      g.font = rc.font(P.str(p, "font", "@body"), P.num(p, "size", 46), P.num(p, "weight", 600), s);
      w = Math.max(w, g.measureText(s).width);
    }
    return w + P.num(p, "size", 46) * (INDENT[P.str(p, "style", "bullet")] ?? 1);
  },
  fonts: (layer, rc) => fontsOf(rc.look, [[layer.p.font ?? "@body", P.num(layer.p, "weight", 600)], [layer.p.font ?? "@body", 700], [layer.p.font ?? "@body", 800], [layer.p.markerFont ?? "@numbers", 700]],
    listItems(rc.value(P.str(layer.p, "field", "points"))).map((i) => i.text)),
});
