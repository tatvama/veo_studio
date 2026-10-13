/**
 * The edit export's sound (src/main/editor-audio.ts): which clips play, the per-clip chain (trim, reverse, speed, gain
 * keyframes, pan, fades, crossfades, delay) and the FFmpeg runs, snapshotted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EditProject, MediaItem, Sequence, TimelineClip, Track } from "../src/shared/types.ts";
import {
  busGraph, clipChain, clipInput, clipInputs, crossfadeCurve, RAMP_XFADE, DEFAULT_DUCK, defaultLoudness, generatorSource, isLoudnessPreset, LOUDNESS, measureArgs, MIX_BATCH, mixJobs, mixPlan,
  nextGain, normalizeArgs, panGains, previewJob, pwlExpr, stemJobs, trackRole,
} from "../src/main/editor-audio.ts";

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
  // the editor's easings (model/params.ts): the cubic in-out
  assert.equal(pwlExpr([[0.5, 1, "ease_in_out"], [1.5, 3, "linear"]]),
    "if(lt(t,0.5),1,if(lt(t,1.5),1+2*if(lt((t-0.5)/1,0.5),4*pow((t-0.5)/1,3),1-pow(-2*(t-0.5)/1+2,3)/2),3))");
});

// ── wave 3: effects on clips, tracks and the master; buses and ducking; generators; curves; stems; preview; loudness ──

const fxi = (type: string, params: Record<string, unknown>) => ({ id: type, type, enabled: true,
  params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, { value: v }])) });

test("roles: the track's, a clip's own wins, else guessed from the track name", () => {
  assert.equal(trackRole({ name: "A1", role: "music" }), "music");
  assert.equal(trackRole({ name: "Music bed" }), "music");
  assert.equal(trackRole({ name: "VO" }), "dialogue");
  assert.equal(trackRole({ name: "Dialogue 2" }), "dialogue");
  assert.equal(trackRole({ name: "Room tone" }), "ambience");
  assert.equal(trackRole({ name: "SFX" }), "sfx");
  assert.equal(trackRole({ name: "A3" }), null);
});

test("ducking: music and ambience ducked under the dialogue bus with sidechaincompress; clip, track and master effects", () => {
  const tracks = [track("V1", "video"), track("D", "audio", { name: "Dialogue", role: "dialogue", effects: [fxi("audio:compressor", { threshold: -20 })] as never }),
    track("M", "audio", { name: "A2", role: "music" }), track("X", "audio", { name: "A3" })];
  const { p, s } = project([
    clip("d1", "D", 0, 50, "music", 0, { effects: [fxi("audio:eq3", { high: 3 })] as never }),
    clip("d2", "D", 50, 50, "music", 0),
    clip("m1", "M", 0, 100, "music", 0),
    clip("amb", "X", 0, 100, "music", 0, { role: "ambience" }),
  ], tracks);
  s.masterEffects = [fxi("audio:limiter", { ceiling: -1 })] as never;
  const plan = mixPlan(p, s, { in: 0, out: 100 });
  assert.deepEqual(plan.ducking, DEFAULT_DUCK);
  assert.deepEqual(plan.clips.map((c) => [c.clipId, c.role]), [["amb", "ambience"], ["d1", "dialogue"], ["m1", "music"], ["d2", "dialogue"]]);
  const [run] = mixJobs(plan, "D:/t/mix.wav");
  const g = run[run.indexOf("-filter_complex") + 1].split(";");
  assert.equal(g[1], "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:2,asetpts=PTS-STARTPTS,highshelf=f=4000:t=q:w=0.7071:g=3[c1]");
  assert.deepEqual(g.slice(4), [
    "[c1][c3]amix=inputs=2:normalize=0:duration=longest:dropout_transition=0,acompressor=threshold=0.1:ratio=4:attack=10:release=250:makeup=1:knee=1.38038:detection=peak[t0]",
    "[c2][c0]amix=inputs=2:normalize=0:duration=longest:dropout_transition=0[bmus]",
    "[t0]asplit=2[bdlgo][bdlgsc]",
    "[bmus][bdlgsc]sidechaincompress=threshold=0.031623:ratio=8:attack=20:release=350:makeup=1[bmusd]",
    "[bdlgo][bmusd]amix=inputs=2:normalize=0:duration=longest:dropout_transition=0,alimiter=limit=0.891251:attack=5:release=50:level=0:latency=1,apad[mix]",
  ]);
  // ducking off, or custom
  assert.equal(mixPlan(p, s, { in: 0, out: 100 }, undefined, { ducking: false }).ducking, null);
  assert.deepEqual(mixPlan(p, s, { in: 0, out: 100 }, undefined, { ducking: { threshold: -40, ratio: 4 } }).ducking, { threshold: -40, ratio: 4, attack: 20, release: 350 });
});

test("effects that need a graph inside a clip chain (reverb), and on the master", () => {
  const { p, s } = project([clip("a", "A1", 0, 50, "music", 0, { effects: [fxi("audio:reverb", { preset: "hall", mix: 0.5 })] as never })], TRACKS);
  s.masterEffects = [fxi("audio:mono_to_stereo", {})] as never;
  const plan = mixPlan(p, s, { in: 0, out: 50 }, undefined, { irFile: (n) => `C:/ud/irs/${n}.wav` });
  const g = mixJobs(plan, "o.wav")[0];
  assert.equal(g[g.indexOf("-filter_complex") + 1], [
    "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:2,asetpts=PTS-STARTPTS[c0s0]",
    "[c0s0]asplit=2[x0e0d][x0e0w]",
    "amovie=filename='C\\:/ud/irs/hall.wav',aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[x0e0ir]",
    "[x0e0w][x0e0ir]afir=irnorm=-1:irgain=1[x0e0wet]",
    "[x0e0d][x0e0wet]amix=inputs=2:weights='0.5 0.5':normalize=0:duration=first[c0g0]",
    "[c0g0]anull[c0]",
    "[c0]pan=mono|c0=0.5*c0+0.5*c1,asplit=2[me0m][me0md]",
    "[me0md]adelay=delays=12:all=1[me0dl]",
    "[me0m][me0dl]amerge=inputs=2,pan=stereo|c0=c0+0.5*c1|c1=c0-0.5*c1[mfxg0]",
    "[mfxg0]apad[mfx]",
    "[mfx]anull[mix]",
  ].join(";"));
  // length-changing effects are cut (or padded) back to the clip
  const ts = project([clip("t", "A1", 0, 50, "music", 0, { effects: [fxi("audio:time_stretch", { tempo: 0.8 })] as never })], TRACKS);
  assert.match(clipChain(mixPlan(ts.p, ts.s, { in: 0, out: 50 }).clips[0], "0:a", "c0", 0), /rubberband=tempo=0\.8,apad=whole_dur=2,atrim=0:2\[c0\]$/);
});

test("generator clips: tone, sweeps, noise and DTMF as lavfi sources (registry names), level keyframes", () => {
  assert.equal(generatorSource({ generator: "tone", params: {} }, 2), "aevalsrc=exprs='0.125893*sin(2*PI*(1000*t))|0.125893*sin(2*PI*(1000*t))':s=48000:d=2");
  assert.equal(generatorSource({ generator: "tone", params: { wave: "square", frequency: 440, level: { value: -6 } } }, 1),
    "aevalsrc=exprs='0.501187*if(lt(mod((440*t),1),0.5),1,-1)|0.501187*if(lt(mod((440*t),1),0.5),1,-1)':s=48000:d=1");
  assert.match(generatorSource({ generator: "tone", params: { frequency: 100, sweepTo: 1000 } }, 4), /sin\(2\*PI\*\(100\*4\/2\.302585\*\(exp\(t\/4\*2\.302585\)-1\)\)\)/);
  assert.match(generatorSource({ generator: "tone", params: { frequency: 100, sweepTo: 300, sweep: "linear" } }, 4), /\(100\*t\+25\*t\*t\)/);
  assert.equal(generatorSource({ generator: "noise", params: {} }, 3), "anoisesrc=color=pink:amplitude=0.063096:r=48000:d=3:seed=1");
  assert.equal(generatorSource({ generator: "noise", params: { color: "velvet", density: 0.1, seed: 9 } }, 3),
    "anoisesrc=color=velvet:amplitude=0.063096:r=48000:d=3:seed=9:density=0.1");
  const dtmf = generatorSource({ generator: "dtmf", params: { digits: "1#", tone: 100, gap: 50 } }, 1);
  assert.equal(dtmf.split("|")[0], "aevalsrc=exprs='0.5*0.251189*(between(t,0,0.1)*(sin(2*PI*697*t)+sin(2*PI*1209*t))+between(t,0.15,0.25)*(sin(2*PI*941*t)+sin(2*PI*1477*t)))");
  const lv = generatorSource({ generator: "tone", params: { level: { value: -18, keyframes: [{ frame: 0, value: -40, ease: "linear" }, { frame: 25, value: -10, ease: "linear" }] } } },
    2, undefined, 25);
  assert.match(lv, /^aevalsrc=exprs='pow\(10,\(if\(lt\(t,0\),-40,if\(lt\(t,1\),-40\+30\*\(t-0\)\/1,-10\)\)\)\/20\)\*sin/);
  // on the timeline: a lavfi input instead of a file
  const g = project([clip("g", "A1", 0, 50, "music", 0, { source: { type: "generate", generator: "tone", params: { frequency: 440 } } as never })], TRACKS);
  const [c] = mixPlan(g.p, g.s, { in: 0, out: 50 }).clips;
  assert.deepEqual(clipInput(c), ["-f", "lavfi", "-i", "aevalsrc=exprs='0.125893*sin(2*PI*(440*t))|0.125893*sin(2*PI*(440*t))':s=48000:d=2"]);
});

test("audio transitions: constant power (qsin), constant gain (tri), exponential (exp), any acrossfade curve by name", () => {
  assert.equal(crossfadeCurve("audio:constant_power"), "qsin");
  assert.equal(crossfadeCurve("audio:constant_gain"), "tri");
  assert.equal(crossfadeCurve("audio:exponential"), "exp");
  assert.equal(crossfadeCurve("audio:hsin"), "hsin");
  assert.equal(crossfadeCurve("audio:whatever"), "qsin");
  const { p, s } = project([clip("x", "A1", 0, 50, "music", 0), clip("y", "A1", 50, 50, "music", 48000)], TRACKS,
    [{ id: "t", trackId: "A1", at: 50, duration: 10, alignment: "center", type: "audio:exponential", easing: "linear", fromClipId: "x", toClipId: "y" }]);
  const [x, y] = mixPlan(p, s, { in: 0, out: 100 }).clips;
  assert.deepEqual([x.fadeOutCurve, y.fadeInCurve], ["exp", "exp"]);
});

test("stems: one track over the whole sequence from frame 0, ignoring mute / solo, master and ducking; effects optional", () => {
  const tracks = [track("V1", "video"), track("A1", "audio", { muted: true, effects: [fxi("audio:gain", { gain: -3 })] as never }), track("A2", "audio", { solo: true })];
  const { p, s } = project([clip("a", "A1", 25, 50, "music", 0, { effects: [fxi("audio:eq3", { low: 2 })] as never }), clip("b", "A2", 0, 100, "music", 0)], tracks);
  s.masterEffects = [fxi("audio:limiter", {})] as never;
  const [run] = stemJobs(p, s, "A1", "D:/t/A1.wav");
  assert.deepEqual(run.slice(0, 6), ["-ss", "0", "-t", "2.05", "-i", "D:/m/music.wav"]);
  assert.equal(run[run.indexOf("-filter_complex") + 1],
    "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:2,asetpts=PTS-STARTPTS,lowshelf=f=200:t=q:w=0.7071:g=2,adelay=48000S|48000S[c0];"
    + "[c0]volume=-3dB[t0];[t0]apad[mix]");
  assert.deepEqual(run.slice(-3), ["-t", "4.000", "D:/t/A1.wav"]);
  const [dry] = stemJobs(p, s, "A1", "D:/t/A1.wav", { effects: false });
  assert.equal(dry[dry.indexOf("-filter_complex") + 1], "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:2,asetpts=PTS-STARTPTS,adelay=48000S|48000S[c0];[c0]apad[mix]");
  assert.throws(() => stemJobs(p, s, "nope", "x.wav"), /isn't in the sequence/);
});

test("the audio preview job: trims, speed, reverse and effects baked in; no gain, pan, fades, track or master", () => {
  const tracks = [track("V1", "video"), track("A1", "audio", { volume: -6, pan: 0.5, effects: [fxi("audio:gain", { gain: -3 })] as never })];
  const { p, s } = project([clip("a", "A1", 25, 50, "music", 96000, { speed: 2, audio: { gain: { value: -9 }, pan: { value: -1 }, fadeIn: 10, fadeOut: 10 },
    effects: [fxi("audio:pitch_shift", { semitones: 2 })] as never })], tracks);
  const j = previewJob(p, s, "a", "D:/c/a.wav");
  assert.deepEqual(j.args, ["-ss", "2", "-t", "4.05", "-i", "D:/m/music.wav", "-filter_complex",
    "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:4,asetpts=PTS-STARTPTS,atempo=2.0000,rubberband=pitch=1.122462:formant=preserved:pitchq=quality[out]",
    "-map", "[out]", "-ac", "2", "-ar", "48000", "-c:a", "pcm_f32le", "-t", "2.000", "D:/c/a.wav"]);
  assert.equal(j.duration, 2);
  assert.throws(() => previewJob(p, s, "zzz", "x.wav"), /isn't in the sequence/);
});

test("loudness presets: targets, the default by preset, measure and normalise arguments, the correction loop", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(LOUDNESS).map(([k, v]) => [k, [v.lufs, v.truePeak]])),
    { youtube: [-14, -1], instagram: [-14, -1], spotify: [-14, -1], apple: [-16, -1], ebu_r128: [-23, -1], ott: [-24, -2] });
  assert.equal(defaultLoudness("broadcast1080"), "ebu_r128");
  assert.equal(defaultLoudness("yt4k"), "youtube");
  assert.ok(isLoudnessPreset("off") && isLoudnessPreset("apple") && !isLoudnessPreset("loud"));
  assert.deepEqual(measureArgs("m.wav"), ["-nostats", "-i", "m.wav", "-af", "ebur128=peak=true", "-f", "null", "-"]);
  assert.deepEqual(normalizeArgs("m.wav", "n.wav", 7.31, -1.5), ["-i", "m.wav", "-af",
    "volume=7.31dB,aresample=192000,alimiter=limit=0.841395:attack=1:release=60:level=0:latency=1,aresample=48000", "-ac", "2", "-ar", "48000", "-c:a", "pcm_f32le", "n.wav"]);
  assert.equal(nextGain(0, -21.3, -14), 7.3);
  assert.equal(nextGain(7.3, -14.2, -14), null);
  assert.equal(nextGain(7.3, -14.6, -14), 7.9);
  assert.equal(nextGain(0, -70, -14), null); // silence
});

test("busGraph alone: roles inside one track split into their own sums", () => {
  const g: string[] = [];
  const out = busGraph([{ label: "c0", trackId: "T", role: "dialogue" }, { label: "c1", trackId: "T", role: "music" }],
    [{ id: "T", name: "Mixed", role: null, fx: [] }], DEFAULT_DUCK, g);
  assert.deepEqual(g, ["[c0]asplit=2[bdlgo][bdlgsc]", "[c1][bdlgsc]sidechaincompress=threshold=0.031623:ratio=8:attack=20:release=350:makeup=1[bmusd]"]);
  assert.equal(out, "[bdlgo][bmusd]amix=inputs=2:normalize=0:duration=longest:dropout_transition=0,apad");
});

test("speed ramps: constant-speed pieces (as the engine draws them), each its own input, 4 ms crossfades, freezes silent, reversed pieces", () => {
  // 100 % for 25 frames, a freeze for 25, then 200 %
  const ramp = { value: 100, keyframes: [{ frame: 0, value: 100, ease: "hold" as const }, { frame: 25, value: 0, ease: "hold" as const }, { frame: 50, value: 200, ease: "hold" as const }] };
  const { p, s } = project([clip("r", "A1", 0, 75, "music", 48000, { timeRemap: ramp })], TRACKS);
  const [c] = mixPlan(p, s, { in: 0, out: 75 }).clips;
  assert.deepEqual(c.pieces, [
    { at: 0, dur: 1, in: 1, speed: 1, reverse: false, fadeIn: 0, fadeOut: 0 },
    { at: 2, dur: 1, in: 2, speed: 2, reverse: false, fadeIn: 0, fadeOut: 0 },
  ]);
  assert.deepEqual(clipInputs(c), [["-ss", "1", "-t", "1.05", "-i", "D:/m/music.wav"], ["-ss", "2", "-t", "2.05", "-i", "D:/m/music.wav"]]);
  const [run] = mixJobs(mixPlan(p, s, { in: 0, out: 75 }), "o.wav");
  assert.equal(run[run.indexOf("-filter_complex") + 1], [
    "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:1,asetpts=PTS-STARTPTS[c0q0]",
    "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:2,asetpts=PTS-STARTPTS,atempo=2.0000,adelay=96000S|96000S[c0q1]",
    "[c0q0][c0q1]amix=inputs=2:normalize=0:duration=longest:dropout_transition=0,apad=whole_dur=3,atrim=0:3[c0r]",
    "[c0r]anull[c0]",
    "[c0]apad[mix]"].join(";"));
  // a smooth ramp: neighbouring pieces overlap by 4 ms with linear fades, the source advances by the ramp's integral
  const smooth = project([clip("s", "A1", 0, 50, "music", 0, { timeRemap: { value: 100, keyframes: [{ frame: 0, value: 50, ease: "linear" }, { frame: 49, value: 150, ease: "linear" }] } })], TRACKS);
  const [sc] = mixPlan(smooth.p, smooth.s, { in: 0, out: 50 }).clips;
  const ps = sc.pieces!;
  assert.ok(ps.length > 2 && ps.length <= 12, `${ps.length} pieces`);
  assert.deepEqual([ps[0].fadeIn, ps[0].fadeOut, ps[1].fadeIn, ps.at(-1)!.fadeOut], [0, RAMP_XFADE, RAMP_XFADE, 0]);
  for (let k = 1; k < ps.length; k++) {
    const prevEnd = ps[k - 1].at + ps[k - 1].dur;
    assert.ok(Math.abs(prevEnd - ps[k].at - RAMP_XFADE) < 1e-6, "pieces overlap by the crossfade");
  }
  assert.ok(ps[0].speed < 0.6 && ps.at(-1)!.speed > 1.3);
  // reversed: every piece reads its region backwards, the first piece from the end of the source the clip uses
  const rev = project([clip("v", "A1", 0, 50, "music", 0, { reverse: true, timeRemap: { value: 100, keyframes: [{ frame: 0, value: 50, ease: "hold" }, { frame: 25, value: 100, ease: "hold" }] } })], TRACKS);
  const [vc] = mixPlan(rev.p, rev.s, { in: 0, out: 50 }).clips;
  assert.deepEqual(vc.pieces!.map((x) => [x.at, Math.round(x.dur * 1e4) / 1e4, Math.round(x.in * 1e4) / 1e4, x.speed, x.reverse]),
    [[0, 1.002, 0.999, 0.5, true], [0.998, 1.002, 0, 1, true]]);
  assert.match(clipChain(vc, ["0:a", "1:a"], "c0", 0), /atrim=0:0\.501,asetpts=PTS-STARTPTS,apad=whole_dur=0\.501,areverse,atempo=0\.5000,afade=t=out/);
  // all frozen: silent
  const frozen = project([clip("f", "A1", 0, 50, "music", 0, { timeRemap: { value: 0 } })], TRACKS);
  assert.deepEqual(mixPlan(frozen.p, frozen.s, { in: 0, out: 50 }).clips, []);
});

test("nested sequences: the inner sequence mixed (its effects, buses, master), then the nested clip's effects, gain keyframes, pan and fades", () => {
  const { p, s } = project([], TRACKS);
  const inner: Sequence = { id: "inner", name: "Inner", width: 1920, height: 1080, fps: 25, sampleRate: 48000, markers: [], playhead: 0, transitions: [],
    tracks: [track("iA1", "audio", { role: "dialogue" }), track("iA2", "audio", { role: "music" })],
    clips: [clip("i1", "iA1", 0, 100, "music", 0, { effects: [fxi("audio:eq3", { low: 2 })] as never }), clip("i2", "iA2", 0, 100, "music", 0)],
    masterEffects: [fxi("audio:gain", { gain: -1 })] as never };
  p.sequences.push(inner);
  s.clips = [clip("n", "A1", 25, 50, "music", 0, { source: { type: "nested", sequenceId: "inner", in: 10 } as never,
    audio: { gain: { value: 0, keyframes: [{ frame: 0, value: -12, ease: "linear" }, { frame: 25, value: 0, ease: "linear" }] }, pan: { value: 0 }, fadeIn: 0, fadeOut: 5 },
    effects: [fxi("audio:compressor", {})] as never })];
  const plan = mixPlan(p, s, { in: 0, out: 100 });
  const [run] = mixJobs(plan, "o.wav");
  assert.equal(run.filter((a) => a === "-i").length, 2);
  // the inner clips start before the nested clip's in point (frame 10 = 0.4 s): read from 0 and trimmed in the graph
  assert.deepEqual(run.slice(0, 5), ["-ss", "0", "-t", "4.05", "-i"]);
  assert.equal(run[run.indexOf("-filter_complex") + 1], [
    "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:4,asetpts=PTS-STARTPTS,lowshelf=f=200:t=q:w=0.7071:g=2,atrim=start=0.4,asetpts=PTS-STARTPTS[c0n0]",
    "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:4,asetpts=PTS-STARTPTS,atrim=start=0.4,asetpts=PTS-STARTPTS[c0n1]",
    "[c0n0]asplit=2[c0_bdlgo][c0_bdlgsc]",
    "[c0n1][c0_bdlgsc]sidechaincompress=threshold=0.031623:ratio=8:attack=20:release=350:makeup=1[c0_bmusd]",
    "[c0_bdlgo][c0_bmusd]amix=inputs=2:normalize=0:duration=longest:dropout_transition=0,volume=-1dB,apad,atrim=0:2[c0sum]",
    "[c0sum]acompressor=threshold=0.063096:ratio=4:attack=10:release=250:makeup=1:knee=1.38038:detection=peak,"
      + "volume='pow(10,(if(lt(t,0),-12,if(lt(t,1),-12+12*(t-0)/1,0)))/20)':eval=frame,afade=t=out:st=1.800:d=0.200:curve=tri,adelay=48000S|48000S[c0]",
    "[c0]apad[mix]"].join(";"));
  // a sequence that contains itself is left out with a warning
  s.clips.push(clip("loop", "A2", 0, 10, "music", 0, { source: { type: "nested", sequenceId: "s", in: 0 } as never }));
  assert.match(mixPlan(p, s, { in: 0, out: 100 }).warnings.join(" "), /contains itself/);
});

test("multicam clips hear their audio angle (audio track audioAngle, else angle, of the multicam sequence)", () => {
  const { p, s } = project([], TRACKS);
  const mc: Sequence = { id: "mc", name: "Multicam", width: 1920, height: 1080, fps: 25, sampleRate: 48000, markers: [], playhead: 0, transitions: [],
    tracks: [track("ma1", "audio"), { ...track("ma2", "audio"), index: 1 }], clips: [clip("cam1", "ma1", 0, 100, "music", 0), clip("cam2", "ma2", 0, 100, "mono", 0)],
    multicam: { angles: [{ name: "A" }, { name: "B" }], syncedBy: "audio" } };
  p.sequences.push(mc);
  s.clips = [clip("m", "A1", 0, 50, "music", 0, { source: { type: "nested", sequenceId: "mc", in: 0 } as never, multicam: { angle: 0, audioAngle: 1 } })];
  const [c] = mixPlan(p, s, { in: 0, out: 50 }).clips;
  assert.deepEqual(c.nested!.clips.map((x) => x.file), ["D:/m/mono.wav"]);
  s.clips[0].multicam = { angle: 0 };
  assert.deepEqual(mixPlan(p, s, { in: 0, out: 50 }).clips[0].nested!.clips.map((x) => x.file), ["D:/m/music.wav"]);
});
