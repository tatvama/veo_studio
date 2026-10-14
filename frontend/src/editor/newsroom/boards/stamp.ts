/**
 * Layer kind "stamp" (nr-boards; registered with the board kinds by render/kinds/list.ts): a rubber-stamp verdict for
 * fact checks (TRUE, FALSE, MISLEADING …) whose colour and icon follow the word it shows, through a tone map that
 * knows Hindi words too, so a choice blank alone sets both. It slams in (big → its size, a small turn), shakes, and
 * leaves an ink ring; a double border and a light tint make it read as a stamp. Owns its in / out.
 */
import type { GfxLayer } from "../types.ts";
import type { Ctx2D, LayerRenderContext, PropDef } from "../render/contract.ts";
import { drawIcon } from "../render/icons.ts";
import { registerLayerKind } from "../render/registry.ts";
import { clamp01, easeBy, progress } from "./math.ts";
import { easeIn, fontsOf, inStart, P, rrPath } from "./draw.ts";

export const STAMP_TONES = "True=@up, Correct=@up, Fact=@up, Verified=@up, सच=@up, सही=@up, False=@breaking, Fake=@breaking, Wrong=@breaking, झूठ=@breaking, फर्जी=@breaking, गलत=@breaking, Misleading=@accent, Partly true=@accent, Half true=@accent, भ्रामक=@accent, Unverified=@light, Unproven=@light";
export const STAMP_ICONS = "True=check_circle, Correct=check_circle, Fact=check_circle, Verified=check_circle, सच=check_circle, सही=check_circle, False=cross_circle, Fake=cross_circle, Wrong=cross_circle, झूठ=cross_circle, फर्जी=cross_circle, गलत=cross_circle, Misleading=warning, Partly true=warning, Half true=warning, भ्रामक=warning, Unverified=info, Unproven=info";

const PROPS: PropDef[] = [
  { key: "text", label: "Text", type: "text", default: "{verdict}", group: "Stamp", hint: "Use {field} for a blank" },
  { key: "tones", label: "Colours by word", type: "longtext", default: STAMP_TONES, group: "Stamp", hint: "Word=colour, … (the first match wins)" },
  { key: "color", label: "Other words", type: "paint", default: "@breaking", group: "Stamp" },
  { key: "showIcon", label: "Icon", type: "bool", default: true, group: "Stamp" },
  { key: "icons", label: "Icons by word", type: "longtext", default: STAMP_ICONS, group: "Stamp" },
  { key: "font", label: "Font", type: "font", default: "@headline", group: "Text" },
  { key: "size", label: "Size", type: "number", default: 120, min: 20, max: 400, unit: "px", group: "Text" },
  { key: "weight", label: "Weight", type: "number", default: 800, min: 100, max: 900, step: 100, group: "Text" },
  { key: "upper", label: "Capitals", type: "bool", default: true, group: "Text" },
  { key: "angle", label: "Tilt", type: "number", default: -8, min: -45, max: 45, step: 1, unit: "°", group: "Stamp" },
  { key: "tint", label: "Tint", type: "number", default: 0.16, min: 0, max: 1, step: 0.02, group: "Stamp" },
  { key: "delay", label: "Lands after", type: "number", default: 0, min: 0, max: 20, step: 0.05, unit: "s", group: "Motion" },
  { key: "dur", label: "Slam", type: "number", default: 0.42, min: 0.1, max: 2, step: 0.02, unit: "s", group: "Motion" },
  { key: "shake", label: "Shake", type: "bool", default: true, group: "Motion" },
];

/** The value a "Word=value, …" map gives a word (case-insensitive; the first match wins), or "". */
export function byWord(map: string, word: string): string {
  const w = word.trim().toLowerCase();
  for (const part of map.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim().toLowerCase() === w) return part.slice(i + 1).trim();
  }
  return "";
}

