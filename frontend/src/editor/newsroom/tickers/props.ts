/**
 * The "ticker" and "clock" layer kinds' properties (docs/EDITOR.md §16.3): the Designer builds its inspector from
 * these PropDefs, and the kinds read a layer's `p` through `tickerProps` / `clockProps` (defaults filled, values
 * checked). Pure.
 */
import type { Paint } from "../types.ts";
import type { PropDef } from "../render/contract.ts";
import type { DeltaStyle, SpeedName } from "./math.ts";

const o = (...v: [string, string][]) => v.map(([value, label]) => ({ value, label }));

export type TickerMode = "crawl" | "flip" | "stack" | "tally" | "seats";
export type TickerTransition = "flip" | "slide" | "fade" | "wipe";
export type TickerSeparator = "look" | "dot" | "diamond" | "bar" | "slash" | "logo" | "none";

export const TICKER_PROPS: PropDef[] = [
  // items and motion
  { key: "source", label: "Items", type: "field", default: "items", group: "Items", hint: "The list field the ticker shows" },
  { key: "mode", label: "Mode", type: "choice", default: "crawl", group: "Items",
    options: o(["crawl", "Crawl"], ["flip", "Flip"], ["stack", "Stack of two"], ["tally", "Tally (election)"], ["seats", "Seat bar"]) },
  { key: "speed", label: "Speed", type: "choice", default: "normal", group: "Motion",
    options: o(["slow", "Slow"], ["normal", "Normal"], ["fast", "Fast"], ["custom", "Custom"]) },
  { key: "speedPx", label: "Custom speed", type: "number", default: 150, min: 20, max: 600, step: 1, unit: "px/s", group: "Motion" },
  { key: "direction", label: "Direction", type: "choice", default: "left", group: "Motion", options: o(["left", "Right to left"], ["right", "Left to right"]) },
  { key: "startFull", label: "Start full", type: "bool", default: true, group: "Motion", hint: "The crawl already fills the band on the first frame" },
  { key: "loopFit", label: "Perfect loop", type: "bool", default: false, group: "Motion", hint: "Adjusts the speed a little so the clip ends where it began" },
  { key: "hold", label: "Seconds per item", type: "number", default: 5, min: 1, max: 30, step: 0.5, unit: "s", group: "Motion" },
  { key: "transition", label: "Change", type: "choice", default: "slide", group: "Motion", options: o(["slide", "Slide up"], ["flip", "Flip"], ["fade", "Fade"], ["wipe", "Wipe"]) },
  { key: "transDur", label: "Change length", type: "number", default: 0.45, min: 0.1, max: 1.5, step: 0.05, unit: "s", group: "Motion" },
  { key: "rows", label: "Rows", type: "number", default: 2, min: 1, max: 4, step: 1, group: "Motion", hint: "Stack of two: rows on screen" },
  { key: "perPage", label: "Items at once", type: "number", default: 1, min: 1, max: 6, step: 1, group: "Motion", hint: "Flip and tally: items shown side by side" },
  { key: "byTag", label: "Group by tag", type: "bool", default: false, group: "Motion", hint: "A flip page never mixes tags (one city at a time)" },
  // text
  { key: "font", label: "Font", type: "font", default: "@headline", group: "Text" },
  { key: "size", label: "Size", type: "number", default: 40, min: 12, max: 160, step: 1, unit: "px", group: "Text" },
  { key: "weight", label: "Weight", type: "number", default: 0, min: 0, max: 900, step: 100, group: "Text", hint: "0 follows the look" },
  { key: "color", label: "Colour", type: "paint", default: "@text", group: "Text" },
  { key: "upper", label: "Capitals", type: "choice", default: "off", group: "Text", options: o(["look", "Follow look"], ["on", "On"], ["off", "Off"]) },
  { key: "tracking", label: "Letter spacing", type: "number", default: 0, min: -0.05, max: 0.3, step: 0.01, unit: "em", group: "Text" },
  { key: "lines", label: "Lines", type: "number", default: 1, min: 1, max: 2, step: 1, group: "Text", hint: "Flip and stack: long items wrap to two lines" },
  { key: "align", label: "Align", type: "choice", default: "left", group: "Text", options: o(["left", "Left"], ["center", "Centre"]) },
  { key: "numbered", label: "Numbers", type: "bool", default: false, group: "Text", hint: "A number badge before each item (speed news)" },
  { key: "numberFill", label: "Number badge", type: "paint", default: "@accent", group: "Text" },
  { key: "numberColor", label: "Number text", type: "paint", default: "@dark", group: "Text" },
  // separators
  { key: "separator", label: "Separator", type: "choice", default: "look", group: "Separators",
    options: o(["look", "Follow look"], ["dot", "Dot"], ["diamond", "Diamond"], ["bar", "Bar"], ["slash", "Slash"], ["logo", "Logo"], ["none", "None"]) },
  { key: "sepColor", label: "Separator colour", type: "paint", default: "@accent", group: "Separators" },
  { key: "gap", label: "Gap", type: "number", default: 0, min: 0, max: 400, step: 2, unit: "px", group: "Separators", hint: "0 = automatic" },
  // tags and the label box
  { key: "tags", label: "Tags", type: "choice", default: "inline", group: "Tags",
    options: o(["none", "Hidden"], ["inline", "Chip before the item"], ["box", "Box that changes with the items"]) },
  { key: "label", label: "Label", type: "text", default: "", group: "Tags", hint: "A fixed box at the start (BREAKING, MARKETS …)" },
  { key: "tagFill", label: "Tag colour", type: "paint", default: "@accent", group: "Tags" },
  { key: "tagColor", label: "Tag text", type: "paint", default: "@dark", group: "Tags", hint: "auto = black or white, whichever reads better" },
  { key: "tagUpper", label: "Tag capitals", type: "choice", default: "on", group: "Tags", options: o(["look", "Follow look"], ["on", "On"], ["off", "Off"]) },
  { key: "labelIcon", label: "Label icon", type: "icon", default: "", group: "Tags" },
  { key: "tagEdge", label: "Box edge", type: "paint", default: "", group: "Tags", hint: "A thin line along the box's right end" },
  { key: "tagFont", label: "Tag font", type: "font", default: "@headline", group: "Tags" },
  { key: "tagSize", label: "Tag size", type: "number", default: 0, min: 0, max: 120, step: 1, unit: "px", group: "Tags", hint: "0 = automatic" },
  { key: "tagWidth", label: "Box width", type: "number", default: 0, min: 0, max: 900, step: 2, unit: "px", group: "Tags", hint: "0 = fits the longest tag" },
  { key: "labelFlash", label: "Flash the label", type: "bool", default: false, group: "Tags" },
  { key: "labelTop", label: "Label above", type: "number", default: 0, min: 0, max: 200, step: 2, unit: "px", group: "Tags", hint: "Puts the label (or tag box) on a tab this tall above the band; 0 = at its start" },
  // priority items
  { key: "flashFill", label: "Priority colour", type: "paint", default: "@breaking", group: "Priority" },
  { key: "flashColor", label: "Priority text", type: "paint", default: "#FFFFFF", group: "Priority" },
  { key: "flashPeriod", label: "Flash every", type: "number", default: 1, min: 0.5, max: 4, step: 0.1, unit: "s", group: "Priority" },
  // values (markets, rates, weather, scores)
  { key: "values", label: "Values", type: "choice", default: "auto", group: "Values", options: o(["auto", "Show when set"], ["off", "Hide"]) },
  { key: "deltaStyle", label: "Change as", type: "choice", default: "abs+pct", group: "Values", options: o(["pct", "Percent"], ["abs", "Points"], ["abs+pct", "Points and percent"]) },
  { key: "decimals", label: "Decimals", type: "number", default: 2, min: -1, max: 4, step: 1, group: "Values", hint: "-1 = none for whole numbers, else 2" },
  { key: "prefix", label: "Before values", type: "text", default: "", group: "Values" },
  { key: "suffix", label: "After values", type: "text", default: "", group: "Values" },
  { key: "currency", label: "Currency sign", type: "bool", default: false, group: "Values" },
  { key: "valueFont", label: "Value font", type: "font", default: "@numbers", group: "Values" },
  { key: "valueColor", label: "Value colour", type: "paint", default: "@text", group: "Values" },
  { key: "upColor", label: "Up colour", type: "paint", default: "@up", group: "Values" },
  { key: "downColor", label: "Down colour", type: "paint", default: "@down", group: "Values" },
  { key: "iconColor", label: "Icon colour", type: "paint", default: "@text", group: "Values" },
  { key: "icon2Color", label: "Icon second colour", type: "paint", default: "@accent", group: "Values" },
  // band
  { key: "fill", label: "Band", type: "paint", default: "", group: "Band", hint: "A plate behind the items (templates usually use a rect layer)" },
  { key: "stripe", label: "Top stripe", type: "paint", default: "", group: "Band" },
  { key: "stripeH", label: "Stripe height", type: "number", default: 4, min: 1, max: 20, step: 1, unit: "px", group: "Band" },
  { key: "bleedL", label: "Bleed left", type: "number", default: 0, min: 0, max: 400, step: 1, unit: "px", group: "Band", hint: "The band runs past the safe area by this much; items stay inside" },
  { key: "bleedR", label: "Bleed right", type: "number", default: 0, min: 0, max: 400, step: 1, unit: "px", group: "Band" },
  { key: "fade", label: "Soft edges", type: "number", default: 0, min: 0, max: 200, step: 2, unit: "px", group: "Band" },
  { key: "padX", label: "Inner margin", type: "number", default: 0, min: 0, max: 200, step: 2, unit: "px", group: "Band", hint: "0 = automatic" },
  { key: "divider", label: "Row lines", type: "bool", default: true, group: "Band" },
  // election
  { key: "total", label: "Total seats", type: "number", default: 543, min: 1, max: 5000, step: 1, group: "Election", hint: "A number or {field}" },
  { key: "majority", label: "Majority mark", type: "number", default: 272, min: 0, max: 5000, step: 1, group: "Election", hint: "A number or {field}" },
  { key: "wonLabel", label: "Won label", type: "text", default: "Won", group: "Election" },
  { key: "leadLabel", label: "Leading label", type: "text", default: "Lead", group: "Election" },
  { key: "majLabel", label: "Majority label", type: "text", default: "Majority", group: "Election" },
];

