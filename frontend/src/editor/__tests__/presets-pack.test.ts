/**
 * The §15.3 presets pack (presets-pack): audio chain presets, effect look packs, title templates in nine new
 * categories and social sequence templates — counts, stable ids, only existing effects with parameters in range,
 * boxes inside the safe area, templates that insert and fill their slots, and edits that still round-trip.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AUDIO_FX, audioFxId, CHAIN_PRESETS, resolveParams } from "../audiofx/registry.ts";
import "../../engine/effects/index.ts";
import { listEffectInfos, type EffectInfo, type EffectParamDef } from "../../engine/effects/registry.ts";
import { moodById } from "../../lib/moods.ts";
import { applyMood, clipMood, removeMood } from "../moods/apply.ts";
import { applyLook, lookById, lookEffects, LOOK_PACKS, LOOKS, looksOf } from "../moods/packs/looks.ts";
import { ctxOf } from "../model/ops.ts";
import { forDisk, parseProject } from "../model/serialize.ts";
import type { EditProject, TitleSpec } from "../model/types.ts";
import { boxInside, formatById, formatSize, SAFE_AREAS, type Format } from "../templates/formats.ts";
import { PACK_TITLE_CATEGORIES, packTitleTemplates } from "../templates/packs/titles.ts";
import { PACK_SEQ_GROUPS, safeOf, setVisualiserProvider, STATIC_WAVEFORM, visualiserProviderFrom } from "../templates/packs/social.ts";
import { fillSlot, insertTemplate, isSlot, SEQ_TEMPLATE_GROUPS, SEQ_TEMPLATES, socialSequence, type SeqTemplate } from "../templates/sequences.ts";
import { TEMPLATE_CATEGORIES, templateSpec, titleTemplates } from "../templates/titles.ts";
import { media, project, put, seqOf } from "./fixtures.ts";

const NEW_CHAINS = ["youtube_voice", "podcast_duo", "phone_bandpass", "stadium_announcer", "horror_whisper", "trailer_voice", "asmr", "car_radio"];
const PACK_SEQ = SEQ_TEMPLATES.filter((t) => (PACK_SEQ_GROUPS as string[]).includes(t.group) || /^subscribe\.(click|like_comment_share|bar|follow_like)$/.test(t.id));

/** The bundled fonts (pages/posters/fonts.ts, read as text: it imports CSS) and their weights, plus Inter. */
function bundledFonts(): Map<string, number[]> {
  const src = readFileSync(fileURLToPath(new URL("../../pages/posters/fonts.ts", import.meta.url)), "utf8");
  const out = new Map<string, number[]>([["Inter Variable", Array.from({ length: 9 }, (_, i) => 100 + i * 100)]]);
  for (const m of src.matchAll(/family: "([^"]+)".*?weights: (\[[\d, ]+\]|RANGE\((\d+), (\d+)\))/g)) {
    const w = m[3] ? Array.from({ length: (Number(m[4]) - Number(m[3])) / 100 + 1 }, (_, i) => Number(m[3]) + i * 100) : JSON.parse(m[2]) as number[];
    out.set(m[1], w);
  }
  return out;
}

// ── counts ───────────────────────────────────────────────────────────────────

