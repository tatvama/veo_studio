import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultTitle } from "../model/defaults.ts";
import { addGenerated, addTransition, ctxOf, updateParam, updateSequence, withLinked } from "../model/ops.ts";
import { addKeyframe } from "../model/params.ts";
import { forDisk, parseProject } from "../model/serialize.ts";
import { clipGainAt, fitWidth, toAudioMix, toComposition, toVideoComposition } from "../model/toComposition.ts";
import { A, on, project, put, seqOf, V } from "./fixtures.ts";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test("V1 becomes the main track in seconds, with a centred transition extending both clips", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  s = put(p, s, "m2", 100, { in: 50, out: 149 });
  s = addTransition(s, ctx, V(s, 0).id, 100, "gl:cube", 20).seq;
  p.sequences = [s];
  const { comp } = toComposition(p, s.id);
  assert.equal(comp.tracks[0].kind, "main");
  const [a, b] = comp.tracks[0].clips;
  close(a.start, 0); close(a.duration, 4 + 10 / 25);
  close(b.start, 4 - 10 / 25); close(b.duration, 4 + 10 / 25);
  close(b.in, 2 - 10 / 25);
  assert.equal(b.transitionIn?.type, "gl:cube");
  close(b.transitionIn!.duration, 20 / 25);
  close(comp.duration, 8);
  assert.equal(a.media.url, "/__media/m1");
});

test("V2 clips are layers with a fitted transform and keyframes in seconds; V1 motion moves to a layer", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  s = put(p, s, "still", 0, undefined, 1, 0, false);
  const still = on(s, V(s, 1).id)[0];
  s = updateParam(s, ctx, still.id, "motion.opacity", (pp) => addKeyframe(addKeyframe(pp, 0, 0, "ease_out"), 25, 100));
  s = updateParam(s, ctx, still.id, "motion.position", () => ({ value: [480, 270] }));
  const v1 = on(s, V(s, 0).id)[0];
  s = updateParam(s, ctx, v1.id, "motion.scale", () => ({ value: 50 }));
  p.sequences = [s];
  const { comp, warnings } = toComposition(p, s.id);
  const main = comp.tracks[0];
  assert.equal(main.clips.length, 0, "the scaled V1 clip left the main track");
  const v1layer = comp.tracks[1];
  assert.equal(v1layer.kind, "layer");
  close(v1layer.clips[0].transform!.scale, 0.5);
  const layer = comp.tracks.find((t) => t.clips.some((c) => c.id === still.id))!;
  const tr = layer.clips[0].transform!;
  close(tr.x, 0.25); close(tr.y, 0.25);
  close(tr.scale, fitWidth(1000, 1000, 1920, 1080));
  assert.deepEqual(tr.keyframes!.map((k) => [k.t, k.opacity, k.easing]), [[0, 0, "ease_out"], [1, 1, "linear"]]);
  assert.ok(Array.isArray(warnings));
});

test("titles and colour mattes come back as generated sources; disabled clips are left out", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = seqOf(p);
  s = addGenerated(s, ctx, V(s, 1).id, 0, 50, { type: "title", text: defaultTitle("Hello") }, "Title").seq;
  s = addGenerated(s, ctx, V(s, 0).id, 0, 50, { type: "color", color: "#ff0000" }, "Red").seq;
  s = put(p, s, "m1", 50, { in: 0, out: 49 });
  s = { ...s, clips: s.clips.map((c) => (c.start === 50 ? { ...c, enabled: false } : c)) };
  p.sequences = [s];
  const { comp, generated } = toComposition(p, s.id);
  assert.ok(Object.keys(generated).some((k) => k.startsWith("gen:title:")));
  assert.equal(generated["gen:color:#ff0000"]?.kind, "color");
  assert.equal(comp.tracks.flatMap((t) => t.clips).length, 2);
});

test("effects map to ShotFx; edge transitions become fades; a range starts at 0", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  const v = on(s, V(s, 0).id)[0];
  s = { ...s, clips: s.clips.map((c) => (c.id === v.id ? { ...c, effects: [
    { id: "e1", type: "adjust", enabled: true, params: { contrast: { value: 0.3 }, saturation: { value: 0 } } },
    { id: "e2", type: "look", enabled: true, params: { look: { value: "cinematic" }, lut_strength: { value: 0.5 } } },
    { id: "e3", type: "glow", enabled: false, params: { amount: { value: 1 } } },
  ] } : c)) };
  s = addTransition(s, ctx, V(s, 0).id, 0, "fade", 25).seq;
  p.sequences = [s];
  const { comp } = toComposition(p, s.id, { lutUrl: (l) => `/api/fx/looks/${l}.cube` });
  const c = comp.tracks[0].clips[0];
  assert.deepEqual(c.fx.adjust, { contrast: 0.3 });
  assert.equal(c.fx.look, "cinematic");
  assert.equal(c.fx.lut_strength, 0.5);
  assert.equal(c.fx.glow, undefined);
  close(c.fx.fade_in!, 1);
  assert.equal(comp.lutUrls?.cinematic, "/api/fx/looks/cinematic.cube");
  const r = toComposition(p, s.id, { range: [25, 75] }).comp;
  close(r.duration, 2);
  close(r.tracks[0].clips[0].start, 0);
  close(r.tracks[0].clips[0].in, 1);
});

