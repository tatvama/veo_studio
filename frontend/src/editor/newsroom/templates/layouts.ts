/**
 * Built-in "Layouts" templates (docs/EDITOR.md §16.4, §16.6). Owner: nr-layouts. Ids "nr.layouts.<name>", stable.
 * 13 made for 16:9 (anchor + over-the-shoulder box left / right, two-way, three-way, four-way debate, six-box big
 * debate, side panel, squeeze-back / L-band, split-screen vs, picture-in-picture, explainer frame, video wall, speed
 * news) and 8 made for 9:16 first (headline + video + caption, top / bottom two-way, stacked three-way, news card, quote
 * card, breaking card, stat card, story counter); every one has both designs. Box 0 is always the main picture.
 *
 * Space: 16:9 keeps the header at y 40–100 and boxes in y 118–882, so tickers and straps have the bottom; 9:16 keeps
 * text clear of the top 12 %, the bottom 22 % and the right 16 % where Reels and Shorts draw their buttons.
 */
import { backdrop, body, fadeIn, FLOAT, header, headline, kicker, OUT, panel, point, POP, rise, S16, S9, SLIDE, tagged, UNFOLD, vbox, WIPE, wipeIn, ZOOM } from "../layouts/kit.ts";
import type { GfxField, GfxLayer, GfxTemplate } from "../types.ts";
import { anim, field, icon, image, layer, line, rect, step, text, tpl } from "./kit.ts";

interface L {
  id: string; name: string; kind: string; description: string; tags?: string[];
  fields: GfxField[]; d16: GfxLayer[]; d9: GfxLayer[]; seconds?: number;
}
const layout = (l: L): GfxTemplate => tpl({
  id: `nr.layouts.${l.id}`, name: l.name, category: "Layouts", role: "layout", kind: l.kind, description: l.description,
  tags: ["layout", ...(l.tags ?? [])], seconds: l.seconds ?? 20, timing: { in: 0.8, out: 0.45 }, hold: "until-next",
  fields: l.fields, designs: { "16:9": l.d16, "9:16": l.d9 }, sounds: { in: "whoosh", out: "swish" },
});

const topic = (def: string) => field.text("topic", "Topic", def, { hint: "The header; leave empty to hide it", maxLength: 70, fill: "story.headline" });
const person = (i: number, label: string, name: string, role: string, roleLabel = "Role") => [
  field.text(`name${i}`, `${label} name`, name, { group: label, fill: "person.name" }),
  field.text(`role${i}`, `${label} ${roleLabel.toLowerCase()}`, role, { group: label, fill: "person.role" }),
];
const live = (i: number, label: string, on = true) => field.toggle(`live${i}`, `${label}: LIVE tag`, on, { group: label });
const place = (i: number, label: string, def: string) => field.text(`place${i}`, `${label} place`, def, { group: label, fill: "place" });

/** Box frame presets. */
const LINE = { frame: "line", frameColor: "@light/85" };
const ACCENT = { frame: "line", frameColor: "@accent", frameWidth: 3 };

// ── 16:9 first ──────────────────────────────────────────────────────────────

const OTS = (side: "left" | "right"): GfxTemplate => {
  const L = side === "left";
  return layout({
    id: `anchor_ots_${side}`, name: `Anchor + box (${side})`, kind: "anchor",
    description: `The anchor full frame with an over-the-shoulder box on the ${side}: a picture with a caption and a tag.`,
    tags: ["anchor", "ots"],
    fields: [field.text("caption", "Caption", "Cyclone Dana nears the Odisha coast", { maxLength: 50, fill: "story.headline" }), field.text("kicker", "Tag", "BREAKING", { maxLength: 18 })],
    d16: [
      vbox(0, [0, 0, 1920, 1080], { frame: "none", inner: 0 }, step("none")),
      vbox(1, L ? [120, 132, 720, 405] : [1080, 132, 720, 405], { ...LINE, frameWidth: 4, inner: 0.25, label: "{caption}", labelStyle: "bar", labelSize: 30, tag: "{kicker}", tagStyle: "plain", tagPos: L ? "tl" : "tr" },
        WIPE(L ? "right" : "left", 0.05, 0.55), FLOAT),
    ],
    d9: [
      vbox(0, [0, 0, 1080, 1920], { frame: "none", inner: 0 }, step("none")),
      vbox(1, L ? [48, 280, 720, 405] : [312, 280, 720, 405], { ...LINE, frameWidth: 4, inner: 0.25, label: "{caption}", labelStyle: "bar", labelSize: 30, tag: "{kicker}", tagStyle: "plain", tagPos: "tl" },
        WIPE(L ? "right" : "left", 0.05, 0.55), FLOAT),
    ],
  });
};

const TWO_WAY = layout({
  id: "two_way", name: "Two-way", kind: "two_way",
  description: "Anchor and reporter side by side, with name tags, the reporter's place and a LIVE tag.",
  tags: ["anchor", "reporter", "live"],
  fields: [topic("Metro phase 2 opens to the public"), ...person(0, "Anchor", "Priya Rao", "Anchor"),
    field.text("name1", "Reporter name", "Venkataramanan Subramaniam", { group: "Reporter", fill: "person.name" }), place(1, "Reporter", "Bengaluru"), live(1, "Reporter")],
  d16: [
    backdrop(S16),
    ...header(72, 40, 1150),
    vbox(0, [72, 118, 880, 764], { ...LINE, ...tagged("name0", "role0") }, SLIDE("right", 0.05)),
    vbox(1, [968, 118, 880, 764], { ...LINE, ...tagged("name1", "place1"), tag: "LIVE", tagOn: "live1" }, SLIDE("left", 0.13)),
  ],
  d9: [
    backdrop(S9),
    ...header(40, 238, 860, 64, "topic", 36),
    vbox(0, [24, 318, 1032, 572], { ...LINE, ...tagged("name0", "role0") }, SLIDE("right", 0.05)),
    vbox(1, [24, 906, 1032, 572], { ...LINE, ...tagged("name1", "place1"), tag: "LIVE", tagOn: "live1" }, SLIDE("left", 0.13)),
  ],
});

