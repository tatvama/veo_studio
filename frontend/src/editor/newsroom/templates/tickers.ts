/**
 * Built-in "Tickers" templates (docs/EDITOR.md §16.4). Owner: nr-tickers. Ids "nr.tickers.<name>", stable forever.
 * Sixteen systems, each with a 16:9 and a 9:16 design: crawl, flip, stacked two-row, breaking bar, category, weather,
 * markets, score bug, election, speed news, rates, alert, social, now / next, headline band and the vertical
 * two-line ticker. They loop for as long as they're on the timeline (seconds 0 = to the sequence end).
 *
 * Geometry: 16:9 sits inside EBU graphics-safe (5 %): the crawl band is y 962–1026, a headline or breaking bar sits
 * just above it (y 866–956) so both can show together. 9:16 keeps clear of the top 12 %, the bottom 22 % and the
 * right 16 % (Reels / Shorts buttons): bands end at y 1486 and x 907, text is 1.15× and crawls run slower. Plates
 * may bleed past the frame's left edge (decoration); text never leaves the safe area.
 */
import type { AnimStep, GfxDesign, GfxLayer, GfxListItem, GfxTemplate } from "../types.ts";
import { anim, field, icon, layer, rect, step, text, tpl } from "./kit.ts";

/** Safe areas (design px: top, right, bottom, left). */
export const SAFE_16_9: [number, number, number, number] = [54, 96, 54, 96];
export const SAFE_9_16: [number, number, number, number] = [231, 173, 423, 65];
const d169 = (layers: GfxLayer[]): GfxDesign => ({ layers, safe: SAFE_16_9 });
const d916 = (layers: GfxLayer[]): GfxDesign => ({ layers, safe: SAFE_9_16 });

// ── motion: plates lead, text follows; out 0.3–0.4 s ─────────────────────────

const OUT_BAND = step("wipe", { dir: "left", dur: 0.38 });
const OUT_FADE = step("fade", { dur: 0.3 });
const A = {
  band: anim(step("wipe", { dir: "right", dur: 0.5 }), OUT_BAND),
  tab: anim(step("wipe", { dir: "right", dur: 0.42, delay: 0.08 }), OUT_BAND),
  tabR: anim(step("wipe", { dir: "left", dur: 0.42, delay: 0.12 }), OUT_FADE),
  label: anim(step("rise", { dur: 0.42, delay: 0.24, distance: 26 }), OUT_FADE),
  items: anim(step("wipe", { dir: "right", dur: 0.6, delay: 0.14 }), OUT_FADE),
  text: anim(step("wipe", { dir: "right", dur: 0.5, delay: 0.3 }), OUT_FADE),
  fade: anim(step("fade", { dur: 0.4, delay: 0.3 }), OUT_FADE),
  grow: anim(step("grow", { dir: "right", dur: 0.5 }), OUT_BAND),
  pop: anim(step("pop", { dur: 0.4, delay: 0.16 }), OUT_FADE),
};
const blink = (period: number, delay = 0) => ({ kind: "blink", period, amount: 0, delay });
const withLoop = (a: ReturnType<typeof anim>, loop: { kind: string; period: number; amount?: number; delay?: number }) => ({ ...a, loop });
const inStep = (s: AnimStep) => anim(s, OUT_FADE);

// ── building blocks ──────────────────────────────────────────────────────────

/** The band behind a ticker: a deep gradient with an accent line on top. */
const band = (id: string, box: [number, number, number, number], o: Record<string, unknown> = {}) =>
  rect(id, box, { fill: { gradient: ["@secondary", "@dark"], angle: 90 }, shape: "flat", stripe: "top", stripeColor: "@accent", stripeWidth: 4, ...o }, { anim: A.band });
/** A 9:16 band: from past the left edge to x 928, its right end in the look's plate style. */
const vband = (id: string, y: number, h: number, o: Record<string, unknown> = {}) =>
  rect(id, [-24, y, 952, h], { fill: { gradient: ["@secondary", "@dark"], angle: 90 }, shape: "look", ends: "right", stripe: "top", stripeColor: "@accent", stripeWidth: 4, ...o }, { anim: A.band });
/** A label tab bleeding off the left edge (its text inside the safe area), with a thin edge on its right end. */
const tab = (id: string, box: [number, number, number, number], fill = "@primary", edge = "@accent") =>
  rect(id, box, { fill, shape: "look", ends: "right", stripe: "right", stripeColor: edge, stripeWidth: Math.max(4, Math.round(box[3] * 0.07)) }, { anim: A.tab });
const label = (id: string, box: [number, number, number, number], value: string, size: number, color = "@textOnPrimary", o: Record<string, unknown> = {}) =>
  text(id, box, value, { font: "@headline", size, weight: 700, color, upper: "on", tracking: 1.5, align: "left", valign: "middle", fit: "shrink", maxLines: 1, ...o }, { anim: A.label });
type Extra = Partial<Omit<GfxLayer, "id" | "kind" | "box" | "p">>;
const ticker = (id: string, box: [number, number, number, number], p: Record<string, unknown>, extra: Extra = {}) =>
  layer("ticker", id, box, { source: "items", font: "@body", weight: 600, ...p }, { anim: A.items, ...extra });
const clock = (id: string, box: [number, number, number, number], p: Record<string, unknown>, extra: Extra = {}) =>
  layer("clock", id, box, p, { anim: A.fade, ...extra });

const list = (id: string, lbl: string, def: GfxListItem[], hint: string) => field.list(id, lbl, def, { maxItems: 60, hint, group: "Items" });
const SOUNDS = { in: "whoosh", out: "swish" };

// ── sample content (reads like real Indian news; English with Hindi and other scripts) ──

const CRAWL_ITEMS: GfxListItem[] = [
  { text: "Heavy rain shuts Andheri subway in Mumbai; traffic diverted via SV Road", flash: true },
  { text: "IMD issues orange alert for Mumbai, Thane and Palghar for the next 48 hours" },
  { text: "दिल्ली-एनसीआर में सुबह हल्की बारिश, तापमान चार डिग्री गिरा" },
  { text: "Sensex ends 412 points higher; Nifty closes above 24,900" },
  { text: "Bengaluru: Namma Metro Yellow Line daily ridership crosses 1 lakh" },
  { text: "Chennai: suburban trains every 10 minutes in peak hours from Monday" },
  { text: "Cricket: India set Australia a target of 312 in the third ODI at Wankhede" },
];

