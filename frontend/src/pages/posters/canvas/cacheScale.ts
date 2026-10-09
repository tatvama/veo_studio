/**
 * The resolution Konva caches (filtered images, faded masks) are rendered at, as output pixels per design pixel.
 * The live canvas sets it from zoom × devicePixelRatio once zooming settles; the exporter raises it for a render and
 * puts it back. Quantised to steps of √2 so small zoom changes don't re-run filters.
 */
import { useSyncExternalStore } from "react";

let value = 1;
const subs = new Set<() => void>();

const quantize = (v: number) => Math.pow(2, Math.round(Math.log2(Math.max(0.05, v)) * 2) / 2);

export function setCacheScale(v: number, exact = false): void {
  const q = exact ? v : quantize(v);
  if (Math.abs(q - value) < 1e-6) return;
  value = q;
  subs.forEach((s) => s());
}

export function getCacheScale(): number {
  return value;
}

export function useCacheScale(): number {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => value, () => value);
}
