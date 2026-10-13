/**
 * The graphics check (docs/EDITOR.md §16.10): every graphic on a sequence, in every ratio the edit delivers, checked
 * for text that doesn't fit (shrunk below 70 % or cut with "…"), letters the fonts lack, layers outside the safe area,
 * crawls too fast to read, holds shorter than their reading time, graphics covering each other, empty required fields,
 * data older than a day (or a failed refresh) and AI-made media without its label. Each finding has the clip, the frame
 * to jump to and, where it can be fixed in one step, a fix (`applyFix`, on a draft: one undo step).
 *
 * Text is measured by an injected function (the panel passes a canvas; tests pass a fake), and missing letters by
 * another (browser only); without them text widths are estimated and letters aren't checked. Pure.
 */
import { secondsToFrames, framesToSeconds, toTimecode } from "../../model/time.ts";
import type { EditProject, Sequence, TimelineClip } from "../../model/types.ts";
import { SAFE_AREAS } from "../../templates/formats.ts";
import { aiRanges, applyAiLabels, aiLabels, subtractRanges, labelSpans } from "../auto/aiLabels.ts";
import { AUTO_KEY, isGraphicClip, type GraphicClip } from "../auto/tags.ts";
import { autoHold } from "../commands.ts";
import { ageHours } from "../feeds/snapshot.ts";
import { templateById } from "../feeds/bind.ts";
import { resolveLook } from "../looks.ts";
import { fillText } from "../render/index.ts";
import { textSetup } from "../render/kinds/basic.ts";
import { applyOverrides, contentBox, designSpace, isEmpty, shownBy, valuesOf } from "../render/layout.ts";
import { cssFont } from "../render/paint.ts";
import { fitText } from "../render/text.ts";
import { DESIGN } from "../templates/kit.ts";
import { crawlSpeed, estimateWidth, maxReadableSpeed, readableSpeed } from "../tickers/math.ts";
import { tickerProps } from "../tickers/props.ts";
import type { Box, ChannelLook, GfxField, GfxLayer, GfxRatio, GfxTemplate, GfxValue } from "../types.ts";

export type QcKind = "fit" | "glyphs" | "safe" | "crawl" | "hold" | "overlap" | "empty" | "stale" | "ai-label";
export type QcFix =
  | { kind: "extend"; label: string; clipId: string; duration: number }
  | { kind: "safe"; label: string; clipId: string; ratio: GfxRatio; dx: number; dy: number }
  | { kind: "crawl"; label: string; clipId: string; ratio: GfxRatio; layerId: string; speedPx: number }
  | { kind: "ai-labels"; label: string }
  | { kind: "refresh"; label: string; sourceId: string };
export interface Finding {
  id: string; kind: QcKind; severity: "error" | "warn";
  clipId?: string; frame: number; ratio?: GfxRatio;
  /** Plain words: what is wrong and where. */ message: string;
  fix?: QcFix;
}

export interface QcDeps {
  /** Width of `text` in a CSS font string, in that font's px (default: an estimate from the font size). */
  measure?(font: string, text: string): number;
  /** The letters of `text` that the font stack can't draw (default: not checked). */
  missing?(font: string, text: string): string[];
  /** Epoch ms "now" (data age). */
  now?: number;
}

export const QC_LABELS: Record<QcKind, string> = {
  fit: "Text that doesn't fit", glyphs: "Missing letters", safe: "Outside the safe area", crawl: "Crawl too fast",
  hold: "Too short to read", overlap: "Graphics covering each other", empty: "Empty fields", stale: "Old data", "ai-label": "AI media without a label",
};

/** Ratios an edit delivers: both for a both-ratio news edit, else the sequence's own. */
export function outputRatios(p: EditProject, seq: Sequence): GfxRatio[] {
  if (p.newsroom?.ratio === "both") return ["16:9", "9:16"];
  const a = seq.width / seq.height;
  return [a > 1.3 ? "16:9" : a < 0.7 ? "9:16" : a < 0.9 ? "4:5" : "1:1"];
}

