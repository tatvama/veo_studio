/**
 * The Wipe Designer's model (docs/EDITOR.md §16.8, nr-wipes): a `WipeSpec` (shape, count, angle, edge, order,
 * stagger, length, cut, hold, ease, overshoot, exit, colours from the look's palette, finish, edge line, logo reveal,
 * flash, headline, motion trail, shadow, seed) becomes a stinger template with one "panels" layer per ratio. The
 * coverage check proves the frame is 100 % covered around the cut in 16:9 and 9:16 (exactly what the kind draws), and
 * Randomise picks tasteful, seeded variations. Every built-in stinger (templates/stingers.ts) is a spec too. Pure.
 */
import { DESIGN, field, layer, tpl } from "../templates/kit.ts";
import type { ChannelLook, GfxLayer, GfxRatio, GfxTemplate } from "../types.ts";
import {
  coverageOf, MIN_HOLD, type CoverShape, motionOf, panelShapes, PANEL_MOTION_DEFAULTS,
  type PanelEase, type PanelEdge, type PanelExit, type PanelLayout, type PanelOrder, type PanelShape,
} from "./geometry.ts";

/** Look colours a wipe may use (the Designer offers these as swatches). */
export type PaletteSlot = "primary" | "secondary" | "accent" | "dark" | "light" | "breaking" | "live";
export const PALETTE_SLOTS: { value: PaletteSlot; label: string }[] = [
  { value: "primary", label: "Primary" }, { value: "secondary", label: "Secondary" }, { value: "accent", label: "Accent" },
  { value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "breaking", label: "Breaking" }, { value: "live", label: "Live" },
];

export interface WipeSpec {
  layout: PanelLayout; edge: PanelEdge;
  count: number;
  /** Travel direction, degrees (0 = left → right). */
  angle: number;
  /** Edge shape depth 0..1. */
  depth: number;
  order: PanelOrder;
  /** Seconds between panels. */
  stagger: number;
  /** Total length, seconds. */
  seconds: number;
  /** Where the cut sits (fraction of the length). */
  cut: number;
  /** Seconds fully covered around the cut. */
  hold: number;
  ease: PanelEase; overshoot: number; exit: PanelExit;
  /** Panel colours, bottom panel first (bars and tiles cycle through them). */
  colors: PaletteSlot[];
  finish: "flat" | "gradient" | "glass";
  /** Edge line width (design px, 0 = none) and colour. */
  line: number; lineColor: PaletteSlot;
  logo: boolean;
  /** 0..1 */
  flash: number;
  /** A headline on the cut ("" = none); it becomes the template's "text" field. */
  text: string;
  textPlate: PaletteSlot | "";
  textStyle: "slam" | "slide" | "rise";
  /** Motion trail ("blur feel") and shadow, 0..1. */
  blur: number; shadow: number;
  seed: number;
  /** Circles / tiles: where they start (fractions of the frame). */
  cx: number; cy: number;
  /** A light sweep across the frame on the cut. */
  sweep: boolean;
  /** Changes for the 9:16 design only. */
  vertical?: Partial<Pick<WipeSpec, "angle" | "count" | "cx" | "cy" | "depth">>;
}

export const WIPE_DEFAULTS: WipeSpec = {
  layout: "stack", edge: "slant", count: 3, angle: 0, depth: 0.3, order: "forward", stagger: 0.07, seconds: 1.2, cut: 0.5,
  hold: 0.16, ease: "smooth", overshoot: 0.4, exit: "continue", colors: ["accent", "secondary", "primary"], finish: "gradient",
  line: 0, lineColor: "accent", logo: false, flash: 0, text: "", textPlate: "", textStyle: "slam", blur: 0.3, shadow: 0.3,
  seed: 1, cx: 0.5, cy: 0.5, sweep: false,
};

