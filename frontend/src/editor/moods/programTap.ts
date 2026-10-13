/**
 * The Program monitor's frame for the scopes: the monitor registers a reader (its preview engine's read-back) while it
 * is open; the Scopes panel and the monitor's scopes overlay read through it. Nothing is read unless someone asks.
 */
import type { RgbaFrame } from "./scopes";

type Reader = () => RgbaFrame | null;
let reader: Reader | null = null;
const subs = new Set<() => void>();

export function setProgramReader(r: Reader | null) { reader = r; subs.forEach((f) => f()); }
export const hasProgramReader = () => !!reader;
export function readProgramFrame(): RgbaFrame | null {
  try { return reader?.() ?? null; } catch { return null; }
}
export function onProgramReader(cb: () => void) { subs.add(cb); return () => { subs.delete(cb); }; }
