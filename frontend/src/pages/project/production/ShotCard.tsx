import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { clsx } from "clsx";
import { AudioLines, Check, Cpu, Film, History, Image as ImageIcon, MessageSquare, Mic, Play, ShieldAlert, ShieldCheck } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { QcMini } from "../../../components/hub/Qc";
import { LockMark } from "../../../components/shell/PresenceBar";
import { takeEngine } from "../../../components/hub/util";
import { Tooltip, rise } from "../../../components/ui";
import { useLockHolder } from "../../../lib/collab";
import { LANG_SHORT } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import type { Shot } from "../../../lib/types";
import { fmtDur } from "./instruments";
import { joinNames } from "./Recovery";
import { displayMedia, isStale, qcFailed, shotStages, staleReason, thumbRatio, type StageState } from "./shotMeta";

/** Amber "Stale" pill: the shot changed after this take was made. The tooltip says what changed. */
export function StaleBadge({ reason, className }: { reason: string; className?: string }) {
  const t = useT();
  const tip = reason ? t("Stale — {reason}", { reason }) : t("Stale — the shot changed after this take was made");
  return (
    <Tooltip content={tip}>
      <span role="img" aria-label={tip}
        className={clsx("mono inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md border border-warn/35 bg-warn/12 px-1.5 text-2xs font-medium leading-none text-warn", className)}>
        <History className="size-3" />{t("Stale")}
      </span>
    </Tooltip>
  );
}

/** Red "Blocked" pill: a safety filter stopped the shot's latest video. The tooltip says whose filter and what to do. */
function BlockedBadge({ engines }: { engines: string[] }) {
  const t = useT();
  const tip = engines.length === 1 ? t("Blocked by {engine}'s safety filter — open the shot to retry on another engine", { engine: engines[0] })
    : engines.length ? t("Blocked by the safety filters of {engines} — open the shot to retry on another engine", { engines: joinNames(engines) })
    : t("Blocked by a safety filter — open the shot to retry on another engine");
  return (
    <Tooltip content={tip}>
      <span role="img" aria-label={tip}
        className="mono inline-flex h-4 shrink-0 items-center gap-0.5 rounded border border-bad/40 bg-bad/15 px-1 text-2xs font-semibold leading-none text-bad">
        <ShieldAlert className="size-3" />{t("Blocked")}
      </span>
    </Tooltip>
  );
}

type SegState = StageState | "na" | "live";

/** One production stage (keyframe, video, voice, lip-sync, QC): an icon over a small lit bar. Dashed = nothing to do here. */
function Seg({ icon, state, label }: { icon: ReactNode; state: SegState; label: string }) {
  return (
    <span title={label} role="img" aria-label={label} data-s={state} className="seg flex min-w-0 flex-col items-center gap-1 py-0.5">
      <span className={clsx("grid h-4 place-items-center [&>svg]:size-3.5 transition-colors",
        state === "done" ? "text-ok" : state === "bad" ? "text-bad" : state === "live" ? "text-accent-ink" : "text-dim/70")}>{icon}</span>
      <i className="seg-bar w-full" />
    </span>
  );
}

/** The status LED in the tile header: where the shot stands overall. */
const LED: Record<string, string> = { approved: "bg-ok shadow-[0_0_6px_0_var(--color-ok)]", video_ready: "bg-accent shadow-[0_0_6px_0_var(--color-accent)]", keyframe_ready: "bg-info", draft: "bg-dim/60" };