/** Font px from a CSS font string ("700 52px …"). */
const pxOf = (font: string) => Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 48);
const estimate = (font: string, text: string) => estimateWidth(text, pxOf(font));

/** What text layers need to fill and pick fonts (the renderer's `text` / `font`). */
function textRc(t: GfxTemplate, vals: Record<string, GfxValue>, look: ChannelLook) {
  const fields = new Map<string, GfxField>(t.fields.map((f) => [f.id, f]));
  const clock = Date.UTC(2026, 0, 1, 13, 30);
  return {
    text: (s: string, upper?: boolean) => { const v = fillText(s ?? "", vals, fields, look, clock); return upper && look.upper ? v.toUpperCase() : v; },
    font: (n: string | undefined, sz: number, w?: number, sample?: string) => cssFont(n, look, sz, w, sample),
  };
}
type Rc = ReturnType<typeof textRc>;
type Measure = (font: string, text: string) => number;

/** Text width as the text kind measures it (widest line, with letter spacing). */
function textWidth(l: GfxLayer, rc: Rc, measure: Measure): number {
  const ts = textSetup(l, rc);
  return ts.s ? Math.max(...ts.s.split(/\r?\n/).map((x) => measure(ts.fontAt(ts.size), x) + ts.tracking * [...x].length)) : 0;
}

/** Plates that fit their text (`p.grow`), as the renderer sizes them: the plate and the text box take the text's width. */
function grown(layers: GfxLayer[], rc: Rc, measure: Measure): GfxLayer[] {
  const boxes = new Map(layers.map((l) => [l.id, l.box]));
  const want = new Map<string, Box>();
  for (const l of layers) {
    const gr = l.p.grow as { layers?: string[]; pad?: number; min?: number; max?: number } | undefined;
    if (l.kind !== "text" || !gr || !Array.isArray(gr.layers)) continue;
    const tw = textWidth(l, rc, measure);
    const align = (l.p.align as string) ?? "left";
    const pad = gr.pad ?? 24;
    for (const id of gr.layers) {
      const b = boxes.get(id);
      if (!b) continue;
      const [tx, , tbw] = l.box;
      let x0: number, x1: number;
      if (align === "right") { x1 = b[0] + b[2]; x0 = Math.min(x1, tx + tbw - tw - pad); x0 = Math.min(x0, x1 - (gr.min ?? 0)); if (gr.max) x0 = Math.max(x0, x1 - gr.max); }
      else if (align === "center") { const cx = b[0] + b[2] / 2; let w = tw + pad * 2; w = Math.max(gr.min ?? 0, gr.max ? Math.min(gr.max, w) : w); x0 = cx - w / 2; x1 = cx + w / 2; }
      else { x0 = b[0]; x1 = Math.max(x0, tx + tw + pad); x1 = Math.max(x1, x0 + (gr.min ?? 0)); if (gr.max) x1 = Math.min(x1, x0 + gr.max); }
      const tb = want.get(l.id) ?? l.box;
      if (align === "right") { const nx = Math.min(tb[0], x0 + pad); want.set(l.id, [nx, tb[1], tb[0] + tb[2] - nx, tb[3]]); }
      else if (align === "center") { const half = Math.max(tb[2], x1 - x0 - pad * 2) / 2; const c = tb[0] + tb[2] / 2; want.set(l.id, [c - half, tb[1], half * 2, tb[3]]); }
      else want.set(l.id, [tb[0], tb[1], Math.max(tb[2], x1 - pad - tb[0]), tb[3]]);
      const prev = want.get(id);
      const nb: Box = [x0, b[1], x1 - x0, b[3]];
      want.set(id, prev ? [Math.min(prev[0], nb[0]), b[1], Math.max(prev[0] + prev[2], nb[0] + nb[2]) - Math.min(prev[0], nb[0]), b[3]] : nb);
    }
  }
  return want.size ? layers.map((l) => (want.has(l.id) ? { ...l, box: want.get(l.id)! } : l)) : layers;
}

