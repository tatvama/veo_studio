/**
 * Layer kind "shine" (docs/EDITOR.md §16.3, nr-wipes): a soft band of light sweeping across its box or the whole frame
 * at an angle, once (period 0) or every `period` seconds. Put it above a plate or logo (`clip` confines it to another
 * layer's box) with blend "screen" or "add" for a glint. A pure function of t. Registers itself on import.
 */
import type { GfxLayer } from "../../types.ts";
import type { Ctx2D, LayerRenderContext, PropDef } from "../contract.ts";
import { withAlpha } from "../paint.ts";
import { registerLayerKind } from "../registry.ts";

export const SHINE_PROPS: PropDef[] = [
  { key: "area", label: "Sweeps across", type: "choice", default: "box", options: [{ value: "box", label: "Its box" }, { value: "frame", label: "The whole frame" }] },
  { key: "angle", label: "Angle", type: "number", default: 20, min: -180, max: 180, step: 1, unit: "°", hint: "0 = a straight band moving left to right" },
  { key: "width", label: "Band width", type: "number", default: 260, min: 10, max: 2000, step: 5, unit: "px" },
  { key: "color", label: "Colour", type: "paint", default: "#FFFFFF" },
  { key: "intensity", label: "Strength", type: "number", default: 0.5, min: 0, max: 1, step: 0.01 },
  { key: "period", label: "Every", type: "number", default: 8, min: 0, max: 60, step: 0.1, unit: "s", hint: "0 = once" },
  { key: "duration", label: "Sweep time", type: "number", default: 0.9, min: 0.1, max: 10, step: 0.05, unit: "s" },
  { key: "delay", label: "First sweep at", type: "number", default: 0.4, min: 0, max: 60, step: 0.05, unit: "s" },
];

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const smooth = (x: number) => x * x * (3 - 2 * x);

/** Where the band is at t: 0..1 across (null = resting between sweeps). Pure. */
export function shineAt(p: Record<string, unknown>, t: number): number | null {
  const delay = Math.max(0, num(p.delay, 0.4)), period = Math.max(0, num(p.period, 8)), dur = Math.max(0.05, num(p.duration, 0.9));
  const local = t - delay;
  if (local < 0) return null;
  const ph = period > 0 ? local % Math.max(period, dur) : local;
  return ph > dur ? null : smooth(ph / dur);
}

function draw(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext) {
  const x = shineAt(layer.p, rc.t);
  if (x === null) return;
  const frame = layer.p.area === "frame";
  const [bx, by, bw, bh] = frame ? [0, 0, rc.designW, rc.designH] : layer.box;
  const a = (num(layer.p.angle, 20) * Math.PI) / 180, nx = Math.cos(a), ny = Math.sin(a);
  const w = Math.max(10, num(layer.p.width, 260));
  // the area's extent along the band's normal
  let mn = Infinity, mx = -Infinity;
  for (const [cx, cy] of [[bx, by], [bx + bw, by], [bx, by + bh], [bx + bw, by + bh]]) { const d = cx * nx + cy * ny; mn = Math.min(mn, d); mx = Math.max(mx, d); }
  const c = mn - w + (mx - mn + 2 * w) * x;
  const col = rc.paint(typeof layer.p.color === "string" ? layer.p.color : "#FFFFFF", "#FFFFFF");
  const css = typeof col === "string" ? col : "#FFFFFF";
  const k = Math.max(0, Math.min(1, num(layer.p.intensity, 0.5)));
  const gr = g.createLinearGradient((c - w / 2) * nx, (c - w / 2) * ny, (c + w / 2) * nx, (c + w / 2) * ny);
  gr.addColorStop(0, withAlpha(css, 0));
  gr.addColorStop(0.3, withAlpha(css, k * 0.35));
  gr.addColorStop(0.5, withAlpha(css, k));
  gr.addColorStop(0.7, withAlpha(css, k * 0.35));
  gr.addColorStop(1, withAlpha(css, 0));
  g.fillStyle = gr;
  g.fillRect(bx, by, bw, bh);
}

registerLayerKind({
  kind: "shine", label: "Light sweep", group: "Motion", props: SHINE_PROPS, ownsAnim: false,
  animates: () => true,
  draw,
});
