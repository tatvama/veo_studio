/**
 * What a preview card's canvas shows (preview-polish), outside React so a pointer move never re-renders: the still,
 * and on hover the item's strips — moving across the card scrubs it (a transition's progress, a title's in → hold →
 * out, an effect's or a look's intensity), holding still plays its loop at 15 fps. Every hover frame is one
 * drawImage of a frame rendered earlier in idle time (≤ 0.5 ms); when the draws run slow the strips drop to half
 * size, then to the still. "Reduce motion" keeps scrubbing (the pointer drives it) but never plays loops.
 */
import { watchCanvas } from "../../engine/sources/canvasLoss";
import { reducedMotion } from "./live";
import { requestStill, requestStrip, stillBackoff, stillKey, stillTime, type FrameChoice, type PreviewItem, type Strip } from "./service";
import { loopIndex, scrubProgress, stripIndex, titleTimeAt, titleTiming, LOOP_FPS } from "./scrub";

export type CardState = "loading" | "ok" | "none";

/** Card draw times (ms), the last 200, for QA. */
export const cardStats = { draw: [] as number[], halved: 0, stillsOnly: 0 };

/** Draws a picture into a 16:9 canvas: as is, or a portrait / square one centred over a dimmed, blurred copy. */
export function drawFit(cv: HTMLCanvasElement, bmp: CanvasImageSource & { width: number; height: number }) {
  const g = cv.getContext("2d");
  if (!g) return;
  const W = cv.width, H = cv.height, ar = bmp.width / Math.max(1, bmp.height), car = W / Math.max(1, H);
  try {
    if (Math.abs(ar - car) < 0.03) { g.drawImage(bmp, 0, 0, W, H); return; }
    g.save();
    g.filter = "blur(8px) brightness(0.32) saturate(1.2)";
    const k = Math.max(W / bmp.width, H / bmp.height) * 1.15;
    g.drawImage(bmp, (W - bmp.width * k) / 2, (H - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    g.restore();
    const s = Math.min(W / bmp.width, H / bmp.height) * 0.94;
    const w = bmp.width * s, h = bmp.height * s;
    g.shadowColor = "rgba(0,0,0,0.6)"; g.shadowBlur = 10;
    g.drawImage(bmp, (W - w) / 2, (H - h) / 2, w, h);
    g.shadowBlur = 0;
  } catch { /* a closed bitmap */ }
}

export class CardPlayer {
  private cv: HTMLCanvasElement;
  private hud: HTMLElement | null;
  private item: PreviewItem | null = null;
  private choice: FrameChoice = { mode: "samples" };
  private size = { w: 0, h: 0 };
  private visible = false;
  private still: ImageBitmap | null = null;
  private stillKey = "";
  private hovering = false;
  private scrub: Strip | null = null;
  private loop: Strip | null = null;
  private offs: (() => void)[] = [];
  private p: number | null = null;
  private lastMove = 0;
  private raf = 0;
  private loopStart = 0;
  private lastDrawn: unknown = null;
  private slowDraws = 0;
  private stripScale = 1;
  private loopsOff = false;
  private gen = 0;
  private retryTimer = 0;
  private shown = false;
  /** The still's priority (a popover's is the one being looked at). */
  priority = 10;
  onState: (s: CardState) => void;

  constructor(cv: HTMLCanvasElement, onState: (s: CardState) => void, hud: HTMLElement | null = null) {
    this.cv = cv; this.onState = onState; this.hud = hud;
    // a GPU reset brings the card's canvas back blank (engine/sources/canvasLoss.ts): its still again
    watchCanvas(cv, () => { this.lastDrawn = null; this.still = null; this.stillKey = ""; this.loadStill(); });
  }

  /** What to show and at which size (device pixels, 16:9). */
  configure(item: PreviewItem, choice: FrameChoice, size: { w: number; h: number }) {
    const changed = item !== this.item || choice !== this.choice || size.w !== this.size.w || size.h !== this.size.h;
    this.item = item; this.choice = choice; this.size = size;
    if (!changed) return;
    if (this.cv.width !== size.w || this.cv.height !== size.h) { this.cv.width = size.w; this.cv.height = size.h; this.lastDrawn = null; if (this.still) this.paint(this.still); }
    this.stillKey = "";
    if (this.hovering) { this.dropStrips(); this.takeStrips(); }
    this.loadStill();
  }

  setVisible(v: boolean) { if (v === this.visible) return; this.visible = v; if (v) this.loadStill(); }

  private loadStill() {
    const it = this.item;
    if (!it || !this.visible || !(this.size.w > 0)) return;
    const key = `${it.kind}|${it.id}|${this.size.w}|${(this.choice as { frame?: { mediaId: string; t: number } }).frame?.mediaId ?? ""}`;
    const my = ++this.gen;
    window.clearTimeout(this.retryTimer);
    if (!this.still) this.onState("loading");
    const choice = this.choice, size = this.size;
    const wanted = () => this.visible && my === this.gen;
    const show = (b: ImageBitmap) => {
      this.still = b; this.stillKey = key;
      this.onState("ok");
      if (!this.hovering || this.p === null) this.paint(b);
    };
    void requestStill(it, choice, size, { priority: this.priority, wanted }).then((b) => {
      if (my !== this.gen) return;
      const wait = stillBackoff(stillKey(it, choice, size));
      if (b) {
        show(b);
        // drawn with warnings: shown, and drawn again after the backoff (it isn't cached)
        if (wait > 0) this.retryTimer = window.setTimeout(() => { if (my === this.gen && this.visible) this.loadStill(); }, wait);
        return;
      }
      if (!this.visible) { this.onState(this.still ? "ok" : "loading"); return; }
      // failed: the item's sample meanwhile (when it was the user's clip), and the real one again after a backoff
      if (choice.mode === "clip") void requestStill(it, { mode: "samples" }, size, { priority: 9, wanted }).then((s) => { if (my === this.gen && s && !this.still) show(s); });
      else if (!this.still) this.onState("none");
      if (wait > 0) this.retryTimer = window.setTimeout(() => { if (my === this.gen && this.visible) this.loadStill(); }, wait);
    });
  }

  private paint(b: ImageBitmap) {
    if (b === this.lastDrawn) return;
    const t0 = performance.now();
    drawFit(this.cv, b);
    const ms = performance.now() - t0;
    this.lastDrawn = b;
    // a strip frame can land before the still: the skeleton goes once there is a picture
    if (!this.shown) { this.shown = true; this.onState("ok"); }
    if (!this.hovering) return;
    cardStats.draw.push(ms);
    if (cardStats.draw.length > 200) cardStats.draw.shift();
    // over budget: half-size strips, then stills only
    this.slowDraws = ms > 0.5 ? this.slowDraws + 1 : Math.max(0, this.slowDraws - 1);
    if (this.slowDraws >= 6) {
      this.slowDraws = 0;
      if (this.stripScale === 1) { this.stripScale = 0.5; cardStats.halved++; this.dropStrips(); this.takeStrips(); }
      else if (!this.loopsOff) { this.loopsOff = true; cardStats.stillsOnly++; }
    }
  }

  private stripSize() {
    if (this.stripScale === 1) return this.size;
    return { w: Math.max(32, Math.round((this.size.w * this.stripScale) / 2) * 2), h: Math.max(18, Math.round((this.size.h * this.stripScale) / 2) * 2) };
  }

  private takeStrips() {
    const it = this.item;
    if (!it || !(this.size.w > 0)) return;
    const sz = this.stripSize();
    this.scrub = requestStrip(it, this.choice, sz, "scrub");
    this.scrub.users++;
    this.offs.push(this.scrub.onChange(() => this.frame()));
    if (it.kind === "chain" && !reducedMotion()) {
      this.loop = requestStrip(it, this.choice, sz, "loop");
      this.loop.users++;
      this.offs.push(this.loop.onChange(() => this.frame()));
    } else this.loop = this.scrub;
  }
  private dropStrips() {
    this.offs.forEach((f) => f()); this.offs = [];
    if (this.scrub) this.scrub.users--;
    if (this.loop && this.loop !== this.scrub) this.loop.users--;
    this.scrub = this.loop = null;
  }

  enter() {
    if (this.hovering) return;
    this.hovering = true;
    this.p = null; this.lastMove = performance.now(); this.loopStart = performance.now();
    this.takeStrips();
    this.run();
  }

  /** The pointer at clientX over a card spanning [left, left + width]. */
  move(clientX: number, left: number, width: number) {
    if (!this.hovering) this.enter();
    this.p = scrubProgress(clientX, left, width);
    this.lastMove = performance.now();
    this.frame();
  }

  leave() {
    if (!this.hovering) return;
    this.hovering = false;
    this.p = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.dropStrips();
    if (this.hud) this.hud.textContent = "";
    if (this.still) this.paint(this.still);
  }

  private holding() { return performance.now() - this.lastMove > 350; }

  /** Draws the frame for the pointer (scrubbing) or the loop (held still). */
  private frame() {
    if (!this.hovering || !this.item || !this.scrub) return;
    const it = this.item;
    const loopOk = !reducedMotion() && !this.loopsOff;
    if (this.p !== null && (!this.holding() || !loopOk)) {
      const st = this.scrub;
      let i: number, label: string;
      if (it.kind === "title" || it.kind === "sequence") {
        const dur = it.kind === "title" ? it.seconds : it.tpl.seconds;
        const tm = it.kind === "title" ? titleTiming(it.spec, dur) : { inEnd: dur * 0.25, outStart: dur * 0.8 };
        const t = titleTimeAt(this.p, dur, tm.inEnd, tm.outStart);
        i = stripIndex(t / Math.max(0.001, dur), st.n);
        label = `${t < tm.inEnd - 1e-3 ? "In" : t > tm.outStart + 1e-3 ? "Out" : "Hold"} · ${t.toFixed(1)} s`;
      } else {
        i = stripIndex(this.p, st.n);
        label = it.kind === "transition" ? `${Math.round(st.values[i] * 100)} %` : `Intensity ${Math.round(st.values[i] * 100)} %`;
      }
      if (this.hud) this.hud.textContent = label;
      const b = st.at(i);
      if (b) this.paint(b);
      this.loopStart = performance.now();
      return;
    }
    if (!loopOk) { if (this.still) this.paint(this.still); return; }
    if (this.hud && this.hud.textContent) this.hud.textContent = "";
    const st = this.loop ?? this.scrub;
    const i = loopIndex(performance.now() - this.loopStart, st.n, st.mode, st.hold, LOOP_FPS);
    const b = st.frames[i] ?? (st.ready ? st.at(i) : null);
    if (b) this.paint(b); else if (this.still) this.paint(this.still);
  }

  private run() {
    const tick = () => {
      if (!this.hovering) return;
      this.raf = requestAnimationFrame(tick);
      if (this.holding()) this.frame();
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** The still's time for an item (titles: their hold pose). */
  static stillTime = stillTime;

  dispose() { this.leave(); this.gen++; this.visible = false; window.clearTimeout(this.retryTimer); }
}
