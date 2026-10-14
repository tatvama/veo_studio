/**
 * News Room data (docs/EDITOR.md §16.10): mappers turn a source's rows into what a template shows. Columns are found by
 * their names in English and Hindi ("Headline", "City", "Temp °C", "Change %", "दल" …), numbers are read the way
 * newsrooms write them (₹1,23,456, −0.4 %, ▼12, native digits). Each mapper gives ticker-style items and tidy rows:
 *   ticker   → { text, tag, flash }                 weather  → { city, temp, min, max, condition, icon }
 *   markets  → { name, value, change, pct }         score    → { team, score, detail }
 *   election → { party, won, leading, total, color } rates   → { item, city, price, change, unit }
 * Items follow the tickers' conventions: markets { text, value, delta = change in points }, weather { text, icon, value },
 * rates { text, tag = city, value, delta }, election { text, value = won, delta = leading, color }.
 * Pure.
 */
import type { GfxListItem, GfxTableRow, GfxTemplate } from "../types.ts";

// ── columns and numbers ──────────────────────────────────────────────────────

/** "Temp (°C)" → "tempc"; Indian scripts are kept. */
export const normCol = (s: string) => s.toLowerCase().normalize("NFC").replace(/[\s_.()[\]\-:/°]+/g, "");

/** The column whose name best matches one of `names` (exact first, in the order given, then prefix, then contains). */
export function findCol(columns: string[], names: string[], except: string[] = []): string | undefined {
  const cols = columns.filter((c) => !except.includes(c)).map((c) => [c, normCol(c)] as const);
  for (const n of names.map(normCol)) { const hit = cols.find(([, k]) => k === n); if (hit) return hit[0]; }
  for (const n of names.map(normCol)) { if (n.length < 3) continue; const hit = cols.find(([, k]) => k.startsWith(n)); if (hit) return hit[0]; }
  for (const n of names.map(normCol)) { if (n.length < 4) continue; const hit = cols.find(([, k]) => k.includes(n)); if (hit) return hit[0]; }
  return undefined;
}

/** Every column of some rows, in first-seen order. */
export function columnsOf(rows: GfxTableRow[]): string[] {
  const out: string[] = [], seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); out.push(k); }
  return out;
}

const DIGIT_ZEROS = [0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66];
/** Native digits (Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam) → 0-9. */
export function latinDigits(s: string): string {
  return s.replace(/[०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯]/g, (c) => {
    const cp = c.codePointAt(0)!;
    const z = DIGIT_ZEROS.find((b) => cp >= b && cp <= b + 9)!;
    return String(cp - z);
  });
}

/** A number as written in a cell ("₹ 1,23,456.5", "−0.42%", "▼ 12", "(3.5)", "+12 pts", "२४") or undefined. */
export function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  let s = latinDigits(v).trim();
  if (!s) return undefined;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/[▼↓🔻]/u.test(s)) neg = true;
  s = s.replace(/[−‒–—]/g, "-").replace(/[▲▼↑↓🔺🔻]/gu, "").replace(/(rs\.?|inr|usd|₹|\$|€|£)/gi, "");
  const m = s.match(/[-+]?\s*\d[\d,]*(\.\d+)?|[-+]?\s*\.\d+/);
  if (!m) return undefined;
  const n = Number(m[0].replace(/[\s,]/g, ""));
  if (!Number.isFinite(n)) return undefined;
  return neg ? -Math.abs(n) : n;
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
const truthy = (v: unknown) => /^(y|yes|true|1|x|✓|✔|haan|हाँ|हां)$/i.test(str(v));

// ── weather icons ────────────────────────────────────────────────────────────

/** Weather icon names (the renderer's icon set). */
export type WeatherIcon = "sun" | "cloud_sun" | "cloud" | "rain" | "storm" | "snow" | "fog" | "wind";
/** A condition in words (English or Hindi) → an icon name. */
export function conditionIcon(cond: string): WeatherIcon {
  const c = cond.toLowerCase();
  if (/thunder|storm|lightning|cyclone|आंधी|तूफान|तूफ़ान|गरज/.test(c)) return "storm";
  if (/snow|sleet|hail|ice|बर्फ|ओले/.test(c)) return "snow";
  if (/rain|shower|drizzle|monsoon|wet|बारिश|वर्षा|बूंदाबांदी/.test(c)) return "rain";
  if (/fog|mist|haze|smog|smoke|dust|कोहरा|धुंध/.test(c)) return "fog";
  if (/wind|breez|gust|हवा/.test(c)) return "wind";
  if (/partly|partial|scattered|few clouds|mostly sunny|intervals|आंशिक/.test(c)) return "cloud_sun";
  if (/cloud|overcast|grey|gray|बादल|मेघ/.test(c)) return "cloud";
  return "sun";
}