/**
 * The design as drawn for a clip in a ratio: layers (overrides merged, hidden and `when`-hidden left out, plates fitted
 * to their text when a look and a measure are given), the design size and the safe insets.
 */
export function designOf(t: GfxTemplate, values: Record<string, GfxValue>, ratio: GfxRatio, overrides?: Record<string, Partial<GfxLayer>>, look?: ChannelLook, measure?: Measure) {
  const D = DESIGN[ratio];
  const ds = designSpace(t, D.w, D.h, ratio);
  const vals = valuesOf(t, values);
  let layers = applyOverrides(ds.layers, overrides, ds.ratio).filter((l) => !l.hidden && shownBy(l.when, vals));
  const rc = look ? textRc(t, vals, look) : null;
  if (rc && measure) layers = grown(layers, rc, measure);
  const own = t.designs[ratio]?.safe;
  const s = SAFE_AREAS[ratio];
  const safe = own && !ds.auto ? { top: own[0], right: own[1], bottom: own[2], left: own[3] }
    : { top: s.top * ds.h, right: s.right * ds.w, bottom: s.bottom * ds.h, left: s.left * ds.w };
  return { layers, w: ds.w, h: ds.h, safe, values: vals, rc };
}
const drawn = (x: Ctx, c: GraphicClip, t: GfxTemplate, ratio: GfxRatio) => {
  const measure = x.deps.measure ?? estimate;
  const d = designOf(t, c.source.gfx.values, ratio, c.source.gfx.overrides, resolveLook(x.p, c.source.gfx.look), measure);
  return { ...d, ink: inked(d.layers, d.rc!, measure) };
};

/** Layers with text boxes cut to the text itself (by its alignment): what is actually drawn. Empty texts drop out. */
function inked(layers: GfxLayer[], rc: Rc, measure: Measure): GfxLayer[] {
  return layers.flatMap((l) => {
    if (l.kind !== "text") return [l];
    const tw = textWidth(l, rc, measure);
    if (!tw) return [];
    const padX = typeof l.p.padX === "number" ? l.p.padX : 0;
    const [bx, by, bw, bh] = l.box;
    const w = Math.min(tw, Math.max(1, bw - padX * 2));
    const align = (l.p.align as string) ?? "left";
    const x0 = align === "right" ? bx + bw - padX - w : align === "center" ? bx + (bw - w) / 2 : bx + padX;
    return [{ ...l, box: [x0, by, w, bh] as Box }];
  });
}

/** Kinds whose box must stay inside the safe area (plates, lines and backgrounds may bleed to the edges). */
const SAFE_KINDS = new Set(["text", "logo", "icon", "image", "clock", "number", "list", "table", "bars", "pins"]);
/** Roles that cover the frame on purpose. */
const FULL_ROLES = new Set(["background", "layout", "wipe"]);

const tc = (seq: Sequence, f: number) => toTimecode(f, seq.fps);
const nameOf = (c: TimelineClip, t: GfxTemplate) => `“${c.name || t.name}”`;

interface Ctx { p: EditProject; seq: Sequence; deps: QcDeps; ratios: GfxRatio[]; out: Finding[] }

