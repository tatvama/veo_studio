/**
 * Pure FFmpeg command builders for the local render (docs/DESKTOP.md §2.4, §4.1). Each one ports a step of the
 * server pipeline (backend/app/pipeline/ffmpeg.py, layers.py, assembler.render) to the render plan's fields, and
 * returns the argument list (without the ffmpeg binary). Unit tests: test/render.test.ts.
 *
 * Differences from the server, all on purpose:
 *  - intermediates use the fastest hardware H.264 encoder at CQ 16 (x264 veryfast CRF 16 as the fallback), not x264 CRF 20;
 *  - at 2160p and above every scale uses `flags=lanczos`; "local upscale" adds `unsharp=5:5:0.5` to shots without an AI upscale;
 *  - the final mux always encodes with the preset's encoder (the server copies the video when there are no captions).
 */
import type { EncoderPreference, RenderPreset } from "../shared/types.ts";

// ── the render plan (server: GET /api/episodes/{eid}/render-plan) ──
export interface PlanAudio { key: string; offset: number; gain_db?: number }
export interface PlanSegment {
  shot_id: number;
  code: string;
  source: string;
  source_kind: string;
  upscaled?: boolean;
  duration: number;
  trim_in: number;
  speed: number;
  seg_len: number;
  audio_override: string | null;
  extra_audio: PlanAudio[];
  keep_src_audio: boolean;
  src_gain_db: number;
  has_audio?: boolean;
  /** Where the segment starts on the finished cut. */
  start?: number;
  /** The complete video chain for w×h (server clip_vf / still_vf): preferred over rebuilding it from the pieces. */
  vf?: string;
  pre: string;
  stabilize: boolean;
  center: [number, number] | null;
  kenburns: boolean;
  vf_post: string;
  af_fx: string;
  transition: [string, number] | null;
}
export interface PlanPic { key: string; kind: string; start: number; in: number; dur: number; chain: string[]; x: string; y: string }
export interface PlanSound { key: string; start: number; in: number; dur: number; gain_db?: number; fade_in?: number; fade_out?: number; has_audio?: boolean }
export interface RenderPlan {
  episode_id: number;
  project_id?: number;
  lang: string;
  w: number;
  h: number;
  fps: number;
  cut_version?: number | null;
  fingerprint?: string;
  generated_at?: string;
  duration_s?: number;
  options?: { effects?: boolean; captions?: boolean; music?: boolean; upscaled?: boolean };
  warnings?: string[];
  segments: PlanSegment[];
  end_card?: { key: string; seconds: number; transition?: [string, number] | null; vf?: string } | null;
  layers?: { pics: PlanPic[]; sounds: PlanSound[] } | null;
  music?: { key: string; volume_db?: number; duck?: boolean } | null;
  captions?: { srt?: string; ass?: string; burn?: boolean; style?: string; font?: string } | null;
  luts?: Record<string, string>;
  loudnorm?: string;
  /** Stabilising filters with a @@TRF@@ placeholder for the transforms file (backend ffmpeg.STAB_DETECT / STAB_TRANSFORM). */
  stabilize_filters?: { detect: string; transform: string };
  keys?: string[];
}

export const STAB_DETECT = "vidstabdetect=shakiness=6:accuracy=12:result='@@TRF@@'";
export const STAB_TRANSFORM = "vidstabtransform=input='@@TRF@@':smoothing=12:zoom=2,unsharp=5:5:0.6,";

const f3 = (x: number) => x.toFixed(3);
const f4 = (x: number) => x.toFixed(4);
/** A raw number where the server formats one with str() (e.g. volume=…dB); FFmpeg reads "-6" and "-6.0" alike. */
const num = (x: number) => String(x);

/** A file path inside an FFmpeg filter argument (backend fx._esc_path): separators become "/", then every backslash,
 * colon and quote left is escaped in one pass (a Windows path has no backslash left by then, so this matches the server). */
export function escPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/[\\:']/g, (c) => `\\${c}`);
}

/** The ASS/fontsdir escaping of backend ffmpeg.replace_audio_mix (posix path, colons escaped). */
export function escAssPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/[\\:]/g, (c) => `\\${c}`);
}

