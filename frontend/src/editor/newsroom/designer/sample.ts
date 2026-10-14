/**
 * Templates the Designer and the look editor fall back on (docs/EDITOR.md §16.8): a name strap and a headline band for
 * look previews when the built-in straps / tickers aren't there, and a blank template to start a new design from.
 * Core kinds only (rect, text, logo), so they draw with any renderer build. Pure (data).
 */
import { builtinTemplates } from "../templates/index.ts";
import { anim, field, logo, rect, step, text, tpl } from "../templates/kit.ts";
import type { GfxCategory, GfxRole, GfxTemplate } from "../types.ts";

export const SAMPLE_STRAP: GfxTemplate = tpl({
  id: "nr.sample.strap", name: "Name strap", category: "Straps", role: "strap", seconds: 6,
  fields: [field.text("name", "Name", "Priya Raghavan"), field.text("role", "Role", "Senior Correspondent, New Delhi")],
  designs: {
    "16:9": [
      rect("plate", [120, 812, 820, 92], { fill: "@primary" }, { anim: anim(step("grow", { dur: 0.45 }), step("fade", { dur: 0.3 })) }),
      rect("stripe", [120, 812, 10, 140], { fill: "@accent" }, { anim: anim(step("wipe", { dir: "down", dur: 0.35 }), step("fade", { dur: 0.3 })) }),
      rect("sub", [130, 904, 640, 48], { fill: "@secondary" }, { anim: anim(step("grow", { dur: 0.4, delay: 0.1 }), step("fade", { dur: 0.3 })) }),
      text("name", [154, 812, 760, 92], "{name}", { font: "@headline", size: 54, color: "@textOnPrimary", upper: "look" }, { anim: anim(step("slide", { dir: "up", dur: 0.45, delay: 0.12 }), step("fade", { dur: 0.25 })) }),
      text("role", [154, 904, 600, 48], "{role}", { font: "@body", size: 30, color: "@text" }, { when: "{role}", anim: anim(step("fade", { dur: 0.4, delay: 0.22 }), step("fade", { dur: 0.25 })) }),
    ],
    "9:16": [
      rect("plate", [70, 1236, 820, 104], { fill: "@primary" }, { anim: anim(step("grow", { dur: 0.45 }), step("fade", { dur: 0.3 })) }),
      rect("stripe", [70, 1236, 12, 160], { fill: "@accent" }, { anim: anim(step("wipe", { dir: "down", dur: 0.35 }), step("fade", { dur: 0.3 })) }),
      rect("sub", [82, 1340, 700, 56], { fill: "@secondary" }, { anim: anim(step("grow", { dur: 0.4, delay: 0.1 }), step("fade", { dur: 0.3 })) }),
      text("name", [106, 1236, 770, 104], "{name}", { font: "@headline", size: 62, color: "@textOnPrimary", upper: "look" }, { anim: anim(step("slide", { dir: "up", dur: 0.45, delay: 0.12 }), step("fade", { dur: 0.25 })) }),
      text("role", [106, 1340, 660, 56], "{role}", { font: "@body", size: 34, color: "@text" }, { when: "{role}", anim: anim(step("fade", { dur: 0.4, delay: 0.22 }), step("fade", { dur: 0.25 })) }),
    ],
  },
});

export const SAMPLE_BAND: GfxTemplate = tpl({
  id: "nr.sample.band", name: "Headline band", category: "Tickers", role: "ticker", seconds: 0, loop: true,
  fields: [field.text("tag", "Tag", "BREAKING"), field.text("line", "Line", "Monsoon reaches Kerala three days early · Sensex closes 412 points higher")],
  designs: {
    "16:9": [
      rect("band", [0, 980, 1920, 64], { fill: "@dark/92" }),
      rect("tagplate", [96, 980, 250, 64], { fill: "@breaking" }),
      text("tag", [96, 980, 250, 64], "{tag}", { font: "@headline", size: 36, color: "@text", align: "center", upper: "on" }),
      text("line", [370, 980, 1300, 64], "{line}", { font: "@body", size: 34, color: "@text", fit: "ellipsis" }),
      logo("logo", [1690, 984, 160, 56], { align: "right" }),
    ],
    "9:16": [
      rect("band", [0, 1420, 1080, 76], { fill: "@dark/92" }),
      rect("tagplate", [54, 1420, 250, 76], { fill: "@breaking" }),
      text("tag", [54, 1420, 250, 76], "{tag}", { font: "@headline", size: 40, color: "@text", align: "center", upper: "on" }),
      text("line", [324, 1420, 590, 76], "{line}", { font: "@body", size: 36, color: "@text", fit: "ellipsis" }),
    ],
  },
});

/** A blank template to design from: a plate and one line of text in both ratios. */
export function blankTemplate(o: { id?: string; name?: string; category?: GfxCategory; role?: GfxRole } = {}): GfxTemplate {
  const t = tpl({
    id: o.id ?? "my.new", name: o.name ?? "New graphic", category: o.category ?? "Straps", role: o.role ?? "strap", seconds: 6,
    fields: [field.text("headline", "Headline", "Your headline here")],
    designs: {
      "16:9": [
        rect("plate", [120, 840, 900, 100], { fill: "@primary" }, { anim: anim(step("grow", { dur: 0.45 }), step("fade", { dur: 0.3 })) }),
        text("headline", [150, 840, 840, 100], "{headline}", { font: "@headline", size: 56, color: "@textOnPrimary" }, { anim: anim(step("slide", { dir: "up", dur: 0.45, delay: 0.1 }), step("fade", { dur: 0.25 })) }),
      ],
      "9:16": [
        rect("plate", [70, 1260, 830, 116], { fill: "@primary" }, { anim: anim(step("grow", { dur: 0.45 }), step("fade", { dur: 0.3 })) }),
        text("headline", [100, 1260, 770, 116], "{headline}", { font: "@headline", size: 64, color: "@textOnPrimary" }, { anim: anim(step("slide", { dir: "up", dur: 0.45, delay: 0.1 }), step("fade", { dur: 0.25 })) }),
      ],
    },
  });
  t.source = "mine";
  return t;
}

/** A strap, a ticker and the logo bug to show a look with: the built-in ones when there are any, else the samples. */
export function previewTemplates(): { strap: GfxTemplate; ticker: GfxTemplate; bug: GfxTemplate | null } {
  let all: GfxTemplate[] = [];
  try { all = builtinTemplates(); } catch { /* the built-ins aren't loaded */ }
  const byId = (...ids: string[]) => ids.map((id) => all.find((t) => t.id === id)).find(Boolean);
  const strap = byId("nr.straps.reporter", "nr.straps.anchor", "nr.straps.guest") ?? all.find((t) => t.category === "Straps" && t.kind !== "ai_label") ?? SAMPLE_STRAP;
  const ticker = byId("nr.tickers.crawl", "nr.tickers.headline", "nr.tickers.breaking") ?? all.find((t) => t.category === "Tickers") ?? SAMPLE_BAND;
  const bug = byId("nr.bugs.logo") ?? null;
  return { strap, ticker, bug };
}