test("nested sequences are flattened into layers", async () => {
  const { nestClips } = await import("../model/ops.ts");
  const p = project();
  const s = put(p, seqOf(p), "m1", 25, { in: 0, out: 49 });
  p.sequences = [s];
  const n = nestClips(p, s.id, s.clips.map((c) => c.id));
  const { comp } = toComposition(n.project, s.id);
  const all = comp.tracks.flatMap((t) => t.clips);
  assert.equal(all.length, 1);
  close(all[0].start, 1);
  close(all[0].duration, 2);
});

test("audio mix: levels, fades, crossfades at cuts, mute and solo", () => {
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  s = put(p, s, "m2", 100, { in: 50, out: 149 });
  s = addTransition(s, ctx, A(s, 0).id, 100, "audio:constant_power", 20).seq;
  s = { ...s, tracks: s.tracks.map((t) => (t.id === A(s, 1).id ? { ...t, solo: true } : t)) };
  p.sequences = [s];
  const mix = toAudioMix(p, s.id);
  assert.equal(mix.tracks.find((t) => t.id === A(s, 0).id)!.audible, false, "another track is soloed");
  const [a, b] = mix.clips;
  close(a.duration, 4 + 10 / 25);
  close(b.start, 4 - 10 / 25);
  close(b.xIn!.duration, 0.8);
  close(clipGainAt(b, 0), 0);
  close(clipGainAt(b, 0.8), 1);
  close(clipGainAt(a, a.xOut!.start + 0.4), Math.SQRT1_2, 1e-6);
});

test("parseProject repairs a file and a project round-trips (with the desktop's extra fields)", () => {
  const p = project();
  p.sequences = [{ ...put(p, seqOf(p), "m1", 0), source: { pid: 3, eid: 9, lang: "kn" } }];
  p.media = p.media.map((m) => (m.kind === "audio" ? { ...m, fps: 48000, duration: 48000 * 60, sampleRate: 48000, seconds: 60 } : m));
  const text = JSON.stringify(forDisk(p));
  const back = parseProject(text).project;
  assert.deepEqual(back.sequences[0].source, { pid: 3, eid: 9, lang: "kn" });
  assert.equal(back.media.find((m) => m.kind === "audio")!.sampleRate, 48000);
  assert.deepEqual(back.sequences[0].clips.map((c) => c.id), p.sequences[0].clips.map((c) => c.id));
  const broken = parseProject({ format: "tatvam-edit", version: 1, name: "X", media: [{ id: "a" }], sequences: [{ fps: 30, tracks: [], clips: [{ trackId: "nope", source: { type: "media" } }] }] });
  assert.equal(broken.project.media.length, 0);
  assert.equal(broken.project.sequences[0].fps, 30);
  assert.ok(broken.project.sequences[0].tracks.some((t) => t.kind === "video"));
  assert.ok(broken.warnings.length > 0);
  assert.throws(() => parseProject({ format: "tatvam-edit", version: 99 }), /newer/);
  assert.throws(() => parseProject("{"), /JSON/);
  void updateSequence; void withLinked;
});

test("a studio shot's fx (one shotfx effect) maps onto the engine clip; audio in samples plays at the right place", () => {
  const p = project();
  p.media = p.media.map((m) => (m.id === "music" ? { ...m, fps: 48000, duration: 48000 * 60, sampleRate: 48000 } : m));
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  const v = on(s, V(s, 0).id)[0];
  s = { ...s, clips: s.clips.map((c) => (c.id === v.id ? { ...c, effects: [{ id: "sf", type: "shotfx", enabled: true, params: {
    fx: { value: { look: "warm", adjust: { contrast: 0.2 }, move: { kind: "zoom_in", amount: 0.1 }, speed: 2, transition: { type: "fade", duration: 1 } } }, kenburns: { value: true } } }] } : c)) };
  // 2 s of music from 10 s into the file, on A2
  s = put(p, s, "music", 25, { in: 48000 * 10, out: 48000 * 12 - 1 }, 0, 1, true);
  p.sequences = [s];
  const { comp } = toComposition(p, s.id);
  const c = comp.tracks[0].clips[0];
  assert.equal(c.fx.look, "warm");
  assert.deepEqual(c.fx.adjust, { contrast: 0.2 });
  assert.equal(c.fx.speed, undefined, "speed stays on the clip");
  assert.deepEqual(c.move, { kind: "zoom_in", amount: 0.1 });
  const mix = toAudioMix(p, s.id);
  const music = mix.clips.find((x) => x.name === "music")!;
  close(music.start, 1); close(music.duration, 2); close(music.in, 10); close(music.rate, 1);
});

