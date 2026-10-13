/**
 * Layer kind "ticker" (docs/EDITOR.md §16.3, §16.4). Owner: nr-tickers. Draws a list field's items as:
 * - crawl: a strip moving right to left (or left to right), seamless for any clip length, optionally full on the
 *   first frame; each item is drawn once into a bitmap and moved (tickers/pieces.ts);
 * - flip: one page (1–6 items side by side) at a time, changing by slide, flip, fade or wipe;
 * - stack: two (1–4) rows rolling up an item at a time (vertical two-line tickers, speed news);
 * - tally: party (or team) results side by side, flipping when there are more than fit;
 * - seats: a seat bar with each party's won and leading seats and the majority line.
 * Items can carry a tag (a chip, or a box at the start that changes with the items), a priority flash, an icon and
 * a value with its ▲ / ▼ change (markets, rates, weather). The kind owns its entrance (a wipe on, plates first and the
 * items just after) and leaves cleanly. Everything is a pure function of time.
 */
import { isCore } from "../context.ts";
import { cssFont, textOn } from "../paint.ts";
import { registerLayerKind } from "../registry.ts";
import type { Ctx2D, LayerRenderContext } from "../contract.ts";
import { measurer } from "../text.ts";
import type { AnimStep, Box, GfxLayer, GfxListItem } from "../../types.ts";
import { capsFor, centreBaseline, fieldPaint, fillPlate, makeCanvas, platePath, setTracking, SLANT, solid, type AnyCanvas } from "../../tickers/canvas.ts";
import { clamp01, crawlItemAt, crawlStart, crawlVisible, flashLevel, flipState, mirrorX, pagesOf } from "../../tickers/math.ts";
import { drawPiece, itemsOf, pieceFor, type Piece } from "../../tickers/pieces.ts";
import { numProp, TICKER_PROPS, tickerProps, type TickerProps } from "../../tickers/props.ts";
import { tickerSpeed } from "../../tickers/period.ts";
import { drawIcon, iconDef } from "../icons.ts";
import { scriptOf } from "../../format.ts";

type RC = LayerRenderContext;

// ── entrance and exit ────────────────────────────────────────────────────────

/** Applies an in or out step at eased amount e (1 = fully shown) as a clip, offset or opacity. */
function applyStep(g: Ctx2D, box: Box, step: AnimStep | undefined, fallback: string, e: number, leaving: boolean): void {
  const kind = step?.kind ?? fallback;
  if (kind === "none" || e >= 1) return;
  const [x, y, w, h] = box;
  const q = clamp01(e);
  const dir = step?.dir ?? (leaving ? "right" : "right");
  switch (kind) {
    case "wipe": case "grow": case "unfold": case "sweep": {
      g.beginPath();
      // in: the edge travels in `dir` revealing; out: the edge travels in `dir` hiding
      if (dir === "left") g.rect(leaving ? x : x + w * (1 - q), y - h, w * q, h * 3);
      else if (dir === "up") g.rect(x - w, leaving ? y : y + h * (1 - q), w * 3, h * q);
      else if (dir === "down") g.rect(x - w, leaving ? y + h * (1 - q) : y, w * 3, h * q);
      else g.rect(leaving ? x + w * (1 - q) : x, y - h, w * q, h * 3);
      g.clip();
      break;
    }
    case "slide": case "rise": case "drop": {
      const d = step?.distance ?? h * 1.1;
      const sy = kind === "drop" ? -1 : 1;
      if (dir === "left" || dir === "right") g.translate((dir === "left" ? 1 : -1) * (leaving ? -1 : 1) * d * (1 - q), 0);
      else g.translate(0, sy * d * (1 - q));
      g.globalAlpha *= clamp01(q * 3);
      break;
    }
    default: g.globalAlpha *= q;
  }
}

// ── the tag / label box ──────────────────────────────────────────────────────

interface BoxFace { text: string; fill: string; color: string }
/** The start box: its plate (from the layer's left edge, bleed included) and where its text sits. */
interface StartBox { plate: Box; tx: number; tw: number }

function boxFont(rc: RC, P: TickerProps, h: number, sample: string): string {
  const s = P.tagSize > 0 ? P.tagSize : Math.min(P.size * 0.74, h * 0.46);
  return rc.font(P.tagFont, s, 800, sample);
}
const sizeOfFont = (font: string) => parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? "28");
const iconSize = (P: TickerProps, h: number) => Math.min(h * 0.62, P.size * 0.95);

