/**
 * Slow motion and frame-rate conversion with RIFE (rife-ncnn-vulkan, docs/EDITOR.md §10): the plan (how many frames,
 * at what rate, how much the sound stretches), the PNG extract (converted to RGB with the clip's own matrix: tagged,
 * else BT.709 for HD), RIFE's arguments (the -n frame count works with the v4 models only; older models double), and
 * the encode of RIFE's JPEG frames back to limited-range BT.709 H.264 on the hardware encoder (aiupscale's
 * FRAMES_TO_VIDEO) with the sound stretched by an atempo chain, kept, or dropped. Pure (test/editor-tools.test.ts).
 */
import path from "node:path";
import type { InterpolateModel, InterpolateOptions } from "../shared/types.ts";
import { BT709_FRAMES, BT709_TAGS, FRAMES_TO_VIDEO } from "./aiupscale.ts";
import { fpsRational } from "./editor-model.ts";
export { parseVideoFormat } from "./editor-media.ts";
import { atempoChain } from "./render-args.ts";

export const RIFE_MODELS: InterpolateModel[] = ["rife-v4.6", "rife-v4", "rife-v3.1", "rife-v2.4", "rife-anime", "rife-UHD"];
export const DEFAULT_RIFE_MODEL: InterpolateModel = "rife-v4.6";
/** Models that take any frame count (-n); the others only double. */
export const isV4 = (m: string) => /^rife-v4/.test(m);

export interface InterpPlan {
  model: InterpolateModel;
  /** frames RIFE makes from `inFrames` source frames */
  inFrames: number;
  outFrames: number;
  /** the new clip's rate as FFmpeg reads it ("96000/1001", "60") and as a number */
  fpsArg: string;
  fps: number;
  /** new length / source length (1 = same speed; 4 = 4× slow motion) */
  stretch: number;
  /** new frames per source frame */
  factor: number;
}

const ratio = (n: number, d: number) => (d === 1 ? String(n) : `${n}/${d}`);

/** What an interpolation makes of `inFrames` frames at `srcFps` (throws with a plain message when it can't). */
export function interpPlan(srcFps: number, inFrames: number, o: Pick<InterpolateOptions, "factor" | "fps" | "model">): InterpPlan {
  const model = o.model ?? DEFAULT_RIFE_MODEL;
  if (!RIFE_MODELS.includes(model)) throw new Error(`Unknown RIFE model ${String(model)}`);
  if (!(srcFps > 0)) throw new Error("The clip has no frame rate");
  if (inFrames < 2) throw new Error("Slow motion needs at least two frames");
  if (o.factor !== undefined && ![2, 4, 8].includes(o.factor)) throw new Error("The factor is 2, 4 or 8");
  if (o.fps !== undefined && !(Number.isFinite(o.fps) && o.fps >= 1 && o.fps <= 240)) throw new Error("The frame rate must be between 1 and 240");
  const [sn, sd] = fpsRational(srcFps);
  const src = sn / sd;
  let factor: number;
  let fpsN: number;
  let fpsD: number;
  if (o.factor) {
    factor = o.factor;
    if (o.fps) [fpsN, fpsD] = fpsRational(o.fps);
    else [fpsN, fpsD] = [sn * factor, sd];
  } else if (o.fps) {
    [fpsN, fpsD] = fpsRational(o.fps);
    factor = fpsN / fpsD / src;
    if (!(factor > 1.0001)) throw new Error(`Pick a frame rate above the clip's ${Math.round(src * 1000) / 1000} fps`);
    if (factor > 16) throw new Error("At most 16 new frames per source frame");
  } else {
    factor = 2;
    [fpsN, fpsD] = [sn * 2, sd];
  }
  if (!isV4(model) && Math.abs(factor - 2) > 1e-9) throw new Error(`${model} only doubles the frames: use rife-v4.6 for ×4, ×8 or a new frame rate`);
  const outFrames = Math.max(2, Math.round(inFrames * factor));
  const fps = fpsN / fpsD;
  const g = gcd(fpsN, fpsD);
  const stretch = (outFrames / fps) / (inFrames / src);
  return { model, inFrames, outFrames, fpsArg: ratio(fpsN / g, fpsD / g), fps: Math.round(fps * 1000) / 1000, stretch: Math.round(stretch * 1e6) / 1e6, factor };
}

