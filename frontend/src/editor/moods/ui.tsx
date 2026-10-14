/**
 * Pieces the looks panels share (Moods, LUT browser, Scopes, Templates): visibility (pause work in hidden tabs), a
 * clip's source time at the playhead, LUT URLs, the scope picker (selection / track / sequence) and an intensity
 * slider. The cards' pictures are drawn by editor/preview.
 */
import { useEffect, useState, type RefObject } from "react";
import { defaultLutUrl } from "../model/toComposition";
import { ctxOf, sourceFrameAt, tracksOf, clipEnd } from "../model/ops";
import { framesToSeconds } from "../model/time";
import type { MediaItem, Sequence, TimelineClip } from "../model/types";
import { ed, project } from "../store";
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

/** Source seconds of a clip at a timeline frame (its middle when the playhead is outside it). */
export function clipTime(c: TimelineClip, s: Sequence, frame: number, m: MediaItem): number {
  const f = frame >= c.start && frame < clipEnd(c) ? frame : c.start + Math.floor(c.duration / 2);
  const src = sourceFrameAt(c, s, ctxOf(project()), f);
  return m.kind === "image" ? 0 : framesToSeconds(src, m.fps > 0 ? m.fps : s.fps);
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
