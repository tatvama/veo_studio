/**
 * Built-in "Straps" templates (docs/EDITOR.md §16.4). Owner: nr-boards. Ids "nr.straps.<name>", stable.
 *
 * Name straps (anchor, reporter, guest / expert, on phone, video call) are a two-tier plate: the name on the look's
 * primary plate, the role on a light plate under it; both plates grow with their text (`p.grow`) and fields use the
 * people ids (name, role, location, photo) so the rundown and the people library fill them. Headline, location and
 * hashtag straps follow the same plate system. Labels (file footage, source, translated, sponsored, AI-generated, story
 * slug) are compact tags in the free corners: top-left (slug, then labels below it) and bottom-right. Motion: the plate
 * leads (grow from the left), text follows 60–120 ms later behind a clip, and everything leaves in about 0.4 s.
 */
import type { GfxField, GfxLayer, GfxTemplate } from "../types.ts";
import { anim, field, icon, image, rect, step, text, tpl } from "./kit.ts";

const SHADOW = { color: "rgba(0,0,0,0.38)", blur: 20, x: 0, y: 6 };
const SOFT = { color: "rgba(0,0,0,0.3)", blur: 12, x: 0, y: 4 };

/** Plate in: grows from the left; out: shrinks back after its text has gone. */
const plateAnim = (delay: number, dir: "right" | "left" | "up" | "down" = "right", outDelay = 0.1) =>
  anim(step("grow", { dir, dur: 0.42, delay }), step("grow", { dur: 0.28, delay: outDelay }));
/** Text on a plate: rises (or slides) in after the plate, fades quickly out. */
const textAnim = (delay: number, kind: "rise" | "slide" = "rise") =>
  anim(kind === "rise" ? step("rise", { dur: 0.4, delay, distance: 36 }) : step("slide", { dir: "right", dur: 0.42, delay, distance: 56 }), step("fade", { dur: 0.2 }));
const popAnim = (delay: number) => anim(step("pop", { dur: 0.4, delay }), step("fade", { dur: 0.2, delay: 0.05 }));

// ── the people fields ────────────────────────────────────────────────────────

const F = {
  name: (def: string) => field.text("name", "Name", def, { fill: "person.name", required: true, maxLength: 40, group: "Person" }),
  role: (def: string) => field.text("role", "Role", def, { fill: "person.role", maxLength: 60, group: "Person" }),
  location: (def: string) => field.text("location", "Location", def, { fill: "place", maxLength: 30, group: "Person" }),
  photo: () => field.image("photo", "Photo", { fill: "person.photo", group: "Person" }),
};

// ── geometry per ratio ───────────────────────────────────────────────────────

interface Geo {
  L: number;           // plates' left edge
  ny: number; nh: number; ns: number;   // name plate top, height, text size
  ry: number; rh: number; rs: number;   // role plate
  ty: number; th: number; ts: number;   // tag above the name plate
  nmax: number; rmax: number;           // widest plates (inside the safe area)
  right: number;       // safe right edge
  top: number;         // top-left corner row
  br: number;          // bottom-right label row (top)
}
const G16: Geo = { L: 128, ny: 834, nh: 80, ns: 52, ry: 914, rh: 50, rs: 32, ty: 790, th: 44, ts: 27, nmax: 1100, rmax: 1000, right: 1824, top: 64, br: 916 };
const G9: Geo = { L: 72, ny: 1290, nh: 92, ns: 60, ry: 1382, rh: 58, rs: 36, ty: 1240, th: 50, ts: 31, nmax: 835, rmax: 835, right: 907, top: 240, br: 1176 };
type Ratio = "16:9" | "9:16";

/**
 * The two-tier name plate: name on the primary plate, role on the light plate. `x` moves it right (photo straps);
 * `d` delays it. Layers: plate, name, sub, role.
 */
