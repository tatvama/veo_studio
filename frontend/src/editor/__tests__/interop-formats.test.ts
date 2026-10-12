import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildProject } from "../interop/build.ts";
import { makeIds, parseTimecode, toTimecode } from "../interop/common.ts";
import { fromEdl, toEdl } from "../interop/edl.ts";
import { detectImport, exportSequence, importTimeline } from "../interop/index.ts";
import { fromMarkersCsv, parseDelimited, toMarkersCsv, toYoutubeChapters } from "../interop/markers.ts";
import { fromOtio, toOtio } from "../interop/otio.ts";
import type { EditProject } from "../model/types.ts";
import { clipList, clipsOn, richProject, T } from "./interop-fixture.ts";

const fixture = (name: string) => readFileSync(new URL(`../interop/__fixtures__/${name}`, import.meta.url), "utf8");
const build = (doc: Parameters<typeof buildProject>[0]): EditProject => buildProject(doc, { ids: makeIds(9), now: "2026-10-12T00:00:00.000Z" }).project;
const seqOf = (p: EditProject) => p.sequences.find((s) => s.id === p.activeSequenceId)!;

test("timecode: drop-frame at 29.97 skips ;00 and ;01 each minute but not each tenth", () => {
  assert.equal(toTimecode(1800, 29.97), "00:01:00;02");
  assert.equal(toTimecode(17982, 29.97), "00:10:00;00");
  assert.equal(parseTimecode("00:01:00;02", 29.97), 1800);
  assert.equal(parseTimecode("01:00:00;00", 29.97), 107892);
  assert.equal(toTimecode(90, 25), "00:00:03:15");
  assert.equal(toTimecode(24 * 3600, 23.976), "01:00:00:00");
});

// ── EDL ──────────────────────────────────────────────────────────────────────

