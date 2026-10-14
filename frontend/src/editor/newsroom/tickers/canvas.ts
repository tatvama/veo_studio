/**
 * Canvas helpers for the ticker and clock kinds: offscreen canvases (crawl pieces are drawn once and moved), plates
 * shaped by the look (flat / glass / angled / rounded), optical centring of a line of text per script, field tokens
 * in paints, and a cache epoch that changes when fonts or pictures arrive. No DOM at import time.
 */
import { scriptOf } from "../format.ts";
import { assetEpoch } from "../render/images.ts";
import type { Ctx2D, LayerRenderContext } from "../render/contract.ts";
import type { ChannelLook, Paint, ScriptId } from "../types.ts";

export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

/** A canvas of w × h pixels (OffscreenCanvas where there is one), or null without canvas support (Node). */
export function makeCanvas(w: number, h: number): { c: AnyCanvas; g: Ctx2D } | null {
  const W = Math.max(1, Math.ceil(w)), H = Math.max(1, Math.ceil(h));
  let c: AnyCanvas | null = null;
  if (typeof OffscreenCanvas !== "undefined") c = new OffscreenCanvas(W, H);
  else if (typeof document !== "undefined") { const e = document.createElement("canvas"); e.width = W; e.height = H; c = e; }
  if (!c) return null;
  const g = c.getContext("2d") as Ctx2D | null;
  return g ? { c, g } : null;
}

let fontsEpoch = 0, watching = false;
/** Changes whenever fonts finish loading or a picture arrives (cached pieces made before then are redrawn). */
export function cacheEpoch(): string {
  if (!watching) {
    watching = true;
    const fs = (globalThis as { document?: { fonts?: EventTarget } }).document?.fonts ?? (globalThis as { fonts?: EventTarget }).fonts;
    try { fs?.addEventListener?.("loadingdone", () => { fontsEpoch++; }); } catch { /* no font events here */ }
  }
  return `${fontsEpoch}.${assetEpoch()}`;
}

/** A paint that may name a field ("{level}" → that field's colour); otherwise as written. */
export function fieldPaint(p: Paint | undefined, rc: Pick<LayerRenderContext, "value">): Paint | undefined {
  if (typeof p !== "string") return p;
  const m = /^\{([\w.-]+)\}$/.exec(p.trim());
  if (!m) return p;
  const v = rc.value(m[1]);
  return typeof v === "string" && v ? v : undefined;
}

/** A solid css colour for a paint (gradients give their first colour): for cache keys and solid fills. */
export function solid(rc: Pick<LayerRenderContext, "paint" | "value">, p: Paint | undefined, fallback = ""): string {
  const q = fieldPaint(p, rc);
  const r = rc.paint(q && typeof q === "object" ? q.gradient[0] : q, fallback);
  return typeof r === "string" ? r : fallback;
}

/** A stable text form of a paint for cache keys. */
export const paintKey = (p: Paint | undefined): string => (typeof p === "string" ? p : p ? JSON.stringify(p) : "");

// ── plates ───────────────────────────────────────────────────────────────────

/** The slant of an angled plate's end, as a share of its height (tan 14°: the same angle as the core's plates). */
export const SLANT = 0.25;

/**
 * Traces a plate in the look's style: angled ends (`ends` says which: the right only by default), rounded corners,
 * or a plain rectangle (flat and glass).
 */
