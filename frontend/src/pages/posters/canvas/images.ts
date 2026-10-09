/**
 * One HTMLImageElement per src, shared by the live canvas, previews and the exporter. Components subscribe with
 * `useImage(src)`; the exporter awaits `loadImage(src)` so nothing is drawn before its pixels are there.
 */
import { useSyncExternalStore } from "react";

type Status = "loading" | "loaded" | "error";
interface Entry {
  img: HTMLImageElement;
  status: Status;
  promise: Promise<HTMLImageElement | null>;
  subs: Set<() => void>;
}

const cache = new Map<string, Entry>();

function needsCors(src: string): boolean {
  if (src.startsWith("data:") || src.startsWith("blob:") || src.startsWith("/")) return false;
  try {
    return new URL(src, window.location.href).origin !== window.location.origin;
  } catch {
    return false;
  }
}

function entry(src: string): Entry {
  let e = cache.get(src);
  if (e) return e;
  const img = new Image();
  if (needsCors(src)) img.crossOrigin = "anonymous";
  img.decoding = "async";
  const subs = new Set<() => void>();
  let resolve!: (v: HTMLImageElement | null) => void;
  const promise = new Promise<HTMLImageElement | null>((r) => { resolve = r; });
  const made: Entry = { img, status: "loading", promise, subs };
  img.onload = () => { made.status = "loaded"; resolve(img); subs.forEach((s) => s()); };
  img.onerror = () => { made.status = "error"; resolve(null); subs.forEach((s) => s()); };
  img.src = src;
  cache.set(src, made);
  return made;
}

/** Resolves with the decoded image (or null when it failed to load). */
export function loadImage(src: string): Promise<HTMLImageElement | null> {
  if (!src) return Promise.resolve(null);
  return entry(src).promise;
}

/** The loaded image for `src`, or undefined while it loads (or when it failed). */
export function useImage(src: string | undefined | null): HTMLImageElement | undefined {
  return useSyncExternalStore(
    (cb) => {
      if (!src) return () => {};
      const e = entry(src);
      e.subs.add(cb);
      return () => { e.subs.delete(cb); };
    },
    () => {
      if (!src) return undefined;
      const e = entry(src);
      return e.status === "loaded" ? e.img : undefined;
    },
    () => undefined,
  );
}

export function imageFailed(src: string): boolean {
  return cache.get(src)?.status === "error";
}

/** Resolves on the next animation frame, or shortly after when frames are paused (a hidden tab). */
export const nextFrame = () => new Promise<void>((r) => {
  let done = false;
  const go = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(go);
  setTimeout(go, 120);
});
