/**
 * Auto SFX (frontend/src/editor/autosfx, docs/EDITOR.md §15.2): each rule on fixture sequences, the density cap, the
 * intensity gains, ducking under speech, determinism, a re-run replacing (not doubling) its sounds, the user's own SFX
 * left alone, ONE undo step, and auto edit's punch-ins getting swishes. The SFX library is a fixture of our own and the
 * planner picks by tag, so the real library's ids can change freely.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAutoEdit } from "../../automation/autoedit/executor.ts";
import { planAutoEdit } from "../../automation/autoedit/planner.ts";
import type { MediaAnalysis, PlanMedia } from "../../automation/autoedit/types.ts";
import { applyAutoSfx, clearSfxCache, projectHost, removeAutoSfxCommand } from "../autosfx/apply.ts";
import { buildAutoSfx, removeAutoSfx, sfxKey } from "../autosfx/build.ts";
import { titleTiming, transitionKind } from "../autosfx/events.ts";
import { hash32, INTENSITY_DB, MIN_GAP_S, planAutoSfx, RULES, TAKES } from "../autosfx/planner.ts";
import type { AutoSfxPlan, SfxPlacement } from "../autosfx/types.ts";
import { SFX_PRESETS } from "../sfx/index.ts";
import { baseClip, defaultTitle, newProject } from "../model/defaults.ts";
import { seedIds } from "../model/ids.ts";
import { addTrack, addTransition, ctxOf, normalize, seqEnd, tracksOf } from "../model/ops.ts";
import { insertFreeze } from "../model/retime.ts";
import { parseProject } from "../model/serialize.ts";
import type { EditProject, MediaItem, Sequence, TimelineClip, TitleSpec } from "../model/types.ts";
import { STICKERS, stickerSpec } from "../templates/titles.ts";
import { CATALOG, calls, fakeAddSfx, historyHost, qaEdit } from "./autosfx-fixtures.ts";
import { A, project, put, seqOf, V } from "./fixtures.ts";

const FPS = 25;
const plan = (p: EditProject, o: Parameters<typeof planAutoSfx>[2] = {}) => planAutoSfx(p.sequences[0], p, { catalog: CATALOG, ...o });
const of = (pl: AutoSfxPlan, rule: string) => pl.placements.filter((x) => x.rule === rule);
const preset = (id: string) => CATALOG.find((x) => x.id === id)!;
const sec = (f: number) => f / FPS;

/** A one-clip-per-call builder for small sequences: m1/m2 alternating on V1, back to back, 4 s each. */
function threeCuts(): { p: EditProject; s: Sequence } {
  const p = project();
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  s = put(p, s, "m2", 100, { in: 0, out: 99 });
  s = put(p, s, "m1", 200, { in: 100, out: 199 });
  return { p, s };
}
const withSeq = (p: EditProject, s: Sequence): EditProject => ({ ...p, sequences: [s, ...p.sequences.slice(1)] });
const titleClip = (s: Sequence, track: number, start: number, dur: number, spec: TitleSpec, name = "Title"): TimelineClip =>
  baseClip(s, V(s, track).id, start, dur, { type: "title", text: spec }, name);

// ── each rule ────────────────────────────────────────────────────────────────