const THREE_WAY = layout({
  id: "three_way", name: "Three-way", kind: "three_way",
  description: "The anchor large with two guests stacked beside, each with a name tag.",
  tags: ["anchor", "guests"],
  fields: [topic("Water crisis: who is responsible?"), ...person(0, "Anchor", "Priya Rao", "Anchor"),
    ...person(1, "Guest 1", "Dr. Arvind Kulkarni", "Hydrologist, IISc"), ...person(2, "Guest 2", "डॉ. अनुराधा मिश्रा", "जल नीति विशेषज्ञ")],
  d16: [
    backdrop(S16),
    ...header(72, 40, 1150),
    vbox(0, [72, 118, 1064, 764], { ...LINE, ...tagged("name0", "role0") }, POP(0.04)),
    vbox(1, [1152, 118, 696, 374], { ...LINE, ...tagged("name1", "role1") }, SLIDE("left", 0.14)),
    vbox(2, [1152, 508, 696, 374], { ...LINE, ...tagged("name2", "role2") }, SLIDE("left", 0.22)),
  ],
  d9: [
    backdrop(S9),
    ...header(40, 238, 860, 64, "topic", 36),
    vbox(0, [24, 318, 1032, 600], { ...LINE, ...tagged("name0", "role0") }, POP(0.04)),
    vbox(1, [24, 934, 508, 544], { ...LINE, ...tagged("name1", "role1") }, SLIDE("up", 0.14)),
    vbox(2, [548, 934, 508, 544], { ...LINE, ...tagged("name2", "role2") }, SLIDE("up", 0.22)),
  ],
});

const DEBATE_NAMES: [string, string][] = [["Priya Rao", "Anchor"], ["Sudhanshu Trivedi", "BJP spokesperson"], ["Supriya Shrinate", "Congress spokesperson"], ["Yogendra Yadav", "Political analyst"],
  ["Rakesh Tikait", "Bharatiya Kisan Union"], ["Dr. Sanjay Kumar", "CSDS-Lokniti"]];

const FOUR_WAY = layout({
  id: "four_way", name: "Four-way debate", kind: "debate",
  description: "A two-by-two debate grid with a name and party or role in every box.",
  tags: ["debate", "panel", "grid"],
  fields: [topic("किसान आंदोलन: आगे क्या?"), ...DEBATE_NAMES.slice(0, 4).flatMap(([n, r], i) => person(i, i === 0 ? "Anchor" : `Guest ${i}`, n, r))],
  d16: [
    backdrop(S16, { texture: "grid", textureColor: "@light/4" }),
    ...header(72, 40, 1150),
    ...[[72, 118], [968, 118], [72, 508], [968, 508]].map(([x, y], i) => vbox(i, [x, y, 880, 374], { ...ACCENT, ...tagged(`name${i}`, `role${i}`) }, POP(0.05 + i * 0.08))),
  ],
  d9: [
    backdrop(S9, { texture: "grid", textureColor: "@light/4" }),
    ...header(40, 238, 860, 64, "topic", 36),
    ...[[24, 318], [548, 318], [24, 902], [548, 902]].map(([x, y], i) => vbox(i, [x, y, 508, 572], { ...ACCENT, ...tagged(`name${i}`, `role${i}`) }, POP(0.05 + i * 0.08))),
  ],
});

const SIX_WAY = layout({
  id: "six_way", name: "Big debate (six boxes)", kind: "debate",
  description: "Six boxes for the big debate, each with a name bar across its foot.",
  tags: ["debate", "panel", "grid"],
  fields: [topic("Big debate: one nation, one election"), ...DEBATE_NAMES.flatMap(([n, r], i) => person(i, i === 0 ? "Anchor" : `Guest ${i}`, n, r))],
  d16: [
    backdrop(S16, { texture: "grid", textureColor: "@light/4" }),
    ...header(72, 40, 1150),
    ...[0, 1, 2, 3, 4, 5].map((i) => vbox(i, [72 + (i % 3) * 597, 118 + Math.floor(i / 3) * 390, 581, 374],
      { ...ACCENT, ...tagged(`name${i}`, `role${i}`), labelStyle: "bar" }, POP(0.04 + i * 0.06))),
  ],
  d9: [
    backdrop(S9, { texture: "grid", textureColor: "@light/4" }),
    ...header(40, 238, 860, 64, "topic", 36),
    ...[0, 1, 2, 3, 4, 5].map((i) => vbox(i, [24 + (i % 2) * 524, 318 + Math.floor(i / 2) * 392, 508, 376],
      { ...ACCENT, ...tagged(`name${i}`, `role${i}`), labelStyle: "bar" }, POP(0.04 + i * 0.06))),
  ],
});

const POINT_FIELDS = (a: string, b: string, c: string) => [field.text("point1", "Point 1", a, { group: "Points" }), field.text("point2", "Point 2", b, { group: "Points" }), field.text("point3", "Point 3", c, { group: "Points" })];

const SIDE_PANEL = layout({
  id: "side_panel", name: "Video + info panel", kind: "panel",
  description: "The picture with an info panel beside it: a kicker, the headline and three points.",
  tags: ["panel", "points", "explainer"],
  fields: [field.text("kicker", "Kicker", "KEY POINTS"), field.longtext("headline", "Headline", "RBI keeps the repo rate at 6.5% for the ninth time in a row", { maxItems: 3, fill: "story.headline" }),
    ...POINT_FIELDS("Inflation forecast cut to 4.5%", "GDP growth seen at 7.2% this year", "Next policy review on 6 December")],
  d16: [
    backdrop(S16),
    vbox(0, [72, 118, 1136, 640], { ...LINE }, POP(0.04)),
    panel("panel", [1224, 118, 624, 764], 0.1),
    ...kicker("kick", 1256, 150, 400, 44, "kicker", 26, 0.24),
    headline("headline", [1256, 214, 560, 196], "{headline}", 46, 0.3, { maxLines: 4 }),
    line("rule", [1256, 430, 560, 4], { color: "@accent/60", width: 2 }, { anim: wipeIn(0.38) }),
    ...point(1, 1256, 462, 560, 120, 32, 0.44), ...point(2, 1256, 594, 560, 120, 32, 0.52), ...point(3, 1256, 726, 560, 120, 32, 0.6),
  ],
  d9: [
    backdrop(S9),
    vbox(0, [24, 250, 1032, 580], { ...LINE }, POP(0.04)),
    panel("panel", [24, 846, 1032, 634], 0.1),
    ...kicker("kick", 56, 878, 400, 50, "kicker", 30, 0.24),
    headline("headline", [56, 948, 840, 200], "{headline}", 50, 0.3, { maxLines: 3 }),
    line("rule", [56, 1164, 840, 4], { color: "@accent/60", width: 2 }, { anim: wipeIn(0.38) }),
    ...point(1, 56, 1190, 840, 90, 34, 0.44), ...point(2, 56, 1284, 840, 90, 34, 0.52), ...point(3, 56, 1378, 840, 90, 34, 0.6),
  ],
});

