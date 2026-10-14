/**
 * Which picture a panel's previews show (preview-polish): the user's own clip wins — the selected clip, else the V1
 * clip under the playhead, else the first V1 clip, read at the playhead (moods/engineLooks.grabFrame, re-read when a
 * paused playhead settles) — unless the panel's "Preview on: Your clip / Samples" switch says samples (remembered
 * per panel in this browser). With no video clip in the edit, the samples show; a frame that fails to load shows
 * the samples too and is tried again with a backoff (frames.ts never keeps a failed or blank frame).
 */
import { clsx } from "clsx";
import { useEffect, useMemo, useState } from "react";
import { clipTime } from "../moods/ui";
import { program, usePlayState, useFrame } from "../playback/transport";
import { urlFor, useEditor, useProject, useSequence } from "../store";
import { frameRetryIn, userFrame } from "./frames";
import { nextClipOnTrack, pickUserClip } from "./samples";
import type { FrameChoice, UserFrame } from "./service";

export type PreviewOn = "clip" | "samples";
const LS = (panel: string) => `tatvam-editor:preview-on:${panel}`;
const readMode = (panel: string): PreviewOn => { try { return localStorage.getItem(LS(panel)) === "samples" ? "samples" : "clip"; } catch { return "clip"; } };

export interface PreviewChoice {
  choice: FrameChoice;
  /** What the switch says. */
  mode: PreviewOn;
  setMode(m: PreviewOn): void;
  /** The edit has a video clip to show. */
  hasClip: boolean;
  clipName: string | null;
  /** Reading the clip's frame. */
  loading: boolean;
}

/** The previews' picture for a panel (`next`: also the next clip's frame, for transitions). */
export function usePreviewChoice(panel: string, opts: { next?: boolean; maxW?: number } = {}): PreviewChoice {
  const s = useSequence();
  const p = useProject();
  const sel = useEditor((x) => x.selection);
  const urls = useEditor((x) => x.urls);
  const frame = useFrame(program);
  const { playing } = usePlayState(program);
  const [mode, setModeState] = useState<PreviewOn>(() => readMode(panel));
  const setMode = (m: PreviewOn) => { setModeState(m); try { localStorage.setItem(LS(panel), m); } catch { /* blocked */ } };
  const [settled, setSettled] = useState(frame);
  useEffect(() => { if (playing) return; const id = window.setTimeout(() => setSettled(program.frame), 250); return () => window.clearTimeout(id); }, [frame, playing]);
  const clip = useMemo(() => pickUserClip(s, sel, settled), [s, sel, settled]);
  const next = useMemo(() => (opts.next && clip ? nextClipOnTrack(s, clip) : null), [opts.next, s, clip]);
  const mediaOf = (c: typeof clip) => (c && c.source.type === "media" ? p.media.find((m) => m.id === (c.source as { mediaId: string }).mediaId) ?? null : null);
  const media = mediaOf(clip), nmedia = mediaOf(next);
  const url = media ? urlFor(media) ?? null : null, nurl = nmedia ? urlFor(nmedia) ?? null : null;
  const t = clip && media ? Math.round(clipTime(clip, s, settled, media) * 10) / 10 : 0;
  const nt = next && nmedia ? Math.round(clipTime(next, s, next.start, nmedia) * 10) / 10 : 0;
  const maxW = opts.maxW ?? 480;
  const want = mode === "clip";
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [ncanvas, setNcanvas] = useState<HTMLCanvasElement | null>(null);
  const [loading, setLoading] = useState(false);
  // a failed frame: the samples meanwhile, and another try after the backoff
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true, timer = 0;
    if (!want || !url || !media) { setCanvas(null); setLoading(false); return; }
    setLoading(true);
    void userFrame(url, t, { maxW, image: media.kind === "image" }).then((c) => {
      if (!alive) return;
      setCanvas(c); setLoading(false);
      const wait = c ? null : frameRetryIn(url, t, maxW);
      if (wait !== null) timer = window.setTimeout(() => setRetry((n) => n + 1), wait + 50);
    });
    return () => { alive = false; window.clearTimeout(timer); };
  }, [want, url, t, maxW, media?.kind, urls, retry]);
  const [nretry, setNretry] = useState(0);
  useEffect(() => {
    let alive = true, timer = 0;
    if (!want || !nurl || !nmedia) { setNcanvas(null); return; }
    void userFrame(nurl, nt, { maxW, image: nmedia.kind === "image" }).then((c) => {
      if (!alive) return;
      setNcanvas(c);
      const wait = c ? null : frameRetryIn(nurl, nt, maxW);
      if (wait !== null) timer = window.setTimeout(() => setNretry((n) => n + 1), wait + 50);
    });
    return () => { alive = false; window.clearTimeout(timer); };
  }, [want, nurl, nt, maxW, nmedia?.kind, urls, nretry]);
  const choice = useMemo<FrameChoice>(() => {
    if (!want || !canvas || !media) return { mode: "samples" };
    const f: UserFrame = { mediaId: media.id, t, canvas, name: clip?.name ?? media.name, seqH: s.height,
      next: ncanvas && nmedia ? { mediaId: nmedia.id, t: nt, canvas: ncanvas } : null };
    return { mode: "clip", frame: f };
  }, [want, canvas, media?.id, t, ncanvas, nmedia?.id, nt, s.height, clip?.name]);
  return { choice, mode, setMode, hasClip: !!clip, clipName: clip?.name ?? null, loading: want && loading };
}

/** The "Preview on: Your clip / Samples" switch. */
export function PreviewSwitch({ pc, className }: { pc: PreviewChoice; className?: string }) {
  const onClip = pc.mode === "clip" && pc.hasClip;
  return (
    <div className={clsx("pv-switch", className)} role="group" aria-label="Preview on" data-preview-on={onClip ? "clip" : "samples"}>
      <span className="pv-switch-label">Preview on</span>
      <div className="ed-seg">
        <button type="button" aria-pressed={onClip} disabled={!pc.hasClip}
          title={pc.hasClip ? `Your clip: ${pc.clipName ?? ""} (the selected clip, else the one under the playhead on V1)` : "The edit has no video clips yet, so the previews use the samples"}
          onClick={() => pc.setMode("clip")}>Your clip</button>
        <button type="button" aria-pressed={!onClip} title="The studio's own showreel stills, with a gentle move" onClick={() => pc.setMode("samples")}>Samples</button>
      </div>
    </div>
  );
}