test("counts: 8 audio chain presets, 6 look packs of 5, 63 title templates in 9 categories, 24 social templates", () => {
  for (const id of NEW_CHAINS) assert.ok(CHAIN_PRESETS.some((c) => c.id === id), id);
  assert.equal(CHAIN_PRESETS.length, 11 + 8);
  assert.equal(LOOK_PACKS.length, 6);
  for (const p of LOOK_PACKS) assert.equal(looksOf(p.id).length, 5, p.id);
  assert.equal(LOOKS.length, 30);
  const pack = packTitleTemplates();
  assert.equal(pack.length, 63);
  assert.equal(PACK_TITLE_CATEGORIES.length, 9);
  for (const c of PACK_TITLE_CATEGORIES) assert.equal(pack.filter((t) => t.category === c).length, 7, c);
  for (const c of PACK_TITLE_CATEGORIES) assert.ok(TEMPLATE_CATEGORIES.includes(c), `${c} is a panel category`);
  const all = titleTemplates();
  for (const c of TEMPLATE_CATEGORIES) assert.ok(all.some((t) => t.category === c), `${c} has templates`);
  assert.equal(all.filter((t) => (PACK_TITLE_CATEGORIES as string[]).includes(t.category)).length, 63);
  const by = (g: string) => PACK_SEQ.filter((t) => t.group === g).length;
  assert.deepEqual({ hooks: by("Hooks"), subscribe: by("Subscribe"), end: by("End screens"), audiograms: by("Audiograms"), quotes: by("Quote cards"), compare: by("Before/after"), countdowns: by("Countdowns") },
    { hooks: 5, subscribe: 4, end: 4, audiograms: 2, quotes: 4, compare: 2, countdowns: 3 });
  assert.equal(PACK_SEQ.length, 24);
  for (const g of SEQ_TEMPLATE_GROUPS) assert.ok(SEQ_TEMPLATES.some((t) => t.group === g), `${g} has templates`);
});

test("ids are unique and the same every build", () => {
  const uniq = (ids: string[], what: string) => assert.equal(new Set(ids).size, ids.length, what);
  uniq(CHAIN_PRESETS.map((c) => c.id), "chain presets");
  uniq(LOOKS.map((l) => l.id), "looks");
  uniq(titleTemplates().map((t) => t.id), "title templates");
  uniq(SEQ_TEMPLATES.map((t) => t.id), "sequence templates");
  assert.equal(JSON.stringify(packTitleTemplates()), JSON.stringify(packTitleTemplates()));
  const pack = packTitleTemplates();
  assert.equal(pack[0].id, "gaming.neon.glitch");
  assert.equal(pack.at(-1)!.id, "podcast.now_playing");
  assert.ok(pack.some((t) => t.id === "wedding.script.blur" && t.fields.sub === "12 · 12 · 2026"));
  assert.ok(pack.some((t) => t.id === "fitness.interval" && t.spec.look?.count?.from === 30));
  // the wave-3 templates keep their place: the pack comes after them
  assert.equal(titleTemplates()[0].id, "headline.clean.fade");
  assert.equal(titleTemplates().findIndex((t) => t.id === "gaming.neon.glitch"), titleTemplates().length - 63);
  assert.equal(lookById("look.cinematic.teal_orange")?.id, "cinematic.teal_orange");
  assert.equal(lookById("cinematic.teal_orange")?.label, "Teal & orange");
});

// ── only existing effects and params, in range ───────────────────────────────

test("audio chain presets use only registered effects, with parameters in range", () => {
  for (const c of CHAIN_PRESETS.filter((x) => NEW_CHAINS.includes(x.id))) {
    assert.ok(c.effects.length >= 2, c.id);
    for (const e of c.effects) {
      assert.equal(audioFxId(e.id), e.id, `${c.id}: ${e.id}`);
      const def = AUDIO_FX.find((d) => d.id === e.id)!;
      for (const [k, v] of Object.entries(e.values ?? {})) {
        const p = def.params.find((x) => x.name === k);
        assert.ok(p, `${c.id}: ${e.id}.${k}`);
        if (p.type === "number") {
          assert.equal(typeof v, "number", `${c.id}: ${e.id}.${k}`);
          assert.ok((p.min ?? -Infinity) <= (v as number) && (v as number) <= (p.max ?? Infinity), `${c.id}: ${e.id}.${k}=${v} in ${p.min}..${p.max}`);
        } else if (p.type === "select") assert.ok(p.options!.some((o) => o.value === v), `${c.id}: ${e.id}.${k}=${v}`);
      }
      // nothing is clamped or dropped when the preset is applied
      const r = resolveParams(e.id, e.values ?? {});
      for (const [k, v] of Object.entries(e.values ?? {})) assert.equal(r[k], v, `${c.id}: ${e.id}.${k}`);
    }
  }
  // the lo-fi crusher comes before any filter in car radio (FFmpeg's acrusher turns filter denormals into NaN)
  const car = CHAIN_PRESETS.find((c) => c.id === "car_radio")!;
  assert.equal(car.effects[0].id, "lofi");
});

