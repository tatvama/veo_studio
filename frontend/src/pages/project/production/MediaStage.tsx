import { clsx } from "clsx";
import { Image as ImageIcon, Maximize2, Minimize2, Pause, Play, Repeat, Volume2, VolumeX } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { capturePointer, releasePointer } from "../../../components/hub/util";
import { Tooltip } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import { ratioOf } from "./shotMeta";

/** Height the viewer aims for: tall enough to judge a frame, never most of the screen. */
const STAGE_H = "clamp(240px, 46vh, 560px)";
/** CSS width of the viewer for a project aspect (used to lay the info column out next to a portrait video). */
export const stageWidth = (aspect: string) => {
  const r = ratioOf(aspect);
  return `calc(${STAGE_H} * ${r.w} / ${r.h})`;
};

const fmt = (s: number) => {
  const v = Number.isFinite(s) ? Math.max(0, s) : 0;
  return `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`;
};

function StageButton({ title, onClick, active, children, className }: { title: string; onClick: () => void; active?: boolean; children: ReactNode; className?: string }) {
  return (
    <Tooltip content={title}>
      <button type="button" aria-label={title} aria-pressed={active} onClick={(e) => { e.stopPropagation(); onClick(); }}
        className={clsx("grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-white/15 hover:text-white",
          active ? "text-accent" : "text-white/85", className)}>
        {children}
      </button>
    </Tooltip>
  );
}

/** Scrub bar: drag or click to seek. The fill is moved by the parent's animation frame loop (no re-render per frame). */
function Scrub({ fill, dur, onSeek }: { fill: React.RefObject<HTMLDivElement | null>; dur: number; onSeek: (t: number) => void }) {
  const t = useT();
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const at = (x: number) => {
    const r = el.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (x - r.left) / Math.max(1, r.width))) * dur;
  };
  return (
    <div
      ref={el} role="slider" tabIndex={0} aria-label={t("Seek")} aria-valuemin={0} aria-valuemax={Math.round(dur)}
      className="group/scrub relative flex h-5 min-w-0 flex-1 cursor-pointer touch-none items-center"
      onPointerDown={(e) => { e.stopPropagation(); drag.current = true; capturePointer(e.currentTarget, e.pointerId); onSeek(at(e.clientX)); }}
      onPointerMove={(e) => { if (drag.current) onSeek(at(e.clientX)); }}
      onPointerUp={(e) => { drag.current = false; releasePointer(e.currentTarget, e.pointerId); }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault(); e.stopPropagation();
          onSeek(Math.min(dur, Math.max(0, (fill.current ? parseFloat(fill.current.dataset.t ?? "0") : 0) + (e.key === "ArrowRight" ? 0.5 : -0.5))));
        }
      }}
    >
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/25 transition-[height] group-hover/scrub:h-1.5">
        <div ref={fill} data-t="0" className="h-full origin-left rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]" style={{ transform: "scaleX(0)" }} />
      </div>
    </div>
  );
}

