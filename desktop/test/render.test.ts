/**
 * The local render's FFmpeg builders against the server pipeline. The SERVER_* strings were captured from
 * backend/app/pipeline/ffmpeg.py + layers.py (run() monkeypatched) for the same inputs; the desktop may only differ
 * where docs/DESKTOP.md §4.1 says so (hardware intermediates, lanczos at 2160p, local-upscale unsharp, final encoder).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PRESETS, STAB_TRANSFORM, atempoChain, concatList, escPath, finalArgs, finalEncoder, fitFilter, intermediateEncoder, mixArgs, musicBedArgs,
  overlayArgs, presetDims, presetList, segmentArgs, stabilizeDetectArgs, stepWeights, stillArgs, substituteLuts, uhdVf, xfadeArgs,
  type PlanSegment, type RenderPlan,
} from "../src/main/render-args.ts";
import { planKeys } from "../src/main/render.ts";

/** Python prints -3.0dB / d=1.0 where JS prints -3dB / d=1: the same to FFmpeg. */
const norm = (s: string) => s.replace(/(\d+)\.0(?!\d)/g, "$1");
const fc = (args: string[]) => args[args.indexOf("-filter_complex") + 1];

const SERVER_NORMALIZE_FC = "[1:a]aresample=48000,aformat=channel_layouts=stereo,apad[a1];[2:a]aresample=48000,aformat=channel_layouts=stereo,volume=-3.0dB,adelay=500|500,apad[a2];[a1][a2]amix=inputs=2:normalize=0:duration=longest[am];[am]atempo=1.5000,afade=t=in:st=0:d=0.5,apad[afx];[0:v]setpts=(PTS-STARTPTS)/1.5,scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160:'max(0,min(iw-ow,iw*0.5000-ow/2))':'max(0,min(ih-oh,ih*0.4200-oh/2))',setsar=1,fps=24,hflip,eq=contrast=1.12,fade=t=in:st=0:d=0.5,format=yuv420p,tpad=stop_mode=clone:stop_duration=30[vv]";
const SERVER_NORMALIZE_VF = "setpts=(PTS-STARTPTS)/1.5,scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160:'max(0,min(iw-ow,iw*0.5000-ow/2))':'max(0,min(ih-oh,ih*0.4200-oh/2))',setsar=1,fps=24,hflip,eq=contrast=1.12,fade=t=in:st=0:d=0.5,format=yuv420p,tpad=stop_mode=clone:stop_duration=30";
const SERVER_PLAIN_FC = "[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=-6.0dB,apad[a0];[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=30[vv]";
const SERVER_STILL_VF = "scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,zoompan=z='min(zoom+0.0009,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=72:s=1920x1080:fps=24,setsar=1";
const SERVER_XFADE_FC = "[0:v]setpts=PTS-STARTPTS,settb=AVTB,fps=24,format=yuv420p[v0];[0:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a0];[1:v]setpts=PTS-STARTPTS,settb=AVTB,fps=24,format=yuv420p[v1];[1:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a1];[2:v]setpts=PTS-STARTPTS,settb=AVTB,fps=24,format=yuv420p[v2];[2:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a2];[v0][v1]xfade=transition=fade:duration=0.500:offset=3.500[vx1];[a0][a1]acrossfade=d=0.500:c1=tri:c2=tri[ax1];[vx1][ax1][v2][a2]concat=n=2:v=1:a=1[vx2c][ax2];[vx2c]fps=24[vx2]";
const SERVER_MUSIC = ["-stream_loop", "-1", "-i", "m.mp3", "-i", "voice.wav", "-filter_complex", "[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=-16.0dB,atrim=0:30.000,afade=t=out:st=28.000:d=2[m];[1:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[sc][vo];[m][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350[md];[md][vo]amix=inputs=2:normalize=0:duration=first[out]", "-map", "[out]", "-t", "30.000", "-ar", "48000", "mixed.wav"];
const SERVER_MIX = ["-i", "voice.wav", "-ss", "1.000", "-t", "3.000", "-i", "s.wav", "-filter_complex", "[0:a]aresample=48000,aformat=channel_layouts=stereo[a0];[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=-2.0dB,afade=t=in:st=0:d=0.5,afade=t=out:st=2.000:d=1.0,adelay=2000|2000[a1];[a0][a1]amix=inputs=2:normalize=0:duration=first[m]", "-map", "[m]", "-t", "30.000", "-ar", "48000", "-ac", "2", "vl.wav"];
const SERVER_OVERLAY_GRAPH = "[1:v]setpts=PTS-STARTPTS+1.000/TB,scale=384:-2,format=yuva420p,colorchannelmixer=aa=0.800[p1];[0:v][p1]overlay=x='main_w*0.8000-overlay_w/2':y='main_h*0.2000-overlay_h/2':enable='between(t,1.000,4.000)':eof_action=pass[b1]";