test("transitions: a whoosh centred on the cut, its length = the transition + 0.2 s", () => {
  const { p, s: s0 } = threeCuts();
  const s = addTransition(s0, ctxOf(p), V(s0, 0).id, 100, "gl:cube", 20).seq;
  const pl = plan(withSeq(p, s));
  const [w] = of(pl, "transitions");
  assert.ok(w, "a whoosh");
  assert.ok(preset(w.presetId).tags.includes("whoosh"));
  assert.equal(w.values.length, 1, "0.8 s transition + 0.2 s");
  assert.equal(w.hit, 100);
  assert.equal(w.align, "centre");
  assert.equal(w.at, 100 - Math.floor(w.duration / 2));
  assert.equal(w.duration, 25);
  assert.match(w.reason, /gl:cube \(0\.8 s\): a whoosh centred on the cut/);
  // a dissolve gets a softer whoosh, 3 dB down
  const d = plan(withSeq(p, addTransition(s0, ctxOf(p), V(s0, 0).id, 100, "dissolve", 10).seq));
  assert.equal(of(d, "transitions")[0].gainDb, INTENSITY_DB.normal - 3);
  assert.equal(of(d, "transitions")[0].values.length, 0.6);
  // a fade from black at a clip's edge has nothing to whoosh between
  const e = plan(withSeq(p, addTransition(s0, ctxOf(p), V(s0, 0).id, 0, "fade", 10, { side: "to" }).seq));
  assert.equal(of(e, "transitions").length, 0);
  assert.match(e.skipped.find((x) => x.rule === "transitions")!.reason, /clip's edge/);
  // audio crossfades make no sound
  const a = plan(withSeq(p, addTransition(s0, ctxOf(p), A(s0, 0).id, 100, "audio:constant_power", 10).seq));
  assert.equal(a.placements.length, 0);
});

test("stingers and tv: wipes: a whoosh plus a soft impact at the cover point", () => {
  const { p, s: s0 } = threeCuts();
  const s = addTransition(s0, ctxOf(p), V(s0, 0).id, 200, "tv:matte_linear", 20).seq;
  const pl = plan(withSeq(p, s));
  const st = of(pl, "stingers");
  assert.equal(st.length, 2);
  const w = st.find((x) => preset(x.presetId).tags.includes("whoosh"))!, i = st.find((x) => preset(x.presetId).tags.includes("impact"))!;
  assert.equal(w.hit, 200);
  assert.equal(w.values.length, 1);
  // a luma wipe covers the frame when it finishes (frame 210); a soft one (the "soft" variant), 4 dB down
  assert.equal(i.hit, 209);
  assert.equal(i.presetId, "t.impact.soft");
  assert.equal(i.gainDb, INTENSITY_DB.normal - 4);
  // a stinger covers in the middle (or where its params say)
  const sg = plan(withSeq(p, addTransition(s0, ctxOf(p), V(s0, 0).id, 200, "stinger:panels", 20).seq));
  assert.equal(of(sg, "stingers").find((x) => x.align === "start")!.hit, 200);
  assert.equal(transitionKind("tv:matte_clock"), "wipe");
  assert.equal(transitionKind("tv:whip_left"), "move");
  assert.equal(transitionKind("tv:vhs_tracking"), "glitch");
  assert.equal(transitionKind("tv:tv_off"), "tape");
  assert.equal(transitionKind("fadeblack"), "soft");
});

test("titles: pop or swish in, a reverse swish out, a typing burst for typewriters", () => {
  const { p, s: s0 } = threeCuts();
  const slide: TitleSpec = { ...defaultTitle("Asha Rao"), animIn: "none", animOut: "none", look: { in: "slide_left", out: "wipe", inDur: 0.6, outDur: 0.4 } };
  const pop: TitleSpec = { ...defaultTitle("Big News"), animIn: "pop", animOut: "fade" };
  const typed: TitleSpec = { ...defaultTitle("Hello world, again"), animIn: "typewriter", animOut: "none" };
  const faded: TitleSpec = { ...defaultTitle("Quiet"), animIn: "fade", animOut: "fade" };
  const s = normalize({ ...s0, clips: [...s0.clips, titleClip(s0, 1, 20, 100, slide, "Lower"), titleClip(s0, 2, 140, 50, pop, "Pop"), titleClip(s0, 1, 150, 100, typed, "Typed"),
    titleClip(s0, 2, 260, 30, faded, "Faded")] }, ctxOf(p));
  const pl = plan(withSeq(p, s));
  const t = of(pl, "titles");
  const lowerIn = t.find((x) => x.hit === 20)!;
  assert.ok(preset(lowerIn.presetId).tags.includes("swish"), "slide in → swish");
  assert.equal(lowerIn.align, "start");
  assert.equal(lowerIn.values.length, 0.7, "the in-animation + 0.1 s");
  const lowerOut = t.find((x) => x.hit === 120)!;
  assert.equal(lowerOut.presetId, "t.reverse", "out → a reverse swish");
  assert.equal(lowerOut.align, "end");
  assert.equal(lowerOut.at + lowerOut.duration, 120, "it ends with the title");
  assert.ok(preset(t.find((x) => x.hit === 140)!.presetId).tags.includes("pop"), "pop in → pop");
  const ty = t.find((x) => x.hit === 150)!;
  const tm = titleTiming(typed, 4);
  assert.equal(ty.presetId, "t.typing");
  assert.equal(ty.values.keys, 16, "one key per character (no spaces)");
  assert.equal(ty.values.length, Math.round(tm.inDur * 10) / 10);
  assert.ok(ty.duration <= Math.round((tm.inDur + 0.12) * FPS), "no longer than the typing");
  assert.equal(t.filter((x) => x.hit === 260).length, 0, "a fade makes no sound");
  assert.match(pl.skipped.find((x) => x.sourceId === s.clips.find((c) => c.name === "Faded")!.id)!.reason, /no sound for a fade/);
});

test("stickers: a pop, the click of subscribe and like, a ding for the bell", () => {
  const { p, s: s0 } = threeCuts();
  const st = (id: string) => stickerSpec(STICKERS.find((x) => x.id === id)!, 1920, 1080);
  const s = normalize({ ...s0, clips: [...s0.clips, titleClip(s0, 1, 10, 100, st("subscribe"), "Sub"), titleClip(s0, 2, 150, 50, st("emoji-0"), "Emoji"),
    titleClip(s0, 2, 220, 50, st("bell"), "Bell")] }, ctxOf(p));
  const pl = plan(withSeq(p, s));
  const k = of(pl, "stickers");
  assert.deepEqual(k.map((x) => [x.hit, x.presetId]), [[10, "t.pop"], [10 + Math.round((0.5 + 0.75) * FPS), "t.click"], [150, "t.pop"], [220, "t.ding"]]);
});

test("countdowns: a tick on every number and a boom when it reaches zero", () => {
  const { p, s: s0 } = threeCuts();
  const count: TitleSpec = { ...defaultTitle("#"), animIn: "none", animOut: "none", look: { in: "pop", out: "fade", count: { from: 5, to: 0 } } };
  const s = normalize({ ...s0, clips: [...s0.clips, titleClip(s0, 1, 50, 125, count, "Count")] }, ctxOf(p));
  const pl = plan(withSeq(p, s));
  const c = of(pl, "countdowns");
  assert.deepEqual(c.filter((x) => x.presetId === "t.tick").map((x) => x.hit), [50, 75, 100, 125, 150], "5, 4, 3, 2, 1: one a second");
  const boom = c.find((x) => preset(x.presetId).tags.includes("boom"))!;
  assert.equal(boom.hit, 175, "zero: the end of the countdown");
  assert.equal(boom.gainDb, INTENSITY_DB.normal + 2);
  assert.equal(of(pl, "titles").length, 0, "no title pop on top of the ticks");
  // a fast counter (30 → 0 in 5 s) still ticks about once a second
  const fast: TitleSpec = { ...count, look: { ...count.look, count: { from: 30, to: 0 } } };
  const f = plan(withSeq(p, normalize({ ...s0, clips: [...s0.clips, titleClip(s0, 1, 50, 125, fast, "Fast")] }, ctxOf(p))));
  const ticks = of(f, "countdowns").filter((x) => x.presetId === "t.tick");
  assert.ok(ticks.length >= 5 && ticks.length <= 6, `${ticks.length} ticks`);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].hit - ticks[i - 1].hit >= Math.round(0.9 * FPS));
});

