import { clsx } from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { CircleCheck, PenLine } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { WaveCanvas, type PeakData, type WaveSeg } from "./Waveform";
import { clamp, formatTC, useClock, type Clock, type Marker } from "./utils";

function PlayedLayer({ clock, duration, children }: { clock: Clock; duration: number; children: React.ReactNode }) {
  const t = useClock(clock);
  const pct = duration ? clamp(t / duration, 0, 1) * 100 : 0;
  return <div className="pointer-events-none absolute inset-0" style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}>{children}</div>;
}

function Head({ clock, duration, dragging }: { clock: Clock; duration: number; dragging: boolean }) {
  const t = useClock(clock);
  const pct = duration ? clamp(t / duration, 0, 1) * 100 : 0;
  return (
    <div className="pointer-events-none absolute inset-y-0 w-0" style={{ left: `${pct}%` }}>
      <div className="absolute -left-px bottom-2 top-1 w-0.5 rounded-full bg-ink/90 shadow-[0_0_0_1px_rgb(0_0_0/0.35)]" />
      <div className={clsx("absolute -left-[7px] bottom-[8px] size-3.5 rounded-full border-2 border-accent bg-ink shadow-[0_2px_6px_rgb(0_0_0/0.45)] transition-transform duration-150",
        dragging ? "scale-125" : "group-hover:scale-110")} />
    </div>
  );
}

/**
 * Scrub bar: waveform (backend peaks), played region, comment markers (amber dots, resolved ones dimmed; hover shows a
 * snippet), hover timecode and a draggable playhead. Touch friendly: 44px tall hit area, pointer capture while dragging.
 */
export function ScrubBar({ clock, duration, fps, onSeek, onScrub, peaks, markers = [], activeMarker, onMarker, className }: {
  clock: Clock; duration: number; fps: number; onSeek: (t: number) => void; onScrub?: (active: boolean) => void;
  peaks?: PeakData | null; markers?: Marker[]; activeMarker?: number | null; onMarker?: (id: number) => void; className?: string;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [hoverMarker, setHoverMarker] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef(false);
  const segs: WaveSeg[] = useMemo(() => (peaks ? [{ start: 0, dur: peaks.duration, data: peaks }] : []), [peaks]);
  const timeAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, 0, 1) * duration;
  };
  const width = ref.current?.clientWidth ?? 0;
  const hm = markers.find((m) => m.id === hoverMarker);

  return (
    <div
      ref={ref}
      role="slider"
      aria-label={t("Seek")}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(clock.get())}
      tabIndex={-1}
      className={clsx("group relative h-11 cursor-pointer touch-none select-none", className)}
      onPointerDown={(e) => {
        if (!duration || e.button !== 0) return;
        if ((e.target as HTMLElement).closest("[data-marker]")) return;
        drag.current = true;
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        onScrub?.(true);
        onSeek(timeAt(e.clientX));
      }}
      onPointerMove={(e) => {
        const r = ref.current!.getBoundingClientRect();
        setHoverX(clamp(e.clientX - r.left, 0, r.width));
        if (drag.current) onSeek(timeAt(e.clientX));
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        drag.current = false;
        setDragging(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        onScrub?.(false);
      }}
      onPointerCancel={() => { if (drag.current) { drag.current = false; setDragging(false); onScrub?.(false); } }}
      onPointerLeave={() => { if (!drag.current) setHoverX(null); }}
    >
      {/* waveform */}
      {segs.length > 0 && (
        <div className="absolute inset-x-0 top-1 h-6 overflow-hidden rounded-sm">
          <WaveCanvas segs={segs} duration={peaks!.duration} height={24} className="text-dim opacity-50" />
          <PlayedLayer clock={clock} duration={duration}>
            <WaveCanvas segs={segs} duration={peaks!.duration} height={24} className="text-accent-ink opacity-85" />
          </PlayedLayer>
        </div>
      )}
      {/* track */}
      <div className="absolute inset-x-0 bottom-3 h-1.5 rounded-full bg-line transition-[height] duration-150 group-hover:h-2">
        <PlayedLayer clock={clock} duration={duration}><div className="h-full rounded-full bg-accent" /></PlayedLayer>
      </div>
      {/* comment markers */}
      {duration > 0 && markers.map((m) => (
        <button
          key={m.id}
          data-marker
          type="button"
          aria-label={t("Comment at {tc}", { tc: formatTC(m.time, fps, true) })}
          onPointerEnter={() => setHoverMarker(m.id)}
          onPointerLeave={() => setHoverMarker(null)}
          onFocus={() => setHoverMarker(m.id)}
          onBlur={() => setHoverMarker(null)}
          onClick={(e) => { e.stopPropagation(); onMarker?.(m.id); }}
          className="group/m absolute bottom-[3px] z-10 -ml-3 grid size-6 place-items-center rounded-full max-sm:-ml-3.5 max-sm:size-7"
          style={{ left: `${clamp(m.time / duration, 0, 1) * 100}%` }}
        >
          <span className={clsx("block size-2.5 rounded-full border-2 border-panel transition-transform duration-150 group-hover/m:scale-150",
            m.resolved ? "bg-dim" : "bg-accent-2", activeMarker === m.id && "scale-150 ring-2 ring-accent")} />
        </button>
      ))}
      <Head clock={clock} duration={duration} dragging={dragging} />
      {/* hover readouts */}
      <AnimatePresence>
        {hm && duration > 0 && (
          <motion.div
            key={hm.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.15 }}
            className="pointer-events-none absolute bottom-9 z-20 w-56 -translate-x-1/2 rounded-xl border border-line bg-raised p-2.5 text-left shadow-pop"
            style={{ left: `clamp(7rem, ${clamp(hm.time / duration, 0, 1) * 100}%, calc(100% - 7rem))` }}
          >
            <p className="flex items-center gap-1.5 text-2xs text-mute">
              <span className="rounded bg-accent-2/15 px-1 py-px font-mono font-medium text-amber-300">{formatTC(hm.time, fps, true)}</span>
              <span className="min-w-0 flex-1 truncate font-medium text-ink">{hm.author}</span>
              {hm.drawing && <PenLine className="size-3 shrink-0" />}
              {hm.resolved && <span className="inline-flex shrink-0 items-center gap-0.5 text-green-300"><CircleCheck className="size-3" />{t("Resolved")}</span>}
            </p>
            <p className="mt-1 line-clamp-2 text-xs text-ink">{hm.body}</p>
          </motion.div>
        )}
      </AnimatePresence>
      {hoverX !== null && !hm && duration > 0 && (
        <div className="pointer-events-none absolute bottom-9 z-20 -translate-x-1/2 rounded-md border border-line bg-raised px-1.5 py-0.5 font-mono text-2xs tabular-nums text-ink shadow-pop"
          style={{ left: clamp(hoverX, 34, Math.max(34, width - 34)) }}>
          {formatTC((hoverX / Math.max(1, width)) * duration, fps)}
        </div>
      )}
    </div>
  );
}