/** A complete spec from a partial one. */
export const wipeSpec = (s: Partial<WipeSpec> = {}): WipeSpec => ({ ...WIPE_DEFAULTS, ...s, colors: s.colors?.length ? [...s.colors] : [...WIPE_DEFAULTS.colors] });

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/** The panels layer's `p` for a spec (in a ratio). */
export function panelsProps(s: WipeSpec, ratio: GfxRatio = "16:9"): Record<string, unknown> {
  const v = ratio === "9:16" ? s.vertical ?? {} : {};
  const c = s.colors.slice(0, 4);
  return {
    layout: s.layout, edge: s.edge, count: v.count ?? s.count, angle: v.angle ?? s.angle, depth: v.depth ?? s.depth, order: s.order,
    stagger: s.stagger, cut: s.cut, hold: Math.max(MIN_HOLD, s.hold), ease: s.ease, overshoot: s.overshoot, exit: s.exit, seed: s.seed,
    cx: v.cx ?? s.cx, cy: v.cy ?? s.cy,
    color1: c[0] ? `@${c[0]}` : "", color2: c[1] ? `@${c[1]}` : "", color3: c[2] ? `@${c[2]}` : "", color4: c[3] ? `@${c[3]}` : "",
    style: s.finish, lineWidth: s.line, lineColor: `@${s.lineColor}`, blur: s.blur, shadow: s.shadow,
    logo: s.logo, logoColor: "@textOnPrimary", text: s.text ? "{text}" : "", textColor: "@textOnPrimary",
    textPlate: s.textPlate ? `@${s.textPlate}` : "", textStyle: s.textStyle, flash: s.flash, flashColor: "#FFFFFF",
  };
}

function designLayers(s: WipeSpec, ratio: GfxRatio): GfxLayer[] {
  const { w, h } = DESIGN[ratio];
  const out: GfxLayer[] = [layer("panels", "panels", [0, 0, w, h], panelsProps(s, ratio), { name: "Panels", pin: { x: "stretch", y: "stretch" } })];
  if (s.sweep) {
    const at = s.cut * s.seconds;
    out.push(layer("shine", "sweep", [0, 0, w, h], {
      area: "frame", angle: 24, width: ratio === "9:16" ? 520 : 640, color: "#FFFFFF", intensity: 0.5, period: 0, duration: 0.62,
      delay: Math.max(0, at - 0.3),
    }, { name: "Light sweep", blend: "screen", pin: { x: "stretch", y: "stretch" } }));
  }
  return out;
}

export interface StingerMeta { id: string; name: string; description?: string; tags?: string[]; sounds?: GfxTemplate["sounds"] }

/** The stinger template a spec makes (16:9 and 9:16, `cut` set, fully opaque at the cut). */
export function stingerTemplate(spec: Partial<WipeSpec>, meta: StingerMeta): GfxTemplate {
  const s = wipeSpec(spec);
  const sec = round(Math.max(0.4, s.seconds), 3);
  const t = tpl({
    id: meta.id, name: meta.name, category: "Stingers", role: "wipe", kind: "stinger",
    description: meta.description, tags: meta.tags,
    seconds: sec, timing: { in: round(s.cut * sec), out: round((1 - s.cut) * sec) },
    fields: s.text ? [field.text("text", "Headline", s.text, { maxLength: 28, hint: "Shown on the cut" })] : [],
    designs: { "16:9": designLayers(s, "16:9"), "9:16": designLayers(s, "9:16") },
    hold: "fixed", cut: s.cut, sounds: meta.sounds ?? { in: "whoosh", cut: s.flash > 0.3 || s.logo ? "impact" : "swish" },
  });
  return t;
}