/** Width of the start box's text area: fixed, or the widest of its texts (with the label icon). */
function boxWidth(g: Ctx2D, rc: RC, P: TickerProps, h: number, texts: string[]): number {
  if (P.tagWidth > 0) return P.tagWidth;
  let w = 0;
  for (const t of texts) {
    if (!t) continue;
    const font = boxFont(rc, P, h, t);
    w = Math.max(w, measurer(g, font, sizeOfFont(font) * 0.05)(t));
  }
  if (!w) return 0;
  const slant = rc.look.plate === "angled" ? h * SLANT : 0;
  const icon = P.labelIcon && iconDef(P.labelIcon) ? iconSize(P, h) + P.size * 0.3 : 0;
  return Math.max(h * 1.9, w + icon + P.size * 1.1 + slant);
}

function drawBoxFace(g: Ctx2D, rc: RC, P: TickerProps, f: BoxFace, sb: StartBox, cy: number): void {
  const h = sb.plate[3];
  const font = boxFont(rc, P, h, f.text);
  const s = sizeOfFont(font);
  const slant = rc.look.plate === "angled" ? h * SLANT : 0;
  const room = sb.tw - slant * 0.5;
  g.font = font; g.fillStyle = f.color; g.textBaseline = "alphabetic";
  setTracking(g, 0.05, s);
  const icon = P.labelIcon && iconDef(P.labelIcon) ? iconSize(P, h) : 0;
  if (icon) {
    const tw = Math.min(measurer(g, font, s * 0.05)(f.text), room - icon - P.size * 0.9);
    const x0 = sb.tx + (room - (icon + P.size * 0.3 + tw)) / 2;
    drawIcon(g, P.labelIcon, x0, cy - icon / 2, icon, icon, f.color, f.color);
    g.font = font; g.fillStyle = f.color; g.textAlign = "left";
    g.fillText(f.text, x0 + icon + P.size * 0.3, centreBaseline(g, f.text, cy), Math.max(10, tw));
  } else {
    g.textAlign = "center";
    g.fillText(f.text, sb.tx + room / 2, centreBaseline(g, f.text, cy), Math.max(10, room - P.size * 0.6));
  }
  setTracking(g, 0, s);
}

/** The start box with its face, sliding from `prev` to `cur` while k goes 0 → 1. */
function drawStartBox(g: Ctx2D, rc: RC, P: TickerProps, sb: StartBox, cur: BoxFace, prev: BoxFace | null, k: number): void {
  const [x, y, w, h] = sb.plate;
  const look = rc.look;
  const e = rc.ease(clamp01(k));
  g.save();
  const change = !!prev && k < 1;
  fillPlate(g, x, y, w, h, change && prev!.fill !== cur.fill ? prev!.fill : cur.fill, look);
  if (change && prev!.fill !== cur.fill) {
    g.save(); platePath(g, x, y, w, h, look); g.clip();
    g.beginPath(); g.rect(x, y + h * (1 - e), w, h * e); g.clip();
    fillPlate(g, x, y, w, h, cur.fill, look);
    g.restore();
  }
  // a thin edge along the right end (it follows an angled plate's slant)
  const edge = fieldPaint(P.tagEdge, rc);
  if (edge) {
    const ew = Math.max(3, h * 0.07), s = look.plate === "angled" ? Math.min(w / 3, h * SLANT) : 0;
    g.save(); platePath(g, x, y, w, h, look); g.clip();
    g.beginPath(); g.moveTo(x + w - ew, y); g.lineTo(x + w, y); g.lineTo(x + w - s, y + h); g.lineTo(x + w - s - ew, y + h); g.closePath();
    g.fillStyle = rc.paint(edge); g.fill();
    g.restore();
  }
  platePath(g, x, y, w, h, look);
  g.clip();
  const cy = y + h / 2;
  if (change && prev!.text !== cur.text) {
    g.save(); g.translate(0, -h * e); g.globalAlpha *= 1 - e; drawBoxFace(g, rc, P, prev!, sb, cy); g.restore();
    g.save(); g.translate(0, h * (1 - e)); g.globalAlpha *= e; drawBoxFace(g, rc, P, cur, sb, cy); g.restore();
  } else drawBoxFace(g, rc, P, cur, sb, cy);
  g.restore();
}

