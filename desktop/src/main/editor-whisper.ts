/**
 * Local speech to text with whisper.cpp (docs/EDITOR.md §10, desktop-tools): the 16 kHz mono WAV extract, the
 * whisper-cli arguments (`-ojf`: the full JSON with every token's offsets) and the parser that turns tokens into words.
 *
 * whisper.cpp writes token texts as raw bytes, and Indic scripts are split into byte-level pieces (one Kannada letter
 * can be two tokens, each half a UTF-8 sequence). So the JSON is read as latin1 (one char per byte), the pieces are
 * joined per word, and only whole words are decoded as UTF-8. A token that starts with a space starts a word;
 * punctuation stays with the word before it; special tokens ([_BEG_], [_TT_123] …) are dropped.
 * Pure (test/editor-tools.test.ts).
 */
import type { LocalTranscript, TranscriptSegment, TranscriptWord } from "../shared/types.ts";

export const WHISPER_RATE = 16000;

/** Languages whisper knows (its codes) that the studio uses; "auto" detects. Others are passed on if whisper has them. */
export const WHISPER_LANGS = ["auto", "en", "hi", "kn", "te", "ta", "ml", "mr", "bn", "gu", "pa", "ur", "or", "as", "sa", "ne", "si", "fr", "de", "es",
  "it", "pt", "ru", "ja", "ko", "zh", "ar"] as const;

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function checkLanguage(lang: unknown): string {
  const l = String(lang ?? "auto").trim().toLowerCase();
  if (l === "auto" || /^[a-z]{2,3}$/.test(l)) return l;
  throw new Error(`"${String(lang)}" isn't a language code (use auto, en, hi, kn, te, ta …)`);
}

/** The sound of [in, out) as the 16 kHz mono 16-bit WAV whisper wants. */
export function wavArgs(src: string, out: string, inS = 0, outS?: number): string[] {
  const seek = inS > 0 ? ["-ss", inS.toFixed(3)] : [];
  const dur = outS !== undefined && outS > inS ? ["-t", (outS - inS).toFixed(3)] : [];
  return [...seek, ...dur, "-i", src, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(WHISPER_RATE), "-c:a", "pcm_s16le", out];
}

export function whisperArgs(o: { model: string; wav: string; outBase: string; language: string; threads: number; gpu: boolean;
  translate?: boolean; prompt?: string }): string[] {
  const a = ["-m", o.model, "-f", o.wav, "-of", o.outBase, "-ojf", "-pp", "-np", "-l", o.language, "-t", String(Math.max(1, Math.round(o.threads)))];
  if (o.translate) a.push("-tr");
  if (o.prompt && o.prompt.trim()) a.push("--prompt", o.prompt.trim().slice(0, 600));
  if (!o.gpu) a.push("-ng");
  return a;
}

/** "whisper_print_progress_callback: progress =  40%" → 0.4 */
export function parseWhisperProgress(line: string): number | null {
  const m = /progress\s*=\s*(\d{1,3})%/.exec(line);
  return m ? Math.min(1, Number(m[1]) / 100) : null;
}

/** whisper fell back to the CPU (the CUDA backend didn't load). */
export const noGpuInLog = (log: string) => /no GPU found/i.test(log);

interface WToken { text?: string; offsets?: { from?: number; to?: number }; p?: number; id?: number }
interface WSegment { offsets?: { from?: number; to?: number }; text?: string; tokens?: WToken[] }
interface WJson { result?: { language?: string }; params?: { language?: string }; transcription?: WSegment[] }

const utf8 = (latin1: string) => Buffer.from(latin1, "latin1").toString("utf8");
const isSpecial = (t: string) => /^\[_[A-Z]+_?\d*\]$/.test(t) || /^\[_[A-Z_]+\]$/.test(t) || /^<\|.*\|>$/.test(t);
/** Text with nothing word-like in it: attaches to the word before. */
const isPunct = (s: string) => s.length > 0 && !/[\p{L}\p{N}\p{M}]/u.test(s);

/**
 * The full JSON (`-ojf`, read as latin1) → segments with words, in seconds plus `offset` (media time of the WAV's
 * start). Words keep inside their segment and in order; empty segments are dropped.
 */
export function parseWhisperJson(latin1Json: string, offset = 0): { language: string; segments: TranscriptSegment[] } {
  const j = JSON.parse(latin1Json) as WJson;
  const language = String(j.result?.language || j.params?.language || "");
  const segments: TranscriptSegment[] = [];
  for (const s of j.transcription ?? []) {
    const s0 = (Number(s.offsets?.from) || 0) / 1000;
    const s1 = Math.max(s0, (Number(s.offsets?.to) || 0) / 1000);
    const words: TranscriptWord[] = [];
    let cur: { bytes: string; from: number; to: number; p: number } | null = null;
    const flush = () => {
      if (!cur) return;
      const text = utf8(cur.bytes).replace(/�/g, "").trim();
      if (text) {
        if (isPunct(text) && words.length) {
          const w = words[words.length - 1];
          w.text += text;
          w.end = Math.max(w.end, cur.to);
        } else {
          words.push({ start: cur.from, end: Math.max(cur.from, cur.to), text, p: Math.round(cur.p * 1000) / 1000 });
        }
      }
      cur = null;
    };
    for (const t of s.tokens ?? []) {
      const raw = String(t.text ?? "");
      if (!raw || isSpecial(raw)) continue;
      const from = (Number(t.offsets?.from) || 0) / 1000;
      const to = (Number(t.offsets?.to) || 0) / 1000;
      const p = Number.isFinite(Number(t.p)) ? Number(t.p) : 1;
      if (raw.startsWith(" ") || !cur) {
        flush();
        cur = { bytes: raw, from, to, p };
      } else {
        cur.bytes += raw;
        cur.to = Math.max(cur.to, to);
        cur.p = Math.min(cur.p, p);
      }
    }
    flush();
    const text = utf8(String(s.text ?? "")).replace(/�/g, "").trim();
    if (!text && !words.length) continue;
    // inside the segment, in order, never ending before they start
    let prev = s0;
    for (const w of words) {
      w.start = Math.min(Math.max(w.start, prev, s0), s1);
      w.end = Math.min(Math.max(w.end, w.start), s1);
      prev = w.start;
      w.start = r3(w.start + offset);
      w.end = r3(w.end + offset);
    }
    segments.push({ start: r3(s0 + offset), end: r3(s1 + offset), text: text || words.map((w) => w.text).join(" "), words });
  }
  return { language, segments };
}

/** Threads for the CPU build: the physical cores (logical / 2), 2..8. */
export function whisperThreads(logical: number): number {
  return Math.min(8, Math.max(2, Math.floor((logical || 4) / 2)));
}

export type { LocalTranscript };