const HEADLINES: GfxListItem[] = [
  { text: "Railways to run 30 festive special trains on the Delhi–Patna route" },
  { text: "Monsoon withdraws from Rajasthan; dry weather across north India this week" },
  { text: "उत्तर प्रदेश: 25 जिलों में भारी बारिश का अलर्ट, स्कूल दो दिन बंद" },
  { text: "Pune Ring Road: land acquisition reaches 90 per cent, work to start in March" },
  { text: "హైదరాబాద్‌లో రేపు భారీ వర్షాలు, ఎల్లో అలర్ట్ జారీ" },
  { text: "Kochi Water Metro adds two routes to Fort Kochi and Mattancherry" },
];

const CATEGORY_ITEMS: GfxListItem[] = [
  { tag: "National", text: "Parliament's winter session to begin on 24 November" },
  { tag: "National", text: "Railways adds 30 festive special trains on the Delhi–Patna route" },
  { tag: "States", text: "Kerala: schools in three districts closed as heavy rain continues" },
  { tag: "States", text: "தமிழ்நாடு: சென்னையில் இன்று கனமழைக்கு வாய்ப்பு" },
  { tag: "Business", text: "Rupee opens 6 paise higher at 83.36 against the US dollar" },
  { tag: "Business", text: "GST collections rise 9 per cent to ₹1.87 lakh crore in October" },
  { tag: "Sports", text: "Pro Kabaddi: Patna Pirates beat Bengaluru Bulls 38–32 in Pune" },
  { tag: "Sports", text: "Hockey: India beat Malaysia 4–1 to reach the Asia Cup final" },
  { tag: "World", text: "Dubai airport resumes full operations after the sandstorm" },
];

const WEATHER: GfxListItem[] = [
  { text: "Delhi", icon: "fog", value: 34 }, { text: "Mumbai", icon: "rain", value: 29 }, { text: "Bengaluru", icon: "cloud", value: 24 },
  { text: "Chennai", icon: "cloud_sun", value: 33 }, { text: "Kolkata", icon: "storm", value: 31 }, { text: "Hyderabad", icon: "cloud_sun", value: 30 },
  { text: "Ahmedabad", icon: "sun", value: 36 }, { text: "लखनऊ", icon: "fog", value: 33 }, { text: "Guwahati", icon: "rain", value: 27 },
];

const MARKETS: GfxListItem[] = [
  { text: "SENSEX", value: 81523.16, delta: 412.3 },
  { text: "NIFTY 50", value: 24926.7, delta: 118.45 },
  { text: "BANK NIFTY", value: 51812.25, delta: -96.3 },
  { text: "NIFTY IT", value: 41208.9, delta: 233.1 },
  { text: "GOLD ₹/10g", value: 76450, delta: 320 },
  { text: "SILVER ₹/kg", value: 92300, delta: -450 },
  { text: "₹ / $", value: 83.42, delta: -0.06 },
  { text: "BRENT $/bbl", value: 78.15, delta: 0.92 },
];

const SPEED_NEWS: GfxListItem[] = [
  "Mumbai: Coastal Road's northern arm opens from Worli to Bandra",
  "IMD: monsoon to withdraw from Gujarat by next week",
  "उत्तर प्रदेश: 25 जिलों में भारी बारिश का अलर्ट, स्कूल बंद",
  "Bengaluru: Silk Board flyover to be ready by December",
  "Chennai Metro Phase 2: trial run on the Porur stretch completed",
  "Hyderabad: Musi riverfront walkway opens to the public",
  "Kerala: Sabarimala pilgrim registrations cross 5 lakh",
  "दिल्ली: प्रदूषण बढ़ने पर GRAP का पहला चरण लागू",
  "Kolkata: Howrah Bridge gets new LED lighting before the Pujas",
  "Pune Ring Road: 90 per cent of the land acquired",
  "Odisha: Puri Beach Festival dates announced for December",
  "Assam: Brahmaputra falls below the danger mark in Guwahati",
  "Gujarat: bullet train viaduct crosses 300 km",
  "Punjab: paddy procurement begins at 1,800 mandis",
  "बिहार: पटना मेट्रो के पहले रूट पर ट्रायल रन सफल",
  "Jaipur: heritage walk timings extended for the tourist season",
  "Kochi Water Metro adds two routes to Fort Kochi",
  "Indore: city bus fleet to go fully electric by 2027",
  "Shimla: first snowfall of the season likely this week",
  "Hockey: India women reach the Asia Cup semi-final",
].map((t) => ({ text: t }));

const RATES: GfxListItem[] = [
  { tag: "Delhi", text: "Petrol", value: 94.72 }, { tag: "Delhi", text: "Diesel", value: 87.62 },
  { tag: "Delhi", text: "Gold 22K", value: 73450, delta: 250 }, { tag: "Delhi", text: "LPG", value: 803 },
  { tag: "Mumbai", text: "Petrol", value: 103.44 }, { tag: "Mumbai", text: "Diesel", value: 89.97 },
  { tag: "Mumbai", text: "Gold 22K", value: 73300, delta: 200 }, { tag: "Mumbai", text: "LPG", value: 802.5 },
  { tag: "Kolkata", text: "Petrol", value: 104.95 }, { tag: "Kolkata", text: "Diesel", value: 91.76, delta: -0.12 },
  { tag: "Kolkata", text: "Gold 22K", value: 73450, delta: 250 }, { tag: "Kolkata", text: "LPG", value: 829 },
  { tag: "Chennai", text: "Petrol", value: 100.75, delta: 0.09 }, { tag: "Chennai", text: "Diesel", value: 92.34 },
  { tag: "Chennai", text: "Gold 22K", value: 73600, delta: 300 }, { tag: "Chennai", text: "LPG", value: 818.5 },
];

const ALERTS: GfxListItem[] = [
  { text: "Heavy to very heavy rain likely in Mumbai, Thane and Raigad till Friday" },
  { text: "Fishermen advised not to venture into the sea along the Konkan coast" },
  { text: "मुंबई में अगले 48 घंटे भारी बारिश की चेतावनी, निचले इलाकों में सतर्क रहें" },
  { text: "Helplines: BMC 1916 · Emergency 112" },
];

