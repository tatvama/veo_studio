/**
 * News Room automation (docs/EDITOR.md §16.10): speaker runs from transcript words, speaker labels matched to people,
 * strap templates by kind, the dry run (gaps, repeats, short runs, unknown speakers, straps placed by hand) and placing
 * them (re-running replaces, never doubles); AI-media ranges (merged, hidden tracks left out, nested sequences looked
 * into), labels on their own track, labels placed by hand respected.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addGenerated, ctxOf } from "../model/ops.ts";
import type { EditProject, Sequence } from "../model/types.ts";
import type { PlacedWord, Transcript } from "../panels/TranscriptOps.ts";
import { AI_LABEL_TRACK, aiLabels, aiRanges, applyAiLabels, mergeRanges, subtractRanges } from "../newsroom/auto/aiLabels.ts";
import { applySpeakerStraps, personFor, personValues, speakerRuns, speakerStraps, strapTemplateFor } from "../newsroom/auto/speakers.ts";
import { aiLabelTemplate, autoClips } from "../newsroom/auto/tags.ts";
import { field, rect, text, tpl } from "../newsroom/templates/kit.ts";
import type { GfxInstance, GfxTemplate, Person } from "../newsroom/types.ts";
import { media, project, put, V } from "./fixtures.ts";

const strap = (id: string, kind: string): GfxTemplate => tpl({ id, name: kind[0].toUpperCase() + kind.slice(1), category: "Straps", role: "strap", kind, seconds: 6, hold: "auto",
  fields: [field.text("name", "Name", "Priya Rao", { fill: "person.name", required: true }), field.text("role", "Role", "Anchor", { fill: "person.role" }),
    field.text("place", "Place", "", { fill: "place" }), field.image("photo", "Photo", { fill: "person.photo" })],
  designs: { "16:9": [rect("plate", [120, 820, 760, 90], { fill: "@primary" }), text("name", [150, 820, 700, 56], "{name}", { size: 52 })] } });
const AI = tpl({ id: "nr.straps.ai_label", name: "AI-generated label", category: "Straps", role: "strap", kind: "ai_label", seconds: 0,
  fields: [field.text("text", "Text", "AI-GENERATED")], designs: { "16:9": [text("t", [1500, 60, 320, 40], "{text}", { size: 28 })] } });
const TEMPLATES = [strap("nr.straps.anchor", "anchor"), strap("nr.straps.reporter", "reporter"), strap("nr.straps.guest", "guest"), AI];

const PEOPLE: Person[] = [
  { id: "p1", name: "Priya Rao", role: "Anchor", kind: "anchor", speaker: "SPEAKER_00" },
  { id: "p2", name: "Dr Arjun Mehta", role: "Cardiologist, AIIMS", kind: "expert", speaker: "Speaker 2", location: "New Delhi", photo: { mediaId: "still" } },
  { id: "p3", name: "Kavya", role: "Reporter", kind: "reporter", names: { hi: "काव्या" } },
];

function newsEdit(): EditProject {
  const p = project();
  p.newsroom = { version: 1, look: "look.classic_red", looks: {}, templates: Object.fromEntries(TEMPLATES.map((t) => [t.id, t])), ratio: "16:9", rundown: [],
    people: PEOPLE.map((x) => ({ ...x })), places: [], sources: [], data: {}, settings: { safeGuides: true, collision: true, readSpeed: 3, tickerSpeed: "normal", aiLabel: true } };
  return p;
}

let k = 0;
/** Words for a speaker from a to b seconds (25 fps frames), one per half second. */
const said = (speaker: string | undefined, a: number, b: number): PlacedWord[] =>
  Array.from({ length: Math.max(1, Math.round((b - a) * 2)) }, (_, i) => ({ key: `w${k++}`, text: "word", from: Math.round((a + i / 2) * 25), to: Math.round((a + i / 2 + 0.45) * 25), clipId: "c", trackId: "t", ...(speaker ? { speaker } : {}), filler: false }));

test("speaker runs: by label, broken by other speakers, unlabelled words and long pauses", () => {
  const w = [...said("A", 0, 5), ...said("B", 5.5, 8), ...said(undefined, 8, 9), ...said("B", 9.2, 12), ...said("A", 12.2, 13), ...said("A", 20, 22)];
  const r = speakerRuns(w, 25);
  assert.deepEqual(r.map((x) => [x.speaker, Math.round((x.from / 25) * 10) / 10, Math.round(x.to / 25)]), [["A", 0, 5], ["B", 5.5, 12], ["A", 12.2, 22]]);
});