function checkText(x: Ctx, c: GraphicClip, t: GfxTemplate, ratio: GfxRatio, many: boolean) {
  const d = drawn(x, c, t, ratio);
  const rc = d.rc!;
  const measure = x.deps.measure ?? estimate;
  const where = many ? ` in ${ratio}` : "";
  for (const l of d.layers) {
    if (l.kind !== "text") continue;
    const ts = textSetup(l, rc);
    if (!ts.s.trim()) continue;
    const padX = typeof l.p.padX === "number" ? l.p.padX : 0;
    const fit = (typeof l.p.fit === "string" ? l.p.fit : "shrink") as "shrink" | "wrap" | "ellipsis" | "none";
    const r = fitText(ts.s, Math.max(1, l.box[2] - padX * 2), l.box[3], {
      size: ts.size, lineHeight: ts.lh, fit, maxLines: typeof l.p.maxLines === "number" ? l.p.maxLines : 0,
      minScale: typeof l.p.minScale === "number" ? l.p.minScale : 0.6,
    }, (sz) => (s: string) => measure(ts.fontAt(sz), s) + ((ts.tracking * sz) / ts.size) * [...s].length);
    const label = `${nameOf(c, t)} (${l.name})`;
    if (r.ellipsized) x.out.push({ id: `fit:${c.id}:${ratio}:${l.id}`, kind: "fit", severity: "error", clipId: c.id, frame: c.start, ratio,
      message: `${label}${where}: the text is too long and is cut off with “…”. Shorten it.` });
    else if (fit !== "none" && r.scale < 0.7) x.out.push({ id: `fit:${c.id}:${ratio}:${l.id}`, kind: "fit", severity: "warn", clipId: c.id, frame: c.start, ratio,
      message: `${label}${where}: the text shrinks to ${Math.round(r.scale * 100)} % to fit. A shorter text reads better.` });
    if (x.deps.missing) {
      const miss = x.deps.missing(ts.fontAt(ts.size), ts.s);
      if (miss.length) x.out.push({ id: `glyphs:${c.id}:${l.id}`, kind: "glyphs", severity: "error", clipId: c.id, frame: c.start,
        message: `${label}: the fonts have no letters for “${miss.slice(0, 6).join(" ")}”${miss.length > 6 ? " …" : ""}; they would show as empty boxes. Choose a font for that script in the channel look.` });
    }
  }
}

function checkSafe(x: Ctx, c: GraphicClip, t: GfxTemplate, ratio: GfxRatio) {
  if (FULL_ROLES.has(t.role)) return;
  const d = drawn(x, c, t, ratio);
  const tol = 2;
  const out = d.ink.filter((l) => SAFE_KINDS.has(l.kind) && (
    l.box[0] < d.safe.left - tol || l.box[1] < d.safe.top - tol || l.box[0] + l.box[2] > d.w - d.safe.right + tol || l.box[1] + l.box[3] > d.h - d.safe.bottom + tol));
  if (!out.length) return;
  // the shift that brings every checked layer inside (when they fit at all)
  const bx = [Math.min(...out.map((l) => l.box[0])), Math.min(...out.map((l) => l.box[1])), Math.max(...out.map((l) => l.box[0] + l.box[2])), Math.max(...out.map((l) => l.box[1] + l.box[3]))];
  const all = d.ink.filter((l) => SAFE_KINDS.has(l.kind));
  const ax = [Math.min(...all.map((l) => l.box[0])), Math.min(...all.map((l) => l.box[1])), Math.max(...all.map((l) => l.box[0] + l.box[2])), Math.max(...all.map((l) => l.box[1] + l.box[3]))];
  const shift = (lo: number, hi: number, min: number, max: number) => (hi - lo > max - min ? null : lo < min ? min - lo : hi > max ? max - hi : 0);
  const dx = shift(Math.min(ax[0], bx[0]), Math.max(ax[2], bx[2]), d.safe.left, d.w - d.safe.right);
  const dy = shift(Math.min(ax[1], bx[1]), Math.max(ax[3], bx[3]), d.safe.top, d.h - d.safe.bottom);
  const fix: QcFix | undefined = dx !== null && dy !== null && (dx || dy)
    ? { kind: "safe", label: "Move inside", clipId: c.id, ratio, dx: Math.round(dx), dy: Math.round(dy) } : undefined;
  const names = out.map((l) => l.name).slice(0, 3).join(", ");
  x.out.push({ id: `safe:${c.id}:${ratio}`, kind: "safe", severity: "warn", clipId: c.id, frame: c.start, ratio,
    message: `${nameOf(c, t)} in ${ratio}: ${names}${out.length > 3 ? " …" : ""} ${out.length === 1 ? "is" : "are"} outside the safe area${ratio === "9:16" ? " (Reels and Shorts draw their buttons there)" : ""}.`,
    ...(fix ? { fix } : {}) });
}

