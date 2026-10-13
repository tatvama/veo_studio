/**
 * LUTs registered at runtime as look ids (matchColor's generated LUTs, a LUT browser's previews): any engine's "look"
 * effect or fx.look with that id uses it, without Composition.lutUrls. Pure module state.
 */
import type { Lut3D } from "./cube.ts";

const luts = new Map<string, Lut3D>();
let version = 0;

/** Adds (or replaces) a LUT under a look id ("match:…", "lut:…"). */
export function registerLut(id: string, lut: Lut3D): void {
  if (!id || typeof id !== "string") throw new Error("A LUT needs an id");
  if (!(lut?.size >= 2) || lut.data?.length !== lut.size ** 3 * 3) throw new Error(`LUT "${id}" isn't a ${lut?.size}³ table`);
  luts.set(id, lut);
  version++;
}
export const unregisterLut = (id: string): boolean => { version++; return luts.delete(id); };
export const registeredLut = (id: string): Lut3D | undefined => luts.get(id);
export const registeredLuts = (): string[] => [...luts.keys()];
export const lutsVersion = () => version;