const NV = { h264_nvenc: true, hevc_nvenc: true, hevc_nvenc_10bit: true, av1_nvenc: false, libx264: true, libx265: true, prores_ks: true };
const NONE = { libx264: true, libx265: true, prores_ks: true };

function seg(over: Partial<PlanSegment> = {}): PlanSegment {
  return { shot_id: 41, code: "E02-SH03", source: "projects/1/shots/41/video/a.mp4", source_kind: "video", upscaled: false, duration: 6, trim_in: 0.2,
    speed: 1.5, seg_len: 4, audio_override: "projects/1/v.wav", extra_audio: [{ key: "projects/1/n.wav", offset: 0.5, gain_db: -3 }], keep_src_audio: true,
    src_gain_db: 0, has_audio: true, pre: "setpts=(PTS-STARTPTS)/1.5,", stabilize: false, center: [0.5, 0.42], kenburns: false,
    vf_post: "hflip,eq=contrast=1.12,fade=t=in:st=0:d=0.5,format=yuv420p", af_fx: "atempo=1.5000,afade=t=in:st=0:d=0.5", transition: null, ...over };
}

test("helpers: escaping, LUT marks, atempo, fit", () => {
  assert.equal(escPath("C:\\Users\\a'b\\x.cube"), "C\\:/Users/a\\'b/x.cube");
  assert.equal(substituteLuts("lut3d=file='@@LUT_3@@':interp=tetrahedral", { 3: "D:\\luts\\teal.cube" }), "lut3d=file='D\\:/luts/teal.cube':interp=tetrahedral");
  assert.equal(substituteLuts("lut3d=file='@@LUT_9@@'", {}), "lut3d=file='@@LUT_9@@'");
  assert.equal(atempoChain(1.5), "atempo=1.5000");
  assert.equal(atempoChain(3), "atempo=2.0,atempo=1.5000");
  assert.equal(atempoChain(0.25), "atempo=0.5,atempo=0.5000");
  assert.equal(fitFilter(1920, 1080), "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1");
  assert.match(fitFilter(3840, 2160), /increase:flags=lanczos,crop/);
});

test("uhdVf adds lanczos to every fixed-size scale at 2160p and unsharp after the framing", () => {
  const vf = uhdVf(SERVER_NORMALIZE_VF, 3840, 2160, true);
  assert.equal(vf, SERVER_NORMALIZE_VF.replace("force_original_aspect_ratio=increase", "force_original_aspect_ratio=increase:flags=lanczos")
    .replace("setsar=1,", "setsar=1,unsharp=5:5:0.5,"));
  assert.equal(uhdVf(SERVER_NORMALIZE_VF, 1920, 1080, true), SERVER_NORMALIZE_VF); // nothing below 2160p
  assert.equal(uhdVf("scale=7680:4320,zoompan=z='1'", 3840, 2160), "scale=7680:4320:flags=lanczos,zoompan=z='1'");
  assert.equal(uhdVf("scale=7680:4320:flags=bicubic", 3840, 2160), "scale=7680:4320:flags=bicubic");
});