function checkCrawl(x: Ctx, c: GraphicClip, t: GfxTemplate, ratio: GfxRatio, many: boolean) {
  const d = designOf(t, c.source.gfx.values, ratio, c.source.gfx.overrides);
  for (const l of d.layers) {
    if (l.kind !== "ticker") continue;
    const P = tickerProps(l.p);
    if (P.mode !== "crawl") continue;
    const speed = crawlSpeed(P.speed, d.w, d.h, P.speedPx);
    const r = readableSpeed(speed, P.size, l.box[2]);
    if (r.level !== "too-fast") continue;
    const ok = Math.floor(maxReadableSpeed(P.size, l.box[2]));
    x.out.push({ id: `crawl:${c.id}:${ratio}:${l.id}`, kind: "crawl", severity: "warn", clipId: c.id, frame: c.start, ratio,
      message: `${nameOf(c, t)}${many ? ` in ${ratio}` : ""}: the crawl moves ${Math.round(r.charsPerSec)} letters a second, too fast to read (about ${Math.round(r.onScreen * 10) / 10} s on screen).`,
      fix: { kind: "crawl", label: "Slow it down", clipId: c.id, ratio, layerId: l.id, speedPx: ok } });
  }
}

function checkHold(x: Ctx, c: GraphicClip, t: GfxTemplate) {
  if (t.loop || FULL_ROLES.has(t.role) || t.role === "ticker" || t.role === "bug") return;
  if (c.source.gfx.values[AUTO_KEY] === "ai-label") return;
  const need = autoHold(t, valuesOf(t, c.source.gfx.values), x.p.newsroom?.settings.readSpeed ?? 3);
  const have = framesToSeconds(c.duration, x.seq.fps);
  if (have >= need - 0.25) return;
  const want = secondsToFrames(need, x.seq.fps);
  const next = x.seq.clips.filter((o) => o.trackId === c.trackId && o.start >= c.start + c.duration && o.id !== c.id).reduce((m, o) => Math.min(m, o.start), Infinity);
  const room = next - c.start;
  const dur = Math.min(want, room);
  x.out.push({ id: `hold:${c.id}`, kind: "hold", severity: "warn", clipId: c.id, frame: c.start,
    message: `${nameOf(c, t)} is on screen for ${have.toFixed(1)} s; reading it takes about ${need.toFixed(1)} s.`,
    ...(dur > c.duration ? { fix: { kind: "extend" as const, label: dur >= want ? `Hold ${need.toFixed(1)} s` : `Hold ${framesToSeconds(dur, x.seq.fps).toFixed(1)} s (up to the next graphic)`, clipId: c.id, duration: dur } } : {}) });
}

function checkEmpty(x: Ctx, c: GraphicClip, t: GfxTemplate) {
  const v = c.source.gfx.values, bound = c.source.gfx.bind ?? {};
  const empty = t.fields.filter((f) => f.required && !bound[f.id] && isEmpty(v[f.id] ?? f.default));
  if (empty.length) x.out.push({ id: `empty:${c.id}`, kind: "empty", severity: "error", clipId: c.id, frame: c.start,
    message: `${nameOf(c, t)}: ${empty.map((f) => f.label).join(", ")} ${empty.length === 1 ? "is" : "are"} empty. Fill ${empty.length === 1 ? "it" : "them"} in.` });
}

/** Boxes of two graphics overlap by more than 2 % of the smaller one. */
const overlaps = (a: number[], b: number[]) => {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]), h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 && w * h > 0.02 * Math.min(a[2] * a[3], b[2] * b[3]);
};

