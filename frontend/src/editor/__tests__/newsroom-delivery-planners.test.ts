/**
 * News delivery planners (docs/EDITOR.md §16.11): seamless loop lengths and the seam check, batch from a
 * spreadsheet (mapping, values per field type, lengths, names, backgrounds), news shorts per rundown story and the
 * look preview reel.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { tracksOf } from "../model/ops.ts";
import type { Sequence, TimelineClip } from "../model/types.ts";
import { cellValue, guessMapping, parseNumber, parseSeconds, planBatch } from "../newsroom/delivery/batch.ts";
import { graphicsOf, placeGraphic } from "../newsroom/delivery/build.ts";
import { cycleFrames, findSeamless, findSeamlessAsync, frameDifference, loopLength, loopPeriods, loopStart, openReasons, planLoop, seamCheck } from "../newsroom/delivery/loops.ts";
import { planReel } from "../newsroom/delivery/reel.ts";
import { planShorts, storyValues, VERTICAL_CAPTION_BOX } from "../newsroom/delivery/shorts.ts";
import { BUILTIN_LOOKS } from "../newsroom/looks.ts";
import { anim, field, layer, rect, step, text, tpl } from "../newsroom/templates/kit.ts";
import type { GfxTemplate, RundownStory } from "../newsroom/types.ts";
import { media, project, put, seqOf } from "./fixtures.ts";
import { STRAP, TICKER } from "./newsroom-delivery-fixtures.ts";

const BUG = tpl({ id: "t.bug", name: "LIVE bug", category: "Bugs", role: "bug", seconds: 0, loop: true, timing: { in: 0.5, out: 0.3 },
  fields: [field.text("label", "Label", "LIVE")],
  designs: { "16:9": [rect("dot", [40, 40, 20, 20], { fill: "@live" }, { anim: anim(step("fade"), undefined, { kind: "blink", period: 1.2 }) }),
    layer("shine", "sweep", [0, 0, 200, 60], { period: 0.8 })] } });
const CARD = tpl({ id: "t.card", name: "Headline card", category: "Openers", role: "board", seconds: 3,
  fields: [field.text("title", "Title", "BIG STORY"), field.list("points", "Points")], designs: { "16:9": [text("t", [100, 400, 1700, 200], "{title}")] } });
const STINGER = tpl({ id: "t.sting", name: "Swipe", category: "Stingers", role: "wipe", seconds: 1.2, fields: [], designs: { "16:9": [rect("p", [0, 0, 1920, 1080])] } });
const BG = tpl({ id: "t.bg", name: "Waves", category: "Backgrounds", role: "background", seconds: 0, loop: true, fields: [], designs: { "16:9": [layer("bg", "bg", [0, 0, 1920, 1080], { period: 6 })] } });
const CLOCK = tpl({ id: "t.clock", name: "Clock", category: "Bugs", role: "bug", seconds: 0, loop: true, fields: [], designs: { "16:9": [layer("clock", "c", [0, 0, 100, 40])] } });
const gfxOf = (c: TimelineClip) => (c.source as { gfx: { template: string; values: Record<string, unknown>; look?: string } }).gfx;

// ── loops ──

test("loop periods from the design; one cycle of them all in frames; lengths in whole cycles", () => {
  assert.deepEqual(loopPeriods(BUG), [1.2, 0.8]);
  assert.equal(cycleFrames([1.2, 0.8], 25), 60, "1.2 s = 30 frames, 0.8 s = 20 frames → 60");
  assert.equal(cycleFrames([1.2], 29.97), 36, "35.96 frames counts as 36");
  assert.equal(cycleFrames([], 25), 1, "nothing loops: any length");
  assert.equal(cycleFrames([0.7], 25, 30), null, "0.7 s at 25 fps = 17.5 frames: 35 frames, longer than allowed");
  assert.deepEqual(loopLength(10, 25, 60), { frames: 240, seconds: 9.6, cycles: 4, cycle: 60, exact: true });
  assert.deepEqual(loopLength(1, 25, 60), { frames: 60, seconds: 2.4, cycles: 1, cycle: 60, exact: true });
  assert.equal(loopLength(10, 25, null).frames, 250);
  assert.equal(loopStart(BUG, 25), 13, "after the 0.5 s in phase (12.5 frames → 13)");
  assert.deepEqual(openReasons(TICKER), []);
  assert.deepEqual(openReasons(CLOCK), ["a clock counts on"]);
});

test("a loop plan: the graphic long enough, the range after its in phase, a colour under it when asked", () => {
  const plan = planLoop(BUG, { values: { label: "LIVE" } }, { seconds: 10, width: 1920, height: 1080, fps: 25, background: "#112233" });
  assert.deepEqual(plan.range, { in: 13, out: 253 });
  assert.equal(plan.length.frames, 240);
  const s = plan.sequence;
  const g = graphicsOf(s, "bug")[0];
  assert.ok(g.start === 0 && g.duration >= plan.range.out + 25, "a second past the loop");
  assert.equal(gfxOf(g).template, "t.bug");
  const v1 = tracksOf(s, "video").find((t) => !t.gfxRole)!;
  assert.equal((s.clips.find((c) => c.trackId === v1.id)!.source as { color: string }).color, "#112233");
  const clear = planLoop(BUG, { values: {} }, { seconds: 4, width: 1080, height: 1920, fps: 25 });
  assert.equal(clear.sequence.clips.length, 1, "on transparency: only the graphic");
  const fixed = planLoop(TICKER, { values: {} }, { seconds: 4, width: 1920, height: 1080, fps: 25, frames: 333 });
  assert.deepEqual([fixed.range.out - fixed.range.in, fixed.length.exact], [333, false]);
  const still = planLoop(STRAP, { values: {} }, { seconds: 3, width: 1920, height: 1080, fps: 25 });
  assert.deepEqual([still.still, still.length.frames, still.length.exact], [true, 75, true], "nothing moves once in: any length");
  const clock = planLoop(CLOCK, { values: {} }, { seconds: 3, width: 1920, height: 1080, fps: 25 });
  assert.deepEqual([clock.still, clock.length.exact, clock.open], [false, false, ["a clock counts on"]], "a clock can't be promised from its design");
});

test("the seam check compares the first frame with the one after the last; findSeamless finds a crawl's period", async () => {
  // a fake graphic: a bar crawling one pixel per frame across a 40-pixel strip that repeats (a 40-frame period)
  const draw = (t: number) => { const f = Math.round(t * 25); const px = new Uint8Array(40 * 4); px[((f % 40) * 4) + 3] = 255; return px; };
  assert.equal(seamCheck(draw, 5, 80, 25)!.ok, true);
  assert.equal(seamCheck(draw, 5, 70, 25)!.ok, false);
  assert.deepEqual(findSeamless(draw, 5, 25, 20, 60), { frames: 40, diff: 0 });
  assert.deepEqual(await findSeamlessAsync(draw, 5, 25, 20, 60, 7), { frames: 40, diff: 0 }, "in steps, the same answer");
  assert.equal(seamCheck(() => null, 0, 10, 25), null);
  assert.equal(frameDifference([0, 0, 0, 255], [0, 0, 0, 0]), 0.25);
  assert.equal(frameDifference([1], [1, 2]), 1);
});

// ── batch ──

const PERSON = tpl({ id: "t.person", name: "Guest", category: "Straps", role: "strap", seconds: 6,
  fields: [field.text("name", "Name", "Priya"), field.text("role", "Role / title", "Anchor"), field.number("votes", "Votes", 0), field.toggle("live", "Live"),
    field.list("points", "Key points"), field.choice("side", "Side", [{ value: "left", label: "Left" }, { value: "right", label: "Right" }]),
    field.image("photo", "Photo"), field.table("table", "Table", [])],
  designs: { "16:9": [text("n", [100, 800, 800, 80], "{name}")] } });

test("batch: columns found by name; cells turned into each field's kind of value", () => {
  assert.deepEqual(guessMapping(PERSON, ["NAME", "Role/Title", "Votes ", "Clip"]), { name: "NAME", role: "Role/Title", votes: "Votes " });
  assert.equal(parseSeconds("8"), 8);
  assert.equal(parseSeconds("8.5 s"), 8.5);
  assert.equal(parseSeconds("0:08"), 8);
  assert.equal(parseSeconds("1:02:03"), 3723);
  assert.equal(parseSeconds("eight"), null);
  assert.equal(parseNumber("₹ 1,23,456.5"), 123456.5);
  assert.equal(parseNumber("-"), null);
  const f = (id: string) => PERSON.fields.find((x) => x.id === id)!;
  const pics = [media("pic1", { kind: "image", name: "Priya Rao.jpg" })];
  assert.deepEqual(cellValue(f("votes"), "12,345"), { value: 12345 });
  assert.match(cellValue(f("votes"), "lots").problem!, /isn't a number/);
  assert.deepEqual(cellValue(f("live"), "Yes"), { value: true });
  assert.deepEqual(cellValue(f("live"), "no"), { value: false });
  assert.deepEqual(cellValue(f("points"), "One | Two\nThree"), { value: [{ text: "One" }, { text: "Two" }, { text: "Three" }] });
  assert.deepEqual(cellValue(f("side"), "RIGHT"), { value: "right" });
  assert.match(cellValue(f("side"), "up").problem!, /isn't one of Left, Right/);
  assert.deepEqual(cellValue(f("photo"), "priya rao", pics), { value: { mediaId: "pic1" } });
  assert.match(cellValue(f("photo"), "nobody.png", pics).problem!, /no picture called/);
  assert.deepEqual(cellValue(f("name"), "  "), {});
});

test("batch: one sequence per row, named by a column (unique), length per row, over a colour / a clip / nothing", () => {
  const p = project();
  const rows = [{ Name: "Asha", Role: "MLA", Len: "4" }, { Name: "", Role: "", Len: "" }, { Name: "Asha", Role: "Minister", Len: "soon" }, { Name: "Ravi", Role: "", Len: "0:12" }];
  const base = { template: PERSON, columns: ["Name", "Role", "Len"], rows, mapping: { name: "Name", role: "Role" }, nameColumn: "Name", lengthColumn: "Len", seconds: 6,
    width: 1920, height: 1080, fps: 25, media: p.media };
  const out = planBatch({ ...base, background: { kind: "color", color: "#003366" } });
  assert.deepEqual(out.map((r) => [r.index, r.name, r.seconds, r.frames]), [[0, "Asha", 4, 100], [2, "Asha_2", 6, 150], [3, "Ravi", 12, 300]]);
  assert.deepEqual(out[0].values, { name: "Asha", role: "MLA" });
  assert.deepEqual(out[2].values, { name: "Ravi" }, "an empty cell keeps the sample");
  assert.match(out[1].problems[0], /"soon" isn't a number of seconds/);
  const s0 = out[0].sequence;
  assert.equal(new Set(out.map((r) => r.sequence.id)).size, 3);
  assert.deepEqual(s0.clips.map((c) => c.source.type).sort(), ["color", "graphic"]);
  assert.equal(graphicsOf(s0, "strap")[0].duration, 100);
  const overClip = planBatch({ ...base, background: { kind: "media", mediaId: "m1", in: 0 } });
  assert.deepEqual(overClip[0].sequence.clips.map((c) => c.source.type).sort(), ["graphic", "media", "media"], "picture and sound");
  assert.match(overClip[2].problems.join(" "), /m1 is shorter than 12 s/);
  const alone = planBatch({ ...base, background: { kind: "transparent" }, nameColumn: undefined, nameBase: "Guest" });
  assert.deepEqual(alone.map((r) => r.name), ["Guest 1", "Guest 3", "Guest 4"]);
  assert.equal(alone[0].sequence.clips.length, 1);
});

// ── shorts ──

const stories = (): RundownStory[] => [
  { id: "st1", slug: "MUMBAI RAINS", headline: "Rains lash Mumbai", strap: "Local trains delayed", ticker: ["Schools shut"], start: 25, end: 75, location: "Mumbai" },
  { id: "st2", slug: "BUDGET", headline: "Budget today", start: 75, end: 100 },
  { id: "st3", slug: "LATER", headline: "Not built yet" },
];

test("story text fills a template by hints and names; the headline lands somewhere", () => {
  const s = stories()[0];
  assert.deepEqual(storyValues(STRAP, s), { headline: "Rains lash Mumbai", strap: "Local trains delayed" });
  assert.deepEqual(storyValues(TICKER, s), { items: [{ text: "Schools shut" }] });
  assert.deepEqual(storyValues(TICKER, { ...s, ticker: [] }, { tickerLines: ["Other story"] }), { items: [{ text: "Other story" }] });
  assert.deepEqual(storyValues(CARD, { ...s, points: ["a", "b"] }), { title: "Rains lash Mumbai", points: [{ text: "a" }, { text: "b" }] });
  const odd = tpl({ id: "t.odd", name: "Odd", category: "Straps", role: "strap", seconds: 5, fields: [field.text("x1", "Line A")], designs: {} });
  assert.deepEqual(storyValues(odd, s), { x1: "Rains lash Mumbai" });
});

test("shorts: the story's range after a headline card, a strap and ticker when it has none, captions moved with it", () => {
  const p = project();
  const src: Sequence = { ...put(p, seqOf(p), "m1", 0, { in: 0, out: 99 }), width: 1080, height: 1920 };
  const withStrap = placeGraphic(src, STRAP, 80, 15, { values: { headline: "own strap" } }).seq;
  const cue = (start: number, end: number, t: string) => ({ start, end, text: t, spec: { text: t, font: "Inter", size: 60, color: "#fff", weight: 700, align: "center" as const, box: [0, 0.8, 1, 0.1] as [number, number, number, number] } });
  const out = planShorts({ stories: stories(), source: { project: p, sequence: withStrap }, card: { seconds: 2, color: "#C8102E" }, strap: STRAP, ticker: TICKER,
    cues: [cue(10, 20, "before"), cue(30, 40, "in one"), cue(80, 90, "in two")] });
  assert.deepEqual(out.map((x) => [x.name, x.frames, x.parts.strap, x.parts.ticker, x.parts.captions]),
    [["MUMBAI RAINS_9x16", 100, "added", "added", 1], ["BUDGET_9x16", 75, "own", "added", 1], ["LATER_9x16", 0, "none", "none", 0]]);
  assert.match(out[2].problems[0], /Not on the timeline yet/);
  assert.equal(out[2].sequence, null);
  const s1 = out[0].sequence!;
  assert.deepEqual([s1.width, s1.height], [1080, 1920]);
  const pic = s1.clips.find((c) => c.source.type === "media")!;
  assert.deepEqual([pic.start, pic.duration, (pic.source as { in: number }).in], [50, 50, 25], "the story's 25..75 after a 2 s card");
  const card = s1.clips.filter((c) => c.start === 0 && c.source.type !== "graphic").map((c) => c.source.type).sort();
  assert.deepEqual(card, ["color", "title"], "no card template: the headline as a title on the look's colour");
  const strap = graphicsOf(s1, "strap")[0];
  assert.deepEqual([strap.start, strap.duration, gfxOf(strap).values.headline], [50, 50, "Rains lash Mumbai"]);
  assert.deepEqual([graphicsOf(s1, "ticker")[0].start, graphicsOf(s1, "ticker")[0].duration], [0, 100]);
  const caption = s1.clips.find((c) => c.source.type === "title" && c.start > 0)!;
  assert.deepEqual([caption.start, caption.duration], [55, 10], "30..40 → 55..65");
  assert.deepEqual((caption.source as { text: { box: number[] } }).text.box, VERTICAL_CAPTION_BOX);
  const withCard = planShorts({ stories: [stories()[1]], source: { project: p, sequence: src }, card: { seconds: 1, template: CARD, color: "#000" } });
  const c = graphicsOf(withCard[0].sequence!, "board")[0];
  assert.deepEqual([c.start, c.duration, gfxOf(c).values.title], [0, 25, "Budget today"]);
});

// ── reel ──

test("the look preview reel: a title card per category, each graphic for its time (stingers their own), the backdrop not under the backgrounds", () => {
  const look = BUILTIN_LOOKS[1];
  const templates: GfxTemplate[] = [STRAP, { ...STRAP, id: "t.strap2", name: "Strap 2" }, TICKER, BUG, STINGER, BG];
  const r = planReel({ look, templates, perCategory: 0, seconds: 4, titleSeconds: 2, width: 1920, height: 1080, fps: 25 });
  assert.deepEqual(r.items.map((x) => [x.category, x.template, x.start, x.frames]), [
    ["Bugs", "t.bug", 50, 100], ["Straps", "t.strap", 200, 100], ["Straps", "t.strap2", 300, 100], ["Tickers", "t.ticker", 450, 100],
    ["Stingers", "t.sting", 600, 30], ["Backgrounds", "t.bg", 680, 100]]);
  const s = r.sequence;
  const titles = s.clips.filter((c) => c.source.type === "title").map((c) => [(c.source as { text: { text: string } }).text.text, c.start]);
  assert.deepEqual(titles, [["Bugs", 0], ["Straps", 150], ["Tickers", 400], ["Stingers", 550], ["Backgrounds", 630]]);
  assert.deepEqual(graphicsOf(s, "background").map((c) => [c.start, c.duration, c.name]), [[0, 680, "Backdrop"], [680, 100, "Waves"]],
    "the backdrop runs up to the Backgrounds, which are the picture there");
  assert.ok(s.clips.filter((c) => c.source.type === "graphic").every((c) => gfxOf(c).look === look.id), "in the chosen look");
  assert.deepEqual(gfxOf(graphicsOf(s, "strap")[0]).values, { headline: "Sample headline", strap: "Sample line" }, "sample text");
  assert.deepEqual(Object.keys(r.templates).sort(), ["t.bg", "t.bug", "t.sting", "t.strap", "t.strap2", "t.ticker"]);
  const few = planReel({ look, templates, perCategory: 1, categories: ["Straps"], seconds: 3, titleSeconds: 0, width: 1080, height: 1920, fps: 25, backdrop: "color" });
  assert.deepEqual(few.items.map((x) => x.template), ["t.strap"]);
  assert.equal(few.sequence.clips.find((c) => c.source.type === "color")!.duration, 75);
});
