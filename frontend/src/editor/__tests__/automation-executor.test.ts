/**
 * Auto edit's executor (frontend/src/automation/autoedit/executor.ts) on a fake store: the editor's own command
 * history (model/commands.ts), so the whole new sequence is ONE undo step. Checks the clips (picture + linked sound,
 * source in / out, speed), punch-ins, J/L cuts, transitions, titles, captions, the music bed, the mood, the speed
 * ramps, the 9:16 fill, and the watch folder's append / rebuild.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAutoEdit } from "../../automation/autoedit/executor.ts";
import { planAutoEdit } from "../../automation/autoedit/planner.ts";
import type { MediaAnalysis, PlanMedia } from "../../automation/autoedit/types.ts";
import * as H from "../model/commands.ts";
import { newProject } from "../model/defaults.ts";
import { seedIds } from "../model/ids.ts";
import { seqEnd, tracksOf } from "../model/ops.ts";
import type { EditProject, MediaItem, Sequence } from "../model/types.ts";

const FPS = 25;
const item = (id: string, name: string, seconds: number, o: Partial<MediaItem> = {}): MediaItem => ({ id, binId: null, name, kind: "video", path: `D:\\Shoot\\${name}`,
  duration: Math.round(seconds * FPS), fps: FPS, width: 1920, height: 1080, hasAudio: true, markers: [], seconds, ...o });
const audio = (id: string, name: string, seconds: number): MediaItem => item(id, name, seconds, { kind: "audio", fps: 48000, duration: Math.round(seconds * 48000), width: 0, height: 0 });
const plan = (m: MediaItem): PlanMedia => ({ id: m.id, name: m.name, kind: m.kind, duration: m.seconds ?? 0, hasAudio: m.hasAudio, width: m.width, height: m.height, path: m.path });
const A = (id: string, a: Partial<MediaAnalysis> & { duration: number }): MediaAnalysis => ({ mediaId: id, name: id, kind: "video", hasAudio: true, width: 1920, height: 1080, ...a });
const curve = (seconds: number, f: (t: number) => number) => Array.from({ length: Math.ceil(seconds / 0.5) }, (_, i) => f(i * 0.5));

function project(media: MediaItem[]): EditProject {
  seedIds(7);
  const p = newProject("Lighthouse", { width: 1920, height: 1080, fps: FPS });
  return { ...p, media };
}
const active = (p: EditProject): Sequence => p.sequences.find((s) => s.id === p.activeSequenceId)!;

test("talking head → one undo step: a new sequence with linked clips, punch-ins, dialogue clean-up and captions", () => {
  const media = [item("m1", "vlog_001.mp4", 20)];
  const p0 = project(media);
  const pl = planAutoEdit(media.map(plan), [A("m1", { duration: 20, silences: [{ start: 3, end: 5 }, { start: 10, end: 11.5 }], energy: curve(20, () => -20),
    transcript: [{ start: 0.2, end: 2.8, text: "Hi, welcome back" }] })], { style: "talking_head", folder: "Lighthouse", fps: FPS });
  // the fake store: the editor's own history, one command
  let h = H.initHistory(p0);
  h = H.exec(h, H.command("Assistant: auto_edit", (p) => buildAutoEdit(p, pl).project));
  assert.equal(h.past.length, 1);
  assert.equal(h.past[0].label, "Assistant: auto_edit");
  const p1 = h.present;
  assert.equal(p1.sequences.length, 2);
  const s = active(p1);
  assert.equal(s.name, "Auto edit · Lighthouse · Talking head / vlog");
  const [V1, , V3] = tracksOf(s, "video");
  const [A1] = tracksOf(s, "audio");
  assert.equal(V1.name, "Picture");
  assert.equal(A1.role, "dialogue");
  const pics = s.clips.filter((c) => c.trackId === V1.id).sort((a, b) => a.start - b.start);
  const snds = s.clips.filter((c) => c.trackId === A1.id).sort((a, b) => a.start - b.start);
  assert.equal(pics.length, pl.segments.length);
  assert.equal(snds.length, pl.segments.length);
  pics.forEach((c, i) => {
    const seg = pl.segments[i];
    assert.equal(c.source.type === "media" && c.source.in, Math.round(seg.in * FPS), "source in");
    assert.equal(c.start, Math.round(seg.at * FPS));
    assert.ok(c.linkId && snds[i].linkId === c.linkId, "picture and sound linked");
    assert.equal(c.motion.scale.value, seg.scale ?? 100);
  });
  assert.ok(pics.some((c) => c.motion.scale.value === 112), "a punch-in");
  assert.deepEqual(snds[0].effects.map((e) => e.type), ["audio:voice_enhance", "audio:speech_level"]);
  assert.equal(snds[0].role, "dialogue");
  assert.ok(s.clips.some((c) => c.trackId === V3.id && c.source.type === "title" && c.source.text.text === "Hi, welcome back"), "captions on V3");
  assert.equal(V3.name, "Captions");
  assert.ok(Math.abs(seqEnd(s) / FPS - pl.summary.length) < 0.1);
  // Ctrl+Z takes the whole sequence back
  const undone = H.undo(h);
  assert.equal(undone.present, p0);
  assert.equal(undone.present.sequences.length, 1);
});

test("montage: music bed on A3, transitions on the beats, the mood's effects, a speed ramp", () => {
  const media = [item("c1", "b_roll_01.mp4", 12, { hasAudio: false }), item("c2", "b_roll_02.mp4", 10, { hasAudio: false }), audio("mu", "song.wav", 16)];
  const beats = Array.from({ length: 31 }, (_, i) => 0.5 * (i + 1)).filter((b) => b < 16);
  const pl = planAutoEdit(media.map(plan), [A("c1", { duration: 12, hasAudio: false, motion: curve(12, () => 0.1) }), A("c2", { duration: 10, hasAudio: false }),
    { ...A("mu", { duration: 16, kind: "audio" }), beats, bpm: 120 }], { style: "montage", music: "mu", folder: "Trip", fps: FPS });
  const r = buildAutoEdit(project(media), pl);
  const s = active(r.project);
  const [V1] = tracksOf(s, "video");
  const A3 = tracksOf(s, "audio")[2];
  const music = s.clips.filter((c) => c.trackId === A3.id);
  assert.equal(music.length, 1);
  assert.equal(music[0].role, "music");
  assert.equal(music[0].audio?.gain.value, -3);
  assert.equal(music[0].duration, 16 * FPS);
  assert.ok(music[0].audio!.fadeOut > 0);
  assert.equal(A3.role, "music");
  assert.equal(s.transitions.length, pl.transitions.length);
  assert.ok(s.transitions.every((t) => t.trackId === V1.id));
  const pics = s.clips.filter((c) => c.trackId === V1.id);
  assert.ok(pics.every((c) => c.effects.some((e) => e.id.startsWith("mood:action:"))), "the mood on every shot");
  assert.ok(pics.some((c) => c.timeRemap?.keyframes?.length), "a speed ramp");
  assert.equal(s.clips.filter((c) => tracksOf(s, "audio")[0].id === c.trackId).length, 0, "no clip sound under the music");
});

test("highlights: 9:16 fill, a hook title on V2; documentary: J/L cuts move the sound", () => {
  const media = [item("h1", "stream.mp4", 60)];
  const pl = planAutoEdit(media.map(plan), [A("h1", { duration: 60, energy: curve(60, (t) => (t > 20 && t < 30 ? -8 : -35)) })], { style: "highlights", targetSeconds: 12, fps: FPS });
  const s = active(buildAutoEdit(project(media), pl).project);
  assert.deepEqual([s.width, s.height], [1080, 1920]);
  const [V1, V2] = tracksOf(s, "video");
  assert.ok(s.clips.filter((c) => c.trackId === V1.id).every((c) => c.motion.scale.value === 316), "a 16:9 picture covers the 9:16 frame (316 %)");
  assert.ok(s.clips.some((c) => c.trackId === V2.id && c.source.type === "title" && c.name.startsWith("Hook:")));

  const dm = [item("d1", "Asha_interview.mp4", 20), item("d2", "Harbour_wide.mp4", 12)];
  // d2 opens on a pause: the trimmed start leaves a handle for its sound to lead in under d1's last picture
  const dp = planAutoEdit(dm.map(plan), [A("d1", { duration: 20, energy: curve(20, () => -18) }),
    A("d2", { duration: 12, silences: [{ start: 0, end: 1.5 }], energy: curve(12, () => -25) })], { style: "documentary", fps: FPS });
  const lead = dp.segments.find((x) => x.soundLead || x.soundTail);
  assert.ok(lead, "the plan has a J or L cut");
  const ds = active(buildAutoEdit(project(dm), dp).project);
  const [A1, A2] = tracksOf(ds, "audio");
  const sounds = ds.clips.filter((c) => c.trackId === A1.id || c.trackId === A2.id);
  assert.ok(sounds.some((c) => c.trackId === A2.id), "the next clip's sound goes on the second dialogue track");
  const pics = ds.clips.filter((c) => c.trackId === tracksOf(ds, "video")[0].id);
  const moved = sounds.find((snd) => { const v = pics.find((p) => p.linkId && p.linkId === snd.linkId); return v && (snd.start < v.start || snd.start + snd.duration > v.start + v.duration); });
  assert.ok(moved, "a sound clip starts before or ends after its picture (J / L)");
});

test("watch folders: append adds after the end of the auto edit; rebuild replaces it in place", () => {
  const media = [item("m1", "a_001.mp4", 10), item("m2", "a_002.mp4", 8)];
  const an = [A("m1", { duration: 10, energy: curve(10, () => -20) }), A("m2", { duration: 8, energy: curve(8, () => -20) })];
  const first = planAutoEdit([plan(media[0])], an, { style: "talking_head", folder: "Drop", fps: FPS });
  const r1 = buildAutoEdit(project(media), first);
  const end1 = seqEnd(active(r1.project));
  const more = planAutoEdit([plan(media[1])], an, { style: "talking_head", folder: "Drop", fps: FPS });
  const r2 = buildAutoEdit(r1.project, more, { appendTo: r1.sequenceId });
  assert.equal(r2.sequenceId, r1.sequenceId);
  assert.equal(r2.project.sequences.length, 2);
  const s2 = active(r2.project);
  const added = s2.clips.filter((c) => c.source.type === "media" && c.source.mediaId === "m2");
  assert.ok(added.length && added.every((c) => c.start >= end1), "after the old end");
  const all = planAutoEdit(media.map(plan), an, { style: "talking_head", folder: "Drop", fps: FPS });
  const r3 = buildAutoEdit(r2.project, all, { rebuild: true });
  assert.equal(r3.sequenceId, r1.sequenceId, "same sequence id");
  assert.equal(r3.project.sequences.length, 2);
  assert.ok(Math.abs(seqEnd(active(r3.project)) / FPS - all.summary.length) < 0.1);
});