function checkOverlaps(x: Ctx, gs: { c: GraphicClip; t: GfxTemplate }[]) {
  const collision = x.p.newsroom?.settings.collision ?? true;
  const allowed = (a: GfxTemplate, b: GfxTemplate) => {
    if (FULL_ROLES.has(a.role) || FULL_ROLES.has(b.role)) return true;
    const pair = [a.role, b.role].sort().join("+");
    return collision && (pair === "strap+ticker" || pair === "board+ticker");
  };
  for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) {
    const A = gs[i], B = gs[j];
    if (A.c.trackId === B.c.trackId) continue;
    const from = Math.max(A.c.start, B.c.start), to = Math.min(A.c.start + A.c.duration, B.c.start + B.c.duration);
    if (to <= from || allowed(A.t, B.t)) continue;
    for (const ratio of x.ratios) {
      if (!showsIn(A.c, ratio) || !showsIn(B.c, ratio)) continue;
      const da = drawn(x, A.c, A.t, ratio), db = drawn(x, B.c, B.t, ratio);
      const ba = contentBox(da.ink, da.w, da.h), bb = contentBox(db.ink, db.w, db.h);
      if (!ba || !bb || !overlaps(ba, bb)) continue;
      x.out.push({ id: `overlap:${A.c.id}:${B.c.id}:${ratio}`, kind: "overlap", severity: "warn", clipId: B.c.start >= A.c.start ? B.c.id : A.c.id, frame: from, ratio,
        message: `${nameOf(A.c, A.t)} and ${nameOf(B.c, B.t)} cover each other${x.ratios.length > 1 ? ` in ${ratio}` : ""} at ${tc(x.seq, from)}.` });
      break;
    }
  }
}

function checkData(x: Ctx, gs: { c: GraphicClip; t: GfxTemplate }[]) {
  const nr = x.p.newsroom;
  if (!nr) return;
  const now = x.deps.now ?? Date.now();
  const used = new Map<string, GraphicClip>();
  for (const { c } of gs) for (const b of Object.values(c.source.gfx.bind ?? {})) if (!used.has(b.source)) used.set(b.source, c);
  for (const [sid, c] of used) {
    const src = nr.sources.find((s) => s.id === sid);
    const snap = nr.data[sid];
    const name = src ? `“${src.name}”` : "A data source";
    const fix = src && src.kind !== "manual" ? { fix: { kind: "refresh" as const, label: "Refresh", sourceId: sid } } : {};
    if (!snap) x.out.push({ id: `stale:${sid}`, kind: "stale", severity: "warn", clipId: c.id, frame: c.start, message: `${name} has never been refreshed, so its graphics show their own text.`, ...fix });
    else if (snap.error) x.out.push({ id: `stale:${sid}`, kind: "stale", severity: "warn", clipId: c.id, frame: c.start, message: `${name}: the last refresh failed (${snap.error}). Graphics show the data from before.`, ...fix });
    else if (src?.kind !== "manual" && ageHours(snap, now) > 24) {
      const h = ageHours(snap, now);
      x.out.push({ id: `stale:${sid}`, kind: "stale", severity: "warn", clipId: c.id, frame: c.start,
        message: `${name} is ${h >= 48 ? `${Math.floor(h / 24)} days` : `${Math.floor(h)} hours`} old.`, ...fix });
    }
  }
}

function checkAiLabels(x: Ctx) {
  if (!x.p.newsroom?.settings.aiLabel) return;
  const missing = subtractRanges(aiRanges(x.p, x.seq.id), labelSpans(x.p, x.seq));
  for (const r of missing) x.out.push({ id: `ai-label:${r.from}`, kind: "ai-label", severity: "error", frame: r.from,
    message: `AI-made pictures from ${tc(x.seq, r.from)} to ${tc(x.seq, r.to)} have no “AI-generated” label.`, fix: { kind: "ai-labels", label: "Add AI labels" } });
}