test("edl: V1 and A1–A2 as CMX 3600 events with a dissolve, an M2 speed line, clip names and source files", () => {
  const p = richProject();
  const r = toEdl(p, p.activeSequenceId);
  const lines = r.text.split("\r\n");
  assert.equal(lines[0], "TITLE: Sequence 01");
  assert.equal(lines[1], "FCM: NON-DROP FRAME");
  assert.ok(lines.includes("001  AX       V     C        00:00:00:00 00:00:03:15 00:00:00:00 00:00:03:15"), r.text);
  // the dissolve: outgoing held at 90, then D 020 from the incoming's source at 90
  assert.ok(lines.includes("002  AX       V     C        00:00:03:15 00:00:03:15 00:00:03:15 00:00:03:15"));
  assert.ok(lines.includes("002  AX       V     D    020 00:00:01:15 00:00:05:20 00:00:03:15 00:00:07:20"));
  assert.ok(lines.includes("* TO CLIP NAME: Shot two.mov"));
  assert.ok(lines.includes("* SOURCE FILE: D:\\Footage\\Shot two.mov"));
  assert.ok(lines.some((l) => /^M2   AX\s+050\.0\s+00:00:03:15$/.test(l)), "2× at 25 fps = 50 source frames a second");
  assert.ok(lines.some((l) => /^\d{3}  AX       A2    D    025 /.test(l)), "the music's fade-in from black on A2");
  assert.ok(lines.some((l) => l.startsWith("* LOC: 00:00:00:10 YELLOW  Intro")));
  assert.ok(r.warnings.some((w) => /V2 isn't in the EDL/.test(w)));
});

test("edl: export → import keeps the clip list of V1 and the audio tracks", () => {
  const p = richProject();
  const q = build(fromEdl(toEdl(p, p.activeSequenceId).text));
  const keep = (l: ReturnType<typeof clipList>) => l.filter((c) => c.track === "V1" || c.track.startsWith("A")).map(({ enabled, ...c }) => { void enabled; return c; });
  assert.deepEqual(keep(clipList(q)), keep(clipList(p)));
  const s = seqOf(q);
  const x = s.transitions.find((t) => t.trackId === T(s, "video", 0).id && t.at === 100)!;
  assert.deepEqual([x.duration, x.alignment, x.type], [20, "center", "fade"]);
  assert.ok(s.transitions.some((t) => t.trackId === T(s, "audio", 1).id && t.alignment === "start" && t.duration === 25), "the fade from black");
  const v = clipsOn(s, "video", 0), a = clipsOn(s, "audio", 0);
  assert.ok(v[0].linkId && v[0].linkId === a[0].linkId, "V and A events of one source at one place are linked");
  assert.equal(s.markers[0].name, "Intro");
  assert.equal(q.media.find((m) => m.name === "Shot two.mov")!.path, "D:\\Footage\\Shot two.mov");
});

test("edl: a hand-written 29.97 drop-frame EDL (01:00:00;00 start, AA, A2, M2, LOC) imports", () => {
  const ir = fromEdl(fixture("promo.edl"));
  assert.equal(ir.sequences[0].fps, 29.97);
  const q = build(ir);
  const s = seqOf(q);
  const v = clipsOn(s, "video", 0);
  assert.deepEqual(v.map((c) => [c.start, c.duration]), [[0, 135], [135, 165], [300, 60]]);
  assert.equal(v[1].source.type === "media" && v[1].source.in, 1815, "01:00;02 DF = frame 1800, plus half the dissolve");
  assert.equal(v[2].speed, 2);
  assert.equal(v[2].source.type === "media" && v[2].source.in, 900);
  assert.equal(clipsOn(s, "audio", 0).length, 1);
  assert.equal(clipsOn(s, "audio", 1)[0].duration, 360);
  assert.equal(q.media.find((m) => m.name === "Theme.wav")!.kind, "audio");
  assert.equal(s.markers[0].frame, 60);
  assert.equal(s.markers[0].color, "#ef4444");
});

// ── OTIO ─────────────────────────────────────────────────────────────────────

/** The checks OTIO's own reader makes on the schemas used here (OTIO_SCHEMA names and versions, required fields). */
function validateOtio(o: unknown, path = "$"): string[] {
  const errs: string[] = [];
  const need: Record<string, string[]> = {
    "Timeline.1": ["name", "metadata", "global_start_time", "tracks"],
    "Stack.1": ["name", "metadata", "source_range", "effects", "markers", "enabled", "children"],
    "Track.1": ["name", "metadata", "source_range", "effects", "markers", "enabled", "children", "kind"],
    "Clip.2": ["name", "metadata", "source_range", "effects", "markers", "enabled", "media_references", "active_media_reference_key"],
    "Gap.1": ["name", "metadata", "source_range", "effects", "markers", "enabled"],
    "Transition.1": ["name", "metadata", "in_offset", "out_offset", "transition_type"],
    "ExternalReference.1": ["name", "metadata", "available_range", "target_url"],
    "MissingReference.1": ["name", "metadata", "available_range"],
    "GeneratorReference.1": ["name", "metadata", "available_range", "generator_kind", "parameters"],
    "Marker.2": ["name", "metadata", "color", "marked_range", "comment"],
    "LinearTimeWarp.1": ["name", "metadata", "effect_name", "time_scalar"],
    "FreezeFrame.1": ["name", "metadata", "effect_name", "time_scalar"],
    "Effect.1": ["name", "metadata", "effect_name"],
    "RationalTime.1": ["rate", "value"],
    "TimeRange.1": ["start_time", "duration"],
  };
  if (Array.isArray(o)) { o.forEach((x, i) => errs.push(...validateOtio(x, `${path}[${i}]`))); return errs; }
  if (!o || typeof o !== "object") return errs;
  const obj = o as Record<string, unknown>;
  const sch = obj.OTIO_SCHEMA as string | undefined;
  if (sch !== undefined) {
    if (!need[sch]) errs.push(`${path}: unknown schema ${sch}`);
    else for (const k of need[sch]) if (!(k in obj)) errs.push(`${path}: ${sch} without ${k}`);
    if (sch === "RationalTime.1" && !(Number(obj.rate) > 0 && Number.isFinite(Number(obj.value)))) errs.push(`${path}: bad RationalTime`);
    if (sch === "Track.1" && !["Video", "Audio"].includes(obj.kind as string)) errs.push(`${path}: bad track kind`);
    if (sch === "Clip.2" && !(obj.media_references as Record<string, unknown>)[obj.active_media_reference_key as string]) errs.push(`${path}: no active media reference`);
    if (sch === "Track.1") {
      const ch = obj.children as Record<string, unknown>[];
      ch.forEach((c, i) => {
        if (c.OTIO_SCHEMA === "Transition.1" && (i === 0 || i === ch.length - 1 || ch[i - 1].OTIO_SCHEMA === "Transition.1")) errs.push(`${path}.children[${i}]: a transition needs an item on both sides`);
      });
    }
    if (sch === "Marker.2" && !["PINK", "RED", "ORANGE", "YELLOW", "GREEN", "CYAN", "BLUE", "PURPLE", "MAGENTA", "BLACK", "WHITE"].includes(obj.color as string)) errs.push(`${path}: bad marker colour`);
  }
  for (const [k, v] of Object.entries(obj)) if (k !== "metadata") errs.push(...validateOtio(v, `${path}.${k}`));
  return errs;
}

test("otio: the export follows the published schemas (Timeline.1, Stack.1, Track.1, Clip.2, Gap.1, Transition.1, Marker.2 …)", () => {
  const p = richProject();
  const r = toOtio(p, p.activeSequenceId);
  const o = JSON.parse(r.text);
  assert.deepEqual(validateOtio(o), []);
  assert.equal(o.OTIO_SCHEMA, "Timeline.1");
  const v1 = o.tracks.children[0];
  assert.equal(v1.kind, "Video");
  assert.deepEqual(v1.children.map((c: { OTIO_SCHEMA: string }) => c.OTIO_SCHEMA), ["Clip.2", "Transition.1", "Clip.2", "Transition.1", "Clip.2"]);
  assert.equal(v1.children[1].in_offset.value, 10);
  assert.equal(v1.children[1].transition_type, "SMPTE_Dissolve");
  assert.equal(v1.children[3].transition_type, "Custom_Transition");
  assert.equal(v1.children[4].effects[0].OTIO_SCHEMA, "LinearTimeWarp.1");
  assert.equal(v1.children[4].effects[0].time_scalar, 2);
  assert.equal(v1.children[2].media_references.DEFAULT_MEDIA.target_url, "file:///D:/Footage/Shot%20two.mov");
  assert.equal(v1.children[2].source_range.start_time.rate, 50, "a video source at its own rate");
  assert.equal(v1.children[2].source_range.start_time.value, 100);
  const v2 = o.tracks.children[1];
  assert.ok(v2.children.some((c: { OTIO_SCHEMA: string }) => c.OTIO_SCHEMA === "Stack.1"), "the nested sequence is a Stack in the track");
  assert.equal(o.tracks.markers[0].color, "YELLOW");
  assert.equal(o.tracks.children[5].enabled, false, "the muted A3");
});

test("otio: export → import → export is the same file, with every clip back", () => {
  const p = richProject();
  const t1 = toOtio(p, p.activeSequenceId).text;
  const q = build(fromOtio(t1));
  assert.deepEqual(clipList(q), clipList(p));
  const strip = (t: string) => t.replace(/"clipId": "[^"]*"/g, "\"clipId\": \"\"").replace(/"id": "[^"]*"/g, "\"id\": \"\"").replace(/"linkId": "[^"]*"/g, "\"linkId\": \"\"")
    .replace(/"sequenceId": "[^"]*"/g, "\"sequenceId\": \"\"");
  assert.equal(strip(toOtio(q, q.activeSequenceId).text), strip(t1));
  const s = seqOf(q);
  assert.equal(s.transitions.find((t) => t.at === 200)?.type, "wipeleft");
  assert.equal(clipsOn(s, "audio", 1)[0].audio?.fadeIn, 25);
  assert.equal(T(s, "audio", 2).muted, true);
});

