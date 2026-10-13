import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildProject } from "../interop/build.ts";
import { makeIds, pathToUrl, urlToPath } from "../interop/common.ts";
import { fromFcpXml, toFcpXml } from "../interop/fcpxml.ts";
import { descendants, kid, kids, parseXml, txt } from "../interop/xml.ts";
import { parseProject } from "../model/serialize.ts";
import type { EditProject } from "../model/types.ts";
import { clipList, clipsOn, richProject, T } from "./interop-fixture.ts";

const fixture = (name: string) => readFileSync(new URL(`../interop/__fixtures__/${name}`, import.meta.url), "utf8");
/** Import as the converter makes it (`open`: also through parseProject, as the editor opens it). */
const reimport = (text: string, open = false): EditProject => {
  const p = buildProject(fromFcpXml(text), { ids: makeIds(3), now: "2026-10-12T00:00:00.000Z" }).project;
  return open ? parseProject(p).project : p;
};
const noUuid = (s: string) => s.replace(/<uuid>[^<]*<\/uuid>/g, "<uuid/>");

test("xml: paths become file://localhost URLs and back (spaces, Devanagari, UNC)", () => {
  assert.equal(pathToUrl("D:\\Footage\\Shot one.mp4"), "file://localhost/D:/Footage/Shot%20one.mp4");
  assert.equal(urlToPath("file://localhost/D:/Footage/Shot%20one.mp4"), "D:\\Footage\\Shot one.mp4");
  assert.equal(urlToPath("file://localhost/D%3a/Footage/Shot%20one.mp4"), "D:\\Footage\\Shot one.mp4");
  assert.equal(urlToPath(pathToUrl("D:\\Audio\\Score मूल.wav")), "D:\\Audio\\Score मूल.wav");
  assert.equal(pathToUrl("\\\\nas\\share\\a b.mov"), "file://nas/share/a%20b.mov");
  assert.equal(urlToPath("file://nas/share/a%20b.mov"), "\\\\nas\\share\\a b.mov");
  assert.equal(urlToPath("file:///Volumes/Media/clip.mov"), "/Volumes/Media/clip.mov");
});