const SQUEEZE = layout({
  id: "squeeze_back", name: "Squeeze-back (L-band)", kind: "squeeze",
  description: "The picture squeezes back into a box while an L-shaped frame comes in with an info or ad panel and a sponsor.",
  tags: ["squeeze", "l-band", "ad", "sponsor"],
  fields: [
    field.text("panelTitle", "Panel title", "Festive offers", { group: "Panel" }),
    field.longtext("panelText", "Panel text", "Up to 40% off on home appliances this Diwali", { group: "Panel" }),
    field.image("ad", "Ad picture", { group: "Panel", hint: "Fills the panel instead of the text" }),
    field.image("sponsor", "Sponsor logo", { group: "Band" }),
    field.text("sponsorText", "Sponsor line", "Presented by", { group: "Band" }),
    field.text("bandText", "Band text", "Visit your nearest store · Toll free 1800 123 4567", { group: "Band" }),
  ],
  d16: [
    backdrop(S16, { bands: "none", glowX: 0.92, glowY: 0.5 }),
    vbox(0, [64, 64, 1408, 792], { frame: "line", frameColor: "@light/70", frameWidth: 2, inner: 0.25 }, ZOOM(0)),
    panel("panel", [1488, 64, 368, 792], 0.2, "@primary"),
    headline("panelTitle", [1516, 104, 312, 140], "{panelTitle}", 44, 0.34, { color: "@textOnPrimary", maxLines: 2, upper: "look" }, ),
    body("panelText", [1516, 262, 312, 420], "{panelText}", 32, 0.42, { color: "@textOnPrimary/90", maxLines: 7 }),
    image("adpic", [1488, 70, 368, 786], "ad", { fit: "cover", bg: "" }, { when: "{ad}", anim: fadeIn(0.3) }),
    rect("band", [64, 872, 1792, 150], { shape: "flat", fill: { gradient: ["@secondary", "@dark"], angle: 0 }, stripe: "top", stripeColor: "@accent", stripeWidth: 4 }, { anim: anim(step("slide", { dir: "up", dur: 0.5, delay: 0.24, distance: 160 }), OUT) }),
    text("sponsorText", [100, 890, 260, 36], "{sponsorText}", { font: "@body", size: 24, weight: 500, color: "@light/70", upper: "on", tracking: 1.5 }, { when: "{sponsor}", anim: fadeIn(0.45) }),
    image("sponsorLogo", [100, 930, 260, 76], "sponsor", { fit: "contain", bg: "" }, { when: "{sponsor}", anim: fadeIn(0.5) }),
    text("bandText", [400, 872, 1420, 150], "{bandText}", { font: "@headline", size: 44, weight: 600, color: "@light", fit: "shrink", maxLines: 1 }, { when: "{sponsor}", anim: rise(0.5) }),
    text("bandText_full", [104, 872, 1716, 150], "{bandText}", { font: "@headline", size: 44, weight: 600, color: "@light", fit: "shrink", maxLines: 1 }, { when: "!{sponsor}", anim: rise(0.5) }),
  ],
  d9: [
    backdrop(S9, { bands: "none", glowY: 0.7 }),
    vbox(0, [40, 238, 1000, 562], { frame: "line", frameColor: "@light/70", frameWidth: 2, inner: 0.25 }, ZOOM(0)),
    panel("panel", [40, 816, 1000, 468], 0.2, "@primary"),
    headline("panelTitle", [76, 850, 820, 120], "{panelTitle}", 52, 0.34, { color: "@textOnPrimary", maxLines: 2, upper: "look" }),
    body("panelText", [76, 980, 820, 280], "{panelText}", 38, 0.42, { color: "@textOnPrimary/90", maxLines: 5 }),
    image("adpic", [40, 822, 1000, 462], "ad", { fit: "cover", bg: "" }, { when: "{ad}", anim: fadeIn(0.3) }),
    rect("band", [40, 1300, 1000, 178], { shape: "flat", fill: { gradient: ["@secondary", "@dark"], angle: 0 }, stripe: "top", stripeColor: "@accent", stripeWidth: 4 }, { anim: anim(step("slide", { dir: "up", dur: 0.5, delay: 0.24, distance: 160 }), OUT) }),
    text("sponsorText", [76, 1318, 300, 34], "{sponsorText}", { font: "@body", size: 24, weight: 500, color: "@light/70", upper: "on", tracking: 1.5 }, { when: "{sponsor}", anim: fadeIn(0.45) }),
    image("sponsorLogo", [76, 1356, 240, 100], "sponsor", { fit: "contain", bg: "" }, { when: "{sponsor}", anim: fadeIn(0.5) }),
    text("bandText", [340, 1340, 560, 120], "{bandText}", { font: "@headline", size: 34, weight: 600, color: "@light", fit: "shrink", maxLines: 2, lineHeight: 1.1 }, { when: "{sponsor}", anim: rise(0.5) }),
    text("bandText_full", [76, 1320, 824, 140], "{bandText}", { font: "@headline", size: 38, weight: 600, color: "@light", fit: "shrink", maxLines: 2, lineHeight: 1.1 }, { when: "!{sponsor}", anim: rise(0.5) }),
  ],
});

/** The "VS" disc between the two sides. */
const vsBadge = (x: number, y: number, d: number): GfxLayer[] => [
  rect("vs_disc", [x, y, d, d], { fill: { gradient: ["@primary", "@secondary"], angle: 120 }, shape: "pill", stroke: "@accent", strokeWidth: 5, gloss: 0.18 },
    { name: "VS disc", anim: anim(step("pop", { dur: 0.5, delay: 0.32, ease: "back" }), OUT, { kind: "shine", period: 9, delay: 1 }), shadow: { color: "#000000aa", blur: 30, x: 0, y: 8 } }),
  text("vs", [x, y, d, d], "{vs}", { font: "@headline", size: d * 0.42, weight: 800, color: "@textOnPrimary", align: "center", upper: "on", fit: "shrink" }, { anim: anim(step("pop", { dur: 0.45, delay: 0.42 }), OUT) }),
];

const SPLIT_VS = layout({
  id: "split_vs", name: "Split-screen vs", kind: "vs",
  description: "Two sides face off with a VS badge between them and a name bar on each side.",
  tags: ["vs", "split", "sports", "debate"],
  fields: [topic("The final word: India vs Australia"), ...person(0, "Left", "Rohit Sharma", "India", "Side"), ...person(1, "Right", "Pat Cummins", "Australia", "Side"), field.text("vs", "Badge", "VS", { maxLength: 4 })],
  d16: [
    backdrop(S16, { texture: "rays", textureColor: "@light/3" }),
    ...header(72, 40, 1150),
    vbox(0, [56, 118, 888, 764], { frame: "thick", frameWidth: 5, frameColor: "@primary", ...tagged("name0", "role0"), labelStyle: "bar" }, SLIDE("right", 0.04, 0.6)),
    vbox(1, [976, 118, 888, 764], { frame: "thick", frameWidth: 5, frameColor: "@accent", ...tagged("name1", "role1"), labelStyle: "bar" }, SLIDE("left", 0.04, 0.6)),
    ...vsBadge(880, 420, 160),
  ],
  d9: [
    backdrop(S9, { texture: "rays", textureColor: "@light/3" }),
    ...header(40, 238, 860, 64, "topic", 36),
    vbox(0, [24, 318, 1032, 566], { frame: "thick", frameWidth: 5, frameColor: "@primary", ...tagged("name0", "role0"), labelStyle: "bar" }, SLIDE("down", 0.04, 0.6)),
    vbox(1, [24, 916, 1032, 566], { frame: "thick", frameWidth: 5, frameColor: "@accent", ...tagged("name1", "role1"), labelStyle: "bar" }, SLIDE("up", 0.04, 0.6)),
    ...vsBadge(470, 830, 140),
  ],
});