test("otio: a hand-written Resolve-style file imports (01:00:00:00 media start, warp, dissolve, markers, disabled track)", () => {
  const q = build(fromOtio(fixture("resolve.otio")));
  const s = seqOf(q);
  assert.equal(s.fps, 24);
  assert.equal(s.name, "Festival Cut");
  const v = clipsOn(s, "video", 0);
  assert.deepEqual(v.map((c) => [c.start, c.duration, c.speed]), [[24, 72, 1], [96, 96, 0.5]]);
  assert.equal(v[0].source.type === "media" && v[0].source.in, 48, "the source counts from the file's own start time");
  const x = s.transitions[0];
  assert.deepEqual([x.at, x.duration, x.alignment, x.type], [96, 24, "center", "fade"]);
  const a = q.media.find((m) => m.name === "A.mov")!;
  assert.equal(a.path, "C:\\Media\\Festival\\A.mov");
  assert.ok(a.markers.some((m) => m.name === "Smile" && m.frame === 60));
  assert.ok(a.markers.some((m) => m.name === "Gaussian Blur (not imported)"));
  assert.equal(q.media.find((m) => m.name === "B.mov")!.path, "C:\\Media\\Festival\\B roll.mov");
  assert.equal(T(s, "audio", 0).muted, true);
  assert.equal(clipsOn(s, "audio", 0)[0].source.type === "media" && (clipsOn(s, "audio", 0)[0].source as { in: number }).in, 48000);
  assert.deepEqual([s.markers[0].frame, s.markers[0].name, s.markers[0].color], [30, "Title card", "#60a5fa"]);
});