test("generic video tracks: motion and effect keyframes in seconds, track transitions, titles, mattes, nests", async () => {
  const { nestClips } = await import("../model/ops.ts");
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 99 });
  s = put(p, s, "m2", 100, { in: 50, out: 149 });
  s = addTransition(s, ctx, V(s, 0).id, 100, "gl:cube", 20).seq;
  const v = on(s, V(s, 0).id)[0];
  s = updateParam(s, ctx, v.id, "motion.scale", (pp) => addKeyframe(addKeyframe(pp, 0, 100, "ease_in"), 50, 150));
  s = { ...s, clips: s.clips.map((c) => (c.id === v.id ? { ...c, effects: [
    { id: "b", type: "kawase_blur", enabled: true, params: { strength: { value: 2, keyframes: [{ frame: 0, value: 0, ease: "linear" }, { frame: 25, value: 4, ease: "linear" }] } } },
    { id: "l", type: "look", enabled: true, params: { look: { value: "noir" } } },
  ] } : c)) };
  s = addGenerated(s, ctx, V(s, 2).id, 0, 50, { type: "title", text: defaultTitle("Hi") }, "T").seq;
  s = addGenerated(s, ctx, V(s, 1).id, 150, 25, { type: "color", color: "#112233" }, "M").seq;
  p.sequences = [s];
  const { comp } = toVideoComposition(p, s.id);
  assert.deepEqual(comp.tracks.map((t) => t.kind), ["video", "video", "video"]);
  const v1 = comp.tracks[0];
  assert.equal(v1.clips.length, 2);
  const a = v1.clips[0];
  assert.deepEqual(a.motion?.scale, { value: 100, keyframes: [{ t: 0, frame: 0, value: 100, ease: "ease_in" }, { t: 2, frame: 50, value: 150, ease: "linear" }] });
  assert.equal(a.fx.look, undefined, "every effect runs in the chain on generic tracks");
  assert.deepEqual(a.effects?.map((e) => e.type), ["kawase_blur", "look"]);
  close(a.start, 0); close(a.duration, 4); close(v1.clips[1].in, 2);
  assert.deepEqual(v1.transitions?.map((t) => [t.type, t.at, t.duration, t.alignment, t.from, t.to]), [["gl:cube", 4, 0.8, "center", a.id, v1.clips[1].id]]);
  close(v1.transitions![0].start!, 4 - 10 / 25);
  assert.equal(comp.tracks[2].clips[0].type, "title");
  assert.equal(comp.tracks[1].clips[0].color, "#112233");
  assert.equal(comp.lutUrls?.noir, "/api/fx/looks/noir.cube");
  const n = nestClips(p, s.id, s.clips.filter((c) => c.trackId === V(s, 0).id).map((c) => c.id));
  const nc = toVideoComposition(n.project, s.id).comp.tracks[0].clips[0];
  assert.equal(nc.type, "nested");
  assert.equal(nc.comp?.tracks[0].clips.length, 2);
  // a range keeps clip-relative keyframes right
  const r = toVideoComposition(p, s.id, { range: [25, 125] }).comp;
  const ra = r.tracks[0].clips[0];
  close(ra.start, 0); close(ra.in, 1);
  close((ra.motion?.scale as { keyframes: { t: number }[] }).keyframes[1].t, 1);
  close(r.tracks[0].transitions![0].start!, 4 - 10 / 25 - 1, 1e-9);
  // an odd number of frames starts floor(d/2) frames before the cut, exactly
  const odd = addTransition(s, ctx, V(s, 0).id, 100, "fade", 21, { alignment: "center" }).seq;
  p.sequences = [odd];
  const t21 = toVideoComposition(p, odd.id).comp.tracks[0].transitions![0];
  close(t21.start!, (100 - 10) / 25);
});

test("nested clips anchor in their sequence's pixels; imported LUTs resolve through lutUrl", async () => {
  const { nestClips } = await import("../model/ops.ts");
  const p = project(); const ctx = ctxOf(p);
  let s = put(p, seqOf(p), "m1", 0, { in: 0, out: 49 });
  p.sequences = [s];
  const n = nestClips(p, s.id, s.clips.map((c) => c.id));
  const outer = n.project.sequences.find((x) => x.id === s.id)!;
  const nc = outer.clips.find((c) => c.source.type === "nested")!;
  assert.deepEqual(nc.motion.anchor.value, [960, 540]);
  s = outer;
  s = { ...s, clips: s.clips.map((c) => (c.id === nc.id ? { ...c, effects: [{ id: "lk", type: "look", enabled: true, params: { look: { value: "lut:abc" } } }] } : c)) };
  const q = { ...n.project, sequences: n.project.sequences.map((x) => (x.id === s.id ? s : x)) };
  const r = toVideoComposition(q, s.id, { lutUrl: (l) => (l === "lut:abc" ? "/__media/x/abc.cube" : undefined) }).comp;
  assert.equal(r.lutUrls?.["lut:abc"], "/__media/x/abc.cube");
  void ctx;
});
