/**
 * Lab-only sample templates (ids "lab.*", never in the product): they exercise the core kinds and animations (plate
 * growth, staggers, Indic text, loops, icons, pictures) so the renderer can be checked before the built-ins exist.
 * Pure data.
 */
import { anim, field, icon, image, line, logo, rect, step, text, tpl } from "../templates/kit.ts";
import { iconList } from "../render/icons.ts";
import type { GfxLayer, GfxTemplate } from "../types.ts";

const strap = tpl({
  id: "lab.strap", name: "Lab · name strap", category: "Straps", role: "strap", seconds: 6, timing: { in: 0.8, out: 0.4 },
  fields: [field.text("name", "Name", "Dr. Venkataraghavan Subramaniam"), field.text("role", "Role", "Senior correspondent, Bengaluru")],
  designs: {
    "16:9": [
      rect("plate", [120, 806, 760, 84], { fill: { gradient: ["@primary", "@secondary"], angle: 0 }, gloss: 0.12, stripe: "left", stripeWidth: 10 }, { anim: anim(step("grow", { dur: 0.45 }), step("grow", { dur: 0.3 })), shadow: { color: "rgba(0,0,0,0.35)", blur: 18, x: 0, y: 6 } }),
      rect("sub", [120, 890, 620, 52], { fill: "@light", shape: "flat" }, { anim: anim(step("grow", { dur: 0.4, delay: 0.12 }), step("grow", { dur: 0.3 })) }),
      text("name", [150, 806, 700, 84], "{name}", { font: "@headline", size: 54, color: "@textOnPrimary", upper: "look", grow: { layers: ["plate"], pad: 34, min: 360, max: 1100 } }, { clip: "plate", anim: anim(step("rise", { dur: 0.45, delay: 0.18 }), step("fade", { dur: 0.25 })) }),
      text("role", [150, 890, 590, 52], "{role}", { font: "@body", size: 32, color: "@dark", grow: { layers: ["sub"], pad: 30, min: 260, max: 900 } }, { clip: "sub", anim: anim(step("slide", { dir: "right", dur: 0.4, delay: 0.26, distance: 60 }), step("fade", { dur: 0.25 })) }),
    ],
    "9:16": [
      rect("plate", [70, 1180, 860, 96], { fill: { gradient: ["@primary", "@secondary"], angle: 0 }, gloss: 0.12, stripe: "left", stripeWidth: 12 }, { anim: anim(step("grow", { dur: 0.45 }), step("grow", { dur: 0.3 })) }),
      rect("sub", [70, 1276, 700, 60], { fill: "@light", shape: "flat" }, { anim: anim(step("grow", { dur: 0.4, delay: 0.12 }), step("grow", { dur: 0.3 })) }),
      text("name", [104, 1180, 800, 96], "{name}", { font: "@headline", size: 60, color: "@textOnPrimary", upper: "look", maxLines: 1, grow: { layers: ["plate"], pad: 34, min: 360, max: 860 } }, { clip: "plate", anim: anim(step("rise", { dur: 0.45, delay: 0.18 }), step("fade", { dur: 0.25 })) }),
      text("role", [104, 1276, 660, 60], "{role}", { font: "@body", size: 36, color: "@dark", grow: { layers: ["sub"], pad: 30, min: 260, max: 860 } }, { clip: "sub", anim: anim(step("slide", { dir: "right", dur: 0.4, delay: 0.26, distance: 60 }), step("fade", { dur: 0.25 })) }),
    ],
  },
});

