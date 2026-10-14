/**
 * Built-in "Boards" templates (docs/EDITOR.md §16.4). Owner: nr-boards. Ids "nr.boards.<name>", stable.
 *
 * Every board sits in one frame: a full-screen background in the look's colours (a dark → secondary gradient, a glow
 * of the primary colour, a halftone corner and fine diagonal rules, all drawn by code), a kicker tag, the title with
 * an accent rule, and a footer with the source line and the channel logo (a shine every ten seconds). The content uses
 * the board kinds (number, list, bars, table, pins, stamp) and the core ones. 9:16 designs stack the content in one
 * column with bigger type, inside the Reels / Shorts safe area. Sample values read like Indian news (₹, lakh / crore,
 * Indian places, a Hindi line in several).
 */
import type { GfxField, GfxLayer, GfxListItem, GfxTableRow, GfxTemplate } from "../types.ts";
import { anim, field, icon, image, layer, line, logo, rect, step, text, tpl } from "./kit.ts";

type Ratio = "16:9" | "9:16";
type B4 = [number, number, number, number];

/** The frame per ratio: margins, title, content area (T..B) and footer. */
interface Frame { r: Ratio; W: number; H: number; X: number; R: number; top: number; titleY: number; titleH: number; titleSize: number; ruleY: number; T: number; B: number; footY: number; s: number }
/** The footer ends above the ticker zone (16:9 crawl from y 962, 9:16 from y 1386), so a ticker on screen never makes
 *  the renderer lift a full-screen board (collision rule): the ticker simply sits over the board's background. */
const F16: Frame = { r: "16:9", W: 1920, H: 1080, X: 96, R: 1824, top: 62, titleY: 112, titleH: 96, titleSize: 74, ruleY: 216, T: 252, B: 872, footY: 900, s: 1 };
const F9: Frame = { r: "9:16", W: 1080, H: 1920, X: 72, R: 900, top: 244, titleY: 302, titleH: 184, titleSize: 80, ruleY: 498, T: 534, B: 1290, footY: 1316, s: 1.15 };
const W = (f: Frame) => f.R - f.X;

const fadeIO = (delay = 0, dur = 0.4) => anim(step("fade", { dur, delay }), step("fade", { dur: 0.3 }));
const riseIO = (delay = 0, dur = 0.5) => anim(step("rise", { dur, delay, distance: 40 }), step("fade", { dur: 0.25 }));
const popIO = (delay = 0) => anim(step("pop", { dur: 0.45, delay }), step("fade", { dur: 0.25 }));
const growIO = (delay = 0, dir: "right" | "left" | "up" | "down" = "right", dur = 0.45) => anim(step("grow", { dir, dur, delay }), step("fade", { dur: 0.25 }));
const zoomIO = (delay = 0) => anim(step("zoom", { dur: 0.6, delay }), step("fade", { dur: 0.3 }));
const SHADOW = { color: "rgba(0,0,0,0.4)", blur: 30, x: 0, y: 12 };
const flat = { shape: "flat", glass: "off" };

/** Halftone dots in the top-right corner and long diagonal rules bottom-left: texture drawn with dotted lines. */
function texture(f: Frame): GfxLayer[] {
  const out: GfxLayer[] = [];
  const rows = 11, step0 = f.r === "16:9" ? 22 : 24, reach = f.r === "16:9" ? 46 : 34;
  for (let i = 0; i < rows; i++) {
    const w0 = (rows - i) * reach;
    out.push(line(`dots${i}`, [f.W - w0 - 24, 30 + i * step0, w0, 8], { color: "@text", width: 5, dash: "dot", dir: "h" },
      { name: "texture", opacity: 0.12 - i * 0.009, anim: fadeIO(0.1 + i * 0.02, 0.5), locked: true }));
  }
  // long diagonal rules across the lower left: frame-sized boxes, so collision rules treat them as background
  const diag = f.r === "16:9" ? [-900, -780, -660] : [-700, -600];
  diag.forEach((dx, i) => out.push(line(`rule${i}`, [dx, Math.round(f.H * 0.25), f.W * 0.95, f.H * 0.95], { color: "@text", width: 2, dir: "diag" }, { name: "texture", opacity: 0.05, anim: fadeIO(0.15, 0.6), locked: true })));
  return out;
}

/** The board frame: background, texture, kicker, title, rule, footer (source + logo). */
function frame(f: Frame, o: { kicker?: boolean; source?: boolean; title?: string; titleLines?: number } = {}): GfxLayer[] {
  const s = f.s;
  const kh = Math.round(46 * s);
  return [
    rect("bg", [0, 0, f.W, f.H + 200], { fill: { gradient: ["@dark", "@secondary"], angle: 120 }, ...flat }, { anim: fadeIO(0, 0.35), locked: true }),
    rect("bg_glow", [0, 0, f.W, f.H + 200], { fill: { gradient: ["@primary/0", "@primary/30"], angle: 315 }, ...flat }, { anim: fadeIO(0.05, 0.6), locked: true }),
    rect("bg_shade", [0, 0, f.W, f.H + 200], { fill: { gradient: ["@dark/0", "@dark/70"], angle: 90 }, ...flat }, { anim: fadeIO(0, 0.4), locked: true }),
    ...texture(f),
    ...(o.kicker === false ? [] : [
      rect("kickerbg", [f.X, f.top, 240, kh], { fill: "@accent", shape: "flat" }, { anim: anim(step("grow", { dur: 0.35, delay: 0.1 }), step("fade", { dur: 0.25 })), when: "{kicker}" }),
      text("kicker", [f.X + 18, f.top, 640, kh], "{kicker}", { font: "@headline", size: Math.round(28 * s), weight: 700, color: "@dark", upper: "on", tracking: 2, maxLines: 1, grow: { layers: ["kickerbg"], pad: 18, min: 160, max: 700 } },
        { clip: "kickerbg", anim: anim(step("rise", { dur: 0.35, delay: 0.2, distance: 24 }), step("fade", { dur: 0.2 })), when: "{kicker}" }),
    ]),
    text("title", [f.X, f.titleY, W(f), f.titleH], o.title ?? "{title}", {
      font: "@headline", size: f.titleSize, weight: 800, color: "@text", maxLines: o.titleLines ?? (f.r === "16:9" ? 1 : 2), fit: "shrink", minScale: 0.6, lineHeight: 1.1, valign: f.r === "16:9" ? "middle" : "top",
    }, { anim: anim(step("stagger", { by: "word", dur: 0.55, delay: 0.18, stagger: 0.05 }), step("fade", { dur: 0.25 })) }),
    rect("rule", [f.X, f.ruleY, 150, 6], { fill: "@accent", shape: "flat" }, { anim: growIO(0.32) }),
    rect("hair", [f.X + 162, f.ruleY + 2, W(f) - 162, 2], { fill: "@text/15", shape: "flat" }, { anim: growIO(0.4, "right", 0.6) }),
    rect("foot", [f.X, f.footY - 12, W(f), 2], { fill: "@text/12", shape: "flat" }, { anim: growIO(0.5, "right", 0.6) }),
    ...(o.source === false ? [] : [
      text("source", [f.X, f.footY, W(f) - Math.round(230 * s), Math.round(40 * s)], "Source: {source}", { font: "@body", size: Math.round(26 * s), weight: 500, color: "@text/70", maxLines: 1, fit: "shrink" },
        { anim: fadeIO(0.7), when: "{source}" }),
    ]),
    logo("logo", [f.R - Math.round(210 * s), f.footY - 4, Math.round(210 * s), Math.round(46 * s)], { align: "right", color: "@text", color2: "@accent" },
      { anim: anim(step("fade", { dur: 0.4, delay: 0.6 }), step("fade", { dur: 0.25 }), { kind: "shine", period: 10, delay: 1.5 }) }),
  ];
}

const F = {
  kicker: (def: string) => field.text("kicker", "Kicker", def, { maxLength: 24, group: "Title" }),
  title: (def: string, o: Partial<GfxField> = {}) => field.text("title", "Title", def, { required: true, maxLength: 70, group: "Title", fill: "story.headline", ...o }),
  source: (def: string) => field.text("source", "Source", def, { maxLength: 80, group: "Title" }),
};
const both = (fn: (f: Frame) => GfxLayer[]) => ({ "16:9": fn(F16), "9:16": fn(F9) });
const board = (o: { id: string; name: string; kind: string; description: string; tags: string[]; fields: GfxField[]; seconds?: number; timing?: { in: number; out: number }; hold?: GfxTemplate["hold"]; sounds?: GfxTemplate["sounds"]; designs: ReturnType<typeof both> }): GfxTemplate =>
  tpl({ category: "Boards", role: "board", seconds: o.seconds ?? 10, timing: o.timing ?? { in: 1, out: 0.5 }, hold: o.hold ?? "fixed", sounds: o.sounds ?? { in: "whoosh", out: "swish" }, ...o, id: `nr.boards.${o.id}` });
