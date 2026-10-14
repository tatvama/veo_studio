/**
 * Numbers, clocks, dates and scripts for graphics (docs/EDITOR.md §16.2). Indian grouping (12,34,567), lakh / crore
 * and K / M / B compact forms, signs and the look's currency; native digits for Indic looks; clocks and dates in the
 * look's zone. Zone maths uses Intl, but the words (month and day names, AM / PM) are our own, so the same edit draws
 * the same text on every machine and ICU version. Pure.
 */
import type { ChannelLook, NumberFormat, ScriptId } from "./types.ts";

// ── scripts ──────────────────────────────────────────────────────────────────

/** Unicode blocks of the Indic scripts a look can have a font for. */
const BLOCKS: [number, number, ScriptId][] = [
  [0x0900, 0x097f, "deva"], [0xa8e0, 0xa8ff, "deva"], [0x0980, 0x09ff, "beng"], [0x0a00, 0x0a7f, "guru"],
  [0x0a80, 0x0aff, "gujr"], [0x0b00, 0x0b7f, "orya"], [0x0b80, 0x0bff, "taml"], [0x0c00, 0x0c7f, "telu"],
  [0x0c80, 0x0cff, "knda"], [0x0d00, 0x0d7f, "mlym"],
];
/** The script of one code point, or null for Latin, digits, punctuation and the rest. */
export function scriptOfChar(cp: number): ScriptId | null {
  if (cp < 0x0900 || cp > 0xa8ff) return null;
  for (const [a, b, s] of BLOCKS) if (cp >= a && cp <= b) return s;
  return null;
}
/** The main script of a text (for its font): the first non-Latin letter's script, else "latn". */
export function scriptOf(s: string): ScriptId {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x0900) continue;
    const sc = scriptOfChar(c);
    if (sc) return sc;
  }
  return "latn";
}

/** Zero of each script's digits. */
const ZERO: Partial<Record<ScriptId, number>> = {
  deva: 0x0966, beng: 0x09e6, guru: 0x0a66, gujr: 0x0ae6, orya: 0x0b66, taml: 0x0be6, telu: 0x0c66, knda: 0x0ce6, mlym: 0x0d66,
};
/** "2026" → "२०२६" (deva) …; Latin text unchanged. */
export function nativeDigits(s: string, script: ScriptId): string {
  const z = ZERO[script];
  return z ? s.replace(/[0-9]/g, (d) => String.fromCharCode(z + d.charCodeAt(0) - 48)) : s;
}
type LookNums = Pick<ChannelLook, "numbers"> & Partial<Pick<ChannelLook, "fonts">>;
/** Which digits a look writes: its first Indic script when native digits are on (default Devanagari), else Latin. */
export function digitScript(look: LookNums, script?: ScriptId): ScriptId {
  if (look.numbers.digits !== "native") return "latn";
  if (script && script !== "latn") return script;
  const first = Object.keys(look.fonts?.scripts ?? {}).find((k) => k !== "latn") as ScriptId | undefined;
  return first ?? "deva";
}

// ── numbers ──────────────────────────────────────────────────────────────────