function faceFor(rc: RC, P: TickerProps, it: GfxListItem | undefined, flashOn: boolean): BoxFace {
  const tag = it?.tag?.trim() ? it.tag.trim() : rc.text(P.label);
  const text = capsFor(tag, P.tagUpper, rc.look);
  if (flashOn) return { text, fill: solid(rc, P.flashFill, "#E10600"), color: solid(rc, P.flashColor, "#FFFFFF") };
  const fill = it?.color || solid(rc, P.tagFill, "#FFC20E");
  const color = it?.color || P.tagColor === "auto" ? textOn(fill) : solid(rc, P.tagColor, "#111111");
  return { text, fill, color };
}

// ── soft edges ───────────────────────────────────────────────────────────────

let scratch: { c: AnyCanvas; g: Ctx2D } | null = null;
/** Draws `paint` through a scratch canvas whose left / right `fade` px fade out, then onto g. */
function withFade(g: Ctx2D, rc: RC, rect: Box, fade: number, fadeLeft: boolean, paint: (q: Ctx2D) => void): void {
  const [x, y, w, h] = rect;
  const W = Math.ceil(w * rc.scale), H = Math.ceil(h * rc.scale);
  if (!scratch || scratch.c.width < W || scratch.c.height < H) scratch = makeCanvas(Math.max(W, scratch?.c.width ?? 0), Math.max(H, scratch?.c.height ?? 0));
  if (!scratch) { paint(g); return; }
  const q = scratch.g;
  q.setTransform(1, 0, 0, 1, 0, 0);
  q.globalCompositeOperation = "source-over";
  q.globalAlpha = 1;
  q.clearRect(0, 0, W, H);
  q.setTransform(rc.scale, 0, 0, rc.scale, -x * rc.scale, -y * rc.scale);
  q.save(); paint(q); q.restore();
  q.setTransform(1, 0, 0, 1, 0, 0);
  q.globalCompositeOperation = "destination-in";
  const f = Math.min(W / 2, fade * rc.scale);
  const gr = q.createLinearGradient(0, 0, W, 0);
  gr.addColorStop(0, fadeLeft ? "rgba(0,0,0,0)" : "#000");
  gr.addColorStop(f / W, "#000"); gr.addColorStop(1 - f / W, "#000"); gr.addColorStop(1, "rgba(0,0,0,0)");
  q.fillStyle = gr; q.fillRect(0, 0, W, H);
  q.globalCompositeOperation = "source-over";
  g.drawImage(scratch.c, 0, 0, W, H, x, y, W / rc.scale, H / rc.scale);
}

// ── modes ────────────────────────────────────────────────────────────────────

function drawFlash(g: Ctx2D, rc: RC, P: TickerProps, x: number, y: number, w: number, h: number): void {
  const lvl = flashLevel(rc.t, P.flashPeriod, rc.fps);
  const fill = solid(rc, P.flashFill, "#E10600");
  const ph = Math.min(h * 0.84, P.size * 1.5);
  g.save();
  g.globalAlpha *= 0.5 + 0.5 * lvl;
  platePath(g, x, y + (h - ph) / 2, w, ph, { plate: rc.look.plate === "angled" ? "flat" : rc.look.plate, radius: Math.min(rc.look.radius, ph / 3) }, {});
  g.fillStyle = fill; g.fill();
  g.restore();
}

function drawCrawl(g: Ctx2D, rc: RC, P: TickerProps, items: GfxListItem[], win: Box, fadeLeft: boolean): void {
  const [wx, wy, ww, wh] = win;
  const ps: Piece[] = items.map((it, i) => pieceFor(g, rc, P, it, { h: wh, maxW: Infinity, sep: true, num: i + 1, count: items.length }));
  const widths = ps.map((p) => p.L.w);
  const cycle = widths.reduce((x, y) => x + y, 0);
  const speed = tickerSpeed(P, rc.designW, rc.designH, rc.fps, cycle, rc.dur);
  const start = crawlStart(rc.t, speed, cycle, ww, P.startFull);
  const right = P.direction === "right";
  const y = Math.round(wy * rc.scale) / rc.scale;
  const paint = (q: Ctx2D) => {
    q.beginPath(); q.rect(wx, wy, ww, wh); q.clip();
    for (const v of crawlVisible(start, widths, ww)) {
      const p = ps[v.i];
      const x = wx + (right ? mirrorX(v.x, p.L.w, ww) : v.x);
      if (p.L.flash) drawFlash(q, rc, P, x, wy, p.L.contentW, wh);
      drawPiece(q, rc, P, p, x, y);
    }
  };
  if (P.fade > 0) withFade(g, rc, win, P.fade, fadeLeft, paint);
  else { g.save(); paint(g); g.restore(); }
}

