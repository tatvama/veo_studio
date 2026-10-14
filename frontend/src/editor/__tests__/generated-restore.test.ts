/**
 * The QA's Program-monitor repro as a unit test: "Ticker · Blue band" at 3.6 s and "Wedding · Script" at 4.0 s on
 * separate tracks, the playhead at 4.8 s, playing and scrubbing — then a GPU reset (late in a long session): every 2D
 * canvas comes back blank with a "contextrestored" event and the engine's WebGL textures are re-created. The template
 * titles are generated pictures (render/generated.ts) behind the engine's own CanvasSource (version → draw → bounds →
 * a full or sub-rect upload); a fake texture replays those uploads. Before the fix the ticker survived (it redraws every
 * frame) but the wedding title, holding still, was re-uploaded from its blank canvas and stayed gone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CanvasSource, type Frame } from "../../engine/sources/source.ts";
import { generatedPicture, type MakeCanvas } from "../render/generated.ts";
import { templateSpec, titleTemplate } from "../templates/titles.ts";

/** A canvas that knows whether anything is drawn on it (ink), and what a GPU reset does to it. */
class FakeCanvas extends EventTarget {
  width: number; height: number; ink = 0; draws = 0;
  private g: Record<string, unknown>;
  constructor(w: number, h: number) {
    super(); this.width = w; this.height = h;
    const ink = new Set(["fillText", "strokeText", "fillRect", "fill", "stroke", "strokeRect"]);
    this.g = new Proxy({} as Record<string, unknown>, {
      get: (target, k: string) => {
        if (k in target) return target[k];
        if (k === "measureText") return (s: string) => ({ width: s.length * 18 });
        if (k === "createLinearGradient") return () => ({ addColorStop() {} });
        if (k === "clearRect") return (x: number, y: number, w: number, h: number) => { if (x <= 0 && y <= 0 && x + w >= this.width && y + h >= this.height) this.ink = 0; };
        return () => { if (ink.has(k)) { this.ink++; this.draws++; } };
      },
      set: (target, k: string, v) => { target[k] = v; return true; },
    });
  }
  getContext() { return this.g; }
  reset() { this.ink = 0; this.dispatchEvent(new Event("contextrestored")); }
}
const made: FakeCanvas[] = [];
const fakeCanvas: MakeCanvas = (w, h) => { const c = new FakeCanvas(w, h); made.push(c); return c; };

/** The renderer's upload rule for one source (renderer.ts upload): a new version uploads all, or only `rect`. */
class FakeTexture {
  version = -1; ink = 0; uploads = 0; subs = 0;
  take(fr: Frame) {
    if (fr.version === this.version) return;
    const c = fr.image as unknown as FakeCanvas;
    if (fr.rect && this.version >= 0) { this.subs++; if (fr.rect[2] > 0 && fr.rect[3] > 0) this.ink = c.ink; } else this.ink = c.ink;
    this.version = fr.version;
    this.uploads++;
  }
  /** The WebGL context came back: every texture is new (renderer.ts restored). */
  lost() { this.version = -1; this.ink = 0; }
}

const W = 1920, H = 1080;
function layer(id: string, start: number, seconds: number) {
  const t = titleTemplate(id);
  assert.ok(t, id);
  const spec = templateSpec(t, H);
  const src = new CanvasSource(generatedPicture({ kind: "title", spec, width: W, height: H, duration: seconds }, fakeCanvas));
  const tex = new FakeTexture();
  return { id, start, seconds, src, tex, canvas: () => made[made.length - 1] };
}

test("the QA repro: two template titles survive a GPU reset while playing and scrubbing", () => {
  made.length = 0;
  const ticker = layer("news.ticker.blue", 3.6, 12);
  const tickerCanvas = made[made.length - 1];
  const wedding = layer("wedding.script.fade", 4.0, 4);
  const weddingCanvas = made[made.length - 1];
  const layers = [ticker, wedding];
  const frame = (t: number) => { for (const l of layers) if (t >= l.start && t < l.start + l.seconds) l.tex.take(l.src.live(t - l.start)); };
  const shown = (t: number) => layers.filter((l) => t >= l.start && t < l.start + l.seconds).map((l) => l.tex.ink > 0);
  // the playhead at 4.8 s, play 1.5 s at 25 fps, then scrub around the wedding title's hold
  frame(4.8);
  assert.deepEqual(shown(4.8), [true, true], "both titles at 4.8 s");
  for (let f = 0; f < 38; f++) frame(4.8 + f / 25);
  const weddingDraws = weddingCanvas.draws;
  for (const t of [5.1, 6.4, 4.9, 7.2, 5.5, 6.0]) { frame(t); assert.deepEqual(shown(t), [true, true], `both at ${t} s`); }
  assert.equal(weddingCanvas.draws, weddingDraws, "the wedding title holds still: not drawn again while scrubbing its hold");
  // the GPU reset: the textures go, then every 2D canvas comes back blank
  for (const l of layers) l.tex.lost();
  tickerCanvas.reset(); weddingCanvas.reset();
  for (const t of [4.8, 4.84, 4.88, 5.6, 6.2]) { frame(t); assert.deepEqual(shown(t), [true, true], `both again at ${t} s after the reset`); }
  // the reset with the textures kept (only the canvases): the redrawn part goes up as a sub-rect
  const subs = wedding.tex.subs;
  weddingCanvas.reset();
  frame(6.3);
  assert.ok(wedding.tex.subs > subs, "a sub-rect upload of the redrawn title");
  assert.deepEqual(shown(6.3), [true, true]);
});

test("generated colour matte: a new version, painted again, after its canvas came back blank", () => {
  made.length = 0;
  const src = new CanvasSource(generatedPicture({ kind: "color", color: "#0c4a6e", width: 64, height: 36 }, fakeCanvas));
  const cv = made[0], tex = new FakeTexture();
  tex.take(src.live(0)); tex.take(src.live(1));
  assert.equal(tex.uploads, 1, "a matte goes up once");
  tex.lost(); cv.reset();
  tex.take(src.live(2));
  assert.ok(tex.ink > 0, "painted again after the reset");
  assert.equal(Number(tex.uploads), 2, "and uploaded again");
});