function Player({ src, poster, autoPlay, box }: { src: string; poster?: string; autoPlay: boolean; box: React.RefObject<HTMLDivElement | null> }) {
  const t = useT();
  const vid = useRef<HTMLVideoElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(true);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [fs, setFs] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = useCallback(() => {
    const v = vid.current;
    if (!v) return;
    if (v.paused || v.ended) void v.play().catch(() => setPlaying(false));
    else v.pause();
  }, []);
  const seek = useCallback((s: number) => {
    const v = vid.current;
    if (!v) return;
    v.currentTime = s;
    if (fill.current && v.duration) { fill.current.style.transform = `scaleX(${s / v.duration})`; fill.current.dataset.t = String(s); }
    setTime(s);
  }, []);

  // smooth progress while playing
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = vid.current;
      if (v && fill.current && v.duration) {
        fill.current.style.transform = `scaleX(${v.currentTime / v.duration})`;
        fill.current.dataset.t = String(v.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => {
    const on = () => setFs(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, [box]);

  const toggleFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen?.();
  };

  if (failed) {
    return <div className="grid h-full place-items-center p-4 text-center text-xs text-white/70">{t("This clip couldn't be played. Try another take.")}</div>;
  }

  return (
    <>
      <video
        ref={vid} src={src} poster={poster} autoPlay={autoPlay} loop={loop} muted={muted} playsInline preload="auto"
        className="absolute inset-0 h-full w-full cursor-pointer object-contain"
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setFailed(true)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
      />
      <AnimatePresence>
        {!playing && (
          <motion.button type="button" key="big" aria-label={t("Play")} onClick={toggle}
            initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.1 }} transition={{ duration: 0.16 }}
            className="absolute left-1/2 top-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/25 bg-black/55 text-white shadow-lg backdrop-blur-md transition-colors hover:border-accent hover:bg-accent hover:text-[var(--on-accent)]">
            <Play className="size-6 translate-x-0.5" fill="currentColor" />
          </motion.button>
        )}
      </AnimatePresence>
      <div className={clsx(
        "absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2 pb-1.5 pt-8 transition-opacity duration-200",
        playing ? "opacity-0 focus-within:opacity-100 group-hover/stage:opacity-100" : "opacity-100")}>
        <StageButton title={playing ? t("Pause") : t("Play")} onClick={toggle}>
          {playing ? <Pause className="size-4" fill="currentColor" /> : <Play className="size-4 translate-x-px" fill="currentColor" />}
        </StageButton>
        {/* small stages (a portrait clip in a narrow drawer) drop the secondary controls instead of clipping them */}
        <span className="mono hidden w-[5.5rem] shrink-0 text-center text-2xs tabular-nums text-white/85 @min-[300px]/stage:block">{fmt(time)} <span className="text-white/45">/ {fmt(dur)}</span></span>
        <Scrub fill={fill} dur={dur} onSeek={seek} />
        <StageButton title={muted ? t("Unmute") : t("Mute")} onClick={() => setMuted((m) => !m)} active={muted}>
          {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </StageButton>
        <StageButton title={loop ? t("Looping") : t("Loop off")} onClick={() => setLoop((l) => !l)} active={loop} className="hidden @min-[240px]/stage:grid"><Repeat className="size-4" /></StageButton>
        <StageButton title={fs ? t("Exit full screen") : t("Full screen")} onClick={toggleFs}>
          {fs ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </StageButton>
      </div>
    </>
  );
}

/**
 * Large viewer for one take: video with its own controls, a still, or an empty state. The box always has the project's
 * aspect ratio, so overlays and letterboxing never lie about the framing. Changing `id` crossfades to the new media.
 */
export function MediaStage({ id, kind, src, poster, aspect, label, emptyLabel, autoPlay = true, className }: {
  id: string | number; kind: "video" | "image" | "empty"; src?: string; poster?: string; aspect: string;
  label?: ReactNode; emptyLabel?: string; autoPlay?: boolean; className?: string;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const r = ratioOf(aspect);
  return (
    <div
      ref={box} tabIndex={0} role="group" aria-label={t("Viewer")}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === " ") {
          e.preventDefault();
          const v = box.current?.querySelector("video");
          if (v) { if (v.paused) void v.play().catch(() => {}); else v.pause(); }
        }
      }}
      style={{ aspectRatio: r.css, maxWidth: stageWidth(aspect) }}
      className={clsx(
        "scr group/stage @container/stage mx-auto w-full outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        "[&:fullscreen]:max-w-none [&:fullscreen]:rounded-none", !src && kind !== "image" && "scr-empty", className)}
    >
      <motion.div key={id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }} className="absolute inset-0">
        {kind === "video" && src ? (
          <Player src={src} poster={poster} autoPlay={autoPlay} box={box} />
        ) : kind === "image" && src ? (
          <img src={src} alt="" className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-white/60">
            <ImageIcon className="size-8" />
            <span className="eyebrow !text-white/60">{emptyLabel ?? t("No keyframe yet")}</span>
          </div>
        )}
      </motion.div>
      {label && (
        <span className="mono pointer-events-none absolute left-3 top-3 z-[5] max-w-[70%] truncate rounded border border-white/15 bg-black/60 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wider text-white backdrop-blur-sm">{label}</span>
      )}
    </div>
  );
}