const SOCIAL: GfxListItem[] = [
  { tag: "@RaginiReports", text: "Water-logging at Hindmata; buses diverted via Dadar TT" },
  { tag: "@ChennaiRains", text: "Steady showers over Velachery and Tambaram; carry an umbrella" },
  { tag: "@CricketWithAmit", text: "What a chase! 312 at Wankhede will need something special" },
  { tag: "@DelhiCommuter", text: "मेट्रो की ब्लू लाइन पर सेवा सामान्य, भीड़ ज़्यादा" },
  { tag: "@PuneTraffic", text: "Expect slow traffic on the Mumbai–Pune Expressway near Lonavala" },
];

const PARTIES: GfxListItem[] = [
  { text: "NDA", value: 240, delta: 52, color: "#F47C20" },
  { text: "INDIA", value: 180, delta: 38, color: "#1F6FD1" },
  { text: "Others", value: 20, delta: 13, color: "#8A94A6" },
];

const VERTICAL_ITEMS: GfxListItem[] = [
  { text: "Delhi Metro's Golden Line extension opens for passengers on Monday" },
  { text: "Navi Mumbai airport: first commercial flight lands to a water salute" },
  { text: "राजस्थान: 12 जिलों में शीतलहर की चेतावनी जारी" },
  { text: "ಬೆಂಗಳೂರಿನಲ್ಲಿ ಇಂದು ಸಂಜೆ ಗುಡುಗು ಸಹಿತ ಮಳೆ ಸಾಧ್ಯತೆ" },
  { text: "Sensex ends 412 points higher; Nifty above 24,900" },
  { text: "Hockey: India beat Malaysia 4–1 to reach the Asia Cup final" },
];

// ── the systems ──────────────────────────────────────────────────────────────

const crawl = tpl({
  id: "nr.tickers.crawl", name: "Crawl", category: "Tickers", role: "ticker", kind: "crawl",
  description: "The classic news crawl: a label, lines moving right to left, and the clock.",
  tags: ["crawl", "scroll", "bottom"], seconds: 0, hold: "fill", loop: true, timing: { in: 0.8, out: 0.4 }, sounds: SOUNDS,
  fields: [
    list("items", "Ticker lines", CRAWL_ITEMS, "One line per item; turn on priority to make an item flash"),
    field.text("label", "Label", "Top news", { maxLength: 14 }),
    field.toggle("showClock", "Show the clock", true),
  ],
  designs: {
    "16:9": d169([
      band("band", [0, 962, 1920, 64]),
      tab("tab", [-24, 962, 360, 64]),
      label("label", [96, 962, 224, 64], "{label}", 32),
      ticker("crawl", [352, 962, 1340, 64], { mode: "crawl", size: 40, fade: 24 }),
      rect("clock_plate", [1704, 962, 240, 64], { fill: "@primary", shape: "look", ends: "left", stripe: "left", stripeColor: "@accent", stripeWidth: 4 }, { anim: A.tabR, when: "{showClock}" }),
      clock("clock", [1712, 962, 112, 64], { show: "time", size: 36, color: "@textOnPrimary", blink: true }, { when: "{showClock}" }),
    ]),
    "9:16": d916([
      tab("tab", [-24, 1334, 330, 52]),
      label("label", [65, 1334, 230, 52], "{label}", 30),
      rect("clock_plate", [748, 1334, 180, 52], { fill: "@primary", shape: "look", ends: "left" }, { anim: A.tabR, when: "{showClock}" }),
      clock("clock", [760, 1334, 147, 52], { show: "time", size: 32, color: "@textOnPrimary", blink: true }, { when: "{showClock}" }),
      vband("band", 1386, 100),
      ticker("crawl", [65, 1386, 842, 100], { mode: "crawl", size: 46, fade: 30 }),
    ]),
  },
});

const flip = tpl({
  id: "nr.tickers.flip", name: "Flip headlines", category: "Tickers", role: "ticker", kind: "flip",
  description: "One headline at a time, flipping to the next every few seconds.",
  tags: ["flip", "headlines", "bottom"], seconds: 0, hold: "fill", loop: true, timing: { in: 0.8, out: 0.4 }, sounds: SOUNDS,
  fields: [
    list("items", "Headlines", HEADLINES, "One headline per line; each shows for the seconds set below"),
    field.text("label", "Label", "Headlines", { maxLength: 14 }),
  ],
  designs: {
    "16:9": d169([
      band("band", [0, 942, 1920, 84]),
      tab("tab", [-24, 942, 384, 84]),
      label("label", [96, 942, 250, 84], "{label}", 34),
      ticker("flip", [376, 942, 1448, 84], { mode: "flip", transition: "flip", hold: 5, transDur: 0.5, size: 46, font: "@headline", weight: 0 }),
    ]),
    "9:16": d916([
      tab("tab", [-24, 1290, 330, 52]),
      label("label", [65, 1290, 230, 52], "{label}", 30),
      vband("band", 1342, 144),
      ticker("flip", [65, 1342, 820, 144], { mode: "flip", transition: "flip", hold: 6, transDur: 0.5, size: 50, lines: 2, font: "@headline", weight: 0 }),
    ]),
  },
});

const stacked = tpl({
  id: "nr.tickers.stacked", name: "Stacked two-row", category: "Tickers", role: "ticker", kind: "stacked",
  description: "The story's headline on top and the crawl below it.",
  tags: ["stacked", "headline", "crawl", "two row"], seconds: 0, hold: "fill", loop: true, timing: { in: 0.9, out: 0.4 }, sounds: SOUNDS,
  fields: [
    field.text("tag", "Tag", "Big story", { maxLength: 16, group: "Headline" }),
    field.longtext("headline", "Headline", "Monsoon session: Parliament passes the Digital Personal Data amendment by voice vote", { maxLength: 110, group: "Headline", fill: "story.headline" }),
    list("items", "Ticker lines", CRAWL_ITEMS.slice(1), "The crawl under the headline"),
  ],
  designs: {
    "16:9": d169([
      rect("plate", [-24, 868, 1848, 88], { fill: "@light", shape: "look", ends: "right" }, { anim: A.band }),
      tab("tag_plate", [-24, 868, 336, 88]),
      label("tag", [96, 868, 200, 88], "{tag}", 30),
      text("headline", [334, 868, 1470, 88], "{headline}", { font: "@headline", size: 50, weight: 700, color: "@dark", align: "left", valign: "middle", fit: "shrink" }, { anim: A.text }),
      band("band", [0, 962, 1920, 64]),
      ticker("crawl", [96, 962, 1728, 64], { mode: "crawl", size: 40, fade: 36 }),
    ]),
    "9:16": d916([
      tab("tag_plate", [-24, 1150, 300, 50]),
      label("tag", [65, 1150, 200, 50], "{tag}", 28),
      rect("plate", [-24, 1200, 952, 180], { fill: "@light", shape: "look", ends: "right", skew: 8 }, { anim: A.band }),
      text("headline", [65, 1206, 815, 168], "{headline}", { font: "@headline", size: 54, weight: 700, color: "@dark", align: "left", valign: "middle", fit: "shrink", maxLines: 3 }, { anim: A.text }),
      vband("band", 1386, 100),
      ticker("crawl", [65, 1386, 842, 100], { mode: "crawl", size: 44, fade: 30 }),
    ]),
  },
});

