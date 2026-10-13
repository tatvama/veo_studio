/**
 * Feature detection for the audiograms' visualiser (docs/EDITOR.md §15.3–15.4). audio-tools2 builds the audio-reactive
 * visualiser as a generated source (ClipSource "visualizer", editor/audiotools/index.ts: `VISUALIZER_STYLES` and
 * `makeVisualizerSource`). When this build has them, a provider is registered so the audiogram templates draw it, fed
 * by the sequence's sound: the audio clip under the playhead (else the first one, else an audio file of the project),
 * as a media item from its source in-point. Otherwise the templates keep their static waveform. No hard dependency:
 * the module is looked up with import.meta.glob. A module may also export a ready `visualiserProvider`
 * (packs/social.ts VisualiserProvider).
 */
import { useEffect, useState } from "react";
import { clipEnd, tracksOf } from "../../model/ops";
import { framesToSeconds } from "../../model/time";
import type { ClipSource } from "../../model/types";
import { program } from "../../playback/transport";
import { project, seq } from "../../store";
import { hasVisualiser, setVisualiserProvider, visualiserProviderFrom, type VisualiserProvider } from "./social";

type MakeSource = (o: Record<string, unknown>) => ClipSource;
let found: Promise<boolean> | null = null;

type VisAudio = { mediaId: string; offset: number; name: string };
let forced: VisAudio | null = null;
/** Builds a template with this sound for its visualiser (an audiogram's chosen source, templates/audiogram.ts). */
export function withVisualiserAudio<T>(a: VisAudio | null, fn: () => T): T {
  const prev = forced;
  forced = a;
  try { return fn(); } finally { forced = prev; }
}

/** The sound the visualiser draws: a media item and the media seconds to start from. */
export function visualiserAudio(): VisAudio | null {
  if (forced) return forced;
  const p = project(), s = seq();
  const audio = new Set(tracksOf(s, "audio").map((t) => t.id));
  const clips = s.clips.filter((c) => audio.has(c.trackId) && c.source.type === "media").sort((a, b) => a.start - b.start);
  const at = program.frame;
  const c = clips.find((x) => x.start <= at && at < clipEnd(x)) ?? clips[0];
  if (c && c.source.type === "media") {
    const m = p.media.find((x) => x.id === (c.source as { mediaId: string }).mediaId);
    if (m) return { mediaId: m.id, offset: Math.round(framesToSeconds(c.source.in, m.fps > 0 ? m.fps : s.fps) * 1000) / 1000, name: m.name };
  }
  const m = p.media.find((x) => x.kind === "audio") ?? p.media.find((x) => x.hasAudio);
  return m ? { mediaId: m.id, offset: 0, name: m.name } : null;
}

/** Looks for the visualiser (once it's found; a miss is looked up again next time); true when the audiograms draw it. */
export function detectVisualiser(): Promise<boolean> {
  const p = (found ??= (async () => {
    if (hasVisualiser()) return true;
    const mods = import.meta.glob(["../../audiotools/index.ts"]);
    for (const load of Object.values(mods)) {
      try {
        const m = (await load()) as Record<string, unknown>;
        if (typeof m.visualiserProvider === "function") { setVisualiserProvider(m.visualiserProvider as VisualiserProvider); return true; }
        const make = m.makeVisualizerSource as MakeSource | undefined;
        const styles = (m.VISUALIZER_STYLES as { id: string }[] | undefined) ?? [];
        if (typeof make !== "function" || !styles.length) continue;
        setVisualiserProvider(visualiserProviderFrom(make, styles, visualiserAudio));
        return true;
      } catch (e) { console.warn("[templates] visualiser", e); }
    }
    console.warn("[templates] no audio visualiser in this build", Object.keys(mods));
    return false;
  })());
  void p.then((ok) => { if (!ok && found === p) found = null; });
  return p;
}

/** The detection as a hook: null while looking, then whether the visualiser is there (looked up again on `key`). */
export function useVisualiserDetect(key?: unknown): boolean | null {
  const [v, setV] = useState<boolean | null>(hasVisualiser() ? true : null);
  useEffect(() => { let alive = true; void detectVisualiser().then((x) => { if (alive) setV(x); }); return () => { alive = false; }; }, [key]);
  return v;
}