const PIP = layout({
  id: "pip", name: "Picture-in-picture", kind: "pip",
  description: "The main picture full frame with a second one in a framed inset above the ticker.",
  tags: ["pip", "inset"],
  fields: [field.text("label", "Inset label", "Visuals from Wayanad", { maxLength: 40 }), live(1, "Inset", true)],
  d16: [
    vbox(0, [0, 0, 1920, 1080], { frame: "none", inner: 0 }, step("none")),
    vbox(1, [1312, 520, 536, 302], { frame: "thick", frameWidth: 6, frameColor: "@light", inner: 0.2, label: "{label}", labelStyle: "bar", labelSize: 26, tag: "LIVE", tagOn: "live1", tagPos: "tl" }, UNFOLD(0.05), FLOAT),
  ],
  d9: [
    vbox(0, [0, 0, 1080, 1920], { frame: "none", inner: 0 }, step("none")),
    vbox(1, [404, 1096, 496, 372], { frame: "thick", frameWidth: 6, frameColor: "@light", inner: 0.2, label: "{label}", labelStyle: "bar", labelSize: 26, tag: "LIVE", tagOn: "live1", tagPos: "tl" }, UNFOLD(0.05), FLOAT),
  ],
});

const EXPLAINER = layout({
  id: "explainer", name: "Explainer frame", kind: "explainer",
  description: "A full-screen explainer in the channel's frame: a title bar, a step caption and the source.",
  tags: ["explainer", "full screen"],
  fields: [field.text("kicker", "Kicker", "EXPLAINED"), field.text("title", "Title", "How UPI moves money in two seconds", { fill: "story.headline" }),
    field.text("step", "Step caption", "1. You scan and pay"), field.text("source", "Source", "NPCI")],
  d16: [
    backdrop(S16, { texture: "lines", textureColor: "@light/4", bands: "none" }),
    rect("bar", [0, 0, 1920, 104], { shape: "flat", fill: { gradient: ["@dark", "@secondary"], angle: 0 }, stripe: "bottom", stripeColor: "@accent", stripeWidth: 3 }, { anim: wipeIn(0, "right", 0.4) }),
    ...kicker("kick", 64, 28, 300, 50, "kicker", 30, 0.16),
    text("title", [340, 22, 1500, 62], "{title}", { font: "@headline", size: 40, weight: 700, color: "@light", fit: "shrink", maxLines: 1 }, { anim: rise(0.26) }),
    vbox(0, [40, 116, 1840, 924], { frame: "line", frameColor: "@accent/80", frameWidth: 3, radius: 6, inner: 0.3,
      label: "{step}", labelStyle: "plate", labelPos: "tl", labelFill: "@dark/85", labelColor: "@light", labelSize: 34, tag: "Source: {source}", tagStyle: "plain", tagPos: "br" }, WIPE("down", 0.08, 0.6)),
  ],
  d9: [
    backdrop(S9, { texture: "lines", textureColor: "@light/4", bands: "none" }),
    rect("bar", [0, 220, 1080, 130], { shape: "flat", fill: { gradient: ["@dark", "@secondary"], angle: 0 }, stripe: "bottom", stripeColor: "@accent", stripeWidth: 3 }, { anim: wipeIn(0, "right", 0.4) }),
    ...kicker("kick", 40, 236, 300, 40, "kicker", 24, 0.16),
    text("title", [40, 282, 860, 60], "{title}", { font: "@headline", size: 38, weight: 700, color: "@light", fit: "shrink", maxLines: 1 }, { anim: rise(0.26) }),
    vbox(0, [20, 362, 1040, 1116], { frame: "line", frameColor: "@accent/80", frameWidth: 3, radius: 6, inner: 0.3,
      label: "{step}", labelStyle: "plate", labelPos: "bl", labelFill: "@dark/85", labelColor: "@light", labelSize: 36, tag: "Source: {source}", tagStyle: "plain", tagPos: "tl" }, WIPE("down", 0.08, 0.6)),
  ],
});

const WALL = layout({
  id: "video_wall", name: "Video wall", kind: "wall",
  description: "Four stories at once: a featured box and three more, each with its headline.",
  tags: ["wall", "headlines", "stories"],
  fields: [topic("Top stories at 9"), field.text("story1", "Story 1", "Chandrayaan-4 gets the Cabinet's nod", { group: "Stories" }), field.text("story2", "Story 2", "Sensex crosses 85,000 for the first time", { group: "Stories" }),
    field.text("story3", "Story 3", "Orange alert: heavy rain for Kerala", { group: "Stories" }), field.text("story4", "Story 4", "मुंबई में नई मेट्रो लाइन शुरू", { group: "Stories" }),
    field.text("featured", "Featured tag", "TOP STORY")],
  d16: [
    backdrop(S16, { texture: "dots", textureColor: "@light/5" }),
    ...header(72, 40, 1150),
    vbox(0, [72, 118, 1104, 764], { ...LINE, label: "{story1}", labelStyle: "bar", tag: "{featured}", tagStyle: "plain", tagPos: "tl" }, POP(0.04)),
    ...[1, 2, 3].map((i) => vbox(i, [1192, 118 + (i - 1) * 260, 656, 244], { ...LINE, label: `{story${i + 1}}`, labelStyle: "bar", labelSize: 26 }, SLIDE("left", 0.1 + i * 0.07))),
  ],
  d9: [
    backdrop(S9, { texture: "dots", textureColor: "@light/5" }),
    ...header(40, 238, 860, 64, "topic", 36),
    vbox(0, [24, 318, 1032, 580], { ...LINE, label: "{story1}", labelStyle: "bar", tag: "{featured}", tagStyle: "plain", tagPos: "tl" }, POP(0.04)),
    ...[1, 2, 3].map((i) => vbox(i, [24 + (i - 1) * 349, 914, 334, 564], { ...LINE, label: `{story${i + 1}}`, labelStyle: "bar", labelSize: 24 }, SLIDE("up", 0.1 + i * 0.07))),
  ],
});