function nameBlock(g: Geo, o: { x?: number; d?: number; plateFill?: unknown; subFill?: string; subText?: string; nameField?: string; roleField?: string; stripe?: boolean } = {}): GfxLayer[] {
  const x = o.x ?? g.L, d = o.d ?? 0;
  const pad = Math.round(g.nh * 0.36);
  const nmax = Math.min(g.nmax, g.right - x), rmax = Math.min(g.rmax, g.right - x);
  return [
    rect("plate", [x, g.ny, Math.min(640, nmax), g.nh], {
      fill: o.plateFill ?? "@primary", gloss: 0.12, ends: "right", ...(o.stripe === false ? {} : { stripe: "left", stripeWidth: Math.round(g.nh * 0.13) }),
    }, { anim: plateAnim(d + 0.04), shadow: SHADOW }),
    text("name", [x + pad, g.ny, nmax - pad * 2, g.nh], `{${o.nameField ?? "name"}}`, {
      font: "@headline", size: g.ns, weight: 700, color: "@textOnPrimary", upper: "look", maxLines: 1, fit: "shrink", minScale: 0.62,
      grow: { layers: ["plate"], pad, min: Math.round(nmax * 0.36), max: nmax },
    }, { clip: "plate", anim: textAnim(d + 0.16) }),
    rect("sub", [x, g.ry, Math.min(520, rmax), g.rh], { fill: o.subFill ?? "@light", shape: "flat" }, { anim: plateAnim(d + 0.14), shadow: SOFT, when: `{${o.roleField ?? "role"}}` }),
    text("role", [x + pad, g.ry, rmax - pad * 2, g.rh], `{${o.roleField ?? "role"}}`, {
      font: "@body", size: g.rs, weight: 600, color: o.subText ?? "@dark", maxLines: 1, fit: "shrink", minScale: 0.62,
      grow: { layers: ["sub"], pad, min: Math.round(rmax * 0.3), max: rmax },
    }, { clip: "sub", anim: textAnim(d + 0.26, "slide"), when: `{${o.roleField ?? "role"}}` }),
  ];
}

/** A small tag above the name plate (icon optional), growing with its text. Layers: tagbg, tagicon?, tag. */
function tagBlock(g: Geo, value: string, o: { x?: number; fill?: string; color?: string; icon?: string; when?: string; d?: number } = {}): GfxLayer[] {
  const x = o.x ?? g.L, d = o.d ?? 0;
  const ic = o.icon ? Math.round(g.th * 0.62) : 0;
  const pad = Math.round(g.th * 0.36);
  const tx = x + pad + (ic ? ic + Math.round(g.th * 0.2) : 0);
  const max = Math.min(560, g.right - x);
  const w = (o.when ? { when: o.when } : {});
  return [
    rect("tagbg", [x, g.ty, 220, g.th], { fill: o.fill ?? "@accent", shape: "flat" }, { anim: plateAnim(d, "right", 0.12), ...w }),
    ...(o.icon ? [icon("tagicon", [x + pad, g.ty + (g.th - ic) / 2, ic, ic], o.icon, { color: o.color ?? "@dark" }, { anim: popAnim(d + 0.14), ...w })] : []),
    text("tag", [tx, g.ty, max - (tx - x) - pad, g.th], value, {
      font: "@headline", size: g.ts, weight: 700, color: o.color ?? "@dark", upper: "on", tracking: 1.5, maxLines: 1, fit: "shrink",
      grow: { layers: ["tagbg"], pad, min: 120, max },
    }, { clip: "tagbg", anim: textAnim(d + 0.1), ...w }),
  ];
}

/** A corner label: plate (stripe on its outer edge), optional icon, one line of text; grows with the text. */
function label(id: string, g: Geo, r: Ratio, at: "tl" | "tl2" | "br", value: string, o: { icon?: string; fill?: string; color?: string; size?: number; h?: number; y?: number; stripe?: string; when?: string } = {}): GfxLayer[] {
  const h = o.h ?? (r === "16:9" ? 50 : 56), size = o.size ?? Math.round(h * 0.54);
  const ic = o.icon ? Math.round(h * 0.56) : 0;
  const pad = Math.round(h * 0.36);
  const max = r === "16:9" ? 720 : 700;
  const right = at === "br";
  const top = o.y ?? (at === "br" ? g.br : at === "tl2" ? g.top + (r === "16:9" ? 66 : 72) : g.top);
  const x0 = right ? g.right - max : r === "16:9" ? 96 : 66;
  const plateBox: [number, number, number, number] = right ? [g.right - 300, top, 300, h] : [x0, top, 300, h];
  const iconX = right ? g.right - pad - ic : x0 + pad + 8;
  const tx = right ? x0 : x0 + pad + 8 + (ic ? ic + Math.round(h * 0.22) : 0);
  const tw = right ? max - pad - 8 - (ic ? ic + Math.round(h * 0.22) : 0) : max - (tx - x0) - pad;
  const w = o.when ? { when: o.when } : {};
  return [
    rect(`${id}bg`, plateBox, { fill: o.fill ?? "@dark/88", shape: "flat", stripe: right ? "right" : "left", stripeWidth: 8, stripeColor: o.stripe ?? "@accent" },
      { anim: anim(step("grow", { dir: right ? "left" : "right", dur: 0.4 }), step("grow", { dur: 0.26, delay: 0.1 })), shadow: SOFT, ...w }),
    ...(o.icon ? [icon(`${id}icon`, [iconX, top + (h - ic) / 2, ic, ic], o.icon, { color: o.stripe ?? "@accent" }, { anim: popAnim(0.12), ...w })] : []),
    text(id, [tx, top, tw, h], value, {
      font: "@headline", size, weight: 700, color: o.color ?? "@text", upper: "look", tracking: 1, maxLines: 1, fit: "shrink", align: right ? "right" : "left",
      grow: { layers: [`${id}bg`], pad, min: 160, max },
    }, { clip: `${id}bg`, anim: textAnim(0.12), ...w }),
  ];
}