test("punch-in jump cuts: a subtle swish where the picture punches in", () => {
  const p = project();
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  s = put(p, s, "m1", 100, { in: 100, out: 199 });
  s = put(p, s, "m1", 200, { in: 200, out: 249 });
  s = put(p, s, "m2", 250, { in: 0, out: 49 });
  s = { ...s, clips: s.clips.map((c) => (c.trackId === V(s, 0).id && c.start === 100 ? { ...c, motion: { ...c.motion, scale: { value: 112 } } } : c)) };
  const pl = plan(withSeq(p, s));
  const k = of(pl, "punch_ins");
  // 100 → 112 at 4 s and 112 → 100 at 8 s; the cut to other media at 10 s is not a jump cut
  assert.deepEqual(k.map((x) => x.hit), [100, 200]);
  assert.ok(k.every((x) => preset(x.presetId).tags.includes("swish") && x.gainDb === INTENSITY_DB.normal - 6 && x.values.length === 0.35));
  assert.match(k[0].reason, /100 % → 112 %/);
});

test("speed ramps: a riser over the ramp-in and an impact at full slow; freezes get a shutter", () => {
  const f = qaEdit();
  const s = f.sequences[0];
  const mid = s.clips.find((c) => c.trackId === V(s, 0).id && c.start === 100)!;
  const ks = mid.timeRemap!.keyframes!;
  const fullSlow = mid.start + ks[1].frame;
  const pl = planAutoSfx(s, f, { catalog: CATALOG });
  const r = of(pl, "speed_ramps");
  const riser = r.find((x) => x.presetId === "t.riser")!, hit = r.find((x) => x.presetId !== "t.riser")!;
  assert.equal(riser.align, "end");
  assert.equal(riser.hit, fullSlow);
  assert.equal(riser.at + riser.duration, fullSlow, "the riser ends at full slow");
  assert.ok(riser.values.length >= 0.5);
  assert.equal(hit.hit, fullSlow);
  assert.ok(preset(hit.presetId).tags.includes("impact"));
  // a frame hold in the last clip
  const last = s.clips.find((c) => c.trackId === V(s, 0).id && c.start === 200)!;
  const fz = insertFreeze(s, ctxOf(f), last.id, 240, 25);
  const pf = planAutoSfx(fz, f, { catalog: CATALOG });
  const sh = of(pf, "freeze_frames");
  assert.equal(sh.length, 1);
  assert.equal(sh[0].hit, 240);
  assert.equal(sh[0].presetId, "t.shutter");
});