const L = (text: string, tag?: string, extra: Partial<GfxListItem> = {}): GfxListItem => ({ text, ...(tag ? { tag } : {}), ...extra });
const row = (r: GfxTableRow) => r;

// ── 1. key points ────────────────────────────────────────────────────────────

const keyPoints = board({
  id: "key_points", name: "Key points", kind: "points", hold: "auto", seconds: 12,
  description: "A numbered list of the story's main points, building one by one with the newest highlighted; a side panel with a picture or an icon.",
  tags: ["points", "bullets", "explainer", "list", "budget"],
  fields: [
    F.kicker("Key points"), F.title("Union Budget 2026-27: what changes for you"),
    field.list("points", "Points", [
      L("Income up to ₹12 lakh a year stays tax-free under the new regime"),
      L("Standard deduction for salaried employees raised to ₹1 lakh"),
      L("₹11.2 lakh crore for roads, railways and ports"),
      L("किसान क्रेडिट कार्ड की सीमा बढ़कर ₹5 लाख हुई"),
      L("Customs duty removed on 36 life-saving medicines"),
    ], { required: true, maxItems: 7, fill: "story.points" }),
    field.image("photo", "Picture", { hint: "Optional: shown beside the points (16:9)" }),
    field.choice("icon", "Panel icon", ["rupee", "chart", "ballot", "info", "globe", "star", "trend_up", "home"].map((v) => ({ value: v, label: v.replace("_", " ") })), "rupee"),
    field.text("panel", "Panel label", "Budget 2026", { maxLength: 18 }),
    F.source("Ministry of Finance"),
  ],
  designs: both((f) => {
    const vertical = f.r === "9:16";
    const listBox: B4 = vertical ? [f.X, f.T, W(f), f.B - f.T] : [f.X, f.T + 6, 1170, f.B - f.T - 6];
    const out = [
      ...frame(f),
      layer("list", "points", listBox, {
        field: "points", style: "number", plate: true, plateFill: "@dark/55", size: vertical ? 56 : 44, weight: 600, maxLines: vertical ? 3 : 2,
        gap: 0.42, spread: true, build: "paced", delay: 0.6, itemDur: 0.5, highlight: "latest", hiFill: "@primary", dim: 0.75,
      }, { anim: anim(undefined, step("slide", { dur: 0.35 })) }),
    ];
    if (!vertical) {
      const px = 1300, pw = f.R - px, box: B4 = [px, f.T + 6, pw, f.B - f.T - 6];
      out.push(
        rect("panel", box, { fill: { gradient: ["@primary", "@secondary"], angle: 135 }, gloss: 0.12, stripe: "top", stripeWidth: 8 }, { anim: growIO(0.35, "up", 0.5), shadow: SHADOW, when: "!{photo}" }),
        icon("panel_icon", [px + (pw - 220) / 2, f.T + 150, 220, 220], "{icon}", { color: "@textOnPrimary", color2: "@accent", weight: 1.2 }, { anim: popIO(0.6), when: "!{photo}", opacity: 0.92 }),
        text("panel_label", [px + 30, f.T + 420, pw - 60, 110], "{panel}", { font: "@headline", size: 54, weight: 800, color: "@textOnPrimary", align: "center", upper: "look", maxLines: 2, fit: "shrink" },
          { anim: riseIO(0.7), when: "!{photo}" }),
        image("photo", box, "photo", { shape: "rounded", radius: 12, border: "@text/25", borderWidth: 2, focusY: 0.4 }, { anim: zoomIO(0.35), shadow: SHADOW, when: "{photo}" }),
      );
    }
    return out;
  }),
});

// ── 2. big number ────────────────────────────────────────────────────────────

const bigNumber = board({
  id: "big_number", name: "Big number", kind: "number", seconds: 9,
  description: "One figure counting up in the look's number style (₹, lakh / crore), with what it means and how it changed.",
  tags: ["number", "figure", "stat", "count", "lakh", "crore", "economy"],
  fields: [
    F.kicker("By the numbers"), F.title("GST collections hit a new high"),
    field.number("value", "Number", 1.95e12, { currency: true, compact: true }, { required: true, hint: "Type the full amount: 1,95,00,00,00,00,000 shows as ₹1.95 lakh crore" }),
    field.text("label", "What it is", "Gross GST collected in October 2026", { maxLength: 70 }),
    field.number("change", "Change (%)", 9.1, { sign: true, suffix: "%", decimals: 1 }),
    field.text("changeLabel", "Compared with", "vs October 2025", { maxLength: 40 }),
    field.text("context", "Note", "Highest monthly collection after April", { maxLength: 80 }),
    F.source("Ministry of Finance"),
  ],
  designs: both((f) => {
    const v = f.r === "9:16";
    const cw = W(f);
    const numBox: B4 = v ? [f.X, f.T + 20, cw, 320] : [f.X, f.T + 10, cw, 300];
    const ly = numBox[1] + numBox[3] + (v ? 10 : 6);
    const chipW = v ? 420 : 380, chipH = v ? 92 : 82;
    const cy = ly + (v ? 130 : 86);
    return [
      ...frame(f),
      rect("halo", [f.X + cw * 0.18, numBox[1] + numBox[3] * 0.08, cw * 0.64, numBox[3] * 0.84], { fill: { gradient: ["@primary/0", "@primary/22"], angle: 90 }, shape: "pill", glass: "off" },
        { anim: fadeIO(0.3, 0.8), opacity: 0.9 }),
      layer("number", "value", numBox, {
        field: "value", currency: true, compact: true, size: v ? 200 : 240, weight: 700, color: "@text", unitScale: 0.42, unitColor: "@accent",
        delay: 0.35, dur: 1.9, ease: "expo", align: "center",
      }, { anim: anim(step("rise", { dur: 0.5, delay: 0.25 }), step("fade", { dur: 0.3 })), shadow: { color: "rgba(0,0,0,0.45)", blur: 24, x: 0, y: 8 } }),
      text("label", [f.X, ly, cw, v ? 110 : 64], "{label}", { font: "@body", size: v ? 44 : 42, weight: 600, color: "@text/90", align: "center", maxLines: 2, fit: "shrink", valign: "top" }, { anim: riseIO(0.6) }),
      rect("chip", [f.X + (cw - chipW) / 2, cy, chipW, chipH], { fill: "@dark/70", shape: "pill", glass: "off", stroke: "@text/20", strokeWidth: 2 }, { anim: popIO(1.1), when: "{change}" }),
      layer("number", "change", [f.X + (cw - chipW) / 2 + 20, cy, chipW - 40, chipH], {
        field: "change", sign: true, suffix: "%", decimals: 1, arrow: true, signColors: true, size: v ? 58 : 52, weight: 700, unitScale: 0.8, unitColor: "@text/80",
        delay: 1.1, dur: 1.2, align: "center",
      }, { anim: anim(step("fade", { dur: 0.3, delay: 1.15 }), step("fade", { dur: 0.25 })), when: "{change}" }),
      text("changeLabel", [f.X, cy + chipH + 10, cw, 48], "{changeLabel}", { font: "@body", size: v ? 34 : 30, weight: 500, color: "@text/70", align: "center", maxLines: 1 }, { anim: fadeIO(1.3), when: "{changeLabel}" }),
      rect("note_rule", [f.X + cw / 2 - 40, cy + chipH + (v ? 84 : 76), 80, 4], { fill: "@accent", shape: "flat" }, { anim: growIO(1.5), when: "{context}" }),
      text("context", [f.X, cy + chipH + (v ? 98 : 88), cw, v ? 96 : 56], "{context}", { font: "@headline", size: v ? 44 : 38, weight: 600, color: "@accent", align: "center", maxLines: 2, fit: "shrink", valign: "top" },
        { anim: riseIO(1.55), when: "{context}" }),
    ];
  }),
});

// ── 3. quote with photo ──────────────────────────────────────────────────────

