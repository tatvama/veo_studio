/**
 * Layer kind "pins" (docs/EDITOR.md §16.3, nr-boards): the user's own map picture (an image blank; there is no
 * built-in map) with pins from a table blank (label, x, y as 0..1 of the picture, optional colour and note). Pins drop
 * in one after another with a little bounce and a shadow, pulse while shown, and get label tags that wipe out from
 * the pin; an optional route line draws through them in order, and one pin can be picked out. Without a picture a
 * quiet placeholder (grid and contours) is drawn so the board still reads. Owns its in / out.
 */
import type { GfxImageRef, GfxLayer } from "../../types.ts";
import type { Ctx2D, LayerRenderContext, PropDef } from "../contract.ts";
import { registerLayerKind } from "../registry.ts";
import { clamp01, easeBy, fitRect, pinDrop, pinsFrom, placeTags, progress, pulseAt, tableRows, tagRect, type Pin } from "../../boards/math.ts";
import { choices, fontsOf, fillPlate, inStart, layerMoves, P, pinPath, rrPath } from "../../boards/draw.ts";

const G = { m: "Map", d: "Pins", s: "Pin style", a: "Animation", t: "Tags", r: "Route" };
const PROPS: PropDef[] = [
  { key: "image", label: "Map picture blank", type: "field", default: "map", group: G.m, hint: "Your own map image" },
  { key: "fit", label: "Fit", type: "choice", default: "contain", group: G.m, options: choices("contain|Whole picture", "cover|Fill the box") },
  { key: "mapFill", label: "Behind the map", type: "paint", default: "@dark/70", group: G.m },
  { key: "grid", label: "Grid when empty", type: "bool", default: true, group: G.m },
  { key: "mapBorder", label: "Border", type: "paint", default: "@text/18", group: G.m },
  { key: "field", label: "Pins blank", type: "field", default: "pins", group: G.d, hint: "A table: label, x, y (0..1), colour, note" },
  { key: "labelCol", label: "Label column", type: "text", default: "label", group: G.d },
  { key: "xCol", label: "Across column", type: "text", default: "x", group: G.d },
  { key: "yCol", label: "Down column", type: "text", default: "y", group: G.d },
  { key: "style", label: "Pin", type: "choice", default: "drop", group: G.s, options: choices("drop|Map pin", "dot|Dot", "ring|Ring") },
  { key: "pinColor", label: "Pin colour", type: "paint", default: "@breaking", group: G.s, hint: "Rows with a colour use theirs" },
  { key: "pinSize", label: "Pin size", type: "number", default: 48, min: 10, max: 200, unit: "px", group: G.s },
  { key: "focus", label: "Pick out pin", type: "number", default: 0, min: 0, max: 30, step: 1, group: G.s, hint: "Pin number; 0 = none" },
  { key: "delay", label: "First pin after", type: "number", default: 0.45, min: 0, max: 20, step: 0.05, unit: "s", group: G.a },
  { key: "stagger", label: "Between pins", type: "number", default: 0.3, min: 0, max: 5, step: 0.05, unit: "s", group: G.a },
  { key: "dropDur", label: "Drop", type: "number", default: 0.6, min: 0.1, max: 3, step: 0.05, unit: "s", group: G.a },
  { key: "pulse", label: "Pulse", type: "bool", default: true, group: G.a },
  { key: "pulsePeriod", label: "Pulse every", type: "number", default: 1.8, min: 0.4, max: 10, step: 0.1, unit: "s", group: G.a },
  { key: "tags", label: "Label tags", type: "bool", default: true, group: G.t },
  { key: "tagFill", label: "Tag colour", type: "paint", default: "@dark/90", group: G.t },
  { key: "tagColor", label: "Tag text", type: "paint", default: "@text", group: G.t },
  { key: "tagFont", label: "Tag font", type: "font", default: "@body", group: G.t },
  { key: "tagSize", label: "Tag size", type: "number", default: 30, min: 10, max: 100, unit: "px", group: G.t },
  { key: "tagUpper", label: "Tags in capitals (look)", type: "bool", default: true, group: G.t },
  { key: "route", label: "Route line", type: "bool", default: false, group: G.r, hint: "Joins the pins in order" },
  { key: "routeColor", label: "Route colour", type: "paint", default: "@accent", group: G.r },
];