/** The breaking tag: white with red letters, flashing to accent with dark letters (two layers blinking together). */
const breakingTag = (box: [number, number, number, number], size: number) => {
  const tagIn = step("wipe", { dir: "right", dur: 0.32, delay: 0.16 });
  return [
    rect("tag_plate", box, { fill: "@light", glass: "off", shape: "look" }, { anim: inStep(tagIn) }),
    text("tag", box, "{tag}", { font: "@headline", size, weight: 800, color: "@breaking", upper: "on", tracking: 1, align: "center", valign: "middle", padX: 14, fit: "shrink", maxLines: 1 }, { anim: inStep(tagIn) }),
    rect("tag_flash", box, { fill: "@accent", glass: "off", shape: "look" }, { anim: withLoop(inStep(tagIn), blink(1, 0.5)), when: "{flash}" }),
    text("tag_flash_text", box, "{tag}", { font: "@headline", size, weight: 800, color: "@dark", upper: "on", tracking: 1, align: "center", valign: "middle", padX: 14, fit: "shrink", maxLines: 1 }, { anim: withLoop(inStep(tagIn), blink(1, 0.5)), when: "{flash}" }),
  ];
};

const breaking = tpl({
  id: "nr.tickers.breaking", name: "Breaking bar", category: "Tickers", role: "ticker", kind: "breaking",
  description: "A red bar that grows in with a flashing BREAKING tag; it sits just above the crawl.",
  tags: ["breaking", "flash", "alert", "headline"], seconds: 0, hold: "until-next", loop: true, timing: { in: 0.9, out: 0.4 },
  sounds: { in: "impact", out: "swish" },
  fields: [
    field.text("tag", "Tag", "Breaking news", { maxLength: 16 }),
    field.longtext("headline", "Headline", "ISRO's Gaganyaan G1 uncrewed mission lifts off successfully from Sriharikota", { maxLength: 110, fill: "story.headline" }),
    field.toggle("flash", "Flash the tag", true),
  ],
  designs: {
    "16:9": d169([
      rect("plate", [-24, 866, 1848, 88], { fill: "@breaking", gloss: 0.16, glass: "off", shape: "look", ends: "right", stripe: "bottom", stripeColor: "@accent", stripeWidth: 4 }, { anim: A.grow }),
      ...breakingTag([96, 878, 330, 62], 34),
      text("headline", [450, 866, 1360, 88], "{headline}", { font: "@headline", size: 50, weight: 700, color: "#FFFFFF", align: "left", valign: "middle", fit: "shrink" }, { anim: A.text }),
    ]),
    "9:16": d916([
      ...breakingTag([65, 1112, 380, 58], 34),
      rect("plate", [-24, 1176, 952, 150], { fill: "@breaking", gloss: 0.16, glass: "off", shape: "look", ends: "right", stripe: "bottom", stripeColor: "@accent", stripeWidth: 4 }, { anim: A.grow }),
      text("headline", [65, 1180, 815, 142], "{headline}", { font: "@headline", size: 52, weight: 700, color: "#FFFFFF", align: "left", valign: "middle", fit: "shrink", maxLines: 3 }, { anim: A.text }),
    ]),
  },
});

const category = tpl({
  id: "nr.tickers.category", name: "Category ticker", category: "Tickers", role: "ticker", kind: "category",
  description: "A crawl whose box shows each line's category (National, States, Business …) as it passes.",
  tags: ["crawl", "category", "sections"], seconds: 0, hold: "fill", loop: true, timing: { in: 0.8, out: 0.4 }, sounds: SOUNDS,
  fields: [
    list("items", "Ticker lines", CATEGORY_ITEMS, "Give each line a tag (its category); the box changes as the lines pass"),
    field.text("label", "Label when a line has no tag", "News", { maxLength: 14 }),
  ],
  designs: {
    "16:9": d169([
      band("band", [0, 962, 1920, 64]),
      ticker("crawl", [-24, 962, 1848, 64], { mode: "crawl", size: 40, tags: "box", label: "{label}", tagFill: "@primary", tagColor: "@textOnPrimary", tagEdge: "@accent", bleedL: 120, transDur: 0.4, fade: 36 }),
    ]),
    "9:16": d916([
      vband("band", 1386, 100),
      ticker("crawl", [-24, 1386, 931, 100], { mode: "crawl", size: 44, tags: "box", label: "{label}", tagFill: "@primary", tagColor: "@textOnPrimary", tagEdge: "@accent", bleedL: 89, transDur: 0.4, fade: 24 }),
    ]),
  },
});

const weather = tpl({
  id: "nr.tickers.weather", name: "Weather strip", category: "Tickers", role: "ticker", kind: "weather",
  description: "Cities with a weather icon and the temperature, a few at a time.",
  tags: ["weather", "temperature", "cities", "flip"], seconds: 0, hold: "fill", loop: true, timing: { in: 0.8, out: 0.4 }, sounds: SOUNDS,
  fields: [
    list("items", "Cities", WEATHER, "City, an icon (sun, cloud_sun, cloud, rain, storm, fog, wind) and the temperature in °C"),
    field.text("label", "Label", "Weather", { maxLength: 14 }),
  ],
  designs: {
    "16:9": d169([
      band("band", [0, 954, 1920, 72]),
      tab("tab", [-24, 954, 344, 72]),
      icon("label_icon", [96, 968, 44, 44], "cloud_sun", { color: "@textOnPrimary", color2: "@accent" }, { anim: A.label }),
      label("label", [150, 954, 160, 72], "{label}", 30),
      ticker("cities", [340, 954, 1484, 72], { mode: "flip", perPage: 3, transition: "slide", hold: 5, size: 38, decimals: 0, suffix: "°C", iconColor: "@text", icon2Color: "@accent", tags: "none" }),
    ]),
    "9:16": d916([
      tab("tab", [-24, 1314, 330, 52]),
      icon("label_icon", [65, 1320, 40, 40], "cloud_sun", { color: "@textOnPrimary", color2: "@accent" }, { anim: A.label }),
      label("label", [114, 1314, 180, 52], "{label}", 30),
      vband("band", 1366, 120),
      ticker("cities", [65, 1366, 830, 120], { mode: "flip", perPage: 2, transition: "slide", hold: 5, size: 44, decimals: 0, suffix: "°C", iconColor: "@text", icon2Color: "@accent", tags: "none" }),
    ]),
  },
});