export function platePath(g: Ctx2D, x: number, y: number, w: number, h: number, look: Pick<ChannelLook, "plate" | "radius">, ends: { left?: boolean; right?: boolean } = { right: true }): void {
  g.beginPath();
  if (look.plate === "angled") {
    const s = Math.min(w / 3, h * SLANT);
    const l = ends.left ? s : 0, r = ends.right ? s : 0;
    g.moveTo(x + l, y); g.lineTo(x + w, y); g.lineTo(x + w - r, y + h); g.lineTo(x, y + h); g.closePath();
    return;
  }
  if (look.plate === "rounded") {
    const rad = Math.max(0, Math.min(look.radius || 8, h / 2, w / 2));
    if (typeof (g as { roundRect?: unknown }).roundRect === "function") { g.roundRect(x, y, w, h, rad); return; }
    g.moveTo(x + rad, y); g.arcTo(x + w, y, x + w, y + h, rad); g.arcTo(x + w, y + h, x, y + h, rad); g.arcTo(x, y + h, x, y, rad); g.arcTo(x, y, x + w, y, rad); g.closePath();
    return;
  }
  g.rect(x, y, w, h);
}

/** Fills a plate (glass looks get a translucent fill with a light top edge). */
export function fillPlate(g: Ctx2D, x: number, y: number, w: number, h: number, fill: string | CanvasGradient, look: Pick<ChannelLook, "plate" | "radius">, ends?: { left?: boolean; right?: boolean }): void {
  if (!fill || w <= 0 || h <= 0) return;
  g.save();
  platePath(g, x, y, w, h, look, ends);
  g.fillStyle = fill;
  if (look.plate === "glass") g.globalAlpha *= 0.9;
  g.fill();
  if (look.plate === "glass") {
    g.clip();
    g.globalAlpha = Math.min(1, g.globalAlpha / 0.9);
    const gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, "rgba(255,255,255,0.22)"); gr.addColorStop(0.5, "rgba(255,255,255,0.04)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    g.fillStyle = "rgba(255,255,255,0.35)"; g.fillRect(x, y, w, Math.max(1, h * 0.03));
  }
  g.restore();
}

// ── text ─────────────────────────────────────────────────────────────────────

/** Letters whose top and bottom set a script's optical centre (caps for Latin, a plain akshara for Indic). */
const REF: Partial<Record<ScriptId, string>> = { latn: "H", deva: "कम", knda: "ಕನ", telu: "కన", taml: "கன", beng: "কম", gujr: "કમ", guru: "ਕਮ", mlym: "കമ", orya: "କମ" };
const metrics = new Map<string, [number, number]>();

/** The baseline that centres a line of `sample`'s script on `cy`, in the font now set on `g`. */
export function centreBaseline(g: Ctx2D, sample: string, cy: number): number {
  const ref = REF[scriptOf(sample)] ?? "H";
  const k = `${g.font}|${ref}`;
  let m = metrics.get(k);
  if (!m) {
    const t = g.measureText(ref);
    const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(g.font)?.[1] ?? "40");
    const asc = t.actualBoundingBoxAscent || size * 0.7, desc = t.actualBoundingBoxDescent || 0;
    m = [asc, desc];
    if (metrics.size > 2000) metrics.clear();
    metrics.set(k, m);
  }
  return cy + (m[0] - m[1]) / 2;
}

/** Sets letter spacing (em of `size`) where the canvas supports it. */
export function setTracking(g: Ctx2D, em: number, size: number): void {
  const x = g as { letterSpacing?: string };
  if (typeof x.letterSpacing === "string") x.letterSpacing = `${(em * size).toFixed(2)}px`;
}

/** Capitals per a "look" / "on" / "off" setting (Indic scripts have none and pass unchanged). */
export const capsFor = (s: string, upper: "look" | "on" | "off", look: Pick<ChannelLook, "upper">): string =>
  upper === "on" || (upper === "look" && look.upper) ? s.toLocaleUpperCase("en-IN") : s;

/** Draws a small market arrow (▲ / ▼) as a triangle in a box. */
export function triangle(g: Ctx2D, x: number, y: number, w: number, h: number, up: boolean, fill: string | CanvasGradient): void {
  g.beginPath();
  if (up) { g.moveTo(x + w / 2, y); g.lineTo(x + w, y + h); g.lineTo(x, y + h); }
  else { g.moveTo(x, y); g.lineTo(x + w, y); g.lineTo(x + w / 2, y + h); }
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}
