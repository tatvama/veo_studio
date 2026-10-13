/**
 * The thumbnail and preview service (preview-polish): what a card asks for — a still of an item on the chosen frame
 * (the user's clip, or the item's sample) at a size, or a strip of frames for its hover animation — answered from
 * memory, then IndexedDB, else rendered on the shared engine in idle time (scheduler.ts: a few per idle callback,
 * the hovered card first, cards that scrolled away dropped).
 *
 * Items:
 *   chain       moods, look packs, LUTs and video effects: `effects(k)` at an intensity k (0 = none … kMax)
 *   transition  a transition id between two pictures, at a progress
 *   title       a title spec (1080 lines) over a darkened frame, at a time (still: its hold pose)
 *   sequence    a template sequence, its media slots filled with the frame (then samples)
 */
import type { SeqTemplate } from "../templates/sequences";
import type { TitleSpec } from "../model/types";
import { diskGet, diskPut, memory } from "./cache";
import { sourceKey, thumbKey, versionOf, type FrameSourceRef } from "./keys";
import { lastRenderWarnings, renderChain, renderSequence, renderTitle, renderTransition, type ChainFx } from "./render";
import { samplePair, sampleFor, SAMPLE_IDS, type SampleId } from "./samples";
import { browserIdleEnv, IdleScheduler } from "./scheduler";
import { stripTimes, titleTiming, LOOP_FPS } from "./scrub";
import { frameSource, sampleSource, type Src } from "./sources";

/** True when a render came back (nearly) all black: a source that was not drawn. Never cached. */
export function blankBitmap(b: ImageBitmap): boolean {
  try {
    if (typeof OffscreenCanvas === "undefined") return false;
    const c = new OffscreenCanvas(16, 9), g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(b, 0, 0, 16, 9);
    const d = g.getImageData(0, 0, 16, 9).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 5 || d[i + 1] > 5 || d[i + 2] > 5) return false;
    return true;
  } catch { return false; }
}

/** Failed stills by key: how many times, and when (the next try waits 1 s, 3 s, 9 s, at most 30 s). */
const failures = new Map<string, { n: number; at: number }>();
export const stillBackoff = (key: string): number => { const f = failures.get(key); return f ? Math.min(30000, 1000 * Math.pow(3, f.n - 1)) : 0; };
export const stillFailures = (key: string): number => failures.get(key)?.n ?? 0;

export type PreviewItem =
  | { kind: "chain"; id: string; text?: string; effects: (k: number) => ChainFx[]; /** the card's still (default 1) */ k?: number; /** the scrub's top (default 1) */ kMax?: number }
  | { kind: "transition"; id: string; params?: Record<string, unknown> }
  | { kind: "title"; id: string; text?: string; spec: TitleSpec; seconds: number }
  | { kind: "sequence"; id: string; text?: string; tpl: SeqTemplate; fields?: Record<string, string>; aspect: number };

/** The user's frame the previews show (moods/engineLooks.grabFrame's canvas), and for transitions the next clip's. */
export interface UserFrame { mediaId: string; t: number; canvas: HTMLCanvasElement; name: string; seqH: number; next?: { mediaId: string; t: number; canvas: HTMLCanvasElement } | null }
export type FrameChoice = { mode: "samples" } | { mode: "clip"; frame: UserFrame };

export const scheduler = new IdleScheduler(browserIdleEnv());

// ── what an item is drawn from ──────────────────────────────────────────────────────────────────────────

const clipRef = (f: { mediaId: string; t: number }): FrameSourceRef => ({ kind: "clip", mediaId: f.mediaId, t: f.t });

/** The frame source(s) of an item under a choice (for its cache key). */
export function sourceOf(item: PreviewItem, choice: FrameChoice): FrameSourceRef {
  const user = choice.mode === "clip" ? choice.frame : null;
  if (item.kind === "transition") {
    const [a, b] = samplePair(item.id);
    if (!user) return { kind: "pair", a: { kind: "sample", id: a }, b: { kind: "sample", id: b } };
    return { kind: "pair", a: clipRef(user), b: user.next ? clipRef(user.next) : { kind: "sample", id: b } };
  }
  if (user) return clipRef(user);
  return { kind: "sample", id: sampleFor(item.id, item.text ?? "") };
}