function draw(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext): void {
  const p = layer.p, [x, y, w, h] = layer.box;
  const word = rc.text(P.str(p, "text", "{verdict}")).trim();
  if (!word) return;
  const shown = P.bool(p, "upper", true) ? word.toUpperCase() : word;
  const paint = byWord(P.str(p, "tones", STAMP_TONES), word) || (P.paint(p, "color", "@breaking") as string);
  const col = rc.paint(paint);
  const iconName = P.bool(p, "showIcon", true) ? byWord(P.str(p, "icons", STAMP_ICONS), word) : "";
  const font = P.str(p, "font", "@headline"), weight = P.num(p, "weight", 800);
  let s = P.num(p, "size", 120);
  const widthAt = (z: number) => { g.font = rc.font(font, z, weight, shown); return g.measureText(shown).width + (iconName ? z * 1.05 : 0) + z * 0.8; };
  const need = widthAt(s);
  if (need > w * 0.96) s *= (w * 0.96) / need;
  s = Math.min(s, h / 1.6);
  const sw = widthAt(s), sh = s * 1.42;
  const cx = x + w / 2, cy = y + h / 2;
  // slam: from big and turned, overshoot, then a short shake and an ink ring
  const t0 = inStart(layer) + P.num(p, "delay", 0), dur = P.num(p, "dur", 0.42);
  const pr = progress(rc.t, t0, dur);
  if (pr <= 0) return;
  const e = easeBy("expo", pr);
  const since = rc.t - (t0 + dur);
  let dx = 0, dy = 0;
  if (P.bool(p, "shake", true) && since > 0 && since < 0.3) {
    const k = (1 - since / 0.3) * s * 0.05;
    dx = Math.sin(since * 70) * k; dy = Math.cos(since * 55) * k * 0.6;
  }
  const scale = 1 + (1 - e) * 1.3;
  const angle = P.num(p, "angle", -8) + (1 - e) * -14;
  const out = rc.phase.out < 1 ? easeIn(rc, rc.phase.out) : 1;
  g.save();
  g.globalAlpha *= clamp01(pr * 3) * out;
  g.translate(cx + dx, cy + dy);
  g.rotate((angle * Math.PI) / 180);
  g.scale(scale * (out < 1 ? 1 + (1 - out) * 0.15 : 1), scale * (out < 1 ? 1 + (1 - out) * 0.15 : 1));
  const bx = -sw / 2, by = -sh / 2, r = s * 0.14;
  // ink ring after it lands
  if (since > 0 && since < 0.6) {
    const k = since / 0.6;
    g.save();
    g.globalAlpha *= (1 - k) * 0.6;
    g.strokeStyle = col; g.lineWidth = s * 0.05;
    const grow = 1 + k * 0.28;
    rrPath(g, bx * grow, by * grow, sw * grow, sh * grow, r * grow);
    g.stroke();
    g.restore();
  }
  // tint, double border
  rrPath(g, bx, by, sw, sh, r);
  g.save(); g.globalAlpha *= P.num(p, "tint", 0.16); g.fillStyle = col; g.fill(); g.restore();
  g.strokeStyle = col;
  g.lineWidth = s * 0.075; rrPath(g, bx, by, sw, sh, r); g.stroke();
  const ins = s * 0.13;
  g.lineWidth = s * 0.03; rrPath(g, bx + ins, by + ins, sw - ins * 2, sh - ins * 2, Math.max(2, r - ins * 0.6)); g.stroke();
  // icon and word
  let tx = bx + s * 0.4;
  if (iconName) {
    const is = s * 0.82;
    drawIcon(g, iconName, tx, -is / 2, is, is, col, "#FFFFFF");
    tx += s * 1.05;
  }
  g.font = rc.font(font, s, weight, shown);
  g.fillStyle = col; g.textAlign = "left"; g.textBaseline = "middle";
  g.fillText(shown, tx, s * 0.04);
  g.restore();
}

registerLayerKind({
  kind: "stamp", label: "Stamp", group: "Text", props: PROPS, ownsAnim: true,
  animates: () => true,
  draw(g, layer, rc) { g.save(); draw(g, layer, rc); g.restore(); },
  fonts: (layer, rc) => fontsOf(rc.look, [[layer.p.font ?? "@headline", P.num(layer.p, "weight", 800)]], [rc.text(P.str(layer.p, "text", "{verdict}"))]),
});

