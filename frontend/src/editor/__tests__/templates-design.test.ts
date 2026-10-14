/**
 * The title design system (templates/design.ts, docs/EDITOR.md §15.3): the tokens themselves, and every title
 * template (the 106 of wave 3, restyled, and the presets pack's 63) built from them — contrast on its plate, boxes on
 * the grid inside title safe, sizes from the type scale, durations from the motion presets, the bundled fonts of its
 * pairing — with the template ids unchanged. The social templates follow the same rules in every frame they land in.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  contrast, INDIC_SCRIPTS, insideSafe, MIN_CONTRAST, MOTION, MOTION_LIMITS, onGrid, PAIRINGS, palette, PALETTES, plateContrast, readingPairs, SUB_STEP, TYPE_SCALE, TYPE_SIZES,
} from "../templates/design.ts";
import { PACK_SEQ_GROUPS, safeOf } from "../templates/packs/social.ts";
import { SEQ_TEMPLATES, type SeqTemplate } from "../templates/sequences.ts";
import { formatById, formatSize, type Format } from "../templates/formats.ts";
import { titleTemplates } from "../templates/titles.ts";
import { drawTitle } from "../render/title.ts";
import type { TitleSpec } from "../model/types.ts";

/** The bundled fonts (pages/posters/fonts.ts, read as text: it imports CSS): weights and scripts, plus Inter. */
function bundled(): Map<string, { weights: number[]; scripts: string[] }> {
  const src = readFileSync(fileURLToPath(new URL("../../pages/posters/fonts.ts", import.meta.url)), "utf8");
  const out = new Map([["Inter Variable", { weights: Array.from({ length: 9 }, (_, i) => 100 + i * 100), scripts: ["latin"] }]]);
  for (const m of src.matchAll(/family: "([^"]+)".*?scripts: \[([^\]]*)\], weights: (\[[\d, ]+\]|RANGE\((\d+), (\d+)\))/g)) {
    const weights = m[4] ? Array.from({ length: (Number(m[5]) - Number(m[4])) / 100 + 1 }, (_, i) => Number(m[4]) + i * 100) : JSON.parse(m[3]) as number[];
    out.set(m[1], { weights, scripts: [...m[2].matchAll(/"(\w+)"/g)].map((x) => x[1]) });
  }
  return out;
}
const FONTS = bundled();

// ── the tokens ───────────────────────────────────────────────────────────────

test("tokens: a six-step type scale, ten palettes at 4.5:1, bundled pairings that set the Indic scripts, motion in range", () => {
  assert.equal(TYPE_SIZES.length, 6);
  for (let i = 1; i < TYPE_SIZES.length; i++) {
    const r = TYPE_SIZES[i - 1] / TYPE_SIZES[i];
    assert.ok(r >= 1.3 && r <= 1.6, `step ${TYPE_SIZES[i - 1]} → ${TYPE_SIZES[i]} (${r.toFixed(2)})`);
  }
  for (const [k, v] of Object.entries(SUB_STEP)) assert.ok(TYPE_SCALE[v] <= TYPE_SCALE[k as keyof typeof TYPE_SCALE], k);
  assert.equal(PALETTES.length, 10);
  assert.equal(new Set(PALETTES.map((p) => p.id)).size, 10);
  for (const p of PALETTES) {
    assert.ok(contrast(p.text, p.bg) >= MIN_CONTRAST, `${p.id} text`);
    assert.ok(contrast(p.sub, p.bg) >= MIN_CONTRAST, `${p.id} sub`);
    assert.ok(contrast(p.onAccent, p.accent) >= MIN_CONTRAST, `${p.id} on accent`);
  }
  assert.ok(contrast("#ffffff", "#000000") > 20.9 && Math.abs(contrast("#777777", "#777777") - 1) < 1e-9);
  assert.ok(FONTS.size >= 20, `${FONTS.size} fonts parsed`);
  for (const f of PAIRINGS) {
    for (const r of [f.display, f.text]) {
      const b = FONTS.get(r.family);
      assert.ok(b, `${f.id}: ${r.family} is bundled`);
      assert.ok(b.weights.includes(r.weight), `${f.id}: ${r.family} ${r.weight}`);
    }
    for (const s of INDIC_SCRIPTS) {
      const fam = f.indic[s];
      assert.ok(FONTS.get(fam)?.scripts.includes(s), `${f.id}: ${fam} sets ${s}`);
    }
  }
  for (const m of Object.values(MOTION)) {
    assert.ok(m.inDur >= MOTION_LIMITS.in[0] && m.inDur <= MOTION_LIMITS.in[1], `${m.id} in ${m.inDur}`);
    assert.ok(m.outDur >= MOTION_LIMITS.out[0] && m.outDur <= MOTION_LIMITS.out[1], `${m.id} out ${m.outDur}`);
    if (m.step !== undefined) assert.ok(m.step >= MOTION_LIMITS.step[0] && m.step <= MOTION_LIMITS.step[1], `${m.id} step`);
    assert.equal(m.expressive, ["bounce", "elastic", "glitch", "spin", "pop"].includes(m.in), `${m.id} expressive`);
  }
  // a translucent plate is judged over black and over white footage
  assert.ok(plateContrast("#ffffff", "#000000e6") >= MIN_CONTRAST);
  assert.ok(plateContrast("#ffffff", "#00000080") < MIN_CONTRAST);
});

