/**
 * The Program monitor's frame for the scopes: the monitor registers a reader (its preview engine's read-back) and,
 * when the engine has GPU scopes, a scope reader (a scope drawn from the frame on the GPU, no frame read-back) while
 * it is open; the Scopes panel and the monitor's scopes overlay read through them. Nothing is read unless someone asks.
 */
import type { RgbaFrame, ScopeKind } from "./scopes";

type Reader = () => RgbaFrame | null;
type ScopeReader = (kind: ScopeKind) => Promise<ImageBitmap | null>;
let reader: Reader | null = null;
let scopeReader: ScopeReader | null = null;
const subs = new Set<() => void>();

export function setProgramReader(r: Reader | null) { reader = r; subs.forEach((f) => f()); }
/** The GPU scope reader (null: the panel computes scopes itself from readProgramFrame()). */
export function setProgramScopes(r: ScopeReader | null) { scopeReader = r; }
export const hasProgramReader = () => !!reader;
export const hasProgramScopes = () => !!scopeReader;
export function readProgramFrame(): RgbaFrame | null {
  try { return reader?.() ?? null; } catch { return null; }
}
/** A scope of the program frame drawn on the GPU, or null when the monitor has none (then read the frame). */
export async function readProgramScope(kind: ScopeKind): Promise<ImageBitmap | null> {
  if (!scopeReader) return null;
  try { return await scopeReader(kind); } catch { return null; }
}
export function onProgramReader(cb: () => void) { subs.add(cb); return () => { subs.delete(cb); }; }