test("xml: the edit is written as xmeml 4 with files once, −1 at transitions, speed, levels, markers and a nested sequence", () => {
  const p = richProject();
  const r = toFcpXml(p, p.activeSequenceId);
  const doc = parseXml(r.text);
  const xmeml = kid(doc, "xmeml")!;
  assert.equal(xmeml.attrs.version, "4");
  const seq = kid(xmeml, "sequence")!;
  assert.equal(txt(kid(seq, "rate"), "timebase"), "25");
  assert.equal(txt(kid(seq, "rate"), "ntsc"), "FALSE");
  const vtracks = kids(kid(kid(seq, "media"), "video"), "track"), atracks = kids(kid(kid(seq, "media"), "audio"), "track");
  assert.equal(vtracks.length, 3);
  assert.equal(atracks.length, 3);
  // each file in full once, then by id
  const files = descendants(xmeml, "file");
  const full = files.filter((f) => f.children.length);
  assert.equal(new Set(full.map((f) => f.attrs.id)).size, full.length);
  assert.equal(full.length, 4);
  assert.ok(files.length > full.length);
  const shot1 = full.find((f) => txt(f, "name") === "Shot one.mp4")!;
  assert.equal(txt(shot1, "pathurl"), "file://localhost/D:/Footage/Shot%20one.mp4");
  assert.equal(txt(kid(kid(kid(shot1, "media"), "audio"), "samplecharacteristics"), "samplerate"), "48000");
  // V1: the dissolve sits between the clips, which say −1 and reach into it
  const v1 = vtracks[0].children.filter((c) => c.name === "clipitem" || c.name === "transitionitem").map((c) => c.name);
  assert.deepEqual(v1, ["clipitem", "transitionitem", "clipitem", "transitionitem", "clipitem"]);
  const [a, x, b] = vtracks[0].children.filter((c) => c.name === "clipitem" || c.name === "transitionitem");
  assert.equal(txt(a, "end"), "-1"); assert.equal(txt(a, "out"), "110");
  assert.equal(txt(b, "start"), "-1"); assert.equal(txt(b, "in"), "40"); // 2 s in (50 fps media) = 50 sequence frames, less the 10 under the dissolve
  assert.equal(txt(x, "start"), "90"); assert.equal(txt(x, "end"), "110"); assert.equal(txt(x, "alignment"), "center");
  assert.equal(txt(kid(x, "effect"), "name"), "Cross Dissolve");
  // the 2× clip: Time Remap at 200 %
  const fast = vtracks[0].children.filter((c) => c.name === "clipitem")[2];
  const tr = kids(fast, "filter").map((f) => kid(f, "effect")!).find((e) => txt(e, "effectid") === "timeremap")!;
  assert.equal(txt(kids(tr, "parameter").find((pp) => txt(pp, "parameterid") === "speed"), "value"), "200");
  // the wipe has no FCP equivalent: a cross dissolve plus a Tatvam marker on the incoming clip
  assert.ok(r.warnings.some((w) => w.includes("wipeleft")));
  assert.ok(kids(fast, "marker").some((m) => txt(m, "name") === "Tatvam: Transition"));
  // A1: constant power crossfade
  const ax = atracks[0].children.find((c) => c.name === "transitionitem")!;
  assert.equal(txt(kid(ax, "effect"), "name"), "Cross Fade (+3dB)");
  // A2: the music bed with Audio Levels keyframes on the media, pan, a fade-in edge transition, its role and effect marker
  const bedItems = atracks[1].children.filter((c) => c.name === "clipitem" || c.name === "transitionitem");
  assert.deepEqual(bedItems.map((c) => c.name), ["transitionitem", "clipitem"]);
  assert.equal(txt(kid(bedItems[0], "effect"), "name"), "Cross Fade (0dB)");
  assert.equal(txt(bedItems[0], "alignment"), "start-black");
  const bed = bedItems[1];
  const lv = kids(bed, "filter").map((f) => kid(f, "effect")!).find((e) => txt(e, "effectid") === "audiolevels")!;
  const keys = kids(kid(lv, "parameter"), "keyframe").map((k) => [Number(txt(k, "when")), Math.round(Number(txt(k, "value")) * 1000) / 1000]);
  assert.deepEqual(keys, [[25, 1], [125, 0.501]]); // media frame 25 = 1 s in; −6 dB
  assert.ok(kids(bed, "filter").some((f) => txt(kid(f, "effect"), "effectid") === "audiopan"));
  assert.equal(txt(kid(bed, "labels"), "label2"), "Music");
  assert.ok(kids(bed, "marker").some((m) => txt(m, "name") === "Tatvam: compressor"));
  assert.equal(txt(atracks[2], "enabled"), "FALSE");
  assert.equal(txt(vtracks[1], "locked"), "TRUE");
  // the title is a Text generator; the nested sequence is written inside its clip
  assert.ok(descendants(vtracks[1], "generatoritem").some((g) => txt(kid(g, "effect"), "effectid") === "Text"));
  const nested = descendants(vtracks[1], "clipitem").find((c) => kid(c, "sequence"))!;
  assert.equal(txt(kid(nested, "sequence"), "name"), "Inner");
  // markers with colour; the media's marker on its clip
  const intro = kids(seq, "marker").find((m) => txt(m, "name") === "Intro")!;
  assert.equal(txt(intro, "comment"), "Start here");
  assert.equal(txt(kid(intro, "color"), "red"), "251");
  assert.ok(kids(a, "marker").some((m) => txt(m, "name") === "Good take" && txt(m, "in") === "30"));
});

test("xml: export → import → export gives the same file, and the clip lists match", () => {
  const p = richProject();
  const x1 = toFcpXml(p, p.activeSequenceId).text;
  const q = reimport(x1);
  assert.deepEqual(clipList(q), clipList(p));
  assert.deepEqual(clipList(reimport(x1, true)), clipList(p), "the editor opens it with the same clips");
  const x2 = toFcpXml(q, q.activeSequenceId).text;
  assert.equal(noUuid(x2), noUuid(x1));
  // what came back exactly through the Tatvam markers
  const s = q.sequences.find((x) => x.id === q.activeSequenceId)!;
  const bed = clipsOn(s, "audio", 1)[0];
  assert.equal(bed.effects[0]?.type, "audio:compressor");
  assert.equal((bed as { role?: string }).role, "music");
  assert.deepEqual(bed.audio!.gain.keyframes!.map((k) => [k.frame, Math.round(k.value * 100) / 100]), [[0, 0], [100, -6]]);
  const wipe = s.transitions.find((t) => t.trackId === T(s, "video", 0).id && t.at === 200);
  assert.equal(wipe?.type, "wipeleft");
  assert.equal(s.markers.find((m) => m.name === "Intro")?.color, "#fbbf24");
  const title = clipsOn(s, "video", 1).find((c) => c.source.type === "title");
  assert.equal(title?.source.type === "title" && title.source.text.text, "Hello Tatvam");
  assert.ok(q.media.find((m) => m.name === "Shot one.mp4")!.markers.some((m) => m.name === "Good take" && m.frame === 30));
});

