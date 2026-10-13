/**
 * Layer kind "panels" (docs/EDITOR.md §16.3, nr-wipes): the stinger engine. Panels, bars, slices, doors, blades, 3D
 * flips, circles or tiles in the look's colours sweep in with a stagger, cover the whole box around the cut, and leave
 * again; edges can be slanted, chevron, round, wavy, torn paper or brush, with edge lines, motion trails, shadows and
 * glass. A logo reveal, a headline ("BREAKING NEWS") and a flash sit on the cut. The geometry is wipes/geometry.ts, so
 * the Wipe Designer's coverage check sees exactly what this draws. Registers itself on import.
 */
import type { GfxLayer } from "../../types.ts";
import {
  motionOf, panelShapes, stingerClock, PANEL_EASES, PANEL_EDGES, PANEL_EXITS, PANEL_LAYOUTS, PANEL_MOTION_DEFAULTS, PANEL_ORDERS,
  type PanelShape, type Pt, type StingerClock,
} from "../../wipes/geometry.ts";
import type { Ctx2D, LayerRenderContext, PropDef } from "../contract.ts";
import { cssFont } from "../paint.ts";
import { registerLayerKind } from "../registry.ts";

const D = PANEL_MOTION_DEFAULTS;
const G_MOTION = "Motion", G_LOOK = "Look", G_REVEAL = "On the cut";

export const PANELS_PROPS: PropDef[] = [
  { key: "layout", label: "Shape", type: "choice", default: D.layout, options: PANEL_LAYOUTS, group: G_MOTION },
  { key: "edge", label: "Edge", type: "choice", default: D.edge, options: PANEL_EDGES, group: G_MOTION },
  { key: "count", label: "Count", type: "number", default: D.count, min: 1, max: 16, step: 1, group: G_MOTION },
  { key: "angle", label: "Direction", type: "number", default: D.angle, min: -180, max: 180, step: 1, unit: "°", group: G_MOTION, hint: "0 = left to right, 90 = top to bottom" },
  { key: "depth", label: "Edge depth", type: "number", default: D.depth, min: 0, max: 1, step: 0.01, group: G_MOTION },
  { key: "order", label: "Order", type: "choice", default: D.order, options: PANEL_ORDERS, group: G_MOTION },
  { key: "stagger", label: "Stagger", type: "number", default: D.stagger, min: 0, max: 0.3, step: 0.005, unit: "s", group: G_MOTION },
  { key: "cut", label: "Cut point", type: "number", default: D.cut, min: 0.2, max: 0.8, step: 0.01, group: G_MOTION, hint: "Where the frame is fully covered (fraction of the length)" },
  { key: "hold", label: "Hold", type: "number", default: D.hold, min: 0.125, max: 1.5, step: 0.01, unit: "s", group: G_MOTION },
  { key: "ease", label: "Ease", type: "choice", default: D.ease, options: PANEL_EASES, group: G_MOTION },
  { key: "overshoot", label: "Overshoot", type: "number", default: D.overshoot, min: 0, max: 1, step: 0.01, group: G_MOTION },
  { key: "exit", label: "Exit", type: "choice", default: D.exit, options: PANEL_EXITS, group: G_MOTION },
  { key: "cx", label: "Centre x", type: "number", default: 0.5, min: 0, max: 1, step: 0.01, group: G_MOTION, hint: "Circles and tiles" },
  { key: "cy", label: "Centre y", type: "number", default: 0.5, min: 0, max: 1, step: 0.01, group: G_MOTION },
  { key: "seed", label: "Variation", type: "number", default: D.seed, min: 0, max: 9999, step: 1, group: G_MOTION },
  { key: "color1", label: "Colour 1", type: "paint", default: "@accent", group: G_LOOK },
  { key: "color2", label: "Colour 2", type: "paint", default: "@secondary", group: G_LOOK },
  { key: "color3", label: "Colour 3", type: "paint", default: "@primary", group: G_LOOK },
  { key: "color4", label: "Colour 4", type: "paint", default: "", group: G_LOOK },
  { key: "style", label: "Finish", type: "choice", default: "gradient", group: G_LOOK,
    options: [{ value: "flat", label: "Flat" }, { value: "gradient", label: "Shaded" }, { value: "glass", label: "Glass" }] },
  { key: "lineWidth", label: "Edge line", type: "number", default: 0, min: 0, max: 30, step: 1, unit: "px", group: G_LOOK },
  { key: "lineColor", label: "Edge line colour", type: "paint", default: "@accent", group: G_LOOK },
  { key: "blur", label: "Motion trail", type: "number", default: 0.3, min: 0, max: 1, step: 0.01, group: G_LOOK },
  { key: "shadow", label: "Shadow", type: "number", default: 0.3, min: 0, max: 1, step: 0.01, group: G_LOOK },
  { key: "logo", label: "Logo reveal", type: "bool", default: false, group: G_REVEAL },
  { key: "logoColor", label: "Logo colour", type: "paint", default: "@textOnPrimary", group: G_REVEAL },
  { key: "text", label: "Headline", type: "text", default: "", group: G_REVEAL, hint: "Shown on the cut, e.g. BREAKING NEWS or {text}" },
  { key: "textColor", label: "Headline colour", type: "paint", default: "@textOnPrimary", group: G_REVEAL },
  { key: "textPlate", label: "Headline plate", type: "paint", default: "", group: G_REVEAL },
  { key: "textStyle", label: "Headline move", type: "choice", default: "slam", group: G_REVEAL,
    options: [{ value: "slam", label: "Slam in" }, { value: "slide", label: "Slide in" }, { value: "rise", label: "Rise" }] },
  { key: "flash", label: "Flash", type: "number", default: 0, min: 0, max: 1, step: 0.01, group: G_REVEAL },
  { key: "flashColor", label: "Flash colour", type: "paint", default: "#FFFFFF", group: G_REVEAL },
];

