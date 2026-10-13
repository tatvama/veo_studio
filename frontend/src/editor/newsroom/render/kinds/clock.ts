/**
 * Layer kind "clock" (docs/EDITOR.md §16.3). Owner: nr-tickers. Shows the time, the date, both, the day, a
 * temperature, or a match clock, from the clip's clock (`rc.clock`: the edit's air time plus the time into the
 * sequence, so exports repeat). Follows the look's 12 / 24 h, zone, date style and digits; digits sit in equal cells
 * (no jitter as they change); optional seconds and a blinking colon. The match clock counts up (football) or down
 * (kabaddi) from the time typed in, or shows the overs (cricket), by the template's sport field.
 */
import { DAYS, digitScript, fmtDate, nativeDigits, zonedParts } from "../../format.ts";
import { isCore } from "../context.ts";
import { drawIcon, iconDef } from "../icons.ts";
import { cssFont } from "../paint.ts";
import { registerLayerKind } from "../registry.ts";
import { measurer } from "../text.ts";
import type { Ctx2D, LayerRenderContext } from "../contract.ts";
import type { ChannelLook, GfxLayer } from "../../types.ts";
import { capsFor, centreBaseline, solid } from "../../tickers/canvas.ts";
import { colonOn, fmtMatch, matchTime, parseClock } from "../../tickers/math.ts";
import { CLOCK_PROPS, clockProps, type ClockProps } from "../../tickers/props.ts";

type RC = LayerRenderContext;

/** A run of clock text: digits sit in equal cells; `colon` blinks; `small` is AM / PM, a suffix or a unit. */
export interface ClockRun { text: string; kind: "digits" | "colon" | "text" | "small" }

const pad2 = (n: number) => String(n).padStart(2, "0");
const native = (look: Pick<ChannelLook, "numbers" | "fonts">, s: string) => { const d = digitScript(look); return d === "latn" ? s : nativeDigits(s, d); };

/** The time at `ms` as runs, in the look's zone and 12 / 24 h. */
export function timeRuns(ms: number, look: Pick<ChannelLook, "clock" | "numbers" | "fonts">, seconds: boolean): ClockRun[] {
  const z = zonedParts(ms, look.clock.zone);
  const h = look.clock.hours === 12 ? z.hour % 12 || 12 : z.hour;
  const runs: ClockRun[] = [
    { text: native(look, look.clock.hours === 12 ? String(h) : pad2(h)), kind: "digits" },
    { text: ":", kind: "colon" },
    { text: native(look, pad2(z.minute)), kind: "digits" },
  ];
  if (seconds) runs.push({ text: ":", kind: "colon" }, { text: native(look, pad2(z.second)), kind: "digits" });
  if (look.clock.hours === 12) runs.push({ text: z.hour < 12 ? "AM" : "PM", kind: "small" });
  return runs;
}

/** Runs for a plain text: digits in cells, the rest as is. */
export function textRuns(s: string): ClockRun[] {
  const out: ClockRun[] = [];
  for (const m of s.matchAll(/(\p{Nd}+)|(:)|([^\p{Nd}:]+)/gu)) out.push({ text: m[0], kind: m[1] ? "digits" : m[2] ? "colon" : "text" });
  return out;
}

/** What a match clock shows `t` seconds into the clip. */
export function matchText(sport: string, time: unknown, overs: unknown, t: number): string {
  const s = sport.toLowerCase();
  if (s === "cricket") { const o = String(overs ?? "").trim(); return o ? `${o} OV` : ""; }
  const start = parseClock(time);
  if (start === null) return String(time ?? "");
  return fmtMatch(matchTime(start, t, s === "kabaddi"));
}

interface Measured { runs: ClockRun[]; font: string; small: string; cell: number; w: number; size: number }