const SPEED = layout({
  id: "speed_news", name: "Speed news", kind: "speed",
  description: "Fast headlines: the picture, a big story number with progress, the headline and its place.",
  tags: ["speed news", "headlines", "counter"],
  fields: [field.text("kicker", "Kicker", "SPEED NEWS"), field.text("n", "Story number", "07", { hint: "Two digits read best: 07", maxLength: 3 }), field.text("total", "Stories", "25", { maxLength: 3 }),
    field.longtext("headline", "Headline", "Delhi's air turns 'severe' as AQI crosses 450 in several areas", { fill: "story.headline" }), field.text("place", "Place", "New Delhi", { fill: "place" })],
  d16: [
    backdrop(S16, { glow: "@breaking/40", bands: "lower" }),
    rect("kick_plate", [72, 40, 420, 60], { fill: "@breaking", stripe: "right", stripeColor: "@accent", stripeWidth: 10 }, { anim: wipeIn(0.04) }),
    icon("bolt", [86, 46, 48, 48], "bolt", { color: "@accent" }, { anim: anim(step("pop", { dur: 0.35, delay: 0.2 }), OUT, { kind: "pulse", period: 1.6, amount: 0.08 }) }),
    text("kick", [142, 40, 336, 60], "{kicker}", { font: "@headline", size: 36, weight: 800, color: "#FFFFFF", upper: "on", tracking: 2, fit: "shrink" }, { anim: fadeIn(0.2, 0.25) }),
    vbox(0, [72, 118, 1136, 640], { ...LINE }, SLIDE("right", 0.06)),
    panel("panel", [1224, 118, 624, 764], 0.12),
    text("num", [1256, 130, 210, 230], "{n}", { font: "@numbers", size: 190, weight: 700, color: "@accent", fit: "shrink" }, { anim: anim(step("pop", { dur: 0.45, delay: 0.26 }), OUT) }),
    text("of", [1470, 236, 340, 90], "/ {total}", { font: "@numbers", size: 56, weight: 600, color: "@light/60" }, { anim: fadeIn(0.34) }),
    layer("progress", "progress", [1256, 380, 560, 8], { at: "n", of: "total", gap: 4, fill: "@accent", rest: "@light/18" }, { anim: anim(step("fade", { dur: 0.6, delay: 0.3 }), OUT) }),
    headline("headline", [1256, 420, 560, 330], "{headline}", 46, 0.4, { maxLines: 5 }),
    icon("pin", [1250, 790, 44, 44], "pin", { color: "@accent" }, { when: "{place}", anim: fadeIn(0.5) }),
    text("place", [1300, 788, 520, 48], "{place}", { font: "@body", size: 30, weight: 600, color: "@light/85", upper: "look" }, { when: "{place}", anim: fadeIn(0.52) }),
  ],
  d9: [
    backdrop(S9, { glow: "@breaking/40", bands: "lower" }),
    rect("kick_plate", [40, 238, 420, 64], { fill: "@breaking", stripe: "right", stripeColor: "@accent", stripeWidth: 10 }, { anim: wipeIn(0.04) }),
    icon("bolt", [54, 246, 48, 48], "bolt", { color: "@accent" }, { anim: anim(step("pop", { dur: 0.35, delay: 0.2 }), OUT, { kind: "pulse", period: 1.6, amount: 0.08 }) }),
    text("kick", [110, 238, 336, 64], "{kicker}", { font: "@headline", size: 38, weight: 800, color: "#FFFFFF", upper: "on", tracking: 2, fit: "shrink" }, { anim: fadeIn(0.2, 0.25) }),
    vbox(0, [24, 318, 1032, 580], { ...LINE }, SLIDE("right", 0.06)),
    text("num", [40, 914, 190, 210], "{n}", { font: "@numbers", size: 170, weight: 700, color: "@accent", fit: "shrink" }, { anim: anim(step("pop", { dur: 0.45, delay: 0.26 }), OUT) }),
    text("of", [236, 1018, 300, 80], "/ {total}", { font: "@numbers", size: 52, weight: 600, color: "@light/60" }, { anim: fadeIn(0.34) }),
    headline("headline", [40, 1134, 860, 260], "{headline}", 50, 0.4, { maxLines: 4 }),
    icon("pin", [36, 1404, 44, 44], "pin", { color: "@accent" }, { when: "{place}", anim: fadeIn(0.5) }),
    text("place", [86, 1402, 700, 48], "{place}", { font: "@body", size: 30, weight: 600, color: "@light/85", upper: "look" }, { when: "{place}", anim: fadeIn(0.52) }),
    layer("progress", "progress", [40, 1464, 860, 8], { at: "n", of: "total", gap: 4, fill: "@accent", rest: "@light/18" }, { anim: anim(step("fade", { dur: 0.6, delay: 0.3 }), OUT) }),
  ],
});

// ── 9:16 first ──────────────────────────────────────────────────────────────

const V_HEADLINE = layout({
  id: "v_headline_video", name: "Headline + video + caption", kind: "vertical",
  description: "Made for Reels and Shorts: the headline on top, the video in the middle, a caption below.",
  tags: ["vertical", "shorts", "caption"],
  fields: [field.text("kicker", "Kicker", "BREAKING"), field.longtext("headline", "Headline", "Bengaluru gets its first driverless metro line", { fill: "story.headline" }),
    field.longtext("caption", "Caption", "The 19 km Yellow Line links RV Road to Electronic City and should carry 3.5 lakh riders a day.")],
  d9: [
    backdrop(S9, { bands: "none", glowY: 0.35 }),
    rect("head_plate", [24, 236, 1032, 236], { shape: "flat", fill: { gradient: ["@primary", "@secondary"], angle: 0 }, stripe: "left", stripeWidth: 10 }, { anim: wipeIn(0, "right", 0.45) }),
    ...kicker("kick", 60, 256, 400, 42, "kicker", 26, 0.18, "@accent"),
    headline("headline", [60, 312, 840, 150], "{headline}", 54, 0.24, { color: "@textOnPrimary", maxLines: 3 }),
    vbox(0, [0, 488, 1080, 608], { frame: "none", inner: 0.3 }, WIPE("down", 0.12, 0.55)),
    line("rule", [0, 1096, 1080, 6], { color: "@accent", width: 6 }, { anim: wipeIn(0.3) }),
    body("caption", [60, 1132, 840, 330], "{caption}", 40, 0.4, { color: "@light", maxLines: 6 }),
  ],
  d16: [
    backdrop(S16, { bands: "none" }),
    vbox(0, [72, 118, 1136, 640], { frame: "none", inner: 0.3 }, WIPE("right", 0.12, 0.55)),
    line("rule", [72, 758, 1136, 6], { color: "@accent", width: 6 }, { anim: wipeIn(0.3) }),
    rect("head_plate", [1224, 118, 624, 340], { shape: "flat", fill: { gradient: ["@primary", "@secondary"], angle: 90 }, stripe: "left", stripeWidth: 10 }, { anim: wipeIn(0, "down", 0.45) }),
    ...kicker("kick", 1258, 142, 400, 42, "kicker", 26, 0.18, "@accent"),
    headline("headline", [1258, 200, 560, 240], "{headline}", 50, 0.24, { color: "@textOnPrimary", maxLines: 4 }),
    body("caption", [1240, 484, 600, 380], "{caption}", 36, 0.4, { color: "@light", maxLines: 8 }),
  ],
});