test("xml: Premiere's own export (hand-written golden) imports: −1 edges, stereo pairs, levels, pproColor, bins, unknown effects", () => {
  const ir = fromFcpXml(fixture("premiere.xml"));
  const q = parseProject(buildProject(ir, { ids: makeIds(5) }).project).project;
  const s = q.sequences.find((x) => x.id === q.activeSequenceId)!;
  assert.equal(s.fps, 23.976);
  assert.equal(s.width, 1920);
  const v1 = clipsOn(s, "video", 0);
  assert.deepEqual(v1.map((c) => [c.start, c.duration]), [[0, 48], [48, 72]]);
  assert.equal(v1[1].source.type === "media" && v1[1].source.in, 36, "the incoming clip's in point is at the cut (the XML's in reaches 12 frames into the dissolve)");
  const x = s.transitions.find((t) => t.trackId === T(s, "video", 0).id)!;
  assert.deepEqual([x.at, x.duration, x.alignment, x.type], [48, 24, "center", "fade"]);
  // the stereo pair on A1 + A2 became one clip
  assert.equal(clipsOn(s, "audio", 0).length, 2);
  assert.equal(clipsOn(s, "audio", 1).length, 0);
  assert.ok(ir.warnings.some((w) => /stereo pair/.test(w)));
  const a1 = clipsOn(s, "audio", 0)[0];
  assert.equal(Math.round(a1.audio!.gain.value * 10) / 10, -6);
  assert.ok(a1.linkId && a1.linkId === v1[0].linkId);
  // the slow clip
  assert.equal(v1[1].speed, 0.5);
  // the media path, the missing file and the unknown effect
  const m = q.media.find((mm) => mm.name === "Interview A.mov")!;
  assert.equal(m.path, "C:\\Projects\\Doc\\Interview A.mov");
  assert.equal(m.fps, 23.976);
  assert.ok(m.markers.some((k) => k.name === "Gaussian Blur (not imported)"));
  assert.equal(s.markers.find((k) => k.name === "Act 2")?.color, "#ef4444");
});

