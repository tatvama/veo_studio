/**
 * Edit by transcript (docs/EDITOR.md §10): the words of the sequence where the timeline shows them — from local Whisper
 * (bridge.editor.transcribeLocal, word timings, kept per media file in this browser) or from the caption clips on the
 * timeline (the AI captions tool's). Click a word to go there; select words (click, Shift-click, Ctrl-click) and press
 * Delete to cut them out — a razor and a ripple across the clip's linked A/V, in one command. Search, a filler-word
 * finder (English and Indian languages), speaker labels, and "Make captions" (karaoke) from the transcript.
 */
import { clsx } from "clsx";
import { Captions, Loader2, Mic, Scissors, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, SearchField } from "../../components/ui";
import { editorBridge } from "../../lib/desktop";
import { useEditorHost } from "../host";
import { ctxOf, tracksOf } from "../model/ops";
import { framesToSeconds, toTimecode } from "../model/time";
import type { MediaItem } from "../model/types";
import { program, useFrame } from "../playback/transport";
import { ed, setFocus, useEditor, useProject, useSequence } from "../store";
import { addCaptionTrack, CAPTION_STYLES, captionTrackFromSegments } from "../templates/captions";
import { captionWords, cutRanges, placeWords, wordRanges, wordsFromSegments, type PlacedWord, type Transcript } from "./TranscriptOps";
import { readTranscriptStore, transcriptKey, writeTranscriptStore, type TranscriptStore } from "./transcriptStore";

type Store = TranscriptStore;
const readStore = readTranscriptStore;
const writeStore = writeTranscriptStore;
/** Transcripts by media file (a file transcribed once serves every edit it's in). */
const keyOf = transcriptKey;

const LANGS: [string, string][] = [["auto", "Detect"], ["en", "English"], ["hi", "Hindi"], ["kn", "Kannada"], ["te", "Telugu"], ["ta", "Tamil"], ["ml", "Malayalam"], ["mr", "Marathi"], ["bn", "Bengali"], ["gu", "Gujarati"], ["pa", "Punjabi"]];

type LocalBridge = { transcribeLocal?: (path: string, mediaId: string, o: { language: string; model: "base" | "large-v3-turbo-q5" }) => Promise<{ language: string; segments: { start: number; end: number; text: string; words?: { start: number; end: number; text: string }[]; speaker?: string }[] }> };

