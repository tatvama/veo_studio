/**
 * The edit export's sound (src/main/editor-audio.ts): which clips play, the per-clip chain (trim, reverse, speed, gain
 * keyframes, pan, fades, crossfades, delay) and the FFmpeg runs, snapshotted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EditProject, MediaItem, Sequence, TimelineClip, Track } from "../src/shared/types.ts";
import { clipChain, MIX_BATCH, mixJobs, mixPlan, panGains, pwlExpr } from "../src/main/editor-audio.ts";

const track = (id: string, kind: "video" | "audio", over: Partial<Track> = {}): Track => ({
  id, kind, name: id, index: 0, locked: false, hidden: false, muted: false, solo: false, targeted: false, syncLock: true, height: 48, volume: 0, pan: 0, ...over,
});
const med = (id: string, over: Partial<MediaItem> = {}): MediaItem => ({
  id, binId: null, name: `${id}.wav`, kind: "audio", path: `D:/m/${id}.wav`, duration: 480000, fps: 48000, width: 0, height: 0, hasAudio: true,
  audioChannels: 2, markers: [], ...over,
});
const clip = (id: string, trackId: string, start: number, duration: number, mediaId: string, inF: number, over: Partial<TimelineClip> = {}): TimelineClip => ({
  id, trackId, start, duration, source: { type: "media", mediaId, in: inF }, speed: 1, reverse: false, enabled: true, name: id,
  motion: {} as never, effects: [], audio: { gain: { value: 0 }, pan: { value: 0 }, fadeIn: 0, fadeOut: 0 }, ...over,
});

function project(clips: TimelineClip[], tracks: Track[], transitions: Sequence["transitions"] = [], media: MediaItem[] = []): { p: EditProject; s: Sequence } {
  const s: Sequence = { id: "s", name: "S", width: 1920, height: 1080, fps: 25, sampleRate: 48000, tracks, clips, transitions, markers: [], playhead: 0 };
  const p = { format: "tatvam-edit", version: 1, id: "p", name: "P", created: "", modified: "", bins: [], sequences: [s], activeSequenceId: "s",
    settings: { copyMedia: false, proxy: "off", autosaveSeconds: 10 },
    media: [med("music"), med("mono", { audioChannels: 1 }), med("vid", { kind: "video", fps: 25, duration: 250, path: "D:/m/vid.mp4" }),
      med("silent", { kind: "video", hasAudio: false, path: "D:/m/silent.mp4" }), med("gone", { missing: true }), ...media] } as EditProject;
  return { p, s };
}

const TRACKS = [track("V1", "video"), track("A1", "audio"), track("A2", "audio", { volume: -3, pan: -0.5 }), track("A3", "audio", { muted: true })];

test("which clips play: muted tracks, disabled clips, images, silent media, missing files, linked halves, video clips with sound", () => {
  const { p, s } = project([
    clip("a", "A1", 0, 50, "music", 25 * 1920),
    clip("off", "A1", 60, 10, "music", 0, { enabled: false }),
    clip("muted", "A3", 0, 50, "music", 0),
    clip("missing", "A2", 0, 50, "gone", 0),
    clip("v-linked", "V1", 0, 50, "vid", 0, { linkId: "L" }),
    clip("a-linked", "A2", 0, 50, "vid", 0, { linkId: "L" }),
    clip("v-own", "V1", 50, 50, "vid", 50),
    clip("v-noaudio", "V1", 100, 50, "silent", 0),
    clip("v-nosettings", "V1", 150, 50, "vid", 0, { audio: undefined }),
  ], TRACKS);
  const plan = mixPlan(p, s, { in: 0, out: 200 });
  assert.deepEqual(plan.clips.map((c) => c.clipId), ["a", "a-linked", "v-own"]);
  assert.match(plan.warnings[0], /missing: its media is missing/);
  assert.equal(plan.clips[0].in, 1); // 48000 source frames at 48 kHz
  // solo: only soloed audio tracks play (video-track sound too is left out)
  const solo = project(s.clips, [track("V1", "video"), track("A1", "audio"), track("A2", "audio", { solo: true }), track("A3", "audio", { muted: true })]);
  assert.deepEqual(mixPlan(solo.p, solo.s, { in: 0, out: 200 }).clips.map((c) => c.clipId), ["a-linked"]);
});

test("a clip's chain: trim, speed, gain keyframes with the track volume, mono constant-power pan, fades, delay", () => {
  const { p, s } = project([
    clip("c", "A2", 50, 100, "mono", 48000, { speed: 2,
      audio: { gain: { value: 0, keyframes: [{ frame: 0, value: -6, ease: "linear" }, { frame: 25, value: 0, ease: "hold" }, { frame: 50, value: -12, ease: "linear" }] },
        pan: { value: 0.5 }, fadeIn: 10, fadeOut: 25 } }),
  ], TRACKS);
  const [c] = mixPlan(p, s, { in: 0, out: 200 }).clips;
  assert.deepEqual([c.start, c.duration, c.in, c.speed, c.pan, c.gainDb], [2, 4, 1, 2, 0, -3]);
  assert.deepEqual(c.gainPoints, [[0, -9, "linear"], [1, -3, "hold"], [2, -15, "linear"]]);
  assert.equal(clipChain(c, "0:a", "c0", 0),
    "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:8,asetpts=PTS-STARTPTS,atempo=2.0000,"
    + "volume='pow(10,(if(lt(t,0),-9,if(lt(t,1),-9+6*(t-0)/1,if(lt(t,2),-3,-15))))/20)':eval=frame,"
    + "afade=t=in:st=0:d=0.400:curve=tri,afade=t=out:st=3.000:d=1.000:curve=tri,adelay=96000S|96000S[c0]");
});

test("stereo balance, keyframed pan (aeval), reverse, and a range that starts inside a clip", () => {
  const { p, s } = project([
    clip("r", "A1", 0, 50, "music", 0, { reverse: true, audio: { gain: { value: -2 }, pan: { value: 0.25 }, fadeIn: 0, fadeOut: 0 } }),
    clip("k", "A1", 50, 50, "music", 0, { audio: { gain: { value: 0 }, pan: { value: 0, keyframes: [{ frame: 0, value: -1, ease: "linear" }, { frame: 50, value: 1, ease: "linear" }] }, fadeIn: 0, fadeOut: 0 } }),
  ], TRACKS);
  const plan = mixPlan(p, s, { in: 25, out: 100 });
  const [r, k] = plan.clips;
  assert.equal(clipChain(r, "0:a", "c0", plan.range.start),
    "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:2,asetpts=PTS-STARTPTS,apad=whole_dur=2,areverse,volume=-2dB,"
    + "pan=stereo|c0=0.75*c0|c1=1*c1,atrim=start=1,asetpts=PTS-STARTPTS[c0]");
  assert.equal(clipChain(k, "1:a", "c1", plan.range.start),
    "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:2,asetpts=PTS-STARTPTS,"
    + "aeval=exprs='val(0)*if(gt((if(lt(t,0),-1,if(lt(t,2),-1+2*(t-0)/2,1))),0),1-(if(lt(t,0),-1,if(lt(t,2),-1+2*(t-0)/2,1))),1)"
    + "|val(1)*if(lt((if(lt(t,0),-1,if(lt(t,2),-1+2*(t-0)/2,1))),0),1+(if(lt(t,0),-1,if(lt(t,2),-1+2*(t-0)/2,1))),1)':c=stereo,adelay=48000S|48000S[c1]");
  // clips outside the range are dropped
  assert.deepEqual(mixPlan(p, s, { in: 50, out: 100 }).clips.map((c) => c.clipId), ["k"]);
});

test("crossfades: both clips run into their handles over a centred transition, constant power; an edge transition fades one clip", () => {
  const { p, s } = project([
    clip("x", "A1", 0, 50, "music", 0),
    clip("y", "A1", 50, 50, "music", 48000),
    clip("short", "A2", 50, 50, "music", 2400),
    clip("z", "A2", 100, 50, "music", 0),
  ], TRACKS, [
    { id: "t1", trackId: "A1", at: 50, duration: 10, alignment: "center", type: "audio:constant_power", easing: "linear", fromClipId: "x", toClipId: "y" },
    { id: "t2", trackId: "A2", at: 150, duration: 20, alignment: "end", type: "audio:constant_gain", easing: "linear", fromClipId: "z" },
    { id: "t4", trackId: "A2", at: 50, duration: 10, alignment: "start", type: "audio:constant_power", easing: "linear", toClipId: "short" },
    { id: "t3", trackId: "V1", at: 50, duration: 10, alignment: "center", type: "fade", easing: "linear" },
  ]);
  const byId = new Map(mixPlan(p, s, { in: 0, out: 200 }).clips.map((c) => [c.clipId, c]));
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const x = byId.get("x")!;
  const y = byId.get("y")!;
  const z = byId.get("z")!;
  const short = byId.get("short")!;
  assert.deepEqual([x.start, x.duration, x.in, x.fadeOut, x.fadeOutCurve, x.fadeIn], [0, 2.2, 0, 0.4, "qsin", 0]);
  assert.deepEqual([y.start, y.duration, r3(y.in), y.fadeIn, y.fadeInCurve], [1.8, 2.2, 0.8, 0.4, "qsin"]);
  assert.deepEqual([z.start, z.duration, z.fadeOut, z.fadeOutCurve], [4, 2, 0.8, "tri"]);
  // an edge transition only fades (no handle needed); here 50 ms of source before the in point isn't enough to extend
  assert.deepEqual([short.start, short.duration, short.fadeIn, short.fadeInCurve], [2, 2, 0.4, "qsin"]);
});

test("the FFmpeg runs: one mix, a silent one, and batches for long sequences", () => {
  const { p, s } = project([clip("a", "A1", 0, 50, "music", 0), clip("b", "A2", 25, 50, "mono", 0)], TRACKS);
  const jobs = mixJobs(mixPlan(p, s, { in: 0, out: 100 }), "D:/t/mix.wav");
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], [
    "-ss", "0", "-t", "2.05", "-i", "D:/m/music.wav",
    "-ss", "0", "-t", "2.05", "-i", "D:/m/mono.wav",
    "-filter_complex",
    "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:2,asetpts=PTS-STARTPTS[c0];"
    + "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:2,asetpts=PTS-STARTPTS,volume=-3dB,pan=stereo|c0=1.306563*c0|c1=0.541196*c1,adelay=48000S|48000S[c1];"
    + "[c0][c1]amix=inputs=2:normalize=0:duration=longest:dropout_transition=0,apad[mix]",
    "-map", "[mix]", "-ac", "2", "-ar", "48000", "-c:a", "pcm_f32le", "-t", "4.000", "D:/t/mix.wav"]);
  const silent = mixJobs(mixPlan(p, { ...s, clips: [] }, { in: 0, out: 50 }), "D:/t/s.wav", { loudnorm: "loudnorm=I=-14:TP=-1.5:LRA=11" });
  assert.deepEqual(silent, [["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000", "-ac", "2", "-ar", "48000",
    "-c:a", "pcm_f32le", "-t", "2.000", "D:/t/s.wav"]]);
  const many = Array.from({ length: MIX_BATCH * 2 + 3 }, (_, i) => clip(`m${i}`, "A1", i * 10, 10, "music", 0));
  const big = project(many, TRACKS);
  const runs = mixJobs(mixPlan(big.p, big.s, { in: 0, out: many.length * 10 }), "D:/t/mix.wav", { part: (i) => `D:/t/part${i}.wav` });
  assert.equal(runs.length, 4);
  assert.equal(runs[0].at(-1), "D:/t/part0.wav");
  assert.equal(runs[3].filter((a) => a === "-i").length, 3);
  assert.match(runs[3].join(" "), /\[0:a\]\[1:a\]\[2:a\]amix=inputs=3:normalize=0/);
});

test("pan laws and the keyframe expression", () => {
  assert.deepEqual(panGains(0, false), [1, 1]);
  assert.deepEqual(panGains(-0.5, false), [1, 0.5]);
  const [l, r] = panGains(0, true);
  assert.ok(Math.abs(l - 1) < 1e-9 && Math.abs(r - 1) < 1e-9, "constant power, unity at the centre");
  const [hl, hr] = panGains(1, true);
  assert.ok(Math.abs(hl) < 1e-9 && Math.abs(hr - Math.SQRT2) < 1e-9);
  assert.equal(pwlExpr([[0.5, 1, "ease_in_out"], [1.5, 3, "linear"]]),
    "if(lt(t,0.5),1,if(lt(t,1.5),1+2*((t-0.5)/1*(t-0.5)/1*(3-2*(t-0.5)/1)),3))");
});
