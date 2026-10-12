/**
 * Analysis for auto edit and the `analyze_media` tool (docs/EDITOR.md §13.2, §13.3), all free on this PC: silences,
 * scene cuts, beats and loudness through EditorManager.analyze (editor-analyze.ts), local Whisper through
 * EditorManager.transcribeLocal (editor-whisper.ts), and bad takes plus the energy / motion curves in one FFmpeg pass
 * (autoedit-analyze.ts). Two files at a time. Electron-free.
 */
import { existsSync } from "node:fs";
import type { AnalysisKindName, AnalyzeKind, AnalyzeMediaRef, AnalyzeOptions, AnalyzeResult, LocalTranscript, MediaAnalysis, TranscribeOptions } from "../../shared/types.ts";
import { parseQuality, qualityArgs, type QualityResult } from "../autoedit-analyze.ts";
import { Limiter } from "../editor-media.ts";
import { mediaKind } from "./security.ts";

export interface AnalyzerDeps {
  analyze(file: string, mediaId: string, kind: AnalyzeKind, opts?: AnalyzeOptions): Promise<AnalyzeResult>;
  transcribe?(file: string, mediaId: string, opts: TranscribeOptions): Promise<LocalTranscript>;
  /** which Whisper model is installed (null: none) */
  whisperModel?(): "base" | "large-v3-turbo-q5" | null;
  /** runs FFmpeg with every stderr line passed on (editor-media.runFfmpegLines with the found FFmpeg) */
  ffmpegLines(args: string[], onLine: (l: string) => void, signal?: AbortSignal): Promise<void>;
  log(m: string): void;
}

export const DEFAULT_KINDS: AnalysisKindName[] = ["silence", "scenes", "loudness", "quality"];

export class Analyzer {
  private limiter = new Limiter(2);
  private deps: AnalyzerDeps;
  constructor(deps: AnalyzerDeps) { this.deps = deps; }

  async quality(file: string, o: { video: boolean; audio: boolean; duration: number }, signal?: AbortSignal): Promise<QualityResult> {
    const lines: string[] = [];
    let header = true;
    await this.deps.ffmpegLines(qualityArgs(file, o), (l) => {
      // the input header (tags) and the detector lines; FFmpeg's progress lines are dropped
      if (header && /^\s*Stream mapping:/.test(l)) header = false;
      if (header || /black_start|freezedetect|Parsed_a?metadata_/.test(l)) lines.push(l);
    }, signal);
    return parseQuality(lines, o.duration);
  }

  /** Everything asked for, per item; a failed kind is a warning on that item, not an error of the batch. */
  async run(editPath: string, items: AnalyzeMediaRef[], kinds: AnalysisKindName[] = DEFAULT_KINDS,
    o: { signal?: AbortSignal; language?: string; onProgress?(done: number, total: number, current: string): void } = {}): Promise<MediaAnalysis[]> {
    const want = new Set(kinds.length ? kinds : DEFAULT_KINDS);
    let done = 0;
    const out = await Promise.all(items.map((it) => this.limiter.run(async () => {
      if (o.signal?.aborted) throw new Error("cancelled");
      const r: MediaAnalysis = { mediaId: it.id, name: it.name, kind: it.kind, duration: it.seconds ?? 0, hasAudio: it.hasAudio,
        width: it.width ?? 0, height: it.height ?? 0 };
      const warn = (w: string) => { (r.warnings ??= []).push(w.slice(0, 300)); };
      const soft = async (what: string, fn: () => Promise<void>) => {
        try { await fn(); } catch (e) { if (o.signal?.aborted) throw e; warn(`${what}: ${(e as Error).message}`); }
      };
      const video = it.kind === "video";
      if (it.kind !== "image") {
        if (want.has("silence") && it.hasAudio) await soft("silence", async () => {
          const a = await this.deps.analyze(editPath, it.id, "silence", { noiseDb: -35, minMs: 400 });
          if (a.kind === "silence") { r.silences = a.segments; if (!r.duration) r.duration = a.duration; }
        });
        if (want.has("scenes") && video) await soft("scenes", async () => {
          const a = await this.deps.analyze(editPath, it.id, "scenes", { threshold: 0.3 });
          if (a.kind === "scenes") { r.scenes = a.cuts; if (!r.duration) r.duration = a.duration; }
        });
        if (want.has("beats") && it.hasAudio && (it.kind === "audio" || kinds.includes("beats"))) await soft("beats", async () => {
          const a = await this.deps.analyze(editPath, it.id, "beats");
          if (a.kind === "beats") { r.beats = a.beats; r.bpm = a.bpm; }
        });
        if (want.has("loudness") && it.hasAudio) await soft("loudness", async () => {
          const a = await this.deps.analyze(editPath, it.id, "loudness");
          if (a.kind === "loudness") r.loudness = { lufs: a.lufs, lra: a.lra, truePeak: a.truePeak };
        });
        if (want.has("quality") && existsSync(it.path) && mediaKind(it.path)) await soft("quality", async () => {
          const q = await this.quality(it.path, { video, audio: it.hasAudio, duration: r.duration || it.seconds || 0 }, o.signal);
          Object.assign(r, { black: q.black, freeze: q.freeze, blur: q.blur, clipped: q.clipped, energy: q.energy, motion: q.motion });
          if (q.blurScore !== null) r.blurScore = q.blurScore;
          if (q.created) r.created = q.created;
          if (q.timecode) r.timecode = q.timecode;
        });
        if (want.has("transcript") && it.hasAudio) await soft("transcript", async () => {
          const model = this.deps.whisperModel?.() ?? null;
          if (!this.deps.transcribe || !model) throw new Error("local Whisper isn't installed (Tools → Whisper); captions can still come from the paid AI tool");
          const t = await this.deps.transcribe(editPath, it.id, { language: o.language || "auto", model });
          r.transcript = t.segments.map((s) => ({ start: s.start, end: s.end, text: s.text.trim(),
            ...(s.words?.length ? { words: s.words.map((w) => ({ start: w.start, end: w.end, text: w.text })) } : {}) }));
          r.language = t.language;
        });
      }
      done++;
      o.onProgress?.(done, items.length, it.name);
      return r;
    })));
    return out;
  }
}