export default function TranscriptPanel() {
  const host = useEditorHost();
  const s = useSequence();
  const p = useProject();
  const sel = useEditor((x) => x.selection);
  const [mode, setMode] = useState<"media" | "captions">("media");
  const [store, setStore] = useState<Store>(readStore);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [lang, setLang] = useState("auto");
  const [model, setModel] = useState<"base" | "large-v3-turbo-q5">("base");
  const [busy, setBusy] = useState<string | null>(null);
  const [capStyle, setCapStyle] = useState("karaoke-word");
  const bridge = editorBridge() as unknown as LocalBridge | null;
  const canLocal = typeof bridge?.transcribeLocal === "function";

  const transcripts = useMemo(() => {
    const out: Record<string, Transcript> = {};
    for (const m of p.media) { const t = store[keyOf(m)]; if (t) out[m.id] = { ...t, mediaId: m.id }; }
    return out;
  }, [p.media, store]);
  const words: PlacedWord[] = useMemo(() => (mode === "captions" ? captionWords(s) : placeWords(s, ctxOf(p), transcripts)), [mode, s, p, transcripts]);
  useEffect(() => { setPicked(new Set()); }, [mode]);
  const ql = q.trim().toLowerCase();
  const hits = useMemo(() => (ql ? words.filter((w) => w.text.toLowerCase().includes(ql)).map((w) => w.key) : []), [ql, words]);
  const fillers = words.filter((w) => w.filler);

  // the media that needs a transcript: the selected clips', else every clip with sound on the sequence
  const audioIds = new Set(tracksOf(s, "audio").map((t) => t.id));
  const scopeMedia = useMemo(() => {
    const cs = s.clips.filter((c) => c.source.type === "media" && (sel.length ? sel.includes(c.id) : true));
    const ids = [...new Set(cs.map((c) => (c.source as { mediaId: string }).mediaId))];
    return ids.map((id) => p.media.find((m) => m.id === id)).filter((m): m is MediaItem => !!m && (m.kind === "audio" || m.hasAudio));
  }, [s.clips, sel, p.media]);
  void audioIds;

  const transcribe = async () => {
    const path = ed().path;
    if (!canLocal || !path) { toast.message("Transcribing on this PC needs Tatvam Desktop with Whisper (Settings → Tools)"); return; }
    const todo = scopeMedia;
    if (!todo.length) { toast.message("No clips with sound to transcribe"); return; }
    let n = 0;
    for (const m of todo) {
      setBusy(`Transcribing ${m.name} (${++n} of ${todo.length})…`);
      try {
        const r = await bridge!.transcribeLocal!(path, m.id, { language: lang, model });
        const t: Transcript & { at: string; path: string } = { mediaId: m.id, language: r.language, words: wordsFromSegments(r.segments), source: "whisper", at: new Date().toISOString(), path: m.path };
        setStore((st) => { const next = { ...st, [keyOf(m)]: t }; writeStore(next); return next; });
      } catch (e) {
        toast.error(`${m.name}: ${String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "")}`);
      }
    }
    setBusy(null);
  };

  const click = (w: PlacedWord, e: React.MouseEvent) => {
    program.pause();
    program.seek(w.from);
    if (e.shiftKey && anchor) {
      const a = words.findIndex((x) => x.key === anchor), b = words.findIndex((x) => x.key === w.key);
      const [i, j] = a < b ? [a, b] : [b, a];
      setPicked(new Set(words.slice(i, j + 1).map((x) => x.key)));
    } else if (e.ctrlKey || e.metaKey) {
      setPicked((cur) => { const n = new Set(cur); if (n.has(w.key)) n.delete(w.key); else n.add(w.key); return n; });
      setAnchor(w.key);
    } else { setPicked(new Set([w.key])); setAnchor(w.key); }
  };

  const cut = () => {
    if (!picked.size) return;
    const ranges = wordRanges(words, picked, { join: 2 });
    const n = picked.size;
    host.apply(`Delete ${n} word${n === 1 ? "" : "s"}`, (d) => {
      const i = d.sequences.findIndex((x) => x.id === d.activeSequenceId);
      d.sequences[i] = cutRanges(d.sequences[i], ctxOf(d), ranges, { allTracks: mode === "captions" });
    });
    const frames = ranges.reduce((t, r) => t + r.to - r.from, 0);
    toast.success(`Cut ${n} word${n === 1 ? "" : "s"} (${framesToSeconds(frames, s.fps).toFixed(1)} s)`);
    setPicked(new Set());
  };

  const makeCaptions = () => {
    if (!words.length) return;
    // timeline frames → sequence seconds as one segment per speaker run
    const segs: { start: number; end: number; text: string; speaker?: string; words: { start: number; end: number; text: string }[] }[] = [];
    for (const w of words) {
      const a = framesToSeconds(w.from, s.fps), b = framesToSeconds(w.to, s.fps);
      const last = segs[segs.length - 1];
      if (last && last.speaker === w.speaker && a - last.end < 0.8) { last.words.push({ start: a, end: b, text: w.text }); last.end = b; last.text += ` ${w.text}`; }
      else segs.push({ start: a, end: b, text: w.text, speaker: w.speaker, words: [{ start: a, end: b, text: w.text }] });
    }
    const st = CAPTION_STYLES.find((x) => x.id === capStyle);
    const cues = captionTrackFromSegments(segs, { preset: capStyle, fps: s.fps, height: s.height, karaoke: st?.karaoke ?? "word" });
    addCaptionTrack(host, cues, "Captions");
    toast.success(`${cues.length} caption${cues.length === 1 ? "" : "s"} on a new Captions track`);
  };

  const box = useRef<HTMLDivElement>(null);
  const frame = useFrame(program);
  const current = words.find((w) => w.from <= frame && frame < w.to)?.key;
  // keep the spoken word in view while playing
  useEffect(() => { if (!current) return; box.current?.querySelector(`[data-w="${CSS.escape(current)}"]`)?.scrollIntoView({ block: "nearest" }); }, [current]);

  // speaker runs
  const runs = useMemo(() => {
    const out: { speaker?: string; words: PlacedWord[] }[] = [];
    for (const w of words) {
      const last = out[out.length - 1];
      const gap = last ? framesToSeconds(w.from - last.words[last.words.length - 1].to, s.fps) : 0;
      if (last && last.speaker === w.speaker && gap < 1.5) last.words.push(w); else out.push({ speaker: w.speaker, words: [w] });
    }
    return out;
  }, [words, s.fps]);

  return (
    <div className="pn outline-none" tabIndex={0} onPointerDown={() => setFocus("other")}
      onKeyDown={(e) => {
        if ((e.key === "Delete" || e.key === "Backspace") && picked.size && !(e.target as HTMLElement).closest("input,textarea,select")) { e.preventDefault(); e.stopPropagation(); cut(); }
        else if (e.key === "Escape") setPicked(new Set());
      }}>
      <div className="ed-bar flex-wrap gap-2">
        <div className="ed-seg">
          <button type="button" aria-pressed={mode === "media"} onClick={() => setMode("media")}>Clips' speech</button>
          <button type="button" aria-pressed={mode === "captions"} onClick={() => setMode("captions")}>Caption clips</button>
        </div>
        <SearchField value={q} onChange={setQ} placeholder="Search the words" className="min-w-[120px] flex-1 [&_input]:h-6 [&_input]:text-xs" />
      </div>
      {mode === "media" && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-2 py-1.5">
          <select className="ed-field" value={lang} onChange={(e) => setLang(e.target.value)} title="Language">{LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select className="ed-field" value={model} onChange={(e) => setModel(e.target.value as typeof model)} title="Whisper model"><option value="base">Fast (base)</option><option value="large-v3-turbo-q5">Accurate (large v3 turbo)</option></select>
          <Button size="sm" variant="secondary" disabled={!!busy} icon={<Mic className="size-3.5" />} onClick={() => void transcribe()} title={canLocal ? "Free: whisper.cpp on this PC" : "Needs Tatvam Desktop with the Whisper tool"}>
            Transcribe {sel.length ? "selected" : "all"} ({scopeMedia.length})
          </Button>
          {!canLocal && <span className="text-[10px] text-dim">Local Whisper comes with Tatvam Desktop; the AI captions tool's caption clips work here too.</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5 text-2xs">
        <span className="text-dim">{words.length} words · {picked.size} selected</span>
        <Button size="sm" variant="ghost" disabled={!fillers.length} icon={<Sparkles className="size-3.5" />} onClick={() => setPicked(new Set(fillers.map((w) => w.key)))}>Fillers ({fillers.length})</Button>
        <Button size="sm" variant="ghost" disabled={!hits.length} icon={<Search className="size-3.5" />} onClick={() => setPicked(new Set(hits))}>Matches ({hits.length})</Button>
        <Button size="sm" variant="danger" className="ml-auto" disabled={!picked.size} icon={<Scissors className="size-3.5" />} onClick={cut} title="Delete">Cut words</Button>
      </div>
      <div ref={box} className="pn-scroll px-3 py-2 text-sm leading-7" data-transcript>
        {busy && <p className="mb-2 flex items-center gap-2 text-2xs text-mute"><Loader2 className="size-3 animate-spin" />{busy}</p>}
        {!words.length && !busy && (
          <div className="pn-empty h-auto py-8">{mode === "captions" ? "No caption clips on the timeline yet: make them with the AI panel's Captions or from a transcript here." : scopeMedia.length ? "Transcribe the clips to edit them by their words." : "Put clips with sound on the timeline."}</div>
        )}
        {runs.map((r, i) => (
          <p key={i} className="mb-2">
            {r.speaker && <span className="mr-2 rounded bg-hover px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent-ink">{r.speaker}</span>}
            <span className="mono mr-2 text-[10px] text-dim">{toTimecode(r.words[0].from, s.fps)}</span>
            {r.words.map((w) => (
              <span key={w.key} data-w={w.key} onClick={(e) => click(w, e)} title={toTimecode(w.from, s.fps)}
                className={clsx("cursor-pointer rounded px-0.5", picked.has(w.key) ? "bg-bad/35 text-ink line-through decoration-red-300/70" : w.key === current ? "bg-accent/30 text-ink" : hits.includes(w.key) ? "bg-warn/25" : "hover:bg-hover",
                  w.filler && !picked.has(w.key) && "text-amber-300/90 underline decoration-dotted")}>
                {w.text}{" "}
              </span>
            ))}
          </p>
        ))}
      </div>
      <div className="ed-bar bottom gap-1.5">
        <span className="min-w-0 flex-1 truncate text-2xs text-dim">Click a word to go there · Shift / Ctrl to select · Delete cuts</span>
        <select className="ed-field" value={capStyle} onChange={(e) => setCapStyle(e.target.value)} title="Caption style">{CAPTION_STYLES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
        <Button size="sm" variant="secondary" disabled={!words.length || mode === "captions"} icon={<Captions className="size-3.5" />} onClick={makeCaptions}>Make captions</Button>
      </div>
    </div>
  );
}
