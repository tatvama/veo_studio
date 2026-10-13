/**
 * Built-in "Openers" templates (docs/EDITOR.md §16.4). Owner: nr-wipes. Ids "nr.openers.<name>", stable. Full-frame
 * show packaging: a show opener (logo reveal, title, date over a moving background), a story bumper, "Stay with us",
 * a headlines intro, a "Coming up" teaser, a closing slate, a promo end card and a countdown to the show. 16:9 and
 * 9:16 (vertical keeps clear of the Reels / Shorts buttons: content sits in x 70–900, y 230–1500). They go on the
 * Boards track, above the pictures.
 */
import type { Box, GfxLayer, GfxTemplate } from "../types.ts";
import { DESIGN, anim, field, layer, logo, rect, step, text, tpl } from "./kit.ts";

type R = "16:9" | "9:16";

const bg = (r: R, style: string, p: Record<string, unknown> = {}): GfxLayer => {
  const { w, h } = DESIGN[r];
  return layer("bg", "bg", [0, 0, w, h], {
    style, period: 12, speed: 1, density: 1, seed: 5, top: "@secondary", bottom: "@dark", main: "@primary", accent: "@accent", light: "@light",
    intensity: 1, vignette: 0.55, ...p,
  }, { name: "Background", pin: { x: "stretch", y: "stretch" }, anim: anim(step("fade", { dur: 0.6 }), step("fade", { dur: 0.5 })) });
};
const fadeOut = step("fade", { dur: 0.4 });
const shine = { kind: "shine", period: 7, delay: 0.6 } as const;
const H = (size: number, extra: Record<string, unknown> = {}) => ({ font: "@headline", size, weight: 800, color: "@text", align: "center", ...extra });
const B = (size: number, extra: Record<string, unknown> = {}) => ({ font: "@body", size, color: "@text/85", align: "center", ...extra });

// ── 1. show opener ───────────────────────────────────────────────────────────

function showOpener(r: R): GfxLayer[] {
  const v = r === "9:16";
  const L = (b16: Box, b9: Box) => (v ? b9 : b16);
  return [
    bg(r, "streaks", { period: 9 }),
    logo("logo", L([660, 190, 600, 160], [185, 330, 600, 160]), {}, { anim: anim(step("pop", { delay: 0.5, dur: 0.6 }), fadeOut, { kind: "shine", period: 8, delay: 1.2 }) }),
    rect("rule", L([660, 392, 600, 6], [285, 690, 400, 6]), { fill: "@accent", shape: "flat" }, { anim: anim(step("unfold", { delay: 1, dur: 0.5 }), fadeOut) }),
    text("title", L([110, 410, 1700, 210], [70, 720, 830, 300]), "{show}", H(v ? 130 : 160, { upper: "on", tracking: 4, maxLines: v ? 2 : 1 }),
      { anim: anim(step("rise", { delay: 1.2, dur: 0.7 }), step("zoom", { dur: 0.5 }), shine) }),
    text("tagline", L([260, 640, 1400, 70], [70, 1040, 830, 130]), "{tagline}", B(v ? 44 : 42, { maxLines: 2 }), { anim: anim(step("rise", { delay: 1.8, dur: 0.6 }), fadeOut) }),
    rect("dateplate", L([740, 760, 440, 70], [285, 1200, 400, 72]), { fill: "@primary", gloss: 0.15 }, { anim: anim(step("unfold", { delay: 2.3, dur: 0.5 }), fadeOut) }),
    text("date", L([740, 760, 440, 70], [285, 1200, 400, 72]), "{$date}", H(v ? 36 : 34, { color: "@textOnPrimary", weight: 600 }), { anim: anim(step("fade", { delay: 2.6, dur: 0.4 }), fadeOut) }),
    text("host", L([460, 850, 1000, 56], [70, 1300, 830, 60]), "{host}", B(v ? 40 : 36, { color: "@accent", weight: 600 }), { when: "{host}", anim: anim(step("fade", { delay: 2.9, dur: 0.5 }), fadeOut) }),
  ];
}

// ── 2. story bumper ──────────────────────────────────────────────────────────

