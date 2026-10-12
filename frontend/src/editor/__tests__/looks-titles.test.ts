import assert from "node:assert/strict";
import { test } from "node:test";
import { countAt, drawTitle, karaokeAt, karaokeWordStyle, titleFrameKey, isExtendedTitle, visibleWords } from "../render/title.ts";
import { captionTrackFromSegments, segmentWords } from "../templates/captions.ts";
import { STICKERS, stickerSpec, templateSpec, TEMPLATE_CATEGORIES, titleTemplates } from "../templates/titles.ts";
import { insertTemplate, SEQ_TEMPLATES, socialSequence, isSlot } from "../templates/sequences.ts";
import { defaultTitle } from "../model/defaults.ts";
import type { KaraokeSpec } from "../model/types.ts";
import { project, seqOf } from "./fixtures.ts";

test("about 100 title templates, generated the same way every time", () => {
  const a = titleTemplates();
  assert.ok(a.length >= 100, `${a.length}`);
  assert.equal(new Set(a.map((t) => t.id)).size, a.length);
  for (const c of TEMPLATE_CATEGORIES) assert.ok(a.some((t) => t.category === c), c);
  assert.ok(a.filter((t) => t.category === "Lower thirds").length >= 30);
  // deterministic: same ids, same order, same specs
  assert.equal(a[0].id, "headline.clean.fade");
  assert.ok(a.some((t) => t.id === "headline.neon.flicker" && t.spec.look?.loop === "flicker"));
  assert.ok(a.some((t) => t.id === "lower.split.wipe"));
  assert.equal(JSON.stringify(a.map((t) => t.id)), JSON.stringify(titleTemplates().map((t) => t.id)));
  for (const t of a) assert.ok(isExtendedTitle(t.spec), t.id);
});

test("a template scales to the sequence and takes its fields", () => {
  const t = titleTemplates().find((x) => x.id === "lower.bar.rise")!;
  const s = templateSpec(t, 2160, { text: "Ravi", sub: "Editor" });
  assert.equal(s.text, "Ravi");
  assert.equal(s.look?.sub?.text, "Editor");
  assert.equal(s.size, t.spec.size * 2);
  assert.equal(s.template, "lower.bar.rise");
  assert.notEqual(t.spec.text, "Ravi");   // the catalogue isn't changed
  const st = stickerSpec(STICKERS.find((x) => x.id === "star")!, 1920, 1080);
  const [, , w, h] = st.box;
  assert.ok(Math.abs(w * 1920 - h * 1080) < 1, "square on screen");
});

const K: KaraokeSpec = { mode: "word", color: "#fff", highlightColor: "#ff0", words: [
  { start: 0.2, end: 0.6, text: "one" }, { start: 0.7, end: 1.1, text: "two" }, { start: 1.1, end: 1.6, text: "three" }] };

test("karaoke timing: the word being sung and its progress", () => {
  assert.deepEqual(karaokeAt(K, 0.1), { index: -1, progress: 0 });
  assert.equal(karaokeAt(K, 0.4).index, 0);
  assert.ok(Math.abs(karaokeAt(K, 0.4).progress - 0.5) < 1e-9);
  assert.equal(karaokeAt(K, 0.65).index, 0);   // between words the last one holds
  assert.equal(karaokeAt(K, 1.1).index, 2);    // a new word starts exactly at its start
  assert.deepEqual(karaokeAt(K, 2), { index: 3, progress: 1 });
  assert.equal(karaokeWordStyle(K, 1, 0.9).color, "#ff0");
  assert.equal(karaokeWordStyle(K, 0, 0.9).color, "#fff");
  const fill = { ...K, mode: "fill" as const };
  assert.equal(karaokeWordStyle(fill, 0, 0.9).fill, 1);
  assert.equal(karaokeWordStyle(fill, 1, 0.9).fill, 0.5);
  assert.equal(karaokeWordStyle(fill, 2, 0.9).fill, 0);
  const bounce = { ...K, mode: "bounce" as const };
  assert.ok(karaokeWordStyle(bounce, 1, 0.8).lift > 0);
  // the cached raster changes exactly when the highlight moves
  const spec = { ...defaultTitle("one two three"), animIn: "none" as const, animOut: "none" as const, karaoke: K };
  assert.equal(titleFrameKey(spec, 0.8, 3), titleFrameKey(spec, 0.9, 3));
  assert.notEqual(titleFrameKey(spec, 0.9, 3), titleFrameKey(spec, 1.2, 3));
  assert.equal(titleFrameKey({ ...defaultTitle("x"), animIn: "none", animOut: "none" }, 1, 3), "static");
});