// ── every title template ─────────────────────────────────────────────────────

/** The 106 wave-3 ids, written out: restyling must not rename any of them (edits keep the ids they used). */
const WAVE3_IDS = [
  ...["clean", "bold", "cinematic", "neon", "handwritten"].flatMap((s, i) => [...["fade", "rise", "pop", "typewriter", "blur", "zoom", "wipe", "bounce"].map((a) => `headline.${s}.${a}`),
    `headline.${s}.${["slide", "glitch", "tracking", "flicker", "elastic"][i]}`]),
  ...["bar", "split", "pill", "box", "underline", "bracket", "glass", "slash", "minimal", "gradient", "frame", "sport"].flatMap((p) => ["slide_left", "wipe", "rise"].map((a) => `lower.${p}.${a}`)),
  "news.ticker.red", "news.ticker.blue", "news.breaking", "end.thanks", "end.next", "end.follow", "end.credits",
  "social.subscribe.pop", "social.subscribe.slide", "social.like.pop", "social.bell", "social.likesub", "social.burst",
  "quote.serif", "quote.modern", "quote.hand", "quote.callout", "chapter.lines", "chapter.part", "chapter.number", "chapter.left", "chapter.underline",
  "count.ring", "count.big", "count.starting",
];

test("the restyle keeps every template id", () => {
  assert.equal(WAVE3_IDS.length, 106);
  const ids = titleTemplates().map((t) => t.id);
  for (const id of WAVE3_IDS) assert.ok(ids.includes(id), id);
  assert.equal(ids.length, 106 + 63);
  assert.deepEqual(ids.slice(0, 106), WAVE3_IDS.slice().sort((a, b) => ids.indexOf(a) - ids.indexOf(b)));
});

test("every title template: its text plate passes 4.5:1, its box is on the grid inside title safe, its sizes from the type scale", () => {
  for (const t of titleTemplates()) {
    assert.ok(t.design, `${t.id} is built from the design tokens`);
    const p = palette(t.design.palette);
    const pairs = readingPairs(t.spec, p);
    if (t.spec.text.trim() || t.spec.shape?.kind === "subscribe" || t.spec.shape?.kind === "like") assert.ok(pairs.length, `${t.id} has text to read`);
    for (const r of pairs) assert.ok(plateContrast(r.fg, r.bg) >= MIN_CONTRAST, `${t.id}: ${r.what} ${r.fg} on ${r.bg} = ${plateContrast(r.fg, r.bg).toFixed(2)}`);
    assert.ok(insideSafe(t.spec.box), `${t.id}: box ${t.spec.box} inside title safe`);
    assert.ok(onGrid(t.spec.box), `${t.id}: box ${t.spec.box} on the 8 px grid`);
    assert.ok(TYPE_SIZES.includes(t.spec.size), `${t.id}: size ${t.spec.size}`);
    assert.equal(t.spec.size, TYPE_SCALE[t.design.size], t.id);
    if (t.spec.look?.sub) {
      assert.ok(TYPE_SIZES.includes(t.spec.look.sub.size), `${t.id}: sub ${t.spec.look.sub.size}`);
      assert.ok(t.spec.look.sub.size < t.spec.size, `${t.id}: the sub line is smaller`);
    }
    // its colours come from its palette (or the shape that carries it)
    assert.ok([p.text, p.onAccent, t.spec.shape?.stroke, "#ffffff"].includes(t.spec.color), `${t.id}: colour ${t.spec.color}`);
    if (t.spec.look?.decor) assert.ok([p.accent, p.bg, p.text, p.onAccent].some((c) => t.spec.look!.decor!.color.startsWith(c.slice(0, 7))), `${t.id}: decor ${t.spec.look.decor.color}`);
  }
});