function storyBumper(r: R): GfxLayer[] {
  const v = r === "9:16";
  const L = (b16: Box, b9: Box) => (v ? b9 : b16);
  return [
    bg(r, "gradient", { period: 10, vignette: 0.4 }),
    rect("band", L([0, 400, 1920, 300], [0, 760, 1080, 560]), { fill: { gradient: ["@primary", "@secondary"], angle: 0 }, shape: "flat", gloss: 0.12 },
      { anim: anim(step("wipe", { dir: "right", dur: 0.45 }), step("wipe", { dir: "right", dur: 0.35 })) }),
    rect("stripe", L([0, 400, 1920, 8], [0, 760, 1080, 8]), { fill: "@accent", shape: "flat" }, { anim: anim(step("wipe", { dir: "right", delay: 0.1, dur: 0.45 }), step("wipe", { dir: "right", dur: 0.3 })) }),
    rect("labelplate", L([150, 350, 240, 70], [60, 700, 240, 76]), { fill: "@accent" }, { anim: anim(step("pop", { delay: 0.25, dur: 0.4 }), fadeOut) }),
    text("label", L([150, 350, 240, 70], [60, 700, 240, 76]), "{label}", H(v ? 42 : 40, { color: "@dark", upper: "on" }), { anim: anim(step("fade", { delay: 0.35, dur: 0.3 }), fadeOut) }),
    text("title", L([150, 440, 1620, 230], [60, 810, 840, 470]), "{title}", H(v ? 76 : 74, { color: "@textOnPrimary", align: "left", weight: 700, maxLines: v ? 4 : 2 }),
      { anim: anim(step("stagger", { by: "word", delay: 0.3, dur: 0.6 }), fadeOut) }),
  ];
}

// ── 3. stay with us ──────────────────────────────────────────────────────────

function stayWithUs(r: R): GfxLayer[] {
  const v = r === "9:16";
  const L = (b16: Box, b9: Box) => (v ? b9 : b16);
  return [
    bg(r, "bokeh", { period: 16, vignette: 0.6 }),
    logo("logo", L([780, 280, 360, 110], [305, 420, 360, 110]), {}, { anim: anim(step("fade", { delay: 0.1, dur: 0.5 }), fadeOut) }),
    text("line1", L([110, 420, 1700, 180], [70, 620, 830, 340]), "{line1}", H(v ? 120 : 132, { upper: "on", tracking: 3, maxLines: 2 }),
      { anim: anim(step("zoom", { delay: 0.2, dur: 0.6 }), fadeOut, shine) }),
    rect("rule", L([840, 620, 240, 6], [365, 990, 240, 6]), { fill: "@accent", shape: "flat" }, { anim: anim(step("unfold", { delay: 0.5, dur: 0.4 }), fadeOut) }),
    text("line2", L([260, 650, 1400, 70], [70, 1020, 830, 130]), "{line2}", B(v ? 46 : 44, { maxLines: 2 }), { anim: anim(step("rise", { delay: 0.6, dur: 0.5 }), fadeOut) }),
  ];
}

// ── 4. headlines intro ───────────────────────────────────────────────────────

function headlinesIntro(r: R): GfxLayer[] {
  const v = r === "9:16";
  const L = (b16: Box, b9: Box) => (v ? b9 : b16);
  return [
    bg(r, "hex", { period: 8 }),
    rect("bar", L([150, 400, 16, 300], [70, 740, 16, 400]), { fill: "@accent", shape: "flat" }, { anim: anim(step("grow", { dir: "up", delay: 0.15, dur: 0.4 }), fadeOut) }),
    logo("logo", L([196, 300, 300, 90], [104, 590, 300, 100]), { align: "left" }, { anim: anim(step("fade", { delay: 0.4, dur: 0.5 }), fadeOut) }),
    text("title", L([190, 400, 1500, 190], [100, 750, 800, 190]), "{title}", H(v ? 150 : 176, { align: "left", upper: "on", tracking: 4 }),
      { anim: anim(step("wipe", { dir: "right", delay: 0.3, dur: 0.6 }), step("wipe", { dir: "right", dur: 0.4 }), shine) }),
    rect("timeplate", L([196, 610, 280, 76], [104, 960, 260, 76]), { fill: "@primary", gloss: 0.15 }, { anim: anim(step("grow", { dir: "right", delay: 0.7, dur: 0.4 }), fadeOut) }),
    text("time", L([196, 610, 280, 76], [104, 960, 260, 76]), "{time}", H(v ? 42 : 42, { color: "@textOnPrimary" }), { anim: anim(step("fade", { delay: 0.9, dur: 0.3 }), fadeOut) }),
    text("date", L([500, 610, 800, 76], [104, 1050, 790, 64]), "{$date}", B(v ? 38 : 36, { align: "left" }), { anim: anim(step("slide", { dir: "right", delay: 1, dur: 0.5, distance: 40 }), fadeOut) }),
  ];
}

