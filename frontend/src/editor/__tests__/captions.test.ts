import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultTitle } from "../model/defaults.ts";
import { addGenerated, ctxOf, razor, setSpeed, slipClip, trimClip } from "../model/ops.ts";
import type { KaraokeSpec, Sequence, TimelineClip } from "../model/types.ts";
import { on, project, seqOf, V } from "./fixtures.ts";

const WORDS = [{ start: 0, end: 0.4, text: "Hello" }, { start: 0.4, end: 0.8, text: "brave" }, { start: 0.8, end: 1.2, text: "new" }, { start: 1.2, end: 1.6, text: "world" }];

/** A 2 s karaoke caption (50 frames at 25 fps) on V2 at frame 0. */
function caption() {
  const p = project(); const ctx = ctxOf(p);
  const k: KaraokeSpec = { words: WORDS, color: "#ffffff", highlightColor: "#ffd166", mode: "word" };
  const s0 = seqOf(p);
  const r = addGenerated(s0, ctx, V(s0, 1).id, 0, 50, { type: "title", text: { ...defaultTitle("Hello brave new world"), karaoke: k } }, "Caption");
  return { ctx, s: r.seq, id: r.clipId };
}
const words = (c: TimelineClip) => (c.source.type === "title" ? c.source.text.karaoke!.words.map((w) => [w.text, w.start, w.end]) : []);
const clips = (s: Sequence) => on(s, V(s, 1).id);

test("trimming a caption's start moves its word times with it (and trimming back restores them)", () => {
  const { ctx, s, id } = caption();
  const t = trimClip(s, ctx, id, "start", 10);              // 0.4 s off the head
  const c = clips(t)[0];
  assert.equal(c.start, 10);
  assert.deepEqual(words(c), [["Hello", -0.4, 0], ["brave", 0, 0.4], ["new", 0.4, 0.8], ["world", 0.8, 1.2]]);
  const back = trimClip(t, ctx, id, "start", -10);
  assert.deepEqual(words(clips(back)[0]), WORDS.map((w) => [w.text, w.start, w.end]));
});

test("splitting a caption gives each half its words, timed from that half's start", () => {
  const { ctx, s, id } = caption();
  const r = razor(s, ctx, 22, { ids: [id] });               // the cut at 0.88 s, inside "new" (its middle is after it)
  const [l, rt] = clips(r);
  assert.deepEqual(words(l), [["Hello", 0, 0.4], ["brave", 0.4, 0.8]]);
  assert.deepEqual(words(rt), [["new", 0, 0.32], ["world", 0.32, 0.72]]);
  // a cut before a word's middle sends it right; after its middle it stays left, cut at the edit
  const r2 = razor(s, ctx, 23, { ids: [id] });              // 0.92 s
  assert.deepEqual(words(clips(r2)[1]).map((w) => w[0]), ["new", "world"]);
  const r3 = razor(s, ctx, 26, { ids: [id] });              // 1.04 s: "new" (middle 1.0) stays left, cut at 1.04
  assert.deepEqual(words(clips(r3)[0]).at(-1), ["new", 0.8, 1.04]);
  assert.deepEqual(words(clips(r3)[1]), [["world", 0.16, 0.56]]);
});

test("slipping a caption slides its words; a speed change scales them", () => {
  const { ctx, s, id } = caption();
  const sl = slipClip(s, ctx, id, 5);                       // 0.2 s later in the "source": the words come earlier
  assert.deepEqual(words(clips(sl)[0]), [["Hello", -0.2, 0.2], ["brave", 0.2, 0.6], ["new", 0.6, 1], ["world", 1, 1.4]]);
  assert.equal(clips(sl)[0].start, 0, "the caption stays in place");
  const slow = setSpeed(s, ctx, [id], 0.5, { ripple: true });
  assert.equal(clips(slow)[0].duration, 100);
  assert.deepEqual(words(clips(slow)[0]).at(-1), ["world", 2.4, 3.2]);
});