const both = (f: (g: Geo, r: Ratio) => GfxLayer[]) => ({ "16:9": f(G16, "16:9"), "9:16": f(G9, "9:16") });
const strap = (o: { id: string; name: string; kind: string; description: string; tags: string[]; fields: GfxField[]; seconds?: number; timing?: { in: number; out: number }; designs: ReturnType<typeof both> }): GfxTemplate =>
  tpl({ category: "Straps", role: "strap", seconds: o.seconds ?? 6, timing: o.timing ?? { in: 0.75, out: 0.45 }, hold: "auto", sounds: { in: "swish", out: "swish" }, ...o, id: `nr.straps.${o.id}` });

// ── people ───────────────────────────────────────────────────────────────────

const anchor = strap({
  id: "anchor", name: "Anchor", kind: "anchor", tags: ["name", "anchor", "presenter", "lower third"],
  description: "The anchor's name on the channel plate with their role underneath.",
  fields: [F.name("Priya Raghavan"), F.role("Anchor, Prime Time")],
  designs: both((g) => nameBlock(g)),
});

const reporter = strap({
  id: "reporter", name: "Reporter with location", kind: "reporter", tags: ["name", "reporter", "correspondent", "location", "lower third"],
  description: "Reporter's name and role, with the place they're reporting from in a tag above.",
  fields: [F.name("Arjun Mehta"), F.role("Senior correspondent"), F.location("Bengaluru")],
  designs: both((g) => [...tagBlock(g, "{location}", { icon: "pin", when: "{location}" }), ...nameBlock(g, { d: 0.06 })]),
});

const guest = strap({
  id: "guest", name: "Guest / expert", kind: "guest", tags: ["name", "guest", "expert", "panel", "analyst", "lower third"],
  description: "A guest or expert: a tag (Guest, Expert, Analyst …), their name and their designation.",
  fields: [
    field.choice("tag", "Tag", ["Expert", "Guest", "Analyst", "Spokesperson", "Eyewitness", "Panelist"].map((v) => ({ value: v, label: v })), "Expert", { group: "Person" }),
    F.name("Dr. Venkataraghavan Subramaniam"), F.role("Former Deputy Governor, Reserve Bank of India"),
  ],
  designs: both((g) => [
    ...tagBlock(g, "{tag}", { fill: "@accent" }),
    ...nameBlock(g, { d: 0.06, plateFill: { gradient: ["@secondary", "@dark"], angle: 0 }, subFill: "@primary", subText: "@textOnPrimary" }),
  ]),
});

