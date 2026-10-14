/**
 * The assistant tools' §15 additions (automation/bridge/catalog.ts): list_catalog's looks, audio_presets and sfx kinds,
 * add_sfx's choice of sound and its one undo step, apply_mood's look-pack ids and add_effect's "preset:<id>" chains.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addChainPreset, addLibrarySfx, catalogLine, catalogRows, chainEffects, chainPreset, CHAIN_PREFIX, moodOrLook, pickSfx } from "../../automation/bridge/catalog.ts";
import { CHAIN_PRESETS } from "../audiofx/registry.ts";
import { ctxOf, tracksOf } from "../model/ops.ts";
import type { EditorHost, EditProject } from "../model/types.ts";
import { LOOKS } from "../moods/packs/looks.ts";
import { RECORDED_SFX, SFX_PRESETS, SFX_TAGS, sfxSeconds } from "../sfx/index.ts";
import { MOODS } from "../../lib/moods.ts";
import { A, project, put, seqOf } from "./fixtures.ts";

test("list_catalog looks: every mood, then the 30 look-pack looks, searchable by pack", () => {
  const rows = catalogRows("looks");
  assert.equal(LOOKS.length, 30);
  assert.equal(rows.length, MOODS.length + 30);
  assert.deepEqual(rows.slice(0, MOODS.length).map((r) => r.id), MOODS.map((m) => m.id));
  assert.ok(rows.some((r) => r.id === "cinematic.teal_orange" && /Cinematic look pack/.test(r.group ?? "")));
  const wedding = catalogRows("looks", "wedding");
  assert.ok(wedding.length >= 5 && wedding.filter((r) => r.id.startsWith("wedding.")).length === LOOKS.filter((l) => l.pack === "wedding").length);
});

test("list_catalog audio_presets: the chain presets as preset:<id>, with their chains", () => {
  const rows = catalogRows("audio_presets");
  assert.equal(rows.length, CHAIN_PRESETS.length);
  assert.ok(rows.every((r) => r.id.startsWith(CHAIN_PREFIX)));
  const yt = rows.find((r) => r.id === "preset:youtube_voice");
  assert.ok(yt);
  assert.equal(yt.label, "YouTube voice");
  assert.equal(yt.params, "highpass → eq_param → compressor → deesser → limiter");
  assert.deepEqual(catalogRows("audio_presets", "voice").map((r) => r.id).sort(), CHAIN_PRESETS.filter((p) => /voice/i.test(p.id + p.name + p.group)).map((p) => `preset:${p.id}`).sort());
});

test("list_catalog sfx: every sound with its category and tags; a tag search finds the tagged ones", () => {
  const rows = catalogRows("sfx");
  // the generated sounds, then the recorded ones (Kenney CC0)
  assert.equal(rows.length, SFX_PRESETS.length + RECORDED_SFX.length);
  assert.deepEqual(rows.map((r) => r.tags), [...SFX_PRESETS.map((p) => p.tags), ...RECORDED_SFX.map((r) => r.tags)], "every sound keeps its tags");
  assert.deepEqual(rows.slice(SFX_PRESETS.length).map((r) => r.id), RECORDED_SFX.map((r) => r.id));
  assert.ok(rows.length > 100, `${rows.length} sounds`);
  for (const r of rows) assert.ok(r.group && Array.isArray(r.tags) && /^\d+(\.\d+)? s(, loops)?$/.test(r.params ?? ""), `${r.id}: ${r.params}`);
  const typing = catalogRows("sfx", "typing");
  assert.ok(typing.length >= 5);
  assert.ok(typing.every((r) => r.tags!.includes("typing") || /typing/i.test(r.id + r.label + r.group)));
  assert.match(catalogLine(typing[0]), /^\S+ — .+ \[.+\] \(.+\) \{.*typing.*\}$/);
});

test("add_sfx: a preset id, or a tag (the seed picks among the matches); errors name the catalogue", () => {
  const a = pickSfx("whoosh.fast");
  assert.deepEqual([a.preset.id, a.seed, a.among], ["whoosh.fast", 1, 1]);
  assert.equal(pickSfx("whoosh.fast", undefined, 9).seed, 9);
  const tagged = SFX_PRESETS.filter((p) => p.tags.includes("impact"));
  assert.ok(tagged.length > 2);
  assert.equal(pickSfx(undefined, "impact").preset.id, tagged[0].id, "no seed: the first with the tag");
  assert.equal(pickSfx(undefined, "Impact", 2).preset.id, tagged[2 % tagged.length].id);
  assert.equal(pickSfx(undefined, "impact", tagged.length + 1).preset.id, tagged[1].id, "wraps");
  assert.equal(pickSfx(undefined, "impact").among, tagged.length);
  for (const t of SFX_TAGS) assert.ok(pickSfx(undefined, t).preset.tags.includes(t), `tag ${t}`);
  assert.throws(() => pickSfx("whoosh.nope"), /list_catalog\(sfx\)/);
  assert.throws(() => pickSfx(undefined, "kazoo"), /tags: whoosh/);
  assert.throws(() => pickSfx(), /preset .* or tag/);
});

test("add_sfx: rendered, then the media, an SFX track and the clip in ONE undo step", async () => {
  let p: EditProject = project();
  const labels: string[] = [];
  const host: EditorHost = {
    project: () => p, sequence: () => p.sequences[0], selection: () => ({ clipIds: [], trackIds: [] }), playhead: () => 0, inOut: () => ({}),
    apply(label: string, mutate: (d: EditProject) => void) { const d = structuredClone(p); mutate(d); p = d; labels.push(label); },
    addMedia: () => [], path: () => "", toast: () => undefined,
  } as unknown as EditorHost;
  const r = await addLibrarySfx(host, { tag: "pop", at: 75, gainDb: -9, label: "Assistant: add_sfx" });
  assert.ok(r.clipId);
  assert.deepEqual(labels, ["Assistant: add_sfx"], "one undo step, labelled for the History panel");
  const s = p.sequences[0];
  const c = s.clips.find((x) => x.id === r.clipId)!;
  const t = s.tracks.find((x) => x.id === c.trackId)!;
  assert.deepEqual([t.kind, t.role, t.name, c.start, c.role, c.audio?.gain.value], ["audio", "sfx", "SFX", 75, "sfx", -9]);
  assert.equal(c.duration, Math.round(sfxSeconds(r.pick.preset.id) * s.fps));
  assert.equal(p.media.filter((m) => m.path === r.item.path).length, 1);
  assert.ok(tracksOf(s, "audio").length >= 1);
});

test("apply_mood: a mood id, a look-pack look id (also look.<id>), else null", () => {
  assert.equal(moodOrLook(MOODS[0].id)?.mood?.id, MOODS[0].id);
  assert.equal(moodOrLook("cinematic.teal_orange")?.look?.label, LOOKS.find((l) => l.id === "cinematic.teal_orange")!.label);
  const w = LOOKS.find((l) => l.pack === "wedding")!;
  assert.equal(moodOrLook(`look.${w.id}`)?.look?.id, w.id);
  assert.equal(moodOrLook("nope"), null);
});

test("add_effect preset:<id>: the chain's effects in order after the clip's own, new ids per clip", () => {
  const p = chainPreset("preset:phone_bandpass");
  assert.equal(chainPreset("phone_bandpass"), p);
  assert.throws(() => chainPreset("preset:nope"), /list_catalog\(audio_presets\)/);
  const es = chainEffects(p);
  assert.deepEqual(es.map((e) => e.type), p.effects.map((e) => `audio:${e.id}`));
  assert.equal(es[0].params.frequency.value, 300);
  assert.equal(new Set([...es, ...chainEffects(p)].map((e) => e.id)).size, es.length * 2, "fresh ids every time");
  const pr = project();
  const s0 = put(pr, seqOf(pr), "m1", 0);
  const id = s0.clips.find((c) => c.trackId === A(s0, 0).id)!.id;
  const own = s0.clips.find((c) => c.id === id)!.effects.length;
  const r = addChainPreset(s0, ctxOf(pr), [id], p);
  const c = r.seq.clips.find((x) => x.id === id)!;
  assert.equal(c.effects.length, own + p.effects.length);
  assert.deepEqual(c.effects.slice(own).map((e) => e.id), r.made.get(id));
});