test("a video segment matches the server's normalize_clip (with the plan's vf and without)", () => {
  const ctx = { w: 3840, h: 2160, fps: 24, src: "src.mp4", out: "seg.mp4", enc: ["-c:v", "libx264"], override: "voice.wav",
    extra: [{ path: "narr.wav", offset: 0.5, gain_db: -3 }], hasAudio: true, luts: {} };
  const withVf = segmentArgs(seg({ vf: SERVER_NORMALIZE_VF }), ctx);
  const lanczos = (s: string) => s.replace("force_original_aspect_ratio=increase", "force_original_aspect_ratio=increase:flags=lanczos");
  assert.equal(norm(fc(withVf)), norm(lanczos(SERVER_NORMALIZE_FC)));
  assert.deepEqual(withVf.slice(0, 10), ["-ss", "0.200", "-t", "6.500", "-i", "src.mp4", "-i", "voice.wav", "-i", "narr.wav"]);
  assert.deepEqual(withVf.slice(-14), ["-map", "[vv]", "-map", "[afx]", "-t", "4.000", "-c:v", "libx264", "-c:a", "aac", "-ar", "48000", "-ac", "2", "seg.mp4"].slice(-14));
  const rebuilt = segmentArgs(seg(), ctx); // an older plan without `vf`
  assert.equal(norm(fc(rebuilt)), norm(lanczos(SERVER_NORMALIZE_FC)));
  // plain 1080p clip, source sound at -6 dB
  const plain = segmentArgs(seg({ trim_in: 0, speed: 1, seg_len: 5, audio_override: null, extra_audio: [], src_gain_db: -6, pre: "", center: null, vf_post: "", af_fx: "" }),
    { ...ctx, w: 1920, h: 1080, override: null, extra: [] });
  assert.equal(norm(fc(plain)), norm(SERVER_PLAIN_FC));
});

test("local upscale sharpens only shots without an AI upscale; stabilising prepends the transform", () => {
  const ctx = { w: 3840, h: 2160, fps: 24, src: "s.mp4", out: "o.mp4", enc: [], hasAudio: false, luts: {}, localUpscale: true };
  assert.match(fc(segmentArgs(seg({ vf: SERVER_NORMALIZE_VF }), ctx)), /setsar=1,unsharp=5:5:0\.5,fps=24/);
  assert.doesNotMatch(fc(segmentArgs(seg({ vf: SERVER_NORMALIZE_VF, upscaled: true }), ctx)), /unsharp=5:5:0\.5/);
  const trf = "D:\\p\\Cache\\render-1\\seg_0.trf";
  const st = fc(segmentArgs(seg({ vf: SERVER_NORMALIZE_VF, stabilize: true }), { ...ctx, trf, stabTransform: STAB_TRANSFORM }));
  assert.ok(st.includes("[0:v]vidstabtransform=input='D\\:/p/Cache/render-1/seg_0.trf':smoothing=12:zoom=2,unsharp=5:5:0.6,setpts=(PTS-STARTPTS)/1.5,"), st);
  const det = stabilizeDetectArgs(seg(), "s.mp4", trf, "vidstabdetect=shakiness=6:accuracy=12:result='@@TRF@@'");
  assert.deepEqual(det, ["-ss", "0.200", "-t", "6.500", "-i", "s.mp4", "-vf", "vidstabdetect=shakiness=6:accuracy=12:result='D\\:/p/Cache/render-1/seg_0.trf'", "-f", "null", "-"]);
  // no source sound and nothing else: silence
  assert.match(fc(segmentArgs(seg({ audio_override: null, extra_audio: [], af_fx: "", speed: 1 }), { ...ctx, override: null, extra: [] })), /^\[1:a\]apad\[a1\];\[0:v\]/);
});

test("a still matches the server's still_to_video", () => {
  const a = stillArgs({ image: "kf.png", out: "still.mp4", seconds: 3, w: 1920, h: 1080, fps: 24, audio: "v.wav", kenburns: true, vf: SERVER_STILL_VF, enc: ["-c:v", "libx264"] });
  assert.deepEqual(a.slice(0, 14), ["-loop", "1", "-framerate", "24", "-i", "kf.png", "-i", "v.wav", "-t", "3.000", "-vf", SERVER_STILL_VF, "-map", "0:v"]);
  assert.equal(a[a.indexOf("-af") + 1], "apad,atrim=0:3.000");
  const rebuilt = stillArgs({ image: "kf.png", out: "still.mp4", seconds: 3, w: 1920, h: 1080, fps: 24, audio: "v.wav", kenburns: true, enc: [] });
  assert.equal(rebuilt[rebuilt.indexOf("-vf") + 1], SERVER_STILL_VF);
  const silent = stillArgs({ image: "kf.png", out: "o.mp4", seconds: 2, w: 3840, h: 2160, fps: 24, kenburns: false, enc: [] });
  assert.deepEqual(silent.slice(6, 10), ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]);
  assert.match(silent[silent.indexOf("-vf") + 1], /^scale=3840:2160:force_original_aspect_ratio=increase:flags=lanczos,crop=3840:2160,setsar=1,fps=24$/);
});