test("every title template: fonts from its pairing, motion from the presets, no playful moves on serious styles", () => {
  for (const t of titleTemplates()) {
    const f = PAIRINGS.find((x) => x.id === t.design!.pairing)!;
    assert.ok([f.display, f.text].some((r) => r.family === t.spec.font && r.weight === t.spec.weight), `${t.id}: ${t.spec.font} ${t.spec.weight} from ${f.id}`);
    if (t.spec.look?.sub?.font) assert.equal(t.spec.look.sub.font, f.text.family, t.id);
    const m = MOTION[t.design!.motion];
    const L = t.spec.look!;
    assert.equal(L.in, m.in, `${t.id}: in`);
    assert.equal(L.inDur, m.inDur, `${t.id}: in duration`);
    assert.equal(L.outDur, m.outDur, `${t.id}: out duration`);
    assert.ok(L.out === m.out || L.out === "none", `${t.id}: out ${L.out}`);
    if (L.staggerStep !== undefined) assert.ok(L.staggerStep >= MOTION_LIMITS.step[0] && L.staggerStep <= MOTION_LIMITS.step[1], `${t.id}: stagger`);
    assert.ok(t.tone, t.id);
    if (t.tone === "serious") {
      assert.ok(!m.expressive, `${t.id}: ${m.id} on a serious style`);
      assert.ok(!["pulse", "shake", "wiggle", "spin", "float"].includes(L.loop ?? "none"), `${t.id}: loop ${L.loop}`);
    }
  }
  // the calm swaps keep the ids: a serious headline's "bounce" slot drops in, its "pop" flips up
  const clean = titleTemplates().find((t) => t.id === "headline.clean.bounce")!;
  assert.equal(clean.spec.look?.in, "drop");
  assert.equal(titleTemplates().find((t) => t.id === "headline.bold.bounce")!.spec.look?.in, "bounce");
});

// ── the social templates, in every frame they land in ────────────────────────

const PACK_SEQ = SEQ_TEMPLATES.filter((t) => (PACK_SEQ_GROUPS as string[]).includes(t.group) || /^subscribe\.(click|like_comment_share|bar|follow_like)$/.test(t.id));
const fieldsOf = (t: SeqTemplate) => Object.fromEntries(t.fields.map((f) => [f.key, f.value]));
function sizesFor(t: SeqTemplate): [number, number][] {
  if (t.format) { const s = formatSize({ width: 1920, height: 1080 }, formatById(t.format) as Format); return [[s.width, s.height]]; }
  return [[1920, 1080], [1080, 1920], [1080, 1080], [3840, 2160]];
}