async function srcFor(ref: FrameSourceRef, choice: FrameChoice, w: number, h: number): Promise<Src | null> {
  if (ref.kind === "sample") return sampleSource(ref.id as SampleId, w, h);
  if (ref.kind === "clip" && choice.mode === "clip") {
    const f = choice.frame;
    const pic = f.mediaId === ref.mediaId && f.t === ref.t ? f.canvas : f.next && f.next.mediaId === ref.mediaId ? f.next.canvas : null;
    return pic ? frameSource(pic, sourceKey(ref), w, h) : null;
  }
  return null;
}

/** The height the user's frame's pixel-sized effects are for. */
const refHeight = (choice: FrameChoice) => (choice.mode === "clip" ? choice.frame.seqH || 1080 : 1080);

const versions = new WeakMap<PreviewItem, string>();
/** An item's version (what draws it). */
export function itemVersion(item: PreviewItem): string {
  let v = versions.get(item);
  if (v === undefined) { v = computeVersion(item); versions.set(item, v); }
  return v;
}
function computeVersion(item: PreviewItem): string {
  switch (item.kind) {
    case "chain": return versionOf({ fx: item.effects(item.k ?? 1), k: item.kMax ?? 1 });
    case "transition": return versionOf({ p: item.params ?? null });
    case "title": return versionOf({ s: item.spec, d: item.seconds });
    case "sequence": return versionOf({ f: item.fields ?? null, a: item.aspect, s: item.tpl.seconds, l: item.tpl.layers(item.tpl.fields.reduce((o, x) => ({ ...o, [x.key]: item.fields?.[x.key] ?? x.value }), {} as Record<string, string>), 1920, 1080) });
  }
}

/** The render size of an item's picture: the card's (16:9), or a portrait / square template at the card's height. */
export function renderSize(item: PreviewItem, card: { w: number; h: number }): { w: number; h: number } {
  if (item.kind !== "sequence" || Math.abs(item.aspect - 16 / 9) < 0.02) return card;
  const h = card.h, w = Math.max(2, Math.round((h * item.aspect) / 2) * 2);
  return { w, h };
}

/** The time of a title's or a template's still (its hold pose). */
export function stillTime(item: PreviewItem): number {
  if (item.kind === "title") return titleTiming(item.spec, item.seconds).hold;
  if (item.kind === "sequence") return item.tpl.seconds * 0.6;
  return 0;
}

/** Renders one frame of an item: `p` is the progress (transitions), the time (titles, templates, chain loops), or
 *  the intensity (chain scrubs, with `k`). */
async function renderFrame(item: PreviewItem, choice: FrameChoice, w: number, h: number, at: { t?: number; k?: number; progress?: number }): Promise<ImageBitmap | null> {
  const ref = sourceOf(item, choice);
  if (item.kind === "transition") {
    if (ref.kind !== "pair") return null;
    const [a, b] = await Promise.all([srcFor(ref.a, choice, w, h), srcFor(ref.b, choice, w, h)]);
    if (!a || !b) return null;
    return renderTransition(a, b, item.id, at.progress ?? 0.5, w, h, item.params);
  }
  if (item.kind === "chain") {
    const src = await srcFor(ref, choice, w, h);
    if (!src) return null;
    return renderChain(src, item.effects(at.k ?? item.k ?? 1), at.t ?? 0, w, h, refHeight(choice));
  }
  if (item.kind === "title") {
    const src = await srcFor(ref, choice, w, h);
    return renderTitle(src, item.spec, item.seconds, at.t ?? stillTime(item), w, h, `${item.id}:${itemVersion(item)}`);
  }
  // a template: the first slot shows the frame (the user's clip, or the item's sample), the others other samples
  const first = ref;
  const others = SAMPLE_IDS.filter((s) => !(first.kind === "sample" && first.id === s));
  return renderSequence(item.tpl, item.fields, (i) => (i === 0 ? srcFor(first, choice, w, h) : sampleSource(others[(i - 1 + (item.id.length % others.length)) % others.length], w, h)), at.t ?? stillTime(item), w, h);
}

// ── stills ──────────────────────────────────────────────────────────────────────────────────────────────

const inflight = new Map<string, Promise<ImageBitmap | null>>();
/** Who still wants a queued still (several cards can show the same picture). */
const wants = new Map<string, Set<() => boolean>>();
export const previewStats = { stills: 0, fromMemory: 0, fromDisk: 0, rendered: 0, warned: 0, failed: 0, renderMs: [] as number[] };