/** Draws one flip page (its cells side by side) inside the window. */
function drawPage(g: Ctx2D, rc: RC, P: TickerProps, items: GfxListItem[], page: number[], win: Box, count: number): void {
  const [wx, wy, ww, wh] = win;
  const per = Math.max(1, P.perPage);
  const pad = P.padX > 0 ? P.padX : P.size * 0.5;
  const cw = ww / per;
  const make = (Q: TickerProps) => page.map((idx) => pieceFor(g, rc, Q, items[idx], { h: wh, maxW: cw - pad * 2, sep: false, num: idx + 1, count }));
  let Q = P;
  let ps = make(P);
  // items side by side share one size: the smallest any of them needed
  if (page.length > 1) {
    const min = Math.min(...ps.map((p) => p.L.parts.reduce((m, x) => (x.k === "text" ? Math.min(m, x.size) : m), P.size)));
    if (min < P.size - 0.01) { Q = { ...P, size: Math.floor(min * 4) / 4 }; ps = make(Q); }
  }
  page.forEach((_, j) => {
    const p = ps[j];
    const cx = wx + j * cw;
    const x = P.align === "center" || per > 1 ? cx + Math.max(pad, (cw - p.L.contentW) / 2) : cx + pad;
    if (p.L.flash) drawFlash(g, rc, Q, x, wy, p.L.contentW, wh);
    drawPiece(g, rc, Q, p, x, wy);
    if (j > 0 && P.divider) {
      g.save(); g.fillStyle = solid(rc, "@text/22", "rgba(255,255,255,0.22)"); g.fillRect(cx - 1, wy + wh * 0.2, 2, wh * 0.6); g.restore();
    }
  });
}

/** Paints a change from one page to the next (k 0 → 1) inside the window. */
function transition(g: Ctx2D, rc: RC, P: TickerProps, win: Box, k: number, prev: ((q: Ctx2D) => void) | null, cur: (q: Ctx2D) => void): void {
  const [wx, wy, ww, wh] = win;
  if (!prev || k >= 1) { cur(g); return; }
  const e = clamp01(rc.ease(clamp01(k)));
  g.save();
  g.beginPath(); g.rect(wx, wy, ww, wh); g.clip();
  switch (P.transition) {
    case "fade":
      g.save(); g.globalAlpha *= 1 - e; prev(g); g.restore();
      g.save(); g.globalAlpha *= e; cur(g); g.restore();
      break;
    case "flip": {
      const cy = wy + wh / 2;
      const half = e < 0.5;
      const s = half ? 1 - e * 2 : (e - 0.5) * 2;
      g.save(); g.translate(0, cy); g.scale(1, Math.max(0.001, s)); g.translate(0, -cy);
      g.globalAlpha *= 0.4 + 0.6 * s;
      (half ? prev : cur)(g);
      g.restore();
      break;
    }
    case "wipe": {
      const edge = wx + ww * e;
      g.save(); g.beginPath(); g.rect(edge, wy, wx + ww - edge, wh); g.clip(); prev(g); g.restore();
      g.save(); g.beginPath(); g.rect(wx, wy, edge - wx, wh); g.clip(); cur(g); g.restore();
      g.fillStyle = solid(rc, P.tagFill, "#FFC20E");
      g.fillRect(edge - Math.max(3, P.size * 0.1), wy, Math.max(3, P.size * 0.1), wh);
      break;
    }
    default: {  // slide up
      g.save(); g.translate(0, -wh * e); g.globalAlpha *= 1 - e * 0.6; prev(g); g.restore();
      g.save(); g.translate(0, wh * (1 - e)); cur(g); g.restore();
    }
  }
  g.restore();
}

function drawFlip(g: Ctx2D, rc: RC, P: TickerProps, items: GfxListItem[], win: Box, fadeLeft: boolean): void {
  const pages = pagesOf(items, P.perPage, P.byTag);
  const st = flipState(rc.shown, pages.length, P.hold, P.transDur);
  if (st.index < 0) return;
  const paint = (i: number) => (q: Ctx2D) => drawPage(q, rc, P, items, pages[i], win, items.length);
  const go = (q: Ctx2D) => transition(q, rc, P, win, st.k, st.k < 1 ? paint(st.prev) : null, paint(st.index));
  if (P.fade > 0) withFade(g, rc, win, P.fade, fadeLeft, go);
  else go(g);
}