// ── 5. coming up ─────────────────────────────────────────────────────────────

function comingUp(r: R): GfxLayer[] {
  const v = r === "9:16";
  const out: GfxLayer[] = [
    bg(r, "grid", { period: 8 }),
    rect("titleplate", v ? [60, 300, 520, 92] : [96, 130, 560, 100], { fill: "@primary", gloss: 0.18 }, { anim: anim(step("grow", { dir: "right", dur: 0.45 }), fadeOut) }),
    text("title", v ? [60, 300, 520, 92] : [96, 130, 560, 100], "{title}", H(v ? 56 : 60, { color: "@textOnPrimary", upper: "on" }), { anim: anim(step("fade", { delay: 0.25, dur: 0.35 }), fadeOut) }),
  ];
  for (let i = 0; i < 3; i++) {
    const y = v ? 450 + i * 320 : 290 + i * 210;
    const h = v ? 280 : 170;
    const plate: Box = v ? [60, y, 840, h] : [96, y, 1560, h];
    const badge: Box = v ? [60, y, 130, h] : [96, y, 170, h];
    const item: Box = v ? [216, y + 10, 664, h - 20] : [300, y + 10, 1320, h - 20];
    const d = 0.5 + i * 0.28;
    out.push(
      rect(`plate${i + 1}`, plate, { fill: "@dark/82", stripe: "bottom", stripeColor: "@accent", stripeWidth: 5 }, { anim: anim(step("grow", { dir: "right", delay: d, dur: 0.45 }), step("fade", { dur: 0.35, delay: i * 0.08 })) }),
      rect(`badge${i + 1}`, badge, { fill: "@primary", shape: "flat" }, { anim: anim(step("wipe", { dir: "down", delay: d + 0.15, dur: 0.35 }), step("fade", { dur: 0.35, delay: i * 0.08 })) }),
      text(`num${i + 1}`, badge, String(i + 1), { font: "@numbers", size: v ? 90 : 96, weight: 700, color: "@textOnPrimary", align: "center" }, { anim: anim(step("pop", { delay: d + 0.3, dur: 0.4 }), step("fade", { dur: 0.35, delay: i * 0.08 })) }),
      text(`item${i + 1}`, item, `{item${i + 1}}`, { font: "@headline", size: v ? 48 : 50, weight: 600, color: "@text", align: "left", maxLines: v ? 4 : 2 },
        { clip: `plate${i + 1}`, when: `{item${i + 1}}`, anim: anim(step("rise", { delay: d + 0.25, dur: 0.5 }), step("fade", { dur: 0.35, delay: i * 0.08 })) }),
    );
  }
  return out;
}

// ── 6. closing slate ─────────────────────────────────────────────────────────

function closingSlate(r: R): GfxLayer[] {
  const v = r === "9:16";
  const L = (b16: Box, b9: Box) => (v ? b9 : b16);
  return [
    bg(r, "gradient", { period: 20, vignette: 0.45 }),
    logo("logo", L([610, 230, 700, 200], [160, 420, 650, 190]), {}, { anim: anim(step("pop", { delay: 0.1, dur: 0.6 }), fadeOut, { kind: "shine", period: 6, delay: 0.6 }) }),
    text("thanks", L([160, 480, 1600, 120], [70, 680, 830, 210]), "{thanks}", H(v ? 80 : 84, { maxLines: 2 }), { anim: anim(step("rise", { delay: 0.5, dur: 0.6 }), fadeOut) }),
    rect("rule", L([860, 630, 200, 6], [385, 910, 200, 6]), { fill: "@accent", shape: "flat" }, { anim: anim(step("unfold", { delay: 0.8, dur: 0.4 }), fadeOut) }),
    text("web", L([360, 670, 1200, 64], [70, 950, 830, 64]), "{web}", B(v ? 42 : 42, { color: "@text" }), { when: "{web}", anim: anim(step("fade", { delay: 1, dur: 0.5 }), fadeOut) }),
    text("social", L([360, 740, 1200, 64], [70, 1024, 830, 64]), "{social}", B(v ? 42 : 42, { color: "@accent", weight: 600 }), { when: "{social}", anim: anim(step("fade", { delay: 1.15, dur: 0.5 }), fadeOut) }),
  ];
}