function measureRuns(g: Ctx2D, runs: ClockRun[], font: string, small: string, size: number): Measured {
  const m = measurer(g, font), ms = measurer(g, small);
  let cell = 0;
  for (let d = 0; d <= 9; d++) cell = Math.max(cell, m(String(d)));
  const digit = runs.find((r) => r.kind === "digits")?.text.charCodeAt(0) ?? 48;
  if (digit > 0x0900) cell = Math.max(cell, m(String.fromCharCode(digit)));
  let w = 0;
  for (const r of runs) {
    if (r.kind === "digits") w += [...r.text].length * cell;
    else if (r.kind === "small") w += size * 0.16 + ms(r.text);
    else if (r.kind === "colon") w += m(":") + size * 0.04;
    else w += m(r.text);
  }
  return { runs, font, small, cell, w, size };
}

function drawRuns(g: Ctx2D, M: Measured, x: number, base: number, color: string | CanvasGradient, colonA: number): void {
  g.fillStyle = color; g.textBaseline = "alphabetic";
  let cx = x;
  for (const r of M.runs) {
    if (r.kind === "digits") {
      g.font = M.font; g.textAlign = "center";
      for (const ch of r.text) { g.fillText(ch, cx + M.cell / 2, base); cx += M.cell; }
    } else if (r.kind === "colon") {
      g.font = M.font; g.textAlign = "left";
      const w = measurer(g, M.font)(":");
      g.save(); g.globalAlpha *= colonA; g.fillText(":", cx + M.size * 0.02, base - M.size * 0.04); g.restore();
      cx += w + M.size * 0.04;
    } else if (r.kind === "small") {
      cx += M.size * 0.16;
      g.font = M.small; g.textAlign = "left";
      g.fillText(r.text, cx, base);
      cx += measurer(g, M.small)(r.text);
    } else {
      g.font = M.font; g.textAlign = "left";
      g.fillText(r.text, cx, base);
      cx += measurer(g, M.font)(r.text);
    }
  }
}

const alignX = (P: ClockProps, x: number, w: number, cw: number) => (P.align === "left" ? x : P.align === "right" ? x + w - cw : x + (w - cw) / 2);