test("join, sound layers, music bed and picture layers match the server", () => {
  const x = xfadeArgs(["a.mp4", "b.mp4", "c.mp4"], [4, 3, 5], [null, ["fade", 0.5], null], "body.mp4", 24, ["-c:v", "h264_nvenc"])!;
  assert.equal(fc(x), SERVER_XFADE_FC);
  assert.equal(xfadeArgs(["a.mp4", "b.mp4"], [4, 3], [null, null], "body.mp4", 24, []), null);
  assert.equal(concatList(["D:\\x\\a.mp4", "/tmp/it's.mp4"]), "file 'D:/x/a.mp4'\nfile '/tmp/it'\\''s.mp4'\n");
  assert.deepEqual(musicBedArgs("m.mp3", "voice.wav", "mixed.wav", 30, -16, true).map(norm), SERVER_MUSIC.map(norm));
  assert.deepEqual(mixArgs("voice.wav", [{ key: "k", path: "s.wav", start: 2, in: 1, dur: 3, gain_db: -2, fade_in: 0.5, fade_out: 1 }], 30, "vl.wav")!.map(norm), SERVER_MIX.map(norm));
  assert.equal(mixArgs("voice.wav", [{ key: "k", path: "s.wav", start: 0, in: 0, dur: 1, has_audio: false }], 30, "o.wav"), null);
  const o = overlayArgs("body.mp4", [{ key: "k", path: "logo.png", kind: "image", start: 1, in: 0, dur: 3,
    chain: ["setpts=PTS-STARTPTS+1.000/TB", "scale=384:-2", "format=yuva420p", "colorchannelmixer=aa=0.800"], x: "main_w*0.8000-overlay_w/2", y: "main_h*0.2000-overlay_h/2" }],
    "out.mp4", ["-c:v", "libx264"]);
  assert.deepEqual(o.slice(0, 10), ["-i", "body.mp4", "-loop", "1", "-framerate", "24", "-t", "3.000", "-i", "logo.png"]);
  assert.equal(fc(o), SERVER_OVERLAY_GRAPH);
  assert.deepEqual(o.slice(-6), ["-map", "[b1]", "-an", "-c:v", "libx264", "out.mp4"]);
});