const markets = tpl({
  id: "nr.tickers.markets", name: "Markets strip", category: "Tickers", role: "ticker", kind: "markets",
  description: "Sensex, Nifty, gold, silver and the rupee with green ▲ and red ▼ changes.",
  tags: ["markets", "stocks", "sensex", "nifty", "business", "crawl"], seconds: 0, hold: "fill", loop: true, timing: { in: 0.8, out: 0.4 }, sounds: SOUNDS,
  fields: [
    list("items", "Markets", MARKETS, "Name, value and the change in points (the percentage is worked out)"),
    field.text("label", "Label", "Markets", { maxLength: 14 }),
  ],
  designs: {
    "16:9": d169([
      band("band", [0, 962, 1920, 64], { fill: { gradient: ["@dark", "@secondary"], angle: 90 } }),
      tab("tab", [-24, 962, 344, 64]),
      icon("label_icon", [96, 976, 36, 36], "trend_up", { color: "@textOnPrimary" }, { anim: A.label }),
      label("label", [142, 962, 170, 64], "{label}", 30),
      ticker("markets", [336, 962, 1488, 64], { mode: "crawl", size: 36, weight: 700, upper: "on", separator: "bar", deltaStyle: "abs+pct", decimals: 2, tags: "none", fade: 36 }),
    ]),
    "9:16": d916([
      tab("tab", [-24, 1334, 330, 52]),
      icon("label_icon", [65, 1342, 36, 36], "trend_up", { color: "@textOnPrimary" }, { anim: A.label }),
      label("label", [110, 1334, 186, 52], "{label}", 30),
      vband("band", 1386, 100, { fill: { gradient: ["@dark", "@secondary"], angle: 90 } }),
      ticker("markets", [65, 1386, 842, 100], { mode: "crawl", size: 42, weight: 700, upper: "on", separator: "bar", deltaStyle: "abs+pct", decimals: 2, tags: "none", fade: 30 }),
    ]),
  },
});

const SPORTS = [{ value: "cricket", label: "Cricket" }, { value: "football", label: "Football" }, { value: "kabaddi", label: "Kabaddi" }];
const scoreBug = (o: { x: number; y: number; k: number }) => {
  const { x, y, k } = o;
  const s = (v: number) => Math.round(v * k);
  const top = y, rowY = y + s(32), rowH = s(62), w = s(640);
  return [
    rect("event_plate", [x, top, w, s(32)], { fill: "@primary", shape: "flat" }, { anim: inStep(step("wipe", { dir: "right", dur: 0.4 })) }),
    text("event", [x + s(14), top, w - s(28), s(32)], "{event}", { font: "@headline", size: s(20), weight: 700, color: "@textOnPrimary", upper: "on", tracking: 1.5, align: "left", valign: "middle", fit: "shrink", maxLines: 1 }, { anim: A.fade }),
    rect("plate", [x, rowY, w, rowH], { fill: "@dark/92", shape: "flat" }, { anim: inStep(step("wipe", { dir: "right", dur: 0.45, delay: 0.06 })) }),
    rect("team1_plate", [x, rowY, s(108), rowH], { fill: "@secondary", shape: "flat", stripe: "bottom", stripeColor: "@accent", stripeWidth: s(4) }, { anim: A.pop }),
    text("team1", [x, rowY, s(108), rowH], "{team1}", { font: "@headline", size: s(32), weight: 800, color: "#FFFFFF", upper: "on", align: "center", valign: "middle", fit: "shrink", maxLines: 1 }, { anim: A.pop }),
    text("score1", [x + s(118), rowY, s(152), rowH], "{score1}", { font: "@numbers", size: s(42), weight: 700, color: "@text", align: "left", valign: "middle", fit: "shrink", maxLines: 1 }, { anim: A.text }),
    rect("team2_plate", [x + s(276), rowY, s(100), rowH], { fill: "@text/12", shape: "flat" }, { anim: A.pop }),
    text("team2", [x + s(276), rowY, s(100), rowH], "{team2}", { font: "@headline", size: s(30), weight: 700, color: "@text/90", upper: "on", align: "center", valign: "middle", fit: "shrink", maxLines: 1 }, { anim: A.pop }),
    text("score2", [x + s(386), rowY, s(110), rowH], "{score2}", { font: "@numbers", size: s(38), weight: 700, color: "@text/90", align: "left", valign: "middle", fit: "shrink", maxLines: 1 }, { anim: A.text, when: "{score2}" }),
    rect("clock_plate", [x + s(500), rowY, s(140), rowH], { fill: "@accent", shape: "flat" }, { anim: inStep(step("wipe", { dir: "left", dur: 0.4, delay: 0.2 })) }),
    clock("match", [x + s(506), rowY, s(128), rowH], { show: "match", size: s(30), color: "@dark", font: "@numbers", sportField: "sport", timeField: "clock", oversField: "overs" }),
    rect("detail_plate", [x, rowY + rowH, w, s(38)], { fill: "@secondary/95", shape: "flat" }, { anim: inStep(step("wipe", { dir: "down", dur: 0.35, delay: 0.3 })), when: "{detail}" }),
    text("detail", [x + s(14), rowY + rowH, w - s(28), s(38)], "{detail}", { font: "@body", size: s(22), weight: 600, color: "@text/90", align: "left", valign: "middle", fit: "shrink", maxLines: 1 }, { anim: A.fade, when: "{detail}" }),
  ];
};