const V_TWO_WAY = layout({
  id: "v_two_way", name: "Two-way (top and bottom)", kind: "two_way",
  description: "Made for vertical: one picture above the other, a topic band between them, names and a LIVE tag.",
  tags: ["vertical", "anchor", "reporter", "live"],
  fields: [topic("Ground report: flood relief in Assam"), ...person(0, "Top", "Priya Rao", "Studio"),
    field.text("name1", "Bottom name", "Ankita Bora", { group: "Bottom", fill: "person.name" }), place(1, "Bottom", "Guwahati"), live(1, "Bottom")],
  d9: [
    backdrop(S9, { bands: "none" }),
    vbox(0, [0, 236, 1080, 600], { frame: "none", inner: 0.3, ...tagged("name0", "role0") }, SLIDE("down", 0.04)),
    rect("band", [0, 836, 1080, 96], { shape: "flat", fill: "@primary", stripe: "bottom", stripeColor: "@accent", stripeWidth: 5 }, { when: "{topic}", anim: wipeIn(0.16, "right") }),
    text("band_text", [40, 836, 860, 92], "{topic}", { font: "@headline", size: 40, weight: 700, color: "@textOnPrimary", upper: "look", fit: "shrink", maxLines: 1 }, { when: "{topic}", anim: fadeIn(0.3) }),
    vbox(1, [0, 932, 1080, 560], { frame: "none", inner: 0.3, ...tagged("name1", "place1"), tag: "LIVE", tagOn: "live1" }, SLIDE("up", 0.1)),
  ],
  d16: [
    backdrop(S16, { bands: "none" }),
    vbox(0, [0, 96, 952, 744], { frame: "none", inner: 0.3, ...tagged("name0", "role0") }, SLIDE("right", 0.04)),
    vbox(1, [968, 96, 952, 744], { frame: "none", inner: 0.3, ...tagged("name1", "place1"), tag: "LIVE", tagOn: "live1" }, SLIDE("left", 0.1)),
    rect("band", [0, 840, 1920, 72], { shape: "flat", fill: "@primary", stripe: "bottom", stripeColor: "@accent", stripeWidth: 5 }, { when: "{topic}", anim: wipeIn(0.16, "right") }),
    text("band_text", [72, 840, 1700, 70], "{topic}", { font: "@headline", size: 38, weight: 700, color: "@textOnPrimary", upper: "look", fit: "shrink", maxLines: 1 }, { when: "{topic}", anim: fadeIn(0.3) }),
  ],
});

const V_THREE = layout({
  id: "v_three_stack", name: "Three-way (stacked)", kind: "three_way",
  description: "Made for vertical: three pictures stacked, each with a name tag.",
  tags: ["vertical", "guests"],
  fields: [topic("Budget 2026: three views"), ...person(0, "Top", "Priya Rao", "Anchor"), ...person(1, "Middle", "Dr. Arvind Subramanian", "Economist"), ...person(2, "Bottom", "राधिका गुप्ता", "CEO, Edelweiss MF")],
  d9: [
    backdrop(S9, { bands: "none" }),
    ...header(40, 238, 860, 56, "topic", 32),
    ...[0, 1, 2].map((i) => vbox(i, [0, 304 + i * 396, 1080, 384], { frame: "line", frameColor: "@light/50", frameWidth: 2, inner: 0.3, ...tagged(`name${i}`, `role${i}`) }, SLIDE(i % 2 ? "left" : "right", 0.04 + i * 0.08))),
  ],
  d16: [
    backdrop(S16, { bands: "lower" }),
    ...header(72, 40, 1150),
    ...[0, 1, 2].map((i) => vbox(i, [72 + i * 600, 118, 576, 764], { ...LINE, ...tagged(`name${i}`, `role${i}`) }, SLIDE("up", 0.04 + i * 0.08))),
  ],
});

const V_CARD = layout({
  id: "v_news_card", name: "News card", kind: "card",
  description: "Made for vertical: a card with a photo or video box, the category, the headline and three points.",
  tags: ["vertical", "card", "points"],
  fields: [field.text("category", "Category", "ECONOMY"), field.longtext("headline", "Headline", "GST collections hit ₹2.1 lakh crore in April", { fill: "story.headline" }),
    ...POINT_FIELDS("Up 12.4% from a year ago", "Maharashtra leads with ₹41,645 crore", "The highest monthly collection yet")],
  d9: [
    backdrop(S9, { bands: "corner", texture: "dots" }),
    rect("card", [32, 236, 1016, 1240], { fill: "@light", radius: 28, shape: "rounded" }, { name: "Card", anim: anim(step("rise", { dur: 0.55, distance: 80 }), OUT), shadow: { color: "#00000080", blur: 40, x: 0, y: 14 } }),
    vbox(0, [56, 260, 968, 544], { frame: "none", radius: 18, inner: 0.2 }, ZOOM(0.16)),
    ...kicker("cat", 56, 832, 500, 46, "category", 26, 0.3, "@primary", "@textOnPrimary"),
    headline("headline", [56, 898, 850, 230], "{headline}", 56, 0.36, { color: "@dark", maxLines: 3 }),
    ...point(1, 60, 1152, 846, 96, 34, 0.46, "@dark/85", "@primary"), ...point(2, 60, 1252, 846, 96, 34, 0.54, "@dark/85", "@primary"), ...point(3, 60, 1352, 846, 96, 34, 0.62, "@dark/85", "@primary"),
  ],
  d16: [
    backdrop(S16, { bands: "corner", texture: "dots" }),
    rect("card", [96, 104, 1728, 790], { fill: "@light", radius: 28, shape: "rounded" }, { name: "Card", anim: anim(step("rise", { dur: 0.55, distance: 80 }), OUT), shadow: { color: "#00000080", blur: 40, x: 0, y: 14 } }),
    vbox(0, [124, 132, 880, 734], { frame: "none", radius: 18, inner: 0.2 }, ZOOM(0.16)),
    ...kicker("cat", 1040, 156, 500, 46, "category", 26, 0.3, "@primary", "@textOnPrimary"),
    headline("headline", [1040, 224, 740, 250], "{headline}", 54, 0.36, { color: "@dark", maxLines: 4 }),
    ...point(1, 1044, 500, 740, 110, 32, 0.46, "@dark/85", "@primary"), ...point(2, 1044, 614, 740, 110, 32, 0.54, "@dark/85", "@primary"), ...point(3, 1044, 728, 740, 110, 32, 0.62, "@dark/85", "@primary"),
  ],
});

