/**
 * A studio episode → an editor sequence (src/main/editor-episode.ts), from the fixture in fixtures/episode.ts: the
 * studio's cut timing (layoutClips / assembler.timeline), the take and sound choices of assembler.plan, layers,
 * titles, music and scene markers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MediaItem, TimelineClip } from "../src/shared/types.ts";
import { dimsFor, episodePlan, episodeSequence } from "../src/main/editor-episode.ts";
import { EPISODE, LAYERS } from "./fixtures/episode.ts";

const opts = { lang: "kn", primaryLanguage: "kn", fps: 24, width: 1920, height: 1080 };
const SECONDS: Record<string, number> = { l41: 4, v42: 6, kn42: 2.5, n43: 2, s41: 2, m6: 4, "amb.wav": 10 };

function itemFor(key: string): MediaItem {
  const name = key.split("/").pop()!;
  const stem = name.replace(/\.\w+$/, "");
  const secs = SECONDS[stem] ?? SECONDS[name] ?? 0;
  const kind = /\.png$/.test(name) ? "image" : /\.(wav|mp3)$/.test(name) ? "audio" : "video";
  return { id: `m-${stem}`, binId: null, name, kind, path: `C:/edit/Media/${name}`, markers: [], hasAudio: kind !== "image",
    fps: kind === "audio" ? 48000 : kind === "video" ? 24 : 0, duration: kind === "audio" ? secs * 48000 : kind === "video" ? secs * 24 : 0,
    width: kind === "audio" ? 0 : 1280, height: kind === "audio" ? 0 : 720, seconds: secs, studioKey: key };
}

test("the plan: takes, voices and every key to fetch", () => {
  const plan = episodePlan(EPISODE, LAYERS, opts);
  assert.deepEqual(plan.shots.map((p) => [p.shot.id, p.picture?.id, p.still, p.ownAudio, p.voice?.id ?? null, p.narration?.id ?? null]),
    [[41, 141, false, true, null, null], [42, 242, false, false, 342, null], [43, 443, true, false, null, 543]]);
  assert.deepEqual(plan.shots.map((p) => [p.start, p.len, p.overlap]), [[0, 4, 0], [3, 3, 1], [5.5, 3, 0.5]]);
  assert.deepEqual(plan.needs.map((n) => `${n.role}:${n.name}`), [
    "picture:E02-SH01_lipsync_141.mp4", "sfx:E02-SH01_sfx.wav", "picture:E02-SH02_video_242.mp4", "voice:E02-SH02_voice_342.wav",
    "still:E02-SH03_keyframe_443.png", "narration:E02-SH03_narration_543.wav", "music:music_6.mp3", "layer:logo.png", "layer:amb.wav"]);
  assert.match(plan.warnings[0], /E02-SH02: no lip-sync for kn/);
  // an English render of the same cut: no lines in en, so the original sound of each video
  const en = episodePlan(EPISODE, LAYERS, { ...opts, lang: "en" });
  assert.deepEqual(en.shots.map((p) => [p.picture?.id, p.ownAudio, p.voice?.id ?? null]), [[241, true, null], [242, true, null], [443, false, null]]);
});

test("the sequence: V1 cut with start-aligned transitions, A1 linked sound, voices, SFX, looped music, layers, titles, markers", () => {
  const plan = episodePlan(EPISODE, LAYERS, opts);
  const { sequence: s, bin, warnings } = episodeSequence(EPISODE, LAYERS, plan, opts, itemFor);
  assert.equal(s.name, "S01E02 The river");
  assert.equal(bin.name, "S01E02 The river");
  assert.deepEqual(s.source, { pid: 1, eid: 3, lang: "kn" });
  assert.deepEqual(s.tracks.map((t) => `${t.kind[0]}${t.index}:${t.name}`),
    ["v0:V1 Shots", "v1:Logo", "v2:Titles", "a0:A1 Sound", "a1:A2 Voice", "a2:A3 Music", "a3:A4 SFX", "a4:Ambience"]);
  const tr = (name: string) => s.tracks.find((t) => t.name === name)!.id;
  const on = (name: string) => s.clips.filter((c) => c.trackId === tr(name));
  const brief = (c: TimelineClip) => [c.start, c.duration, c.source.type === "media" ? c.source.mediaId : c.source.type, c.source.type === "media" ? c.source.in : 0, c.speed];
  assert.deepEqual(on("V1 Shots").map(brief), [[0, 72, "m-l41", 0, 1], [72, 60, "m-v42", 24, 1.5], [132, 72, "m-k43", 0, 1]]);
  const [v41, v42, v43] = on("V1 Shots");
  assert.deepEqual(v41.effects.map((e) => [e.type, e.params.fx.value]), [["shotfx", { fade_in: 0.5, look: "teal_orange" }]]);
  assert.deepEqual(v42.effects, []);
  assert.deepEqual(v43.effects.map((e) => [e.type, e.params.kenburns?.value]), [["shotfx", true]]);
  assert.deepEqual(s.transitions.map((t) => [t.trackId === tr("V1 Shots"), t.at, t.duration, t.alignment, t.type, t.easing, t.fromClipId, t.toClipId]),
    [[true, 72, 24, "start", "gl:cube", "ease_in_out", v41.id, v42.id], [true, 132, 12, "start", "fade", "linear", v42.id, v43.id]]);
  const [a41] = on("A1 Sound");
  assert.equal(on("A1 Sound").length, 1);
  assert.deepEqual(brief(a41), [0, 72, "m-l41", 0, 1]);
  assert.equal(a41.linkId, v41.linkId);
  assert.ok(a41.linkId);
  assert.deepEqual(a41.audio, { gain: { value: 0 }, pan: { value: 0 }, fadeIn: 12, fadeOut: 0 });
  assert.deepEqual(on("A2 Voice").map(brief), [[72, 40, "m-kn42", 0, 1.5], [132, 48, "m-n43", 0, 1]]);
  assert.deepEqual(on("A4 SFX").map((c) => [...brief(c), c.audio!.gain.value]), [[24, 48, "m-s41", 0, 1, -8]]);
  const music = on("A3 Music");
  assert.deepEqual(music.map((c) => [c.start, c.duration, c.audio!.gain.value, c.audio!.fadeOut]), [[0, 96, -18, 0], [96, 96, -18, 0], [192, 12, -18, 12]]);
  const [logo] = on("Logo");
  assert.deepEqual(brief(logo), [24, 72, "m-logo", 0, 1]);
  assert.deepEqual(logo.motion.position, { value: [1536, 216] });
  assert.deepEqual(logo.motion.scale, { value: 20, keyframes: [{ frame: 0, value: 20, ease: "linear" }, { frame: 48, value: 30, ease: "linear" }] });
  assert.deepEqual(logo.motion.opacity, { value: 80 });
  assert.deepEqual(logo.effects[0].params.fx.value, { fade_in: 0.5 });
  const [amb] = on("Ambience");
  assert.deepEqual(brief(amb), [0, 120, "m-amb", 48000, 1]);
  assert.deepEqual(amb.audio, { gain: { value: -2 }, pan: { value: 0 }, fadeIn: 24, fadeOut: 24 });
  assert.equal(s.tracks.find((t) => t.name === "Ambience")!.volume, -3);
  const [title] = on("Titles");
  assert.equal(title.start, 12);
  assert.equal(title.duration, 48);
  assert.equal(title.source.type === "title" && title.source.text.text, "The river");
  assert.deepEqual(s.markers.map((m) => [m.frame, m.name]), [[0, "Scene 1: Dawn"], [132, "Scene 2: Night"]]);
  assert.ok(warnings.some((w) => /ducked/.test(w)));
  // missing media leave their clips out, with a warning
  const partial = episodeSequence(EPISODE, LAYERS, plan, opts, (k) => (k.includes("v42") ? undefined : itemFor(k)));
  assert.equal(partial.sequence.clips.filter((c) => c.source.type === "media" && c.source.mediaId === "m-v42").length, 0);
  assert.ok(partial.warnings.some((w) => /v42\.mp4: couldn't be fetched/.test(w)));
});

test("dimsFor follows backend ffmpeg.dims_for", () => {
  assert.deepEqual(dimsFor("16:9"), { width: 1920, height: 1080 });
  assert.deepEqual(dimsFor("9:16"), { width: 1080, height: 1920 });
  assert.deepEqual(dimsFor("1:1", 720), { width: 720, height: 720 });
});
