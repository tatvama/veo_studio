/**
 * Pieces the looks panels share (Moods, LUT browser, Scopes, Templates): visibility (pause work in hidden tabs), the
 * clip whose picture the thumbnails show and that picture at the playhead, an ImageBitmap thumbnail, LUT URLs, the
 * scope picker (selection / track / sequence) and an intensity slider.
 */
import { clsx } from "clsx";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { defaultLutUrl } from "../model/toComposition";
import { ctxOf, sourceFrameAt, tracksOf, clipEnd } from "../model/ops";
import { framesToSeconds } from "../model/time";
import type { MediaItem, Sequence, TimelineClip } from "../model/types";
import { program, usePlayState, useFrame } from "../playback/transport";
import { ed, project, urlFor, useEditor, useProject, useSequence } from "../store";
import { grabFrame } from "./engineLooks";
import type { MoodScope } from "./apply";

/** True while the element is laid out on screen (a panel in a hidden tab isn't). Loops that only matter while
 *  someone looks (the scopes) also check `document.visibilityState` themselves. */
export function useVisible(ref: RefObject<HTMLElement | null>): boolean {
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setVis(es.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return vis;
}

/** The LUT URL of a look: an imported LUT's runtime URL, a team LUT on the studio, a preset look's baked .cube. */
export function lutUrlFor(look: string): string | undefined {
  if (!look.startsWith("lut:")) return defaultLutUrl(look);
  const u = ed().urls[look];
  if (u) return u;
  const p = project();
  const id = look.slice(4);
  const mine = p.luts?.find((l) => l.id === id)?.url;
  if (mine) return mine;
  const s = p.sequences.find((x) => x.id === p.activeSequenceId);
  const pid = s?.source?.pid ?? p.studioProjectId;
  return pid ? `/media/projects/${pid}/luts/${encodeURIComponent(id)}.cube` : undefined;
}

const isPicture = (c: TimelineClip, s: Sequence) => c.source.type === "media" && tracksOf(s, "video").some((t) => t.id === c.trackId);

/** The clip the looks preview: the first selected video clip, else the top one under the playhead, else the first. */
export function previewClip(s: Sequence, selection: string[], frame: number): TimelineClip | null {
  const pics = s.clips.filter((c) => isPicture(c, s));
  const sel = pics.find((c) => selection.includes(c.id));
  if (sel) return sel;
  const order = new Map(tracksOf(s, "video").map((t) => [t.id, t.index]));
  const under = pics.filter((c) => c.start <= frame && frame < clipEnd(c)).sort((a, b) => (order.get(b.trackId) ?? 0) - (order.get(a.trackId) ?? 0))[0];
  return under ?? pics[0] ?? null;
}

/** Source seconds of a clip at a timeline frame (its middle when the playhead is outside it). */
export function clipTime(c: TimelineClip, s: Sequence, frame: number, m: MediaItem): number {
  const f = frame >= c.start && frame < clipEnd(c) ? frame : c.start + Math.floor(c.duration / 2);
  const src = sourceFrameAt(c, s, ctxOf(project()), f);
  return m.kind === "image" ? 0 : framesToSeconds(src, m.fps > 0 ? m.fps : s.fps);
}

/**
 * The picture the looks browsers show: the preview clip's media at the playhead (re-read when the paused playhead
 * settles on another frame, not while playing).
 */
export function useClipFrame(maxW = 320): { canvas: HTMLCanvasElement | null; clip: TimelineClip | null; media: MediaItem | null; url: string | null; t: number; loading: boolean } {
  const s = useSequence();
  const p = useProject();
  const sel = useEditor((x) => x.selection);
  const urls = useEditor((x) => x.urls);
  const frame = useFrame(program);
  const { playing } = usePlayState(program);
  const [settled, setSettled] = useState(frame);
  useEffect(() => { if (playing) return; const id = window.setTimeout(() => setSettled(program.frame), 250); return () => window.clearTimeout(id); }, [frame, playing]);
  const clip = useMemo(() => previewClip(s, sel, settled), [s, sel, settled]);
  const media = clip && clip.source.type === "media" ? p.media.find((m) => m.id === (clip.source as { mediaId: string }).mediaId) ?? null : null;
  const url = media ? urlFor(media) ?? null : null;
  const t = clip && media ? Math.round(clipTime(clip, s, settled, media) * 10) / 10 : 0;
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!url || !media) { setCanvas(null); return; }
    setLoading(true);
    void grabFrame(url, t, { maxW, image: media.kind === "image" }).then((c) => { if (alive) { setCanvas(c); setLoading(false); } });
    return () => { alive = false; };
  }, [url, t, maxW, media?.kind, urls]);
  return { canvas, clip, media, url, t, loading };
}

/** Draws an ImageBitmap promise (re-drawn when it changes). */
export function Thumb({ promise: p, className, label }: { promise: Promise<ImageBitmap | null> | null; className?: string; label?: ReactNode }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [st, setSt] = useState<"loading" | "ok" | "none">("loading");
  useEffect(() => {
    let alive = true;
    if (!p) { setSt("none"); return; }
    setSt("loading");
    void p.then((b) => {
      const c = cv.current;
      if (!alive || !c) return;
      if (!b) { setSt("none"); return; }
      c.width = b.width; c.height = b.height;
      c.getContext("2d")?.drawImage(b, 0, 0);
      setSt("ok");
    });
    return () => { alive = false; };
  }, [p]);
  return (
    <div className={clsx("relative overflow-hidden rounded-md bg-black", className)} data-thumb={st}>
      <canvas ref={cv} className="absolute inset-0 size-full object-cover" />
      {st !== "ok" && <div className="absolute inset-0 grid place-items-center text-[10px] text-white/50">{st === "loading" ? "…" : label ?? "No picture"}</div>}
    </div>
  );
}

export type ScopeChoice = "selection" | "track" | "sequence";

/** The clips a scope choice means now. */
export function scopeOf(choice: ScopeChoice, s: Sequence, selection: string[]): MoodScope {
  if (choice === "selection") return { kind: "clips", ids: selection };
  if (choice === "track") {
    const first = s.clips.find((c) => selection.includes(c.id) && tracksOf(s, "video").some((t) => t.id === c.trackId));
    return { kind: "track", trackId: first?.trackId ?? tracksOf(s, "video")[0]?.id ?? "" };
  }
  return { kind: "sequence" };
}

export function ScopePicker({ value, onChange, count }: { value: ScopeChoice; onChange: (v: ScopeChoice) => void; count?: number }) {
  return (
    <div className="ed-seg" title="Which clips get it">
      {([["selection", `Selected${count !== undefined ? ` (${count})` : ""}`], ["track", "Track"], ["sequence", "Sequence"]] as const).map(([v, l]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

export function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-2xs text-mute">
      <span className="shrink-0">{label}</span>
      <input type="range" className="min-w-0 flex-1 accent-[var(--color-accent)]" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="mono w-10 shrink-0 text-right text-accent-ink">{format ? format(value) : value}</span>
    </label>
  );
}