const V_QUOTE = layout({
  id: "v_quote_card", name: "Quote card", kind: "quote",
  description: "Made for vertical: the speaker in a round box, the quote large, their name and role.",
  tags: ["vertical", "quote"],
  fields: [field.longtext("quote", "Quote", "We will not rest until every village has clean drinking water.", { maxItems: 6 }),
    field.text("name", "Name", "Nirmala Sitharaman", { fill: "person.name" }), field.text("role", "Role", "Union Finance Minister", { fill: "person.role" })],
  d9: [
    backdrop(S9, { texture: "rays", textureColor: "@light/3", glowX: 0.5, glowY: 0.22, bands: "none" }),
    vbox(0, [340, 280, 400, 400], { frame: "line", frameColor: "@accent", frameWidth: 8, radius: 200, inner: 0.25 }, step("pop", { dur: 0.6, delay: 0.04, ease: "back" })),
    icon("qmark", [72, 740, 130, 110], "quote_open", { color: "@accent" }, { anim: anim(step("pop", { dur: 0.4, delay: 0.24 }), OUT) }),
    text("quote", [72, 860, 834, 420], "{quote}", { font: "@headline", size: 60, weight: 600, color: "@light", lineHeight: 1.18, fit: "shrink", maxLines: 6, valign: "top" }, { anim: anim(step("stagger", { by: "word", dur: 0.7, delay: 0.3 }), OUT) }),
    line("rule", [72, 1300, 140, 6], { color: "@accent", width: 6 }, { anim: wipeIn(0.5) }),
    text("name", [72, 1324, 834, 64], "{name}", { font: "@headline", size: 46, weight: 700, color: "@accent", upper: "look", fit: "shrink", maxLines: 1 }, { anim: rise(0.56) }),
    text("role", [72, 1392, 834, 50], "{role}", { font: "@body", size: 32, weight: 500, color: "@light/75", fit: "shrink", maxLines: 1 }, { anim: rise(0.62) }),
  ],
  d16: [
    backdrop(S16, { texture: "rays", textureColor: "@light/3", glowX: 0.2, glowY: 0.4, bands: "none" }),
    vbox(0, [150, 230, 480, 480], { frame: "line", frameColor: "@accent", frameWidth: 8, radius: 240, inner: 0.25 }, step("pop", { dur: 0.6, delay: 0.04, ease: "back" })),
    icon("qmark", [720, 170, 120, 100], "quote_open", { color: "@accent" }, { anim: anim(step("pop", { dur: 0.4, delay: 0.24 }), OUT) }),
    text("quote", [720, 280, 1110, 380], "{quote}", { font: "@headline", size: 60, weight: 600, color: "@light", lineHeight: 1.18, fit: "shrink", maxLines: 5, valign: "top" }, { anim: anim(step("stagger", { by: "word", dur: 0.7, delay: 0.3 }), OUT) }),
    line("rule", [720, 690, 140, 6], { color: "@accent", width: 6 }, { anim: wipeIn(0.5) }),
    text("name", [720, 712, 1100, 64], "{name}", { font: "@headline", size: 46, weight: 700, color: "@accent", upper: "look", fit: "shrink", maxLines: 1 }, { anim: rise(0.56) }),
    text("role", [720, 780, 1100, 50], "{role}", { font: "@body", size: 32, weight: 500, color: "@light/75", fit: "shrink", maxLines: 1 }, { anim: rise(0.62) }),
  ],
});

const V_BREAKING = layout({
  id: "v_breaking_card", name: "Breaking card", kind: "breaking",
  description: "Made for vertical: a full breaking-news card with the bulletin header, the video and the headline.",
  tags: ["vertical", "breaking"],
  fields: [field.text("kicker", "Header", "BREAKING NEWS"), field.longtext("headline", "Headline", "Earthquake of magnitude 5.8 jolts Delhi-NCR; no damage reported so far", { fill: "story.headline" })],
  d9: [
    backdrop(S9, { fill: { gradient: ["@dark", "@secondary"], angle: 90 }, glow: "@breaking/55", glowX: 0.5, glowY: 0.18, texture: "diagonal", bands: "none" }),
    rect("kick_plate", [0, 236, 1080, 168], { shape: "flat", fill: { gradient: ["@breaking", "@dark"], angle: 0 }, stripe: "bottom", stripeColor: "@accent", stripeWidth: 8 },
      { anim: anim(step("wipe", { dir: "right", dur: 0.45 }), OUT, { kind: "shine", period: 6, delay: 0.6 }) }),
    text("kick", [40, 236, 860, 160], "{kicker}", { font: "@headline", size: 92, weight: 800, color: "#FFFFFF", upper: "on", fit: "shrink", maxLines: 1, tracking: 1 }, { anim: anim(step("zoom", { dur: 0.45, delay: 0.14 }), OUT) }),
    vbox(0, [0, 420, 1080, 608], { frame: "none", inner: 0.3, tag: "LIVE", tagPos: "tl" }, WIPE("down", 0.2, 0.55)),
    headline("headline", [48, 1060, 856, 320], "{headline}", 62, 0.36, { maxLines: 4 }),
    rect("time_plate", [48, 1400, 300, 58], { fill: "@dark/85", radius: 6 }, { anim: fadeIn(0.5) }),
    icon("clock", [62, 1409, 40, 40], "clock", { color: "@accent" }, { anim: fadeIn(0.52) }),
    text("time", [112, 1400, 230, 58], "{$time}", { font: "@numbers", size: 32, weight: 600, color: "@light" }, { anim: fadeIn(0.54) }),
  ],
  d16: [
    backdrop(S16, { fill: { gradient: ["@dark", "@secondary"], angle: 90 }, glow: "@breaking/55", glowX: 0.2, glowY: 0.2, texture: "diagonal", bands: "none" }),
    rect("kick_plate", [0, 96, 1920, 140], { shape: "flat", fill: { gradient: ["@breaking", "@dark"], angle: 0 }, stripe: "bottom", stripeColor: "@accent", stripeWidth: 8 },
      { anim: anim(step("wipe", { dir: "right", dur: 0.45 }), OUT, { kind: "shine", period: 6, delay: 0.6 }) }),
    text("kick", [72, 96, 1700, 136], "{kicker}", { font: "@headline", size: 96, weight: 800, color: "#FFFFFF", upper: "on", fit: "shrink", maxLines: 1, tracking: 2 }, { anim: anim(step("zoom", { dur: 0.45, delay: 0.14 }), OUT) }),
    vbox(0, [960, 268, 888, 500], { frame: "line", frameColor: "@light/70", inner: 0.3, tag: "LIVE", tagPos: "tl" }, WIPE("left", 0.2, 0.55)),
    headline("headline", [72, 276, 840, 420], "{headline}", 60, 0.36, { maxLines: 5 }),
    rect("time_plate", [72, 720, 300, 58], { fill: "@dark/85", radius: 6 }, { anim: fadeIn(0.5) }),
    icon("clock", [86, 729, 40, 40], "clock", { color: "@accent" }, { anim: fadeIn(0.52) }),
    text("time", [136, 720, 230, 58], "{$time}", { font: "@numbers", size: 32, weight: 600, color: "@light" }, { anim: fadeIn(0.54) }),
  ],
});