test("xml: 29.97 (NTSC, drop-frame), reverse, a speed ramp, motion, an adjustment layer, generators, track settings come back", async () => {
  const { newProject, baseClip, newSequence } = await import("../model/defaults.ts");
  const { seedIds } = await import("../model/ids.ts");
  const { addTransition, ctxOf } = await import("../model/ops.ts");
  const { media } = await import("./fixtures.ts");
  seedIds(11);
  const p = newProject("NTSC", { width: 1920, height: 1080, fps: 29.97 });
  p.media = [media("v", { name: "Cam A.mov", path: "E:\Cam A.mov", fps: 29.97, duration: 900 }), media("srv", { name: "Voice.wav", path: "studio:p/1/voice.wav", kind: "audio", fps: 48000, duration: 480000, width: 0, height: 0 })];
  let s = newSequence("Main", { width: 1920, height: 1080, fps: 29.97 }, { video: 2, audio: 3 });
  const tv = (i: number) => s.tracks.filter((t) => t.kind === "video")[i].id, ta = (i: number) => s.tracks.filter((t) => t.kind === "audio")[i].id;
  const rev = { ...baseClip(s, tv(0), 0, 150, { type: "media", mediaId: "v", in: 100 }, "Backwards", { width: 1920, height: 1080 }), reverse: true };
  const ramp = { ...baseClip(s, tv(0), 150, 150, { type: "media", mediaId: "v", in: 400 }, "Ramp", { width: 1920, height: 1080 }),
    timeRemap: { value: 100, keyframes: [{ frame: 0, value: 100, ease: "linear" as const }, { frame: 75, value: 50, ease: "linear" as const }, { frame: 149, value: 50, ease: "linear" as const }] } };
  ramp.motion = { ...ramp.motion, scale: { value: 120 } };
  const adj = { ...baseClip(s, tv(1), 0, 60, { type: "adjustment" }, "Grade"), effects: [{ id: "e1", type: "adjust", enabled: true, params: { contrast: { value: 0.2 } } }] };
  const tone = baseClip(s, ta(0), 0, 90, { type: "generate", generator: "tone", params: { frequency: { value: 440 } } } as never, "Tone");
  const noise = baseClip(s, ta(1), 0, 60, { type: "generate", generator: "noise", params: { color: { value: "pink" } } } as never, "Noise");
  const v1 = baseClip(s, ta(2), 0, 100, { type: "media", mediaId: "srv", in: 0 }, "Voice A");
  const v2 = { ...baseClip(s, ta(2), 100, 100, { type: "media", mediaId: "srv", in: 160000 }, "Voice B"), enabled: false };
  s = { ...s, clips: [rev, ramp, adj, tone, noise, v1, v2] };
  s.tracks = s.tracks.map((t) => (t.id === ta(2) ? { ...t, volume: -3, role: "dialogue" as const, effects: [{ id: "tf", type: "audio:denoise", enabled: true, params: { amount: { value: 0.4 } } }] } : t));
  (s as { masterEffects?: unknown }).masterEffects = [{ id: "mf", type: "audio:limiter", enabled: true, params: { ceiling: { value: -1 } } }];
  p.sequences = [s]; p.activeSequenceId = s.id;
  s = addTransition(s, ctxOf(p), ta(2), 100, "audio:exponential", 10).seq;
  p.sequences = [s];
  const opts = { generated: { [noise.id]: { path: "E:\Exports\Interchange\Main_media\Noise.wav", seconds: 2 } } };
  const r1 = toFcpXml(p, s.id, opts);
  const doc = parseXml(r1.text);
  const seq = kid(kid(doc, "xmeml"), "sequence")!;
  assert.equal(txt(kid(seq, "rate"), "timebase"), "30");
  assert.equal(txt(kid(seq, "rate"), "ntsc"), "TRUE");
  assert.equal(txt(kid(seq, "timecode"), "displayformat"), "DF");
  assert.ok(r1.warnings.some((w) => /Voice\.wav.*studio media/.test(w)));
  assert.ok(r1.warnings.some((w) => /exponential/.test(w)));
  assert.ok(r1.warnings.some((w) => /speed ramp/.test(w)));
  assert.ok(r1.warnings.some((w) => /Tone.*wasn't rendered/.test(w)));
  const back = buildProject(fromFcpXml(r1.text), { ids: makeIds(4) }).project;
  const bs = back.sequences[0];
  const bv = clipsOn(bs, "video", 0);
  assert.equal(bv[0].reverse, true);
  assert.equal(bv[0].source.type === "media" && bv[0].source.in, 100);
  assert.deepEqual(bv[1].timeRemap, ramp.timeRemap);
  assert.equal(bv[1].speed, 1);
  assert.equal(bv[1].motion.scale.value, 120);
  const badj = clipsOn(bs, "video", 1)[0];
  assert.deepEqual([badj.source.type, badj.enabled, badj.effects[0]?.type], ["adjustment", true, "adjust"]);
  const btone = clipsOn(bs, "audio", 0)[0], bnoise = clipsOn(bs, "audio", 1)[0];
  assert.deepEqual([btone?.source.type, btone?.start, btone?.duration], ["generate", 0, 90]);
  assert.deepEqual([bnoise?.source.type, bnoise?.duration], ["generate", 60]);
  assert.equal(back.media.some((m) => m.name === "Noise.wav"), false, "the rendered stand-in isn't kept as media");
  const t3 = bs.tracks.filter((t) => t.kind === "audio")[2];
  assert.deepEqual([t3.volume, t3.role, t3.effects?.[0]?.type], [-3, "dialogue", "audio:denoise"]);
  assert.equal((bs as { masterEffects?: { type: string }[] }).masterEffects?.[0]?.type, "audio:limiter");
  const voice = clipsOn(bs, "audio", 2);
  assert.equal(voice[1].enabled, false);
  assert.equal(bs.transitions.find((t) => t.trackId === t3.id)?.type, "audio:exponential");
  assert.equal(back.media.find((m) => m.name === "Voice.wav")?.path, "", "studio media stays offline until it's made local");
  // the desktop renders generators per clip id: the reimported clip has its own
  assert.equal(noUuid(toFcpXml(back, bs.id, { generated: { [bnoise.id]: opts.generated[noise.id] } }).text), noUuid(r1.text));
});