const ENGINE = new Map(listEffectInfos().map((d) => [d.id, d]));
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
/** Asserts an engine effect's parameters exist and are in their declared range. */
function checkEngineEffect(where: string, type: string, params: Record<string, unknown>) {
  const def: EffectInfo | undefined = ENGINE.get(type);
  assert.ok(def, `${where}: effect ${type} is registered`);
  for (const [k, v] of Object.entries(params)) {
    const p: EffectParamDef | undefined = def.params.find((x: EffectParamDef) => x.name === k);
    assert.ok(p, `${where}: ${type}.${k}`);
    const inRange = (x: number): boolean => (p.min ?? -Infinity) - 1e-9 <= x && x <= (p.max ?? Infinity) + 1e-9;
    switch (p.type) {
      case "float": case "int": case "angle": assert.ok(typeof v === "number" && inRange(v), `${where}: ${type}.${k}=${v} in ${p.min}..${p.max}`); break;
      case "bool": assert.equal(typeof v, "boolean", `${where}: ${type}.${k}`); break;
      case "enum": assert.ok(p.options!.some((o) => o.value === v || String(o.value) === String(v)), `${where}: ${type}.${k}=${v}`); break;
      case "color": case "rgba": assert.ok(typeof v === "string" && HEX.test(v), `${where}: ${type}.${k}=${v}`); break;
      case "vec2": case "point": case "rgb": assert.ok(Array.isArray(v) && v.every((x: unknown): boolean => typeof x === "number" && (p.type === "point" || inRange(x))), `${where}: ${type}.${k}`); break;
      case "curve": assert.ok(Array.isArray(v) && v.every((pt) => Array.isArray(pt) && pt.every((x) => x >= 0 && x <= 1)), `${where}: ${type}.${k}`); break;
      default: break;
    }
  }
}

test("look packs use only registered effects, with parameters in range at every intensity", () => {
  for (const l of LOOKS) {
    assert.ok(l.effects.length >= 2, l.id);
    for (const k of [1, 0.5, 1.5]) for (const e of lookEffects(l, k)) checkEngineEffect(`${l.id}@${k}`, e.type, e.params);
    assert.deepEqual(lookEffects(l, 0), [], `${l.id} at 0 changes nothing`);
  }
});

test("social templates' layer effects are registered effects with parameters in range", () => {
  for (const t of PACK_SEQ) for (const [W, H] of sizesFor(t)) for (const track of t.layers(fieldsOf(t), W, H)) for (const l of track) {
    for (const e of l.effects ?? []) checkEngineEffect(`${t.id} ${l.name}`, e.type, e.params);
  }
});

// ── fonts, safe areas ────────────────────────────────────────────────────────

const fieldsOf = (t: SeqTemplate) => Object.fromEntries(t.fields.map((f) => [f.key, f.value]));
/** The frames a template is checked in: its format's, or landscape and vertical for the ones that go anywhere. */
function sizesFor(t: SeqTemplate): [number, number][] {
  if (t.format) { const s = formatSize({ width: 1920, height: 1080 }, formatById(t.format) as Format); return [[s.width, s.height]]; }
  return [[1920, 1080], [1080, 1920], [1080, 1080]];
}
/** Title layers that show text (or a labelled button); text-less shapes such as dividers may bleed. */
const showsText = (s: TitleSpec) => !!s.text.trim() || s.shape?.kind === "subscribe" || s.shape?.kind === "like" || !!s.look?.count;