export interface TickerProps {
  source: string; mode: TickerMode;
  speed: SpeedName | "custom"; speedPx: number; direction: "left" | "right"; startFull: boolean; loopFit: boolean;
  hold: number; transition: TickerTransition; transDur: number; rows: number; perPage: number; byTag: boolean;
  font: string; size: number; weight: number; color: Paint; upper: "look" | "on" | "off"; tracking: number; lines: 1 | 2;
  align: "left" | "center"; numbered: boolean; numberFill: Paint; numberColor: Paint;
  separator: TickerSeparator; sepColor: Paint; gap: number;
  tags: "none" | "inline" | "box"; label: string; tagFill: Paint; tagColor: Paint; tagUpper: "look" | "on" | "off"; labelIcon: string; tagEdge: Paint;
  tagFont: string; tagSize: number; tagWidth: number; labelFlash: boolean; labelTop: number;
  flashFill: Paint; flashColor: Paint; flashPeriod: number;
  values: "auto" | "off"; deltaStyle: DeltaStyle; decimals: number; prefix: string; suffix: string; currency: boolean;
  valueFont: string; valueColor: Paint; upColor: Paint; downColor: Paint; iconColor: Paint; icon2Color: Paint;
  fill: Paint; stripe: Paint; stripeH: number; bleedL: number; bleedR: number; fade: number; padX: number; divider: boolean;
  /** A number, or "{field}" (read when drawing: numProp). */
  total: number | string; majority: number | string; wonLabel: string; leadLabel: string; majLabel: string;
}

