import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { ESRGAN, MODELS, chooseScale, encodeArgs, esrganArgs, extractArgs, fpsOf, minutesFor, outputDims, parseGpus, pickGpu } from "../src/main/aiupscale.ts";
import { PRESETS, presetDims, uhdVf } from "../src/main/render-args.ts";

test("the pinned engine is the official v0.2.5.0 Windows build", () => {
  assert.equal(ESRGAN.url, `https://github.com/xinntao/Real-ESRGAN/releases/download/v${ESRGAN.version}/${ESRGAN.file}`);
  assert.match(ESRGAN.sha256, /^[0-9a-f]{64}$/);
  assert.equal(ESRGAN.size, 45_474_481);
});

test("scale: the smallest step that reaches the target, x4plus always 4", () => {
  assert.equal(chooseScale("fast", 1920, 1080, 2160), 2);
  assert.equal(chooseScale("fast", 1920, 1080, 1440), 2);
  assert.equal(chooseScale("fast", 1280, 720, 2160), 3);
  assert.equal(chooseScale("fast", 640, 360, 2160), 4); // can't reach: the largest it has
  assert.equal(chooseScale("best", 1920, 1080, 1440), 4);
  assert.deepEqual(MODELS.best.scales, [4]);
});

test("output size keeps the shape with the target short side, even numbers", () => {
  assert.deepEqual(outputDims(1920, 1080, 2160), [3840, 2160]);
  assert.deepEqual(outputDims(1080, 1920, 2160), [2160, 3840]);
  assert.deepEqual(outputDims(1920, 1080, 1440), [2560, 1440]);
  assert.deepEqual(outputDims(1000, 1000, 1441), [1442, 1442]);
});

test("Vulkan devices from the verbose log, and the dedicated card is picked", () => {
  const log = `[0 NVIDIA GeForce GTX 1660 Ti]  queueC=2[8]  queueG=0[16]  queueT=1[2]
[0 NVIDIA GeForce GTX 1660 Ti]  bugsbn1=0  bugbilz=0
[1 Intel(R) UHD Graphics 630]  queueC=0[1]  queueG=0[1]  queueT=0[1]`;
  const gpus = parseGpus(log);
  assert.deepEqual(gpus, [{ index: 0, name: "NVIDIA GeForce GTX 1660 Ti" }, { index: 1, name: "Intel(R) UHD Graphics 630" }]);
  assert.equal(pickGpu(gpus)?.index, 0);
  assert.equal(pickGpu([{ index: 0, name: "Intel(R) UHD Graphics 630" }, { index: 1, name: "AMD Radeon RX 6700 XT" }])?.index, 1);
  assert.equal(pickGpu([{ index: 0, name: "Microsoft Basic Render Driver" }, { index: 1, name: "Intel(R) UHD Graphics 630" }])?.index, 1);
  assert.equal(pickGpu([]), null);
});

test("frame rate from ffmpeg -i, 24 when it can't tell", () => {
  assert.equal(fpsOf("Stream #0:0: Video: h264, yuv420p, 1920x1080, 4012 kb/s, 25 fps, 25 tbr"), 25);
  assert.equal(fpsOf("Stream #0:0: Video: h264, 1920x1080, 23.98 fps, 23.98 tbr"), 23.98);
  assert.equal(fpsOf("nothing"), 24);
});

test("the three steps' arguments", () => {
  assert.deepEqual(extractArgs("in.mp4", "f"), ["-i", "in.mp4", "-map", "0:v:0", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", path.join("f", "%06d.png")]);
  assert.deepEqual(esrganArgs({ inDir: "a", outDir: "b", model: "fast", scale: 2, gpu: 0 }),
    ["-i", "a", "-o", "b", "-n", "realesr-animevideov3", "-s", "2", "-g", "0", "-f", "jpg", "-j", "1:2:2"]);
  const enc = encodeArgs({ framesDir: "o", fps: 24, source: "in.mp4", out: "up.mp4", w: 3840, h: 2160, enc: ["-c:v", "hevc_nvenc"] });
  assert.deepEqual(enc.slice(0, 10), ["-framerate", "24", "-i", path.join("o", "%06d.jpg"), "-i", "in.mp4", "-map", "0:v:0", "-map", "1:a:0?"]);
  assert.ok(enc.includes("scale=3840:2160:flags=lanczos:in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p,"
    + "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"));
  assert.ok(enc.includes("hevc_nvenc") && enc.at(-1) === "up.mp4");
  assert.deepEqual(enc.slice(enc.indexOf("-colorspace"), enc.indexOf("-colorspace") + 8),
    ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]);
  assert.deepEqual(enc.slice(enc.indexOf("-c:a"), enc.indexOf("-c:a") + 2), ["-c:a", "copy"]);
});

test("time estimate from output megapixels a second", () => {
  // 144 frames of 3840×2160 at 11.1 MP/s ≈ 1.8 min, plus 12% for frames out and the encode
  assert.equal(minutesFor(144, [3840, 2160], 11.1), 2);
  assert.ok(minutesFor(144, [7680, 4320], 1.65) > 45);
});

test("2K presets: 2560×1440 for the project's shape, vertical 1440×2560, Lanczos from 1440p up", () => {
  const yt2k = PRESETS.find((p) => p.id === "yt2k")!;
  const social2k = PRESETS.find((p) => p.id === "social2k")!;
  assert.deepEqual(presetDims(yt2k, "16:9"), { w: 2560, h: 1440 });
  assert.deepEqual(presetDims(yt2k, "9:16"), { w: 1440, h: 2560 });
  assert.deepEqual(presetDims(social2k, "16:9"), { w: 1440, h: 2560 });
  assert.equal(uhdVf("scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440,setsar=1", 2560, 1440),
    "scale=2560:1440:force_original_aspect_ratio=increase:flags=lanczos,crop=2560:1440,setsar=1");
});