const score = tpl({
  id: "nr.tickers.score", name: "Score bug", category: "Tickers", role: "ticker", kind: "score",
  description: "Live score in the corner: cricket (runs, wickets, overs, run rate, target), football or kabaddi with a running clock.",
  tags: ["score", "cricket", "football", "kabaddi", "sports"], seconds: 0, hold: "fill", loop: true, timing: { in: 0.8, out: 0.4 },
  sounds: { in: "swish", out: "swish" },
  fields: [
    field.choice("sport", "Sport", SPORTS, "cricket", { hint: "Cricket shows the overs; football counts the clock up, kabaddi counts it down" }),
    field.text("event", "Match", "IND vs AUS · 3rd ODI · Wankhede", { maxLength: 40 }),
    field.text("team1", "Team 1", "IND", { maxLength: 5, group: "Teams" }),
    field.text("score1", "Score 1", "245/4", { maxLength: 8, group: "Teams", hint: "Cricket: runs/wickets; football and kabaddi: goals or points" }),
    field.text("team2", "Team 2", "AUS", { maxLength: 5, group: "Teams" }),
    field.text("score2", "Score 2", "311/7", { maxLength: 8, group: "Teams", hint: "Cricket: the other side's total (empty while it hasn't batted)" }),
    field.text("overs", "Overs (cricket)", "38.2", { maxLength: 5, group: "Clock" }),
    field.text("clock", "Match time at the start (mm:ss)", "67:12", { maxLength: 6, group: "Clock" }),
    field.text("detail", "Detail line", "CRR 6.39 · RRR 5.74 · Need 67 off 70 balls", { maxLength: 70 }),
  ],
  designs: {
    "16:9": d169(scoreBug({ x: 96, y: 60, k: 1 })),
    "9:16": d916(scoreBug({ x: 65, y: 248, k: 1.25 })),
  },
});

const election = tpl({
  id: "nr.tickers.election", name: "Election strip", category: "Tickers", role: "ticker", kind: "election",
  description: "Party colours with won and leading seats, and a seat bar with the majority line.",
  tags: ["election", "results", "seats", "votes", "trends"], seconds: 0, hold: "fill", loop: true, timing: { in: 0.9, out: 0.4 }, sounds: SOUNDS,
  fields: [
    field.text("title", "Title", "Lok Sabha 2029 · Trends", { maxLength: 36 }),
    field.text("status", "Status", "543 of 543 seats · 2:45 PM", { maxLength: 36 }),
    field.list("parties", "Parties", PARTIES, { maxItems: 12, group: "Results", hint: "Party, won seats (value), leading seats (change) and its colour" }),
    field.number("total", "Total seats", 543, { decimals: 0 }, { group: "Results" }),
    field.number("majority", "Majority mark", 272, { decimals: 0 }, { group: "Results" }),
  ],
  designs: {
    "16:9": d169([
      rect("plate", [0, 902, 1920, 124], { fill: { gradient: ["@secondary", "@dark"], angle: 90 }, shape: "flat", stripe: "top", stripeColor: "@accent", stripeWidth: 4 }, { anim: A.band }),
      tab("title_plate", [-24, 902, 580, 44]),
      label("title", [96, 902, 440, 44], "{title}", 24),
      text("status", [1240, 902, 584, 44], "{status}", { font: "@body", size: 22, weight: 600, color: "@text/80", align: "right", valign: "middle", fit: "shrink", maxLines: 1 }, { anim: A.fade }),
      ticker("tally", [96, 952, 1060, 70], { source: "parties", mode: "tally", perPage: 3, size: 36, hold: 6, font: "@headline" }),
      ticker("seats", [1184, 952, 640, 70], { source: "parties", mode: "seats", size: 30, total: "{total}", majority: "{majority}" }, { anim: anim(step("fade", { dur: 0.3, delay: 0.3 }), OUT_FADE) }),
    ]),
    "9:16": d916([
      tab("title_plate", [-24, 1110, 620, 50]),
      label("title", [65, 1110, 520, 50], "{title}", 26),
      rect("plate", [-24, 1160, 952, 326], { fill: { gradient: ["@secondary", "@dark"], angle: 90 }, shape: "look", ends: "right", skew: 8, stripe: "top", stripeColor: "@accent", stripeWidth: 4 }, { anim: A.band }),
      text("status", [65, 1170, 842, 40], "{status}", { font: "@body", size: 24, weight: 600, color: "@text/80", align: "left", valign: "middle", fit: "shrink", maxLines: 1 }, { anim: A.fade }),
      ticker("tally", [65, 1216, 815, 116], { source: "parties", mode: "tally", perPage: 3, size: 34, hold: 6, font: "@headline" }),
      ticker("seats", [65, 1350, 790, 110], { source: "parties", mode: "seats", size: 30, total: "{total}", majority: "{majority}" }, { anim: anim(step("fade", { dur: 0.3, delay: 0.3 }), OUT_FADE) }),
    ]),
  },
});

const speedNews = tpl({
  id: "nr.tickers.speed_news", name: "Speed news", category: "Tickers", role: "ticker", kind: "speed",
  description: "Top 20 news: numbered headlines flipping fast.",
  tags: ["speed news", "top 20", "fast", "numbered", "flip"], seconds: 0, hold: "fill", loop: true, timing: { in: 0.8, out: 0.4 },
  sounds: { in: "whoosh", out: "swish" },
  fields: [
    field.text("title", "Title", "Speed news", { maxLength: 18 }),
    list("items", "Headlines", SPEED_NEWS, "Numbered in order; each shows for 3 seconds"),
  ],
  designs: {
    "16:9": d169([
      tab("title_plate", [-24, 872, 420, 56], "@breaking"),
      icon("title_icon", [96, 884, 32, 32], "bolt", { color: "@accent" }, { anim: A.label }),
      label("title", [136, 872, 240, 56], "{title}", 32, "#FFFFFF"),
      band("band", [0, 928, 1920, 98]),
      ticker("headlines", [96, 928, 1728, 98], { mode: "flip", numbered: true, transition: "slide", hold: 3, transDur: 0.35, size: 46, font: "@headline", weight: 0 }),
    ]),
    "9:16": d916([
      tab("title_plate", [-24, 1100, 420, 56], "@breaking"),
      icon("title_icon", [65, 1112, 32, 32], "bolt", { color: "@accent" }, { anim: A.label }),
      label("title", [105, 1100, 270, 56], "{title}", 32, "#FFFFFF"),
      vband("band", 1156, 330, { skew: 8 }),
      ticker("headlines", [65, 1160, 800, 322], { mode: "stack", rows: 3, numbered: true, hold: 3, transDur: 0.4, size: 42, lines: 2, font: "@headline", weight: 0 }),
    ]),
  },
});