test("people, templates and values", () => {
  const p = newsEdit();
  assert.equal(personFor(PEOPLE, " speaker_00 ")?.id, "p1");
  assert.equal(personFor(PEOPLE, "Kavya")?.id, "p3", "by name when there's no label");
  assert.equal(personFor(PEOPLE, "काव्या")?.id, "p3");
  assert.equal(personFor(PEOPLE, "Speaker 9"), undefined);
  assert.equal(strapTemplateFor(p, "anchor")?.id, "nr.straps.anchor");
  assert.equal(strapTemplateFor(p, "expert")?.id, "nr.straps.guest", "experts use the guest strap when there's no expert strap");
  assert.equal(strapTemplateFor(p, "reporter", "nr.straps.guest")?.id, "nr.straps.guest", "a preferred template wins");
  assert.equal(strapTemplateFor(p, undefined)?.id, "nr.straps.guest");
  const t = strapTemplateFor(p, "expert")!;
  assert.deepEqual(personValues(t, PEOPLE[1]), { name: "Dr Arjun Mehta", role: "Cardiologist, AIIMS", place: "New Delhi", photo: { mediaId: "still" } });
  assert.deepEqual(personValues(t, PEOPLE[2], "hi"), { name: "काव्या", role: "Reporter" });
  assert.equal(aiLabelTemplate(p)?.id, AI.id);
});

const strapsOn = (s: Sequence) => s.clips.filter((c) => s.tracks.find((t) => t.id === c.trackId)?.gfxRole === "strap");
const gfx = (c: { source: unknown }) => (c.source as { gfx: GfxInstance }).gfx;

test("speaker straps: the dry run, placing, and re-running replaces them", () => {
  const p = newsEdit();
  const seqId = p.sequences[0].id;
  const words = [
    ...said("SPEAKER_00", 0, 10),       // Priya: strap
    ...said("Speaker 2", 10.5, 20),     // Arjun: strap
    ...said("SPEAKER_00", 21, 24),      // Priya again within 90 s: no
    ...said("Speaker 3", 25, 30),       // nobody: no
    ...said("SPEAKER_00", 30.5, 31.5),  // too short: no
    ...said("Speaker 2", 200, 212),     // Arjun after 3 minutes: strap
  ];
  const plan = speakerStraps(p, seqId, { words });
  assert.deepEqual(plan.items.map((i) => [i.name, i.at, i.template]), [
    ["Priya Rao", 10, "nr.straps.anchor"], ["Dr Arjun Mehta", 273, "nr.straps.guest"], ["Dr Arjun Mehta", 5010, "nr.straps.guest"]]);
  // reading time (4 s at least; more words, longer), never past the speaker's turn
  assert.equal(plan.items[0].duration, 100);
  assert.equal(plan.items[1].duration, 108);
  assert.deepEqual(plan.items[0].values, { name: "Priya Rao", role: "Anchor" });
  assert.deepEqual(plan.unmatched, ["Speaker 3"]);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ["Priya Rao was named a moment ago", "Nobody in People has this speaker label", "Speaks too briefly"]);
  assert.deepEqual(plan.replaced, []);
  const ids = applySpeakerStraps(p, seqId, plan);
  assert.equal(ids.length, 3);
  let s = p.sequences[0];
  assert.deepEqual(strapsOn(s).map((c) => [c.start, c.duration, gfx(c).values._auto, gfx(c).values.name]).sort((a, b) => Number(a[0]) - Number(b[0])),
    [[10, 100, "speaker", "Priya Rao"], [273, 108, "speaker", "Dr Arjun Mehta"], [5010, 108, "speaker", "Dr Arjun Mehta"]]);
  // a strap placed by hand at 200 s; the speaker becomes someone else; run again
  const manual = addGenerated(s, ctxOf(p), strapsOn(s)[0].trackId, 4990, 150, { type: "graphic", gfx: { template: "nr.straps.reporter", values: { name: "By hand" } } }, "By hand");
  p.sequences[0] = manual.seq;
  p.newsroom!.people[0].speaker = "Speaker 3";
  const again = speakerStraps(p, seqId, { words });
  assert.equal(again.replaced.length, 2, "the hand-placed strap overwrote the third");
  assert.ok(again.skipped.some((x) => x.reason === "A strap placed by hand is already there"));
  applySpeakerStraps(p, seqId, again);
  s = p.sequences[0];
  assert.equal(autoClips(s, "speaker").length, again.items.length);
  assert.ok(s.clips.some((c) => c.id === manual.clipId), "the hand-placed strap is kept");
  assert.deepEqual(autoClips(s, "speaker").map((c) => gfx(c).values.name).sort(), ["Dr Arjun Mehta", "Priya Rao"]);
});

test("speaker straps from the Transcript panel's transcripts (source seconds → timeline)", () => {
  const p = newsEdit();
  let s = put(p, p.sequences[0], "m1", 50, { in: 25 });
  p.sequences[0] = s;
  const tr: Transcript = { mediaId: "m1", source: "whisper", words: [
    ...Array.from({ length: 10 }, (_, i) => ({ start: 1 + i * 0.5, end: 1.4 + i * 0.5, text: "hello", speaker: "SPEAKER_00" })),
  ] };
  const plan = speakerStraps(p, s.id, { transcripts: { m1: tr } });
  // media second 1 is source frame 25 = the clip's first frame (timeline 50); plus the 0.4 s lead
  assert.deepEqual(plan.items.map((i) => i.at), [60]);
});