const headline = tpl({
  id: "lab.headline", name: "Lab · headline (Hindi)", category: "Straps", role: "strap", seconds: 7, timing: { in: 1.2, out: 0.5 },
  fields: [field.text("tag", "Tag", "BREAKING"), field.longtext("headline", "Headline", "मुंबई में भारी बारिश से लोकल ट्रेनें रुकीं, स्कूल और दफ्तर आज बंद रहेंगे")],
  designs: {
    "16:9": [
      rect("tagbg", [96, 770, 230, 56], { fill: "@breaking", shape: "angled", ends: "right" }, { anim: anim(step("wipe", { dir: "right", dur: 0.35 }), step("fade")) }),
      text("tag", [96, 770, 210, 56], "{tag}", { font: "@headline", size: 34, color: "#FFFFFF", align: "center", tracking: 2 }, { anim: anim(step("fade", { delay: 0.2, dur: 0.3 }), step("fade")), when: "{tag}" }),
      icon("dot", [300, 784, 28, 28], "live", { color: "#FFFFFF" }, { anim: anim(step("pop", { delay: 0.3 }), undefined, { kind: "blink", period: 1 }) }),
      rect("plate", [96, 826, 1300, 150], { fill: "@dark/88", shape: "flat", stripe: "top", stripeWidth: 6 }, { anim: anim(step("unfold", { dur: 0.5, delay: 0.1 }), step("fade", { dur: 0.3 })) }),
      text("headline", [130, 836, 1240, 130], "{headline}", { font: "@headline", size: 56, color: "@text", maxLines: 2 }, { anim: anim(step("stagger", { by: "word", delay: 0.45, dur: 0.6 }), step("fade", { dur: 0.3 })) }),
    ],
    "9:16": [
      rect("tagbg", [60, 1000, 260, 64], { fill: "@breaking", shape: "angled", ends: "right" }, { anim: anim(step("wipe", { dir: "right", dur: 0.35 }), step("fade")) }),
      text("tag", [60, 1000, 240, 64], "{tag}", { font: "@headline", size: 38, color: "#FFFFFF", align: "center" }, { anim: anim(step("fade", { delay: 0.2 }), step("fade")) }),
      rect("plate", [60, 1064, 900, 260], { fill: "@dark/88", shape: "flat", stripe: "top", stripeWidth: 6 }, { anim: anim(step("unfold", { dur: 0.5, delay: 0.1 }), step("fade", { dur: 0.3 })) }),
      text("headline", [92, 1076, 840, 236], "{headline}", { font: "@headline", size: 62, color: "@text", maxLines: 3 }, { anim: anim(step("stagger", { by: "word", delay: 0.45, dur: 0.6 }), step("fade", { dur: 0.3 })) }),
    ],
  },
});

const bug = tpl({
  id: "lab.bug", name: "Lab · live bug + clock", category: "Bugs", role: "bug", seconds: 0, loop: true, timing: { in: 0.6, out: 0 },
  fields: [field.text("label", "Label", "LIVE"), field.text("place", "Place", "New Delhi")],
  designs: {
    "16:9": [
      rect("logoplate", [1580, 54, 250, 92], { fill: "@primary", shape: "look", gloss: 0.18 }, { anim: anim(step("pop", { dur: 0.5 }), undefined, { kind: "shine", period: 6, delay: 1 }) }),
      logo("logo", [1592, 60, 226, 80], {}, { anim: anim(step("fade", { delay: 0.2 })) }),
      rect("liveplate", [1580, 154, 120, 40], { fill: "@live", shape: "flat", radius: 4 }, { anim: anim(step("wipe", { dir: "right", delay: 0.3, dur: 0.3 })) }),
      icon("dot", [1590, 164, 20, 20], "live", { color: "#FFFFFF" }, { anim: anim(step("fade", { delay: 0.5 }), undefined, { kind: "blink", period: 1.2 }) }),
      text("label", [1614, 154, 80, 40], "{label}", { font: "@headline", size: 26, color: "#FFFFFF", weight: 700 }, { anim: anim(step("fade", { delay: 0.5 })) }),
      rect("clockplate", [1704, 154, 126, 40], { fill: "@dark/80", shape: "flat" }, { anim: anim(step("wipe", { dir: "right", delay: 0.4, dur: 0.3 })) }),
      text("clock", [1704, 154, 126, 40], "{$time}", { font: "@numbers", size: 26, color: "@text", align: "center" }, { anim: anim(step("fade", { delay: 0.6 })) }),
    ],
    "9:16": [
      rect("logoplate", [760, 240, 250, 92], { fill: "@primary", gloss: 0.18 }, { anim: anim(step("pop"), undefined, { kind: "shine", period: 6, delay: 1 }) }),
      logo("logo", [772, 246, 226, 80], {}, {}),
      rect("liveplate", [760, 340, 120, 40], { fill: "@live", shape: "flat" }, { anim: anim(step("wipe", { dir: "right", delay: 0.3 })) }),
      icon("dot", [770, 350, 20, 20], "live", { color: "#FFFFFF" }, { anim: anim(undefined, undefined, { kind: "blink", period: 1.2 }) }),
      text("label", [794, 340, 80, 40], "{label}", { font: "@headline", size: 26, color: "#FFFFFF" }, {}),
    ],
  },
});