const V_STAT = layout({
  id: "v_stat_card", name: "Stat card", kind: "stat",
  description: "Made for vertical: a picture with one big number, what it means, the change and the source.",
  tags: ["vertical", "number", "data"],
  fields: [field.text("stat", "Number", "₹2.4 lakh crore", { hint: "Written as you want it shown" }), field.longtext("label", "What it is", "Spent on rural roads under PMGSY since 2000"),
    field.text("change", "Change", "Up 18% in five years"), field.text("source", "Source", "Ministry of Rural Development")],
  d9: [
    backdrop(S9, { bands: "lower", glowY: 0.55 }),
    vbox(0, [24, 250, 1032, 560], { frame: "none", inner: 0.3 }, WIPE("down", 0.04, 0.55)),
    line("rule", [24, 810, 1032, 6], { color: "@accent", width: 6 }, { anim: wipeIn(0.2) }),
    text("stat", [48, 850, 856, 200], "{stat}", { font: "@numbers", size: 150, weight: 700, color: "@accent", fit: "shrink", maxLines: 1 }, { anim: anim(step("zoom", { dur: 0.5, delay: 0.26 }), OUT) }),
    headline("label", [48, 1060, 856, 180], "{label}", 46, 0.36, { maxLines: 3 }),
    rect("chg_plate", [48, 1262, 520, 60], { fill: "@up/18", radius: 30, stroke: "@up", strokeWidth: 2 }, { when: "{change}", anim: fadeIn(0.46) }),
    icon("chg_icon", [62, 1270, 44, 44], "trend_up", { color: "@up" }, { when: "{change}", anim: fadeIn(0.5) }),
    text("change", [114, 1262, 440, 60], "{change}", { font: "@body", size: 30, weight: 700, color: "@up", fit: "shrink", maxLines: 1, grow: { layers: ["chg_plate"], pad: 26, min: 200, max: 820 } }, { when: "{change}", anim: fadeIn(0.5) }),
    text("source", [48, 1420, 856, 44], "Source: {source}", { font: "@body", size: 26, weight: 500, color: "@light/55" }, { when: "{source}", anim: fadeIn(0.56) }),
  ],
  d16: [
    backdrop(S16, { bands: "lower" }),
    vbox(0, [72, 118, 880, 764], { frame: "none", inner: 0.3 }, WIPE("right", 0.04, 0.55)),
    line("rule", [952, 118, 6, 764], { color: "@accent", width: 6, dir: "v" }, { anim: wipeIn(0.2, "down") }),
    text("stat", [1010, 180, 840, 220], "{stat}", { font: "@numbers", size: 150, weight: 700, color: "@accent", fit: "shrink", maxLines: 1 }, { anim: anim(step("zoom", { dur: 0.5, delay: 0.26 }), OUT) }),
    headline("label", [1010, 420, 830, 200], "{label}", 46, 0.36, { maxLines: 3 }),
    rect("chg_plate", [1010, 650, 520, 60], { fill: "@up/18", radius: 30, stroke: "@up", strokeWidth: 2 }, { when: "{change}", anim: fadeIn(0.46) }),
    icon("chg_icon", [1024, 658, 44, 44], "trend_up", { color: "@up" }, { when: "{change}", anim: fadeIn(0.5) }),
    text("change", [1076, 650, 440, 60], "{change}", { font: "@body", size: 30, weight: 700, color: "@up", fit: "shrink", maxLines: 1, grow: { layers: ["chg_plate"], pad: 26, min: 200, max: 800 } }, { when: "{change}", anim: fadeIn(0.5) }),
    text("source", [1010, 820, 830, 44], "Source: {source}", { font: "@body", size: 26, weight: 500, color: "@light/55" }, { when: "{source}", anim: fadeIn(0.56) }),
  ],
});

const V_COUNTER = layout({
  id: "v_story_counter", name: "Story counter", kind: "counter",
  description: "Made for vertical: story progress like a phone's stories, the count (2 / 5), the video and the headline.",
  tags: ["vertical", "counter", "stories"],
  fields: [field.number("n", "Story number", 2), field.number("total", "Stories", 5), field.longtext("headline", "Headline", "Monsoon reaches Kerala three days early, says IMD", { fill: "story.headline" })],
  d9: [
    backdrop(S9, { bands: "none", glowY: 0.8 }),
    layer("progress", "progress", [40, 244, 1000, 10], { at: "n", of: "total", gap: 10, fill: "@light", rest: "@light/25" }, { anim: anim(step("fade", { dur: 0.6 }), OUT) }),
    rect("count_plate", [40, 276, 170, 60], { fill: "@primary", radius: 30, shape: "rounded" }, { anim: anim(step("pop", { dur: 0.4, delay: 0.1 }), OUT) }),
    text("count", [40, 276, 170, 60], "{n} / {total}", { font: "@numbers", size: 34, weight: 700, color: "@textOnPrimary", align: "center", fit: "shrink" }, { anim: fadeIn(0.18) }),
    vbox(0, [24, 356, 1032, 820], { frame: "none", radius: 24, inner: 0.25 }, ZOOM(0.08)),
    headline("headline", [48, 1204, 856, 260], "{headline}", 56, 0.3, { maxLines: 4 }),
  ],
  d16: [
    backdrop(S16, { bands: "none" }),
    layer("progress", "progress", [72, 52, 1776, 10], { at: "n", of: "total", gap: 12, fill: "@light", rest: "@light/25" }, { anim: anim(step("fade", { dur: 0.6 }), OUT) }),
    vbox(0, [72, 96, 1104, 786], { frame: "none", radius: 24, inner: 0.25 }, ZOOM(0.08)),
    rect("count_plate", [1224, 130, 200, 70], { fill: "@primary", radius: 35, shape: "rounded" }, { anim: anim(step("pop", { dur: 0.4, delay: 0.1 }), OUT) }),
    text("count", [1224, 130, 200, 70], "{n} / {total}", { font: "@numbers", size: 40, weight: 700, color: "@textOnPrimary", align: "center", fit: "shrink" }, { anim: fadeIn(0.18) }),
    headline("headline", [1224, 240, 624, 420], "{headline}", 58, 0.3, { maxLines: 6 }),
  ],
});

export const LAYOUTS: GfxTemplate[] = [
  OTS("left"), OTS("right"), TWO_WAY, THREE_WAY, FOUR_WAY, SIX_WAY, SIDE_PANEL, SQUEEZE, SPLIT_VS, PIP, EXPLAINER, WALL, SPEED,
  V_HEADLINE, V_TWO_WAY, V_THREE, V_CARD, V_QUOTE, V_BREAKING, V_STAT, V_COUNTER,
];