const quote = board({
  id: "quote", name: "Quote with photo", kind: "quote", hold: "auto", seconds: 10,
  description: "Someone's words in large type beside their photo, with their name and role.",
  tags: ["quote", "statement", "said", "photo", "hindi"],
  fields: [
    F.kicker("They said"), F.title("On the farm loan waiver", { required: false, fill: undefined }),
    field.image("photo", "Photo", { fill: "person.photo" }),
    field.longtext("quote", "Quote", "किसानों का कर्ज़ माफ़ करना हमारी पहली प्राथमिकता है। बजट में इसके लिए ₹25,000 करोड़ रखे गए हैं।", { required: true, maxLength: 220 }),
    field.text("name", "Name", "Kavita Deshmukh", { fill: "person.name", maxLength: 40 }),
    field.text("role", "Role", "Agriculture Minister, Maharashtra", { fill: "person.role", maxLength: 60 }),
    F.source("Press conference, Mumbai"),
  ],
  designs: both((f) => {
    if (f.r === "16:9") {
      const px = f.X, pw = 500, qx = px + pw + 70, qw = f.R - qx;
      return [
        ...frame(f),
        rect("photo_back", [px + 18, f.T + 18, pw, f.B - f.T - 18], { fill: "@accent", shape: "look" }, { anim: growIO(0.25, "up", 0.5) }),
        image("photo", [px, f.T, pw, f.B - f.T - 18], "photo", { shape: "rounded", radius: 10, focusY: 0.3, bg: "@secondary" }, { anim: anim(step("wipe", { dir: "up", dur: 0.6, delay: 0.3 }), step("fade", { dur: 0.3 })), shadow: SHADOW }),
        icon("mark", [qx - 8, f.T - 4, 120, 120], "quote_open", { color: "@accent" }, { anim: anim(step("drop", { dur: 0.45, delay: 0.5, distance: 30 }), step("fade", { dur: 0.25 })) }),
        text("quote", [qx, f.T + 120, qw, 360], "{quote}", { font: "@body", size: 56, weight: 600, color: "@text", lineHeight: 1.3, maxLines: 5, valign: "top", fit: "shrink" },
          { anim: anim(step("fade", { by: "line", dur: 0.7, delay: 0.65, stagger: 0.18 }), step("fade", { dur: 0.25 })) }),
        rect("qrule", [qx, f.T + 494, 110, 6], { fill: "@accent", shape: "flat" }, { anim: growIO(1.1) }),
        text("name", [qx, f.T + 512, qw, 64], "{name}", { font: "@headline", size: 48, weight: 700, color: "@text", upper: "look", maxLines: 1, fit: "shrink" }, { anim: riseIO(1.2), when: "{name}" }),
        text("role", [qx, f.T + 576, qw, 48], "{role}", { font: "@body", size: 32, weight: 500, color: "@text/75", maxLines: 1, fit: "shrink" }, { anim: riseIO(1.3), when: "{role}" }),
      ];
    }
    const ps = 300;
    return [
      ...frame(f),
      rect("photo_back", [f.X + 12, f.T + 12, ps, ps], { fill: "@accent", shape: "look" }, { anim: growIO(0.25, "up", 0.5) }),
      image("photo", [f.X, f.T, ps, ps], "photo", { shape: "rounded", radius: 10, focusY: 0.3, bg: "@secondary" }, { anim: anim(step("wipe", { dir: "up", dur: 0.6, delay: 0.3 }), step("fade", { dur: 0.3 })), shadow: SHADOW }),
      text("name", [f.X + ps + 40, f.T + 120, W(f) - ps - 40, 70], "{name}", { font: "@headline", size: 50, weight: 700, color: "@text", upper: "look", maxLines: 2, fit: "shrink", valign: "bottom" }, { anim: riseIO(0.5), when: "{name}" }),
      rect("qrule", [f.X + ps + 40, f.T + 202, 90, 6], { fill: "@accent", shape: "flat" }, { anim: growIO(0.6) }),
      text("role", [f.X + ps + 40, f.T + 220, W(f) - ps - 40, 90], "{role}", { font: "@body", size: 34, weight: 500, color: "@text/75", maxLines: 2, fit: "shrink", valign: "top" }, { anim: riseIO(0.6), when: "{role}" }),
      icon("mark", [f.X - 6, f.T + 340, 110, 110], "quote_open", { color: "@accent" }, { anim: anim(step("drop", { dur: 0.45, delay: 0.7, distance: 30 }), step("fade", { dur: 0.25 })) }),
      text("quote", [f.X, f.T + 450, W(f), f.B - f.T - 450], "{quote}", { font: "@body", size: 58, weight: 600, color: "@text", lineHeight: 1.3, maxLines: 7, valign: "top", fit: "shrink" },
        { anim: anim(step("fade", { by: "line", dur: 0.7, delay: 0.85, stagger: 0.18 }), step("fade", { dur: 0.25 })) }),
    ];
  }),
});

// ── 4. poll bars ─────────────────────────────────────────────────────────────

const PARTY = { a: "#F28C28", b: "#1E6FD9", c: "#2E9E4F", d: "#8A94A6" };
const poll = board({
  id: "poll", name: "Poll bars", kind: "poll", seconds: 10,
  description: "Opinion-poll results as growing bars with their percentages, the leader picked out, and the sample size counting up.",
  tags: ["poll", "survey", "opinion", "bars", "election"],
  fields: [
    F.kicker("Opinion poll"), F.title("Who should be the next Chief Minister?"),
    field.table("data", "Results", [{ id: "label", label: "Choice", type: "text" }, { id: "value", label: "%", type: "number" }, { id: "color", label: "Colour", type: "color" }], [
      row({ label: "Anil Deshpande (JVF)", value: 41, color: PARTY.a }), row({ label: "Sunita Patil (LSA)", value: 33, color: PARTY.b }),
      row({ label: "Rahul Shinde (RND)", value: 17, color: PARTY.c }), row({ label: "Can't say", value: 9, color: PARTY.d }),
    ], { required: true }),
    field.number("sample", "People asked", 12400), field.text("margin", "Margin of error", "±3%", { maxLength: 12 }),
    F.source("Tatvam–Lokniti survey, 1–10 October"),
  ],
  designs: both((f) => {
    const v = f.r === "9:16";
    const barsBox: B4 = v ? [f.X, f.T, W(f), 540] : [f.X, f.T + 10, 1240, f.B - f.T - 20];
    const card: B4 = v ? [f.X, f.T + 570, W(f), 180] : [1400, f.T + 10, f.R - 1400, f.B - f.T - 20];
    return [
      ...frame(f),
      layer("bars", "bars", barsBox, {
        field: "data", mode: "horizontal", labelPos: "above", labelSize: v ? 40 : 36, valueSize: v ? 56 : 50, suffix: "%", decimals: 0, scale: "max",
        thickness: 0.62, leader: true, delay: 0.55, dur: 1.2, stagger: 0.15, track: "@text/8",
      }, { anim: anim(step("fade", { dur: 0.4, delay: 0.4 }), step("fade", { dur: 0.3 })) }),
      rect("card", card, { fill: "@dark/55", shape: "rounded", stripe: v ? "left" : "top", stripeWidth: 6, stripeColor: "@accent" }, { anim: growIO(0.6, v ? "right" : "up", 0.5), shadow: SHADOW }),
      icon("card_icon", v ? [card[0] + 40, card[1] + 40, 100, 100] : [card[0] + (card[2] - 110) / 2, card[1] + 60, 110, 110], "ballot", { color: "@accent", color2: "@text" }, { anim: popIO(0.9) }),
      layer("number", "sample", v ? [card[0] + 170, card[1] + 14, card[2] - 200, 104] : [card[0] + 20, card[1] + 200, card[2] - 40, 150], {
        field: "sample", size: v ? 84 : 92, weight: 700, delay: 0.9, dur: 1.6, align: v ? "left" : "center", label: "People asked", labelSize: v ? 30 : 32, labelPos: "below",
      }, { anim: anim(step("fade", { dur: 0.3, delay: 0.85 }), step("fade", { dur: 0.25 })) }),
      text("margin", v ? [card[0] + 170, card[1] + 124, card[2] - 200, 44] : [card[0] + 20, card[1] + 400, card[2] - 40, 48], "Margin of error {margin}", {
        font: "@body", size: v ? 30 : 30, weight: 600, color: "@accent", align: v ? "left" : "center", maxLines: 1, fit: "shrink",
      }, { anim: fadeIO(1.4), when: "{margin}" }),
    ];
  }),
});

// ── 5. timeline ──────────────────────────────────────────────────────────────

const timeline = board({
  id: "timeline", name: "Timeline", kind: "timeline", hold: "auto", seconds: 12,
  description: "Dates and events joined by a line that draws itself as each one arrives: across in 16:9, down in 9:16.",
  tags: ["timeline", "history", "dates", "events", "chronology"],
  fields: [
    F.kicker("Timeline"), F.title("Chandrayaan: India's road to the Moon"),
    field.list("events", "Events", [
      L("Chandrayaan-1 finds signs of water on the Moon", "2008"),
      L("Chandrayaan-2 orbiter reaches the Moon", "2019"),
      L("Chandrayaan-3 lands near the south pole", "2023"),
      L("Chandrayaan-4 to bring back Moon samples", "2027"),
      L("भारतीय अंतरिक्ष यात्री चाँद पर उतरने का लक्ष्य", "2040"),
    ], { required: true, maxItems: 6, hint: "Each item: the event, with the date as its tag" }),
    F.source("ISRO"),
  ],
  designs: both((f) => {
    const v = f.r === "9:16";
    return [
      ...frame(f),
      layer("list", "events", v ? [f.X, f.T, W(f), f.B - f.T] : [f.X, f.T + 70, W(f), f.B - f.T - 110], v
        ? { field: "events", layout: "rows", style: "node", rail: true, size: 46, tagSize: 0.72, maxLines: 2, gap: 0.5, spread: true, build: "paced", delay: 0.6, enter: "slide", highlight: "latest", hiFill: "@primary/80", dim: 0.8 }
        : { field: "events", layout: "columns", style: "node", rail: true, size: 42, tagSize: 1.2, maxLines: 4, plate: true, valign: "center", plateFill: "@dark/45", build: "paced", delay: 0.6, enter: "rise", highlight: "latest", hiFill: "@primary/85", dim: 0.85 },
      { anim: anim(undefined, step("fade", { dur: 0.3 })) }),
    ];
  }),
});

