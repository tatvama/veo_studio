/**
 * Home's one box: a pasted script is recognised (scene headings, NAME: lines, or simply a long piece of writing) and
 * counted, so it can be imported with the user's own words; a short idea keeps the "write it for me" path.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectScript, scriptTitle, withoutTitle } from "../scriptDetect.ts";

test("a short idea is an idea", () => {
  const g = detectScript("A young temple priest discovers the brass lamp moves by itself at night.");
  assert.equal(g.script, false);
  assert.equal(g.lines, 0);
});

test("a two-line idea that mentions scenes is still an idea", () => {
  assert.equal(detectScript("Scenes from a village fair.\nWarm, funny, 30 seconds.").script, false);
});

test("scene headings and dialogue make a script, counted", () => {
  const g = detectScript([
    "SCENE 1: INT. KITCHEN - MORNING",
    "Grandmother's sunlit kitchen.",
    "AJJI (proud): This recipe is fifty years old.",
    "VO: Some flavours never leave you.",
    "",
    "EXT. GARDEN - DAY",
    "RAVI: I can smell it from here!",
    "AJJI: Then come inside.",
  ].join("\n"));
  assert.equal(g.script, true);
  assert.equal(g.scenes, 2);
  assert.equal(g.lines, 4);
});

test("dialogue alone is a script of one scene", () => {
  const g = detectScript("MEERA: Where were you?\nRAVI: At the river.\nMEERA: All night?");
  assert.deepEqual(g, { script: true, scenes: 1, lines: 3 });
});

test("layout labels and sentences with colons are not speakers", () => {
  const g = detectScript("VISUAL: a lamp flickers\nMUSIC: soft veena\nNote to self: keep it short\nThe time: 9 pm");
  assert.equal(g.lines, 0);
});

test("a long piece of prose is read as a script (AI arranges it, keeping the words)", () => {
  const para = "The rain had not stopped for three days, and the village had gone quiet in a way it never did. ";
  const text = Array.from({ length: 8 }, () => para).join("\n");
  assert.equal(detectScript(text).script, true);
});

test("a title is taken from a short first line", () => {
  assert.equal(scriptTitle("The Brass Lamp\n\nSCENE 1: INT. TEMPLE - NIGHT"), "The Brass Lamp");
  assert.equal(scriptTitle("TITLE: The Lamp\nSCENE 1"), "The Lamp");
  assert.equal(scriptTitle("SCENE 1: INT. TEMPLE - NIGHT"), "");
  assert.equal(scriptTitle("RAVI: hello"), "");
});

test("the title line is not read as part of the story", () => {
  assert.equal(withoutTitle("The Brass Lamp\n\nSCENE 1: INT. TEMPLE - NIGHT\nRAVI: hi"), "SCENE 1: INT. TEMPLE - NIGHT\nRAVI: hi");
  assert.equal(withoutTitle("SCENE 1: INT. TEMPLE - NIGHT\nRAVI: hi"), "SCENE 1: INT. TEMPLE - NIGHT\nRAVI: hi");
});