/** Photo straps: a picture (circle for phone, a video window for calls) with the name block beside it. */
function photoStrap(g: Geo, r: Ratio, mode: "phone" | "video"): GfxLayer[] {
  const ps = r === "16:9" ? 162 : 176;                       // picture height
  const pw = mode === "video" ? Math.round(ps * 1.3) : ps;
  const top = g.ry + g.rh - ps;                               // bottoms line up
  const x = g.L + pw + (r === "16:9" ? 18 : 16);
  const badge = Math.round(ps * 0.34);
  const pic = mode === "phone"
    ? image("photo", [g.L, top, ps, ps], "photo", { shape: "circle", border: "@accent", borderWidth: 6, focusY: 0.3 }, { anim: popAnim(0), shadow: SHADOW })
    : image("photo", [g.L, top, pw, ps], "photo", { shape: "rounded", radius: 10, border: "@light", borderWidth: 4, focusY: 0.3 }, { anim: anim(step("zoom", { dur: 0.45 }), step("fade", { dur: 0.25 })), shadow: SHADOW });
  const badgeBox: [number, number, number, number] = mode === "phone"
    ? [g.L + ps - badge * 0.9, top + ps - badge * 0.95, badge, badge]
    : [g.L + 10, top + 10, Math.round(badge * 0.8), Math.round(badge * 0.8)];
  return [
    pic,
    icon("badge", badgeBox, mode === "phone" ? "phone" : "video_call", { color: "@dark", bg: "@accent", bgShape: mode === "phone" ? "circle" : "rounded", pad: 0.22 },
      { anim: anim(step("pop", { dur: 0.4, delay: 0.32 }), step("fade", { dur: 0.2 }), mode === "phone" ? { kind: "pulse", period: 1.6, amount: 0.08, delay: 0.4 } : undefined) }),
    ...(mode === "video" ? [icon("rec", [g.L + pw - 30, top + 12, 18, 18], "live", { color: "@live" }, { anim: anim(step("fade", { delay: 0.4 }), step("fade", { dur: 0.2 }), { kind: "blink", period: 1.2 }) })] : []),
    ...tagBlock(g, mode === "phone" ? "On phone" : "Via video call", { x, d: 0.08, fill: "@live", color: "#FFFFFF", icon: mode === "phone" ? "phone" : "video_call" }),
    ...nameBlock(g, { x, d: 0.1 }),
  ];
}

const phone = strap({
  id: "phone", name: "On phone", kind: "phone", tags: ["name", "phone", "phono", "caller", "lower third"],
  description: "A caller on the phone: their photo in a circle with a phone badge, name and role.",
  fields: [F.photo(), F.name("Sandeep Kulkarni"), F.role("District Collector, Wayanad")],
  designs: { "16:9": photoStrap(G16, "16:9", "phone"), "9:16": photoStrap(G9, "9:16", "phone") },
});

const videoCall = strap({
  id: "video_call", name: "Via video call", kind: "video_call", tags: ["name", "video call", "remote", "guest", "lower third"],
  description: "A guest joining by video call: their picture in a call window, a 'via video call' tag, name and role.",
  fields: [F.photo(), F.name("Meera Iyer"), F.role("Climate scientist, IISc Bengaluru")],
  designs: { "16:9": photoStrap(G16, "16:9", "video"), "9:16": photoStrap(G9, "9:16", "video") },
});

// ── headline, place, hashtag ─────────────────────────────────────────────────

function headlineStrap(g: Geo, r: Ratio): GfxLayer[] {
  const W = g.right - g.L - (r === "16:9" ? 32 : 0);
  const hh = r === "16:9" ? 96 : 176, sh = r === "16:9" ? 56 : 104;
  const hy = r === "16:9" ? 810 : 1148, sy = hy + hh;
  const ty = hy - (r === "16:9" ? 48 : 54), th = r === "16:9" ? 48 : 54;
  const pad = r === "16:9" ? 30 : 30;
  return [
    rect("tagbg", [g.L, ty, 260, th], { fill: "@breaking", shape: "angled", ends: "right" }, { anim: anim(step("wipe", { dir: "right", dur: 0.3 }), step("fade", { dur: 0.2, delay: 0.1 })), when: "{tag}" }),
    icon("dot", [g.L + 16, ty + (th - 20) / 2, 20, 20], "live", { color: "#FFFFFF" }, { anim: anim(step("pop", { delay: 0.18 }), step("fade", { dur: 0.2 }), { kind: "blink", period: 1, delay: 0.3 }), when: "{tag}" }),
    text("tag", [g.L + 46, ty, 520, th], "{tag}", { font: "@headline", size: r === "16:9" ? 30 : 34, weight: 700, color: "#FFFFFF", upper: "on", tracking: 2, maxLines: 1, grow: { layers: ["tagbg"], pad: 28, min: 200, max: 600 } },
      { clip: "tagbg", anim: textAnim(0.12), when: "{tag}" }),
    rect("plate", [g.L, hy, W, hh], { fill: "@primary", gloss: 0.1, shape: "flat", stripe: "top", stripeWidth: 5, stripeColor: "@accent" }, { anim: plateAnim(0.06), shadow: SHADOW }),
    text("headline", [g.L + pad, hy + 4, W - pad * 2, hh - 8], "{headline}", {
      font: "@headline", size: r === "16:9" ? 58 : 64, weight: 700, color: "@textOnPrimary", maxLines: r === "16:9" ? 1 : 2, fit: "shrink", minScale: 0.6, lineHeight: 1.12,
    }, { clip: "plate", anim: anim(step("stagger", { by: "word", delay: 0.24, dur: 0.5, stagger: 0.05 }), step("fade", { dur: 0.2 })) }),
    rect("sub", [g.L, sy, W, sh], { fill: "@light", shape: "flat" }, { anim: plateAnim(0.16), shadow: SOFT, when: "{subline}" }),
    text("subline", [g.L + pad, sy, W - pad * 2, sh], "{subline}", {
      font: "@body", size: r === "16:9" ? 34 : 38, weight: 600, color: "@dark", maxLines: r === "16:9" ? 1 : 2, fit: "shrink", lineHeight: 1.15,
    }, { clip: "sub", anim: textAnim(0.32, "slide"), when: "{subline}" }),
  ];
}