// ── 6. versus ────────────────────────────────────────────────────────────────

const versus = board({
  id: "versus", name: "VS comparison", kind: "versus", seconds: 10,
  description: "Two sides head to head: names and pictures on either side of a VS badge, then the figures row by row.",
  tags: ["versus", "vs", "compare", "comparison", "head to head"],
  fields: [
    F.kicker("Head to head"), F.title("Bengaluru vs Hyderabad: the tech-jobs race"),
    field.text("left", "Left side", "Bengaluru", { required: true, maxLength: 24 }), field.image("leftPhoto", "Left picture"),
    field.text("right", "Right side", "Hyderabad", { required: true, maxLength: 24 }), field.image("rightPhoto", "Right picture"),
    field.table("rows", "Figures", [{ id: "left", label: "Left", type: "text" }, { id: "label", label: "What", type: "text" }, { id: "right", label: "Right", type: "text" }], [
      row({ left: "₹18.5 lakh", label: "Average tech salary", right: "₹16.2 lakh" }),
      row({ left: "₹95", label: "Office rent (per sq ft a month)", right: "₹72" }),
      row({ left: "1.2 lakh", label: "Tech jobs added in 2026", right: "98,000" }),
      row({ left: "79 km", label: "Metro network", right: "69 km" }),
      row({ left: "42", label: "Startups worth $1 billion+", right: "9" }),
    ]),
    F.source("NASSCOM, industry estimates"),
  ],
  designs: both((f) => {
    const v = f.r === "9:16";
    const cw = W(f), ph = v ? 150 : 150, half = v ? (cw - 30) / 2 : 700;
    const lx = f.X, rx = f.R - half, py = f.T;
    const pic = v ? 0 : 118;
    const vs = v ? 116 : 150;
    const tableY = py + ph + (v ? 40 : 40);
    return [
      ...frame(f),
      rect("lplate", [lx, py, half, ph], { fill: "@primary", gloss: 0.14, ends: "right" }, { anim: growIO(0.3, "right", 0.5), shadow: SHADOW }),
      ...(v ? [] : [image("lphoto", [lx + 16, py + 16, pic, pic], "leftPhoto", { shape: "circle", border: "@textOnPrimary", borderWidth: 4 }, { anim: popIO(0.55), when: "{leftPhoto}" })]),
      text("lname", [lx + (v ? 24 : pic + 40), py, half - (v ? 48 : pic + 80), ph], "{left}", { font: "@headline", size: v ? 52 : 60, weight: 800, color: "@textOnPrimary", upper: "look", maxLines: v ? 2 : 1, fit: "shrink", align: v ? "center" : "left" },
        { clip: "lplate", anim: anim(step("slide", { dir: "right", dur: 0.45, delay: 0.5, distance: 80 }), step("fade", { dur: 0.25 })) }),
      rect("rplate", [rx, py, half, ph], { fill: "@accent", gloss: 0.14, ends: "left" }, { anim: growIO(0.3, "left", 0.5), shadow: SHADOW }),
      ...(v ? [] : [image("rphoto", [f.R - 16 - pic, py + 16, pic, pic], "rightPhoto", { shape: "circle", border: "@dark", borderWidth: 4 }, { anim: popIO(0.55), when: "{rightPhoto}" })]),
      text("rname", [rx + (v ? 24 : 40), py, half - (v ? 48 : pic + 80), ph], "{right}", { font: "@headline", size: v ? 52 : 60, weight: 800, color: "@dark", upper: "look", maxLines: v ? 2 : 1, fit: "shrink", align: v ? "center" : "right" },
        { clip: "rplate", anim: anim(step("slide", { dir: "left", dur: 0.45, delay: 0.5, distance: 80 }), step("fade", { dur: 0.25 })) }),
      rect("vsbg", [f.X + (cw - vs) / 2, py + (ph - vs) / 2, vs, vs], { fill: "@light", shape: "pill", glass: "off", stroke: "@dark", strokeWidth: 6 },
        { anim: anim(step("pop", { dur: 0.5, delay: 0.75, ease: "back" }), step("fade", { dur: 0.25 }), { kind: "pulse", period: 2.4, amount: 0.04, delay: 0.4 }), shadow: SHADOW }),
      text("vs", [f.X + (cw - vs) / 2, py + (ph - vs) / 2, vs, vs], "VS", { font: "@headline", size: Math.round(vs * 0.44), weight: 800, color: "@dark", align: "center" },
        { anim: anim(step("pop", { dur: 0.5, delay: 0.8, ease: "back" }), step("fade", { dur: 0.25 }), { kind: "pulse", period: 2.4, amount: 0.04, delay: 0.4 }) }),
      layer("table", "rows", [f.X, tableY, cw, f.B - tableY], {
        field: "rows", columns: "left=Left, label=, right=Right", header: false, align: "ccc", widths: v ? "1,1.25,1" : "1,1.5,1",
        font: "@body", size: v ? 44 : 40, weight: 700, firstBold: true, rowFill: "@dark/50", zebraFill: "@light/7", lines: true, rowHeight: 2.0,
        delay: 1.0, stagger: 0.12, rowDur: 0.45,
      }, { anim: anim(undefined, step("fade", { dur: 0.3 })) }),
    ];
  }),
});

// ── 7. fact check ────────────────────────────────────────────────────────────

const VERDICTS = ["False", "True", "Misleading", "Partly true", "Unverified", "झूठ", "सच", "भ्रामक"];
const factCheck = board({
  id: "fact_check", name: "Fact check", kind: "fact_check", hold: "auto", seconds: 11, sounds: { in: "whoosh", out: "swish", cut: "impact" },
  description: "The claim, then a verdict stamp (True, False, Misleading … coloured by the verdict) and what was found.",
  tags: ["fact check", "fake", "viral", "verdict", "stamp", "misinformation"],
  fields: [
    F.kicker("Fact check"), F.title("Is the government giving free laptops to students?"),
    field.longtext("claim", "Claim", "Viral WhatsApp message: \"Register on this link to get a free laptop under PM Laptop Yojana 2026\"", { required: true, maxLength: 200 }),
    field.choice("verdict", "Verdict", VERDICTS.map((v) => ({ value: v, label: v })), "False", { hint: "The stamp's colour follows the verdict" }),
    field.longtext("found", "What we found", "No such scheme exists. PIB Fact Check has flagged the link as a phishing site that collects bank details.", { maxLength: 240 }),
    F.source("PIB Fact Check"),
  ],
  designs: both((f) => {
    const v = f.r === "9:16";
    const cw = W(f), th = v ? 50 : 44;
    const claimW = v ? cw : 1090, claimH = v ? 300 : 300;
    const fy = v ? f.T + th + claimH + 250 : f.T + th + claimH + 46;
    const tag = (id: string, x: number, y: number, label: string, fill: string, delay: number) => [
      rect(`${id}bg`, [x, y, 200, th], { fill, shape: "flat" }, { anim: growIO(delay, "right", 0.3) }),
      text(id, [x + 16, y, 500, th], label, { font: "@headline", size: v ? 30 : 27, weight: 700, color: "#FFFFFF", upper: "on", tracking: 2, maxLines: 1, grow: { layers: [`${id}bg`], pad: 16, min: 140, max: 520 } },
        { clip: `${id}bg`, anim: riseIO(delay + 0.1, 0.35) }),
    ];
    return [
      ...frame(f),
      ...tag("claimtag", f.X, f.T, "The claim", "@breaking", 0.4),
      rect("claimcard", [f.X, f.T + th, claimW, claimH], { fill: "@dark/60", ...flat, stripe: "left", stripeWidth: 6, stripeColor: "@breaking" }, { anim: growIO(0.45, "right", 0.5), shadow: SHADOW }),
      icon("claimicon", [f.X + 30, f.T + th + 26, 54, 54], "quote_open", { color: "@text/40" }, { anim: popIO(0.7) }),
      text("claim", [f.X + 100, f.T + th + 24, claimW - 130, claimH - 48], "{claim}", { font: "@body", size: v ? 44 : 42, weight: 600, color: "@text", lineHeight: 1.25, maxLines: v ? 5 : 4, valign: "top", fit: "shrink" },
        { anim: anim(step("fade", { by: "line", dur: 0.6, delay: 0.7, stagger: 0.15 }), step("fade", { dur: 0.25 })) }),
      layer("stamp", "verdict", v ? [f.X, f.T + th + claimH + 20, cw, 210] : [f.X + claimW + 30, f.T + 20, cw - claimW - 30, claimH + 40], {
        text: "{verdict}", size: v ? 120 : 112, angle: -9, delay: 1.6, dur: 0.42,
      }),
      ...tag("foundtag", f.X, fy, "What we found", "@primary", 2.0),
      rect("foundcard", [f.X, fy + th, cw, f.B - fy - th], { fill: "@dark/45", ...flat, stripe: "left", stripeWidth: 6, stripeColor: "@primary" }, { anim: growIO(2.05, "right", 0.5) }),
      text("found", [f.X + 36, fy + th + 20, cw - 72, f.B - fy - th - 40], "{found}", { font: "@body", size: v ? 40 : 38, weight: 500, color: "@text", lineHeight: 1.28, maxLines: v ? 5 : 3, valign: "top", fit: "shrink" },
        { anim: anim(step("fade", { by: "line", dur: 0.6, delay: 2.2, stagger: 0.15 }), step("fade", { dur: 0.25 })), when: "{found}" }),
    ];
  }),
});