/** Swap `@@LUT_<id>@@` for the escaped local .cube path. Unknown ids are left (FFmpeg then reports them). */
export function substituteLuts(filter: string, luts: Record<string, string>): string {
  return filter.replace(/@@LUT_([A-Za-z0-9_-]+)@@/g, (m, id: string) => (luts[id] ? escPath(luts[id]) : m));
}

/** 2K and 4K output: upscaled from the 1080p clips, so scaling uses Lanczos (and local upscale sharpens). */
export const isUhd = (w: number, h: number) => Math.min(w, h) >= 1440;
const scaleFlags = (w: number, h: number) => (isUhd(w, h) ? ":flags=lanczos" : "");

/**
 * The server's ready-made chain, tuned for 1440p and above: every fixed-size `scale=W:H…` gets `flags=lanczos`, and
 * `sharpen` (local upscale on a shot without an AI upscale) adds `unsharp=5:5:0.5` right after the framing.
 */
export function uhdVf(vf: string, w: number, h: number, sharpen = false): string {
  if (!isUhd(w, h)) return vf;
  let out = vf.replace(/scale=\d+:\d+(?::[a-z_]+=[^,:;'\[\]]+)*/g, (m) => (m.includes("flags=") ? m : `${m}:flags=lanczos`));
  if (sharpen) {
    const i = out.indexOf("setsar=1");
    if (i >= 0) out = `${out.slice(0, i + 8)},unsharp=5:5:0.5${out.slice(i + 8)}`;
  }
  return out;
}

/** A stabilising filter template with the escaped transforms file in place of @@TRF@@. */
export function withTrf(template: string, trf: string): string {
  return template.split("@@TRF@@").join(escPath(trf));
}

/** Scale to cover then crop to exactly w×h (backend ffmpeg.fit_filter), with lanczos at 2160p and above. */
export function fitFilter(w: number, h: number, center?: [number, number] | null): string {
  const sc = `scale=${w}:${h}:force_original_aspect_ratio=increase${scaleFlags(w, h)}`;
  if (!center) return `${sc},crop=${w}:${h},setsar=1`;
  const [cx, cy] = center;
  return `${sc},crop=${w}:${h}:'max(0,min(iw-ow,iw*${f4(cx)}-ow/2))':'max(0,min(ih-oh,ih*${f4(cy)}-oh/2))',setsar=1`;
}

/** atempo takes 0.5–2 per stage: chain stages for 0.25–4× (backend fx.atempo_chain). */
export function atempoChain(speed: number): string {
  const parts: string[] = [];
  let s = speed;
  while (s > 2.0) { parts.push("atempo=2.0"); s /= 2.0; }
  while (s < 0.5) { parts.push("atempo=0.5"); s /= 0.5; }
  parts.push(`atempo=${f4(s)}`);
  return parts.join(",");
}

// ── encoders ──

export type Family = "nvenc" | "qsv" | "amf" | "software";

/** The fastest hardware H.264 encoder for intermediates (CQ 16), else x264 veryfast CRF 16. */
export function intermediateEncoder(probe: Record<string, boolean>, prefer: EncoderPreference = "auto", cq = 16): { name: string; args: string[] } {
  const order: Family[] = prefer === "auto" ? ["nvenc", "qsv", "amf", "software"] : [prefer, "nvenc", "qsv", "amf", "software"];
  for (const fam of order) {
    if (fam === "nvenc" && probe.h264_nvenc) return { name: "h264_nvenc", args: ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", String(cq), "-b:v", "0", "-profile:v", "high", "-pix_fmt", "yuv420p"] };
    if (fam === "qsv" && probe.h264_qsv) return { name: "h264_qsv", args: ["-c:v", "h264_qsv", "-preset", "faster", "-global_quality", String(cq), "-pix_fmt", "nv12"] };
    if (fam === "amf" && probe.h264_amf) return { name: "h264_amf", args: ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", String(cq), "-qp_p", String(cq), "-pix_fmt", "nv12"] };
    if (fam === "software") break;
  }
  return { name: "libx264", args: ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(cq), "-pix_fmt", "yuv420p"] };
}

export const AUDIO_INTERMEDIATE = ["-c:a", "aac", "-ar", "48000", "-ac", "2"];

export interface PresetDef {
  id: string; label: string; w: number; h: number; fps?: number; orientation: "project" | "vertical";
  codec: "hevc" | "h264" | "prores" | "av1"; container: "mp4" | "mov"; tenBit: boolean; cq?: number; cbr?: string; note: string;
}

export const PRESETS: PresetDef[] = [
  { id: "yt4k", label: "YouTube 4K", w: 3840, h: 2160, orientation: "project", codec: "hevc", container: "mp4", tenBit: true, cq: 19, note: "HEVC 10-bit, CQ 19" },
  { id: "yt4k_h264", label: "YouTube 4K (H.264)", w: 3840, h: 2160, orientation: "project", codec: "h264", container: "mp4", tenBit: false, cq: 18, note: "H.264 8-bit, CQ 18" },
  { id: "social4k", label: "Shorts / Reels 4K", w: 2160, h: 3840, orientation: "vertical", codec: "hevc", container: "mp4", tenBit: false, cq: 20, note: "HEVC 8-bit, vertical" },
  { id: "yt2k", label: "YouTube 2K", w: 2560, h: 1440, orientation: "project", codec: "hevc", container: "mp4", tenBit: false, cq: 19, note: "HEVC 8-bit, CQ 19, 2560×1440" },
  { id: "social2k", label: "Shorts / Reels 2K", w: 1440, h: 2560, orientation: "vertical", codec: "hevc", container: "mp4", tenBit: false, cq: 20, note: "HEVC 8-bit, vertical 1440×2560" },
  { id: "master_prores", label: "Master ProRes 422 HQ", w: 3840, h: 2160, orientation: "project", codec: "prores", container: "mov", tenBit: true, note: "prores_ks profile 3, yuv422p10le (software encoder)" },
  { id: "broadcast1080", label: "Broadcast 1080p25", w: 1920, h: 1080, fps: 25, orientation: "project", codec: "h264", container: "mp4", tenBit: false, cbr: "50M", note: "H.264 high, 50 Mb/s CBR, AAC 48 kHz" },
  { id: "review1080", label: "Review 1080p (fast)", w: 1920, h: 1080, orientation: "project", codec: "h264", container: "mp4", tenBit: false, cq: 23, note: "H.264 CQ 23" },
  { id: "av1_4k", label: "AV1 4K (archive)", w: 3840, h: 2160, orientation: "project", codec: "av1", container: "mp4", tenBit: false, cq: 28, note: "AV1 NVENC, only where supported (RTX 40 and up)" },
];

/** Output size for a preset and the project's aspect: 16:9 as listed, 9:16 swapped, 1:1 square on the short side. */
export function presetDims(p: PresetDef, aspect: string): { w: number; h: number } {
  if (p.orientation === "vertical") return { w: p.w, h: p.h };
  const long = Math.max(p.w, p.h);
  const short = Math.min(p.w, p.h);
  if (aspect === "9:16") return { w: short, h: long };
  if (aspect === "1:1") return { w: short, h: short };
  return { w: long, h: short };
}

/** The final encoder for a preset on this PC (NVENC → QSV → AMF → software), or null when it can't be encoded. */
export function finalEncoder(p: PresetDef, probe: Record<string, boolean>, prefer: EncoderPreference = "auto", allow10bit = true):
  { name: string; args: string[]; family: Family } | null {
  const order: Family[] = prefer === "auto" ? ["nvenc", "qsv", "amf", "software"] : [prefer, "nvenc", "qsv", "amf", "software"];
  const cq = String(p.cq ?? 19);
  const ten = p.tenBit && allow10bit;
  if (p.codec === "prores") {
    return { name: "prores_ks", family: "software", args: ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", "-vendor", "apl0"] };
  }
  if (p.codec === "av1") {
    if (probe.av1_nvenc) return { name: "av1_nvenc", family: "nvenc", args: ["-c:v", "av1_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", cq, "-b:v", "0", "-pix_fmt", "yuv420p"] };
    return null;
  }
  if (p.cbr) { // broadcast: constant bit rate H.264 high
    const b = p.cbr;
    const buf = `${Number.parseInt(b, 10) * 2}M`;
    for (const fam of order) {
      if (fam === "nvenc" && probe.h264_nvenc) return { name: "h264_nvenc", family: fam, args: ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "cbr", "-b:v", b, "-maxrate", b, "-bufsize", buf, "-profile:v", "high", "-pix_fmt", "yuv420p"] };
      if (fam === "qsv" && probe.h264_qsv) return { name: "h264_qsv", family: fam, args: ["-c:v", "h264_qsv", "-b:v", b, "-maxrate", b, "-minrate", b, "-bufsize", buf, "-profile:v", "high", "-pix_fmt", "nv12"] };
      if (fam === "amf" && probe.h264_amf) return { name: "h264_amf", family: fam, args: ["-c:v", "h264_amf", "-rc", "cbr", "-b:v", b, "-maxrate", b, "-bufsize", buf, "-profile:v", "high", "-pix_fmt", "nv12"] };
      if (fam === "software") break;
    }
    return { name: "libx264", family: "software", args: ["-c:v", "libx264", "-preset", "medium", "-b:v", b, "-minrate", b, "-maxrate", b, "-bufsize", buf, "-x264-params", "nal-hrd=cbr", "-profile:v", "high", "-pix_fmt", "yuv420p"] };
  }
  if (p.codec === "h264") {
    for (const fam of order) {
      if (fam === "nvenc" && probe.h264_nvenc) return { name: "h264_nvenc", family: fam, args: ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", cq, "-b:v", "0", "-profile:v", "high", "-pix_fmt", "yuv420p"] };
      if (fam === "qsv" && probe.h264_qsv) return { name: "h264_qsv", family: fam, args: ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", cq, "-profile:v", "high", "-pix_fmt", "nv12"] };
      if (fam === "amf" && probe.h264_amf) return { name: "h264_amf", family: fam, args: ["-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", cq, "-qp_p", cq, "-profile:v", "high", "-pix_fmt", "nv12"] };
      if (fam === "software") break;
    }
    return { name: "libx264", family: "software", args: ["-c:v", "libx264", "-preset", "medium", "-crf", cq, "-profile:v", "high", "-pix_fmt", "yuv420p"] };
  }
  // HEVC
  for (const fam of order) {
    if (fam === "nvenc" && (ten ? probe.hevc_nvenc_10bit : probe.hevc_nvenc)) {
      return { name: "hevc_nvenc", family: fam, args: ["-c:v", "hevc_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", cq, "-b:v", "0",
        ...(ten ? ["-profile:v", "main10", "-pix_fmt", "p010le"] : ["-profile:v", "main", "-pix_fmt", "yuv420p"]), "-tag:v", "hvc1"] };
    }
    if (fam === "qsv" && (ten ? probe.hevc_qsv_10bit : probe.hevc_qsv)) {
      return { name: "hevc_qsv", family: fam, args: ["-c:v", "hevc_qsv", "-preset", "medium", "-global_quality", cq,
        ...(ten ? ["-profile:v", "main10", "-pix_fmt", "p010le"] : ["-profile:v", "main", "-pix_fmt", "nv12"]), "-tag:v", "hvc1"] };
    }
    if (fam === "amf" && probe.hevc_amf && !ten) {
      return { name: "hevc_amf", family: fam, args: ["-c:v", "hevc_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", cq, "-qp_p", cq, "-pix_fmt", "nv12", "-tag:v", "hvc1"] };
    }
    if (fam === "software") break;
  }
  return { name: "libx265", family: "software", args: ["-c:v", "libx265", "-preset", "medium", "-crf", cq, "-pix_fmt", ten ? "yuv420p10le" : "yuv420p", "-tag:v", "hvc1"] };
}

/** Presets with what this PC would use (AV1 hidden when the probe fails). */
export function presetList(probe: Record<string, boolean>, prefer: EncoderPreference = "auto", allow10bit = true): RenderPreset[] {
  const out: RenderPreset[] = [];
  for (const p of PRESETS) {
    const enc = finalEncoder(p, probe, prefer, allow10bit);
    if (!enc) continue; // e.g. AV1 on a GPU without an AV1 encoder: hidden
    out.push({ id: p.id, label: p.label, w: p.w, h: p.h, fps: p.fps ?? 24, codec: p.codec, container: p.container,
      hardware: enc.family === "software" ? false : enc.name, orientation: p.orientation, tenBit: p.tenBit, note: p.note, encoder: enc.name });
  }
  return out;
}

// ── steps ──

export interface ResolvedAudio { path: string; offset: number; gain_db?: number }

export interface SegmentCtx {
  w: number; h: number; fps: number;
  src: string;
  out: string;
  enc: string[];
  /** Local paths of the segment's audio override / extra tracks. */
  override?: string | null;
  extra?: ResolvedAudio[];
  /** Whether the source has an audio stream (from the plan or a local probe). */
  hasAudio: boolean;
  luts: Record<string, string>;
  localUpscale?: boolean;
  /** The vidstabdetect result when the shot is stabilised. */
  trf?: string | null;
  /** plan.stabilize_filters.transform (with @@TRF@@). */
  stabTransform?: string;
}

/** First pass of stabilising (backend normalize_clip, fx.stabilize). */
export function stabilizeDetectArgs(seg: PlanSegment, src: string, trf: string, detect = STAB_DETECT): string[] {
  return ["-ss", f3(seg.trim_in), "-t", f3(seg.seg_len * (seg.speed || 1) + 0.5), "-i", src, "-vf", withTrf(detect, trf), "-f", "null", "-"];
}

function sharpen(seg: PlanSegment, ctx: SegmentCtx): string {
  return ctx.localUpscale && !seg.upscaled && isUhd(ctx.w, ctx.h) ? ",unsharp=5:5:0.5" : "";
}

/** A video segment, scaled / cropped / trimmed to the export format with its audio graph (backend ffmpeg.normalize_clip). */
export function segmentArgs(seg: PlanSegment, ctx: SegmentCtx): string[] {
  const { w, h, fps } = ctx;
  const speed = Number(seg.speed || 1);
  const segLen = seg.seg_len;
  const stab = seg.stabilize && ctx.trf ? withTrf(ctx.stabTransform || STAB_TRANSFORM, ctx.trf) : "";
  const args: string[] = ["-ss", f3(seg.trim_in), "-t", f3(segLen * speed + 0.5), "-i", ctx.src];
  const inputsAudio: string[] = [];
  let idx = 1;
  if (ctx.override) {
    args.push("-i", ctx.override);
    inputsAudio.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,apad[a${idx}]`);
    idx++;
  } else if (seg.keep_src_audio && ctx.hasAudio) {
    const gain = seg.src_gain_db ? `,volume=${num(seg.src_gain_db)}dB` : "";
    inputsAudio.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo${gain},apad[a0]`);
  }
  for (const ex of ctx.extra ?? []) {
    const gain = ex.gain_db ? `,volume=${num(ex.gain_db)}dB` : "";
    args.push("-i", ex.path);
    const ms = Math.trunc(Math.max(ex.offset, 0) * 1000);
    inputsAudio.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo${gain},adelay=${ms}|${ms},apad[a${idx}]`);
    idx++;
  }
  if (!inputsAudio.length) {
    args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
    inputsAudio.push(`[${idx}:a]apad[a${idx}]`);
    idx++;
  }
  const labels = inputsAudio.map((s) => s.slice(s.lastIndexOf("[") + 1, -1));
  let fc = inputsAudio.join(";");
  let amap: string;
  if (labels.length > 1) {
    fc += `;${labels.map((l) => `[${l}]`).join("")}amix=inputs=${labels.length}:normalize=0:duration=longest[am]`;
    amap = "[am]";
  } else {
    amap = `[${labels[0]}]`;
  }
  // the plan's af_fx is backend clip_audio_filters: the atempo chain and the fades (older plans had only the fades)
  const aFx: string[] = Math.abs(speed - 1) > 1e-3 && !(seg.af_fx || "").includes("atempo") ? [atempoChain(speed)] : [];
  if (seg.af_fx) aFx.push(seg.af_fx);
  if (aFx.length) {
    fc += `;${amap}${aFx.join(",")},apad[afx]`;
    amap = "[afx]";
  }
  let vchain: string;
  if (seg.vf) {
    vchain = stab + uhdVf(substituteLuts(seg.vf, ctx.luts), w, h, Boolean(ctx.localUpscale && !seg.upscaled));
  } else { // an older plan without `vf`: build it as backend ffmpeg.clip_vf does
    const post = substituteLuts(seg.vf_post || "", ctx.luts);
    vchain = `${stab}${seg.pre || ""}${fitFilter(w, h, seg.center)}${sharpen(seg, ctx)},fps=${fps}${post ? `,${post}` : ""},tpad=stop_mode=clone:stop_duration=30`;
  }
  fc += `;[0:v]${vchain}[vv]`;
  args.push("-filter_complex", fc, "-map", "[vv]", "-map", amap, "-t", f3(segLen), ...ctx.enc, ...AUDIO_INTERMEDIATE, ctx.out);
  return args;
}

/** A still (keyframe or end card) as a clip with Ken Burns or a plain fit (backend ffmpeg.still_to_video). */
export function stillArgs(opts: { image: string; out: string; seconds: number; w: number; h: number; fps: number; audio?: string | null;
  kenburns: boolean; vfPost?: string; afFx?: string; luts?: Record<string, string>; enc: string[]; localUpscale?: boolean; vf?: string }): string[] {
  const { w, h, fps, seconds } = opts;
  const frames = Math.max(Math.round(seconds * fps), 1);
  let vf: string;
  if (opts.vf) {
    vf = uhdVf(substituteLuts(opts.vf, opts.luts ?? {}), w, h, Boolean(opts.localUpscale));
  } else if (opts.kenburns) {
    vf = `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase${scaleFlags(w, h)},crop=${w * 2}:${h * 2},`
      + `zoompan=z='min(zoom+0.0009,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${fps},setsar=1`;
  } else {
    vf = `${fitFilter(w, h)},fps=${fps}`;
  }
  if (!opts.vf) {
    if (opts.localUpscale && isUhd(w, h)) vf += ",unsharp=5:5:0.5";
    const extra = substituteLuts(opts.vfPost || "", opts.luts ?? {});
    if (extra) vf += `,${extra}`;
  }
  const af = opts.afFx || "";
  const args: string[] = ["-loop", "1", "-framerate", String(fps), "-i", opts.image];
  if (opts.audio) args.push("-i", opts.audio);
  else args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push("-t", f3(seconds), "-vf", vf, "-map", "0:v", "-map", "1:a", "-af", `apad,atrim=0:${f3(seconds)}${af ? `,${af}` : ""}`,
    ...opts.enc, ...AUDIO_INTERMEDIATE, "-shortest", opts.out);
  return args;
}

/** A still's voice + extra sounds mixed into one track (backend assembler._mix_audio). */
export function mixAudioArgs(base: string | null | undefined, extra: ResolvedAudio[], seconds: number, out: string): string[] {
  const args: string[] = [];
  const filters: string[] = [];
  const labels: string[] = [];
  let idx = 0;
  if (base) {
    args.push("-i", base);
    filters.push(`[${idx}:a]aresample=48000,apad[a${idx}]`);
    labels.push(`[a${idx}]`);
    idx++;
  }
  for (const ex of extra) {
    const gain = ex.gain_db ? `,volume=${num(ex.gain_db)}dB` : "";
    args.push("-i", ex.path);
    const ms = Math.trunc(ex.offset * 1000);
    filters.push(`[${idx}:a]aresample=48000${gain},adelay=${ms}|${ms},apad[a${idx}]`);
    labels.push(`[a${idx}]`);
    idx++;
  }
  const fc = `${filters.join(";")};${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest[o]`;
  return [...args, "-filter_complex", fc, "-map", "[o]", "-t", f3(seconds), out];
}

/** Join clips with xfade / acrossfade transitions (backend ffmpeg.xfade_concat). null = no transitions: use concat. */
export function xfadeArgs(clips: string[], lengths: number[], transitions: ([string, number] | null)[], out: string, fps: number, enc: string[]): string[] | null {
  if (!transitions.slice(1).some(Boolean)) return null;
  const args: string[] = [];
  for (const c of clips) args.push("-i", c);
  const f: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    f.push(`[${i}:v]setpts=PTS-STARTPTS,settb=AVTB,fps=${fps},format=yuv420p[v${i}]`);
    f.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`);
  }
  let vcur = "v0";
  let acur = "a0";
  let length = lengths[0];
  for (let i = 1; i < clips.length; i++) {
    const tr = transitions[i];
    const vo = `vx${i}`;
    const ao = `ax${i}`;
    if (tr) {
      const [name, dd] = tr;
      const d = Math.max(0.1, Math.min(dd, lengths[i] / 2, length / 2));
      const off = Math.max(length - d, 0);
      f.push(`[${vcur}][v${i}]xfade=transition=${name}:duration=${f3(d)}:offset=${f3(off)}[${vo}]`);
      f.push(`[${acur}][a${i}]acrossfade=d=${f3(d)}:c1=tri:c2=tri[${ao}]`);
      length = length + lengths[i] - d;
    } else {
      f.push(`[${vcur}][${acur}][v${i}][a${i}]concat=n=2:v=1:a=1[${vo}c][${ao}]`);
      f.push(`[${vo}c]fps=${fps}[${vo}]`);
      length += lengths[i];
    }
    vcur = vo;
    acur = ao;
  }
  return [...args, "-filter_complex", f.join(";"), "-map", `[${vcur}]`, "-map", `[${acur}]`, ...enc, ...AUDIO_INTERMEDIATE, out];
}

/** The concat demuxer list (backend ffmpeg.concat) and its args. */
export function concatList(clips: string[]): string {
  return clips.map((c) => `file '${c.replace(/\\/g, "/").replace(/'/g, "'\\''")}'\n`).join("");
}
export function concatArgs(listFile: string, out: string): string[] {
  return ["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", out];
}

/** The body's sound as one track (backend ffmpeg.extract_audio: mono, 44.1 kHz WAV). */
export function extractAudioArgs(video: string, outWav: string): string[] {
  return ["-i", video, "-vn", "-ac", "1", "-ar", "44100", outWav];
}

export interface ResolvedPic extends PlanPic { path: string }
export interface ResolvedSound extends PlanSound { path: string }

/** Composite the picture layers over the body (backend layers.overlay_graph + overlay), picture only. */
export function overlayArgs(body: string, pics: ResolvedPic[], out: string, enc: string[]): string[] {
  const args: string[] = ["-i", body];
  const f: string[] = [];
  let base = "0:v";
  pics.forEach((c, i) => {
    const k = i + 1;
    if (c.kind === "image") args.push("-loop", "1", "-framerate", "24", "-t", f3(c.dur), "-i", c.path);
    else args.push("-ss", f3(c.in), "-t", f3(c.dur), "-i", c.path);
    const st = c.start;
    const end = c.start + c.dur;
    f.push(`[${k}:v]${c.chain.join(",")}[p${k}]`);
    f.push(`[${base}][p${k}]overlay=x='${c.x}':y='${c.y}':enable='between(t,${f3(st)},${f3(end)})':eof_action=pass[b${k}]`);
    base = `b${k}`;
  });
  return [...args, "-filter_complex", f.join(";"), "-map", `[${base}]`, "-an", ...enc, out];
}

/** Lay the sound layers over the mix (backend layers.mix). Sounds without an audio stream are skipped. null = nothing to do. */
export function mixArgs(baseAudio: string, sounds: ResolvedSound[], total: number, out: string): string[] | null {
  const args: string[] = ["-i", baseAudio];
  const f = ["[0:a]aresample=48000,aformat=channel_layouts=stereo[a0]"];
  const labels = ["[a0]"];
  for (const c of sounds) {
    if (c.has_audio === false) continue;
    args.push("-ss", f3(c.in), "-t", f3(c.dur), "-i", c.path);
    const idx = labels.length;
    const ms = Math.trunc(c.start * 1000);
    const chain = ["aresample=48000", "aformat=channel_layouts=stereo", `volume=${num(c.gain_db ?? 0)}dB`];
    if (c.fade_in) chain.push(`afade=t=in:st=0:d=${num(c.fade_in)}`);
    if (c.fade_out) chain.push(`afade=t=out:st=${f3(Math.max(c.dur - c.fade_out, 0))}:d=${num(c.fade_out)}`);
    chain.push(`adelay=${ms}|${ms}`);
    f.push(`[${idx}:a]${chain.join(",")}[a${idx}]`);
    labels.push(`[a${idx}]`);
  }
  if (labels.length === 1) return null;
  f.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=first[m]`);
  return [...args, "-filter_complex", f.join(";"), "-map", "[m]", "-t", f3(total), "-ar", "48000", "-ac", "2", out];
}

/** Loop / trim the music, fade it out and duck it under the voices (backend ffmpeg.music_bed). */
export function musicBedArgs(music: string, voiceMix: string | null, out: string, length: number, volumeDb = -16, duck = true): string[] {
  const fadeStart = Math.max(length - 2.0, 0);
  const base = `[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=${num(volumeDb)}dB,atrim=0:${f3(length)},afade=t=out:st=${f3(fadeStart)}:d=2[m]`;
  if (voiceMix && duck) {
    const fc = `${base};[1:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[sc][vo];`
      + "[m][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350[md];"
      + "[md][vo]amix=inputs=2:normalize=0:duration=first[out]";
    return ["-stream_loop", "-1", "-i", music, "-i", voiceMix, "-filter_complex", fc, "-map", "[out]", "-t", f3(length), "-ar", "48000", out];
  }
  return ["-stream_loop", "-1", "-i", music, "-filter_complex", base, "-map", "[m]", "-t", f3(length), out];
}

/** The final mux: loudness-normalised sound, burned ASS captions / titles, the preset's encoder (backend replace_audio_mix). */
export function finalArgs(opts: { video: string; audio: string; out: string; ass?: string | null; fontsDir?: string | null; loudnorm?: string;
  encoder: string[]; container: "mp4" | "mov"; fps?: number }): string[] {
  const af = opts.loudnorm || "loudnorm=I=-14:TP=-1.5:LRA=11";
  const args: string[] = ["-i", opts.video, "-i", opts.audio];
  if (opts.ass) {
    let vf = `ass='${escAssPath(opts.ass)}':shaping=complex`;
    if (opts.fontsDir) vf += `:fontsdir='${escAssPath(opts.fontsDir)}'`;
    args.push("-vf", vf);
  }
  args.push(...opts.encoder);
  if (opts.fps) args.push("-r", String(opts.fps));
  const audio = opts.container === "mov" ? ["-c:a", "pcm_s24le", "-ar", "48000"] : ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"];
  args.push("-map", "0:v", "-map", "1:a", "-af", af, ...audio, "-movflags", "+faststart", "-shortest", opts.out);
  return args;
}

/** Step weights for the overall progress bar. */
export function stepWeights(plan: RenderPlan, opts: { music: boolean }): { id: string; label: string; weight: number; seconds: number }[] {
  const total = plan.segments.reduce((s, x) => s + x.seg_len, 0) || 1;
  const steps: { id: string; label: string; weight: number; seconds: number }[] = [{ id: "prepare", label: "Getting the media", weight: 4, seconds: 0 }];
  plan.segments.forEach((s, i) => steps.push({ id: `seg${i}`, label: `Shot ${i + 1} of ${plan.segments.length} (${s.code})`,
    weight: (55 * s.seg_len) / total * (s.stabilize ? 1.6 : 1), seconds: s.seg_len }));
  const body = total - plan.segments.slice(1).reduce((s, x) => s + (x.transition ? x.transition[1] : 0), 0) + (plan.end_card?.seconds ?? 0);
  if (plan.end_card) steps.push({ id: "endcard", label: "End card", weight: 2, seconds: plan.end_card.seconds });
  steps.push({ id: "join", label: "Joining the shots", weight: 9, seconds: body });
  steps.push({ id: "voice", label: "Sound mix", weight: 1, seconds: body });
  if (plan.layers?.pics?.length) steps.push({ id: "layers", label: "Picture layers", weight: 9, seconds: body });
  if (plan.layers?.sounds?.length) steps.push({ id: "mix", label: "Sound layers", weight: 2, seconds: body });
  if (plan.music && opts.music) steps.push({ id: "music", label: "Music bed", weight: 2, seconds: body });
  steps.push({ id: "final", label: "Final encode", weight: 16, seconds: body });
  const sum = steps.reduce((s, x) => s + x.weight, 0);
  return steps.map((s) => ({ ...s, weight: s.weight / sum }));
}