function iconSheet(): GfxTemplate {
  const list = iconList();
  const cols = 10, cw = 170, ch = 150;
  const layers: GfxLayer[] = [rect("bg", [60, 60, 1800, 960], { fill: "@dark/85", shape: "rounded", radius: 24 })];
  list.forEach(([id], i) => {
    const x = 90 + (i % cols) * cw, y = 90 + Math.floor(i / cols) * ch;
    layers.push(icon(`i_${id}`, [x + 45, y, 80, 80], id, { color: "@text", color2: "@accent" }, { anim: anim(step("pop", { delay: 0.01 * i, dur: 0.4 })) }));
    layers.push(text(`t_${id}`, [x, y + 86, cw - 10, 30], id, { font: "@body", size: 18, color: "@text/70", align: "center" }));
  });
  layers.push(line("rule", [90, 1000, 1740, 4], { color: "@accent", dash: "dash" }));
  return tpl({ id: "lab.icons", name: "Lab · icons", category: "Boards", role: "board", seconds: 6, fields: [], designs: { "16:9": layers } });
}

const quote = tpl({
  id: "lab.quote", name: "Lab · quote with photo", category: "Boards", role: "board", seconds: 8, timing: { in: 1, out: 0.4 },
  fields: [field.image("photo", "Photo"), field.longtext("quote", "Quote", "We will restore power to every village before the festival. Crews are already working through the night."),
    field.text("who", "Who", "Priya Rao, Energy Minister")],
  designs: {
    "16:9": [
      rect("card", [240, 200, 1440, 600], { fill: { gradient: ["@secondary", "@dark"], angle: 90 }, shape: "rounded", radius: 18, stripe: "left", stripeWidth: 12 }, { anim: anim(step("zoom", { dur: 0.5 }), step("fade")), shadow: { color: "rgba(0,0,0,0.45)", blur: 40, x: 0, y: 16 } }),
      image("photo", [300, 290, 340, 340], "photo", { shape: "circle", border: "@accent", borderWidth: 6 }, { anim: anim(step("pop", { delay: 0.2 }), step("fade")) }),
      icon("q", [700, 250, 90, 90], "quote_open", { color: "@accent" }, { anim: anim(step("drop", { delay: 0.3 }), step("fade")) }),
      text("quote", [700, 340, 900, 300], "{quote}", { font: "@body", size: 48, weight: 600, color: "@text", lineHeight: 1.25, valign: "top" }, { anim: anim(step("fade", { by: "line", delay: 0.45, dur: 0.6 }), step("fade")) }),
      line("rule", [700, 660, 120, 6], { color: "@accent", width: 6 }, { anim: anim(step("grow", { delay: 0.7 }), step("fade")) }),
      text("who", [700, 680, 900, 60], "— {who}", { font: "@body", size: 32, color: "@text/80" }, { anim: anim(step("typewriter", { delay: 0.8, dur: 0.8 }), step("fade")) }),
    ],
  },
});

export const LAB_SAMPLES: GfxTemplate[] = [strap, headline, bug, iconSheet(), quote];
export const labSample = (id: string) => LAB_SAMPLES.find((t) => t.id === id);