const headline = strap({
  id: "headline", name: "Two-line headline", kind: "headline", tags: ["headline", "breaking", "story", "lower third", "hindi"],
  description: "A big headline on the channel plate with a second line under it and an optional tag (BREAKING, BIG STORY …).",
  seconds: 7, timing: { in: 0.9, out: 0.45 },
  fields: [
    field.text("tag", "Tag", "Breaking", { maxLength: 20 }),
    field.longtext("headline", "Headline", "मुंबई में भारी बारिश: लोकल ट्रेनें ठप, स्कूल-कॉलेज आज बंद", { fill: "story.headline", required: true, maxLength: 80 }),
    field.longtext("subline", "Second line", "IMD issues red alert for Mumbai, Thane and Palghar till Friday", { fill: "story.strap", maxLength: 110 }),
  ],
  designs: { "16:9": headlineStrap(G16, "16:9"), "9:16": headlineStrap(G9, "9:16") },
});

function locationStrap(g: Geo, r: Ratio): GfxLayer[] {
  const h = r === "16:9" ? 76 : 86, y = g.ry + g.rh - h - (r === "16:9" ? 44 : 50);
  const box = h;
  const pad = 26, max = Math.min(900, g.right - g.L - box);
  const dh = r === "16:9" ? 44 : 50;
  return [
    rect("pinbox", [g.L, y, box, h], { fill: "@accent", shape: "flat" }, { anim: anim(step("grow", { dir: "up", dur: 0.3 }), step("grow", { dur: 0.24, delay: 0.14 })), shadow: SHADOW }),
    icon("pin", [g.L + box * 0.2, y + h * 0.18, box * 0.6, h * 0.64], "pin", { color: "@dark" }, { anim: anim(step("drop", { dur: 0.45, delay: 0.16, ease: "bounce", distance: 30 }), step("fade", { dur: 0.2 })) }),
    rect("plate", [g.L + box, y, 420, h], { fill: "@dark/90", shape: "flat" }, { anim: plateAnim(0.08), shadow: SHADOW }),
    text("place", [g.L + box + pad, y, max - pad * 2, h], "{place}", {
      font: "@headline", size: r === "16:9" ? 46 : 52, weight: 700, color: "@text", upper: "look", tracking: 1, maxLines: 1, fit: "shrink",
      grow: { layers: ["plate"], pad, min: 280, max },
    }, { clip: "plate", anim: textAnim(0.2) }),
    rect("detailbg", [g.L + box, y + h, 360, dh], { fill: "@primary", shape: "flat" }, { anim: plateAnim(0.18), when: "{detail}" }),
    text("detail", [g.L + box + pad, y + h, max - pad * 2, dh], "{detail}", {
      font: "@body", size: r === "16:9" ? 28 : 32, weight: 600, color: "@textOnPrimary", maxLines: 1, fit: "shrink",
      grow: { layers: ["detailbg"], pad, min: 200, max },
    }, { clip: "detailbg", anim: textAnim(0.3, "slide"), when: "{detail}" }),
  ];
}

