/**
 * Built-in "Bugs" templates (docs/EDITOR.md §16.4). Owner: nr-tickers. Ids "nr.bugs.<name>", stable forever. The
 * small graphics that stay in a corner: the channel logo (a light sweep every 10 s), the LIVE bug with a blinking dot
 * and the clock, a corner clock, date, clock and date, temperature, and EXCLUSIVE / RECORDED / BREAKING tags. Each
 * has a 16:9 and a 9:16 design. The logo is drawn top right (the template's `kind` "logo" lets the renderer move it
 * to the look's bug corner); the rest sit top left, clear of the logo.
 */
import type { GfxDesign, GfxLayer, GfxTemplate } from "../types.ts";
import { anim, field, icon, layer, logo, rect, step, text, tpl } from "./kit.ts";
import { SAFE_16_9, SAFE_9_16 } from "./tickers.ts";

const d169 = (layers: GfxLayer[]): GfxDesign => ({ layers, safe: SAFE_16_9 });
const d916 = (layers: GfxLayer[]): GfxDesign => ({ layers, safe: SAFE_9_16 });

const OUT = step("fade", { dur: 0.3 });
const plateIn = anim(step("wipe", { dir: "right", dur: 0.4 }), OUT);
const textIn = anim(step("fade", { dur: 0.35, delay: 0.18 }), OUT);
const clockLayer = (id: string, box: [number, number, number, number], p: Record<string, unknown>, extra: Partial<Omit<GfxLayer, "id" | "kind" | "box" | "p">> = {}) =>
  layer("clock", id, box, p, { anim: textIn, ...extra });

/** Top-left anchor and scale per ratio (9:16 sizes are 1.15×, below the platform's top bar). */
const AT = { "16:9": { x: 96, y: 64, k: 1 }, "9:16": { x: 65, y: 250, k: 1.15 } } as const;
type R = keyof typeof AT;
const s = (r: R, v: number) => Math.round(v * AT[r].k);
const bx = (r: R, x: number, y: number, w: number, h: number): [number, number, number, number] => [AT[r].x + s(r, x), AT[r].y + s(r, y), s(r, w), s(r, h)];

const base = (id: string, name: string, kind: string, description: string, tags: string[], fields: GfxTemplate["fields"], design: (r: R) => GfxLayer[], sounds?: GfxTemplate["sounds"]) =>
  tpl({
    id, name, category: "Bugs", role: "bug", kind, description, tags, seconds: 0, hold: "fill", loop: true, timing: { in: 0.6, out: 0.4 }, fields,
    designs: { "16:9": d169(design("16:9")), "9:16": d916(design("9:16")) }, ...(sounds ? { sounds } : {}),
  });

const logoBug = tpl({
  id: "nr.bugs.logo", name: "Logo bug", category: "Bugs", role: "bug", kind: "logo",
  description: "The channel logo in its corner, with a light sweep every 10 seconds.",
  tags: ["logo", "bug", "channel", "watermark"], seconds: 0, hold: "fill", loop: true, timing: { in: 0.7, out: 0.4 },
  fields: [],
  designs: {
    "16:9": d169([logo("logo", [1584, 62, 240, 90], { align: "right" }, { opacity: 0.92, shadow: { color: "#00000073", blur: 10, x: 0, y: 2 }, anim: anim(step("fade", { dur: 0.6 }), OUT, { kind: "shine", period: 10, delay: 1.5 }) })]),
    "9:16": d916([logo("logo", [690, 248, 210, 80], { align: "right" }, { opacity: 0.92, shadow: { color: "#00000073", blur: 10, x: 0, y: 2 }, anim: anim(step("fade", { dur: 0.6 }), OUT, { kind: "shine", period: 10, delay: 1.5 }) })]),
  },
});

const live = base("nr.bugs.live", "LIVE bug", "live", "A red LIVE tag with a blinking dot and the clock.", ["live", "bug", "clock"],
  [field.text("text", "Text", "Live", { maxLength: 10 }), field.toggle("showClock", "Show the clock", true)],
  (r) => [
    rect("plate", bx(r, 0, 0, 168, 50), { fill: "@live", shape: "look", ends: "right", gloss: 0.12 }, { anim: plateIn }),
    icon("dot", bx(r, 14, 14, 22, 22), "live", { color: "#FFFFFF" }, { anim: { ...textIn, loop: { kind: "blink", period: 1.2, amount: 0.15, delay: 0.4 } } }),
    text("text", bx(r, 42, 0, 112, 50), "{text}", { font: "@headline", size: s(r, 30), weight: 800, color: "#FFFFFF", upper: "on", tracking: 1.5, align: "left", valign: "middle", fit: "shrink", maxLines: 1 }, { anim: textIn }),
    rect("clock_plate", bx(r, 154, 0, 132, 50), { fill: "@dark/88", shape: "look", ends: "left" }, { anim: anim(step("wipe", { dir: "right", dur: 0.4, delay: 0.12 }), OUT), when: "{showClock}" }),
    clockLayer("clock", bx(r, 170, 0, 108, 50), { show: "time", size: s(r, 30), color: "@text" }, { when: "{showClock}" }),
  ], { in: "swish" });