test("pack title templates: bundled fonts and weights, boxes inside the 16:9 safe area, extended looks", () => {
  const fonts = bundledFonts();
  assert.ok(fonts.size >= 20, `${fonts.size} fonts parsed`);
  for (const t of packTitleTemplates()) {
    const w = fonts.get(t.spec.font);
    assert.ok(w, `${t.id}: ${t.spec.font} is bundled`);
    assert.ok(w.includes(t.spec.weight), `${t.id}: ${t.spec.font} has weight ${t.spec.weight}`);
    if (t.spec.look?.sub?.font) assert.ok(fonts.has(t.spec.look.sub.font), `${t.id}: sub font ${t.spec.look.sub.font}`);
    assert.ok(boxInside(t.spec.box, SAFE_AREAS["16:9"]), `${t.id}: box ${t.spec.box} inside the safe area`);
    assert.ok(t.spec.look, `${t.id} uses the template renderer`);
    assert.ok(t.seconds > 0 && t.fields.text, t.id);
    // scales to a 4K sequence like the others
    assert.equal(templateSpec(t, 2160).size, t.spec.size * 2);
  }
});

test("social templates keep their text inside the safe area of the frame they land in", () => {
  const fonts = bundledFonts();
  for (const t of PACK_SEQ) for (const [W, H] of sizesFor(t)) {
    const safe = safeOf(W, H);
    let texts = 0;
    for (const track of t.layers(fieldsOf(t), W, H)) for (const l of track) {
      assert.ok(l.dur > 0 && l.start >= 0 && l.start + l.dur <= t.seconds + 1e-9, `${t.id} ${l.name} within the template's length`);
      if (l.source.type !== "title") continue;
      const s = l.source.text;
      assert.ok(fonts.has(s.font), `${t.id} ${l.name}: ${s.font}`);
      if (!showsText(s)) continue;
      texts++;
      assert.ok(boxInside(s.box, safe), `${t.id} @${W}×${H} ${l.name}: ${s.box} inside ${JSON.stringify(safe)}`);
    }
    assert.ok(texts > 0, `${t.id} shows some text`);
  }
});

// ── inserting and filling ────────────────────────────────────────────────────

test("social templates insert (flattened and nested), and their slots fill with media", () => {
  for (const t of PACK_SEQ) {
    const p = project();
    const s = seqOf(p);
    const layers = t.layers(fieldsOf(t), s.width, s.height);
    const n = layers.reduce((a, l) => a + l.length, 0);
    const flat = insertTemplate(p, s.id, t, 25, "flatten");
    const fs = seqOf(flat.project);
    assert.equal(flat.clipIds.length, n, `${t.id}: one clip per layer`);
    assert.equal(fs.tracks.filter((x) => x.kind === "video").length, s.tracks.filter((x) => x.kind === "video").length + layers.length, t.id);
    for (const id of flat.clipIds) assert.ok(fs.clips.find((c) => c.id === id && c.start >= 25), `${t.id}: ${id} placed at the playhead`);
    const slots = fs.clips.filter(isSlot);
    if (slots.length) {
      const filled = fillSlot(fs, ctxOf(flat.project), slots[0].id, flat.project.media[0]);
      const c = filled.clips.find((x) => x.id === slots[0].id)!;
      assert.equal(c.source.type, "media", `${t.id}: the slot takes the clip`);
      assert.deepEqual(c.effects.map((e) => e.type), slots[0].effects.map((e) => e.type), `${t.id}: the slot's effects stay`);
      assert.equal(c.duration, slots[0].duration);
    }
    const nest = insertTemplate(p, s.id, t, 0, "nest");
    assert.equal(nest.project.sequences.length, 2, t.id);
    if (t.format) {
      const r = socialSequence(p, s.id, t, { nest: true });
      const rs = r.project.sequences.find((x) => x.id === r.sequenceId)!;
      const size = formatSize(s, formatById(t.format) as Format);
      assert.deepEqual([rs.width, rs.height], [size.width, size.height], t.id);
      assert.equal(r.project.activeSequenceId, rs.id);
    }
  }
  // the hooks and quotes take what the user typed
  const p = project();
  const hook = SEQ_TEMPLATES.find((t) => t.id === "hook.pov")!;
  const r = insertTemplate(p, seqOf(p).id, hook, 0, "flatten", { hook: "POV: it worked" });
  assert.ok(seqOf(r.project).clips.some((c) => c.source.type === "title" && c.source.text.text === "POV: it worked"));
});