function drawStack(g: Ctx2D, rc: RC, P: TickerProps, items: GfxListItem[], win: Box): void {
  const [wx, wy, ww, wh] = win;
  const R = Math.max(1, P.rows), n = items.length;
  const rh = wh / R;
  const pad = P.padX > 0 ? P.padX : P.size * 0.5;
  const row = (q: Ctx2D, idx: number, y: number) => {
    const p = pieceFor(q, rc, P, items[idx], { h: rh, maxW: ww - pad * 2, sep: false, num: idx + 1, count: n });
    const x = P.align === "center" ? wx + Math.max(pad, (ww - p.L.contentW) / 2) : wx + pad;
    if (p.L.flash) drawFlash(q, rc, P, x, y, p.L.contentW, rh);
    drawPiece(q, rc, P, p, x, y);
  };
  const lines = (q: Ctx2D) => {
    if (!P.divider || R < 2) return;
    q.save(); q.fillStyle = solid(rc, "@text/18", "rgba(255,255,255,0.18)");
    for (let r = 1; r < R; r++) q.fillRect(wx + pad, wy + rh * r - 1, ww - pad * 2, 2);
    q.restore();
  };
  const paint = (q: Ctx2D) => {
    q.save(); q.beginPath(); q.rect(wx, wy, ww, wh); q.clip();
    if (n <= R) items.forEach((_, i) => row(q, i, wy + i * rh));
    else {
      const st = flipState(rc.shown, n, P.hold, P.transDur);
      const e = st.k < 1 ? clamp01(rc.ease(st.k)) : 1;
      const off = (1 - e) * rh;
      for (let j = st.k < 1 ? -1 : 0; j < R; j++) {
        const idx = (((st.step + j) % n) + n) % n;
        const y = wy + j * rh + off;
        q.save();
        if (j === -1) q.globalAlpha *= 1 - e;
        if (j === R - 1 && st.k < 1) q.globalAlpha *= e;
        row(q, idx, y);
        q.restore();
      }
    }
    q.restore();
    lines(q);
  };
  if (P.fade > 0) withFade(g, rc, win, P.fade, true, paint);
  else paint(g);
}

/** One party's (or team's) result: a chip in its colour, the total, and won / leading below each other. */
function drawTallyCell(g: Ctx2D, rc: RC, P: TickerProps, it: GfxListItem, x: number, y: number, w: number, h: number): void {
  const S = P.size, look = rc.look;
  const col = it.color || solid(rc, P.tagFill, "#FFC20E");
  const name = capsFor(rc.text(it.text), "on", look);
  const won = Number.isFinite(it.value) ? (it.value as number) : 0;
  const lead = Number.isFinite(it.delta) ? (it.delta as number) : 0;
  const cy = y + h / 2;
  g.save();
  // chip
  const nf = rc.font(P.tagFont, S * 0.7, 800, name);
  const nw = measurer(g, nf, S * 0.03)(name);
  const ch = Math.min(h * 0.74, S * 1.35), cw = Math.min(w * 0.46, nw + S * 0.9);
  platePath(g, x, cy - ch / 2, cw, ch, look, look.plate === "angled" ? { right: true } : {});
  g.fillStyle = col; g.fill();
  g.font = nf; g.fillStyle = textOn(col); g.textAlign = "center"; g.textBaseline = "alphabetic";
  setTracking(g, 0.03, S * 0.7);
  g.fillText(name, x + cw / 2 - (look.plate === "angled" ? ch * SLANT * 0.25 : 0), centreBaseline(g, name, cy), cw - S * 0.4);
  setTracking(g, 0, S);
  // total
  const tot = rc.number(won + lead, { decimals: 0 });
  const tf = rc.font(P.valueFont, S * 1.12, 700, tot);
  g.font = tf; g.textAlign = "left"; g.fillStyle = solid(rc, P.valueColor, "#FFFFFF");
  const tx = x + cw + S * 0.36;
  g.fillText(tot, tx, centreBaseline(g, "8", cy));
  const totW = measurer(g, tf)(tot);
  // won / leading
  const sf = rc.font("@body", S * 0.4, 600, "W");
  g.font = sf; g.fillStyle = solid(rc, "@text/80", "rgba(255,255,255,0.8)");
  const lx = tx + totW + S * 0.3;
  if (lx < x + w - S * 0.5) {
    g.fillText(`${rc.text(P.wonLabel)} ${rc.number(won, { decimals: 0 })}`, lx, centreBaseline(g, "H", cy - S * 0.26), x + w - lx - S * 0.2);
    g.fillText(`${rc.text(P.leadLabel)} ${rc.number(lead, { decimals: 0 })}`, lx, centreBaseline(g, "H", cy + S * 0.26), x + w - lx - S * 0.2);
  }
  g.restore();
}