const rates = tpl({
  id: "nr.tickers.rates", name: "Rates strip", category: "Tickers", role: "ticker", kind: "rates",
  description: "Petrol, diesel, gold and LPG prices, one city at a time.",
  tags: ["rates", "prices", "petrol", "diesel", "gold", "fuel", "flip"], seconds: 0, hold: "fill", loop: true, timing: { in: 0.8, out: 0.4 }, sounds: SOUNDS,
  fields: [
    field.text("title", "Title", "Today's rates", { maxLength: 22 }),
    list("items", "Rates", RATES, "Tag = city; then the item, its price in ₹ and the change (optional)"),
  ],
  designs: {
    "16:9": d169([
      tab("title_plate", [-24, 908, 420, 46]),
      label("title", [96, 908, 300, 46], "{title}", 26),
      band("band", [0, 954, 1920, 72]),
      ticker("rates", [-24, 954, 1848, 72], { mode: "flip", byTag: true, perPage: 4, tags: "box", tagFill: "@accent", tagColor: "@dark", tagEdge: "@primary", bleedL: 120, transition: "slide", hold: 5, size: 34, currency: true, decimals: -1, deltaStyle: "abs" }),
    ]),
    "9:16": d916([
      tab("title_plate", [-24, 1290, 420, 46]),
      label("title", [65, 1290, 330, 46], "{title}", 26),
      vband("band", 1336, 150),
      ticker("rates", [-24, 1336, 904, 150], { mode: "flip", byTag: true, perPage: 2, tags: "box", tagFill: "@accent", tagColor: "@dark", tagEdge: "@primary", bleedL: 89, transition: "slide", hold: 5, size: 38, currency: true, decimals: -1, deltaStyle: "abs" }),
    ]),
  },
});

const LEVELS = [
  { value: "#F2C200", label: "Yellow (be aware)" },
  { value: "#F57C00", label: "Orange (be prepared)" },
  { value: "#D7141A", label: "Red (take action)" },
  { value: "#1E88E5", label: "Blue (information)" },
];
const alert = tpl({
  id: "nr.tickers.alert", name: "Alert bar", category: "Tickers", role: "ticker", kind: "alert",
  description: "Weather and safety alerts in the severity's colour, with a crawl of advice.",
  tags: ["alert", "warning", "weather", "imd", "severity", "crawl"], seconds: 0, hold: "fill", loop: true, timing: { in: 0.8, out: 0.4 },
  sounds: { in: "impact", out: "swish" },
  fields: [
    field.choice("level", "Severity", LEVELS, "#F57C00"),
    field.text("label", "Label", "Orange alert · IMD", { maxLength: 24 }),
    list("items", "Advice lines", ALERTS, "What people should know or do"),
  ],
  designs: {
    "16:9": d169([
      ticker("alert", [-24, 952, 1968, 74], { mode: "crawl", size: 38, fill: "@dark", stripe: "{level}", stripeH: 5, label: "{label}", labelIcon: "warning", tagFill: "{level}", tagColor: "auto", bleedL: 120, bleedR: 120, fade: 36 }, { anim: A.band }),
    ]),
    "9:16": d916([
      ticker("alert", [-24, 1330, 952, 156], { mode: "crawl", size: 42, fill: "@dark", stripe: "{level}", stripeH: 5, label: "{label}", labelIcon: "warning", labelTop: 54, tagFill: "{level}", tagColor: "auto", tagSize: 28, bleedL: 89, bleedR: 21, fade: 30 }, { anim: A.band }),
    ]),
  },
});

const social = tpl({
  id: "nr.tickers.social", name: "Social ticker", category: "Tickers", role: "ticker", kind: "social",
  description: "The hashtag and viewers' posts with their handles.",
  tags: ["social", "hashtag", "posts", "viewers", "crawl"], seconds: 0, hold: "fill", loop: true, timing: { in: 0.8, out: 0.4 }, sounds: SOUNDS,
  fields: [
    field.text("hashtag", "Hashtag", "#MumbaiRains", { maxLength: 24 }),
    list("items", "Posts", SOCIAL, "Tag = the handle; then the post"),
  ],
  designs: {
    "16:9": d169([
      band("band", [0, 962, 1920, 64]),
      tab("tab", [-24, 962, 420, 64], "@accent", "@primary"),
      icon("tag_icon", [96, 976, 36, 36], "hashtag", { color: "@dark" }, { anim: A.label }),
      label("hashtag", [138, 962, 250, 64], "{hashtag}", 32, "@dark", { upper: "off", tracking: 0 }),
      ticker("posts", [412, 962, 1412, 64], { mode: "crawl", size: 36, tags: "inline", tagUpper: "off", tagFill: "@primary", tagColor: "@textOnPrimary", separator: "dot", fade: 36 }),
    ]),
    "9:16": d916([
      tab("tab", [-24, 1334, 420, 52], "@accent", "@primary"),
      icon("tag_icon", [65, 1342, 36, 36], "hashtag", { color: "@dark" }, { anim: A.label }),
      label("hashtag", [106, 1334, 280, 52], "{hashtag}", 30, "@dark", { upper: "off", tracking: 0 }),
      vband("band", 1386, 100),
      ticker("posts", [65, 1386, 842, 100], { mode: "crawl", size: 42, tags: "inline", tagUpper: "off", tagFill: "@primary", tagColor: "@textOnPrimary", separator: "dot", fade: 30 }),
    ]),
  },
});