/** The spec a stinger template was made from (its 16:9 panels layer), or null when it has none. */
export function specFromTemplate(t: GfxTemplate): WipeSpec | null {
  const l = t.designs["16:9"]?.layers.find((x) => x.kind === "panels") ?? t.designs["9:16"]?.layers.find((x) => x.kind === "panels");
  if (!l) return null;
  const p = l.p;
  const m = motionOf(p);
  const slot = (v: unknown): PaletteSlot | null => (typeof v === "string" && v.startsWith("@") && PALETTE_SLOTS.some((x) => x.value === v.slice(1)) ? (v.slice(1) as PaletteSlot) : null);
  const colors = [p.color1, p.color2, p.color3, p.color4].map(slot).filter((x): x is PaletteSlot => !!x);
  const txt = t.fields.find((f) => f.id === "text");
  const v = t.designs["9:16"]?.layers.find((x) => x.kind === "panels")?.p;
  const vertical: WipeSpec["vertical"] = {};
  if (v) {
    const mv = motionOf(v);
    if (mv.angle !== m.angle) vertical.angle = mv.angle;
    if (mv.count !== m.count) vertical.count = mv.count;
    if (mv.cx !== m.cx) vertical.cx = mv.cx;
    if (mv.cy !== m.cy) vertical.cy = mv.cy;
    if (mv.depth !== m.depth) vertical.depth = mv.depth;
  }
  const finish = p.style === "flat" || p.style === "glass" ? p.style : "gradient";
  const ts = p.textStyle === "slide" || p.textStyle === "rise" ? p.textStyle : "slam";
  return wipeSpec({
    layout: m.layout, edge: m.edge, count: m.count, angle: m.angle, depth: m.depth, order: m.order, stagger: m.stagger,
    seconds: t.seconds || 1.2, cut: t.cut ?? m.cut, hold: m.hold, ease: m.ease, overshoot: m.overshoot, exit: m.exit,
    colors: colors.length ? colors : undefined, finish, line: Number(p.lineWidth) || 0, lineColor: slot(p.lineColor) ?? "accent",
    logo: p.logo === true, flash: Number(p.flash) || 0, text: typeof txt?.default === "string" && p.text ? txt.default : "",
    textPlate: slot(p.textPlate) ?? "", textStyle: ts, blur: typeof p.blur === "number" ? p.blur : 0.3,
    shadow: typeof p.shadow === "number" ? p.shadow : 0.3, seed: m.seed, cx: m.cx, cy: m.cy,
    sweep: !!t.designs["16:9"]?.layers.some((x) => x.kind === "shine"),
    ...(Object.keys(vertical).length ? { vertical } : {}),
  });
}

// ── coverage check ───────────────────────────────────────────────────────────

export interface RatioCoverage { ratio: GfxRatio; covered: number; where: string[]; times: number[] }
export interface StingerCheck { ok: boolean; reasons: string[]; ratios: RatioCoverage[] }

/** The opaque shapes of a design's panels layers at t (design px), for checks and previews. */
export function designShapes(t: GfxTemplate, ratio: GfxRatio, at: number, dur = t.seconds): (PanelShape & CoverShape)[] {
  const d = t.designs[ratio];
  const out: (PanelShape & CoverShape)[] = [];
  for (const l of d?.layers ?? []) {
    if (l.hidden || l.kind !== "panels") continue;
    const [x, y, w, h] = l.box;
    for (const s of panelShapes(motionOf(l.p), w, h, dur, at)) {
      out.push({ ...s, pts: s.pts.map(([a, b]) => [a + x, b + y]), holes: s.holes?.map((hh) => hh.map(([a, b]) => [a + x, b + y])), clip: [x, y, x + w, y + h] });
    }
  }
  return out;
}

const pct = (x: number) => (x >= 0.1 ? `${Math.round(x * 100)} %` : `${(x * 100).toFixed(1)} %`);

/**
 * Proves a stinger hides its cut: in 16:9 and 9:16 the frame must be 100 % covered at the cut and just either side of
 * it (the cut frame and its neighbours at 24 fps). `step` is the scan-line spacing in design px.
 */
export function checkStinger(t: GfxTemplate, step = 10): StingerCheck {
  const reasons: string[] = [];
  const ratios: RatioCoverage[] = [];
  const cut = t.cut;
  if (cut === undefined || !(cut > 0 && cut < 1)) return { ok: false, reasons: ["The stinger has no cut point."], ratios };
  const T = Math.max(0.2, t.seconds || 1);
  const tc = cut * T, h = MIN_HOLD / 2 - 0.004;
  const times = [tc - h, tc, tc + h];
  for (const ratio of ["16:9", "9:16"] as GfxRatio[]) {
    const d = t.designs[ratio];
    if (!d) { reasons.push(`There is no ${ratio} design.`); continue; }
    if (!d.layers.some((l) => l.kind === "panels" && !l.hidden)) { reasons.push(`The ${ratio} design has no panels to cover the cut.`); continue; }
    const { w, h: H } = DESIGN[ratio];
    let worst = 1;
    const where = new Set<string>();
    for (const at of times) {
      const c = coverageOf(designShapes(t, ratio, at, T), w, H, step);
      if (c.covered < worst) worst = c.covered;
      if (c.covered < 1 - 1e-6) c.where.forEach((x) => where.add(x));
    }
    ratios.push({ ratio, covered: worst, where: [...where], times });
    if (worst < 1 - 1e-6) {
      reasons.push(`At the cut the ${ratio} frame isn't fully covered: ${pct(1 - worst)} shows through${where.size ? ` at ${[...where].slice(0, 3).join(", ")}` : ""}.`);
    }
  }
  return { ok: reasons.length === 0, reasons, ratios };
}

