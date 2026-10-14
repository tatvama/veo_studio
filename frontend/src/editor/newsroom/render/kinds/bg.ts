/**
 * Layer kind "bg" (docs/EDITOR.md §16.3, nr-wipes): procedural, seamlessly looping news backgrounds (news grid, light
 * streaks, wireframe or dotted globe, bokeh, waves, particles, hex mesh, gradient flow, ticker tape) in the look's
 * colours. The picture is wipes/bgscene.ts at the loop phase, so t and t + period are the same frame. This module also
 * registers "countdown" (a big number counting down with a ring), used by the countdown opener. Registers on import.
 */
import type { GfxLayer } from "../../types.ts";
import { bgParams, bgScene, BG_STYLES, type BgColor, type BgPrim } from "../../wipes/bgscene.ts";
import type { Ctx2D, LayerRenderContext, PropDef } from "../contract.ts";
import { cssFont, withAlpha } from "../paint.ts";
import { registerLayerKind } from "../registry.ts";

export const BG_PROPS: PropDef[] = [
  { key: "style", label: "Background", type: "choice", default: "grid", options: BG_STYLES },
  { key: "period", label: "Loop length", type: "number", default: 12, min: 2, max: 120, step: 0.5, unit: "s", hint: "The picture repeats exactly after this long" },
  { key: "speed", label: "Speed", type: "number", default: 1, min: 1, max: 6, step: 1, hint: "Whole cycles per loop" },
  { key: "density", label: "Density", type: "number", default: 1, min: 0.2, max: 2, step: 0.05 },
  { key: "seed", label: "Variation", type: "number", default: 1, min: 0, max: 9999, step: 1 },
  { key: "cx", label: "Globe across", type: "number", default: null, min: 0, max: 1, step: 0.01, group: "Globe", hint: "Empty = right side (16:9) / centre (9:16)" },
  { key: "cy", label: "Globe down", type: "number", default: null, min: 0, max: 1, step: 0.01, group: "Globe" },
  { key: "r", label: "Globe size", type: "number", default: null, min: 0.1, max: 1.2, step: 0.01, group: "Globe", hint: "Of the shorter side" },
  { key: "top", label: "Top colour", type: "paint", default: "@secondary", group: "Colours" },
  { key: "bottom", label: "Bottom colour", type: "paint", default: "@dark", group: "Colours" },
  { key: "main", label: "Main colour", type: "paint", default: "@primary", group: "Colours" },
  { key: "accent", label: "Accent colour", type: "paint", default: "@accent", group: "Colours" },
  { key: "light", label: "Light colour", type: "paint", default: "@light", group: "Colours" },
  { key: "intensity", label: "Strength", type: "number", default: 1, min: 0, max: 1.5, step: 0.01, group: "Colours" },
  { key: "vignette", label: "Vignette", type: "number", default: 0.5, min: 0, max: 1, step: 0.01, group: "Colours" },
];

const str = (v: unknown, d: string) => (typeof v === "string" && v ? v : d);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const GLOW: [number, number][] = [[0, 1], [0.2, 0.82], [0.4, 0.5], [0.6, 0.22], [0.8, 0.06], [1, 0]];

function palette(layer: GfxLayer, rc: LayerRenderContext): Record<BgColor, string | CanvasGradient> {
  const p = layer.p;
  return {
    top: rc.paint(str(p.top, "@secondary"), "@secondary"), bottom: rc.paint(str(p.bottom, "@dark"), "@dark"),
    main: rc.paint(str(p.main, "@primary"), "@primary"), accent: rc.paint(str(p.accent, "@accent"), "@accent"),
    light: rc.paint(str(p.light, "@light"), "@light"), up: rc.paint("@up", "@up"), down: rc.paint("@down", "@down"),
  };
}

function drawPrim(g: Ctx2D, q: BgPrim, col: Record<BgColor, string | CanvasGradient>, base: number, k: number, rc: LayerRenderContext) {
  const a = Math.max(0, Math.min(1, q.a * k));
  if (a < 0.003) return;
  g.globalAlpha = base * a;
  const c = col[q.c];
  switch (q.k) {
    case "glow": {
      const gr = g.createRadialGradient(q.x, q.y, 0, q.x, q.y, q.r);
      const css = typeof c === "string" ? c : "#ffffff";
      // a soft falloff (roughly gaussian)
      for (const [s, f] of GLOW) gr.addColorStop(s, withAlpha(css, f));
      g.fillStyle = gr;
      g.fillRect(q.x - q.r, q.y - q.r, q.r * 2, q.r * 2);
      break;
    }
    case "dot": g.fillStyle = c; g.beginPath(); g.arc(q.x, q.y, Math.max(0.1, q.r), 0, Math.PI * 2); g.fill(); break;
    case "ring": g.strokeStyle = c; g.lineWidth = q.w; g.beginPath(); g.arc(q.x, q.y, Math.max(0.1, q.r), 0, Math.PI * 2); g.stroke(); break;
    case "line": {
      if (q.pts.length < 2) break;
      g.strokeStyle = c; g.lineWidth = q.w; g.lineCap = "round"; g.lineJoin = "round";
      g.beginPath(); g.moveTo(q.pts[0][0], q.pts[0][1]);
      for (let i = 1; i < q.pts.length; i++) g.lineTo(q.pts[i][0], q.pts[i][1]);
      if (q.closed) g.closePath();
      g.stroke();
      break;
    }
    case "poly": {
      if (q.pts.length < 3) break;
      g.fillStyle = c;
      g.beginPath(); g.moveTo(q.pts[0][0], q.pts[0][1]);
      for (let i = 1; i < q.pts.length; i++) g.lineTo(q.pts[i][0], q.pts[i][1]);
      g.closePath(); g.fill();
      break;
    }
    case "text": g.fillStyle = c; g.font = rc.font("@numbers", q.size, 600, q.s); g.textBaseline = "top"; g.textAlign = "left"; g.fillText(q.s, q.x, q.y); break;
  }
}