test("camera shake → a boom as it starts; glitch and VHS effects or glitch transitions → glitch, tape noise or a tape stop", () => {
  const { p, s: s0 } = threeCuts();
  const ctx = ctxOf(p);
  let s = addTransition(s0, ctx, V(s0, 0).id, 0, "tv:shake", 10, { side: "to" }).seq;
  s = addTransition(s, ctx, V(s, 0).id, 100, "tv:rgb_split", 10).seq;
  s = addTransition(s, ctx, V(s, 0).id, 200, "tv:tv_off", 10).seq;
  const pl = plan(withSeq(p, s));
  const boom = of(pl, "shake")[0];
  assert.equal(boom.hit, 0);
  assert.ok(preset(boom.presetId).tags.includes("boom"));
  const g = of(pl, "glitch");
  assert.equal(g.find((x) => x.hit === 100)!.presetId, "t.glitch");
  const tape = g.find((x) => x.presetId === "t.tape")!;
  assert.equal(tape.align, "end");
  assert.equal(tape.hit, 200, "the tape stops as the picture goes off");
  // effects on clips: a glitch, a VHS look, a camera-shake effect (each where it starts, not where it carries on)
  const fx = (type: string) => ({ id: `e_${type}`, type, enabled: true, params: {} });
  const s2 = { ...s0, clips: s0.clips.map((c) => (c.trackId !== V(s0, 0).id ? c : c.start === 0 ? { ...c, effects: [fx("glitch")] } : c.start === 100 ? { ...c, effects: [fx("vhs")] }
    : { ...c, effects: [fx("vhs"), fx("camera_shake")] })) };
  const p2 = plan(withSeq(p, s2));
  assert.deepEqual(of(p2, "glitch").map((x) => [x.hit, x.presetId]), [[0, "t.glitch"], [100, "t.static"]]);
  assert.match(p2.skipped.find((x) => x.rule === "glitch")!.reason, /carries on from the clip before/);
  assert.deepEqual(of(p2, "shake").map((x) => x.hit), [200]);
});

test("beat markers (opt-in): hits on the strong beats only, capped", () => {
  const { p, s: s0 } = threeCuts();
  const beats = Array.from({ length: 48 }, (_, i) => ({ id: `b${i}`, frame: i * 6, duration: 0, name: "Beat", color: "#fbbf24", kind: "beat" as const }));
  const s = { ...s0, markers: beats };
  assert.equal(of(plan(withSeq(p, s)), "beats").length, 0, "off by default");
  const on = plan(withSeq(p, s), { rules: { beats: true } });
  const hits = of(on, "beats");
  // no waveform to judge them by: the downbeats (every 4th beat, 0.96 s apart → a second or more apart: every other one)
  assert.ok(hits.length > 0 && hits.every((x) => beats.findIndex((b) => b.frame === x.hit) % 4 === 0));
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i].hit - hits[i - 1].hit >= FPS, "at least a second apart");
  // 48 s of beats under a 48 s matte
  const long = normalize({ ...s, clips: [...s.clips, baseClip(s, V(s, 2).id, 0, 1200, { type: "color", color: "#000000" }, "Matte")] }, ctxOf(p));
  const subtle = plan(withSeq(p, { ...long, markers: Array.from({ length: 200 }, (_, i) => ({ ...beats[0], id: `x${i}`, frame: i * 6 })) }), { rules: { beats: true }, intensity: "subtle" });
  assert.equal(of(subtle, "beats").length, 8, "capped at subtle intensity");
});

test("nested sequences (templates inserted nested): their events land where the clip shows them", () => {
  const { p, s: outer } = threeCuts();
  seedIds(11);
  const inner = normalize({ ...newProject("x", { width: 1920, height: 1080, fps: 25 }).sequences[0], name: "Intro" }, ctxOf(p));
  const pop: TitleSpec = { ...defaultTitle("Hi"), animIn: "pop", animOut: "none" };
  const innerS = normalize({ ...inner, clips: [titleClip(inner, 1, 30, 50, pop, "Hi")] }, ctxOf(p));
  const nested = baseClip(outer, V(outer, 2).id, 120, 60, { type: "nested", sequenceId: innerS.id, in: 10 }, "Intro");
  const s = normalize({ ...outer, clips: [...outer.clips, nested] }, ctxOf({ ...p, sequences: [outer, innerS] }));
  const pp: EditProject = { ...p, sequences: [s, innerS] };
  const t = of(planAutoSfx(s, pp, { catalog: CATALOG }), "titles");
  assert.deepEqual(t.map((x) => x.hit), [120 + 20], "inner frame 30, clip in 10, clip at 120");
});

// ── across the rules ─────────────────────────────────────────────────────────