const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const n01 = (v: unknown, d: number) => { const x = typeof v === "number" && Number.isFinite(v) ? v : d; return x < 0 ? 0 : x > 1 ? 1 : x; };
const c01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
const outBack = (x: number) => { const t = c01(x) - 1, s = 1.6; return 1 + (s + 1) * t * t * t + s * t * t; };
const outExpo = (x: number) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * c01(x)));
const outCubic = (x: number) => 1 - Math.pow(1 - c01(x), 3);

/** The panel colours of a layer (color1..color4, or a `colors` list), never empty. */
export function panelColors(p: Record<string, unknown>): string[] {
  const list = Array.isArray(p.colors) ? (p.colors as unknown[]).filter((c): c is string => typeof c === "string" && !!c)
    : [p.color1, p.color2, p.color3, p.color4].filter((c): c is string => typeof c === "string" && !!c && c !== "none");
  return list.length ? list : ["@accent", "@secondary", "@primary"];
}

function trace(g: Ctx2D, pts: Pt[]) {
  if (!pts.length) return;
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
}
function polyline(g: Ctx2D, pts: Pt[]) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
}
function shapePath(g: Ctx2D, s: PanelShape) {
  g.beginPath();
  trace(g, s.pts);
  for (const h of s.holes ?? []) trace(g, h);
}
const rule = (s: PanelShape): CanvasFillRule => (s.holes?.length ? "evenodd" : "nonzero");

interface DrawOpts { colors: (string | CanvasGradient)[]; style: string; lineW: number; line: string | CanvasGradient; shadow: number; W: number; H: number; scale: number }

function fillShape(g: Ctx2D, s: PanelShape, o: DrawOpts, full: boolean) {
  shapePath(g, s);
  const fr = rule(s);
  g.fillStyle = o.colors[((s.color % o.colors.length) + o.colors.length) % o.colors.length];
  if (full && o.shadow > 0 && s.moving) {
    g.shadowColor = `rgba(0,0,0,${(0.5 * o.shadow).toFixed(3)})`;
    g.shadowBlur = 46 * o.shadow * o.scale;
  }
  g.fill(fr);
  g.shadowColor = "rgba(0,0,0,0)"; g.shadowBlur = 0;
  if (!full) return;
  if (o.style !== "flat") {
    const [a, b] = s.axis ?? [[0, 0], [o.W, o.H]] as [Pt, Pt];
    const gr = g.createLinearGradient(a[0], a[1], b[0], b[1]);
    if (o.style === "glass") {
      gr.addColorStop(0, "rgba(0,0,0,0.18)"); gr.addColorStop(0.55, "rgba(255,255,255,0.04)"); gr.addColorStop(0.9, "rgba(255,255,255,0.16)"); gr.addColorStop(1, "rgba(255,255,255,0.32)");
    } else {
      gr.addColorStop(0, "rgba(0,0,0,0.26)"); gr.addColorStop(0.6, "rgba(0,0,0,0.05)"); gr.addColorStop(1, "rgba(255,255,255,0.10)");
    }
    g.fillStyle = gr;
    g.fill(fr);
    if (o.style === "glass") {
      // a frosted top light across the frame and a soft bottom shade
      const v = g.createLinearGradient(0, 0, 0, o.H);
      v.addColorStop(0, "rgba(255,255,255,0.20)"); v.addColorStop(0.42, "rgba(255,255,255,0.03)"); v.addColorStop(0.5, "rgba(255,255,255,0)"); v.addColorStop(1, "rgba(0,0,0,0.16)");
      g.fillStyle = v;
      g.fill(fr);
    }
  }
  if (s.shade && s.shade > 0.01) { g.fillStyle = `rgba(0,0,0,${s.shade.toFixed(3)})`; g.fill(fr); }
}