const cornerClock = base("nr.bugs.clock", "Corner clock", "clock", "The time in the corner, with a blinking colon.", ["clock", "time", "bug"],
  [],
  (r) => [
    rect("plate", bx(r, 0, 0, 168, 56), { fill: "@dark/82", shape: "look", stripe: "left", stripeColor: "@accent", stripeWidth: s(r, 5) }, { anim: plateIn }),
    clockLayer("clock", bx(r, 8, 0, 154, 56), { show: "time", size: s(r, 36), color: "@text", blink: true }),
  ]);

const cornerDate = base("nr.bugs.date", "Corner date", "date", "Today's date in the look's style.", ["date", "day", "bug"],
  [],
  (r) => [
    rect("plate", bx(r, 0, 0, 300, 48), { fill: "@dark/82", shape: "look", stripe: "left", stripeColor: "@accent", stripeWidth: s(r, 5) }, { anim: plateIn }),
    clockLayer("date", bx(r, 22, 0, 268, 48), { show: "date", size: s(r, 27), color: "@text", font: "@headline", upper: "on", align: "center" }),
  ]);

const clockDate = base("nr.bugs.clock_date", "Clock and date", "clock_date", "The time with the date under it.", ["clock", "date", "time", "bug"],
  [],
  (r) => [
    rect("plate", bx(r, 0, 0, 236, 98), { fill: "@dark/82", shape: "look", stripe: "left", stripeColor: "@accent", stripeWidth: s(r, 5) }, { anim: plateIn }),
    clockLayer("clock", bx(r, 10, 4, 220, 90), { show: "time+date", size: s(r, 44), dateScale: 0.42, color: "@text", dateColor: "@text/80", dateFont: "@headline", upper: "on", blink: true }),
  ]);

const WEATHER_ICONS = [
  { value: "sun", label: "Sunny" }, { value: "cloud_sun", label: "Partly cloudy" }, { value: "cloud", label: "Cloudy" },
  { value: "rain", label: "Rain" }, { value: "storm", label: "Thunderstorm" }, { value: "fog", label: "Fog or haze" },
  { value: "wind", label: "Windy" }, { value: "snow", label: "Snow" },
];
const temperature = base("nr.bugs.temperature", "Temperature", "temperature", "A city's temperature with a weather icon.", ["weather", "temperature", "bug"],
  [field.text("city", "City", "New Delhi", { maxLength: 18 }), field.number("temp", "Temperature (°C)", 34, { decimals: 0 }), field.choice("icon", "Weather", WEATHER_ICONS, "fog")],
  (r) => [
    rect("plate", bx(r, 0, 0, 330, 60), { fill: "@dark/82", shape: "look", stripe: "left", stripeColor: "@accent", stripeWidth: s(r, 5) }, { anim: plateIn }),
    clockLayer("temp", bx(r, 18, 0, 146, 60), { show: "temp", field: "temp", icon: "{icon}", size: s(r, 34), color: "@text", iconColor: "@accent", align: "left" }),
    text("city", bx(r, 166, 0, 154, 60), "{city}", { font: "@headline", size: s(r, 24), weight: 700, color: "@text/90", upper: "on", tracking: 1, align: "left", valign: "middle", fit: "shrink", maxLines: 2, lineHeight: 1 }, { anim: textIn }),
  ]);

const tag = (id: string, name: string, kind: string, description: string, tags: string[], def: string, plate: Record<string, unknown>, color: string, loop?: { kind: string; period: number; amount?: number; delay?: number }, sounds?: GfxTemplate["sounds"]) =>
  base(id, name, kind, description, tags, [field.text("text", "Text", def, { maxLength: 16 })], (r) => [
    rect("plate", bx(r, 0, 0, 260, 52), { shape: "look", ...plate }, { anim: loop ? { ...plateIn, loop } : plateIn }),
    text("text", bx(r, 0, 0, 260, 52), "{text}", { font: "@headline", size: s(r, 30), weight: 800, color, upper: "on", tracking: 2, align: "center", valign: "middle", padX: s(r, 14), fit: "shrink", maxLines: 1 }, { anim: textIn }),
  ], sounds);

const exclusive = tag("nr.bugs.exclusive", "EXCLUSIVE tag", "exclusive", "Marks an exclusive story; a light sweeps across it.", ["exclusive", "tag", "bug"],
  "Exclusive", { fill: "@accent", gloss: 0.1 }, "@dark", { kind: "shine", period: 9, delay: 1 }, { in: "swish" });
const recorded = tag("nr.bugs.recorded", "RECORDED tag", "recorded", "Marks recorded or file footage.", ["recorded", "file", "archive", "tag", "bug"],
  "Recorded", { fill: "@dark/78", stripe: "left", stripeColor: "@text/70", stripeWidth: 4 }, "@text/92");
const breakingTag = tag("nr.bugs.breaking", "BREAKING tag", "breaking", "A flashing BREAKING tag for the corner.", ["breaking", "flash", "tag", "bug"],
  "Breaking", { fill: "@breaking", gloss: 0.14 }, "#FFFFFF", { kind: "flash", period: 1.2, amount: 0.7 }, { in: "impact" });

export const BUGS: GfxTemplate[] = [logoBug, live, cornerClock, cornerDate, clockDate, temperature, exclusive, recorded, breakingTag];