// ── mappers ──────────────────────────────────────────────────────────────────

export type MapperId = "ticker" | "weather" | "markets" | "score" | "election" | "rates";
export interface Mapped { items: GfxListItem[]; rows: GfxTableRow[] }
export interface MapOptions { /** The main column (headline, city, name …) when it isn't found by name. */ column?: string }

const NAMES = {
  headline: ["headline", "title", "text", "news", "story", "line", "heading", "item", "शीर्षक", "खबर", "समाचार", "हेडलाइन"],
  tag: ["category", "tag", "section", "label", "topic", "type", "श्रेणी"],
  flash: ["flash", "breaking", "priority", "urgent", "alert"],
  city: ["city", "place", "location", "town", "district", "station", "name", "शहर", "स्थान"],
  temp: ["temp", "temperature", "tempc", "now", "current", "degrees", "तापमान"],
  min: ["min", "low", "minimum", "mintemp", "न्यूनतम"],
  max: ["max", "high", "maximum", "maxtemp", "अधिकतम"],
  cond: ["condition", "weather", "sky", "conditions", "forecast", "description", "summary", "status", "मौसम"],
  market: ["name", "index", "symbol", "stock", "scrip", "company", "instrument", "ticker", "item", "नाम"],
  value: ["value", "price", "last", "ltp", "close", "level", "rate", "current", "मूल्य"],
  change: ["change", "chg", "net", "netchange", "points", "diff", "delta", "बदलाव"],
  pct: ["%", "pct", "percent", "change%", "%change", "pctchange", "changepct", "changepercent", "percentchange"],
  team: ["team", "side", "name", "country", "club", "टीम"],
  score: ["score", "runs", "goals", "points", "pts", "total", "स्कोर"],
  wickets: ["wickets", "wkts", "wkt", "w"],
  overs: ["overs", "over", "ov"],
  detail: ["status", "detail", "details", "info", "note", "result"],
  party: ["party", "alliance", "front", "candidate", "name", "दल", "पार्टी"],
  won: ["won", "wins", "win", "seats", "seatswon", "जीते", "जीत"],
  leading: ["leading", "leads", "lead", "ahead", "आगे", "बढ़त"],
  color: ["color", "colour", "hex", "रंग"],
  item: ["item", "commodity", "product", "fuel", "metal", "name", "वस्तु"],
  rcity: ["city", "place", "market", "location", "mandi", "शहर"],
  price: ["price", "rate", "value", "cost", "inr", "rs", "₹", "भाव", "कीमत"],
  unit: ["unit", "per", "uom", "इकाई"],
} as const;

const L = (k: keyof typeof NAMES) => [...NAMES[k]];
/** The first column that holds text in most rows (the fallback main column). */
function firstTextCol(cols: string[], rows: GfxTableRow[]): string | undefined {
  return cols.find((c) => rows.filter((r) => typeof r[c] === "string" && str(r[c]) && num(r[c]) === undefined).length >= Math.max(1, rows.length / 2)) ?? cols[0];
}
const firstNumCol = (cols: string[], rows: GfxTableRow[], except: string[]) =>
  cols.find((c) => !except.includes(c) && rows.some((r) => num(r[c]) !== undefined));

function tickerMap(rows: GfxTableRow[], o: MapOptions = {}): Mapped {
  const cols = columnsOf(rows);
  const h = o.column ?? findCol(cols, L("headline")) ?? firstTextCol(cols, rows);
  const tag = findCol(cols, L("tag"), h ? [h] : []), fl = findCol(cols, L("flash"), h ? [h] : []);
  const items: GfxListItem[] = [];
  for (const r of rows) {
    const text = str(h ? r[h] : "");
    if (!text) continue;
    const t = tag ? str(r[tag]) : "";
    items.push({ text, ...(t ? { tag: t } : {}), ...(fl && truthy(r[fl]) ? { flash: true } : {}) });
  }
  return { items, rows: items.map((i) => ({ text: i.text, tag: i.tag ?? "" })) };
}