test("density cap: never two sounds of different events within 0.4 s; the higher-priority rule wins", () => {
  const f = qaEdit();
  const pl = planAutoSfx(f.sequences[0], f, { catalog: CATALOG });
  const gap = MIN_GAP_S * FPS;
  const ev = (x: SfxPlacement) => x.id.split(":").slice(0, 2).join(":");
  for (const a of pl.placements) for (const b of pl.placements) {
    if (a !== b && ev(a) !== ev(b)) assert.ok(Math.abs(a.hit - b.hit) >= gap, `${a.id} @${a.hit} vs ${b.id} @${b.hit}`);
  }
  // the subscribe click (3.64 s) comes 0.36 s before the whoosh of the cut at 4 s: the transition keeps its whoosh
  const sk = pl.skipped.find((x) => x.rule === "stickers")!;
  assert.match(sk.reason, /Within 0\.4 s of .* \(transitions come first\)/);
  assert.ok(of(pl, "transitions").length === 1);
  // a title that pops in on a cut loses to the cut's whoosh
  const { p, s: s0 } = threeCuts();
  const s = normalize({ ...addTransition(s0, ctxOf(p), V(s0, 0).id, 100, "gl:cube", 20).seq,
    clips: [...addTransition(s0, ctxOf(p), V(s0, 0).id, 100, "gl:cube", 20).seq.clips, titleClip(s0, 1, 105, 50, { ...defaultTitle("On the cut"), animIn: "pop", animOut: "none" })] }, ctxOf(p));
  const q = plan(withSeq(p, s));
  assert.equal(of(q, "transitions").length, 1);
  assert.equal(of(q, "titles").length, 0);
  assert.equal(RULES[0].id, "stingers");
});

test("intensity sets the levels (−24 / −18 / −12 dB plus each rule's offset) and the variants", () => {
  const f = qaEdit();
  for (const [i, db] of Object.entries(INTENSITY_DB) as [keyof typeof INTENSITY_DB, number][]) {
    const pl = planAutoSfx(f.sequences[0], f, { catalog: CATALOG, intensity: i });
    assert.equal(pl.intensity, i);
    assert.equal(of(pl, "transitions")[0].gainDb, db);
    assert.equal(of(pl, "titles").find((x) => x.presetId === "t.typing")!.gainDb, db - 4);
    assert.equal(of(pl, "shake")[0].gainDb, db + 1);
  }
  // punchy picks the heavy whoosh and turns the boom's punch up; subtle the soft ones and down
  const { p, s: s0 } = threeCuts();
  const s = addTransition(s0, ctxOf(p), V(s0, 0).id, 100, "gl:cube", 20).seq;
  const punchy = of(plan(withSeq(p, s), { intensity: "punchy" }), "transitions")[0];
  const subtle = of(plan(withSeq(p, s), { intensity: "subtle" }), "transitions")[0];
  assert.equal(punchy.presetId, "t.whoosh.heavy");
  assert.match(subtle.presetId, /t\.whoosh\.(air|soft)/);
  const boom = (i: "subtle" | "punchy") => planAutoSfx(f.sequences[0], f, { catalog: CATALOG, intensity: i }).placements.find((x) => x.presetId === "t.boom")!.values.punch;
  assert.ok(boom("punchy") > 0.5 && boom("subtle") < 0.5);
});

test("dialogue: 6 dB lower while speech plays (dialogue clips, or the speech found by the silence analysis)", () => {
  const { p, s: s0 } = threeCuts();
  let s = addTransition(s0, ctxOf(p), V(s0, 0).id, 100, "gl:cube", 20).seq;
  s = addTransition(s, ctxOf(p), V(s, 0).id, 200, "fade", 20).seq;
  // A1 (the clips' own sound) is dialogue
  s = { ...s, tracks: s.tracks.map((t) => (t.id === A(s, 0).id ? { ...t, role: "dialogue" as const } : t)) };
  const pl = plan(withSeq(p, s));
  assert.ok(pl.placements.length === 2 && pl.placements.every((x) => x.ducked));
  assert.equal(of(pl, "transitions")[0].gainDb, INTENSITY_DB.normal - 6);
  // the analysis says speech stops at 6 s: the cut at 8 s is in a pause
  const an = plan(withSeq(p, s), { speech: [{ from: 0, to: 150 }] });
  assert.deepEqual(an.placements.map((x) => [x.hit, x.ducked]), [[100, true], [200, false]]);
  assert.equal(an.placements[1].gainDb, INTENSITY_DB.normal - 3);
  // no dialogue: nothing ducks
  assert.ok(plan(withSeq(p, { ...s, tracks: s0.tracks })).placements.every((x) => !x.ducked));
});

test("deterministic: the same plan every run, seeded from the sequence id plus the event id", () => {
  const f = qaEdit();
  const a = planAutoSfx(f.sequences[0], f, { catalog: CATALOG });
  const b = planAutoSfx(structuredClone(f.sequences[0]), structuredClone(f), { catalog: CATALOG });
  assert.deepEqual(a, b);
  // (a countdown's numbered ticks share one sound: "…:tick3" is seeded as "…:tick")
  for (const x of a.placements) assert.equal(x.seed, 1 + (hash32(`${f.sequences[0].id}|${x.id.replace(/\d+$/, "")}`) % TAKES));
  const ticks = of(a, "countdowns").filter((x) => x.presetId === "t.tick");
  assert.ok(ticks.length > 1 && ticks.every((x) => x.seed === ticks[0].seed), "the same tick every second");
  // another sequence (same content, another id) rolls other takes
  const c = planAutoSfx({ ...f.sequences[0], id: "s_other" }, f, { catalog: CATALOG });
  assert.notDeepEqual(c.placements.map((x) => x.seed), a.placements.map((x) => x.seed));
  assert.deepEqual(c.placements.map((x) => x.hit), a.placements.map((x) => x.hit));
});

