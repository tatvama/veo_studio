/**
 * Canvas2D pictures don't survive a GPU reset: a driver reset, or the GPU process restarting (e.g. out of graphics
 * memory late in a long session). The browser brings every accelerated 2D canvas back BLANK and fires
 * "contextrestored" on it (detached and Offscreen canvases too). A source that keeps a drawn canvas and redraws it only
 * when its picture changes (a title between its animations, a colour matte, a generated picture) would then hand the
 * engine a transparent canvas for as long as it holds still: the title is gone from the monitor and the export.
 *
 * `watchCanvas` counts a canvas's restores: sources put the count in their cache key and version, so they draw again
 * and the engine uploads the new picture. `onCanvasRestored` tells the monitors to redraw (nothing else would while
 * paused); the WebGL backend reports its own context coming back through `notifyCanvasRestored` too. Pure apart from
 * the event listeners and a timer.
 */
type Listener = () => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setTimeout> | null = null;
let restores = 0;

/** How many restores this page has seen (a watched canvas or a GPU context coming back). */
export const canvasRestores = () => restores;

/** Calls `cb` once, shortly after a watched canvas or a GPU context came back (draw again). Returns the unsubscribe. */
export function onCanvasRestored(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** A canvas or a GPU context came back: the listeners run once after the burst (every canvas fires its own event). */
export function notifyCanvasRestored(): void {
  restores++;
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    for (const f of [...listeners]) { try { f(); } catch { /* a listener's problem */ } }
  }, 16);
}

/**
 * Watches a canvas (HTMLCanvasElement or OffscreenCanvas): the returned getter counts the times it came back blank
 * (0 while it never did). `onRestored` runs first on each restore (repaint something drawn once, e.g. a matte).
 */
export function watchCanvas(c: unknown, onRestored?: () => void): () => number {
  let n = 0;
  const target = c as { addEventListener?: (type: string, fn: () => void) => void } | null;
  if (target && typeof target.addEventListener === "function") {
    target.addEventListener("contextrestored", () => {
      n++;
      try { onRestored?.(); } catch { /* the next draw repaints */ }
      notifyCanvasRestored();
    });
  }
  return () => n;
}