function drawTally(g: Ctx2D, rc: RC, P: TickerProps, items: GfxListItem[], win: Box): void {
  const pages = pagesOf(items, P.perPage, false);
  const st = flipState(rc.shown, pages.length, P.hold, P.transDur);
  if (st.index < 0) return;
  const [wx, wy, ww, wh] = win;
  const per = Math.max(1, P.perPage);
  const cw = ww / per;
  const pad = P.padX > 0 ? P.padX : P.size * 0.3;
  const page = (i: number) => (q: Ctx2D) => pages[i].forEach((idx, j) => {
    drawTallyCell(q, rc, P, items[idx], wx + j * cw + pad, wy, cw - pad * 2, wh);
    if (j > 0 && P.divider) { q.save(); q.fillStyle = solid(rc, "@text/22", "rgba(255,255,255,0.22)"); q.fillRect(wx + j * cw - 1, wy + wh * 0.2, 2, wh * 0.6); q.restore(); }
  });
  transition(g, rc, P, win, st.k, st.k < 1 ? page(st.prev) : null, page(st.index));
}

/** The seat bar: won (solid) and leading (lighter) seats per party, the rest empty, and the majority line. */
function drawSeats(g: Ctx2D, rc: RC, P: TickerProps, items: GfxListItem[], win: Box): void {
  const [wx, wy, ww, wh] = win;
  const S = P.size, look = rc.look;
  const grow = clamp01(rc.ease(clamp01(rc.phase.in)));
  const labelH = Math.min(wh * 0.42, S * 0.9);
  const by = wy + labelH, bh = wh - labelH;
  const total = Math.max(1, numProp(P.total, rc.value, 543));
  const majority = numProp(P.majority, rc.value, 0);
  g.save();
  // the track, then each party's won (solid) and leading (lighter) seats, growing in
  g.save(); platePath(g, wx, by, ww, bh, { plate: look.plate === "angled" ? "flat" : look.plate, radius: Math.min(look.radius, bh / 2) }, {}); g.clip();
  g.fillStyle = solid(rc, "@text/16", "rgba(255,255,255,0.16)"); g.fillRect(wx, by, ww, bh);
  let x = wx;
  const room = ww * grow;
  for (const it of items) {
    const won = Math.max(0, Number(it.value) || 0), lead = Math.max(0, Number(it.delta) || 0);
    const col = it.color || solid(rc, P.tagFill, "#FFC20E");
    const w1 = (won / total) * ww, w2 = (lead / total) * ww;
    g.fillStyle = col; g.fillRect(x, by, Math.max(0, Math.min(w1, wx + room - x)), bh);
    g.globalAlpha = 0.5; g.fillRect(x + w1, by, Math.max(0, Math.min(w2, wx + room - x - w1)), bh); g.globalAlpha = 1;
    const segW = w1 + w2;
    const t = `${capsFor(rc.text(it.text), P.tagUpper, look)} ${rc.number(won + lead, { decimals: 0 })}`;
    const f = rc.font(P.tagFont, Math.min(bh * 0.5, S * 0.56), 800, t);
    if (grow >= 1 && measurer(g, f)(t) + S * 0.5 < segW) {
      g.font = f; g.fillStyle = textOn(col); g.textAlign = "left"; g.textBaseline = "alphabetic";
      g.fillText(t, x + S * 0.25, centreBaseline(g, t, by + bh / 2));
    }
    // a hairline between parties
    if (x > wx) { g.fillStyle = "rgba(0,0,0,0.35)"; g.fillRect(x - 1, by, 2, bh); }
    x += segW;
  }
  g.restore();
  // the majority line and its label
  if (majority > 0 && majority < total) {
    const mx = wx + (majority / total) * ww;
    g.fillStyle = solid(rc, "@text", "#FFFFFF");
    g.fillRect(mx - 1.5, wy + labelH * 0.62, 3, wh - labelH * 0.62 + Math.min(6, S * 0.12));
    const lt = `${rc.text(P.majLabel)} ${rc.number(majority, { decimals: 0 })}`;
    const lf = rc.font("@body", Math.min(labelH * 0.6, S * 0.5), 700, lt);
    g.font = lf; g.textBaseline = "alphabetic";
    const lw = measurer(g, lf)(lt);
    const al: CanvasTextAlign = mx + lw / 2 > wx + ww ? "right" : mx - lw / 2 < wx ? "left" : "center";
    g.textAlign = al;
    g.fillText(lt, al === "right" ? wx + ww : al === "left" ? wx : mx, centreBaseline(g, "H", wy + labelH * 0.3));
  }
  g.restore();
}