/** Groups an integer string: Indian 12,34,567 or international 1,234,567. */
export function groupDigits(int: string, system: "indian" | "international"): string {
  if (int.length <= 3) return int;
  if (system === "international") return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const last = int.slice(-3), rest = int.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last}`;
}

/** A non-negative number with `dec` decimals (fixed) or up to `max` (trailing zeros dropped), grouped. */
function plain(n: number, system: "indian" | "international", dec: number | undefined, max = 2): string {
  const s = dec !== undefined ? n.toFixed(dec) : String(Number(n.toFixed(max)));
  const [i, d] = (s.includes("e") ? n.toFixed(max) : s).split(".");
  return groupDigits(i, system) + (d ? `.${d}` : "");
}

const INDIAN_UNITS: [number, string][] = [[1e12, " lakh crore"], [1e7, " crore"], [1e5, " lakh"]];
const INTL_UNITS: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];

/**
 * 1234567 → "12,34,567" (Indian) / "1,234,567"; compact → "12.35 lakh" / "1.23M"; `sign` adds "+"; `currency` the
 * look's sign ("₹"); native digits for Indic looks (`script` picks which, default the look's first Indic script).
 */
export function fmtNumber(n: number, look: LookNums, f: NumberFormat = {}, script?: ScriptId): string {
  if (!Number.isFinite(n)) return "–";
  const sys = look.numbers.system;
  const neg = n < 0, a = Math.abs(n);
  let body: string;
  if (f.compact) {
    const units = sys === "indian" ? INDIAN_UNITS : INTL_UNITS;
    const u = units.find(([v]) => a >= v);
    if (u) {
      const x = a / u[0];
      body = plain(x, sys, f.decimals, x >= 100 ? 0 : 2) + u[1];
    } else body = plain(a, sys, f.decimals);
  } else body = plain(a, sys, f.decimals);
  const sign = neg && Number(body.replace(/[^0-9.]/g, "")) !== 0 ? "-" : f.sign && a > 0 ? "+" : "";
  const out = `${sign}${f.prefix ?? ""}${f.currency ? look.numbers.currency : ""}${body}${f.suffix ?? ""}`;
  const ds = digitScript(look, script);
  return ds === "latn" ? out : nativeDigits(out, ds);
}

// ── clocks and dates ─────────────────────────────────────────────────────────

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }

const partsFmt = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** Calendar parts of an instant in a zone (month 1..12, weekday 0 = Sunday). An unknown zone falls back to UTC. */
export function zonedParts(ms: number, zone: string): ZonedParts {
  let fmt = partsFmt.get(zone);
  if (!fmt) {
    const o: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short", hourCycle: "h23" };
    try { fmt = new Intl.DateTimeFormat("en-US", { ...o, timeZone: zone }); } catch { fmt = new Intl.DateTimeFormat("en-US", { ...o, timeZone: "UTC" }); }
    partsFmt.set(zone, fmt);
  }
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second, weekday: WEEKDAY[p.weekday] ?? 0 };
}

const pad = (n: number) => String(n).padStart(2, "0");
type LookClock = Pick<ChannelLook, "clock" | "numbers"> & Partial<Pick<ChannelLook, "fonts">>;

/** "19:42" / "7:42 PM" in the look's zone (with seconds when asked). */
export function fmtClock(ms: number, look: LookClock, seconds = false): string {
  const z = zonedParts(ms, look.clock.zone);
  const s = seconds ? `:${pad(z.second)}` : "";
  const out = look.clock.hours === 12 ? `${z.hour % 12 || 12}:${pad(z.minute)}${s} ${z.hour < 12 ? "AM" : "PM"}` : `${pad(z.hour)}:${pad(z.minute)}${s}`;
  const ds = digitScript(look);
  return ds === "latn" ? out : nativeDigits(out, ds);
}

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "13 Oct 2026" (dmy) / "Oct 13, 2026" (mdy) / "Tuesday, 13 October 2026" (long), in the look's zone. */
export function fmtDate(ms: number, look: Pick<ChannelLook, "clock"> & Partial<Pick<ChannelLook, "numbers" | "fonts">>): string {
  const z = zonedParts(ms, look.clock.zone);
  const mon = MONTHS[z.month - 1] ?? "";
  const out = look.clock.date === "mdy" ? `${mon.slice(0, 3)} ${z.day}, ${z.year}`
    : look.clock.date === "long" ? `${DAYS[z.weekday]}, ${z.day} ${mon} ${z.year}`
    : `${z.day} ${mon.slice(0, 3)} ${z.year}`;
  const ds = look.numbers ? digitScript(look as LookNums) : "latn";
  return ds === "latn" ? out : nativeDigits(out, ds);
}

/**
 * Epoch ms of a local date-time ("2026-01-01T19:00") in a zone: what the air time means. Deterministic (no machine
 * zone): finds the zone's offset at that moment with Intl.
 */
export function zonedTimeToMs(local: string, zone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(local);
  if (!m) { const t = Date.parse(local); return Number.isFinite(t) ? t : 0; }
  const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)];
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off = (ms: number) => { const z = zonedParts(ms, zone); return Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second) - ms; };
  let t = guess - off(guess);
  t = guess - off(t);  // twice: right across a DST change
  return t;
}