function weatherMap(rows: GfxTableRow[], o: MapOptions = {}): Mapped {
  const cols = columnsOf(rows);
  const city = o.column ?? findCol(cols, L("city")) ?? firstTextCol(cols, rows);
  const ex = city ? [city] : [];
  const minC = findCol(cols, L("min"), ex), maxC = findCol(cols, L("max"), ex);
  const temp = findCol(cols, L("temp"), [...ex, ...(minC ? [minC] : []), ...(maxC ? [maxC] : [])]) ?? maxC ?? firstNumCol(cols, rows, ex);
  const cond = findCol(cols, L("cond"), ex);
  const out: Mapped = { items: [], rows: [] };
  for (const r of rows) {
    const name = str(city ? r[city] : "");
    if (!name) continue;
    const t = temp ? num(r[temp]) : undefined, c = cond ? str(r[cond]) : "", icon = conditionIcon(c);
    const lo = minC ? num(r[minC]) : undefined, hi = maxC ? num(r[maxC]) : undefined;
    out.items.push({ text: name, icon, ...(t !== undefined ? { value: t } : {}) });
    out.rows.push({ city: name, temp: t ?? "", min: lo ?? "", max: hi ?? "", condition: c, icon });
  }
  return out;
}

function marketsMap(rows: GfxTableRow[], o: MapOptions = {}): Mapped {
  const cols = columnsOf(rows);
  const name = o.column ?? findCol(cols, L("market")) ?? firstTextCol(cols, rows);
  const ex = name ? [name] : [];
  const pct = cols.find((c) => /%|pct|percent/i.test(c) && c !== name) ?? findCol(cols, L("pct"), ex);
  const change = findCol(cols, L("change"), [...ex, ...(pct ? [pct] : [])]);
  const value = findCol(cols, L("value"), [...ex, ...(pct ? [pct] : []), ...(change ? [change] : [])]) ?? firstNumCol(cols, rows, [...ex, ...(pct ? [pct] : []), ...(change ? [change] : [])]);
  const out: Mapped = { items: [], rows: [] };
  for (const r of rows) {
    const n = str(name ? r[name] : "");
    if (!n) continue;
    const v = value ? num(r[value]) : undefined;
    let ch = change ? num(r[change]) : undefined, pc = pct ? num(r[pct]) : undefined;
    if (pc === undefined && ch !== undefined && v !== undefined && v - ch !== 0) pc = Math.round((ch / (v - ch)) * 10000) / 100;
    if (ch === undefined && pc !== undefined && v !== undefined) ch = Math.round((v - v / (1 + pc / 100)) * 100) / 100;
    const d = ch ?? pc;
    out.items.push({ text: n, ...(v !== undefined ? { value: v } : {}), ...(d !== undefined ? { delta: d } : {}) });
    out.rows.push({ name: n, value: v ?? "", change: ch ?? "", pct: pc ?? "" });
  }
  return out;
}

function scoreMap(rows: GfxTableRow[], o: MapOptions = {}): Mapped {
  const cols = columnsOf(rows);
  const team = o.column ?? findCol(cols, L("team")) ?? firstTextCol(cols, rows);
  const ex = team ? [team] : [];
  const score = findCol(cols, L("score"), ex) ?? firstNumCol(cols, rows, ex);
  const wk = findCol(cols, L("wickets"), [...ex, ...(score ? [score] : [])]), ov = findCol(cols, L("overs"), [...ex, ...(score ? [score] : [])]);
  const det = findCol(cols, L("detail"), ex);
  const out: Mapped = { items: [], rows: [] };
  for (const r of rows) {
    const t = str(team ? r[team] : "");
    if (!t) continue;
    const raw = score ? str(r[score]) : "";
    const w = wk ? str(r[wk]) : "", o2 = ov ? str(r[ov]) : "";
    const s = w && !raw.includes("/") ? `${raw}/${w}` : raw;
    const text = o2 ? `${s} (${o2})` : s;
    const d = det ? str(r[det]) : "";
    const v = num(raw);
    out.items.push({ text: t, ...(v !== undefined ? { value: v } : {}), ...(text ? { tag: text } : {}) });
    out.rows.push({ team: t, score: text, detail: d });
  }
  return out;
}