// ── applying ─────────────────────────────────────────────────────────────────

const autoClips = (p: EditProject) => p.sequences[0].clips.filter((c) => c.autoSfx);

test("apply: ONE undo step with the media; a re-run replaces instead of doubling; undo restores the edit", async () => {
  clearSfxCache();
  calls.length = 0;
  const f = qaEdit();
  const host = historyHost(f);
  const pl = planAutoSfx(host.sequence(), host.project(), { catalog: CATALOG });
  const r = await applyAutoSfx(host, pl, { addSfxMedia: fakeAddSfx });
  assert.equal(host.history().past.length, 1, "one command");
  assert.equal(host.history().past[0].label, "Auto SFX");
  assert.equal(r.placed, pl.placements.length);
  const distinct = new Set(pl.placements.map(sfxKey)).size;
  assert.equal(calls.length, distinct, "each distinct sound rendered once");
  assert.equal(r.rendered, distinct);
  const p1 = host.project();
  const sfx = tracksOf(p1.sequences[0], "audio").filter((t) => t.role === "sfx");
  assert.ok(sfx.length >= 1 && sfx[0].name === "SFX", "an SFX track (role sfx)");
  assert.equal(autoClips(p1).length, pl.placements.length);
  assert.ok(p1.media.filter((m) => m.path.startsWith("/edit/Audio/SFX/")).length === distinct, "the sounds were imported in the same step");
  for (const c of autoClips(p1)) {
    const x = pl.placements.find((y) => y.sourceId === c.autoSfx!.sourceId && y.rule === c.autoSfx!.rule && Math.abs(y.hit - (y.align === "start" ? c.start : y.align === "end" ? c.start + c.duration : c.start + Math.floor(c.duration / 2))) <= 1)!;
    assert.ok(x, `placement for ${c.name} @${c.start}`);
    assert.equal(c.audio!.gain.value, x.gainDb);
    assert.equal(c.role, "sfx");
  }
  // no two sounds overlap on one track (the SFX 2 lane takes the overlaps)
  for (const t of sfx) {
    const cs = p1.sequences[0].clips.filter((c) => c.trackId === t.id).sort((a, b) => a.start - b.start);
    for (let i = 1; i < cs.length; i++) assert.ok(cs[i].start >= cs[i - 1].start + cs[i - 1].duration);
  }
  // run it again: the same sounds, not twice as many, and nothing rendered again
  const again = planAutoSfx(host.sequence(), host.project(), { catalog: CATALOG });
  assert.equal(again.replaces, pl.placements.length);
  await applyAutoSfx(host, again, { addSfxMedia: fakeAddSfx });
  assert.equal(host.history().past.length, 2);
  assert.equal(autoClips(host.project()).length, pl.placements.length);
  assert.equal(calls.length, distinct, "cached");
  assert.equal(host.project().media.length, p1.media.length, "no media twice");
  // undo twice: the edit exactly as it was
  host.undo(); host.undo();
  assert.deepEqual(host.project(), f);
});

test("the user's own sound effects are never touched", async () => {
  clearSfxCache();
  const { p, s: s0 } = threeCuts();
  let s = addTransition(s0, ctxOf(p), V(s0, 0).id, 100, "gl:cube", 20).seq;
  const r = addTrack(s, "audio");
  s = { ...r.seq, tracks: r.seq.tracks.map((t) => (t.id === r.trackId ? { ...t, name: "SFX", role: "sfx" as const } : t)) };
  const boom: MediaItem = { id: "mine", binId: null, name: "my boom.wav", kind: "audio", path: "/m/boom.wav", duration: 96000, fps: 48000, width: 0, height: 0, hasAudio: true, markers: [] };
  const p1: EditProject = { ...p, media: [...p.media, boom] };
  const mine = { ...baseClip(s, r.trackId, 90, 50, { type: "media", mediaId: "mine", in: 0 }, "My boom"), role: "sfx" as const };
  s = normalize({ ...s, clips: [...s.clips, mine] }, ctxOf(p1));
  const host = historyHost(withSeq(p1, s));
  await applyAutoSfx(host, planAutoSfx(host.sequence(), host.project(), { catalog: CATALOG }), { addSfxMedia: fakeAddSfx });
  const after = host.project().sequences[0];
  assert.deepEqual(after.clips.find((c) => c.id === mine.id), s.clips.find((c) => c.id === mine.id), "the user's clip is as it was");
  const w = after.clips.find((c) => c.autoSfx)!;
  assert.equal(after.tracks.find((t) => t.id === w.trackId)!.name, "SFX 2", "the whoosh went round it");
  // removing the auto sounds keeps it too
  assert.equal(removeAutoSfxCommand(host), 1);
  assert.ok(host.project().sequences[0].clips.some((c) => c.id === mine.id));
  assert.equal(host.project().sequences[0].clips.filter((c) => c.autoSfx).length, 0);
  assert.equal(host.history().past.length, 2);
});