function strokeEdges(g: Ctx2D, s: PanelShape, o: DrawOpts) {
  if (o.lineW <= 0) return;
  g.strokeStyle = o.line;
  g.lineWidth = o.lineW;
  g.lineJoin = "round"; g.lineCap = "butt";
  for (const e of [s.lead, s.trail]) if (e && e.length > 1) { polyline(g, e); g.stroke(); }
  if (!s.lead && !s.trail && s.pts.length > 2) { shapePath(g, s); g.stroke(); }
}

/** The logo / headline / flash moments: in from just before the last panel lands, out as the first leaves. */
function revealAt(ck: StingerClock, t: number): { a: number; e: number; o: number } {
  const t0 = ck.inEnd - 0.1;
  const a = c01((t - t0) / 0.14);
  const e = (t - t0) / 0.34;
  const o = c01((t - (ck.outStart - 0.05)) / 0.16);
  return { a: a * (1 - o), e, o };
}

function drawLogo(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext, ck: StingerClock, W: number, H: number, cy: number, lw: number, lh: number) {
  const { a, e, o } = revealAt(ck, rc.t);
  if (a <= 0.002) return;
  const s = (0.82 + 0.18 * outBack(e)) * (1 + 0.1 * o);
  g.save();
  g.globalAlpha *= a;
  g.translate(W / 2, cy); g.scale(s, s);
  const img = rc.logo();
  if (img) {
    const iw = (img as { width?: number }).width || 1, ih = (img as { height?: number }).height || 1;
    const k = Math.min(lw / iw, lh / ih);
    g.drawImage(img, -iw * k / 2, -ih * k / 2, iw * k, ih * k);
  } else {
    const txt = rc.look.logo?.text || "NEWS";
    let size = lh * 0.62;
    g.font = rc.font("@headline", size, 800, txt);
    const w0 = g.measureText(txt).width;
    if (w0 > lw) { size *= lw / w0; g.font = rc.font("@headline", size, 800, txt); }
    const tw = Math.min(lw, w0);
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = rc.paint(str(layer.p.logoColor, "@textOnPrimary"), "@textOnPrimary");
    g.fillText(txt, 0, 0);
    // a light sweep over the letters through the hold
    const sw = c01((rc.t - ck.inEnd) / Math.max(0.25, ck.outStart - ck.inEnd));
    if (sw > 0 && sw < 1) {
      const x = -tw / 2 - tw * 0.3 + (tw * 1.6) * sw;
      const gr = g.createLinearGradient(x - tw * 0.18, -size, x + tw * 0.18, size);
      gr.addColorStop(0, "rgba(255,255,255,0)"); gr.addColorStop(0.5, "rgba(255,255,255,0.75)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr;
      g.fillText(txt, 0, 0);
    }
    // the accent rule under the logo grows from the middle
    const bar = outCubic((rc.t - ck.inEnd + 0.04) / 0.3);
    if (bar > 0) {
      g.fillStyle = rc.paint("@accent", "@accent");
      const bw = tw * 0.62 * bar, bh = Math.max(4, size * 0.07);
      g.fillRect(-bw / 2, size * 0.56, bw, bh);
    }
  }
  g.restore();
}

function drawHeadline(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext, ck: StingerClock, W: number, H: number, cy: number, size0: number) {
  const txt = rc.text(str(layer.p.text), true).trim();
  if (!txt) return;
  const { a, e, o } = revealAt(ck, rc.t + 0.04);
  if (a <= 0.002) return;
  const style = str(layer.p.textStyle, "slam");
  let size = size0;
  g.save();
  g.font = rc.font("@headline", size, 800, txt);
  let tw = g.measureText(txt).width;
  const maxW = W * 0.84;
  if (tw > maxW) { size *= maxW / tw; g.font = rc.font("@headline", size, 800, txt); tw = maxW; }
  g.textAlign = "center"; g.textBaseline = "middle";
  const plate = str(layer.p.textPlate);
  const ee = style === "slam" ? outExpo(e * 1.15) : outCubic(e);
  let dx = 0, dy = 0, sc = 1;
  if (style === "slam") sc = 1 + 0.45 * (1 - ee);
  else if (style === "slide") dx = -W * 0.25 * (1 - ee);
  else dy = size * 0.8 * (1 - ee);
  sc *= 1 + 0.06 * o;
  g.translate(W / 2 + dx, cy + dy);
  if (plate) {
    const pw = tw + size * 0.9, ph = size * 1.32;
    const grow = outCubic(e * 1.3);
    g.save();
    g.globalAlpha *= a;
    g.fillStyle = rc.paint(plate, "@breaking");
    g.fillRect(-pw * grow / 2, -ph / 2, pw * grow, ph);
    g.fillStyle = rc.paint("@accent", "@accent");
    g.fillRect(-pw * grow / 2, ph / 2 - Math.max(4, ph * 0.06), pw * grow, Math.max(4, ph * 0.06));
    g.restore();
  }
  g.scale(sc, sc);
  const col = rc.paint(str(layer.p.textColor, "@textOnPrimary"), "@textOnPrimary");
  if (style === "slam" && ee < 0.98) {
    // a zoom trail while it slams in
    for (let k = 2; k >= 1; k--) {
      g.save();
      g.globalAlpha *= a * 0.22 * (1 - ee) * (3 - k);
      const z = 1 + 0.12 * k * (1 - ee);
      g.scale(z, z);
      g.fillStyle = col;
      g.fillText(txt, 0, 0);
      g.restore();
    }
  }
  g.globalAlpha *= a;
  g.fillStyle = col;
  g.fillText(txt, 0, 0);
  g.restore();
  void H;
}

function drawFlash(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext, ck: StingerClock, W: number, H: number) {
  const f = n01(layer.p.flash, 0);
  if (f <= 0) return;
  const d = rc.t - ck.inEnd;
  const env = d < -0.035 ? 0 : d < 0 ? (d + 0.035) / 0.035 : Math.exp(-d / 0.09);
  if (env < 0.005) return;
  g.save();
  g.globalAlpha *= c01(f * env);
  g.fillStyle = rc.paint(str(layer.p.flashColor, "#FFFFFF"), "#FFFFFF");
  g.fillRect(-4, -4, W + 8, H + 8);
  g.restore();
}

registerLayerKind({
  kind: "panels", label: "Stinger panels", group: "Motion", props: PANELS_PROPS, ownsAnim: true,
  animates: () => true,
  fonts(layer, rc) {
    const sample = `${rc.look.logo?.text ?? ""} ${rc.text(str(layer.p.text), true)}`;
    return [cssFont("@headline", rc.look, 96, 800, sample)];
  },
  draw(g, layer, rc) {
    const [bx, by, W, H] = layer.box;
    if (!(W > 0 && H > 0)) return;
    const p = layer.p;
    const m = motionOf(p);
    const T = rc.dur, t = rc.t;
    const ck = stingerClock(m, T);
    if (t <= 0 || t >= T) return;
    const o: DrawOpts = {
      colors: panelColors(p).map((c) => rc.paint(c, "@primary")), style: str(p.style, "gradient"),
      lineW: Math.max(0, Number(p.lineWidth) || 0), line: rc.paint(str(p.lineColor, "@accent"), "@accent"),
      shadow: n01(p.shadow, 0.3), W, H, scale: rc.scale,
    };
    g.save();
    g.translate(bx, by);
    g.beginPath(); g.rect(0, 0, W, H); g.clip();
    // motion trails: ghosts a few hundredths of a second either side, faint
    const blur = n01(p.blur, 0.3);
    if (blur > 0.01) {
      const base = g.globalAlpha;
      for (const [k, w] of [[3, 0.1], [2, 0.18], [1, 0.3]] as const) {
        for (const sgn of [-1, 1]) {
          const tt = t + sgn * k * 0.009;
          if (tt <= 0 || tt >= T) continue;
          for (const s of panelShapes(m, W, H, T, tt)) {
            if (!s.moving) continue;
            g.globalAlpha = base * blur * w * s.alpha;
            fillShape(g, s, o, false);
          }
        }
      }
      g.globalAlpha = base;
    }
    const base = g.globalAlpha;
    for (const s of panelShapes(m, W, H, T, t)) {
      g.globalAlpha = base * s.alpha;
      fillShape(g, s, o, true);
      strokeEdges(g, s, o);
    }
    g.globalAlpha = base;
    // on the cut: logo, headline, flash
    const portrait = H > W;
    const hasText = !!str(p.text).trim();
    const lw = portrait ? W * 0.7 : W * 0.4, lh = portrait ? H * 0.1 : H * 0.22;
    const tsize = portrait ? W * 0.105 : H * 0.115;
    if (p.logo === true) drawLogo(g, layer, rc, ck, W, H, H / 2 - (hasText ? lh * 0.45 : 0), lw, lh);
    if (hasText) drawHeadline(g, layer, rc, ck, W, H, p.logo === true ? H / 2 + lh * 0.55 + tsize * 0.35 : H / 2, tsize);
    drawFlash(g, layer, rc, ck, W, H);
    g.restore();
  },
});