// ── 8. rates ─────────────────────────────────────────────────────────────────

const rates = board({
  id: "rates", name: "Rates", kind: "rates", seconds: 10,
  description: "A rates table (gold, silver, fuel, vegetables …) in ₹ with Indian grouping and up / down changes, building row by row.",
  tags: ["rates", "gold", "silver", "petrol", "prices", "markets", "table"],
  fields: [
    F.kicker("Markets"), F.title("Gold, silver and fuel prices today"),
    field.text("place", "City", "Mumbai", { fill: "place", maxLength: 24 }), field.text("asOf", "As of", "14 Oct, 10:00 AM", { maxLength: 30 }),
    field.table("rows", "Rates", [{ id: "item", label: "Item", type: "text" }, { id: "unit", label: "Unit", type: "text" }, { id: "rate", label: "Rate (₹)", type: "number" }, { id: "change", label: "Change", type: "number" }], [
      row({ item: "Gold 24K", unit: "10 g", rate: 127450, change: 850 }),
      row({ item: "Gold 22K", unit: "10 g", rate: 116830, change: 780 }),
      row({ item: "Silver", unit: "1 kg", rate: 162300, change: -1200 }),
      row({ item: "Petrol", unit: "1 litre", rate: 103.5, change: 0 }),
      row({ item: "Diesel", unit: "1 litre", rate: 90.03, change: 0 }),
      row({ item: "LPG cylinder", unit: "14.2 kg", rate: 852.5, change: 50 }),
    ], { required: true }),
    F.source("IBJA, oil marketing companies"),
  ],
  designs: both((f) => {
    const v = f.r === "9:16";
    return [
      ...frame(f),
      icon("pin", [f.X, f.T + 4, v ? 44 : 38, v ? 44 : 38], "pin", { color: "@accent" }, { anim: popIO(0.45) }),
      text("where", [f.X + (v ? 54 : 48), f.T, W(f) - 60, v ? 52 : 46], "{place} · as of {asOf}", { font: "@body", size: v ? 34 : 30, weight: 600, color: "@text/80", maxLines: 1, fit: "shrink" }, { anim: fadeIO(0.5) }),
      layer("table", "rows", [f.X, f.T + (v ? 76 : 66), W(f), f.B - f.T - (v ? 76 : 66)], {
        field: "rows", columns: v ? "item=Item, rate=Rate (₹), change=Change" : "item=Item, unit=Unit, rate=Rate (₹), change=Change",
        widths: v ? "1.5,1.3,1" : "2.2,1.2,1.6,1.2", money: "rate", signed: "change", size: v ? 42 : 40, rowHeight: v ? 2.1 : 1.95, header: true,
        delay: 0.6, stagger: 0.1,
      }, { anim: anim(undefined, step("fade", { dur: 0.3 })) }),
    ];
  }),
});

// ── 9. weather ───────────────────────────────────────────────────────────────

const WEATHER_ICONS = ["sun", "cloud_sun", "cloud", "rain", "storm", "fog", "wind", "snow"];
const weather = board({
  id: "weather", name: "Weather", kind: "weather", seconds: 10,
  description: "Today's weather for one city (icon, temperature counting up, conditions, humidity, wind, an alert) and a table of other cities.",
  tags: ["weather", "rain", "monsoon", "temperature", "imd", "forecast"],
  fields: [
    F.kicker("Weather"), F.title("Heavy rain alert across Kerala"),
    field.text("city", "City", "Kochi", { fill: "place", maxLength: 24 }),
    field.choice("icon", "Sky", WEATHER_ICONS.map((v) => ({ value: v, label: v.replace("_", " ") })), "rain"),
    field.number("temp", "Temperature (°C)", 27, { suffix: "°" }), field.text("condition", "Conditions", "Heavy rain", { maxLength: 30 }),
    field.text("humidity", "Humidity", "92%", { maxLength: 10 }), field.text("wind", "Wind", "28 km/h", { maxLength: 12 }),
    field.text("alert", "Alert", "Orange alert in 9 districts till Thursday", { maxLength: 60 }),
    field.table("cities", "Other cities", [{ id: "city", label: "City", type: "text" }, { id: "max", label: "Max", type: "number" }, { id: "min", label: "Min", type: "number" }, { id: "rain", label: "Rain %", type: "number" }], [
      row({ city: "Thiruvananthapuram", max: 30, min: 24, rain: 80 }), row({ city: "Kozhikode", max: 29, min: 24, rain: 90 }),
      row({ city: "Thrissur", max: 28, min: 23, rain: 85 }), row({ city: "Idukki", max: 24, min: 18, rain: 95 }), row({ city: "Kannur", max: 29, min: 24, rain: 75 }),
    ]),
    F.source("India Meteorological Department"),
  ],
  designs: both((f) => {
    const v = f.r === "9:16";
    const card: B4 = v ? [f.X, f.T, W(f), 456] : [f.X, f.T + 6, 640, f.B - f.T - 6];
    const [cx, cy, cw] = card;
    const tbl: B4 = v ? [f.X, f.T + 486, W(f), f.B - f.T - 486] : [f.X + 680, f.T + 6, W(f) - 680, f.B - f.T - 6];
    const iconS = v ? 176 : 230;
    const iy = cy + (v ? 96 : 110);
    // 9:16: conditions sit under the temperature on the right; 16:9: under the icon
    const cond: B4 = v ? [cx + iconS + 60, iy + 178, cw - iconS - 96, 50] : [cx + 36, cy + 345, cw - 72, 56];
    const statY = v ? cy + 306 : cy + 400;
    return [
      ...frame(f),
      rect("card", card, { fill: { gradient: ["@primary", "@secondary"], angle: 135 }, gloss: 0.1, shape: "rounded" }, { anim: growIO(0.35, "up", 0.55), shadow: SHADOW }),
      text("city", [cx + 36, cy + 24, cw - 72, 64], "{city}", { font: "@headline", size: v ? 54 : 50, weight: 800, color: "@textOnPrimary", upper: "look", maxLines: 1, fit: "shrink" }, { anim: riseIO(0.55) }),
      icon("sky", [cx + 30, iy, iconS, iconS], "{icon}", { color: "@textOnPrimary", color2: "@accent" }, { anim: anim(step("pop", { dur: 0.55, delay: 0.7, ease: "back" }), step("fade", { dur: 0.25 }), { kind: "float", period: 4, amount: 6, delay: 0.5 }) }),
      layer("number", "temp", [cx + iconS + 50, iy - (v ? 10 : 0), cw - iconS - 86, v ? 180 : iconS], { field: "temp", suffix: "°", from: 18, size: v ? 168 : 190, weight: 700, color: "@textOnPrimary", unitScale: 0.7, unitColor: "@accent", delay: 0.75, dur: 1.2, align: "right" },
        { anim: anim(step("fade", { dur: 0.3, delay: 0.7 }), step("fade", { dur: 0.25 })) }),
      text("condition", cond, "{condition}", { font: "@body", size: 40, weight: 700, color: "@textOnPrimary", maxLines: 1, fit: "shrink", align: v ? "right" : "left" }, { anim: riseIO(0.9) }),
      icon("hum_i", [cx + 36, statY + 6, 40, 40], "humidity", { color: "@accent" }, { anim: popIO(1.0) }),
      text("humidity", [cx + 86, statY, 200, 52], "{humidity}", { font: "@numbers", size: 36, weight: 600, color: "@textOnPrimary", maxLines: 1 }, { anim: fadeIO(1.05) }),
      icon("wind_i", [cx + cw / 2, statY + 6, 40, 40], "wind", { color: "@accent" }, { anim: popIO(1.1) }),
      text("wind", [cx + cw / 2 + 50, statY, cw / 2 - 80, 52], "{wind}", { font: "@numbers", size: 36, weight: 600, color: "@textOnPrimary", maxLines: 1, fit: "shrink" }, { anim: fadeIO(1.15) }),
      rect("alertbg", [cx, cy + card[3] - (v ? 84 : 96), cw, v ? 84 : 96], { fill: "@breaking", ...flat }, { anim: growIO(1.25, "right", 0.45), when: "{alert}" }),
      icon("alert_i", [cx + 26, cy + card[3] - (v ? 66 : 74), v ? 48 : 52, v ? 48 : 52], "warning", { color: "#FFFFFF" }, { anim: anim(step("pop", { delay: 1.45 }), step("fade", { dur: 0.2 }), { kind: "flash", period: 2.5, delay: 0.5 }), when: "{alert}" }),
      text("alert", [cx + 94, cy + card[3] - (v ? 84 : 96), cw - 120, v ? 84 : 96], "{alert}", { font: "@body", size: v ? 32 : 30, weight: 700, color: "#FFFFFF", maxLines: 2, fit: "shrink", lineHeight: 1.1 },
        { clip: "alertbg", anim: riseIO(1.4), when: "{alert}" }),
      layer("table", "cities", tbl, {
        field: "cities", columns: "city=City, max=Max °C, min=Min °C, rain=Rain", percentCols: "rain", widths: v ? "2.8,1,1,1.1" : "2.4,1,1,1.1",
        size: v ? 38 : 38, rowHeight: v ? 1.7 : 2.0, delay: 0.8, stagger: 0.1,
      }, { anim: anim(undefined, step("fade", { dur: 0.3 })) }),
    ];
  }),
});