// ── the kind ─────────────────────────────────────────────────────────────────

function drawTicker(g: Ctx2D, layer: GfxLayer, rc: RC): void {
  const P = tickerProps(layer.p);
  const box: Box = isCore(rc) ? rc.box : layer.box;
  const [bx, by, bw, bh] = box;
  const items = itemsOf(rc.value(P.source));
  const label = rc.text(P.label);
  const hasBox = (P.tags === "box" && (P.mode === "crawl" || P.mode === "flip")) || !!label.trim();
  // a label tab above the band (labelTop), else the band is the whole box
  const lt = hasBox && P.labelTop > 0 ? Math.min(P.labelTop, bh * 0.6) : 0;
  const band: Box = [bx, by + lt, bw, bh - lt];
  // the band may bleed past the safe area; the items and labels stay inside it
  const inner: Box = [bx + P.bleedL, band[1], Math.max(1, bw - P.bleedL - P.bleedR), band[3]];
  const a = layer.anim;
  const eIn = rc.ease(clamp01(rc.phase.in), a?.in?.ease);
  const eOut = rc.ease(clamp01(rc.phase.out), a?.out?.ease);
  // the items follow the plates a little
  const eItems = clamp01((clamp01(rc.phase.in) - 0.12) / 0.6);
  g.save();
  applyStep(g, box, a?.in, "wipe", eIn, false);
  applyStep(g, box, a?.out, "fade", eOut, true);
  // band and stripe
  const fill = fieldPaint(P.fill, rc);
  if (fill) fillPlate(g, band[0], band[1], band[2], band[3], rc.paint(fill), rc.look, rc.look.plate === "angled" ? { right: true } : {});
  const stripe = fieldPaint(P.stripe, rc);
  if (stripe && P.stripeH > 0) { g.fillStyle = rc.paint(stripe); g.fillRect(band[0], band[1], band[2], P.stripeH); }
  // the start box (a fixed label, or the items' tags)
  let sb: StartBox | null = null;
  let win: Box = inner;
  if (hasBox) {
    const texts = [label, ...(P.tags === "box" ? items.map((i) => i.tag ?? "") : [])].map((t) => capsFor(t.trim(), P.tagUpper, rc.look));
    g.save();
    const w = boxWidth(g, rc, P, lt || bh, texts);
    g.restore();
    if (w > 0 && lt) sb = { plate: [bx, by, P.bleedL + w, lt], tx: inner[0], tw: w };
    else if (w > 0) {
      sb = { plate: [bx, by, P.bleedL + w, bh], tx: inner[0], tw: w };
      const over = rc.look.plate === "angled" ? bh * SLANT * 0.5 : 0;
      win = [inner[0] + w - over, by, Math.max(1, inner[2] - w + over), bh];
    }
  }
  const pad = P.mode === "crawl" ? (P.padX > 0 ? P.padX : sb && !lt ? P.size * 0.35 : 0) : 0;
  if (pad) win = [win[0] + pad, win[1], Math.max(1, win[2] - pad * 2), win[3]];
  const flashOn = P.labelFlash && flashLevel(rc.t, P.flashPeriod, rc.fps) >= 0.5;
  if (items.length) {
    g.save();
    if (eItems < 1) g.globalAlpha *= eItems;
    if (P.mode === "crawl") drawCrawl(g, rc, P, items, win, !sb || !!lt);
    else if (P.mode === "flip") drawFlip(g, rc, P, items, win, !sb || !!lt);
    else if (P.mode === "stack") drawStack(g, rc, P, items, win);
    else if (P.mode === "tally") drawTally(g, rc, P, items, win);
    else drawSeats(g, rc, P, items, win);
    g.restore();
  }
  // the start box draws over the items' left edge (they pass under it)
  if (sb) {
    if (items.length && P.tags === "box" && P.mode === "crawl") drawCrawlBox(g, rc, P, items, win, sb, flashOn);
    else if (items.length && P.tags === "box" && P.mode === "flip") drawFlipBox(g, rc, P, items, sb, flashOn);
    else drawStartBox(g, rc, P, sb, faceFor(rc, P, undefined, flashOn), null, 1);
  }
  g.restore();
}

