import { clsx } from "clsx";
import { AlertTriangle, AudioWaveform, Loader2, Maximize, Minimize, Pause, Play, Repeat, Rewind, StepBack, StepForward } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { BarButton } from "./parts";
import { ScrubBar } from "./ScrubBar";
import { PlayButton, ShortcutsButton, SpeedMenu, TimeReadout, VolumeControl } from "./Transport";
import { peaksFromList } from "./Waveform";
import {
  DEFAULT_FPS, clamp, formatTC, frameOf, frameTime, lsGet, lsSet, shortcutAllowed, useClock, type Clock, type Marker,
} from "./utils";
import "../../styles/console.css";
import "../../styles/review.css";

export { PlayerShortcuts } from "./Transport";

export interface PlayerHandle {
  video(): HTMLVideoElement | null;
  seek(t: number): void;
  play(): void;
  pause(): void;
  toggle(): void;
  step(frames: number): void;
  isPlaying(): boolean;
}

export interface ContentRect { left: number; top: number; width: number; height: number }

/**
 * Pro review player: a broadcast-style monitor (dark bed with a slim overlay HUD: version label, transport state, timecode)
 * over a scrub bar and a compact transport. Keyboard: Space, ←/→ frame step, Shift = 1 s, J/K/L shuttle, K+J/L = single frame.
 *   • `fill`   – the picture area grows to fill the parent (parent must have a height); otherwise it follows the video's
 *                aspect ratio, capped at `stageMax`.
 *   • `overlay` renders over the exact picture rect (letterbox aware) — used for frame drawings.
 *   • `dock`   is the pen palette. A function receives `side`: true when there is room to put it as a vertical rail beside
 *              the picture (it then never covers the frame), false to render it as a bar between the picture and the controls.
 */