// ── markers ──────────────────────────────────────────────────────────────────

test("markers: Premiere's CSV layout out and back; a tab-separated Premiere file in", () => {
  const p = richProject();
  const s = seqOf(p);
  const csv = toMarkersCsv(s);
  assert.equal(csv.split("\r\n")[0], "Marker Name,Description,In,Out,Duration,Marker Type");
  assert.equal(csv.split("\r\n")[1], "Intro,Start here,00:00:00:10,00:00:00:10,00:00:00:00,Comment");
  assert.equal(csv.split("\r\n")[2], "Chorus,,00:00:06:00,00:00:07:00,00:00:01:00,Chapter");
  const back = fromMarkersCsv(csv, 25).markers;
  assert.deepEqual(back.map((m) => [m.frame, m.duration, m.name, m.kind]), [[10, 0, "Intro", "comment"], [150, 25, "Chorus", "chapter"]]);
  const prem = fromMarkersCsv(fixture("premiere-markers.csv"), 25);
  assert.deepEqual(prem.markers.map((m) => [m.frame, m.duration, m.name, m.comment ?? ""]), [[0, 0, "Intro", "Opening line"], [310, 0, "Chapter 1", ""], [1555, 50, "Big \"quote\"", "Uses, commas"]]);
  assert.deepEqual(parseDelimited("a,\"b,\"\"c\"\"\"\r\n1,2\n"), [["a", "b,\"c\""], ["1", "2"]]);
});

test("markers: YouTube chapters start at 0:00 and say when YouTube won't show them", () => {
  const p = richProject();
  const r = toYoutubeChapters(seqOf(p));
  assert.equal(r.text, "0:00 Intro\n0:06 Chorus\n");
  assert.ok(r.warnings.some((w) => /at least three/.test(w)));
  assert.ok(r.warnings.some((w) => /0:00/.test(w)));
});

test("index: formats by extension and content; importTimeline names the edit after the file", () => {
  assert.equal(detectImport("cut.xml", ""), "fcpxml");
  assert.equal(detectImport("cut.EDL", ""), "edl");
  assert.equal(detectImport("x", "{\"OTIO_SCHEMA\": \"Timeline.1\"}"), "otio");
  assert.equal(detectImport("x", "TITLE: a\nFCM: NON-DROP FRAME\n"), "edl");
  const p = richProject();
  const x = exportSequence(p, p.activeSequenceId, "premiere-xml");
  assert.equal(x.ext, "xml");
  const r = importTimeline(x.text, "D:\\Exports\\My cut.xml", { ids: makeIds(1) });
  assert.equal(r.project.name, "My cut");
  assert.equal(r.kind, "fcpxml");
  assert.throws(() => exportSequence(p, p.activeSequenceId, "audition-stems"), /Desktop/);
  const au = exportSequence(p, p.activeSequenceId, "audition-xml");
  assert.ok(!au.text.includes("Logo.png"), "Audition XML keeps only V1 for picture");
});
