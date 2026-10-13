/**
 * A GPU reset brings every 2D canvas back blank with a "contextrestored" event (sources/canvasLoss.ts). The engine's
 * own titles and colour mattes cache what they drew; they must draw again (and say so with a new version) or the
 * renderer re-uploads a transparent canvas for as long as the title holds still. Fake canvases (EventTargets that count
 * what was drawn) stand in for the browser's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { canvasRestores, notifyCanvasRestored, onCanvasRestored, watchCanvas } from "../sources/canvasLoss.ts";
import { MatteSource, TitleSource } from "../sources/title.ts";
import type { TitleSpec } from "../types.ts";

/** A 2D context that accepts any call and counts the ones that put ink on the canvas. */
function fakeContext(c: FakeCanvas) {
  const ink = new Set(["fillText", "strokeText", "fillRect", "fill", "stroke", "strokeRect", "drawImage"]);
  return new Proxy({} as Record<string, unknown>, {
    get(target, k: string) {
      if (k in target) return target[k];
      if (k === "measureText") return (s: string) => ({ width: s.length * 10 });
      if (k === "createLinearGradient") return () => ({ addColorStop() {} });
      if (k === "clearRect") return (x: number, y: number, w: number, h: number) => { if (x <= 0 && y <= 0 && x + w >= c.width && y + h >= c.height) c.ink = 0; };
      return (..._a: unknown[]) => { if (ink.has(k)) { c.ink++; c.draws++; } };
    },
    set(target, k: string, v) { target[k] = v; return true; },
  });
}
class FakeCanvas extends EventTarget {
  width: number; height: number; ink = 0; draws = 0;
  private g = fakeContext(this);
  constructor(w: number, h: number) { super(); this.width = w; this.height = h; }
  getContext() { return this.g; }
  /** What a GPU reset does to it: blank, then the event. */
  reset() { this.ink = 0; this.dispatchEvent(new Event("contextrestored")); }
}
(globalThis as Record<string, unknown>).OffscreenCanvas = FakeCanvas;

const spec: TitleSpec = { text: "Holding still", font: "Inter Variable", size: 60, color: "#ffffff", weight: 700, align: "center", box: [0.1, 0.4, 0.8, 0.2], animIn: "fade", animOut: "fade" };
const tick = () => new Promise((r) => setTimeout(r, 40));

test("watchCanvas: counts a canvas's restores and tells the listeners once per burst", async () => {
  const a = new FakeCanvas(8, 8), b = new FakeCanvas(8, 8);
  let repainted = 0, heard = 0, heardOff = 0;
  const na = watchCanvas(a, () => { repainted++; }), nb = watchCanvas(b);
  const off = onCanvasRestored(() => { heard++; });
  const off2 = onCanvasRestored(() => { heardOff++; });
  off2();
  const r0 = canvasRestores();
  a.reset(); b.reset(); b.reset();
  assert.deepEqual([na(), nb(), repainted], [1, 2, 1]);
  assert.equal(canvasRestores() - r0, 3);
  await tick();
  assert.equal(heard, 1, "one redraw for the burst");
  assert.equal(heardOff, 0, "an unsubscribed listener is not called");
  notifyCanvasRestored(); // the WebGL backend's own restore
  await tick();
  assert.equal(heard, 2);
  off();
  // something that is not an EventTarget is simply never restored
  assert.equal(watchCanvas({})(), 0);
});

test("TitleSource: a still title is drawn once, and again (a new version) after its canvas came back blank", () => {
  const s = new TitleSource(spec, 4);
  s.size(320, 180, 180 / 1080);
  const f1 = s.live(1.2)!;
  const cv = f1.image as unknown as FakeCanvas;
  const inked = cv.ink, draws = cv.draws;
  assert.ok(inked > 0, "the title drew");
  for (const t of [1.5, 2, 2.5, 3]) assert.equal(s.live(t)!.version, f1.version, `no new version while it holds still (t ${t})`);
  assert.equal(cv.draws, draws, "and no redraw");
  cv.reset();
  const f2 = s.live(3.1)!;
  assert.notEqual(f2.version, f1.version, "a new version: the engine uploads it");
  assert.ok(cv.ink > 0, "drawn again after the restore");
  assert.equal(s.live(3.2)!.version, f2.version, "then still again");
});

test("MatteSource: painted again with a new version after a restore", () => {
  const m = new MatteSource("#2255cc");
  const f1 = m.live();
  const cv = f1.image as unknown as FakeCanvas;
  assert.ok(cv.ink > 0);
  assert.equal(m.live().version, f1.version);
  cv.reset();
  assert.equal(cv.ink > 0, true, "repainted");
  assert.equal(m.live().version, f1.version + 1);
});