const location = strap({
  id: "location", name: "Location", kind: "location", tags: ["place", "location", "dateline", "lower third"],
  description: "Where the pictures are from: a pin, the place name and an optional detail line (a landmark or the date).",
  fields: [field.text("place", "Place", "Ayodhya, Uttar Pradesh", { fill: "place", required: true, maxLength: 40 }), field.text("detail", "Detail", "Ram Janmabhoomi complex", { maxLength: 50 })],
  designs: { "16:9": locationStrap(G16, "16:9"), "9:16": locationStrap(G9, "9:16") },
});

function hashtagStrap(g: Geo, r: Ratio): GfxLayer[] {
  const h = r === "16:9" ? 84 : 96, y = g.ry + g.rh - h - (r === "16:9" ? 46 : 54);
  const pad = 28, max = Math.min(960, g.right - g.L - h);
  const sh = r === "16:9" ? 46 : 54;
  return [
    rect("box", [g.L, y, h, h], { fill: "@primary", shape: "flat", gloss: 0.12 }, { anim: anim(step("pop", { dur: 0.4 }), step("fade", { dur: 0.2, delay: 0.12 })), shadow: SHADOW }),
    icon("hash", [g.L + h * 0.2, y + h * 0.2, h * 0.6, h * 0.6], "hashtag", { color: "@textOnPrimary", weight: 1.3 }, { anim: anim(step("zoom", { dur: 0.4, delay: 0.1 }), step("fade", { dur: 0.2 })) }),
    rect("plate", [g.L + h, y, 460, h], { fill: "@light", shape: "flat" }, { anim: plateAnim(0.1), shadow: SHADOW }),
    text("hashtag", [g.L + h + pad, y, max - pad * 2, h], "{hashtag}", {
      font: "@headline", size: r === "16:9" ? 52 : 58, weight: 800, color: "@primary", maxLines: 1, fit: "shrink",
      grow: { layers: ["plate"], pad, min: 300, max },
    }, { clip: "plate", anim: anim(step("slide", { dir: "right", dur: 0.45, delay: 0.2, distance: 80 }), step("fade", { dur: 0.2 }), { kind: "shine", period: 9, delay: 1.2 }) }),
    rect("subbg", [g.L + h, y + h, 420, sh], { fill: "@dark/88", shape: "flat" }, { anim: plateAnim(0.2), when: "{subline}" }),
    text("subline", [g.L + h + pad, y + h, max - pad * 2, sh], "{subline}", {
      font: "@body", size: r === "16:9" ? 28 : 32, weight: 600, color: "@text", maxLines: 1, fit: "shrink", grow: { layers: ["subbg"], pad, min: 240, max },
    }, { clip: "subbg", anim: textAnim(0.32, "slide"), when: "{subline}" }),
  ];
}

const hashtag = strap({
  id: "hashtag", name: "Hashtag", kind: "hashtag", tags: ["hashtag", "social", "trend", "lower third"],
  description: "A hashtag for viewers to follow, with an optional call-to-action line.",
  fields: [field.text("hashtag", "Hashtag", "#MumbaiRains", { required: true, maxLength: 32 }), field.text("subline", "Line under it", "Share your pictures with us", { maxLength: 60 })],
  designs: { "16:9": hashtagStrap(G16, "16:9"), "9:16": hashtagStrap(G9, "9:16") },
});

// ── labels ───────────────────────────────────────────────────────────────────

const source = strap({
  id: "source", name: "Source / courtesy", kind: "source", tags: ["source", "courtesy", "credit", "label"],
  description: "Credits where pictures or information came from: Courtesy, Source, Video or Photo, and the name.",
  seconds: 5,
  fields: [
    field.choice("kind", "Says", ["Courtesy", "Source", "Video", "Photo", "Input"].map((v) => ({ value: v, label: v })), "Courtesy"),
    field.text("source", "From", "ANI", { required: true, maxLength: 40 }),
  ],
  designs: { "16:9": label("credit", G16, "16:9", "tl2", "{kind}: {source}"), "9:16": label("credit", G9, "9:16", "tl2", "{kind}: {source}") },
});