test("social templates: type-scale sizes, motion-preset durations and readable text in every frame", () => {
  for (const t of PACK_SEQ) for (const [W, H] of sizesFor(t)) {
    const short = Math.min(W, H);
    const layers = t.layers(fieldsOf(t), W, H);
    const matte = layers.flat().find((l) => l.source.type === "color" && !l.name.startsWith("Slot · ") && l.start === 0 && !l.effects?.some((e) => e.type === "color_gradient"));
    for (const l of layers.flat()) {
      if (l.source.type !== "title") continue;
      const s: TitleSpec = l.source.text;
      const at1080 = Math.round((s.size * 1080) / short * 10) / 10;
      assert.ok(TYPE_SIZES.some((v) => Math.abs(v - at1080) <= 0.2), `${t.id} @${W}×${H} ${l.name}: size ${s.size} (${at1080} at 1080)`);
      if (s.look?.sub) assert.ok(TYPE_SIZES.some((v) => Math.abs(v - (s.look!.sub!.size * 1080) / short) <= 0.2), `${t.id} ${l.name}: sub size`);
      const L = s.look ?? {};
      if (L.in && L.in !== "none") assert.ok(L.inDur !== undefined && L.inDur >= MOTION_LIMITS.in[0] && L.inDur <= MOTION_LIMITS.in[1], `${t.id} ${l.name}: in ${L.inDur}`);
      if (L.out && L.out !== "none") assert.ok(L.outDur !== undefined && L.outDur >= MOTION_LIMITS.out[0] && L.outDur <= MOTION_LIMITS.out[1], `${t.id} ${l.name}: out ${L.outDur}`);
      // the text is read on its plate or shape; free text over a known matte must read on it too (over footage it has a shadow)
      const shows = s.text.trim() || s.shape?.kind === "subscribe" || s.shape?.kind === "like";
      if (!shows) continue;
      const d = s.look?.decor;
      const plate = s.shape?.fill && s.shape.fill !== "none" && s.shape.kind !== "line" ? s.shape.fill : d && ["box", "pill", "glass", "slash", "split", "ticker"].includes(d.kind) ? d.color : null;
      const fg = s.shape?.kind === "subscribe" || s.shape?.kind === "like" ? (s.shape.stroke ?? "#ffffff") : s.color;
      if (plate) assert.ok(plateContrast(fg, plate) >= MIN_CONTRAST, `${t.id} ${l.name}: ${fg} on ${plate}`);
      else if (matte && matte.source.type === "color" && l.start < matte.start + matte.dur) assert.ok(contrast(fg, matte.source.color) >= MIN_CONTRAST, `${t.id} ${l.name}: ${fg} on the ${matte.source.color} matte`);
      else assert.ok(s.shadow || s.outline, `${t.id} ${l.name}: text over footage has a shadow`);
      if (s.look?.sub?.text && !plate && matte?.source.type === "color") assert.ok(contrast(s.look.sub.color, matte.source.color) >= MIN_CONTRAST, `${t.id} ${l.name}: sub on the matte`);
    }
    // and every text box is inside the frame's safe area (at least EBU title safe)
    const safe = safeOf(W, H);
    for (const l of layers.flat()) if (l.source.type === "title" && (l.source.text.text.trim() || l.source.text.look?.count))
      assert.ok(insideSafe(l.source.text.box, safe), `${t.id} @${W}×${H} ${l.name}: ${l.source.text.box}`);
  }
});

/** A 2D context that only measures (each character half the font size) and records nothing (as looks-titles.test). */
function stubContext(): CanvasRenderingContext2D {
  let size = 10;
  const ctx: Record<string, unknown> = {
    set font(v: string) { size = Number(/(\d+)px/.exec(v)?.[1] ?? 10); }, get font() { return `${size}px x`; },
    measureText: (t: string) => ({ width: t.length * size * 0.5 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  return new Proxy(ctx, { get: (o, k) => (k in o ? o[k as string] : () => undefined), set: (o, k, v) => { o[k as string] = v; return true; } }) as unknown as CanvasRenderingContext2D;
}

test("every title template draws: through its entrance, at rest (inside the frame) and on its way out", () => {
  for (const t of titleTemplates()) {
    const dur = t.seconds;
    for (const at of [0.02, 0.2, (t.spec.look?.inDur ?? 0.5) + 0.05, dur / 2, dur - 0.1]) {
      const b = drawTitle(stubContext(), t.spec, 1920, 1080, at, dur);
      if (at >= (t.spec.look?.inDur ?? 0.5) + 0.05 && at <= dur / 2) {
        assert.ok(b, `${t.id} draws at ${at}s`);
        assert.ok(b[0] >= 0 && b[1] >= 0 && b[0] + b[2] <= 1920 && b[1] + b[3] <= 1080, `${t.id}: bounds ${b}`);
      }
    }
  }
});