function drawClock(g: Ctx2D, layer: GfxLayer, rc: RC): void {
  const P = clockProps(layer.p);
  const [x, y, w, h] = isCore(rc) ? rc.box : layer.box;
  const look = rc.look;
  const weight = P.weight > 0 ? P.weight : undefined;
  const color = rc.paint(P.color, "#FFFFFF");
  const colonA = P.blink && !colonOn(rc.clock) ? 0.22 : 1;
  const cy = y + h / 2;
  g.save();
  const line = (runs: ClockRun[], size: number, fontName: string, cyy: number, col: string | CanvasGradient, sample = "8") => {
    const font = rc.font(fontName, size, weight, sample);
    const small = rc.font(fontName, size * 0.5, weight, "AM");
    const M = measureRuns(g, runs, font, small, size);
    const k = M.w > w ? w / M.w : 1;
    g.save();
    const lx = alignX(P, x, w, M.w * k);
    if (k < 1) { g.translate(lx, cyy); g.scale(k, k); g.translate(-lx, -cyy); }
    g.font = font;
    drawRuns(g, M, lx, centreBaseline(g, sample, cyy), col, colonA);
    g.restore();
    return M.w * k;
  };
  const dateColor = rc.paint(P.dateColor, "#FFFFFF");
  const suffix = P.suffix ? [{ text: rc.text(P.suffix), kind: "small" as const }] : [];
  switch (P.show) {
    case "time": line([...timeRuns(rc.clock, look, P.seconds), ...suffix], P.size, P.font, cy, color); break;
    case "date": line(textRuns(capsFor(fmtDate(rc.clock, look), P.upper, look)), P.size, P.font, cy, color, "Ag"); break;
    case "day": {
      const z = zonedParts(rc.clock, look.clock.zone);
      line(textRuns(capsFor(DAYS[z.weekday], P.upper, look)), P.size, P.font, cy, color, "Ag");
      break;
    }
    case "time+date": {
      const date = capsFor(fmtDate(rc.clock, look), P.upper, look);
      const ds = P.size * P.dateScale;
      if (P.layout === "inline") {
        // time, a thin bar, the date: one line centred as a whole
        const tf = rc.font(P.font, P.size, weight, "8"), df = rc.font(P.dateFont, ds, undefined, date);
        const T = measureRuns(g, [...timeRuns(rc.clock, look, P.seconds), ...suffix], tf, rc.font(P.font, P.size * 0.5, weight, "AM"), P.size);
        const dw = measurer(g, df)(date);
        const gap = P.size * 0.45;
        const total = T.w + gap * 2 + dw;
        const k = total > w ? w / total : 1;
        const lx = alignX(P, x, w, total * k);
        g.save();
        if (k < 1) { g.translate(lx, cy); g.scale(k, k); g.translate(-lx, -cy); }
        g.font = tf;
        drawRuns(g, T, lx, centreBaseline(g, "8", cy), color, colonA);
        g.fillStyle = dateColor; g.globalAlpha *= 0.5;
        g.fillRect(lx + T.w + gap - 1, cy - P.size * 0.36, 2, P.size * 0.72);
        g.globalAlpha /= 0.5;
        g.font = df; g.textAlign = "left";
        g.fillText(date, lx + T.w + gap * 2, centreBaseline(g, date, cy));
        g.restore();
      } else {
        const gap = P.size * 0.2;
        const block = P.size * 0.74 + gap + ds * 0.74;
        const ty = cy - block / 2 + P.size * 0.37, dy = cy + block / 2 - ds * 0.37;
        line([...timeRuns(rc.clock, look, P.seconds), ...suffix], P.size, P.font, ty, color);
        line(textRuns(date), ds, P.dateFont, dy, dateColor, "Ag");
      }
      break;
    }
    case "temp": {
      const v = rc.value(P.field);
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
      const txt = n === null ? (typeof v === "string" ? v : "") : `${rc.number(n, { decimals: 0 })}°${P.unit}`;
      const icon = /^\{([\w.-]+)\}$/.test(P.icon) ? String(rc.value(P.icon.slice(1, -1)) ?? "") : P.icon;
      if (icon && iconDef(icon)) {
        const isz = Math.min(h * 0.86, P.size * 1.15);
        const font = rc.font(P.font, P.size, weight, "8");
        const tw = measurer(g, font)(txt);
        const total = isz + P.size * 0.22 + tw;
        const lx = alignX(P, x, w, total);
        drawIcon(g, icon, lx, cy - isz / 2, isz, isz, solid(rc, P.iconColor, "#FFC20E"), color);
        g.font = font; g.fillStyle = color; g.textAlign = "left"; g.textBaseline = "alphabetic";
        g.fillText(txt, lx + isz + P.size * 0.22, centreBaseline(g, "8", cy));
      } else line(textRuns(txt), P.size, P.font, cy, color);
      break;
    }
    case "match": {
      const sport = String(rc.value(P.sportField) ?? "cricket");
      const s = matchText(sport, rc.value(P.timeField), rc.value(P.oversField), rc.t);
      line(textRuns(capsFor(s, "on", look)), P.size, P.font, cy, color);
      break;
    }
  }
  g.restore();
}

registerLayerKind({
  kind: "clock", label: "Clock", group: "Data", props: CLOCK_PROPS,
  draw: drawClock,
  animates(layer, rc) {
    const P = clockProps(layer.p);
    if (P.show === "time" || P.show === "time+date") return true;
    if (P.show === "match") return String(rc.value(P.sportField) ?? "").toLowerCase() !== "cricket";
    return false;
  },
  measure(g, layer, rc) {
    const P = clockProps(layer.p);
    const font = rc.font(P.font, P.size, P.weight || undefined, "8");
    return measureRuns(g, timeRuns(rc.clock, rc.look, P.seconds), font, rc.font(P.font, P.size * 0.5, undefined, "AM"), P.size).w;
  },
  fonts(layer, rc) {
    const P = clockProps(layer.p);
    const w = P.weight > 0 ? P.weight : undefined;
    return [cssFont(P.font, rc.look, P.size, w, "0"), cssFont(P.dateFont, rc.look, P.size * P.dateScale, undefined, "A")];
  },
});