function electionMap(rows: GfxTableRow[], o: MapOptions = {}): Mapped {
  const cols = columnsOf(rows);
  const party = o.column ?? findCol(cols, L("party")) ?? firstTextCol(cols, rows);
  const ex = party ? [party] : [];
  const won = findCol(cols, L("won"), ex), lead = findCol(cols, L("leading"), [...ex, ...(won ? [won] : [])]);
  const color = findCol(cols, L("color"), ex);
  const out: Mapped = { items: [], rows: [] };
  for (const r of rows) {
    const p = str(party ? r[party] : "");
    if (!p) continue;
    const w = (won ? num(r[won]) : undefined) ?? 0, l = (lead ? num(r[lead]) : undefined) ?? 0;
    const c = color ? str(r[color]) : "";
    const col = /^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c) ? (c.startsWith("#") ? c : `#${c}`) : c;
    out.items.push({ text: p, value: w, delta: l, ...(col ? { color: col } : {}) });
    out.rows.push({ party: p, won: w, leading: l, total: w + l, color: col });
  }
  return out;
}

function ratesMap(rows: GfxTableRow[], o: MapOptions = {}): Mapped {
  const cols = columnsOf(rows);
  const item = o.column ?? findCol(cols, L("item")) ?? firstTextCol(cols, rows);
  const ex = item ? [item] : [];
  const city = findCol(cols, L("rcity"), ex);
  const price = findCol(cols, L("price"), [...ex, ...(city ? [city] : [])]) ?? firstNumCol(cols, rows, ex);
  const change = findCol(cols, L("change"), [...ex, ...(price ? [price] : [])]), unit = findCol(cols, L("unit"), ex);
  const out: Mapped = { items: [], rows: [] };
  for (const r of rows) {
    const it = str(item ? r[item] : "");
    if (!it) continue;
    const c = city ? str(r[city]) : "", p = price ? num(r[price]) : undefined, ch = change ? num(r[change]) : undefined, u = unit ? str(r[unit]) : "";
    out.items.push({ text: u ? `${it} /${u}` : it, ...(c ? { tag: c } : {}), ...(p !== undefined ? { value: p } : {}), ...(ch !== undefined ? { delta: ch } : {}) });
    out.rows.push({ item: it, city: c, price: p ?? "", change: ch ?? "", unit: u });
  }
  return out;
}

export const MAPPERS: Record<MapperId, { label: string; hint: string; map(rows: GfxTableRow[], o?: MapOptions): Mapped }> = {
  ticker: { label: "Headlines", hint: "One line per row from the headline column", map: tickerMap },
  weather: { label: "Weather", hint: "City, temperature and condition (with an icon)", map: weatherMap },
  markets: { label: "Markets", hint: "Name, value, change and change %", map: marketsMap },
  score: { label: "Scores", hint: "Team, score, wickets and overs", map: scoreMap },
  election: { label: "Election", hint: "Party, won, leading and colour", map: electionMap },
  rates: { label: "Rates", hint: "Item, city, price and change", map: ratesMap },
};
export const MAPPER_IDS = Object.keys(MAPPERS) as MapperId[];

/** The mapper that suits a template, from its kind, id, name and tags (null: none in particular). */
export function suggestMapper(t: Pick<GfxTemplate, "id" | "name" | "kind" | "tags" | "role">): MapperId | null {
  const s = [t.kind, t.id, t.name, ...(t.tags ?? [])].filter(Boolean).join(" ").toLowerCase();
  if (/weather|temperature|मौसम/.test(s)) return "weather";
  if (/market|stock|sensex|nifty|share|business/.test(s)) return "markets";
  if (/score|cricket|football|kabaddi|match/.test(s)) return "score";
  if (/election|seats|tally|result/.test(s)) return "election";
  if (/rates?\b|fuel|petrol|gold|mandi|price/.test(s)) return "rates";
  if (t.role === "ticker" || /headline|crawl|flip|ticker|news/.test(s)) return "ticker";
  return null;
}