/** The check for a spec (the template it would make). */
export const checkSpec = (s: Partial<WipeSpec>, step = 12): StingerCheck => checkStinger(stingerTemplate(s, { id: "check", name: "Check" }), step);

// ── Randomise ────────────────────────────────────────────────────────────────

/** A small seeded generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = (seed | 0) ^ 0x5bd1e995;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function weighted<T>(r: () => number, list: [T, number][]): T {
  const sum = list.reduce((s, [, w]) => s + w, 0);
  let x = r() * sum;
  for (const [v, w] of list) { x -= w; if (x <= 0) return v; }
  return list[list.length - 1][0];
}
const between = (r: () => number, a: number, b: number, d = 2) => round(a + (b - a) * r(), d);

/** Palettes that sit well together, bottom panel first; the last is the plate the logo sits on. */
const PALETTES: PaletteSlot[][] = [
  ["accent", "secondary", "primary"], ["secondary", "primary"], ["accent", "primary"], ["primary", "secondary"],
  ["light", "accent", "primary"], ["dark", "primary", "secondary"], ["accent", "dark", "primary"], ["primary", "dark"],
  ["secondary", "accent", "secondary"], ["primary", "accent", "secondary"],
];
const PLATE_OK = new Set<PaletteSlot>(["primary", "secondary", "dark", "breaking"]);

/**
 * A tasteful random wipe for a look: sensible counts and timing per shape, the look's motion style, colours from its
 * palette (the logo always lands on a dark-enough plate), edges that suit the shape. The same seed always gives the
 * same spec; `keep` holds the user's choices that Randomise leaves alone (logo, headline).
 */