test("captions from segments: short cues, word times from each cue's first frame, no overlaps", () => {
  const segs = [
    { start: 1, end: 3, text: "hello there my good friend how are you", words: [
      { start: 1, end: 1.2, text: "hello" }, { start: 1.25, end: 1.5, text: "there" }, { start: 1.55, end: 1.7, text: "my" }, { start: 1.75, end: 2, text: "good" },
      { start: 2.05, end: 2.3, text: "friend" }, { start: 2.35, end: 2.5, text: "how" }, { start: 2.55, end: 2.7, text: "are" }, { start: 2.75, end: 3, text: "you" }] },
    { start: 3.1, end: 4, text: "fine thanks" },
  ];
  const cues = captionTrackFromSegments(segs, { fps: 25, offset: 10, maxWords: 4, karaoke: "fill" });
  assert.deepEqual(cues.map((c) => c.text), ["hello there my good", "friend how are you", "fine thanks"]);
  assert.equal(cues[0].start, 275);   // (1 + 10) s at 25 fps
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i - 1].end <= cues[i].start);
  const k = cues[1].spec.karaoke!;
  assert.equal(k.mode, "fill");
  assert.ok(Math.abs(k.words[0].start - ((2.05 + 10) - cues[1].start / 25)) < 1e-6);
  assert.equal(cues[2].spec.karaoke!.words.length, 2);  // text without timings is spread over the segment
  assert.equal(segmentWords({ start: 0, end: 1, text: "a b", words: [{ start: 0, end: 1, text: "New York" }] }).length, 2);
  const plain = captionTrackFromSegments(segs, { fps: 25, karaoke: false });
  assert.equal(plain[0].spec.karaoke, undefined);
});

test("counters and the template library", () => {
  assert.equal(countAt({ from: 5, to: 0 }, 0, 5), 5);
  assert.equal(countAt({ from: 5, to: 0 }, 0.5, 5), 5);
  assert.equal(countAt({ from: 5, to: 0 }, 1.5, 5), 4);
  assert.equal(countAt({ from: 5, to: 0 }, 5, 5), 0);
  assert.equal(countAt({ from: 0, to: 10 }, 2.5, 10), 2);
  const p = project();
  const s = seqOf(p);
  const tpl = SEQ_TEMPLATES.find((t) => t.id === "intro.cinematic")!;
  const flat = insertTemplate(p, s.id, tpl, 25, "flatten", { title: "Hi" });
  const fs = seqOf(flat.project);
  assert.equal(fs.tracks.filter((t) => t.kind === "video").length, s.tracks.filter((t) => t.kind === "video").length + 3);
  assert.ok(fs.clips.some((c) => isSlot(c) && c.start === 25));
  assert.ok(fs.clips.some((c) => c.source.type === "title" && c.source.text.text === "Hi"));
  const nest = insertTemplate(p, s.id, tpl, 0, "nest");
  assert.equal(nest.project.sequences.length, 2);
  assert.equal(seqOf(nest.project).clips[0].source.type, "nested");
  const reel = socialSequence(p, s.id, SEQ_TEMPLATES.find((t) => t.id === "social.reel")!, { nest: true });
  const rs = reel.project.sequences.find((x) => x.id === reel.sequenceId)!;
  assert.deepEqual([rs.width, rs.height], [1080, 1920]);
  assert.ok(rs.clips.some((c) => c.source.type === "nested"));
  assert.equal(reel.project.activeSequenceId, rs.id);
});

test("karaoke words pushed outside the clip by a trim are hidden, not lost", () => {
  const s = { ...defaultTitle(), karaoke: { ...K, words: [{ text: "gone", start: -0.8, end: -0.2 }, ...K.words] } };
  const v = visibleWords(s, 10);
  assert.ok(v && v.karaoke);
  assert.equal(v.karaoke.words.length, K.words.length);
  assert.equal(s.karaoke.words.length, K.words.length + 1); // the clip keeps them
  assert.equal(visibleWords({ ...s, karaoke: { ...K, words: [{ text: "late", start: 12, end: 13 }] } }, 10), null);
  assert.equal(visibleWords(s, 10)?.karaoke?.words[0].text, K.words[0].text);
});

/** A 2D context that only measures (each character half the font size) and records nothing. */
function stubContext(): CanvasRenderingContext2D {
  let size = 10;
  const ctx: Record<string, unknown> = {
    set font(v: string) { size = Number(/(\d+)px/.exec(v)?.[1] ?? 10); }, get font() { return `${size}px x`; },
    measureText: (t: string) => ({ width: t.length * size * 0.5 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  return new Proxy(ctx, { get: (o, k) => (k in o ? o[k as string] : () => undefined), set: (o, k, v) => { o[k as string] = v; return true; } }) as unknown as CanvasRenderingContext2D;
}

test("a title reports the part of the canvas it drew (whole frame while it moves)", () => {
  const spec = { ...defaultTitle("one two three"), animIn: "none" as const, animOut: "none" as const, karaoke: K, box: [0.1, 0.7, 0.8, 0.2] as [number, number, number, number] };
  const b = drawTitle(stubContext(), spec, 1920, 1080, 1, 3);
  assert.ok(b && b[2] < 1920 && b[3] < 1080 && b[1] > 600, JSON.stringify(b));
  // a karaoke word change keeps about the same area (the sung word grows 8 %): only that part is uploaded
  const b2 = drawTitle(stubContext(), spec, 1920, 1080, 1.3, 3)!;
  assert.ok(Math.abs(b2[0] - b![0]) < 20 && Math.abs(b2[2] - b![2]) < 0.05 * b![2] && b2[3] < 1080 / 4, JSON.stringify(b2));
  const anim = { ...spec, look: { in: "slide_left", out: "fade" } };
  assert.deepEqual(drawTitle(stubContext(), anim, 1920, 1080, 0.1, 3), [0, 0, 1920, 1080]);
  assert.ok((drawTitle(stubContext(), anim, 1920, 1080, 1.5, 3) ?? [0, 0, 1920])[2] < 1920);
  assert.equal(drawTitle(stubContext(), { ...spec, karaoke: { ...K, words: [{ text: "late", start: 12, end: 13 }] } }, 1920, 1080, 1, 10), null);
});