export function stillKey(item: PreviewItem, choice: FrameChoice, size: { w: number; h: number }): string {
  const s = renderSize(item, size);
  return thumbKey({ kind: item.kind, id: item.id, version: itemVersion(item), source: sourceOf(item, choice), w: s.w, h: s.h });
}

/** An item's still at a card size (memory → disk → an idle render). `wanted` false drops a queued render. */
export function requestStill(item: PreviewItem, choice: FrameChoice, size: { w: number; h: number }, opts: { priority?: number; wanted?: () => boolean } = {}): Promise<ImageBitmap | null> {
  const key = stillKey(item, choice, size);
  previewStats.stills++;
  const m = memory.get(key);
  if (m) { previewStats.fromMemory++; return Promise.resolve(m); }
  const ws = wants.get(key) ?? new Set<() => boolean>();
  wants.set(key, ws);
  ws.add(opts.wanted ?? (() => true));
  let p = inflight.get(key);
  if (p) { if (scheduler.has(key)) scheduler.add({ key, priority: opts.priority ?? 10, run: () => undefined }); return p; }
  const s = renderSize(item, size);
  p = (async () => {
    const disk = await diskGet(key);
    if (disk) { previewStats.fromDisk++; memory.set(key, disk); return disk; }
    return new Promise<ImageBitmap | null>((resolve) => {
      let done = false;
      scheduler.add({
        key, priority: opts.priority ?? 10,
        wanted: () => { const w = [...(wants.get(key) ?? [])].some((f) => f()); if (!w && !done) { done = true; resolve(null); } return w; },
        run: async () => {
          if (done) return;
          const t0 = performance.now();
          let bmp = await renderFrame(item, choice, s.w, s.h, { t: stillTime(item), k: item.kind === "chain" ? item.k ?? 1 : undefined, progress: 0.5 }).catch((e) => { console.warn("[preview]", item.id, e); return null; });
          // a dip-to-colour transition is all black (or white) half-way: show it a little earlier instead
          if (bmp && item.kind === "transition" && blankBitmap(bmp)) { bmp.close(); bmp = await renderFrame(item, choice, s.w, s.h, { progress: 0.3 }).catch(() => null); }
          previewStats.rendered++;
          previewStats.renderMs.push(performance.now() - t0);
          if (previewStats.renderMs.length > 200) previewStats.renderMs.shift();
          // a failed or blank render is never kept: the card falls back and asks again after a backoff; one the engine
          // drew with warnings (a LUT that didn't load, an effect it hasn't got) shows, but isn't kept until the tries run out
          const good = bmp && !blankBitmap(bmp) ? bmp : null;
          const warned = !!good && lastRenderWarnings().length > 0;
          const tries = failures.get(key)?.n ?? 0;
          if (good && (!warned || tries >= 3)) { failures.delete(key); memory.set(key, good); if (!warned) diskPut(key, good); }
          else { if (!good) bmp?.close(); failures.set(key, { n: tries + 1, at: performance.now() }); if (warned) { previewStats.warned++; console.warn("[preview]", item.id, lastRenderWarnings().join("; ")); } else previewStats.failed++; }
          done = true;
          resolve(good);
        },
      });
    });
  })().finally(() => { inflight.delete(key); wants.delete(key); });
  inflight.set(key, p);
  return p;
}

// ── strips (hover animations) ───────────────────────────────────────────────────────────────────────────

export type StripUse = "scrub" | "loop";