const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (typeof v === "string" && (ok as readonly string[]).includes(v) ? (v as T) : d);
const num = (v: unknown, d: number, min = -Infinity, max = Infinity): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
const str = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const paint = (v: unknown, d: Paint): Paint => (typeof v === "string" || (v && typeof v === "object" && Array.isArray((v as { gradient?: unknown }).gradient)) ? (v as Paint) : d);

const DEF: Record<string, unknown> = Object.fromEntries(TICKER_PROPS.map((p) => [p.key, p.default]));

/** A ticker layer's `p` with every property present and in range. */
export function tickerProps(p: Record<string, unknown> = {}): TickerProps {
  const d = (k: string) => DEF[k];
  return {
    source: str(p.source, d("source") as string),
    mode: pick(p.mode, ["crawl", "flip", "stack", "tally", "seats"] as const, "crawl"),
    speed: pick(p.speed, ["slow", "normal", "fast", "custom"] as const, "normal"),
    speedPx: num(p.speedPx, 150, 1, 2000),
    direction: pick(p.direction, ["left", "right"] as const, "left"),
    startFull: bool(p.startFull, true), loopFit: bool(p.loopFit, false),
    hold: num(p.hold, 5, 0.5, 120), transition: pick(p.transition, ["flip", "slide", "fade", "wipe"] as const, "slide"),
    transDur: num(p.transDur, 0.45, 0, 3), rows: Math.round(num(p.rows, 2, 1, 6)), perPage: Math.round(num(p.perPage, 1, 1, 8)),
    byTag: bool(p.byTag, false),
    font: str(p.font, "@headline") || "@headline", size: num(p.size, 40, 4, 400), weight: num(p.weight, 0, 0, 1000),
    color: paint(p.color, "@text"), upper: pick(p.upper, ["look", "on", "off"] as const, "off"), tracking: num(p.tracking, 0, -0.2, 1),
    lines: num(p.lines, 1) >= 2 ? 2 : 1, align: pick(p.align, ["left", "center"] as const, "left"),
    numbered: bool(p.numbered, false), numberFill: paint(p.numberFill, "@accent"), numberColor: paint(p.numberColor, "@dark"),
    separator: pick(p.separator, ["look", "dot", "diamond", "bar", "slash", "logo", "none"] as const, "look"),
    sepColor: paint(p.sepColor, "@accent"), gap: num(p.gap, 0, 0, 2000),
    tags: pick(p.tags, ["none", "inline", "box"] as const, "inline"), label: str(p.label, ""),
    tagFill: paint(p.tagFill, "@accent"), tagColor: paint(p.tagColor, "@dark"), tagUpper: pick(p.tagUpper, ["look", "on", "off"] as const, "on"),
    labelIcon: str(p.labelIcon, ""), tagEdge: paint(p.tagEdge, ""), tagFont: str(p.tagFont, "@headline") || "@headline",
    tagSize: num(p.tagSize, 0, 0, 400), tagWidth: num(p.tagWidth, 0, 0, 4000), labelFlash: bool(p.labelFlash, false),
    labelTop: num(p.labelTop, 0, 0, 1000),
    flashFill: paint(p.flashFill, "@breaking"), flashColor: paint(p.flashColor, "#FFFFFF"), flashPeriod: num(p.flashPeriod, 1, 0.5, 10),
    values: pick(p.values, ["auto", "off"] as const, "auto"), deltaStyle: pick(p.deltaStyle, ["pct", "abs", "abs+pct"] as const, "abs+pct"),
    decimals: Math.round(num(p.decimals, 2, -1, 6)), prefix: str(p.prefix, ""), suffix: str(p.suffix, ""), currency: bool(p.currency, false),
    valueFont: str(p.valueFont, "@numbers") || "@numbers", valueColor: paint(p.valueColor, "@text"),
    upColor: paint(p.upColor, "@up"), downColor: paint(p.downColor, "@down"),
    iconColor: paint(p.iconColor, "@text"), icon2Color: paint(p.icon2Color, "@accent"),
    fill: paint(p.fill, ""), stripe: paint(p.stripe, ""), stripeH: num(p.stripeH, 4, 0, 100),
    bleedL: num(p.bleedL, 0, 0, 2000), bleedR: num(p.bleedR, 0, 0, 2000), fade: num(p.fade, 0, 0, 1000),
    padX: num(p.padX, 0, 0, 1000), divider: bool(p.divider, true),
    total: typeof p.total === "string" ? p.total : Math.max(1, num(p.total, 543)),
    majority: typeof p.majority === "string" ? p.majority : num(p.majority, 272, 0),
    wonLabel: str(p.wonLabel, "Won"), leadLabel: str(p.leadLabel, "Lead"), majLabel: str(p.majLabel, "Majority"),
  };
}