// ── 7. promo end card ────────────────────────────────────────────────────────

function promoEndCard(r: R): GfxLayer[] {
  const v = r === "9:16";
  const L = (b16: Box, b9: Box) => (v ? b9 : b16);
  return [
    bg(r, "streaks", { period: 10, seed: 9 }),
    text("show", L([130, 330, 1060, 220], [70, 470, 830, 340]), "{show}", H(v ? 140 : 150, { align: v ? "center" : "left", upper: "on", maxLines: 2 }),
      { anim: anim(step("rise", { delay: 0.2, dur: 0.6 }), fadeOut, shine) }),
    rect("whenplate", L([136, 580, 600, 88], [195, 840, 580, 88]), { fill: "@accent", gloss: 0.15 }, { anim: anim(step("grow", { dir: "right", delay: 0.5, dur: 0.45 }), fadeOut) }),
    text("when", L([136, 580, 600, 88], [195, 840, 580, 88]), "{when}", H(v ? 50 : 50, { color: "@dark", upper: "on" }), { anim: anim(step("fade", { delay: 0.75, dur: 0.35 }), fadeOut) }),
    rect("divider", L([1260, 320, 4, 440], [335, 990, 300, 4]), { fill: "@light/45", shape: "flat" }, { anim: anim(step("grow", { dir: v ? "right" : "down", delay: 0.6, dur: 0.5 }), fadeOut) }),
    text("only", L([1310, 380, 480, 60], [70, 1030, 830, 60]), "{only}", B(v ? 38 : 36, { upper: "on", tracking: 6 }), { anim: anim(step("fade", { delay: 0.8, dur: 0.4 }), fadeOut) }),
    logo("logo", L([1320, 460, 460, 170], [235, 1110, 500, 170]), {}, { anim: anim(step("pop", { delay: 0.9, dur: 0.6 }), fadeOut, { kind: "shine", period: 5, delay: 0.8 }) }),
  ];
}

// ── 8. countdown to the show ─────────────────────────────────────────────────

function countdown(r: R): GfxLayer[] {
  const v = r === "9:16";
  const L = (b16: Box, b9: Box) => (v ? b9 : b16);
  return [
    bg(r, "globe", v ? { period: 12, vignette: 0.6 } : { period: 12, vignette: 0.6, cx: 0.5, cy: 0.42, r: 0.42 }),
    text("label", L([560, 150, 800, 70], [70, 380, 830, 70]), "{label}", H(v ? 46 : 44, { color: "@accent", upper: "on", tracking: 8 }), { anim: anim(step("fade", { delay: 0.2, dur: 0.5 }), fadeOut) }),
    layer("countdown", "count", L([735, 240, 450, 450], [235, 470, 500, 500]), { from: 9, delay: 0.5, color: "@text", ring: "@accent", track: "@light/20", font: "@numbers", width: 16 },
      { name: "Countdown", anim: anim(step("pop", { delay: 0.1, dur: 0.6 }), step("zoom", { dur: 0.5 })) }),
    text("show", L([160, 720, 1600, 160], [70, 1010, 830, 270]), "{show}", H(v ? 110 : 120, { upper: "on", maxLines: 2 }), { anim: anim(step("rise", { delay: 0.4, dur: 0.6 }), fadeOut, shine) }),
    logo("logo", L([810, 900, 300, 90], [335, 1310, 300, 90]), {}, { anim: anim(step("fade", { delay: 0.6, dur: 0.5 }), fadeOut) }),
  ];
}

const both = (f: (r: R) => GfxLayer[]) => ({ "16:9": f("16:9"), "9:16": f("9:16") });

