/**
 * Auto edit's extra analysis (docs/EDITOR.md §13.3): bad takes and the shape of each clip, in ONE FFmpeg decode pass
 * at 320 px:
 *   - blackdetect (black stretches), freezedetect (frozen picture), blurdetect at 2 fps (soft or out-of-focus parts),
 *   - the scene score at 2 fps (how much the picture moves: the "motion" curve for highlights),
 *   - astats per half second (RMS level = the "energy" curve, peak and flat factor = clipped sound),
 *   - the creation_time and timecode tags of the file.
 * Silences, scene cuts, beats and loudness come from editor-analyze.ts through EditorManager.analyze. Argument builder
 * and parser are pure (test/autowatch-analyze.test.ts); the runner is editor-media's runFfmpegLines.
 */

export interface Range { start: number; end: number }
export interface QualityResult {
  black: Range[]; freeze: Range[]; blur: Range[]; blurScore: number | null; clipped: Range[];
  peakDb: number | null; energy: number[]; motion: number[];
  created?: string; timecode?: string;
}

export const WINDOW_S = 0.5;
/** blurdetect on 320 px frames: sharp footage reads about 3–7, out of focus 15 and up. */
export const BLUR_ABS = 9;
export const BLUR_REL = 1.8;

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The one-pass graph. `video` / `audio`: which streams the file has. Output goes to the null muxer. */
export function qualityArgs(src: string, o: { video: boolean; audio: boolean }): string[] {
  const parts: string[] = [];
  const maps: string[] = [];
  if (o.video) {
    parts.push("[0:v:0]scale=320:-2,split=2[qa][qb]",
      "[qa]blackdetect=d=0.4:pix_th=0.10,freezedetect=n=-60dB:d=1.0[qv]",
      "[qb]fps=2,format=gray,select='gte(scene\\,0)',blurdetect=block_width=32:block_height=32,metadata=mode=print,nullsink");
    maps.push("-map", "[qv]");
  }
  if (o.audio) {
    parts.push("[0:a:0]aresample=48000,asetnsamples=n=24000:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level+Flat_factor+RMS_level,ametadata=mode=print[qaud]");
    maps.push("-map", "[qaud]");
  }
  if (!parts.length) throw new Error("Nothing to analyse: the file has neither picture nor sound");
  return ["-i", src, "-filter_complex", parts.join(";"), ...maps, "-f", "null", "-"];
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Consecutive flagged samples (each `step` s long) → ranges, joined over gaps up to `join` s, at least `min` s. */
export function flaggedRanges(samples: { t: number; on: boolean }[], step: number, opts: { join?: number; min?: number; duration?: number } = {}): Range[] {
  const join = opts.join ?? step;
  const min = opts.min ?? step;
  const out: Range[] = [];
  let cur: Range | null = null;
  for (const s of [...samples].sort((a, b) => a.t - b.t)) {
    if (!s.on) continue;
    const end = s.t + step;
    if (cur && s.t - cur.end <= join + 1e-6) cur.end = end;
    else { if (cur) out.push(cur); cur = { start: s.t, end }; }
  }
  if (cur) out.push(cur);
  return out.filter((r) => r.end - r.start >= min - 1e-6).map((r) => ({ start: r3(r.start), end: r3(opts.duration ? Math.min(r.end, opts.duration) : r.end) }));
}

/** FFmpeg's stderr lines of a qualityArgs run → the result. */
export function parseQuality(lines: string[], duration: number): QualityResult {
  const black: Range[] = [];
  const freeze: Range[] = [];
  let freezeOpen: number | null = null;
  const now = new Map<string, number>();
  const blurS: { t: number; v: number }[] = [];
  const motionS = new Map<number, number>();
  const audio = new Map<number, { peak?: number; rms?: number; flat?: number }>();
  let created: string | undefined;
  let timecode: string | undefined;
  for (const raw of lines) {
    const l = raw.trim();
    let m = /black_start:\s*(-?[\d.]+)\s+black_end:\s*([\d.]+)/.exec(l);
    if (m) { black.push({ start: r3(Math.max(0, Number(m[1]))), end: r3(Number(m[2])) }); continue; }
    m = /freezedetect\.freeze_start:\s*([\d.]+)/.exec(l);
    if (m) { freezeOpen = Number(m[1]); continue; }
    m = /freezedetect\.freeze_end:\s*([\d.]+)/.exec(l);
    if (m && freezeOpen !== null) { freeze.push({ start: r3(freezeOpen), end: r3(Number(m[1])) }); freezeOpen = null; continue; }
    if (!created) { const c = /^creation_time\s*:\s*(\S+)/.exec(l); if (c) { created = c[1]; continue; } }
    if (!timecode) { const c = /^timecode\s*:\s*(\d{2}:\d{2}:\d{2}[:;]\d{2})/.exec(l); if (c) { timecode = c[1]; continue; } }
    const p = /^\[(Parsed_a?metadata_\d+) @ [^\]]+\]\s*(.*)$/.exec(l);
    if (!p) continue;
    const [, who, rest] = p;
    const f = /pts_time:\s*(-?[\d.]+)/.exec(rest);
    if (f) { now.set(who, Number(f[1])); continue; }
    const t = now.get(who);
    if (t === undefined) continue;
    const kv = /^([\w.]+)=(.*)$/.exec(rest);
    if (!kv) continue;
    const v = kv[2] === "-inf" ? Number.NEGATIVE_INFINITY : Number(kv[2]);
    const slot = Math.round(t / WINDOW_S);
    if (kv[1] === "lavfi.blur") { if (Number.isFinite(v)) blurS.push({ t, v }); }
    else if (kv[1] === "lavfi.scene_score") { if (Number.isFinite(v)) motionS.set(slot, v); }
    else if (kv[1].startsWith("lavfi.astats.Overall.")) {
      const a = audio.get(slot) ?? {};
      if (kv[1].endsWith("Peak_level")) a.peak = v;
      else if (kv[1].endsWith("RMS_level")) a.rms = v;
      else if (kv[1].endsWith("Flat_factor")) a.flat = v;
      audio.set(slot, a);
    }
  }
  if (freezeOpen !== null && duration > freezeOpen) freeze.push({ start: r3(freezeOpen), end: r3(duration) });
  const blurScore = median(blurS.map((b) => b.v));
  const th = Math.max(BLUR_ABS, (blurScore ?? 0) * BLUR_REL);
  const blur = flaggedRanges(blurS.map((b) => ({ t: b.t, on: b.v > th })), WINDOW_S, { join: 0.5, min: 1, duration });
  const slots = Math.max(0, Math.ceil(duration / WINDOW_S));
  const energy: number[] = [];
  const motion: number[] = [];
  const clipFlags: { t: number; on: boolean }[] = [];
  let peakDb: number | null = null;
  for (let i = 0; i < slots; i++) {
    const a = audio.get(i);
    const rms = a?.rms;
    energy.push(rms === undefined || !Number.isFinite(rms) ? -90 : Math.round(Math.max(-90, rms) * 10) / 10);
    motion.push(Math.round((motionS.get(i) ?? 0) * 1000) / 1000);
    if (a?.peak !== undefined && Number.isFinite(a.peak)) peakDb = peakDb === null ? a.peak : Math.max(peakDb, a.peak);
    clipFlags.push({ t: i * WINDOW_S, on: (a?.peak ?? -99) >= -0.1 && (a?.flat ?? 0) > 1 });
  }
  if (!audio.size) energy.length = 0;
  if (!motionS.size) motion.length = 0;
  const clipped = flaggedRanges(clipFlags, WINDOW_S, { join: 0.5, min: WINDOW_S, duration });
  return { black, freeze, blur, blurScore: blurScore === null ? null : Math.round(blurScore * 100) / 100, clipped,
    peakDb: peakDb === null ? null : Math.round(peakDb * 100) / 100, energy, motion, ...(created ? { created } : {}), ...(timecode ? { timecode } : {}) };
}

/** Natural ("series") order of names: S01E02_003 before S01E02_010, like the series names (docs/DESKTOP.md §3.1). */
export const naturalCompare = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