test("a range: only sounds in it are placed and replaced; the dialog's checkboxes keep some", async () => {
  clearSfxCache();
  const f = qaEdit();
  const host = historyHost({ ...f, sequences: [{ ...f.sequences[0], inPoint: 90, outPoint: 230 }] });
  const all = planAutoSfx(host.sequence(), host.project(), { catalog: CATALOG });
  await applyAutoSfx(host, all, { addSfxMedia: fakeAddSfx });
  const io = planAutoSfx(host.sequence(), host.project(), { catalog: CATALOG, range: "inout" });
  assert.deepEqual(io.range, { from: 90, to: 231 });
  assert.ok(io.placements.every((x) => x.hit >= 90 && x.hit < 231));
  const keep = io.placements.slice(0, 2).map((x) => x.id);
  await applyAutoSfx(host, io, { addSfxMedia: fakeAddSfx, only: keep });
  const left = autoClips(host.project());
  const outside = all.placements.filter((x) => x.at + x.duration <= 90 || x.at >= 231).length;
  assert.ok(left.length <= outside + 2 && left.length >= 2, `${left.length} clips`);
  assert.ok(left.filter((c) => c.start < 231 && c.start + c.duration > 90).length >= 2);
});

test("build: a sound that would start before 0 is trimmed at the head; the rendered length wins", () => {
  const f = qaEdit();
  const pl = planAutoSfx(f.sequences[0], f, { catalog: CATALOG });
  const m = (sec: number): MediaItem => ({ id: `x${sec}`, binId: null, name: "x.wav", kind: "audio", path: `/x${sec}.wav`, duration: Math.round(sec * 48000), fps: 48000, width: 0, height: 0, hasAudio: true, markers: [] });
  const items = [m(3), m(0.4)];
  const p = { ...f, media: [...f.media, ...items] };
  const centred: SfxPlacement = { ...pl.placements[0], id: "t1", hit: 5, align: "centre", trim: false, duration: 75 };
  const r = buildAutoSfx(p, { ...pl, placements: [centred] }, () => items[0]);
  const c = r.project.sequences[0].clips.find((x) => x.autoSfx)!;
  assert.equal(c.start, 0);
  assert.equal(c.duration, 75 - (37 - 5), "3 s of sound, its first 32 frames before 0 cut off");
  assert.equal(c.source.type === "media" && c.source.in, Math.round(((37 - 5) * 48000) / FPS));
  assert.ok(c.audio!.fadeIn >= 1);
  assert.equal(removeAutoSfx(r.project, f.sequences[0].id).removed, 1);
  // a whoosh asked for 1 s whose file rings on for 3 s: centred on its 1 s, the tail plays after
  const whoosh: SfxPlacement = { ...centred, id: "w", hit: 100, duration: 25 };
  const rw = buildAutoSfx(p, { ...pl, placements: [whoosh] }, () => items[0]).project.sequences[0].clips.find((x) => x.autoSfx)!;
  assert.deepEqual([rw.start, rw.duration], [100 - 12, 75]);
  // a boom's long tail: a sound a second and a half later cuts it (with a fade) instead of opening another lane;
  // one inside the boom's first second goes on SFX 2
  const boom: SfxPlacement = { ...pl.placements[0], id: "b", hit: 25, align: "start", trim: false, duration: 75, fadeOut: 0 };
  const late: SfxPlacement = { ...boom, id: "late", hit: 25 + 38, duration: 10 };
  const early: SfxPlacement = { ...boom, id: "early", hit: 25 + 12, duration: 10 };
  const r2 = buildAutoSfx(p, { ...pl, placements: [boom, late, early] }, (x) => (x.id === "late" ? items[1] : items[0]));
  const cs = r2.project.sequences[0].clips.filter((x) => x.autoSfx).sort((a, b) => a.start - b.start);
  const lanes = (id: string) => r2.project.sequences[0].tracks.find((t) => t.id === id)!.name;
  assert.deepEqual(cs.map((x) => [x.start, lanes(x.trackId)]), [[25, "SFX"], [37, "SFX 2"], [63, "SFX"]]);
  assert.equal(cs[0].duration, 38, "the boom's tail ends where the later sound starts");
  assert.ok(cs[0].audio!.fadeOut >= 6, "with a fade");
});