const fileFootage = strap({
  id: "file_footage", name: "File footage label", kind: "file", tags: ["file", "archive", "representative", "label"],
  description: "Marks old or illustrative pictures: File footage, File photo, Representative image or Archive, with an optional year.",
  seconds: 5,
  fields: [
    field.choice("label", "Label", [
      { value: "File footage", label: "File footage" }, { value: "File photo", label: "File photo" },
      { value: "Representative image", label: "Representative image" }, { value: "Archive", label: "Archive" },
      { value: "प्रतीकात्मक तस्वीर", label: "प्रतीकात्मक तस्वीर (Hindi)" },
    ], "File footage"),
    field.text("year", "Year or date", "2019", { maxLength: 20 }),
  ],
  designs: both((g, r) => {
    const l = label("label", g, r, "tl2", "{label}", { icon: "camera" });
    const lb = l[0].box, h = lb[3];
    return [
      ...l,
      rect("yearbg", [lb[0], lb[1] + h, 120, Math.round(h * 0.76)], { fill: "@accent", shape: "flat" }, { anim: anim(step("grow", { dur: 0.32, delay: 0.16 }), step("grow", { dur: 0.22 })), when: "{year}" }),
      text("year", [lb[0] + 14, lb[1] + h, 300, Math.round(h * 0.76)], "{year}", { font: "@numbers", size: Math.round(h * 0.46), weight: 700, color: "@dark", maxLines: 1, grow: { layers: ["yearbg"], pad: 14, min: 90, max: 330 } },
        { clip: "yearbg", anim: textAnim(0.26), when: "{year}" }),
    ];
  }),
});

const translated = strap({
  id: "translated", name: "Translated from", kind: "translated", tags: ["translation", "voice-over", "language", "label"],
  description: "Says the words were translated (or voiced over) from another language.",
  seconds: 5,
  fields: [
    field.choice("what", "Says", [{ value: "Translated from", label: "Translated from" }, { value: "Voice-over in English from", label: "Voice-over from" }, { value: "Subtitled from", label: "Subtitled from" }], "Translated from"),
    field.text("language", "Language", "Kannada", { required: true, maxLength: 20 }),
  ],
  designs: { "16:9": label("lang", G16, "16:9", "br", "{what} {language}", { icon: "globe" }), "9:16": label("lang", G9, "9:16", "br", "{what} {language}", { icon: "globe" }) },
});

function sponsored(g: Geo, r: Ratio): GfxLayer[] {
  const h = r === "16:9" ? 92 : 100, w = r === "16:9" ? 470 : 520;
  const x = g.right - w, y = g.br - (h - 50);
  const lg = h - 20;
  return [
    rect("plate", [x, y, w, h], { fill: "@dark/90", shape: "look", stripe: "top", stripeWidth: 4, stripeColor: "@accent" }, { anim: anim(step("grow", { dir: "left", dur: 0.42 }), step("grow", { dur: 0.28, delay: 0.1 })), shadow: SHADOW }),
    rect("logobg", [x + 10, y + 10, lg, lg], { fill: "#FFFFFF", shape: "flat", radius: 6 }, { anim: popAnim(0.16), when: "{logo}" }),
    image("logo", [x + 14, y + 14, lg - 8, lg - 8], "logo", { fit: "contain", bg: "#FFFFFF" }, { anim: popAnim(0.2), when: "{logo}" }),
    text("by", [x + lg + 30, y + 10, w - lg - 48, h * 0.34], "{by}", { font: "@body", size: r === "16:9" ? 22 : 24, weight: 700, color: "@accent", upper: "on", tracking: 2, maxLines: 1, valign: "bottom" },
      { anim: textAnim(0.18) }),
    text("sponsor", [x + lg + 30, y + h * 0.42, w - lg - 48, h * 0.5], "{sponsor}", { font: "@headline", size: r === "16:9" ? 38 : 42, weight: 700, color: "@text", maxLines: 1, fit: "shrink", valign: "top" },
      { anim: textAnim(0.26) }),
  ];
}

const sponsoredBy = strap({
  id: "sponsored", name: "Sponsored by", kind: "sponsored", tags: ["sponsor", "brand", "partner", "label"],
  description: "A sponsor credit with the sponsor's logo (from your bin) and name.",
  seconds: 6,
  fields: [field.text("by", "Says", "Presented by", { maxLength: 24 }), field.text("sponsor", "Sponsor", "Sahyadri Cement", { required: true, maxLength: 36 }), field.image("logo", "Sponsor logo")],
  designs: { "16:9": sponsored(G16, "16:9"), "9:16": sponsored(G9, "9:16") },
});