export function ReviewPlayer({
  src, poster, fps = DEFAULT_FPS, peaks, clock, markers, activeMarker, onMarker, overlay, stageOverlay, dock, toolbar,
  onPlayingChange, keyboard = true, fill = false, stageMax = "60vh", aspectHint, stageClassName, handleRef, stageClickable = true,
  className, durationHint, simple = false, shortcutsExtra, label, onVideoRatio,
}: {
  src: string; poster?: string; fps?: number; peaks?: number[]; clock: Clock; markers?: Marker[]; activeMarker?: number | null;
  onMarker?: (id: number) => void; overlay?: (rect: ContentRect) => ReactNode; stageOverlay?: ReactNode; dock?: ReactNode | ((side: boolean) => ReactNode); toolbar?: ReactNode;
  onPlayingChange?: (playing: boolean) => void; keyboard?: boolean; fill?: boolean; stageMax?: string; aspectHint?: number;
  stageClassName?: string; handleRef?: React.Ref<PlayerHandle>; stageClickable?: boolean; className?: string; durationHint?: number;
  simple?: boolean; shortcutsExtra?: [string, string][];
  /** Version label shown in the monitor HUD (e.g. "Final EN · 9:16 · #12"). */
  label?: string;
  /** Reports the real picture shape (width / height) once the video knows it. */
  onVideoRatio?: (ratio: number) => void;
}) {
  const t = useT();
  const vref = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(durationHint ?? 0);
  const [rate, setRate] = useState(1);
  const [baseRate, setBaseRate] = useState(1);
  const [reverse, setReverse] = useState(0);
  const [volume, setVolume] = useState(() => {
    const v = Number(lsGet("veo-review-volume"));
    return lsGet("veo-review-volume") && Number.isFinite(v) ? clamp(v, 0, 1) : 1;
  });
  const [muted, setMuted] = useState(false);
  const [fs, setFs] = useState(false);
  const [vsize, setVsize] = useState<{ w: number; h: number } | null>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState(false);
  const [started, setStarted] = useState(false);
  const [loop, setLoop] = useState(false);
  const [wave, setWave] = useState(() => lsGet("veo-review-wave") !== "0");
  const [box, setBox] = useState({ w: 0, h: 0 });
  const resumeAfterScrub = useRef(false);
  const kHeld = useRef(false);

  const peakData = useMemo(() => peaksFromList(peaks, durationHint || duration), [peaks, durationHint, duration]);

  // Reset when the source changes. Done while rendering (not in an effect) so it can never overwrite the size
  // reported by a video that loaded from cache before the effect had a chance to run.
  const [seenSrc, setSeenSrc] = useState(src);
  if (seenSrc !== src) {
    setSeenSrc(src);
    setError(false);
    setStarted(false);
    setReverse(0);
    setVsize(null);
  }
  useEffect(() => { clock.set(0); }, [src, clock]);

  // stage size → picture rect
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // card size → whether the pen palette fits as a vertical rail beside the picture
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const rect: ContentRect = useMemo(() => {
    const { w, h } = stage;
    if (!w || !h) return { left: 0, top: 0, width: 0, height: 0 };
    if (!vsize) return { left: 0, top: 0, width: w, height: h };
    const s = Math.min(w / vsize.w, h / vsize.h);
    const cw = vsize.w * s;
    const ch = vsize.h * s;
    return { left: (w - cw) / 2, top: (h - ch) / 2, width: cw, height: ch };
  }, [stage, vsize]);

  // 60 fps clock while playing
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = vref.current;
      if (v) clock.set(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, clock]);

  // reverse shuttle (HTML video can't play backwards: step the picture)
  useEffect(() => {
    const v = vref.current;
    if (!reverse || !v) return;
    v.pause();
    let raf = 0;
    let last = performance.now();
    let lastSeek = 0;
    let pos = v.currentTime;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      pos = Math.max(0, pos - dt * reverse);
      clock.set(pos);
      if (now - lastSeek > 1000 / 15) {
        lastSeek = now;
        v.currentTime = pos;
      }
      if (pos <= 0) {
        setReverse(0);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      v.currentTime = pos;
    };
  }, [reverse, clock]);

  useEffect(() => { onPlayingChange?.(playing || reverse > 0); }, [playing, reverse]);

  useEffect(() => {
    const v = vref.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
    lsSet("veo-review-volume", String(volume));
  }, [volume, muted]);

  useEffect(() => {
    const h = () => setFs(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);

  // ── actions ──
  const dur = () => vref.current?.duration || duration || 0;
  const seek = (to: number) => {
    const v = vref.current;
    if (!v) return;
    const tt = clamp(to, 0, dur() || 0);
    v.currentTime = tt;
    clock.set(tt);
  };
  const play = () => {
    const v = vref.current;
    if (!v || error) return;
    setReverse(0);
    if (v.ended || (v.duration && v.currentTime >= v.duration - 0.02)) v.currentTime = 0;
    setStarted(true);
    v.play().catch(() => { /* autoplay policy / decode error — the error handler shows a message */ });
  };
  const pause = () => {
    setReverse(0);
    vref.current?.pause();
  };
  const toggle = () => (playing || reverse ? pause() : play());
  const step = (frames: number) => {
    pause();
    const cur = reverse ? clock.get() : (vref.current?.currentTime ?? clock.get());
    seek(frameTime(frameOf(cur, fps) + frames, fps));
  };
  const stepSeconds = (s: number) => {
    pause();
    seek(clock.get() + s);
  };
  const shuttleForward = () => {
    const v = vref.current;
    if (!v) return;
    if (reverse) {
      setReverse(0);
      v.playbackRate = baseRate;
      play();
    } else if (!v.paused) {
      v.playbackRate = Math.min(4, Math.max(1, v.playbackRate) * 2);
    } else {
      v.playbackRate = baseRate;
      play();
    }
  };
  const shuttleReverse = () => {
    const v = vref.current;
    if (!v) return;
    if (!v.paused) v.pause();
    setStarted(true);
    setReverse((r) => (r ? Math.min(4, r * 2) : 1));
  };
  const stop = () => {
    pause();
    if (vref.current) vref.current.playbackRate = baseRate;
  };
  const toggleFs = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else rootRef.current?.requestFullscreen?.().catch(() => {});
  };

  const actions = useRef({ seek, play, pause, toggle, step, stepSeconds, shuttleForward, shuttleReverse, stop, toggleFs, dur });
  actions.current = { seek, play, pause, toggle, step, stepSeconds, shuttleForward, shuttleReverse, stop, toggleFs, dur };
  const playingRef = useRef(false);
  playingRef.current = playing || reverse > 0;

  useImperativeHandle(handleRef, () => ({
    video: () => vref.current,
    seek: (x) => actions.current.seek(x),
    play: () => actions.current.play(),
    pause: () => actions.current.pause(),
    toggle: () => actions.current.toggle(),
    step: (n) => actions.current.step(n),
    isPlaying: () => playingRef.current,
  }), []);

  useEffect(() => {
    if (!keyboard) return;
    const down = (e: KeyboardEvent) => {
      if (!shortcutAllowed(e)) return;
      const a = actions.current;
      const k = e.key;
      if (k === " " || k === "Spacebar") {
        e.preventDefault();
        if (!e.repeat) a.toggle();
      } else if (k === "ArrowLeft") {
        e.preventDefault();
        if (e.shiftKey) a.stepSeconds(-1); else a.step(-1);
      } else if (k === "ArrowRight") {
        e.preventDefault();
        if (e.shiftKey) a.stepSeconds(1); else a.step(1);
      } else if (k === "j" || k === "J") {
        e.preventDefault();
        if (kHeld.current) a.step(-1); else a.shuttleReverse();
      } else if (k === "k" || k === "K") {
        e.preventDefault();
        kHeld.current = true;
        a.stop();
      } else if (k === "l" || k === "L") {
        e.preventDefault();
        if (kHeld.current) a.step(1); else a.shuttleForward();
      } else if (k === "f" || k === "F") {
        e.preventDefault();
        a.toggleFs();
      } else if (k === "m" || k === "M") {
        e.preventDefault();
        setMuted((m) => !m);
      } else if (k === "Home") {
        e.preventDefault();
        a.seek(0);
      } else if (k === "End") {
        e.preventDefault();
        a.seek(a.dur());
      }
    };
    const up = (e: KeyboardEvent) => { if (e.key === "k" || e.key === "K") kHeld.current = false; };
    const blur = () => { kHeld.current = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [keyboard]);

  const ratio = vsize ? vsize.w / vsize.h : aspectHint ?? 16 / 9;
  const sideDock = (fill || fs) && box.w >= 640 && box.h >= 540;
  const dockNode = typeof dock === "function" ? dock(sideDock) : dock;
  const busy = playing || reverse > 0;

  return (
    <div ref={rootRef} className={clsx("flex min-h-0 flex-col bg-panel", fs ? "h-full bg-black" : "hud rounded-xl border border-line", className)}>
      <div className={clsx(fs ? "flex min-h-0 flex-1" : fill ? "flex min-h-0 flex-1 gap-2 p-2 pb-0" : "p-2 pb-0")}>
        {sideDock && dockNode}
        <div
          ref={stageRef}
          className={clsx("cx-monitor select-none", fs ? "min-w-0 flex-1 rounded-none border-0" : fill ? "min-h-[96px] min-w-0 flex-1" : "w-full", stageClassName)}
          style={!fs && !fill ? { aspectRatio: String(ratio), maxHeight: stageMax } : undefined}
          onClick={() => stageClickable && toggle()}
          onDoubleClick={toggleFs}
        >
          <video
            ref={vref}
            src={src}
            poster={poster}
            playsInline
            preload="metadata"
            loop={loop}
            className="absolute inset-0 h-full w-full object-contain"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              setDuration(v.duration || durationHint || 0);
              if (v.videoWidth && v.videoHeight) { setVsize({ w: v.videoWidth, h: v.videoHeight }); onVideoRatio?.(v.videoWidth / v.videoHeight); }
              v.volume = volume;
              v.muted = muted;
              clock.set(v.currentTime);
            }}
            onResize={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) { setVsize({ w: v.videoWidth, h: v.videoHeight }); onVideoRatio?.(v.videoWidth / v.videoHeight); } }}
            onDurationChange={(e) => e.currentTarget.duration && setDuration(e.currentTarget.duration)}
            onPlay={() => setPlaying(true)}
            onPause={(e) => { setPlaying(false); if (!reverse) clock.set(e.currentTarget.currentTime); }}
            onEnded={() => setPlaying(false)}
            onSeeked={(e) => { if (!playing && !reverse) clock.set(e.currentTarget.currentTime); }}
            onTimeUpdate={(e) => { if (!playing && !reverse) clock.set(e.currentTarget.currentTime); }}
            onWaiting={() => setWaiting(true)}
            onPlaying={() => setWaiting(false)}
            onCanPlay={() => setWaiting(false)}
            onRateChange={(e) => setRate(e.currentTarget.playbackRate)}
            onError={() => { setError(true); setPlaying(false); }}
          />
          {overlay && rect.width > 0 && (
            <div className="absolute" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
              {overlay(rect)}
            </div>
          )}
          {/* HUD: version label + frame rate on the left, transport state + timecode on the right (decorative: the controls below carry the real state) */}
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[6] flex items-start justify-between gap-2 p-2">
            <div className="flex min-w-0 items-center gap-1.5">
              {label && <span className="rv-chip min-w-0"><span className="truncate">{label}</span></span>}
              <span className="rv-chip max-sm:hidden"><span className="rv-dim">{t("FPS")}</span>{fps}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {(busy || rate !== 1) && (
                <span className="rv-chip" data-tone={busy ? "live" : undefined}>
                  {reverse ? <Rewind fill="currentColor" /> : busy ? <Play fill="currentColor" /> : <Pause fill="currentColor" />}
                  {reverse ? `${reverse}×` : `${rate}×`}
                </span>
              )}
              <HudTime clock={clock} fps={fps} live={busy} />
            </div>
          </div>
          {stageOverlay}
          <AnimatePresence>
            {!started && !playing && !error && (
              <motion.button
                key="big-play"
                type="button"
                aria-label={t("Play")}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.12 }}
                transition={{ duration: 0.2 }}
                onClick={(e) => { e.stopPropagation(); play(); }}
                className="group/play absolute left-1/2 top-1/2 z-10 grid size-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-xl bg-black/55 text-white ring-1 ring-white/25 backdrop-blur-md transition-colors hover:bg-accent hover:text-black max-sm:size-14"
              >
                <Play className="ml-1 size-7 transition-transform group-hover/play:scale-110" fill="currentColor" />
              </motion.button>
            )}
          </AnimatePresence>
          {waiting && playing && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><Loader2 className="size-8 animate-spin text-white/80" /></div>
          )}
          {error && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/85 p-6 text-center text-white">
              <AlertTriangle className="size-7 text-warn" />
              <p className="text-sm font-medium">{t("This video couldn't be loaded.")}</p>
              <p className="text-xs text-white/70">{t("The file may still be processing or was removed.")}</p>
            </div>
          )}
        </div>
      </div>

      {!sideDock && dockNode}

      <div className="@container shrink-0 rounded-b-[0.5625rem] bg-panel px-3 pb-2.5 pt-2">
        <ScrubBar
          clock={clock}
          duration={duration}
          fps={fps}
          peaks={peakData}
          showWave={wave}
          markers={markers}
          activeMarker={activeMarker}
          onMarker={onMarker}
          onSeek={seek}
          onScrub={(on) => {
            if (on) {
              resumeAfterScrub.current = playing;
              if (playing) vref.current?.pause();
            } else if (resumeAfterScrub.current) {
              resumeAfterScrub.current = false;
              play();
            }
          }}
        />
        <div className="mt-1 flex flex-wrap items-center gap-x-0.5 gap-y-1">
          <PlayButton playing={busy} onClick={toggle} />
          <BarButton label={t("Previous frame (←)")} onClick={() => step(-1)}><StepBack className="size-4" /></BarButton>
          <BarButton label={t("Next frame (→)")} onClick={() => step(1)}><StepForward className="size-4" /></BarButton>
          <TimeReadout clock={clock} fps={fps} duration={duration} className="ml-1.5" />
          <div className="ml-auto flex items-center gap-0.5">
            {toolbar}
            <BarButton label={t("Loop")} active={loop} aria-pressed={loop} onClick={() => setLoop((l) => !l)} className="@max-sm:hidden"><Repeat className="size-4" /></BarButton>
            {peakData && (
              <BarButton label={t("Waveform")} active={wave} aria-pressed={wave} className="@max-sm:hidden"
                onClick={() => setWave((w) => { lsSet("veo-review-wave", w ? "0" : "1"); return !w; })}><AudioWaveform className="size-4" /></BarButton>
            )}
            <span aria-hidden className="mx-1 hidden h-5 w-px bg-line @sm:block" />
            <SpeedMenu rate={rate} onPick={(r) => { setBaseRate(r); if (vref.current) vref.current.playbackRate = r; }} />
            <VolumeControl className="@max-sm:hidden" volume={volume} muted={muted} onVolume={(v) => { setVolume(v); setMuted(false); }} onToggleMute={() => setMuted((m) => !m)} />
            {!simple && <ShortcutsButton extra={shortcutsExtra} />}
            <BarButton label={fs ? t("Exit fullscreen (F)") : t("Fullscreen (F)")} onClick={toggleFs}>
              {fs ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
            </BarButton>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Timecode chip in the monitor HUD (its own component so only it re-renders at 60 fps). */
function HudTime({ clock, fps, live }: { clock: Clock; fps: number; live: boolean }) {
  const time = useClock(clock);
  return <span className="rv-chip" data-tone={live ? "live" : undefined}>{formatTC(time, fps, true)}</span>;
}