/** Frames of an item's hover animation, filled progressively; `at(i)` is the nearest frame that's ready. */
export class Strip {
  readonly frames: (ImageBitmap | null)[];
  /** What each frame shows: a time (s), an intensity or a progress. */
  readonly values: number[];
  private subs = new Set<() => void>();
  users = 0;
  readonly mode: "loop" | "pingpong";
  readonly hold: number;
  readonly key: string;
  constructor(key: string, values: number[], mode: "loop" | "pingpong", hold: number) {
    this.key = key; this.values = values; this.frames = values.map(() => null); this.mode = mode; this.hold = hold;
  }
  get n() { return this.frames.length; }
  get ready() { return this.frames.filter(Boolean).length; }
  at(i: number): ImageBitmap | null {
    const n = this.frames.length;
    for (let d = 0; d < n; d++) {
      const a = this.frames[i - d], b = this.frames[i + d];
      if (a) return a;
      if (b) return b;
    }
    return null;
  }
  set(i: number, b: ImageBitmap | null) { this.frames[i] = b; this.subs.forEach((f) => f()); }
  onChange(cb: () => void) { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  dispose() { for (const f of this.frames) try { f?.close(); } catch { /* closed */ } }
}

const strips = new Map<string, Strip>();
const STRIP_CACHE = 5;

/** Every second index first, then the gaps (a scrub finds a near frame early). */
function bisectOrder(n: number): number[] {
  const out: number[] = [], seen = new Set<number>();
  const push = (i: number) => { if (i >= 0 && i < n && !seen.has(i)) { seen.add(i); out.push(i); } };
  push(0); push(n - 1);
  for (let step = n; step >= 1; step = Math.floor(step / 2)) { for (let i = 0; i < n; i += step) push(i); if (step === 1) break; }
  return out;
}

/** The strip of an item's hover animation ("scrub": what the pointer moves through; "loop": what a held card plays). */
export function requestStrip(item: PreviewItem, choice: FrameChoice, size: { w: number; h: number }, use: StripUse): Strip {
  const s = renderSize(item, size);
  let values: number[], mode: "loop" | "pingpong" = "loop", hold = 0;
  let what: "t" | "k" | "progress" = "t";
  if (item.kind === "transition") { values = Array.from({ length: 17 }, (_, i) => i / 16); what = "progress"; hold = 10; }
  else if (item.kind === "chain") {
    if (use === "scrub") { const top = item.kMax ?? 1; values = Array.from({ length: 9 }, (_, i) => (i / 8) * top); what = "k"; }
    else { values = stripTimes(3, 3 * LOOP_FPS + 1); mode = "pingpong"; }
  } else {
    const dur = item.kind === "title" ? item.seconds : item.tpl.seconds;
    const n = Math.max(8, Math.min(60, Math.ceil(dur * LOOP_FPS) + 1));
    values = stripTimes(Math.max(0.1, dur - 1 / 30), n); hold = 6;
  }
  // a title / template / transition has one strip for both uses
  const u = item.kind === "chain" ? use : "both";
  const key = `${thumbKey({ kind: item.kind, id: item.id, version: itemVersion(item), source: sourceOf(item, choice), w: s.w, h: s.h })}|strip:${u}`;
  let st = strips.get(key);
  if (st) { strips.delete(key); strips.set(key, st); }
  else {
    st = new Strip(key, values, mode, hold);
    strips.set(key, st);
    for (const [k, v] of strips) { if (strips.size <= STRIP_CACHE) break; if (v.users <= 0) { strips.delete(k); v.dispose(); } }
  }
  const strip = st;
  const order = u === "scrub" || item.kind === "transition" ? bisectOrder(strip.n) : strip.values.map((_, i) => i);
  order.forEach((i, rank) => {
    if (strip.frames[i]) return;
    const jk = `${key}#${i}`;
    scheduler.add({
      key: jk, priority: 100 + (strip.n - rank) / strip.n,
      wanted: () => strip.users > 0 && strips.get(key) === strip,
      run: async () => {
        if (strip.frames[i]) return;
        const v = strip.values[i];
        const at = what === "t" ? { t: v } : what === "k" ? { k: v, t: 0 } : { progress: v };
        const bmp = await renderFrame(item, choice, s.w, s.h, at).catch(() => null);
        // a failed frame stays empty (the next hover asks for it again); a transition may pass through black
        const good = bmp && (item.kind === "transition" || !blankBitmap(bmp)) ? bmp : null;
        if (!good) bmp?.close();
        if (strips.get(key) === strip) strip.set(i, good); else good?.close();
      },
    });
  });
  return strip;
}

/** Debug and QA: timings and cache counts (window.__tatvamPreview when the editor's debug flag is on). */
export function previewDebug() {
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0);
  const p95 = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] * 100) / 100; };
  return {
    ...previewStats, renderAvg: avg(previewStats.renderMs), renderP95: p95(previewStats.renderMs),
    pending: scheduler.pending, perIdle: [...scheduler.stats.perIdle], jobAvg: avg(scheduler.stats.runs), memoryMB: Math.round(memory.bytes / 1e5) / 10, strips: strips.size,
  };
}