test("auto SFX never makes the sequence longer: tails stop at its end with a fade, nothing starts at the very end", async () => {
  clearSfxCache();
  const f = qaEdit();
  const end = seqEnd(f.sequences[0]);
  const pl = planAutoSfx(f.sequences[0], f, { catalog: CATALOG });
  // the countdown is the last thing in the edit: it reaches zero as the sequence ends, so there's no boom
  assert.ok(pl.skipped.some((x) => x.rule === "countdowns" && /very end/.test(x.reason)));
  const host = historyHost(f);
  await applyAutoSfx(host, planAutoSfx(host.sequence(), host.project(), { catalog: CATALOG }), { addSfxMedia: fakeAddSfx });
  const s = host.project().sequences[0];
  assert.equal(seqEnd(s), end, "as long as before");
  const last = s.clips.filter((c) => c.autoSfx).sort((a, b) => b.start + b.duration - (a.start + a.duration))[0];
  assert.ok(last.start + last.duration <= end);
});

test("auto edit: punch-ins get swishes (the 'Add sound effects' option)", async () => {
  clearSfxCache();
  const item = (id: string, name: string, seconds: number): MediaItem => ({ id, binId: null, name, kind: "video", path: `/shoot/${name}`, duration: Math.round(seconds * FPS), fps: FPS,
    width: 1920, height: 1080, hasAudio: true, markers: [], seconds });
  const media = [item("m1", "vlog_001.mp4", 20)];
  const pm = (m: MediaItem): PlanMedia => ({ id: m.id, name: m.name, kind: m.kind, duration: m.seconds ?? 0, hasAudio: true, width: 1920, height: 1080, path: m.path });
  const an: MediaAnalysis[] = [{ mediaId: "m1", name: "m1", kind: "video", hasAudio: true, width: 1920, height: 1080, duration: 20, silences: [{ start: 3, end: 5 }, { start: 10, end: 11.5 }] }];
  seedIds(7);
  const p0 = { ...newProject("Vlog", { width: 1920, height: 1080, fps: FPS }), media };
  const ae = planAutoEdit(media.map(pm), an, { style: "talking_head", folder: "Vlog", fps: FPS, sfx: "normal" });
  assert.equal(ae.sfx, "normal", "the plan carries the option");
  assert.ok(ae.segments.some((s) => s.scale === 112), "the vlog has punch-ins");
  const built = buildAutoEdit(p0, ae);
  const s = built.project.sequences.find((x) => x.id === built.sequenceId)!;
  const pl = planAutoSfx(s, built.project, { catalog: CATALOG, intensity: ae.sfx });
  const swishes = of(pl, "punch_ins");
  const punches = ae.segments.filter((x, i) => i > 0 && x.mediaId === ae.segments[i - 1].mediaId && (x.scale ?? 100) !== (ae.segments[i - 1].scale ?? 100)).length;
  assert.equal(swishes.length, punches);
  assert.ok(swishes.length >= 1);
  // the vlog's own sound is dialogue: the swishes sit 6 dB lower under it
  assert.ok(swishes.every((x) => x.ducked && x.gainDb === INTENSITY_DB.normal - 6 - 6));
  // and it goes onto the new edit in one step (an edit that isn't open yet: a plain project host)
  const host = projectHost(built.project, "/edits/Vlog.tatvamedit", { sequenceId: built.sequenceId });
  await applyAutoSfx(host, pl, { addSfxMedia: fakeAddSfx });
  assert.equal(host.current().sequences.find((x) => x.id === built.sequenceId)!.clips.filter((c) => c.autoSfx).length, pl.placements.length);
  assert.equal(seqEnd(host.current().sequences.find((x) => x.id === built.sequenceId)!), seqEnd(s), "nothing moved");
});

test("autoSfx survives save and open; a malformed one is dropped", () => {
  const f = qaEdit();
  const s = f.sequences[0];
  const c = s.clips[0];
  const p = { ...f, sequences: [{ ...s, clips: s.clips.map((x) => (x.id === c.id ? { ...x, autoSfx: { rule: "transitions", sourceId: "t_1" } } : x)) }] };
  const back = parseProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(back.project.sequences[0].clips.find((x) => x.id === c.id)!.autoSfx, { rule: "transitions", sourceId: "t_1" });
  const raw = JSON.parse(JSON.stringify(p));
  raw.sequences[0].clips.find((x: { id: string }) => x.id === c.id).autoSfx = { rule: 5 };
  assert.equal(parseProject(raw).project.sequences[0].clips.find((x) => x.id === c.id)!.autoSfx, undefined);
});

test("the SFX library has a sound for every rule (by tag)", () => {
  const tags = new Set(SFX_PRESETS.flatMap((p) => p.tags));
  for (const t of ["whoosh", "impact", "pop", "click", "typing", "shutter", "riser", "glitch", "boom"]) assert.ok(tags.has(t), `a preset tagged ${t}`);
  // and the planner finds them in the real library for the QA edit
  const f = qaEdit();
  const pl = planAutoSfx(f.sequences[0], f);
  assert.ok(pl.placements.length >= 10, `${pl.placements.length} sounds`);
  assert.deepEqual(pl.skipped.filter((x) => /No sound in the library/.test(x.reason)), []);
});