function gcd(a: number, b: number): number {
  a = Math.round(Math.abs(a));
  b = Math.round(Math.abs(b));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

/** The matrix and range to read a clip's YUV with: its tags, else BT.709 (HD) / BT.601 (SD), limited range. */
export function readMatrix(fmt: { matrix: string | null; range: "tv" | "pc" | null }, height: number): { matrix: string; range: "tv" | "pc" } {
  const map: Record<string, string> = { bt709: "bt709", bt470bg: "bt601", smpte170m: "bt601", bt601: "bt601", bt2020nc: "bt2020", bt2020c: "bt2020" };
  return { matrix: (fmt.matrix && map[fmt.matrix]) || (height >= 720 ? "bt709" : "bt601"), range: fmt.range ?? "tv" };
}

/** [in, out) of the clip as PNG frames (RGB from the clip's matrix), numbered from 1. */
export function rifeExtractArgs(src: string, dir: string, o: { in: number; out?: number; matrix: string; range: "tv" | "pc" }): string[] {
  const seek = o.in > 0 ? ["-ss", o.in.toFixed(3)] : [];
  const dur = o.out !== undefined && o.out > o.in ? ["-t", (o.out - o.in).toFixed(3)] : [];
  return [...seek, ...dur, "-i", src, "-map", "0:v:0", "-fps_mode", "passthrough", "-an", "-sn",
    "-vf", `scale=in_color_matrix=${o.matrix}:in_range=${o.range}:flags=lanczos+accurate_rnd+full_chroma_int,format=rgb24`,
    "-start_number", "1", path.join(dir, "%08d.png")];
}

/** RIFE over a folder: `outFrames` frames as JPEG (%08d.jpg from 1) on Vulkan device `gpu`. */
export function rifeArgs(o: { inDir: string; outDir: string; modelDir: string; outFrames: number; gpu: number; uhd: boolean; v4: boolean }): string[] {
  const a = ["-i", o.inDir, "-o", o.outDir, "-m", o.modelDir, "-g", String(o.gpu), "-j", "1:2:2", "-f", "%08d.jpg", "-v"];
  if (o.v4) a.push("-n", String(o.outFrames));
  if (o.uhd) a.push("-u");
  return a;
}

/** "in/00000001.png in/00000002.png 0.250000 -> out/00000002.jpg done" lines: one per frame written. */
export const isRifeFrameLine = (l: string) => /->\s*\S+\.(?:jpg|png|webp)\s+done\s*$/i.test(l.trim());

/**
 * The new clip: RIFE's JPEG frames (full-range BT.601) → limited-range BT.709 at `fpsArg` on `enc`, a 1 s GOP so the
 * editor seeks fast, BT.709 tags; the source's sound over [in, out) stretched to the new length (or kept when it doesn't
 * change, or dropped). `fps` is the numeric rate (for the GOP and the length), `frames` the number of JPEGs.
 */
export function rifeEncodeArgs(o: { framesDir: string; fpsArg: string; fps: number; frames: number; source: string; in: number; out?: number;
  stretch: number; audio: "stretch" | "drop"; hasAudio: boolean; outFile: string; enc: string[]; w: number; h: number }): string[] {
  const a = ["-framerate", o.fpsArg, "-start_number", "1", "-i", path.join(o.framesDir, "%08d.jpg")];
  const withAudio = o.audio !== "drop" && o.hasAudio;
  if (withAudio) {
    if (o.in > 0) a.push("-ss", o.in.toFixed(3));
    if (o.out !== undefined && o.out > o.in) a.push("-t", (o.out - o.in).toFixed(3));
    a.push("-i", o.source);
  }
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  a.push("-map", "0:v:0", "-vf", `scale=${even(o.w)}:${even(o.h)}:flags=lanczos:${FRAMES_TO_VIDEO},format=yuv420p,${BT709_FRAMES}`, ...o.enc, ...BT709_TAGS,
    "-g", String(Math.max(1, Math.round(o.fps))), "-r", o.fpsArg);
  if (withAudio) {
    a.push("-map", "1:a:0?");
    const af = ["aresample=48000"];
    if (Math.abs(o.stretch - 1) > 1e-4) af.push(atempoChain(1 / o.stretch));
    af.push("apad"); // the picture sets the length: a stretched sound a few ms short mustn't cut frames off
    a.push("-af", af.join(","), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", (o.frames / o.fps).toFixed(4));
  } else {
    a.push("-an");
  }
  a.push("-frames:v", String(o.frames), "-movflags", "+faststart", o.outFile);
  return a;
}

/** Bytes the work folder needs: the PNG frames in (about half of raw RGB) and RIFE's JPEGs out (about an eighth). */
export function interpDiskBytes(w: number, h: number, inFrames: number, outFrames: number): number {
  return Math.round(w * h * 3 * (inFrames * 0.55 + outFrames * 0.14) + 64e6);
}

/** "Clip name x4 96fps.mp4" → a file name for the new clip (the caller makes it safe and unique). */
export function interpName(sourceName: string, p: InterpPlan): string {
  const base = sourceName.replace(/\.[^.]+$/, "");
  const fps = Number.isInteger(p.fps) ? String(p.fps) : p.fps.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  const k = Number.isInteger(p.factor) ? `x${p.factor}` : `x${p.factor.toFixed(2)}`;
  return `${base} ${p.stretch > 1.0001 ? `slowmo ${k}` : k} ${fps}fps.mp4`;
}
