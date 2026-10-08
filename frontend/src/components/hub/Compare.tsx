import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Crown, Pause, Play, RotateCcw, Trophy, Volume2, VolumeX } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { secs, usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import type { Take } from "../../lib/types";
import { Badge, Button, Segmented, Tooltip } from "../ui";
import { QcBadges } from "./Qc";
import { capturePointer, releasePointer, takeEngine } from "./util";

/** Pick a shootout winner: selects the take and credits its engine's win count. */
export function usePickWinner(shotId: number) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<number | null>(null);
  const pick = async (take: Take, mode: "winner" | "select" = "winner") => {
    setBusy(take.id);
    try {
      await api.post(`/api/takes/${take.id}/${mode}`);
      qc.invalidateQueries({ queryKey: ["shot", shotId] });
      qc.invalidateQueries({ queryKey: ["episode"] });
      if (mode === "winner") qc.invalidateQueries({ queryKey: ["models"] });
      toast.success(mode === "winner" ? tr("Winner: {engine}", { engine: takeEngine(take) || `#${take.id}` }) : tr("Take #{id} is now in use", { id: take.id }));
    } catch {
      /* api() showed the error */
    } finally {
      setBusy(null);
    }
  };
  return { pick, busy };
}

/** Draggable progress bar (state driven: the compare view re-renders a few times a second anyway). */
function Scrubber({ value, max, onChange, label }: { value: number; max: number; onChange: (v: number) => void; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const at = (x: number) => {
    const r = el.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (x - r.left) / Math.max(1, r.width))) * max;
  };
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div
      ref={el} role="slider" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={Math.round(max * 10) / 10} aria-valuenow={Math.round(value * 10) / 10}
      className="group/scrub relative flex h-6 min-w-0 flex-1 cursor-pointer touch-none items-center"
      onPointerDown={(e) => { drag.current = true; capturePointer(e.currentTarget, e.pointerId); onChange(at(e.clientX)); }}
      onPointerMove={(e) => { if (drag.current) onChange(at(e.clientX)); }}
      onPointerUp={(e) => { drag.current = false; releasePointer(e.currentTarget, e.pointerId); }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); onChange(Math.min(max, Math.max(0, value + (e.key === "ArrowRight" ? 0.25 : -0.25)))); }
      }}
    >
      <div className="relative h-1.5 w-full rounded-full bg-line">
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct}%` }} />
        <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink shadow transition-transform group-hover/scrub:scale-125" style={{ left: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * Side-by-side compare of 2–4 takes with synced playback (one transport for all clips, one audible at a time).
 * `action` "winner" credits the engine (shootouts); "select" just puts the take in use.
 */
export function SyncedCompare({ takes, shotId, canReview, action = "winner", aspect = "16:9" }: {
  takes: Take[]; shotId: number; canReview: boolean; action?: "winner" | "select"; aspect?: string;
}) {
  const t = useT();
  const refs = useRef<(HTMLVideoElement | null)[]>([]);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [rate, setRate] = useState(1);
  const [audible, setAudible] = useState<number>(-1);
  const { pick, busy } = usePickWinner(shotId);
  const isVideo = (x: Take) => x.kind !== "keyframe";
  const videos = takes.filter(isVideo);
  const ids = takes.map((x) => x.id).join(",");

  const all = () => refs.current.filter((v): v is HTMLVideoElement => !!v);
  const leader = () => all()[0];
  const recalc = () => setDur(Math.max(0, ...all().map((v) => (Number.isFinite(v.duration) ? v.duration : 0))));

  useEffect(() => {
    refs.current.length = videos.length;
    setPlaying(false); setTime(0);
    recalc();
  }, [ids]);
  useEffect(() => { all().forEach((v) => { v.playbackRate = rate; }); }, [rate, ids]);

  const play = useCallback(() => {
    const lead = leader();
    if (lead && lead.ended) all().forEach((v) => { v.currentTime = 0; });
    all().forEach((v) => { v.play().catch(() => {}); });
    setPlaying(true);
  }, []);
  const pause = useCallback(() => { all().forEach((v) => v.pause()); setPlaying(false); }, []);
  const seek = (s: number) => { all().forEach((v) => { v.currentTime = Math.min(s, Math.max(0, (v.duration || s) - 0.05)); }); setTime(s); };
  const restart = () => { seek(0); if (playing) play(); };

  // keep followers within ~0.15s of the leader
  const onLeaderTime = () => {
    const lead = leader();
    if (!lead) return;
    setTime(lead.currentTime);
    for (const v of all().slice(1)) {
      const inRange = !!v.duration && lead.currentTime < v.duration;
      if (inRange && Math.abs(v.currentTime - lead.currentTime) > 0.15) v.currentTime = lead.currentTime;
      if (inRange && !lead.paused && v.paused) v.play().catch(() => {});
    }
  };
  const onLeaderEnded = () => {
    // loop the whole set together
    all().forEach((v) => { v.currentTime = 0; });
    if (playing) all().forEach((v) => { v.play().catch(() => {}); });
  };

  const gridCols = takes.length === 2 ? "grid-cols-2" : takes.length === 3 ? "grid-cols-3" : "grid-cols-2";
  const ratio = aspect === "16:9" ? "aspect-video" : aspect === "1:1" ? "aspect-square" : "aspect-[9/16]";
  const letter = (i: number) => String.fromCharCode(65 + i);

  return (
    <div className="space-y-2.5">
      {videos.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-raised px-2 py-1.5">
          <Tooltip content={playing ? t("Pause all") : t("Play all")}>
            <button type="button" onClick={playing ? pause : play} aria-label={playing ? t("Pause all") : t("Play all")}
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-black shadow-sm transition-[transform,filter] hover:brightness-110 active:scale-95">
              {playing ? <Pause className="size-4" fill="currentColor" /> : <Play className="size-4 translate-x-px" fill="currentColor" />}
            </button>
          </Tooltip>
          <Tooltip content={t("Restart")}>
            <button type="button" onClick={restart} aria-label={t("Restart")} className="grid size-8 shrink-0 place-items-center rounded-lg text-mute transition-colors hover:bg-hover hover:text-ink">
              <RotateCcw className="size-4" />
            </button>
          </Tooltip>
          <Scrubber value={Math.min(time, dur || 1)} max={dur || 1} onChange={seek} label={t("Scrub all clips")} />
          <span className="w-[4.5rem] shrink-0 text-right font-mono text-2xs tabular-nums text-mute">{time.toFixed(1)} / {(dur || 0).toFixed(1)}s</span>
          <Segmented value={rate} onChange={setRate} aria-label={t("Playback speed")}
            options={[{ value: 0.5, label: "0.5×" }, { value: 1, label: "1×" }]} />
        </div>
      )}
      <div className={clsx("grid gap-2.5", gridCols)}>
        <AnimatePresence initial={false}>
          {takes.map((x, i) => {
            const L = letter(i);
            const vi = videos.indexOf(x);
            return (
              <motion.div key={x.id} layout initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className={clsx("flex flex-col overflow-hidden rounded-xl border bg-panel", x.selected ? "border-accent shadow-glow" : "border-line")}>
                <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <span className="grid size-5 shrink-0 place-items-center rounded-md bg-accent text-2xs font-bold text-black">{L}</span>
                  <p className="min-w-0 flex-1 truncate text-xs font-semibold" title={x.params?.engine || x.model}>{takeEngine(x) || x.provider}</p>
                  {x.selected && (
                    <motion.span initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 520, damping: 20 }}>
                      <Badge tone="accent"><Crown className="size-3" />{t("in use")}</Badge>
                    </motion.span>
                  )}
                </div>
                <div className={clsx("relative w-full bg-black", ratio, "max-h-[42vh]")}>
                  {isVideo(x) ? (
                    <video
                      ref={(el) => { refs.current[vi] = el; }}
                      src={x.url} poster={x.thumb_url || undefined} playsInline preload="auto" muted={audible !== i}
                      onClick={playing ? pause : play}
                      onLoadedMetadata={recalc}
                      onTimeUpdate={vi === 0 ? onLeaderTime : undefined}
                      onEnded={vi === 0 ? onLeaderEnded : undefined}
                      className="h-full w-full cursor-pointer object-contain"
                    />
                  ) : (
                    <img src={x.url} alt="" className="h-full w-full object-contain" />
                  )}
                  {isVideo(x) && (
                    <Tooltip content={audible === i ? t("Mute this clip") : t("Listen to this clip")}>
                      <button type="button" onClick={() => setAudible((a) => (a === i ? -1 : i))} aria-pressed={audible === i}
                        aria-label={audible === i ? t("Mute this clip") : t("Listen to this clip")}
                        className={clsx("absolute bottom-1.5 right-1.5 grid size-7 place-items-center rounded-lg bg-black/65 backdrop-blur-sm transition-colors hover:bg-black/85",
                          audible === i ? "text-accent-2" : "text-white")}>
                        {audible === i ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
                      </button>
                    </Tooltip>
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-1.5 p-2.5">
                  <div className="flex flex-wrap items-center gap-1 text-2xs tabular-nums text-dim">
                    <span>#{x.id}</span>
                    {x.cost_usd > 0 && <span>· {usd(x.cost_usd)}</span>}
                    {x.duration_s > 0 && <span>· {secs(x.duration_s)}</span>}
                    {x.params?.mode && <Badge>{String(x.params.mode)}</Badge>}
                  </div>
                  <QcBadges take={x} />
                  {canReview && !x.selected && (
                    <Button size="sm" variant={action === "winner" ? "primary" : "secondary"} className="mt-auto w-full" loading={busy === x.id}
                      icon={action === "winner" ? <Trophy className="size-3.5" /> : undefined} onClick={() => pick(x, action)}>
                      {action === "winner" ? t("Pick {letter} as winner", { letter: L }) : t("Use take {letter}", { letter: L })}
                    </Button>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
