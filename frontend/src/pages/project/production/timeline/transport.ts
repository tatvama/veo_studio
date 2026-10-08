import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { clamp, createClock, frameOf, frameTime, type Clock } from "../../../../components/review/utils";
import { FPS, switchTime, type Clip } from "./shared";

// ── transport: one playhead for the preview player, ruler and tracks ────────

export interface Transport {
  clock: Clock; idx: number; playing: boolean; rate: number; broken: Set<number>;
  vref: RefObject<HTMLVideoElement | null>; mref: RefObject<HTMLAudioElement | null>;
  seek(t: number): void; play(): void; pause(): void; toggle(): void; shuttle(dir: 1 | -1): void; step(frames: number): void;
  jump(dir: 1 | -1): void; onVideoMeta(): void; onVideoError(shotId: number): void; placeMusic(): void;
}

export function useTransport(clips: Clip[], total: number): Transport {
  const clock = useMemo(() => createClock(), []);
  const [idx, setIdxState] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [broken, setBroken] = useState<Set<number>>(() => new Set());
  const vref = useRef<HTMLVideoElement>(null);
  const mref = useRef<HTMLAudioElement>(null);
  const st = useRef({ idx: 0, rate: 1, clips, total, broken });
  st.current.clips = clips;
  st.current.total = total;
  st.current.broken = broken;
  st.current.rate = rate;

  const setIdx = (i: number) => { st.current.idx = i; setIdxState(i); };
  const clipAt = (t: number) => {
    const cs = st.current.clips;
    let i = 0;
    for (let k = 0; k < cs.length; k++) if (switchTime(cs[k]) <= t + 1e-6) i = k;
    return i;
  };
  const placeMusic = () => {
    const m = mref.current;
    if (m && m.duration && Number.isFinite(m.duration)) m.currentTime = clock.get() % m.duration;
  };
  const placeVideo = () => {
    const c = st.current.clips[st.current.idx];
    const v = vref.current;
    if (!c?.src || !v || v.readyState < 1) return;
    const target = c.trimIn + clamp(clock.get() - c.start, 0, c.duration) * c.speed;
    if (Math.abs(v.currentTime - target) > 0.02) v.currentTime = target;
  };
  const seek = (t: number) => {
    const tt = clamp(t, 0, st.current.total);
    clock.set(tt);
    const i = clipAt(tt);
    if (i !== st.current.idx) setIdx(i);
    else placeVideo();
    placeMusic();
  };

  // keep idx valid when clips change (reorder, trims)
  useEffect(() => {
    const i = clipAt(Math.min(clock.get(), total));
    if (i !== st.current.idx) setIdx(i);
    if (clock.get() > total) clock.set(total);
  }, [clips, total]);
  useEffect(() => { placeVideo(); }, [idx]);

  // media follow play state
  const cur = clips[idx];
  useEffect(() => {
    const v = vref.current;
    if (v) {
      if (playing && rate > 0 && cur?.src && !broken.has(cur.shot.id)) {
        v.playbackRate = rate * (cur.speed || 1);
        v.play().catch(() => {});
      } else v.pause();
    }
    const m = mref.current;
    if (m) {
      if (playing && rate > 0) {
        m.playbackRate = rate;
        m.play().catch(() => {});
      } else m.pause();
    }
  }, [playing, rate, idx, cur?.src, broken]);

  // the playhead loop
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let lastSeek = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const s = st.current;
      const cs = s.clips;
      const c = cs[s.idx];
      if (!c) { setPlaying(false); return; }
      let t = clock.get();
      const v = vref.current;
      const next = cs[s.idx + 1];
      const end = next ? switchTime(next) : c.start + c.duration;  // hand over half-way through the transition
      const viaVideo = s.rate > 0 && !!c.src && !!v && !s.broken.has(c.shot.id);
      if (viaVideo) {
        if (v!.ended) t = end;
        else if (v!.readyState >= 2 && !v!.paused) t = c.start + (v!.currentTime - c.trimIn) / c.speed;
      } else {
        t += dt * s.rate;
        if (s.rate < 0 && c.src && v && now - lastSeek > 70) {
          lastSeek = now;
          v.currentTime = c.trimIn + clamp(t - c.start, 0, c.duration) * c.speed;
        }
      }
      if (s.rate > 0 && t >= end - 0.01) {
        if (s.idx + 1 < cs.length) {
          setIdx(s.idx + 1);
          t = Math.max(t, switchTime(cs[s.idx]));
        } else {
          clock.set(s.total);
          setPlaying(false);
          setRate(1);
          return;
        }
      } else if (s.rate < 0 && t <= switchTime(c)) {
        if (s.idx > 0) {
          setIdx(s.idx - 1);
          t = Math.max(0, c.start - 0.001);
        } else {
          clock.set(0);
          setPlaying(false);
          setRate(1);
          return;
        }
      }
      clock.set(clamp(t, 0, s.total));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const play = () => {
    if (clock.get() >= st.current.total - 0.05) seek(0);
    setRate(1);
    setPlaying(true);
    placeMusic();
  };
  const pause = () => {
    setPlaying(false);
    setRate(1);
  };
  return {
    clock, idx, playing, rate, broken, vref, mref, seek, play, pause, placeMusic,
    toggle: () => (playing ? pause() : play()),
    shuttle: (dir) => {
      if (dir > 0) {
        if (playing && rate > 0) setRate(Math.min(4, rate * 2));
        else { if (clock.get() >= total - 0.05) seek(0); setRate(1); setPlaying(true); placeMusic(); }
      } else if (playing && rate < 0) setRate(Math.max(-4, rate * 2));
      else { setRate(-1); setPlaying(true); }
    },
    step: (frames) => {
      pause();
      seek(frameTime(frameOf(clock.get(), FPS) + frames, FPS));
    },
    jump: (dir) => {
      const t = clock.get();
      const marks = [0, ...st.current.clips.map((c) => c.start + c.duration)];
      const next = dir > 0 ? marks.find((m) => m > t + 1e-3) : [...marks].reverse().find((m) => m < t - 1e-3);
      if (next !== undefined) seek(next);
    },
    onVideoMeta: () => {
      placeVideo();
      const v = vref.current;
      const c = st.current.clips[st.current.idx];
      if (v && playing && st.current.rate > 0 && c?.src) {
        v.playbackRate = st.current.rate * (c.speed || 1);
        v.play().catch(() => {});
      }
    },
    onVideoError: (shotId) => setBroken((b) => (b.has(shotId) ? b : new Set(b).add(shotId))),
  };
}