export const ShotCard = memo(function ShotCard({ shot, lang, aspect, index, selected, picking, picked, threshold, draggable, engineName, onOpen }: {
  shot: Shot; lang: string; aspect: string; index: number; selected: boolean; picking: boolean; picked: boolean; threshold: number;
  draggable: boolean; engineName: string; onOpen: (id: number) => void;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: shot.id, disabled: !draggable });
  const [preview, setPreview] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [imgOk, setImgOk] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const bar = useRef<HTMLSpanElement>(null);
  const m = displayMedia(shot);
  const st = shotStages(shot, lang);
  const busy = shot.active_jobs.length > 0 || shot.generating;
  const lock = useLockHolder(`shot:${shot.id}`);
  const approved = shot.status === "approved";
  const madeBy = engineName || takeEngine(m.video);
  const pinned = !!engineName;
  const stale = isStale(shot);
  const r = rise(index);
  const qcBad = qcFailed(shot);
  const qcRan = shot.video?.qc?.passed !== undefined || shot.lipsync?.qc?.passed !== undefined;
  const ls = LANG_SHORT[lang] ?? lang;
  const blockedNoVideo = !!shot.blocked && !shot.video;

  useEffect(() => () => window.clearTimeout(timer.current), []);
  // dragging, or the card changing under the pointer, ends the preview
  useEffect(() => { if (isDragging) { setPreview(false); setPlaying(false); } }, [isDragging]);

  const enter = () => {
    if (!m.video || isDragging) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPreview(true), 220);
  };
  const leave = () => {
    window.clearTimeout(timer.current);
    setPreview(false);
    setPlaying(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onOpen(shot.id); }
  };

  const code = shot.code.split("-").pop();
  const label = `${shot.code}: ${shot.action}`;
  const len = Math.max(shot.extend_to || 0, shot.duration_s);

  return (
    // dnd-kit owns the outer element's transform; everything visual lives inside
    <div
      ref={setNodeRef}
      id={`shot-card-${shot.id}`}
      data-shot-card={shot.id}
      data-selected={selected ? "true" : "false"}
      data-picked={picked ? "true" : "false"}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 30 : undefined }}
      {...attributes}
      {...listeners}
      role="button"
      aria-label={label}
      aria-pressed={picking ? picked : selected}
      onClick={() => onOpen(shot.id)}
      onKeyDown={onKey}
      onMouseEnter={enter}
      onMouseLeave={leave}
      className="mon h-full scroll-mt-14 select-none rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
    >
      <div {...r} style={r.style} className={clsx(r.className, "h-full rounded-xl")}>
        <div className={clsx("relative h-full rounded-xl transition-transform duration-200 ease-out",
          busy && "gen-ring", !isDragging && "hover:-translate-y-0.5", isDragging && "scale-[1.03]")}>
          <div className={clsx("mon-frame flex h-full flex-col overflow-hidden rounded-xl border border-line bg-panel", isDragging && "opacity-90 shadow-modal")}>
            {/* head: LED + shot code on the left, timecode and flags on the right */}
            <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line/70 bg-raised/40 px-2">
              <span aria-hidden className={clsx("size-1.5 shrink-0 rounded-full", LED[shot.status] ?? LED.draft)} title={t(shot.status.replaceAll("_", " "))} />
              <span className="mono text-2xs font-semibold tracking-wide text-ink">{code}</span>
              {lock && <LockMark name={lock.name} />}
              {shot.blocked && <BlockedBadge engines={shot.blocked.engine_labels ?? []} />}
              <span className="flex-1" />
              {shot.comments > 0 && (
                <span title={t("{n} comment(s)", { n: shot.comments })} className="mono inline-flex items-center gap-0.5 rounded bg-info/15 px-1 text-2xs font-semibold leading-4 text-info">
                  <MessageSquare className="size-3" />{shot.comments}
                </span>
              )}
              <span title={t("Length")} className="mono text-2xs tabular-nums text-dim">{fmtDur(len)}</span>
              {picking ? (
                <span className={clsx("grid size-4 place-items-center rounded border transition-colors", picked ? "border-info bg-info text-black" : "border-dim/70 bg-transparent text-transparent")}>
                  <Check className="size-3" strokeWidth={3} />
                </span>
              ) : approved ? (
                <motion.span initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 520, damping: 22 }}
                  title={t("Approved")} role="img" aria-label={t("Approved")}
                  className="grid size-4 place-items-center rounded-full bg-ok text-black shadow-[0_0_8px_-1px_var(--color-ok)]">
                  <Check className="size-3" strokeWidth={3} />
                </motion.span>
              ) : null}
            </div>

            {/* screen */}
            <div className="p-1.5 pb-0">
              <div style={{ aspectRatio: thumbRatio(aspect) }} className={clsx("scr", !m.thumb && "scr-empty", m.thumb && !imgOk && "skeleton")}>
                {m.thumb ? (
                  <img src={m.thumb} alt="" loading="lazy" draggable={false} onLoad={() => setImgOk(true)} onError={() => setImgOk(true)}
                    className={clsx("h-full w-full object-cover transition-opacity duration-300", imgOk ? "opacity-100" : "opacity-0")} />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-1.5 p-3 text-center text-2xs text-white/55">
                    <ImageIcon className="size-5" />
                    <span className="eyebrow !text-white/60">{t("No keyframe yet")}</span>
                    <span className="line-clamp-3 text-white/50">{shot.action}</span>
                  </div>
                )}
                {preview && m.video && (
                  <video src={m.video.url} poster={m.thumb || undefined} autoPlay muted loop playsInline preload="auto"
                    onPlaying={() => setPlaying(true)}
                    onTimeUpdate={(e) => {
                      const v = e.currentTarget;
                      if (bar.current && v.duration) bar.current.style.transform = `scaleX(${Math.min(1, v.currentTime / v.duration)})`;
                    }}
                    className={clsx("absolute inset-0 h-full w-full object-cover transition-opacity duration-200", playing ? "opacity-100" : "opacity-0")} />
                )}
                {/* legibility scrim for the chips on the picture */}
                <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/65 to-transparent" />

                {madeBy && (
                  <span title={pinned ? t("Pinned engine: {name}", { name: madeBy }) : t("Made by {engine}", { engine: madeBy })}
                    className="mono absolute bottom-2.5 left-2.5 z-[5] inline-flex max-w-[72%] items-center gap-1 text-2xs text-white/90">
                    <Cpu className={clsx("size-3 shrink-0", pinned ? "text-accent-2" : "text-white/70")} />
                    <span className="truncate">{madeBy}</span>
                  </span>
                )}
                {m.video && !preview && (
                  <span aria-hidden className="absolute bottom-2 right-2 z-[5] grid size-5 place-items-center rounded-full border border-white/25 bg-black/55 text-white/90 backdrop-blur-sm">
                    <Play className="size-3 translate-x-px" fill="currentColor" />
                  </span>
                )}
                <span ref={bar} aria-hidden className={clsx("absolute inset-x-0 bottom-0 z-[5] h-0.5 origin-left bg-accent shadow-[0_0_8px_var(--color-accent)]", preview && playing ? "opacity-100" : "opacity-0")} style={{ transform: "scaleX(0)" }} />

                <AnimatePresence>
                  {busy && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
                      className="absolute inset-0 z-[6] flex flex-col items-center justify-center gap-2 bg-black/60 backdrop-blur-[1px]">
                      <div className="mono flex max-w-[88%] items-center gap-2 rounded-md border border-accent/35 bg-black/70 px-2 py-1 text-2xs font-medium text-white">
                        <span className="eq" aria-hidden><i /><i /><i /><i /></span>
                        <span className="truncate">{shot.active_jobs[0] ? t(shot.active_jobs[0]) : t("working")}</span>
                      </div>
                      <span aria-hidden className="sweep absolute inset-x-0 bottom-0 h-0.5 bg-accent/50" />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* caption + stage strip */}
            <div className="flex flex-1 flex-col justify-between gap-2 px-2.5 pb-2 pt-2">
              <p className="line-clamp-2 min-h-[2.1rem] text-xs leading-snug text-mute">
                {shot.framing && <span className="mono text-2xs font-medium uppercase tracking-wide text-ink">{shot.framing} </span>}{shot.action}
              </p>
              <div>
                <div className="grid grid-cols-5 gap-1.5">
                  <Seg icon={<ImageIcon />} state={st.kf} label={st.kf === "done" ? t("Keyframe ready") : t("No keyframe yet")} />
                  <Seg icon={<Film />} state={blockedNoVideo ? "bad" : st.vid}
                    label={blockedNoVideo ? t("Video blocked by a safety filter") : st.vid === "done" ? t("Video ready") : t("No video yet")} />
                  <Seg icon={<Mic />} state={st.voice ?? "na"}
                    label={st.voice === null ? t("No spoken lines in this language.") : st.voice === "done" ? t("Voice ready ({lang})", { lang: ls }) : t("Voice not generated yet ({lang})", { lang: ls })} />
                  <Seg icon={<AudioLines />} state={st.lip ?? "na"}
                    label={st.lip === null ? t("No spoken lines in this language.") : st.lip === "done" ? t("Lip-synced ({lang})", { lang: ls })
                      : t("{n} line(s) in {lang}; voice mode {mode}", { n: st.lines, lang, mode: shot.effective_voice_mode })} />
                  <Seg icon={<ShieldCheck />} state={qcBad ? "bad" : qcRan ? "done" : "todo"} label={qcBad ? t("QC failed") : qcRan ? t("QC passed") : t("Quality check")} />
                </div>
                {(stale || shot.video?.qc || shot.lipsync?.qc) && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 empty:hidden">
                    <QcMini take={shot.video} lipTake={shot.lipsync} threshold={threshold} />
                    {stale && <StaleBadge reason={staleReason(shot)} className="ml-auto" />}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