// ── 10. election seats ───────────────────────────────────────────────────────

const election = board({
  id: "election", name: "Election seats", kind: "election", seconds: 10,
  description: "The seats each party won as a half donut with the majority line, the declared total and a legend that counts up.",
  tags: ["election", "results", "seats", "majority", "assembly", "lok sabha", "donut"],
  fields: [
    F.kicker("Results 2026"), F.title("Assembly election: party position"),
    field.table("seats", "Parties", [{ id: "label", label: "Party", type: "text" }, { id: "value", label: "Seats", type: "number" }, { id: "color", label: "Colour", type: "color" }], [
      row({ label: "JVF+", value: 68, color: PARTY.a }), row({ label: "LSA+", value: 51, color: PARTY.b }),
      row({ label: "RND", value: 14, color: PARTY.c }), row({ label: "Others", value: 7, color: PARTY.d }),
    ], { required: true }),
    field.number("total", "Seats in the house", 140), field.number("majority", "Majority mark", 71, undefined, { hint: "0 = half + 1" }),
    field.text("status", "Status", "Results declared: 140 of 140", { maxLength: 40 }),
    F.source("Election Commission of India"),
  ],
  designs: both((f) => {
    const v = f.r === "9:16";
    return [
      ...frame(f),
      text("status", [f.X, f.T, W(f), v ? 50 : 46], "{status}", { font: "@headline", size: v ? 36 : 32, weight: 700, color: "@accent", align: v ? "left" : "center", upper: "look", maxLines: 1, fit: "shrink" },
        { anim: fadeIO(0.45), when: "{status}" }),
      layer("bars", "seats", v ? [f.X, f.T + 70, W(f), f.B - f.T - 70] : [f.X + 200, f.T + 60, W(f) - 400, f.B - f.T - 60], {
        field: "seats", mode: "seats", totalField: "total", majorityField: "majority", majorityLabel: "Majority {n}", ring: 0.38, centerLabel: "Seats",
        labelSize: v ? 40 : 34, valueSize: v ? 48 : 42, legendCols: v ? 2 : 4, delay: 0.6, dur: 1.2, leader: true, track: "@text/10",
      }, { anim: anim(step("fade", { dur: 0.4, delay: 0.4 }), step("fade", { dur: 0.3 })) }),
    ];
  }),
});

// ── 11. cricket scorecard ────────────────────────────────────────────────────

const scorecard = board({
  id: "scorecard", name: "Cricket scorecard", kind: "scorecard", seconds: 12,
  description: "The batting side's score, the batting card (runs, balls, fours, sixes, strike rate) row by row, and the match situation.",
  tags: ["cricket", "score", "scorecard", "batting", "odi", "t20", "ipl", "sports"],
  fields: [
    F.kicker("Live score"), F.title("India vs Australia · 2nd ODI, Perth"),
    field.text("team", "Batting side", "India", { maxLength: 20 }), field.text("score", "Score", "287/6", { maxLength: 10 }),
    field.text("overs", "Overs", "50 ov", { maxLength: 10 }), field.text("rate", "Run rate", "RR 5.74", { maxLength: 14 }),
    field.table("batting", "Batting", [
      { id: "batter", label: "Batter", type: "text" }, { id: "r", label: "R", type: "number" }, { id: "b", label: "B", type: "number" },
      { id: "fours", label: "4s", type: "number" }, { id: "sixes", label: "6s", type: "number" }, { id: "sr", label: "SR", type: "number" },
    ], [
      row({ batter: "Aarav Sharma", r: 88, b: 97, fours: 9, sixes: 2, sr: 90.72 }),
      row({ batter: "Rohan Iyer", r: 54, b: 61, fours: 5, sixes: 1, sr: 88.52 }),
      row({ batter: "Kabir Singh", r: 12, b: 18, fours: 1, sixes: 0, sr: 66.67 }),
      row({ batter: "Vihaan Patel*", r: 71, b: 49, fours: 6, sixes: 3, sr: 144.9 }),
      row({ batter: "Ishaan Reddy", r: 23, b: 20, fours: 2, sixes: 1, sr: 115 }),
      row({ batter: "Dev Malhotra*", r: 19, b: 11, fours: 1, sixes: 1, sr: 172.73 }),
    ]),
    field.text("status", "Situation", "Australia need 288 runs to win", { maxLength: 60 }),
    F.source(""),
  ],
  designs: both((f) => {
    const v = f.r === "9:16";
    const cw = W(f), sh = v ? 200 : 120;
    const st = v ? 96 : 66;
    return [
      ...frame(f),
      rect("strip", [f.X, f.T, cw, sh], { fill: { gradient: ["@primary", "@secondary"], angle: 0 }, gloss: 0.12, stripe: "left", stripeWidth: 10 }, { anim: growIO(0.35, "right", 0.5), shadow: SHADOW }),
      icon("bat", [f.X + 30, f.T + (v ? 24 : 26), v ? 64 : 68, v ? 64 : 68], "cricket_bat", { color: "@textOnPrimary", color2: "@accent" }, { anim: popIO(0.55) }),
      text("team", [f.X + (v ? 110 : 116), f.T + (v ? 14 : 0), v ? cw - 140 : 520, v ? 84 : sh], "{team}", { font: "@headline", size: v ? 56 : 56, weight: 800, color: "@textOnPrimary", upper: "look", maxLines: 1, fit: "shrink" },
        { clip: "strip", anim: riseIO(0.55) }),
      text("score", v ? [f.X + 30, f.T + 96, 420, 96] : [f.X + 650, f.T, 420, sh], "{score}", { font: "@numbers", size: v ? 88 : 88, weight: 700, color: "@textOnPrimary", maxLines: 1, fit: "shrink" },
        { clip: "strip", anim: anim(step("zoom", { dur: 0.5, delay: 0.7 }), step("fade", { dur: 0.25 })) }),
      text("overs", v ? [f.X + 450, f.T + 96, 150, 96] : [f.X + 1080, f.T, 220, sh], "{overs}", { font: "@numbers", size: v ? 40 : 40, weight: 600, color: "@textOnPrimary/80", maxLines: 1, fit: "shrink" },
        { clip: "strip", anim: fadeIO(0.85) }),
      text("rate", v ? [f.X + 600, f.T + 96, cw - 630, 96] : [f.X + 1320, f.T, cw - 1350, sh], "{rate}", { font: "@numbers", size: v ? 36 : 38, weight: 600, color: "@accent", align: "right", maxLines: 1, fit: "shrink" },
        { clip: "strip", anim: fadeIO(0.95) }),
      layer("table", "batting", [f.X, f.T + sh + 24, cw, f.B - f.T - sh - 24 - st - 20], {
        field: "batting", columns: v ? "batter=Batter, r=R, b=B, sr=SR" : "batter=Batter, r=R, b=B, fours=4s, sixes=6s, sr=SR",
        widths: v ? "3.2,1,1,1.3" : "4,1,1,1,1,1.3", align: v ? "lrrr" : "lrrrrr", size: v ? 40 : 36, rowHeight: 1.8, decimals: -1, highlight: 1, hiFill: "@accent/90",
        delay: 0.8, stagger: 0.09,
      }, { anim: anim(undefined, step("fade", { dur: 0.3 })) }),
      rect("statusbg", [f.X, f.B - st, cw, st], { fill: "@accent", ...flat }, { anim: growIO(1.6, "right", 0.5), when: "{status}" }),
      text("status", [f.X + 30, f.B - st, cw - 60, st], "{status}", { font: "@headline", size: v ? 40 : 36, weight: 700, color: "@dark", align: "center", upper: "look", maxLines: 2, fit: "shrink", lineHeight: 1.1 },
        { clip: "statusbg", anim: riseIO(1.75), when: "{status}" }),
    ];
  }),
});