type Box = [number, number, number, number];

function pinsOf(layer: GfxLayer, rc: Pick<LayerRenderContext, "value">): Pin[] {
  const p = layer.p;
  return pinsFrom(tableRows(rc.value(P.str(p, "field", "pins"))), { label: P.str(p, "labelCol", "label"), x: P.str(p, "xCol", "x"), y: P.str(p, "yCol", "y") });
}
const mapRef = (layer: GfxLayer, rc: Pick<LayerRenderContext, "value">): GfxImageRef | string | null => {
  const v = rc.value(P.str(layer.p, "image", "map"));
  return v && typeof v === "object" && "mediaId" in (v as object) ? (v as GfxImageRef) : typeof v === "string" && v ? v : null;
};
const sizeOf = (img: CanvasImageSource): [number, number] => {
  const o = img as unknown as { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number; width?: number | { baseVal?: { value: number } }; height?: number | { baseVal?: { value: number } } };
  const w = o.naturalWidth || o.videoWidth || (typeof o.width === "number" ? o.width : o.width?.baseVal?.value) || 0;
  const h = o.naturalHeight || o.videoHeight || (typeof o.height === "number" ? o.height : o.height?.baseVal?.value) || 0;
  return [w, h];
};

/** A calm stand-in map: a fine grid and a few contour lines, the same every frame. */
function placeholder(g: Ctx2D, rc: LayerRenderContext, [x, y, w, h]: Box): void {
  g.save();
  g.strokeStyle = rc.paint("@text/7");
  g.lineWidth = 1.5;
  const step = Math.max(24, Math.min(w, h) / 14);
  g.beginPath();
  for (let gx = x + step; gx < x + w; gx += step) { g.moveTo(gx, y); g.lineTo(gx, y + h); }
  for (let gy = y + step; gy < y + h; gy += step) { g.moveTo(x, gy); g.lineTo(x + w, gy); }
  g.stroke();
  g.strokeStyle = rc.paint("@text/10");
  g.lineWidth = 2;
  for (let k = 0; k < 3; k++) {
    const cx = x + w * (0.25 + 0.5 * rc.rand(k * 3 + 1)), cy = y + h * (0.25 + 0.5 * rc.rand(k * 3 + 2));
    const base = Math.min(w, h) * (0.14 + 0.12 * rc.rand(k * 3 + 3));
    for (let ring = 0; ring < 4; ring++) {
      const R = base * (1 + ring * 0.45);
      g.beginPath();
      for (let a = 0; a <= 48; a++) {
        const th = (a / 48) * Math.PI * 2;
        const wob = 1 + 0.14 * Math.sin(th * 3 + k * 1.7 + ring * 0.4) + 0.07 * Math.sin(th * 5 + k);
        const px = cx + Math.cos(th) * R * wob * 1.25, py = cy + Math.sin(th) * R * wob * 0.85;
        if (a === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
      g.stroke();
    }
  }
  g.restore();
}

function draw(g: Ctx2D, layer: GfxLayer, rc: LayerRenderContext): void {
  const p = layer.p, box = layer.box as Box, [x, y, w, h] = box;
  const radius = rc.look.plate === "rounded" || rc.look.plate === "glass" ? rc.look.radius : 0;
  // the map
  g.save();
  rrPath(g, x, y, w, h, radius);
  g.fillStyle = rc.paint(P.paint(p, "mapFill", "@dark/70"));
  g.fill();
  g.clip();
  const ref = mapRef(layer, rc);
  const img = ref ? rc.image(ref) : null;
  let area: Box = box;
  if (img) {
    const [iw, ih] = sizeOf(img);
    area = fitRect(iw, ih, box, P.str(p, "fit", "contain") === "cover" ? "cover" : "contain");
    g.drawImage(img, area[0], area[1], area[2], area[3]);
  } else if (P.bool(p, "grid", true)) placeholder(g, rc, box);
  g.restore();
  g.save();
  rrPath(g, x + 1, y + 1, w - 2, h - 2, radius);
  g.strokeStyle = rc.paint(P.paint(p, "mapBorder", "@text/18"));
  g.lineWidth = 2;
  g.stroke();
  g.restore();

  const pins = pinsOf(layer, rc);
  if (!pins.length) return;
  const size = P.num(p, "pinSize", 48);
  const start = inStart(layer) + P.num(p, "delay", 0.45), st = P.num(p, "stagger", 0.3), dd = P.num(p, "dropDur", 0.6);
  const pos = pins.map((pn) => [area[0] + pn.x * area[2], area[1] + pn.y * area[3]] as [number, number]);
  const focus = Math.round(P.num(p, "focus", 0)) - 1;
  const style = P.str(p, "style", "drop");
  // route: draws through the pins as they land
  if (P.bool(p, "route", false) && pins.length > 1) {
    const segs = pos.slice(1).map((q, i) => Math.hypot(q[0] - pos[i][0], q[1] - pos[i][1]));
    const total = segs.reduce((a, b) => a + b, 0);
    const rp = easeBy("ease_in_out", progress(rc.t, start + dd * 0.6, st * (pins.length - 1) + dd * 0.4)) * total;
    g.save();
    g.strokeStyle = rc.paint(P.paint(p, "routeColor", "@accent"));
    g.lineWidth = Math.max(3, size * 0.1);
    g.setLineDash([size * 0.28, size * 0.18]);
    g.lineCap = "round";
    g.beginPath(); g.moveTo(pos[0][0], pos[0][1]);
    let left = rp;
    for (let i = 0; i < segs.length && left > 0; i++) {
      const k = Math.min(1, left / Math.max(1e-6, segs[i]));
      g.lineTo(pos[i][0] + (pos[i + 1][0] - pos[i][0]) * k, pos[i][1] + (pos[i + 1][1] - pos[i][1]) * k);
      left -= segs[i];
    }
    g.stroke();
    g.restore();
  }
  // tag sizes, then each tag's side (static: earlier pins keep the better spots)
  const tagFont = P.str(p, "tagFont", "@body");
  const tags = pins.map((pn, i) => {
    const ts = P.num(p, "tagSize", 30) * (i === focus ? 1.12 : 1);
    const label = rc.text(pn.label, P.bool(p, "tagUpper", true));
    const note = pn.note ? rc.text(pn.note) : "";
    g.font = rc.font(tagFont, ts, 700, label);
    const lw = g.measureText(label).width;
    let nw = 0;
    if (note) { g.font = rc.font(tagFont, ts * 0.72, 500, note); nw = g.measureText(note).width; }
    return { ts, label, note, w: Math.max(lw, nw) + ts * 1.1, h: ts * (note ? 2.25 : 1.5) };
  });
  const sides = placeTags(pos, tags.map((t) => [t.w, t.h]), [x, y, w, h], size);
  // pass 1: shadows, pulses and pins
  pins.forEach((pn, i) => {
    const t0 = start + i * st;
    const d = pinDrop(rc.t, t0, dd);
    if (d.a <= 0) return;
    const [px, py] = pos[i];
    const s = size * (i === focus ? 1.3 : 1);
    const col = rc.paint(pn.color ?? (i === focus ? "@accent" : P.paint(p, "pinColor", "@breaking")));
    const landed = rc.t - (t0 + dd * 0.4);
    g.save();
    g.globalAlpha *= d.a;
    const lift = clamp01(-d.y / 1.6);
    g.fillStyle = "rgba(0,0,0,0.35)";
    g.beginPath(); g.ellipse(px, py, s * 0.26 * (1 - lift * 0.5), s * 0.09 * (1 - lift * 0.5), 0, 0, Math.PI * 2); g.fill();
    const period = P.num(p, "pulsePeriod", 1.8);
    if (P.bool(p, "pulse", true) && landed > 0) {
      for (const at of [landed, landed - period / 2]) {
        if (at <= 0) continue;
        const k = pulseAt(at, period);
        g.save();
        g.strokeStyle = col;
        g.globalAlpha *= (1 - k) * 0.7;
        g.lineWidth = Math.max(2, s * 0.06);
        g.beginPath(); g.ellipse(px, py, s * (0.2 + k * 0.9), s * (0.08 + k * 0.36), 0, 0, Math.PI * 2); g.stroke();
        g.restore();
      }
    }
    g.translate(px, py + d.y * s);
    g.scale(1 + (1 - d.s) * 0.8, d.s);
    g.fillStyle = col;
    if (style === "dot" || style === "ring") {
      const r = s * 0.24;
      g.beginPath(); g.arc(0, -r, r, 0, Math.PI * 2);
      if (style === "ring") { g.lineWidth = r * 0.45; g.strokeStyle = col; g.stroke(); g.fillStyle = "#ffffff"; g.beginPath(); g.arc(0, -r, r * 0.42, 0, Math.PI * 2); }
      g.fill();
    } else {
      pinPath(g, 0, 0, s);
      g.shadowColor = "rgba(0,0,0,0.35)"; g.shadowBlur = s * 0.2; g.shadowOffsetY = s * 0.06;
      g.fill();
      g.shadowColor = "transparent"; g.shadowBlur = 0; g.shadowOffsetY = 0;
      g.fillStyle = "#ffffff";
      g.beginPath(); g.arc(0, -s + s * 0.42, s * 0.16, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  });
  // pass 2: tags on top, each wiping out from its pin once it has landed
  if (!P.bool(p, "tags", true)) return;
  pins.forEach((pn, i) => {
    if (!pn.label) return;
    const t0 = start + i * st;
    const te = easeBy("quint", progress(rc.t, t0 + dd * 0.55, 0.4));
    if (te <= 0) return;
    const tg = tags[i], side = sides[i];
    const s = size * (i === focus ? 1.3 : 1);
    const col = rc.paint(pn.color ?? (i === focus ? "@accent" : P.paint(p, "pinColor", "@breaking")));
    const [rx0, ry0] = tagRect(side, pos[i][0], pos[i][1], tg.w, tg.h, s);
    const tx = Math.max(x + 4, Math.min(x + w - tg.w - 4, rx0)), ty = Math.max(y + 4, Math.min(y + h - tg.h - 4, ry0));
    const { ts, label, note } = tg;
    g.save();
    g.beginPath();
    if (side === "right") g.rect(tx - 2, ty - 4, (tg.w + 6) * te, tg.h + 8);
    else if (side === "left") g.rect(tx + tg.w * (1 - te) - 4, ty - 4, tg.w * te + 6, tg.h + 8);
    else if (side === "above") g.rect(tx - 4, ty + tg.h * (1 - te) - 4, tg.w + 8, tg.h * te + 6);
    else g.rect(tx - 4, ty - 2, tg.w + 8, (tg.h + 6) * te);
    g.clip();
    fillPlate(g, rc, tx, ty, tg.w, tg.h, P.paint(p, "tagFill", "@dark/90"), { slant: 0, radius: Math.min(rc.look.radius, 8) });
    g.fillStyle = col;
    const sw = Math.max(4, ts * 0.14);
    if (side === "left") g.fillRect(tx + tg.w - sw, ty, sw, tg.h);
    else if (side === "right") g.fillRect(tx, ty, sw, tg.h);
    else g.fillRect(tx, side === "above" ? ty + tg.h - sw : ty, tg.w, sw);
    g.textAlign = "left"; g.textBaseline = "middle";
    g.font = rc.font(tagFont, ts, 700, label);
    g.fillStyle = rc.paint(P.paint(p, "tagColor", "@text"));
    const lx = tx + (side === "left" ? ts * 0.5 : ts * 0.6);
    g.fillText(label, lx, ty + (note ? ts * 0.78 : tg.h / 2) + ts * 0.02);
    if (note) {
      g.font = rc.font(tagFont, ts * 0.72, 500, note);
      g.globalAlpha *= 0.8;
      g.fillText(note, lx, ty + ts * 1.62);
    }
    g.restore();
  });
}

registerLayerKind({
  kind: "pins", label: "Map pins", group: "Data", props: PROPS, ownsAnim: true,
  animates: () => true,
  draw(g, layer, rc) {
    g.save();
    if (layerMoves(g, layer, rc, "fade")) draw(g, layer, rc);
    g.restore();
  },
  fonts: (layer, rc) => fontsOf(rc.look, [[layer.p.tagFont ?? "@body", 700], [layer.p.tagFont ?? "@body", 500]], pinsOf(layer, rc).map((x) => x.label)),
  images: (layer, rc) => {
    const r = mapRef(layer, rc);
    return r ? [typeof r === "string" ? r : r.mediaId] : [];
  },
});
