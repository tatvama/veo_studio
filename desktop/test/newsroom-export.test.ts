/**
 * News Room delivery on the desktop (src/main/newsroom/export.ts, RenderManager.startNews): option checks, sizes per
 * ratio, output names, the FFmpeg commands per format, the legal-range limiter, and — when FFmpeg is found — real
 * encodes through the RenderManager queue with a fake GPU render window that hands over synthetic frames (RGBA for
 * ProRes 4444 / WebM / PNG, I420 for an mp4 with the TV options). Temp folders only.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EditProject, GpuRenderJob, Sequence } from "../src/shared/types.ts";
import { locateFfmpeg } from "../src/main/ffmpeg.ts";
import {
  alphaArgs, checkNewsOptions, defaultNewsPreset, exportGraphics, newsOutPath, NEWS_CODECS, ratioDims, ratioTag, withGenerated,
  type NewsRenderInput,
} from "../src/main/newsroom/export.ts";
import { gpuFinalArgs, legalRange } from "../src/main/render-args.ts";
import { RenderManager } from "../src/main/render.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), "tatvam-news-export-"));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));

const W = 64, H = 36, FPS = 25;
function seqOf(id: string, over: Partial<Sequence> = {}): Sequence {
  return {
    id, name: "Evening bulletin", width: 1920, height: 1080, fps: FPS, sampleRate: 48000,
    tracks: [
      { id: "v1", kind: "video", name: "V1", index: 0, locked: false, hidden: false, muted: false, solo: false, targeted: true, syncLock: true, height: 50, volume: 0, pan: 0 },
      { id: "g1", kind: "video", name: "Ticker", index: 1, locked: false, hidden: false, muted: false, solo: false, targeted: false, syncLock: true, height: 50, volume: 0, pan: 0,
        gfxRole: "ticker" } as Sequence["tracks"][number],
    ],
    clips: [{ id: "c1", trackId: "g1", start: 0, duration: 10, source: { type: "graphic", gfx: { template: "nr.tickers.crawl", values: {} } } } as unknown as Sequence["clips"][number]],
    transitions: [], markers: [], playhead: 0, ...over,
  };
}
function projectOf(seq: Sequence = seqOf("s1")): EditProject {
  return {
    format: "tatvam-edit", version: 1, id: "p1", name: "News", created: "2026-10-14T00:00:00Z", modified: "2026-10-14T00:00:00Z",
    bins: [], media: [{ id: "m1", binId: null, name: "clip.mp4", kind: "video", path: "C:/x/clip.mp4", duration: 100, fps: 25, width: 1920, height: 1080, hasAudio: true, markers: [] } as unknown as EditProject["media"][number]],
    sequences: [seq], activeSequenceId: seq.id, settings: { copyMedia: false, proxy: "off", autosaveSeconds: 10 },
    newsroom: { version: 1, look: "look.classic_red", looks: {}, templates: {} },
  } as EditProject;
}

// ── pure ──

test("ratioDims keeps the short side and even sizes", () => {
  assert.deepEqual(ratioDims(1920, 1080), { w: 1920, h: 1080 });
  assert.deepEqual(ratioDims(1920, 1080, "9:16"), { w: 1080, h: 1920 });
  assert.deepEqual(ratioDims(1920, 1080, "16:9"), { w: 1920, h: 1080 });
  assert.deepEqual(ratioDims(1080, 1920, "16:9"), { w: 1920, h: 1080 });
  assert.deepEqual(ratioDims(1920, 1080, "1:1"), { w: 1080, h: 1080 });
  assert.deepEqual(ratioDims(1920, 1080, "4:5"), { w: 1080, h: 1350 });
  assert.deepEqual(ratioDims(3840, 2160, "9:16"), { w: 2160, h: 3840 });
  assert.deepEqual(ratioDims(1279, 719), { w: 1280, h: 720 });
  assert.equal(ratioTag("9:16"), "9x16");
  assert.equal(defaultNewsPreset(1920, 1080), "review1080");
  assert.equal(defaultNewsPreset(1080, 1920), "review1080");
  assert.equal(defaultNewsPreset(2560, 1440), "yt2k");
  assert.equal(defaultNewsPreset(3840, 2160), "yt4k_h264");
});

test("output names: Exports\\News, the right extension, a folder for PNG, unique, an explicit file kept", () => {
  const editDir = path.join(tmp, "Edit");
  const news = path.join(editDir, "Exports", "News");
  assert.equal(newsOutPath({ editDir, name: "Bulletin_9x16", codec: "mp4" }, new Set()), path.join(news, "Bulletin_9x16.mp4"));
  assert.equal(newsOutPath({ editDir, name: "Ticker loop", codec: "prores4444" }, new Set()), path.join(news, "Ticker loop.mov"));
  assert.equal(newsOutPath({ editDir, name: "Ticker", codec: "webm_alpha" }, new Set()), path.join(news, "Ticker.webm"));
  assert.equal(newsOutPath({ editDir, name: "Strap", codec: "png" }, new Set()), path.join(news, "Strap"));
  const taken = new Set([path.join(news, "Bulletin.mp4").replace(/\\/g, "/").toLowerCase()]);
  assert.equal(newsOutPath({ editDir, name: "Bulletin", codec: "mp4" }, taken), path.join(news, "Bulletin_2.mp4"));
  assert.equal(newsOutPath({ editDir, name: 'a<b>:c?"', codec: "mp4" }, new Set()), path.join(news, "a_b_c.mp4"));
  const file = path.join(tmp, "out", "mine.mov");
  assert.equal(newsOutPath({ editDir, name: "x", outPath: file, codec: "prores4444" }, new Set()), file);
  assert.equal(newsOutPath({ editDir, name: "x", outPath: path.join(tmp, "out"), codec: "webm_alpha" }, new Set()), path.join(tmp, "out", "x.webm"));
});

test("FFmpeg commands per alpha format", () => {
  const o = { w: 1920, h: 1080, fps: 25, frames: 250, out: path.join(tmp, "a.mov") };
  const pr = alphaArgs("prores4444", o);
  assert.deepEqual(pr.slice(0, 10), ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1920x1080", "-framerate", "25", "-i", "pipe:0"]);
  assert.ok(pr.join(" ").includes("-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le"));
  assert.match(pr[pr.indexOf("-vf") + 1], /out_color_matrix=bt709:out_range=tv.*format=yuva444p10le/);
  assert.ok(pr.includes("-an") && pr[pr.indexOf("-frames:v") + 1] === "250" && pr.at(-1) === o.out);
  const wb = alphaArgs("webm_alpha", { ...o, out: path.join(tmp, "a.webm") });
  assert.ok(wb.join(" ").includes("-c:v libvpx-vp9 -pix_fmt yuva420p"));
  assert.ok(wb.includes("-auto-alt-ref") && wb[wb.indexOf("-auto-alt-ref") + 1] === "0");
  const png = alphaArgs("png", { ...o, out: path.join(tmp, "Strap") });
  assert.ok(png.join(" ").includes("-c:v png -pix_fmt rgba"));
  assert.equal(png.at(-1), path.join(tmp, "Strap", "Strap_%05d.png"));
  assert.equal(png[png.indexOf("-start_number") + 1], "0");
  assert.deepEqual(Object.entries(NEWS_CODECS).map(([k, v]) => `${k}:${v.ext}:${v.alpha}`), ["prores4444:mov:true", "webm_alpha:webm:true", "png::true", "mp4:mp4:false"]);
});

test("legal range: Y 16–235 and Cb/Cr 16–240 (×4 at 10 bits), before the frame tags; off by default", () => {
  assert.equal(legalRange(8), "limiter=min=16:max=235:planes=1,limiter=min=16:max=240:planes=6");
  assert.equal(legalRange(10), "limiter=min=64:max=940:planes=1,limiter=min=64:max=960:planes=6");
  const base = { w: 1920, h: 1080, fps: 25, frames: 25, audio: "a.wav", out: "o.mp4", encoder: ["-c:v", "libx264"], container: "mp4" as const };
  const vf = (a: string[]) => a[a.indexOf("-vf") + 1];
  assert.doesNotMatch(vf(gpuFinalArgs(base)), /limiter/);
  assert.match(vf(gpuFinalArgs({ ...base, legal: true })), /^limiter=min=16:max=235:planes=1,limiter=min=16:max=240:planes=6,setparams=/);
  assert.match(vf(gpuFinalArgs({ ...base, legal: true, bits: 10 })), /^limiter=min=64:max=940/);
});

test("options are checked in plain words", () => {
  const ok = { editPath: path.join(tmp, "a.tatvamedit"), sequenceId: "s1", codec: "prores4444", only: "graphics" };
  assert.deepEqual(checkNewsOptions(ok), ok);
  const bad = (patch: Record<string, unknown>, re: RegExp) => assert.throws(() => checkNewsOptions({ ...ok, ...patch }), re);
  bad({ editPath: "a.tatvamedit" }, /Save the edit first/);
  bad({ codec: "gif" }, /Unknown format gif/);
  bad({ only: "some" }, /graphics or all/);
  bad({ ratio: "2:1" }, /Unknown ratio/);
  bad({ lang: "hindi language" }, /code like hi/);
  bad({ range: { in: 5, out: 5 } }, /range is empty/);
  bad({ roles: ["ticker", "weather"] }, /Unknown graphics role/);
  bad({ preset: "vhs" }, /Unknown preset vhs/);
  bad({ loudness: "loud" }, /Unknown loudness/);
  bad({ background: "red" }, /colour like #000000/);
  bad({ templates: { "nr.x": { id: "nr.y", designs: {} } } }, /Template nr.x is broken/);
  const full = checkNewsOptions({ ...ok, codec: "mp4", only: "all", ratio: "9:16", lang: "hi", range: { in: 0, out: 50 }, name: "  Bulletin ", legal: true,
    loudness: "ebu_r128", preset: "broadcast1080", background: "#FF0000", roles: ["ticker"] });
  assert.equal(full.name, "Bulletin");
  assert.equal(full.background, "#ff0000");
  assert.equal(full.legal, true);
});

test("generated sequences join the saved edit for one export (checked; unknown media refused); templates merge", () => {
  const p = projectOf();
  const gen = seqOf("gen1", { name: "Row 1" });
  const out = withGenerated(p, [gen], { "my.t": { id: "my.t", designs: {} } });
  assert.deepEqual(out.sequences.map((s) => s.id), ["s1", "gen1"]);
  assert.ok((out as { newsroom?: { templates: Record<string, unknown> } }).newsroom!.templates["my.t"]);
  assert.equal(p.sequences.length, 1, "the saved edit isn't changed");
  const replaced = withGenerated(p, [seqOf("s1", { name: "New" })]);
  assert.deepEqual(replaced.sequences.map((s) => s.name), ["New"]);
  const withMedia = seqOf("g2", { clips: [{ id: "x", trackId: "v1", start: 0, duration: 5, source: { type: "media", mediaId: "nope", in: 0 } } as never] });
  assert.throws(() => withGenerated(p, [withMedia]), /media that isn't in the saved edit/);
  assert.throws(() => withGenerated(p, [{ id: "z" }]), /Generated sequence 1 is broken/);
  assert.throws(() => withGenerated(p, [seqOf("d"), seqOf("d")]), /same id/);
});

test("exportGraphics: 9:16 size, frame count, names, window options; graphics-only mp4 gets a background", async () => {
  const started: NewsRenderInput[] = [];
  const editDir = path.join(tmp, "E1");
  const deps = {
    log: () => undefined,
    loadEdit: async (f: string) => ({ file: f, dir: editDir, project: projectOf() }),
    startNews: (i: NewsRenderInput) => { started.push(i); return `job-${started.length}`; },
  };
  const editPath = path.join(editDir, "News.tatvamedit");
  const r = await exportGraphics(deps, { editPath, sequenceId: "s1", codec: "mp4", only: "all", ratio: "9:16", lang: "hi" });
  assert.equal(r!.jobId, "job-1");
  assert.equal(r!.path, path.join(editDir, "Exports", "News", "Evening bulletin_9x16_hi.mp4"));
  assert.deepEqual([r!.w, r!.h, r!.fps, r!.frames], [1080, 1920, 25, 10]);
  const n = started[0].news;
  assert.equal(n.preset, "review1080");
  assert.deepEqual(n.gpu, { only: "all", ratio: "9:16", lang: "hi" });
  assert.deepEqual(started[0].range, { in: 0, out: 10 });
  // the same name again (still queued) gets _2
  const r2 = await exportGraphics(deps, { editPath, sequenceId: "s1", codec: "mp4", only: "all", ratio: "9:16", lang: "hi" });
  assert.equal(path.basename(r2!.path), "Evening bulletin_9x16_hi_2.mp4");
  const a = await exportGraphics(deps, { editPath, sequenceId: "s1", codec: "prores4444", only: "graphics", roles: ["ticker"], name: "Ticker loop", range: { in: 2, out: 8 } });
  assert.deepEqual(started[2].news.gpu, { alpha: true, only: "graphics", roles: ["ticker"] });
  assert.deepEqual([a!.w, a!.h, a!.frames], [1920, 1080, 6]);
  assert.equal(started[2].preset, "prores4444");
  await exportGraphics(deps, { editPath, sequenceId: "s1", codec: "mp4", only: "graphics", preset: "broadcast1080", legal: true, loudness: "ebu_r128" });
  assert.deepEqual(started[3].news.gpu, { only: "graphics", background: "#000000" });
  assert.equal(started[3].news.legal, true);
  assert.equal(started[3].news.loudness, "ebu_r128");
  const gen = seqOf("row1", { name: "Row 1", width: 1080, height: 1920 });
  const b = await exportGraphics(deps, { editPath, sequenceId: "row1", codec: "webm_alpha", only: "graphics", sequences: [gen] });
  assert.deepEqual([b!.w, b!.h], [1080, 1920]);
  assert.ok(started[4].project.sequences.some((s) => s.id === "row1"));
  await assert.rejects(exportGraphics({ log: () => undefined }, { editPath, sequenceId: "s1", codec: "png", only: "graphics" }), /need the desktop app/);
  await assert.rejects(exportGraphics(deps, { editPath, sequenceId: "nope", codec: "png", only: "graphics" }), /isn't in the saved edit/);
});

// ── real encodes through the RenderManager queue (FFmpeg needed) ──

const FF = locateFfmpeg({ appPath: path.join(here, ".."), packaged: false });

/** A GPU render window stand-in: asks for the job, sends every frame, says done (like pages/desktop/RenderJob.tsx). */
function fakeWindow(get: () => RenderManager, seen: GpuRenderJob[]) {
  return (urlPath: string) => {
    const id = new URLSearchParams(urlPath.split("?")[1]).get("id")!;
    let closed = false;
    void (async () => {
      await new Promise((r) => setTimeout(r, 5));
      const r = get();
      const job = r.engineJob(id);
      seen.push(job);
      const alpha = job.kind === "composition" && job.news?.alpha;
      for (let i = 0; i < job.frames && !closed; i++) {
        let bytes: Uint8Array;
        if (alpha) { // a half-transparent red box on the left that moves, fully transparent elsewhere
          bytes = new Uint8Array(job.w * job.h * 4);
          for (let y = 0; y < job.h; y++) for (let x = 0; x < job.w / 2; x++) bytes.set([255, 0, 0, x < 8 + i ? 255 : 128], (y * job.w + x) * 4);
        } else { // full white I420: luma 255 (outside the legal range), neutral chroma
          bytes = new Uint8Array(job.w * job.h * 1.5).fill(128);
          bytes.fill(255, 0, job.w * job.h);
        }
        await r.engineFrame(id, i, bytes);
      }
      r.engineDone(id);
    })().catch((e) => get().engineFail(id, String((e as Error).message)));
    return { close() { closed = true; } };
  };
}