// ── 12. top headlines ────────────────────────────────────────────────────────

const headlines = board({
  id: "headlines", name: "Top headlines", kind: "headlines", hold: "auto", seconds: 12,
  description: "The bulletin's top stories, numbered, each with its section, appearing one by one with the current one lit.",
  tags: ["headlines", "top stories", "bulletin", "news in brief", "list"],
  fields: [
    F.kicker("Top stories"), F.title("Headlines at 9", { fill: undefined }),
    field.list("stories", "Stories", [
      L("Parliament's winter session to begin on 24 November", "Politics"),
      L("Sensex closes above 86,000 for the first time", "Business"),
      L("North-east monsoon to reach Tamil Nadu this week", "Weather"),
      L("भारतीय महिला टीम वर्ल्ड कप के सेमीफाइनल में पहुँची", "Sports"),
      L("Bengaluru to get India's first 6G test corridor", "Tech"),
    ], { required: true, maxItems: 7, hint: "Each story with its section as the tag" }),
    F.source(""),
  ],
  designs: both((f) => {
    const v = f.r === "9:16";
    return [
      ...frame(f),
      layer("list", "stories", [f.X, f.T, W(f), f.B - f.T], {
        field: "stories", style: "numeral", markerColor: "@accent", size: v ? 46 : 44, weight: 600, maxLines: 2, tagSize: 0.5, divider: true, gap: 0.5, spread: true,
        build: "paced", delay: 0.6, enter: "slide", highlight: "latest", hiFill: "@primary/85", dim: 0.7,
      }, { anim: anim(undefined, step("slide", { dur: 0.35 })) }),
    ];
  }),
});

// ── 13. profile card ─────────────────────────────────────────────────────────

const profile = board({
  id: "profile", name: "Profile card", kind: "profile", hold: "auto", seconds: 11,
  description: "A person's photo, name and role with key facts in a table and a short line about them (candidates, newsmakers, achievers).",
  tags: ["profile", "candidate", "biography", "person", "who is", "know your"],
  fields: [
    F.kicker("Profile"), F.title("Know your candidate", { fill: undefined }),
    field.image("photo", "Photo", { fill: "person.photo" }),
    field.text("name", "Name", "Kavya Reddy", { fill: "person.name", required: true, maxLength: 40 }),
    field.text("role", "Role", "Candidate, Jubilee Hills", { fill: "person.role", maxLength: 60 }),
    field.table("facts", "Facts", [{ id: "label", label: "What", type: "text" }, { id: "value", label: "Detail", type: "text" }], [
      row({ label: "Age", value: "46" }), row({ label: "Party", value: "Janata Vikas Front" }), row({ label: "Education", value: "MBA, IIM Bangalore" }),
      row({ label: "Declared assets", value: "₹12.4 crore" }), row({ label: "Criminal cases", value: "None" }),
    ]),
    field.longtext("bio", "About", "Two-time corporator who led the city's lake revival drive; first-time Assembly candidate.", { maxLength: 160 }),
    F.source("Election affidavit"),
  ],
  designs: both((f) => {
    const v = f.r === "9:16";
    if (!v) {
      const pw = 470, tx = f.X + pw + 50, tw = f.R - tx;
      return [
        ...frame(f),
        rect("photo_back", [f.X + 14, f.T + 14, pw, f.B - f.T - 14], { fill: "@primary", shape: "look" }, { anim: growIO(0.25, "up", 0.5) }),
        image("photo", [f.X, f.T, pw, f.B - f.T - 14], "photo", { shape: "rounded", radius: 10, focusY: 0.3, bg: "@secondary", border: "@text/20", borderWidth: 2 }, { anim: anim(step("wipe", { dir: "up", dur: 0.6, delay: 0.3 }), step("fade", { dur: 0.3 })), shadow: SHADOW }),
        text("name", [tx, f.T, tw, 84], "{name}", { font: "@headline", size: 66, weight: 800, color: "@text", upper: "look", maxLines: 1, fit: "shrink" }, { anim: riseIO(0.45) }),
        text("role", [tx, f.T + 84, tw, 50], "{role}", { font: "@body", size: 34, weight: 600, color: "@accent", maxLines: 1, fit: "shrink" }, { anim: riseIO(0.55), when: "{role}" }),
        layer("table", "facts", [tx, f.T + 156, tw, 340], {
          field: "facts", columns: "label=, value=", header: false, widths: "1,1.9", firstBold: false, size: 34, rowHeight: 1.85, color: "@text",
          rowFill: "@dark/50", zebraFill: "@light/7", delay: 0.7, stagger: 0.09,
        }, { anim: anim(undefined, step("fade", { dur: 0.3 })) }),
        rect("bio_rule", [tx, f.T + 524, 6, f.B - f.T - 540], { fill: "@accent", shape: "flat" }, { anim: growIO(1.3, "down", 0.4), when: "{bio}" }),
        text("bio", [tx + 26, f.T + 520, tw - 26, f.B - f.T - 534], "{bio}", { font: "@body", size: 32, weight: 500, color: "@text/85", lineHeight: 1.3, maxLines: 3, valign: "top", fit: "shrink" },
          { anim: fadeIO(1.4), when: "{bio}" }),
      ];
    }
    const ps = 360;
    return [
      ...frame(f),
      rect("photo_back", [f.X + (W(f) - ps) / 2 + 14, f.T + 14, ps, ps], { fill: "@primary", shape: "look" }, { anim: growIO(0.25, "up", 0.5) }),
      image("photo", [f.X + (W(f) - ps) / 2, f.T, ps, ps], "photo", { shape: "rounded", radius: 10, focusY: 0.3, bg: "@secondary" }, { anim: anim(step("wipe", { dir: "up", dur: 0.6, delay: 0.3 }), step("fade", { dur: 0.3 })), shadow: SHADOW }),
      text("name", [f.X, f.T + ps + 30, W(f), 76], "{name}", { font: "@headline", size: 64, weight: 800, color: "@text", align: "center", upper: "look", maxLines: 1, fit: "shrink" }, { anim: riseIO(0.45) }),
      text("role", [f.X, f.T + ps + 106, W(f), 50], "{role}", { font: "@body", size: 36, weight: 600, color: "@accent", align: "center", maxLines: 1, fit: "shrink" }, { anim: riseIO(0.55), when: "{role}" }),
      layer("table", "facts", [f.X, f.T + ps + 176, W(f), f.B - f.T - ps - 176], {
        field: "facts", columns: "label=, value=", header: false, widths: "1,1.6", firstBold: false, size: 38, rowHeight: 1.9,
        rowFill: "@dark/50", zebraFill: "@light/7", delay: 0.7, stagger: 0.09,
      }, { anim: anim(undefined, step("fade", { dur: 0.3 })) }),
    ];
  }),
});

// ── 14. countdown ────────────────────────────────────────────────────────────