const showsIn = (c: GraphicClip, r: GfxRatio) => !c.source.gfx.ratios?.length || c.source.gfx.ratios.includes(r);

/** Runs every check on a sequence; findings sorted by frame. */
export function runQc(p: EditProject, seqId: string, deps: QcDeps = {}): Finding[] {
  const seq = p.sequences.find((s) => s.id === seqId);
  if (!seq) return [];
  const x: Ctx = { p, seq, deps, ratios: outputRatios(p, seq), out: [] };
  const hidden = new Set(seq.tracks.filter((t) => t.hidden).map((t) => t.id));
  const gs = seq.clips.filter((c): c is GraphicClip => isGraphicClip(c) && c.enabled && !hidden.has(c.trackId))
    .map((c) => ({ c, t: templateById(p, c.source.gfx.template) })).filter((g): g is { c: GraphicClip; t: GfxTemplate } => !!g.t)
    .sort((a, b) => a.c.start - b.c.start);
  for (const { c, t } of gs) {
    const rs = x.ratios.filter((r) => showsIn(c, r));
    for (const r of rs) {
      checkText(x, c, t, r, x.ratios.length > 1);
      checkSafe(x, c, t, r);
      checkCrawl(x, c, t, r, x.ratios.length > 1);
    }
    checkHold(x, c, t);
    checkEmpty(x, c, t);
  }
  checkOverlaps(x, gs);
  checkData(x, gs);
  checkAiLabels(x);
  // the same message in two ratios: keep one (letters are checked once per layer already)
  const seen = new Set<string>();
  return x.out.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true))).sort((a, b) => a.frame - b.frame || (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
}

/** Applies a finding's fix on a draft (not "refresh": that reads the source, see the panel); true when done. */
export function applyFix(p: EditProject, seqId: string, fix: QcFix): boolean {
  const seq = p.sequences.find((s) => s.id === seqId);
  if (!seq) return false;
  if (fix.kind === "ai-labels") { applyAiLabels(p, seqId, aiLabels(p, seqId)); return true; }
  if (fix.kind === "refresh") return false;
  const c = seq.clips.find((x) => x.id === fix.clipId);
  if (!c || !isGraphicClip(c)) return false;
  if (fix.kind === "extend") { c.duration = fix.duration; return true; }
  const t = templateById(p, c.source.gfx.template);
  if (!t) return false;
  const gfx = c.source.gfx;
  // changes for this graphic in that ratio only ("<layer>@<ratio>", like the Designer's "Change only this one")
  const ov = { ...(gfx.overrides ?? {}) };
  if (fix.kind === "crawl") {
    const k = `${fix.layerId}@${fix.ratio}`;
    const o = ov[k] ?? {};
    ov[k] = { ...o, p: { ...(o.p ?? {}), speed: "custom", speedPx: fix.speedPx } };
    gfx.overrides = ov;
    return true;
  }
  // safe: every layer of the graphic moves by the same amount
  const D = DESIGN[fix.ratio];
  const ds = designSpace(t, D.w, D.h, fix.ratio);
  for (const l of applyOverrides(ds.layers, gfx.overrides, ds.ratio)) {
    const k = `${l.id}@${fix.ratio}`;
    ov[k] = { ...(ov[k] ?? {}), box: [l.box[0] + fix.dx, l.box[1] + fix.dy, l.box[2], l.box[3]] };
  }
  gfx.overrides = ov;
  return true;
}

/** Findings grouped by kind, in the panel's order. */
export function groupFindings(fs: Finding[]): { kind: QcKind; label: string; items: Finding[] }[] {
  const order: QcKind[] = ["ai-label", "empty", "fit", "glyphs", "safe", "overlap", "hold", "crawl", "stale"];
  return order.map((k) => ({ kind: k, label: QC_LABELS[k], items: fs.filter((f) => f.kind === k) })).filter((g) => g.items.length);
}