test("audiograms draw the visualiser when audio tools provide it, else a static waveform", () => {
  const ag = SEQ_TEMPLATES.filter((t) => t.group === "Audiograms");
  assert.equal(ag.length, 2);
  for (const t of ag) {
    const [[W, H]] = sizesFor(t);
    const names = t.layers(fieldsOf(t), W, H).flat().map((l) => l.name);
    assert.ok(names.includes(STATIC_WAVEFORM), `${t.id}: static fallback`);
    const wave = t.layers(fieldsOf(t), W, H).flat().find((l) => l.name === STATIC_WAVEFORM)!;
    assert.ok(wave.effects?.some((e) => e.type === "wave"), "the waveform is bent by the engine's wave effect");
  }
  const calls: unknown[] = [];
  setVisualiserProvider((spec, box) => { calls.push({ spec, box }); return { source: { type: "color", color: "#123456" }, name: "Visualiser" }; });
  try {
    const t = ag[0];
    const [[W, H]] = sizesFor(t);
    const layer = t.layers(fieldsOf(t), W, H).flat().find((l) => l.name === "Visualiser");
    assert.ok(layer && layer.source.type === "color", "the provider's source is used");
    assert.equal(calls.length, 1);
    const p = project();
    const r = socialSequence(p, seqOf(p).id, t, {});
    assert.ok(r.project.sequences.find((x) => x.id === r.sequenceId)!.clips.some((c) => c.name === "Visualiser"));
  } finally { setVisualiserProvider(null); }
});

test("audiograms over audio-tools2's visualiser source (when this build has it)", async (t) => {
  let viz: Record<string, unknown> | null = null;
  try { viz = await import("../audiotools/visualizer.ts") as Record<string, unknown>; } catch { viz = null; }
  if (!viz || typeof viz.makeVisualizerSource !== "function") { t.skip("no audiotools/visualizer.ts in this build"); return; }
  const make = viz.makeVisualizerSource as (o: Record<string, unknown>) => import("../model/types.ts").ClipSource;
  const styles = viz.VISUALIZER_STYLES as { id: string }[];
  let audio: { mediaId: string; offset: number } | null = null;
  setVisualiserProvider(visualiserProviderFrom(make, styles, () => audio));
  try {
    const sq = SEQ_TEMPLATES.find((x) => x.id === "audiogram.square")!;
    // no sound yet: the static waveform
    assert.ok(sq.layers(fieldsOf(sq), 1080, 1080).flat().some((l) => l.name === STATIC_WAVEFORM));
    audio = { mediaId: "music", offset: 12.5 };
    for (const tpl of SEQ_TEMPLATES.filter((x) => x.group === "Audiograms")) {
      const [[W, H]] = sizesFor(tpl);
      const layer = tpl.layers(fieldsOf(tpl), W, H).flat().find((l) => l.name === "Visualiser")!;
      assert.ok(layer, tpl.id);
      const src = layer.source as { type: string; mediaId?: string; offset?: number; style?: string; box?: number[] };
      assert.equal(src.type, "visualizer");
      assert.equal(src.mediaId, "music");
      assert.equal(src.offset, 12.5);
      assert.ok(styles.some((s) => s.id === src.style), `${tpl.id}: style ${src.style}`);
      assert.ok(boxInside(src.box as TitleSpec["box"], safeOf(W, H)), `${tpl.id}: the visualiser's box is inside the safe area`);
      const p = project();
      const r = socialSequence(p, seqOf(p).id, tpl, {});
      const disk = JSON.parse(JSON.stringify(forDisk(r.project)));
      assert.deepEqual(JSON.parse(JSON.stringify(forDisk(parseProject(disk).project))), disk, `${tpl.id} round-trips`);
    }
  } finally { setVisualiserProvider(null); }
});