const countdown = board({
  id: "countdown", name: "Countdown", kind: "countdown", seconds: 10,
  description: "A ticking countdown in flip tiles (hours, minutes, seconds) to a big moment, with what happens then.",
  tags: ["countdown", "timer", "results", "launch", "clock"],
  fields: [
    F.kicker("Counting day"), F.title("Counting of votes begins in", { fill: undefined }),
    field.text("left", "Time left", "02:14:30", { required: true, hint: "hh:mm:ss (or mm:ss); it ticks down while the board is on" }),
    field.text("detail", "What happens", "Counting starts at 8 AM at 288 centres across the state", { maxLength: 80 }),
    field.text("when", "When", "Saturday, 8:00 AM", { maxLength: 30 }),
    F.source(""),
  ],
  designs: both((f) => {
    const v = f.r === "9:16";
    const tw = v ? W(f) : 1380, tx = f.X + (W(f) - tw) / 2;
    const th = v ? 420 : 400;
    const dy = f.T + (v ? 60 : 30) + th + (v ? 40 : 36);
    return [
      ...frame(f),
      layer("number", "timer", [tx, f.T + (v ? 60 : 30), tw, th], {
        field: "left", mode: "timer", units: "hms", tiles: true, size: v ? 180 : 220, weight: 700, color: "@text", tileFill: "@dark/80", unitColor: "@accent",
        labelSize: v ? 34 : 32, labelColor: "@text/75", tileLabels: "Days, Hours, Minutes, Seconds", delay: 0.6, flip: true,
      }, { anim: anim(step("zoom", { dur: 0.55, delay: 0.35 }), step("fade", { dur: 0.3 })) }),
      text("detail", [f.X, dy, W(f), v ? 130 : 64], "{detail}", { font: "@body", size: v ? 42 : 40, weight: 600, color: "@text/90", align: "center", maxLines: 2, fit: "shrink", valign: "top" }, { anim: riseIO(0.9), when: "{detail}" }),
      rect("whenbg", [f.X + (W(f) - (v ? 520 : 460)) / 2, dy + (v ? 150 : 86), v ? 520 : 460, v ? 76 : 68], { fill: "@accent", shape: "pill", glass: "off" }, { anim: popIO(1.1), when: "{when}" }),
      icon("when_i", [f.X + (W(f) - (v ? 520 : 460)) / 2 + 24, dy + (v ? 150 : 86) + (v ? 18 : 16), v ? 40 : 36, v ? 40 : 36], "calendar", { color: "@dark" }, { anim: popIO(1.2), when: "{when}" }),
      text("when", [f.X + (W(f) - (v ? 520 : 460)) / 2 + (v ? 76 : 70), dy + (v ? 150 : 86), (v ? 520 : 460) - (v ? 100 : 94), v ? 76 : 68], "{when}", { font: "@headline", size: v ? 36 : 32, weight: 700, color: "@dark", maxLines: 1, fit: "shrink", upper: "look" },
        { anim: fadeIO(1.2), when: "{when}" }),
    ];
  }),
});

// ── 15. map with pins ────────────────────────────────────────────────────────

const map = board({
  id: "map", name: "Map with pins", kind: "map", seconds: 12,
  description: "Your own map picture with pins dropping on the places in the story, pulsing, with name tags; plus a short list of facts.",
  tags: ["map", "pins", "location", "districts", "route", "alert"],
  fields: [
    F.kicker("Monsoon watch"), F.title("Red alert in five districts"),
    field.image("map", "Map picture", { required: true, hint: "Your own map image (there is no built-in map)" }),
    field.table("pins", "Pins", [
      { id: "label", label: "Place", type: "text" }, { id: "x", label: "Across (0–1)", type: "number" }, { id: "y", label: "Down (0–1)", type: "number" },
      { id: "note", label: "Note", type: "text" }, { id: "color", label: "Colour", type: "color" },
    ], [
      row({ label: "Kozhikode", x: 0.32, y: 0.22, note: "210 mm in 24 hours" }),
      row({ label: "Thrissur", x: 0.44, y: 0.44, note: "Dam shutters opened" }),
      row({ label: "Kochi", x: 0.4, y: 0.58, note: "Metro services cut" }),
      row({ label: "Idukki", x: 0.66, y: 0.56, note: "Landslide warning" }),
      row({ label: "Thiruvananthapuram", x: 0.58, y: 0.84, note: "Schools shut" }),
    ], { required: true, hint: "x and y are where the pin goes on your map: 0 = left / top, 1 = right / bottom" }),
    field.list("facts", "Facts", [L("Schools shut in 5 districts"), L("NDRF teams on standby"), L("Helpline: 1077")]),
    F.source("IMD, district administrations"),
  ],
  designs: both((f) => {
    const v = f.r === "9:16";
    const mapBox: B4 = v ? [f.X, f.T, W(f), 590] : [f.X, f.T + 6, 1150, f.B - f.T - 6];
    return [
      ...frame(f),
      layer("pins", "pins", mapBox, {
        image: "map", field: "pins", fit: "contain", mapFill: "@dark/70", pinColor: "@breaking", pinSize: v ? 54 : 50, tagSize: v ? 30 : 28, delay: 0.7, stagger: 0.35, route: false,
      }, { anim: anim(step("zoom", { dur: 0.6, delay: 0.3 }), step("fade", { dur: 0.3 })), shadow: SHADOW }),
      layer("list", "facts", v ? [f.X, f.T + 620, W(f), f.B - f.T - 620] : [f.X + 1190, f.T + 6, W(f) - 1190, f.B - f.T - 6], {
        field: "facts", style: "check", size: v ? 44 : 38, plate: true, plateFill: "@dark/55", maxLines: 3, gap: 0.35, spread: !v, build: "stagger", stagger: 0.18, delay: 2.0,
      }, { anim: anim(undefined, step("fade", { dur: 0.3 })) }),
    ];
  }),
});

// ── 16. photo gallery ────────────────────────────────────────────────────────

const gallery = board({
  id: "gallery", name: "Photo gallery", kind: "gallery", seconds: 10,
  description: "Four pictures in a mosaic, each coming in after the other with its caption.",
  tags: ["gallery", "photos", "pictures", "mosaic", "in pictures"],
  fields: [
    F.kicker("In pictures"), F.title("Ganeshotsav: Mumbai bids farewell to Bappa"),
    ...[1, 2, 3, 4].map((i) => field.image(`photo${i}`, `Picture ${i}`)),
    field.text("caption1", "Caption 1", "Lalbaugcha Raja procession, Parel", { maxLength: 50 }),
    field.text("caption2", "Caption 2", "Visarjan at Girgaon Chowpatty", { maxLength: 50 }),
    field.text("caption3", "Caption 3", "ढोल-ताशा पथक, दादर", { maxLength: 50 }),
    field.text("caption4", "Caption 4", "Eco-friendly idols at Juhu", { maxLength: 50 }),
    F.source("Tatvam News photo desk"),
  ],
  designs: both((f) => {
    const v = f.r === "9:16";
    const g = 14;
    const tiles: B4[] = v
      ? [[f.X, f.T, W(f), 380], [f.X, f.T + 380 + g, (W(f) - g) / 2, 350], [f.X + (W(f) + g) / 2, f.T + 380 + g, (W(f) - g) / 2, 168], [f.X + (W(f) + g) / 2, f.T + 380 + g * 2 + 168, (W(f) - g) / 2, 168]]
      : (() => { const bw = 900, sw = W(f) - bw - g, h = f.B - f.T, sh = (h - g * 2) / 3; return [[f.X, f.T, bw, h], [f.X + bw + g, f.T, sw, sh], [f.X + bw + g, f.T + sh + g, sw, sh], [f.X + bw + g, f.T + (sh + g) * 2, sw, sh]] as B4[]; })();
    return [
      ...frame(f),
      ...tiles.flatMap(([x, y, w, h], i) => {
        const d = 0.4 + i * 0.25, ch = Math.min(i === 0 ? 76 : 58, h * 0.36) * (v ? 1.05 : 1);
        return [
          image(`photo${i + 1}`, [x, y, w, h], `photo${i + 1}`, { shape: "rounded", radius: 8, bg: "@secondary", focusY: 0.4 }, { anim: anim(step("zoom", { dur: 0.6, delay: d }), step("fade", { dur: 0.3 })), shadow: SHADOW }),
          rect(`shade${i + 1}`, [x, y + h - ch * 1.8, w, ch * 1.8], { fill: { gradient: ["@dark/0", "@dark/85"], angle: 90 }, shape: "flat", glass: "off", radius: 8 }, { anim: fadeIO(d + 0.2), when: `{caption${i + 1}}` }),
          rect(`cbar${i + 1}`, [x + 18, y + h - ch + 4, 5, ch - 22], { fill: "@accent", shape: "flat" }, { anim: growIO(d + 0.3, "up", 0.3), when: `{caption${i + 1}}` }),
          text(`caption${i + 1}`, [x + 34, y + h - ch, w - 52, ch - 14], `{caption${i + 1}}`, { font: "@body", size: Math.round(ch * 0.46), weight: 700, color: "@text", maxLines: 1, fit: "shrink" },
            { anim: riseIO(d + 0.35, 0.4), when: `{caption${i + 1}}` }),
        ];
      }),
    ];
  }),
});

export const BOARDS: GfxTemplate[] = [
  keyPoints, bigNumber, quote, poll, timeline, versus, factCheck, rates, weather, election, scorecard, headlines, profile, countdown, map, gallery,
];

/** The board frames (tests check content stays inside the safe areas). */
export const BOARD_FRAMES = { "16:9": F16, "9:16": F9 };