test("encoders: intermediates and per-preset finals follow NVENC → QSV → AMF → software", () => {
  assert.deepEqual(intermediateEncoder(NV).args, ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "16", "-b:v", "0", "-profile:v", "high", "-pix_fmt", "yuv420p"]);
  assert.deepEqual(intermediateEncoder(NONE).args, ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p"]);
  assert.equal(intermediateEncoder({ h264_qsv: true }).name, "h264_qsv");
  assert.equal(intermediateEncoder(NV, "software").name, "libx264");
  const p = (id: string) => PRESETS.find((x) => x.id === id)!;
  const yt = finalEncoder(p("yt4k"), NV)!;
  assert.equal(yt.name, "hevc_nvenc");
  assert.ok(yt.args.join(" ").includes("-profile:v main10 -pix_fmt p010le"));
  assert.ok(yt.args.join(" ").includes("-cq 19"));
  assert.equal(finalEncoder(p("yt4k"), { ...NV, hevc_nvenc_10bit: false })!.name, "libx265");
  assert.ok(finalEncoder(p("yt4k"), NONE)!.args.includes("yuv420p10le"));
  assert.equal(finalEncoder(p("yt4k"), NV, "auto", false)!.args.includes("main10"), false);
  assert.deepEqual(finalEncoder(p("master_prores"), NV)!.args, ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", "-vendor", "apl0"]);
  assert.ok(finalEncoder(p("broadcast1080"), NV)!.args.join(" ").includes("-rc cbr -b:v 50M -maxrate 50M -bufsize 100M"));
  assert.ok(finalEncoder(p("broadcast1080"), NONE)!.args.join(" ").includes("nal-hrd=cbr"));
  assert.equal(finalEncoder(p("av1_4k"), NV), null);
  assert.equal(finalEncoder(p("av1_4k"), { av1_nvenc: true })!.name, "av1_nvenc");
  const list = presetList(NV);
  assert.ok(!list.some((x) => x.id === "av1_4k"), "AV1 hidden when the probe fails");
  assert.equal(list.find((x) => x.id === "yt4k")!.hardware, "hevc_nvenc");
  assert.equal(list.find((x) => x.id === "master_prores")!.hardware, false);
  assert.equal(list.find((x) => x.id === "broadcast1080")!.fps, 25);
  assert.equal(list.find((x) => x.id === "yt4k")!.fps, 24);
});

test("preset sizes follow the project aspect", () => {
  const p = (id: string) => PRESETS.find((x) => x.id === id)!;
  assert.deepEqual(presetDims(p("yt4k"), "16:9"), { w: 3840, h: 2160 });
  assert.deepEqual(presetDims(p("yt4k"), "9:16"), { w: 2160, h: 3840 });
  assert.deepEqual(presetDims(p("yt4k"), "1:1"), { w: 2160, h: 2160 });
  assert.deepEqual(presetDims(p("review1080"), "9:16"), { w: 1080, h: 1920 });
  assert.deepEqual(presetDims(p("social4k"), "16:9"), { w: 2160, h: 3840 });
});

test("final mux: loudnorm, burned ASS with shaping, preset encoder, ProRes audio", () => {
  const a = finalArgs({ video: "body.mp4", audio: "mixed.wav", out: "final.mp4", ass: "D:\\p\\Cache\\captions.ass", loudnorm: "loudnorm=I=-14:TP=-1.5:LRA=11",
    encoder: ["-c:v", "hevc_nvenc"], container: "mp4" });
  assert.deepEqual(a, ["-i", "body.mp4", "-i", "mixed.wav", "-vf", "ass='D\\:/p/Cache/captions.ass':shaping=complex", "-c:v", "hevc_nvenc", "-map", "0:v", "-map", "1:a",
    "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-shortest", "final.mp4"]);
  const m = finalArgs({ video: "b.mp4", audio: "a.wav", out: "f.mov", encoder: ["-c:v", "prores_ks"], container: "mov", fps: 25 });
  assert.ok(!m.includes("-vf"));
  assert.ok(m.join(" ").includes("-r 25"));
  assert.ok(m.join(" ").includes("-c:a pcm_s24le"));
});

test("step weights sum to 1 and plan keys are collected", () => {
  const plan: RenderPlan = { episode_id: 3, lang: "kn", w: 3840, h: 2160, fps: 24, segments: [seg(), seg({ source: "projects/1/b.mp4", transition: ["fade", 0.5] })],
    end_card: { key: "projects/1/desktop/end.png", seconds: 3 }, layers: { pics: [{ key: "projects/1/l.png", kind: "image", start: 0, in: 0, dur: 1, chain: [], x: "0", y: "0" }], sounds: [] },
    music: { key: "projects/1/m.mp3" }, luts: { 3: "projects/1/luts/3.cube" }, keys: ["projects/1/shots/41/video/a.mp4"] };
  const w = stepWeights(plan, { music: true });
  assert.ok(Math.abs(w.reduce((s, x) => s + x.weight, 0) - 1) < 1e-9);
  assert.deepEqual(w.map((x) => x.id), ["prepare", "seg0", "seg1", "endcard", "join", "voice", "layers", "music", "final"]);
  assert.deepEqual(planKeys(plan).sort(), ["projects/1/b.mp4", "projects/1/desktop/end.png", "projects/1/l.png", "projects/1/luts/3.cube", "projects/1/m.mp3",
    "projects/1/n.wav", "projects/1/shots/41/video/a.mp4", "projects/1/v.wav"]);
});
