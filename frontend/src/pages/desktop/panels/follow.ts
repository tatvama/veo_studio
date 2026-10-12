/**
 * What the program shows right now, for panels that analyse it (scopes, the level meter): the media file and the time
 * inside it. It comes from the program monitor's `frame` messages; with no program window open, it is worked out from
 * any window's playhead and the cut's layout (the same maths as the timeline).
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { clamp } from "../../../components/review/utils";
import { api } from "../../../lib/api";
import { lastOf, useBus } from "../../../lib/bus";
import { useEpisode } from "../../../lib/queries";
import type { LayersDoc } from "../../project/production/timeline/Layers";
import { clipTail, layoutClips, switchTime, type Clip } from "../../project/production/timeline/shared";

export interface ProgramTarget { url: string; time: number; playing: boolean; rate: number; at: number; shotId?: number | null; filter?: string; t?: number }

/** The cut laid out like the timeline (included shots, trims, speed, transitions, freezes). */
export function useCutClips(eid: number, lang: string): { clips: Clip[]; total: number } {
  const { data: ep } = useEpisode(eid, lang);
  const { data: layers } = useQuery({ queryKey: ["layers", eid], queryFn: () => api.get<LayersDoc>(`/api/episodes/${eid}/layers`), enabled: !!eid });
  return useMemo(() => {
    const clips = layoutClips((ep?.shots ?? []).filter((s) => s.include), null, null, layers?.holds);
    return { clips, total: clips.length ? clipTail(clips[clips.length - 1]) : 0 };
  }, [ep, layers?.holds]);
}

export function clipAt(clips: Clip[], t: number): Clip | undefined {
  let found: Clip | undefined;
  for (const c of clips) if (switchTime(c) <= t + 1e-6) found = c;
  return found ?? clips[0];
}

export function useProgramTarget(eid: number, lang: string): ProgramTarget | null {
  const { clips } = useCutClips(eid, lang);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const fromPlayhead = (t: number, playing: boolean): ProgramTarget | null => {
    const c = clipAt(clipsRef.current, t);
    if (!c?.src) return null;
    return { url: c.src, time: c.trimIn + clamp(t - c.start, 0, c.duration) * c.speed, playing, rate: c.speed, at: Date.now(), shotId: c.shot.id, t };
  };
  const [target, setTarget] = useState<ProgramTarget | null>(null);
  const lastFrame = useRef(0);

  // where the others are when this window opens
  useEffect(() => {
    if (target || !clips.length) return;
    const p = lastOf("playhead", eid);
    setTarget(fromPlayhead(p?.t ?? 0, false));
  }, [clips.length]);

  useBus("frame", (m) => {
    lastFrame.current = Date.now();
    setTarget({ url: m.url, time: m.time, playing: !!m.playing, rate: m.rate ?? 1, at: Date.now(), shotId: m.shotId, filter: m.filter });
  }, { eid });
  useBus("playhead", (m) => {
    if (Date.now() - lastFrame.current < 1500) return;  // the program monitor is telling us exactly
    const next = fromPlayhead(m.t, m.playing);
    if (next) setTarget(next);
  }, { eid });
  useBus("seek", (m) => {
    if (Date.now() - lastFrame.current < 1500) return;
    const next = fromPlayhead(m.t, false);
    if (next) setTarget(next);
  }, { eid });
  return target;
}

/**
 * Keeps a (hidden) media element on the target: same file, same time, playing when it plays. Drift over 0.3 s is
 * corrected; while paused every new time seeks. `onFrame` runs when a new picture is ready after a seek.
 */
export function useFollowMedia(ref: RefObject<HTMLMediaElement | null>, target: ProgramTarget | null, onFrame?: () => void) {
  const cb = useRef(onFrame);
  cb.current = onFrame;
  useEffect(() => {
    const el = ref.current;
    if (!el || !target) return;
    const abs = new URL(target.url, location.href);
    if (abs.origin !== location.origin && el instanceof HTMLVideoElement) el.crossOrigin = "anonymous";
    const want = target.time + (target.playing ? ((Date.now() - target.at) / 1000) * target.rate : 0);
    const place = () => {
      if (Math.abs(el.currentTime - want) > (target.playing ? 0.3 : 0.01)) {
        try { el.currentTime = Math.max(0, want); } catch { /* not seekable yet */ }
      }
      if (target.playing) {
        el.playbackRate = clamp(target.rate || 1, 0.25, 4);
        void el.play().catch(() => undefined);
      } else el.pause();
    };
    if (el.getAttribute("src") !== target.url) {
      el.src = target.url;
      const ready = () => { place(); el.removeEventListener("loadedmetadata", ready); };
      el.addEventListener("loadedmetadata", ready);
      return () => el.removeEventListener("loadedmetadata", ready);
    }
    if (el.readyState >= 1) place();
  }, [target, ref]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = () => cb.current?.();
    el.addEventListener("seeked", h);
    el.addEventListener("loadeddata", h);
    return () => { el.removeEventListener("seeked", h); el.removeEventListener("loadeddata", h); };
  }, [ref]);
}