const nowNext = tpl({
  id: "nr.tickers.now_next", name: "Now / next", category: "Tickers", role: "ticker", kind: "now_next",
  description: "What's on now and what's coming up next, with its time.",
  tags: ["now", "next", "schedule", "programme", "up next"], seconds: 10, hold: "fixed", loop: true, timing: { in: 0.9, out: 0.4 }, sounds: SOUNDS,
  fields: [
    field.text("nowLabel", "Now label", "Now", { maxLength: 8, group: "Now" }),
    field.text("now", "On now", "Prime Time with Ananya Rao", { maxLength: 48, group: "Now" }),
    field.text("nextLabel", "Next label", "Next", { maxLength: 8, group: "Next" }),
    field.text("nextTime", "Time", "21:00", { maxLength: 8, group: "Next" }),
    field.text("next", "Up next", "Desh Ki Baat: the farmers' question", { maxLength: 48, group: "Next" }),
  ],
  designs: {
    "16:9": d169([
      band("now_band", [0, 962, 1076, 64]),
      band("next_band", [1076, 962, 844, 64], { fill: { gradient: ["@dark", "@secondary"], angle: 90 } }),
      tab("now_plate", [-24, 962, 250, 64]),
      icon("now_dot", [96, 981, 26, 26], "live", { color: "#FFFFFF" }, { anim: withLoop(A.label, blink(1.2)) }),
      label("now_label", [130, 962, 90, 64], "{nowLabel}", 32),
      text("now", [244, 962, 820, 64], "{now}", { font: "@headline", size: 38, weight: 0, color: "@text", align: "left", valign: "middle", fit: "shrink", maxLines: 1 }, { anim: A.text }),
      rect("next_plate", [1080, 970, 170, 48], { fill: "@accent", shape: "look" }, { anim: A.pop }),
      label("next_label", [1080, 970, 170, 48], "{nextLabel}", 28, "@dark", { align: "center" }),
      text("next_time", [1262, 962, 116, 64], "{nextTime}", { font: "@numbers", size: 36, weight: 700, color: "@accent", align: "left", valign: "middle", fit: "shrink", maxLines: 1 }, { anim: A.text }),
      text("next", [1380, 962, 444, 64], "{next}", { font: "@body", size: 32, weight: 600, color: "@text/90", align: "left", valign: "middle", fit: "shrink", maxLines: 1 }, { anim: A.text }),
    ]),
    "9:16": d916([
      vband("now_band", 1294, 92),
      tab("now_plate", [-24, 1294, 230, 92]),
      icon("now_dot", [65, 1327, 26, 26], "live", { color: "#FFFFFF" }, { anim: withLoop(A.label, blink(1.2)) }),
      label("now_label", [98, 1294, 100, 92], "{nowLabel}", 32),
      text("now", [222, 1294, 685, 92], "{now}", { font: "@headline", size: 40, weight: 0, color: "@text", align: "left", valign: "middle", fit: "shrink", maxLines: 2 }, { anim: A.text }),
      vband("next_band", 1394, 92, { fill: { gradient: ["@dark", "@secondary"], angle: 90 }, stripe: "none" }),
      rect("next_plate", [65, 1408, 134, 64], { fill: "@accent", shape: "look" }, { anim: A.pop }),
      label("next_label", [65, 1408, 134, 64], "{nextLabel}", 28, "@dark", { align: "center" }),
      text("next_time", [212, 1394, 120, 92], "{nextTime}", { font: "@numbers", size: 38, weight: 700, color: "@accent", align: "left", valign: "middle", fit: "shrink", maxLines: 1 }, { anim: A.text }),
      text("next", [334, 1394, 573, 92], "{next}", { font: "@body", size: 34, weight: 600, color: "@text/90", align: "left", valign: "middle", fit: "shrink", maxLines: 2 }, { anim: A.text }),
    ]),
  },
});

const headline = tpl({
  id: "nr.tickers.headline", name: "Headline band", category: "Tickers", role: "ticker", kind: "headline",
  description: "One big headline across the bottom, with an optional tag.",
  tags: ["headline", "band", "big story", "lower third"], seconds: 0, hold: "until-next", loop: true, timing: { in: 0.8, out: 0.4 }, sounds: SOUNDS,
  fields: [
    field.text("tag", "Tag", "Big story", { maxLength: 18 }),
    field.longtext("headline", "Headline", "Delhi–Mumbai Expressway: last stretch opens, travel time cut to 12 hours", { maxLength: 110, fill: "story.headline" }),
  ],
  designs: {
    "16:9": d169([
      rect("tag_plate", [96, 862, 280, 44], { fill: "@accent", shape: "look" }, { anim: A.pop, when: "{tag}" }),
      label("tag", [96, 862, 280, 44], "{tag}", 26, "@dark", { align: "center" }),
      rect("plate", [-24, 906, 1848, 112], { fill: { gradient: ["@primary", "@secondary"], angle: 0 }, gloss: 0.12, shape: "look", ends: "right", stripe: "bottom", stripeColor: "@accent", stripeWidth: 5 }, { anim: A.grow }),
      text("headline", [96, 906, 1700, 112], "{headline}", { font: "@headline", size: 60, weight: 800, color: "@textOnPrimary", align: "left", valign: "middle", fit: "shrink" }, { anim: A.text }),
    ]),
    "9:16": d916([
      rect("tag_plate", [65, 1166, 260, 46], { fill: "@accent", shape: "look" }, { anim: A.pop, when: "{tag}" }),
      label("tag", [65, 1166, 260, 46], "{tag}", 26, "@dark", { align: "center" }),
      rect("plate", [-24, 1216, 952, 262], { fill: { gradient: ["@primary", "@secondary"], angle: 0 }, gloss: 0.12, shape: "look", ends: "right", skew: 8, stripe: "bottom", stripeColor: "@accent", stripeWidth: 5 }, { anim: A.grow }),
      text("headline", [65, 1226, 800, 240], "{headline}", { font: "@headline", size: 64, weight: 800, color: "@textOnPrimary", align: "left", valign: "middle", fit: "shrink", maxLines: 3 }, { anim: A.text }),
    ]),
  },
});

const vertical = tpl({
  id: "nr.tickers.vertical", name: "Vertical two-line ticker", category: "Tickers", role: "ticker", kind: "vertical",
  description: "Two lines at a time, rolling up one by one: made for vertical video.",
  tags: ["vertical", "two line", "stack", "roll", "reels", "shorts"], seconds: 0, hold: "fill", loop: true, timing: { in: 0.8, out: 0.4 }, sounds: SOUNDS,
  fields: [
    list("items", "Ticker lines", VERTICAL_ITEMS, "Two show at a time; each step rolls up by one"),
    field.text("label", "Label", "Latest", { maxLength: 14 }),
  ],
  designs: {
    "16:9": d169([
      band("band", [0, 914, 1920, 112]),
      tab("tab", [-24, 914, 300, 112]),
      label("label", [96, 914, 170, 112], "{label}", 34),
      ticker("lines", [300, 914, 1524, 112], { mode: "stack", rows: 2, hold: 4, transDur: 0.45, size: 38 }),
    ]),
    "9:16": d916([
      tab("tab", [-24, 1204, 300, 52]),
      label("label", [65, 1204, 200, 52], "{label}", 30),
      vband("band", 1256, 230, { skew: 8 }),
      ticker("lines", [65, 1260, 820, 222], { mode: "stack", rows: 2, hold: 4, transDur: 0.45, size: 42, lines: 2 }),
    ]),
  },
});

export const TICKERS: GfxTemplate[] = [
  crawl, flip, stacked, breaking, category, weather, markets, score, election, speedNews, rates, alert, social, nowNext, headline, vertical,
];
