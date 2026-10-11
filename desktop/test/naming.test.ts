import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TEMPLATES, dedupe, fitName, planRenames, projectFolderName, renderTemplate, safeFileName, safePart, templateKeyForFolder,
} from "../src/main/naming.ts";

const take = { project: "Kaali", season: 1, episode: 2, cut: 3, scene: 1, shot: 3, kind: "video", lang: "", take: 2 };

test("default Takes template renders the series name", () => {
  assert.equal(renderTemplate(DEFAULT_TEMPLATES.Takes, take), "Kaali_S01E02_003_SC01_SH003_video_T02");
  assert.equal(renderTemplate(DEFAULT_TEMPLATES.Takes, { ...take, kind: "lipsync", lang: "kn" }), "Kaali_S01E02_003_SC01_SH003_lipsync_kn_T02");
});

test("zero padding, {_name} and empty tokens", () => {
  assert.equal(renderTemplate("{seq:04}", { seq: 7 }), "0007");
  assert.equal(renderTemplate("{seq:2}", { seq: 123 }), "123");
  assert.equal(renderTemplate("a{_lang}b", { lang: "" }), "ab");
  assert.equal(renderTemplate("a{_lang}b", { lang: "en" }), "a_enb");
  assert.equal(renderTemplate("a{_take:02}", { take: 3 }), "a_03");
  // an empty token between separators doesn't leave a double underscore
  assert.equal(renderTemplate(DEFAULT_TEMPLATES.Renders, { project: "Kaali", season: 1, episode: 2, lang: "", preset: "yt4k", version: 4 }),
    "Kaali_S01E02_yt4k_v004");
  // padding only applies to numbers
  assert.equal(renderTemplate("{code:05}", { code: "E02-SH03" }), "E02-SH03");
});

test("Windows-safe names", () => {
  assert.equal(safePart('A: "B"/C?'), "A-B-C");
  assert.equal(safePart("The Last  Light"), "The-Last-Light");
  assert.equal(safeFileName("name. "), "name");
  assert.equal(safeFileName("CON"), "_CON");
  assert.equal(safeFileName("nul.txt"), "_nul.txt");
  assert.equal(safeFileName("com1"), "_com1");
  assert.equal(safeFileName("<>"), "file");
  assert.equal(renderTemplate("{project}_x", { project: "Kaali: Part 1?" }), "Kaali-Part-1_x");
  assert.equal(projectFolderName("Kaali: The Return", 12), "Kaali_ The Return (#12)");
  assert.equal(projectFolderName("", 3), "Project (#3)");
});

test("path length stays under 240 by shortening the label, then the project", () => {
  const dir = `C:\\${"x".repeat(150)}`;
  const name = fitName("{project}_{label}_{seq:02}", { project: "P".repeat(60), label: "L".repeat(80), seq: 1 }, dir, ".mp4");
  assert.ok(dir.length + 1 + name.length + 4 <= 240, `too long: ${dir.length + 1 + name.length + 4}`);
  assert.ok(name.endsWith("_01"), name);
  assert.ok(name.startsWith("PPP"), name);
  // short enough already: untouched
  assert.equal(fitName("{label}", { label: "short" }, "C:\\lib", ".wav"), "short");
});

test("dedupe adds _2, _3 case-insensitively", () => {
  const out = dedupe([{ path: "Takes/a.mp4" }, { path: "Takes/A.mp4" }, { path: "Takes/a.mp4" }, { path: "Takes/b.mp4" }]);
  assert.deepEqual(out.map((x) => x.path), ["Takes/a.mp4", "Takes/A_2.mp4", "Takes/a_3.mp4", "Takes/b.mp4"]);
  assert.deepEqual(dedupe([{ path: "x.wav" }], ["X.wav"]).map((x) => x.path), ["x_2.wav"]);
});

test("folder → template key", () => {
  assert.equal(templateKeyForFolder("Takes"), "Takes");
  assert.equal(templateKeyForFolder("Audio/Voice"), "Audio");
  assert.equal(templateKeyForFolder("Audio/Music"), "Music");
  assert.equal(templateKeyForFolder("Bible/Props"), "Bible");
  assert.equal(templateKeyForFolder("Whatever"), "Media");
});

/** Simulate a plan on an in-memory folder and check no step ever overwrites another file. */
function simulate(files: Map<string, string>, plan: ReturnType<typeof planRenames>): Map<string, string> {
  const fs = new Map([...files].map(([k, p]) => [p.toLowerCase(), k]));
  for (const st of plan.steps) {
    const key = fs.get(st.from.toLowerCase());
    assert.equal(key, st.key, `step source ${st.from} should hold ${st.key}`);
    const at = fs.get(st.to.toLowerCase());
    assert.ok(at === undefined || at === st.key, `step ${st.from} → ${st.to} would overwrite ${at}`);
    fs.delete(st.from.toLowerCase());
    fs.set(st.to.toLowerCase(), st.key);
  }
  return new Map([...fs].map(([p, k]) => [k, p]));
}

test("planRenames: a swap goes through temporary names", () => {
  const current = [{ key: "A", path: "Takes/001.mp4" }, { key: "B", path: "Takes/002.mp4" }];
  const desired = [{ key: "A", path: "Takes/002.mp4" }, { key: "B", path: "Takes/001.mp4" }];
  const plan = planRenames(current, desired);
  assert.equal(plan.steps.filter((s) => s.phase === 1).length, 2);
  assert.equal(plan.moves.length, 2);
  const end = simulate(new Map(current.map((c) => [c.key, c.path])), plan);
  assert.equal(end.get("A"), "takes/002.mp4");
  assert.equal(end.get("B"), "takes/001.mp4");
});

test("planRenames: rotation, shifts, case-only and blocked moves", () => {
  const current = [{ key: "A", path: "T/1" }, { key: "B", path: "T/2" }, { key: "C", path: "T/3" }, { key: "D", path: "T/x" }, { key: "E", path: "T/keep" }];
  const desired = [{ key: "A", path: "T/2" }, { key: "B", path: "T/3" }, { key: "C", path: "T/1" }, { key: "D", path: "T/X" }, { key: "E", path: "T/keep" }];
  const plan = planRenames(current, desired);
  const end = simulate(new Map(current.map((c) => [c.key, c.path])), plan);
  assert.equal(end.get("A"), "t/2");
  assert.equal(end.get("C"), "t/1");
  assert.ok(plan.steps.some((s) => s.key === "D" && s.to === "T/X" && s.phase === 2), "case-only rename is direct");
  assert.ok(!plan.steps.some((s) => s.key === "E"), "unchanged file isn't touched");
  // a shift into free names needs no temporary step
  const shift = planRenames([{ key: "A", path: "T/1" }, { key: "B", path: "T/2" }], [{ key: "A", path: "T/2" }, { key: "B", path: "T/3" }]);
  simulate(new Map([["A", "T/1"], ["B", "T/2"]]), shift);
  // a target held by a file that stays put is blocked, not overwritten
  const blocked = planRenames([{ key: "A", path: "T/1" }, { key: "S", path: "T/2" }], [{ key: "A", path: "T/2" }]);
  assert.equal(blocked.blocked.length, 1);
  assert.equal(blocked.steps.length, 0);
});