test("AI media ranges: merged, hidden tracks and audio left out, nested sequences looked into", () => {
  const p = newsEdit();
  p.media.push(media("ai1", { path: "studio:shots/abc.mp4" }), media("ai2", { path: "studio:shots/def.png", kind: "image", duration: 0, fps: 0, hasAudio: false }));
  let s = p.sequences[0];
  s = put(p, s, "ai1", 0, { in: 0, out: 99 });
  s = put(p, s, "ai2", 110, undefined, 0, 0, false);
  s = { ...s, clips: s.clips.map((c) => (c.start === 110 ? { ...c, duration: 90 } : c)) };
  s = put(p, s, "m1", 200, { in: 0, out: 99 });
  // on a hidden track: not on screen
  s = put(p, s, "ai1", 400, { in: 0, out: 49 }, 1, 1);
  s = { ...s, tracks: s.tracks.map((t) => (t.id === V(s, 1).id ? { ...t, hidden: true } : t)) };
  p.sequences[0] = s;
  // a nested sequence with AI media at its frames 0..50, used from frame 25 at 500
  const inner: Sequence = { ...structuredClone(p.sequences[0]), id: "inner", name: "Inner", clips: [], transitions: [] };
  p.sequences.push(inner);
  p.sequences[1] = put(p, inner, "ai1", 0, { in: 0, out: 49 });
  p.sequences[0] = addGenerated(p.sequences[0], ctxOf(p), V(p.sequences[0], 2).id, 500, 100, { type: "nested", sequenceId: "inner", in: 25 }, "Nested").seq;
  assert.deepEqual(aiRanges(p, p.sequences[0].id).map((r) => [r.from, r.to, r.mediaIds.join("+")]), [[0, 200, "ai1+ai2"], [500, 525, "ai1"]]);
  assert.deepEqual(aiRanges(p, p.sequences[0].id, { join: 0 }).map((r) => [r.from, r.to]), [[0, 100], [110, 200], [500, 525]]);
  assert.deepEqual(mergeRanges([{ from: 5, to: 9 }, { from: 0, to: 4 }], 1), [{ from: 0, to: 9 }]);
  assert.deepEqual(subtractRanges([{ from: 0, to: 100 }], [{ from: 20, to: 30 }, { from: 90, to: 120 }]), [{ from: 0, to: 20 }, { from: 30, to: 90 }]);
});

test("AI labels: on their own track, hand-placed labels respected, re-running replaces", () => {
  const p = newsEdit();
  p.media.push(media("ai1", { path: "studio:abc" }));
  let s = put(p, p.sequences[0], "ai1", 0, { in: 0, out: 199 });
  s = put(p, s, "ai1", 300, { in: 0, out: 99 });
  p.sequences[0] = s;
  const seqId = s.id;
  const plan = aiLabels(p, seqId);
  assert.equal(plan.template, AI.id);
  assert.deepEqual(plan.items, [{ from: 0, to: 200 }, { from: 300, to: 400 }]);
  applyAiLabels(p, seqId, plan);
  s = p.sequences[0];
  const track = s.tracks.find((t) => t.name === AI_LABEL_TRACK)!;
  assert.equal(track.gfxRole, "strap");
  const straps = s.tracks.find((t) => t.gfxRole === "strap" && t.name !== AI_LABEL_TRACK)!;
  assert.ok(track.index > straps.index, "above the Straps track");
  assert.deepEqual(autoClips(s, "ai-label").map((c) => [c.trackId, c.start, c.duration]), [[track.id, 0, 200], [track.id, 300, 100]]);
  // a label placed by hand over the first range; run again
  const hand = addGenerated(s, ctxOf(p), straps.id, 0, 200, { type: "graphic", gfx: { template: AI.id, values: {} } }, "AI label");
  p.sequences[0] = hand.seq;
  const again = aiLabels(p, seqId);
  assert.equal(again.replaced.length, 2);
  assert.deepEqual(again.items, [{ from: 300, to: 400 }]);
  applyAiLabels(p, seqId, again);
  s = p.sequences[0];
  assert.deepEqual(autoClips(s, "ai-label").map((c) => [c.start, c.duration]), [[300, 100]]);
  assert.equal(s.tracks.filter((t) => t.name === AI_LABEL_TRACK).length, 1, "the track is reused");
  // no template: nothing is placed, earlier automatic labels still go
  delete p.newsroom!.templates[AI.id];
  const none = aiLabels(p, seqId);
  if (!none.template) {
    applyAiLabels(p, seqId, none);
    assert.equal(autoClips(p.sequences[0], "ai-label").length, 0);
  }
});