/** A number prop that may name a field ("{total}" → that field's number); `d` when it isn't a number. */
export function numProp(v: number | string, value: (id: string) => unknown, d: number): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : d;
  const m = /^\{([\w.-]+)\}$/.exec(v.trim());
  const x = m ? value(m[1]) : v;
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : d;
}

/** Decimals for a value: fixed, or (-1) none for whole numbers and 2 otherwise (₹94.72, ₹73,450). */
export const decimalsFor = (decimals: number, v: number): number => (decimals >= 0 ? decimals : Number.isInteger(v) ? 0 : 2);

// ── clock ────────────────────────────────────────────────────────────────────

export type ClockShow = "time" | "date" | "time+date" | "day" | "temp" | "match";

export const CLOCK_PROPS: PropDef[] = [
  { key: "show", label: "Show", type: "choice", default: "time", group: "Clock",
    options: o(["time", "Time"], ["date", "Date"], ["time+date", "Time and date"], ["day", "Day"], ["temp", "Temperature"], ["match", "Match clock"]) },
  { key: "seconds", label: "Seconds", type: "bool", default: false, group: "Clock" },
  { key: "blink", label: "Blinking colon", type: "bool", default: false, group: "Clock" },
  { key: "layout", label: "Time and date", type: "choice", default: "stack", group: "Clock", options: o(["stack", "One above the other"], ["inline", "Side by side"]) },
  { key: "suffix", label: "After the time", type: "text", default: "", group: "Clock", hint: "IST, a city …" },
  { key: "font", label: "Font", type: "font", default: "@numbers", group: "Text" },
  { key: "size", label: "Size", type: "number", default: 44, min: 10, max: 300, step: 1, unit: "px", group: "Text" },
  { key: "weight", label: "Weight", type: "number", default: 0, min: 0, max: 900, step: 100, group: "Text", hint: "0 follows the look" },
  { key: "color", label: "Colour", type: "paint", default: "@text", group: "Text" },
  { key: "align", label: "Align", type: "choice", default: "center", group: "Text", options: o(["left", "Left"], ["center", "Centre"], ["right", "Right"]) },
  { key: "dateFont", label: "Date font", type: "font", default: "@body", group: "Text" },
  { key: "dateScale", label: "Date size", type: "number", default: 0.46, min: 0.2, max: 1, step: 0.02, group: "Text", hint: "A share of the time's size" },
  { key: "dateColor", label: "Date colour", type: "paint", default: "@text/80", group: "Text" },
  { key: "upper", label: "Capitals", type: "choice", default: "look", group: "Text", options: o(["look", "Follow look"], ["on", "On"], ["off", "Off"]) },
  { key: "field", label: "Temperature", type: "field", default: "temp", group: "Temperature" },
  { key: "unit", label: "Unit", type: "choice", default: "C", group: "Temperature", options: o(["C", "°C"], ["F", "°F"], ["", "° only"]) },
  { key: "icon", label: "Icon", type: "text", default: "", group: "Temperature", hint: "An icon name, or {field}" },
  { key: "iconColor", label: "Icon colour", type: "paint", default: "@accent", group: "Temperature" },
  { key: "sportField", label: "Sport", type: "field", default: "sport", group: "Match" },
  { key: "timeField", label: "Match time", type: "field", default: "clock", group: "Match", hint: "mm:ss at the clip's start" },
  { key: "oversField", label: "Overs", type: "field", default: "overs", group: "Match" },
];