// ── look packs on the timeline ───────────────────────────────────────────────

test("a look goes first on the chosen clips, replaces a mood (and a mood replaces it), and Remove mood takes it off", () => {
  const p = project();
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 49 });
  s = put(p, s, "m2", 50, { in: 0, out: 49 });
  const ctx = ctxOf(p);
  const vid = s.clips.filter((c) => c.source.type === "media" && c.trackId === s.tracks.find((t) => t.kind === "video")!.id);
  const own = { id: "e_own", type: "gaussian_blur", enabled: true, params: { radius: { value: 3 } } };
  s = { ...s, clips: s.clips.map((c) => (c.id === vid[0].id ? { ...c, effects: [own] } : c)) };
  const look = lookById("vintage.super8")!;
  const r = applyLook(s, ctx, look, { kind: "clips", ids: [vid[0].id] }, 1);
  assert.equal(r.clips, 1);
  const c0 = r.seq.clips.find((c) => c.id === vid[0].id)!;
  assert.equal(clipMood(c0), "look.vintage.super8");
  assert.deepEqual(c0.effects.map((e) => e.type), [...look.effects.map((e) => e.type), "gaussian_blur"]);
  assert.equal(r.seq.clips.find((c) => c.id === vid[1].id)!.effects.length, 0, "other clips untouched");
  // a mood replaces the look, a look replaces the mood
  const m = applyMood(r.seq, ctx, moodById("noir")!, { kind: "sequence" }, { intensity: 1 });
  assert.equal(clipMood(m.seq.clips.find((c) => c.id === vid[0].id)!), "noir");
  const back = applyLook(m.seq, ctx, lookById("wedding.classic_bw")!, { kind: "sequence" }, 0.5);
  assert.equal(back.clips, 2);
  for (const c of back.seq.clips.filter((x) => vid.some((v) => v.id === x.id))) {
    assert.equal(clipMood(c), "look.wedding.classic_bw");
    assert.ok(!c.effects.some((e) => e.id.startsWith("mood:noir")), "the mood's effects are gone");
  }
  const half = back.seq.clips.find((c) => c.id === vid[1].id)!.effects.find((e) => e.type === "film_grain")!;
  assert.equal(half.params.amount.value, 0.1, "intensity scales the look");
  const off = removeMood(back.seq, ctx, { kind: "sequence" });
  assert.equal(off.clips, 2);
  assert.deepEqual(off.seq.clips.find((c) => c.id === vid[0].id)!.effects.map((e) => e.type), ["gaussian_blur"]);
  // titles and empty scopes are left alone
  assert.equal(applyLook(s, ctx, look, { kind: "clips", ids: [] }).clips, 0);
});

// ── the edit still round-trips ───────────────────────────────────────────────

test("an edit with look packs, pack titles and social templates round-trips through serialize", () => {
  let p: EditProject = project();
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  s = applyLook(s, ctxOf(p), lookById("cinematic.anamorphic")!, { kind: "sequence" }).seq;
  p = { ...p, sequences: [s] };
  for (const id of ["hook.top3", "end.two_videos", "compare.side", "countdown.launch", "quote.post"]) p = insertTemplate(p, s.id, SEQ_TEMPLATES.find((t) => t.id === id)!, 10, "flatten").project;
  p = socialSequence(p, s.id, SEQ_TEMPLATES.find((t) => t.id === "audiogram.vertical")!, { nest: true }).project;
  const disk = JSON.parse(JSON.stringify(forDisk(p)));
  const back = parseProject(disk);
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(JSON.parse(JSON.stringify(forDisk(back.project))), disk);
  assert.ok(back.project.sequences[0].clips.some((c) => c.effects.some((e) => e.id.startsWith("mood:look.cinematic.anamorphic"))));
  void media;
});