export function randomSpec(look: Pick<ChannelLook, "motion">, seed: number, keep: Partial<Pick<WipeSpec, "logo" | "text" | "textPlate" | "textStyle">> = {}): WipeSpec {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = rng(seed * 7919 + attempt * 104729 + 17);
    const layout = weighted<PanelLayout>(r, [["stack", 26], ["bars", 18], ["slices", 10], ["split", 9], ["blades", 9], ["flip", 8], ["circles", 11], ["tiles", 9]]);
    const edges: [PanelEdge, number][] =
      layout === "tiles" ? [["straight", 4], ["chevron", 3], ["round", 3]]
        : layout === "circles" ? [["straight", 4], ["wave", 2], ["brush", 3], ["torn", 1]]
          : layout === "blades" || layout === "flip" ? [["straight", 1]]
            : [["straight", 4], ["slant", 6], ["chevron", 3], ["round", 1], ["wave", 1], ["torn", 1], ["brush", 2]];
    const edge = weighted(r, edges);
    const count = layout === "stack" ? 2 + Math.floor(r() * 3) : layout === "split" ? 1 + Math.floor(r() * 2)
      : layout === "circles" ? 2 + Math.floor(r() * 3) : layout === "tiles" ? 7 + Math.floor(r() * 6)
        : layout === "blades" ? 6 + Math.floor(r() * 5) : layout === "flip" ? 4 + Math.floor(r() * 4) : 3 + Math.floor(r() * 5);
    const angle = layout === "split" ? weighted(r, [[0, 3], [90, 1]]) : layout === "circles" ? 0
      : weighted<number>(r, [[0, 5], [180, 2], [90, 2], [-90, 1], [-12, 2], [15, 2], [30, 1], [-35, 1], [45, 1]]);
    const depth = edge === "slant" ? between(r, 0.2, 0.6) : edge === "chevron" ? between(r, 0.25, 0.5) : edge === "round" ? between(r, 0.3, 0.6)
      : edge === "wave" ? between(r, 0.3, 0.7) : edge === "torn" || edge === "brush" ? between(r, 0.4, 0.85) : 0.3;
    const order: PanelOrder = layout === "stack" || layout === "split" || layout === "circles" ? "forward"
      : weighted<PanelOrder>(r, [["forward", 5], ["reverse", 1], ["center", 3], ["edges", 1], ["random", layout === "tiles" ? 3 : 1]]);
    const stagger = layout === "stack" || layout === "circles" || layout === "split" ? between(r, 0.06, 0.1, 3)
      : layout === "tiles" ? between(r, 0.02, 0.04, 3) : layout === "blades" || layout === "flip" ? between(r, 0.025, 0.05, 3) : between(r, 0.03, 0.06, 3);
    const logo = keep.logo ?? false;
    const text = keep.text ?? "";
    const seconds = logo || text ? between(r, 1.3, 1.6, 2) : between(r, 0.9, 1.35, 2);
    const cut = between(r, 0.46, 0.54, 2);
    const hold = logo || text ? between(r, 0.4, 0.55, 2) : between(r, 0.13, 0.2, 2);
    const ease: PanelEase = look.motion === "sharp" ? weighted<PanelEase>(r, [["expo", 3], ["sharp", 2]])
      : look.motion === "bouncy" ? weighted<PanelEase>(r, [["back", 4], ["elastic", 1]]) : weighted<PanelEase>(r, [["smooth", 4], ["expo", 1]]);
    const overshoot = ease === "back" || ease === "elastic" ? between(r, 0.3, 0.7) : 0.4;
    const exit: PanelExit = layout === "split" ? "back" : weighted<PanelExit>(r, [["continue", 7], ["back", 2], ["fade", 1]]);
    let colors = [...PALETTES[Math.floor(r() * PALETTES.length)]];
    if ((logo || text) && !PLATE_OK.has(colors[colors.length - 1])) colors = [...colors.slice(0, -1), "primary"];
    // stacked shapes: one colour per panel, the palette's last on top (where the logo lands)
    if (layout === "stack" || layout === "circles" || layout === "split") {
      const pal = colors, k = Math.min(4, count);
      colors = Array.from({ length: k }, (_, i) => pal[(((pal.length - k + i) % pal.length) + pal.length) % pal.length]);
    }
    const line = r() < 0.45 ? Math.round(between(r, 3, 10, 0)) : 0;
    const lineColor: PaletteSlot = colors.includes("accent") ? "light" : "accent";
    const finish = weighted<WipeSpec["finish"]>(r, [["gradient", 5], ["flat", 3], ["glass", 2]]);
    const flash = logo ? between(r, 0.2, 0.5) : r() < 0.15 ? between(r, 0.2, 0.4) : 0;
    const centre = layout === "circles" && r() < 0.35 ? weighted<[number, number]>(r, [[[0.15, 0.85], 1], [[0.85, 0.15], 1], [[0.5, 1], 1], [[0, 0.5], 1]]) : [0.5, 0.5];
    const spec = wipeSpec({
      layout, edge, count, angle, depth, order, stagger, seconds, cut, hold, ease, overshoot, exit, colors, finish, line, lineColor,
      logo, flash, text, textPlate: keep.textPlate ?? "", textStyle: keep.textStyle ?? "slam",
      blur: between(r, 0.15, 0.5), shadow: between(r, 0.15, 0.5), seed: 1 + Math.floor(r() * 9998), cx: centre[0], cy: centre[1],
      sweep: r() < 0.15,
    });
    if (checkSpec(spec, 24).ok) return spec;
  }
  return wipeSpec({ ...keep, seed: (seed % 9999) + 1 });
}

/** A short plain-English summary of a spec ("3 slanted panels, left to right, 1.2 s"). */
export function describeSpec(s: WipeSpec): string {
  const dir = (a: number) => { const x = ((a % 360) + 360) % 360; return x < 23 || x >= 338 ? "left to right" : x < 68 ? "down and right" : x < 113 ? "top to bottom" : x < 158 ? "down and left" : x < 203 ? "right to left" : x < 248 ? "up and left" : x < 293 ? "bottom to top" : "up and right"; };
  const shape: Record<PanelLayout, string> = { stack: "panels", bars: "bars", slices: "slices", split: "doors", blades: "blades", flip: "flipping cards", circles: "circles", tiles: "tiles" };
  const edge = s.edge === "straight" ? "" : `${s.edge === "torn" ? "torn" : s.edge === "brush" ? "brushed" : s.edge === "slant" ? "slanted" : s.edge} `;
  return `${s.count} ${edge}${shape[s.layout]}${s.layout === "circles" ? "" : `, ${dir(s.angle)}`}, ${s.seconds.toFixed(1)} s`;
}

export { PANEL_MOTION_DEFAULTS };