function aiLabel(g: Geo, r: Ratio): GfxLayer[] {
  const h = r === "16:9" ? 64 : 70;
  const l = label("ai", g, r, "br", "{label}", { icon: "star", fill: "@light", color: "@dark", stripe: "@primary", h, size: Math.round(h * 0.5), y: g.br - 40 });
  const b = l[0].box;
  return [
    ...l,
    text("detail", [g.right - 700, b[1] + h + 6, 700, r === "16:9" ? 34 : 38], "{detail}", { font: "@body", size: r === "16:9" ? 24 : 27, weight: 600, color: "@text", align: "right", maxLines: 1, fit: "shrink" },
      { anim: textAnim(0.3), when: "{detail}", shadow: { color: "rgba(0,0,0,0.8)", blur: 8, x: 0, y: 2 } }),
  ];
}

const ai = strap({
  id: "ai_label", name: "AI-generated label", kind: "ai_label", tags: ["ai", "synthetic", "disclosure", "label", "it rules"],
  description: "A clear label for AI-made pictures (India IT Rules 2026): \"AI-generated\" with an optional line of detail. Keep it on while AI-made media is on screen.",
  seconds: 6,
  fields: [
    field.choice("label", "Label", [
      { value: "AI-generated", label: "AI-generated" }, { value: "AI-generated visuals", label: "AI-generated visuals" }, { value: "Created with AI", label: "Created with AI" },
      { value: "AI द्वारा निर्मित", label: "AI द्वारा निर्मित (Hindi)" },
    ], "AI-generated"),
    field.text("detail", "Detail", "Visuals recreated with AI for illustration", { maxLength: 60 }),
  ],
  designs: { "16:9": aiLabel(G16, "16:9"), "9:16": aiLabel(G9, "9:16") },
});

function slugStrap(g: Geo, r: Ratio): GfxLayer[] {
  const h = r === "16:9" ? 56 : 62, x = r === "16:9" ? 96 : 66, y = g.top;
  const pad = 22, max = r === "16:9" ? 760 : 700;
  const kh = Math.round(h * 0.72);
  return [
    rect("ear", [x, y, 14, h], { fill: "@accent", shape: "flat" }, { anim: anim(step("grow", { dir: "down", dur: 0.26 }), step("fade", { dur: 0.2, delay: 0.16 })) }),
    rect("plate", [x + 14, y, 360, h], { fill: "@primary", shape: "flat", gloss: 0.12 }, { anim: plateAnim(0.08), shadow: SHADOW }),
    text("slug", [x + 14 + pad, y, max - pad * 2, h], "{slug}", {
      font: "@headline", size: Math.round(h * 0.6), weight: 700, color: "@textOnPrimary", upper: "on", tracking: 1.5, maxLines: 1, fit: "shrink",
      grow: { layers: ["plate"], pad, min: 240, max },
    }, { clip: "plate", anim: textAnim(0.18), }),
    rect("kickerbg", [x + 14, y + h, 240, kh], { fill: "@dark/88", shape: "flat" }, { anim: plateAnim(0.2), when: "{kicker}" }),
    text("kicker", [x + 14 + pad, y + h, max - pad * 2, kh], "{kicker}", {
      font: "@body", size: Math.round(kh * 0.56), weight: 700, color: "@accent", upper: "on", tracking: 1, maxLines: 1, fit: "shrink",
      grow: { layers: ["kickerbg"], pad, min: 140, max },
    }, { clip: "kickerbg", anim: textAnim(0.3, "slide"), when: "{kicker}" }),
  ];
}

const slug = strap({
  id: "slug", name: "Story slug", kind: "slug", tags: ["slug", "topic", "story", "corner", "label"],
  description: "The story's topic in the top-left corner, with an optional line under it (Day 3, Live updates …).",
  seconds: 8,
  fields: [field.text("slug", "Slug", "Monsoon fury", { fill: "story.slug", required: true, maxLength: 30 }), field.text("kicker", "Under it", "Day 3 · Live updates", { maxLength: 30 })],
  designs: { "16:9": slugStrap(G16, "16:9"), "9:16": slugStrap(G9, "9:16") },
});

export const STRAPS: GfxTemplate[] = [
  anchor, reporter, guest, headline, location, phone, videoCall, hashtag, source, fileFootage, translated, sponsoredBy, ai, slug,
];