function drawBg(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext) {
  const [x, y, W, H] = layer.box;
  if (!(W > 0 && H > 0)) return;
  const P = bgParams(layer.p);
  const col = palette(layer, rc);
  g.save();
  g.translate(x, y);
  g.beginPath(); g.rect(0, 0, W, H); g.clip();
  const base = g.globalAlpha;
  const top = col.top, bottom = col.bottom;
  const lg = g.createLinearGradient(0, 0, 0, H);
  lg.addColorStop(0, typeof top === "string" ? top : "#101a33");
  lg.addColorStop(1, typeof bottom === "string" ? bottom : "#0a0f1e");
  g.fillStyle = lg;
  g.fillRect(0, 0, W, H);
  const k = Math.max(0, num(layer.p.intensity, 1));
  for (const q of bgScene(P, W, H, rc.t)) drawPrim(g, q, col, base, k, rc);
  g.globalAlpha = base;
  const v = Math.max(0, Math.min(1, num(layer.p.vignette, 0.5)));
  if (v > 0.01) {
    const R = Math.hypot(W, H) / 2;
    const vg = g.createRadialGradient(W / 2, H / 2, R * 0.35, W / 2, H / 2, R);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, `rgba(0,0,0,${(0.75 * v).toFixed(3)})`);
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
  }
  g.restore();
}

registerLayerKind({
  kind: "bg", label: "Animated background", group: "Motion", props: BG_PROPS,
  animates: () => true,
  fonts: (layer, rc) => (layer.p.style === "tape" ? [cssFont("@numbers", rc.look, 32, 600)] : []),
  draw: drawBg,
});

// ── countdown ────────────────────────────────────────────────────────────────

export const COUNTDOWN_PROPS: PropDef[] = [
  { key: "from", label: "Count from", type: "number", default: 10, min: 1, max: 99, step: 1, unit: "s" },
  { key: "delay", label: "Starts at", type: "number", default: 0, min: 0, max: 60, step: 0.1, unit: "s" },
  { key: "color", label: "Number colour", type: "paint", default: "@text" },
  { key: "ring", label: "Ring colour", type: "paint", default: "@accent" },
  { key: "track", label: "Ring track", type: "paint", default: "@light/20" },
  { key: "font", label: "Font", type: "font", default: "@numbers" },
  { key: "width", label: "Ring width", type: "number", default: 14, min: 0, max: 60, step: 1, unit: "px" },
];

/** The number shown and the progress at t (pure). */
export function countdownAt(p: Record<string, unknown>, t: number): { n: number; since: number; left: number } {
  const from = Math.max(1, Math.round(num(p.from, 10)));
  const e = t - Math.max(0, num(p.delay, 0));
  if (e < 0) return { n: from, since: 1, left: 1 };
  const rem = Math.max(0, from - e);
  return { n: Math.max(0, Math.ceil(rem - 1e-9)), since: e - Math.floor(e), left: rem / from };
}

registerLayerKind({
  kind: "countdown", label: "Countdown", group: "Data", props: COUNTDOWN_PROPS, ownsAnim: false,
  animates: () => true,
  fonts: (layer, rc) => [cssFont(str(layer.p.font, "@numbers"), rc.look, 120, 700)],
  draw(g, layer, rc) {
    const [x, y, w, h] = layer.box;
    const { n, since, left } = countdownAt(layer.p, rc.t);
    const cx = x + w / 2, cy = y + h / 2;
    const lw = Math.max(0, num(layer.p.width, 14));
    const R = Math.min(w, h) / 2 - lw;
    if (lw > 0 && R > 4) {
      g.lineWidth = lw; g.lineCap = "round";
      g.strokeStyle = rc.paint(str(layer.p.track, "@light/20"), "@light/20");
      g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = rc.paint(str(layer.p.ring, "@accent"), "@accent");
      g.beginPath(); g.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left); g.stroke();
    }
    const pop = 1 + 0.16 * Math.pow(1 - Math.min(1, since / 0.28), 3);
    const txt = rc.number(n, { decimals: 0 });
    g.save();
    g.translate(cx, cy); g.scale(pop, pop);
    g.font = rc.font(str(layer.p.font, "@numbers"), Math.min(w, h) * 0.46, 700, txt);
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = rc.paint(str(layer.p.color, "@text"), "@text");
    g.fillText(txt, 0, Math.min(w, h) * 0.02);
    g.restore();
  },
});