/** The crawl's start box: the tag of the item reaching the start of the window, sliding as it changes. */
function drawCrawlBox(g: Ctx2D, rc: RC, P: TickerProps, items: GfxListItem[], win: Box, sb: StartBox, flashOn: boolean): void {
  const ps = items.map((it, i) => pieceFor(g, rc, P, it, { h: win[3], maxW: Infinity, sep: true, num: i + 1, count: items.length }));
  const widths = ps.map((p) => p.L.w);
  const cycle = widths.reduce((x, y) => x + y, 0);
  const speed = tickerSpeed(P, rc.designW, rc.designH, rc.fps, cycle, rc.dur);
  const start = crawlStart(rc.t, speed, cycle, win[2], P.startFull);
  const right = P.direction === "right";
  const at = crawlItemAt(right ? win[2] - 1 : Math.min(win[2] * 0.02, 12), start, widths);
  const cur = faceFor(rc, P, at.i >= 0 ? items[at.i] : undefined, flashOn);
  let prev: BoxFace | null = null, k = 1;
  if (at.i >= 0 && !right && P.transDur > 0 && !(start > 0 && at.i === 0)) {
    // it arrived `since` s ago; nothing changes for an item already there when the clip began
    const since = at.into / Math.max(1, speed);
    if (since < P.transDur && since < rc.t) { prev = faceFor(rc, P, items[(at.i - 1 + items.length) % items.length], flashOn); k = since / P.transDur; }
  }
  drawStartBox(g, rc, P, sb, cur, prev, k);
}

function drawFlipBox(g: Ctx2D, rc: RC, P: TickerProps, items: GfxListItem[], sb: StartBox, flashOn: boolean): void {
  const pages = pagesOf(items, P.perPage, P.byTag);
  const st = flipState(rc.shown, pages.length, P.hold, P.transDur);
  const cur = faceFor(rc, P, items[pages[st.index]?.[0] ?? 0], flashOn);
  const prev = st.k < 1 ? faceFor(rc, P, items[pages[st.prev]?.[0] ?? 0], flashOn) : null;
  drawStartBox(g, rc, P, sb, cur, prev, st.k);
}

registerLayerKind({
  kind: "ticker", label: "Ticker", group: "Data", props: TICKER_PROPS, ownsAnim: true,
  draw: drawTicker,
  animates(layer, rc) {
    const P = tickerProps(layer.p);
    const items = itemsOf(rc.value(P.source));
    if (!items.length) return false;
    if (P.mode === "crawl") return true;
    if (P.labelFlash || items.some((i) => i.flash)) return true;
    if (P.mode === "seats") return false;
    if (P.mode === "stack") return items.length > P.rows;
    return pagesOf(items, P.mode === "tally" ? P.perPage : P.perPage, P.mode === "flip" && P.byTag).length > 1;
  },
  fonts(layer, rc) {
    const P = tickerProps(layer.p);
    const items = itemsOf(rc.value(P.source));
    const out = new Set<string>();
    const w = P.weight > 0 ? P.weight : undefined;
    const scripts = new Map<string, string>();
    for (const it of items) { const s = scriptOf(it.text); if (!scripts.has(s)) scripts.set(s, it.text); }
    if (!scripts.size) scripts.set("latn", "A");
    for (const sample of scripts.values()) out.add(cssFont(P.font, rc.look, P.size, w, sample));
    out.add(cssFont(P.tagFont, rc.look, P.size * 0.6, 800, "A"));
    if (items.some((i) => i.value !== undefined || i.delta !== undefined) || P.mode === "tally" || P.mode === "seats") out.add(cssFont(P.valueFont, rc.look, P.size, w ?? 600, "0"));
    if (P.numbered) out.add(cssFont("@numbers", rc.look, P.size * 0.78, 700, "0"));
    return [...out];
  },
  images(layer, rc) {
    const P = tickerProps(layer.p);
    const sep = P.separator === "look" ? rc.look.separator : P.separator;
    const l = rc.look.logo;
    return sep === "logo" && l ? [l.mediaId ?? l.image ?? ""].filter(Boolean) : [];
  },
});

/** For loop exports and the graphics check (tickers/period.ts): speed, strip width and the length of one pass. */
export { crawlPeriod, crawlStripWidth, tickerSpeed } from "../../tickers/period.ts";