export const OPENERS: GfxTemplate[] = [
  tpl({
    id: "nr.openers.show_opener", name: "Show opener", category: "Openers", role: "board", kind: "opener",
    description: "The logo, the show's name and today's date over moving light.", tags: ["opener", "show"],
    seconds: 9, timing: { in: 3.4, out: 0.8 }, hold: "fixed",
    fields: [field.text("show", "Show", "Prime Time", { maxLength: 22 }), field.text("tagline", "Tagline", "The day's biggest stories, explained"),
      field.text("host", "Host", "with Ananya Rao", { hint: "Leave empty to hide" })],
    designs: both(showOpener), sounds: { in: "whoosh", cut: "impact" },
  }),
  tpl({
    id: "nr.openers.story_bumper", name: "Story bumper", category: "Openers", role: "board", kind: "bumper",
    description: "A quick band with the next story's title.", tags: ["bumper", "story"],
    seconds: 2.5, timing: { in: 0.8, out: 0.4 }, hold: "fixed",
    fields: [field.text("label", "Label", "Next"), field.longtext("title", "Story", "Assam floods: rescue teams reach cut-off villages", { maxItems: 2 })],
    designs: both(storyBumper), sounds: { in: "swish", out: "swish" },
  }),
  tpl({
    id: "nr.openers.stay_with_us", name: "Stay with us", category: "Openers", role: "board", kind: "bumper",
    description: "The break bumper: STAY WITH US and what comes after the break.", tags: ["bumper", "break"],
    seconds: 3.5, timing: { in: 1, out: 0.5 }, hold: "fixed",
    fields: [field.text("line1", "Big line", "Stay with us"), field.text("line2", "Small line", "More after the break")],
    designs: both(stayWithUs), sounds: { in: "whoosh" },
  }),
  tpl({
    id: "nr.openers.headlines_intro", name: "Headlines intro", category: "Openers", role: "board", kind: "opener",
    description: "HEADLINES with the bulletin time and date.", tags: ["opener", "headlines"],
    seconds: 4, timing: { in: 1.3, out: 0.5 }, hold: "fixed",
    fields: [field.text("title", "Title", "Headlines"), field.text("time", "Bulletin time", "9 PM")],
    designs: both(headlinesIntro), sounds: { in: "whoosh", cut: "impact" },
  }),
  tpl({
    id: "nr.openers.coming_up", name: "Coming up", category: "Openers", role: "board", kind: "teaser",
    description: "A teaser board with the next three stories.", tags: ["teaser", "list"],
    seconds: 6, timing: { in: 1.6, out: 0.5 }, hold: "fixed",
    fields: [field.text("title", "Title", "Coming up"),
      field.text("item1", "Story 1", "Monsoon update: heavy rain alert for coastal Karnataka"),
      field.text("item2", "Story 2", "Cricket: India squad named for the home series"),
      field.text("item3", "Story 3", "मुंबई मेट्रो की नई लाइन पर आज से सफ़र शुरू")],
    designs: both(comingUp), sounds: { in: "swish" },
  }),
  tpl({
    id: "nr.openers.closing_slate", name: "Closing slate", category: "Openers", role: "board", kind: "slate",
    description: "The sign-off: logo, thank you, website and handle.", tags: ["closing", "slate"],
    seconds: 5, timing: { in: 1.2, out: 0.6 }, hold: "fixed",
    fields: [field.text("thanks", "Thank you line", "Thank you for watching"), field.text("web", "Website", "yourchannel.in"), field.text("social", "Social handle", "@yourchannel")],
    designs: both(closingSlate), sounds: { in: "swish" },
  }),
  tpl({
    id: "nr.openers.promo_end_card", name: "Promo end card", category: "Openers", role: "board", kind: "promo",
    description: "The end of a promo: the show, when it's on, and the channel.", tags: ["promo", "end card"],
    seconds: 5, timing: { in: 1.2, out: 0.5 }, hold: "fixed",
    fields: [field.text("show", "Show", "Prime Time"), field.text("when", "When", "Weeknights 9 PM"), field.text("only", "Above the logo", "Only on")],
    designs: both(promoEndCard), sounds: { in: "whoosh", cut: "impact" },
  }),
  tpl({
    id: "nr.openers.countdown", name: "Countdown to the show", category: "Openers", role: "board", kind: "countdown",
    description: "Counts down from 9 to the show over a turning globe.", tags: ["countdown", "opener"],
    seconds: 10, timing: { in: 0.8, out: 0.6 }, hold: "fixed",
    fields: [field.text("label", "Label", "Live in"), field.text("show", "Show", "Prime Time")],
    designs: both(countdown), sounds: { in: "whoosh" },
  }),
];