export interface ClockProps {
  show: ClockShow; seconds: boolean; blink: boolean; layout: "stack" | "inline"; suffix: string;
  font: string; size: number; weight: number; color: Paint; align: "left" | "center" | "right";
  dateFont: string; dateScale: number; dateColor: Paint; upper: "look" | "on" | "off";
  field: string; unit: "C" | "F" | ""; icon: string; iconColor: Paint;
  sportField: string; timeField: string; oversField: string;
}

/** A clock layer's `p` with every property present and in range. */
export function clockProps(p: Record<string, unknown> = {}): ClockProps {
  return {
    show: pick(p.show, ["time", "date", "time+date", "day", "temp", "match"] as const, "time"),
    seconds: bool(p.seconds, false), blink: bool(p.blink, false), layout: pick(p.layout, ["stack", "inline"] as const, "stack"),
    suffix: str(p.suffix, ""),
    font: str(p.font, "@numbers") || "@numbers", size: num(p.size, 44, 4, 600), weight: num(p.weight, 0, 0, 1000),
    color: paint(p.color, "@text"), align: pick(p.align, ["left", "center", "right"] as const, "center"),
    dateFont: str(p.dateFont, "@body") || "@body", dateScale: num(p.dateScale, 0.46, 0.1, 2), dateColor: paint(p.dateColor, "@text/80"),
    upper: pick(p.upper, ["look", "on", "off"] as const, "look"),
    field: str(p.field, "temp"), unit: pick(p.unit, ["C", "F", ""] as const, "C"), icon: str(p.icon, ""), iconColor: paint(p.iconColor, "@accent"),
    sportField: str(p.sportField, "sport"), timeField: str(p.timeField, "clock"), oversField: str(p.oversField, "overs"),
  };
}

/** Field ids a layer's props refer to (the template check: each must be a field of the template). */
export function tickerFieldRefs(kind: string, p: Record<string, unknown>): string[] {
  const tok = (s: unknown) => (typeof s === "string" ? [...s.matchAll(/\{([\w.-]+)\}/g)].map((m) => m[1]) : []);
  if (kind === "ticker") {
    const q = tickerProps(p);
    return [q.source, ...tok(q.label), ...tok(q.labelIcon), ...[q.tagFill, q.tagColor, q.tagEdge, q.fill, q.stripe, q.color, q.total, q.majority].flatMap(tok)];
  }
  if (kind === "clock") {
    const q = clockProps(p);
    const refs = [...tok(q.suffix), ...tok(q.icon)];
    if (q.show === "temp") refs.push(q.field);
    if (q.show === "match") refs.push(q.sportField, q.timeField, q.oversField);
    return refs;
  }
  return [];
}