async function untilDone(r: RenderManager, id: string) {
  for (let i = 0; i < 600; i++) {
    const j = r.get(id)!;
    if (["done", "failed", "cancelled"].includes(j.status)) return j;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("timed out");
}
const ffInfo = (file: string) => spawnSync(FF!.path, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr;
/** The first frame decoded as RGBA (or gray), bytes. */
const decode = (file: string, pixFmt: string, extra: string[] = []) =>
  spawnSync(FF!.path, ["-hide_banner", "-loglevel", "error", ...extra, "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", pixFmt, "-"], { maxBuffer: 1 << 24 }).stdout as Buffer;

test("real encodes: ProRes 4444, WebM with alpha, PNG frames and a TV mp4 (legal range) through the render queue",
  { skip: !FF && "FFmpeg not found", timeout: 120_000 }, async () => {
    const editDir = path.join(tmp, "Real");
    const seen: GpuRenderJob[] = [];
    let renders!: RenderManager;
    renders = new RenderManager({
      upstream: undefined as never, library: undefined as never, ff: () => FF, probe: async () => ({}),
      settings: () => ({ encoder: { prefer: "auto", hevc10bit: false } }) as never, jobsFile: path.join(tmp, "renders.json"),
      broadcast: () => undefined, log: () => undefined, openRenderWindow: fakeWindow(() => renders, seen),
    });
    const seq = seqOf("s1", { width: W, height: H });
    const deps = { log: () => undefined, loadEdit: async (f: string) => ({ file: f, dir: editDir, project: projectOf(seq) }),
      startNews: (i: NewsRenderInput) => renders.startNews(i) };
    const editPath = path.join(editDir, "News.tatvamedit");
    const go = async (o: Partial<Parameters<typeof exportGraphics>[1]>) => {
      const r = await exportGraphics(deps, { editPath, sequenceId: "s1", codec: "prores4444", only: "graphics", ...o } as never);
      const j = await untilDone(renders, r!.jobId!);
      assert.equal(j.status, "done", j.error);
      assert.equal(j.output, r!.path);
      assert.ok(existsSync(r!.path));
      return r!;
    };

    const pr = await go({ codec: "prores4444", name: "Ticker" });
    assert.match(ffInfo(pr.path), /prores \(4444\).*yuva444p1[02]le.*64x36/s);
    const px = decode(pr.path, "rgba");
    assert.equal(px.length, W * H * 4);
    assert.ok(Math.abs(px[3] - 255) <= 1 && px[0] > 240 && px[1] < 16, `opaque red at the left edge: ${[...px.subarray(0, 4)]}`);
    const mid = (10 * W + 20) * 4; // inside the half-transparent part of the box
    assert.ok(Math.abs(px[mid + 3] - 128) <= 2, `half alpha kept: ${px[mid + 3]}`);
    assert.ok(px[mid] > 240, `straight (not premultiplied) colour: ${px[mid]}`);
    assert.equal(px[(10 * W + 50) * 4 + 3], 0, "transparent where nothing is drawn");

    const wb = await go({ codec: "webm_alpha", name: "Ticker" });
    assert.match(ffInfo(wb.path), /vp9.*alpha_mode\s*:\s*1/is);
    const wpx = decode(wb.path, "rgba", ["-c:v", "libvpx-vp9"]);
    assert.ok(wpx[(10 * W + 50) * 4 + 3] < 8 && wpx[3] > 247, "WebM keeps the alpha");

    const png = await go({ codec: "png", name: "Strap" });
    const files = readdirSync(png.path).sort();
    assert.equal(files.length, 10);
    assert.equal(files[0], "Strap_00000.png");
    const ppx = decode(path.join(png.path, files[9]), "rgba");
    assert.deepEqual([...ppx.subarray(0, 4)], [255, 0, 0, 255]);
    assert.deepEqual([...ppx.subarray(mid, mid + 4)], [255, 0, 0, 128]);
    assert.equal(ppx[(10 * W + 50) * 4 + 3], 0);

    const tv = await go({ codec: "mp4", only: "all", preset: "review1080", legal: true, loudness: "ebu_r128", name: "Bulletin TV" });
    assert.equal(path.basename(tv.path), "Bulletin TV.mp4");
    const info = ffInfo(tv.path);
    assert.match(info, /h264.*1920x1080/s, "the preset's size");
    assert.match(info, /Audio: aac/);
    const y = decode(tv.path, "yuv420p");
    // the frames were all 255: the limiter holds luma at 235 (a little encoder noise allowed)
    assert.ok(Math.max(...y.subarray(0, 4000)) <= 237, `legal range: max ${Math.max(...y.subarray(0, 4000))}`);
    const plain = await go({ codec: "mp4", only: "all", preset: "review1080", name: "Bulletin web" });
    const y2 = decode(plain.path, "yuv420p");
    assert.ok(Math.max(...y2.subarray(0, 4000)) >= 250, "without legal range the white stays above 235");

    // the window got the news options: alpha for the transparent ones, none for the mp4
    const comps = seen.filter((j) => j.kind === "composition") as Extract<GpuRenderJob, { kind: "composition" }>[];
    assert.deepEqual(comps.map((j) => Boolean(j.news?.alpha)), [true, true, true, false, false]);
    assert.deepEqual(comps.map((j) => j.bits ?? 8), [8, 8, 8, 8, 8]);
    assert.ok(!readdirSync(path.join(editDir, "Cache")).length, "the temp folders are gone");
  });

test("TV loudness for real: a loud tone is brought to EBU R128 −23 LUFS (true peak under −1 dBTP); graphics-only is silent; cancel works",
  { skip: !FF && "FFmpeg not found", timeout: 120_000 }, async () => {
    const editDir = path.join(tmp, "Loud");
    const tone = path.join(tmp, "tone.wav");
    // 4 s of 1 kHz at −6 dBFS: about −9 LUFS, far above the target
    spawnSync(FF!.path, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=4", "-af", "volume=-3dB", "-ac", "2", tone]);
    const seen: GpuRenderJob[] = [];
    let renders!: RenderManager;
    renders = new RenderManager({
      upstream: undefined as never, library: undefined as never, ff: () => FF, probe: async () => ({}),
      settings: () => ({ encoder: { prefer: "auto", hevc10bit: false } }) as never, jobsFile: path.join(tmp, "renders2.json"),
      broadcast: () => undefined, log: () => undefined, openRenderWindow: fakeWindow(() => renders, seen),
    });
    const base = seqOf("s1", { width: W, height: H });
    const seq: Sequence = { ...base,
      tracks: [...base.tracks, { id: "a1", kind: "audio", name: "A1", index: 0, locked: false, hidden: false, muted: false, solo: false, targeted: true, syncLock: true, height: 50, volume: 0, pan: 0 }],
      clips: [...base.clips, { id: "t1", trackId: "a1", start: 0, duration: 100, source: { type: "media", mediaId: "tone", in: 0 }, speed: 1, reverse: false, enabled: true, name: "tone",
        audio: { gain: { value: 0 }, pan: { value: 0 }, fadeIn: 0, fadeOut: 0 } } as unknown as Sequence["clips"][number]] };
    const proj = projectOf(seq);
    proj.media.push({ id: "tone", binId: null, name: "tone.wav", kind: "audio", path: tone, duration: 192000, fps: 48000, width: 0, height: 0, hasAudio: true, markers: [] } as never);
    const deps = { log: () => undefined, loadEdit: async (f: string) => ({ file: f, dir: editDir, project: proj }), startNews: (i: NewsRenderInput) => renders.startNews(i) };
    const editPath = path.join(editDir, "News.tatvamedit");
    const r = await exportGraphics(deps, { editPath, sequenceId: "s1", codec: "mp4", only: "all", preset: "draft720", loudness: "ebu_r128", legal: true, name: "TV" });
    const j = await untilDone(renders, r!.jobId!);
    assert.equal(j.status, "done", j.error);
    assert.equal(j.loudness?.target, -23);
    assert.ok(Math.abs(j.loudness!.measured! + 23) <= 0.5, `measured ${j.loudness!.measured} LUFS`);
    const meter = spawnSync(FF!.path, ["-hide_banner", "-nostats", "-i", j.output!, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const lufs = Number(/I:\s*(-?[\d.]+) LUFS/.exec(meter.slice(meter.lastIndexOf("Summary")))![1]);
    const peak = Number(/Peak:\s*(-?[\d.]+) dBFS/.exec(meter.slice(meter.lastIndexOf("Summary")))![1]);
    assert.ok(Math.abs(lufs + 23) <= 1, `the file measures ${lufs} LUFS`);
    assert.ok(peak <= -1, `true peak ${peak} dBTP`);
    // graphics only: no sound of the edit's, silence in the file
    const g = await exportGraphics(deps, { editPath, sequenceId: "s1", codec: "mp4", only: "graphics", preset: "draft720", name: "Gfx" });
    const gj = await untilDone(renders, g!.jobId!);
    assert.equal(gj.status, "done", gj.error);
    assert.deepEqual((seen.at(-1) as Extract<GpuRenderJob, { kind: "composition" }>).news, { only: "graphics", background: "#000000" });
    const vol = spawnSync(FF!.path, ["-hide_banner", "-nostats", "-i", gj.output!, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    assert.match(vol, /max_volume: -(9\d|\d{3}|inf)/, "silent");
    // a queued export can be cancelled before it starts; the running one stops
    const a = await exportGraphics(deps, { editPath, sequenceId: "s1", codec: "prores4444", only: "graphics", name: "A" });
    const b = await exportGraphics(deps, { editPath, sequenceId: "s1", codec: "prores4444", only: "graphics", name: "B" });
    renders.cancel(b!.jobId!);
    assert.equal(renders.get(b!.jobId!)!.status, "cancelled");
    assert.equal((await untilDone(renders, a!.jobId!)).status, "done");
    assert.ok(!existsSync(b!.path));
  });
