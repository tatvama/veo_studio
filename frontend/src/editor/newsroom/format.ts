/**
 * Numbers, clocks, dates and scripts for graphics (docs/EDITOR.md §16.2). Owner: nr-core. PLACEHOLDER signatures. Pure.
 */
import type { ChannelLook, NumberFormat, ScriptId } from "./types.ts";

/** 1234567 → "12,34,567" (Indian) / "1,234,567"; compact → "12.35 lakh" / "1.23M"; native digits for Indic looks. */
export function fmtNumber(n: number, _look: Pick<ChannelLook, "numbers">, _f: NumberFormat = {}): string { return String(n); }
/** "19:42" / "7:42 PM" in the look's zone. */
export function fmtClock(ms: number, _look: Pick<ChannelLook, "clock" | "numbers">, _seconds = false): string { return new Date(ms).toISOString().slice(11, 16); }
/** "13 Oct 2026" (dmy) / "Oct 13, 2026" (mdy) / "Tuesday, 13 October 2026" (long). */
export function fmtDate(ms: number, _look: Pick<ChannelLook, "clock">): string { return new Date(ms).toISOString().slice(0, 10); }
/** The main script of a text (for its font): the first non-Latin letter's script, else "latn". */
export function scriptOf(_s: string): ScriptId { return "latn"; }
