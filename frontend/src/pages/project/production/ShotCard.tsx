import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { clsx } from "clsx";
import { AudioLines, Check, Cpu, Film, Image as ImageIcon, MessageSquare, Mic, Play } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { QcMini } from "../../../components/hub/Qc";
import { LockMark } from "../../../components/shell/PresenceBar";
import { takeEngine } from "../../../components/hub/util";
import { Progress, rise } from "../../../components/ui";
import { useLockHolder } from "../../../lib/collab";
import { LANG_SHORT } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import type { Shot } from "../../../lib/types";
import { displayMedia, shotStages, thumbRatio, type StageState } from "./shotMeta";

/** One production stage (keyframe, video, voice, lip-sync): filled + coloured when done, dashed when still to do. */
function StageIcon({ icon, state, label }: { icon: ReactNode; state: StageState; label: string }) {
  return (
    <span title={label} role="img" aria-label={label}
      className={clsx("grid size-[18px] shrink-0 place-items-center rounded-md [&>svg]:size-3.5",
        state === "done" && "bg-ok/12 text-ok", state === "bad" && "bg-bad/12 text-bad",
        state === "todo" && "border border-dashed border-line text-dim")}>
      {icon}
    </span>
  );
}

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
  const r = rise(index);

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

  return (
    // dnd-kit owns the outer element's transform; everything visual lives inside
    <div
      ref={setNodeRef}
      id={`shot-card-${shot.id}`}
      data-shot-card={shot.id}
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
      className="h-full scroll-mt-14 select-none rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
    >
      <div {...r} style={r.style} className={clsx(r.className, "h-full rounded-xl")}>
        <div className={clsx("relative h-full rounded-xl transition-transform duration-200 ease-out",
          busy && "gen-ring", !isDragging && "hover:-translate-y-0.5", isDragging && "scale-[1.03]")}>
          <div className={clsx(
            "flex h-full flex-col overflow-hidden rounded-xl border bg-panel transition-[border-color,box-shadow] duration-200",
            selected ? "border-accent shadow-glow" : picked ? "border-info ring-2 ring-info/30" : "border-line hover:border-dim/60 hover:shadow-lift",
            isDragging && "opacity-90 shadow-modal")}>
            {/* media */}
            <div style={{ aspectRatio: thumbRatio(aspect) }} className={clsx("relative overflow-hidden bg-raised", m.thumb && !imgOk && "skeleton")}>
              {m.thumb ? (
                <img src={m.thumb} alt="" loading="lazy" draggable={false} onLoad={() => setImgOk(true)} onError={() => setImgOk(true)}
                  className={clsx("h-full w-full object-cover transition-opacity duration-300", imgOk ? "opacity-100" : "opacity-0")} />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-1.5 p-3 text-center text-2xs text-dim">
                  <ImageIcon className="size-5" />
                  <span className="font-medium text-mute">{t("No keyframe yet")}</span>
                  <span className="line-clamp-3">{shot.action}</span>
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
              {/* legibility scrims */}
              <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-black/55 to-transparent" />
              <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/60 to-transparent" />

              <div className="absolute left-1.5 top-1.5 flex items-center gap-1">
                <span className="rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-2xs font-semibold text-white backdrop-blur-sm">{code}</span>
                {lock && <LockMark name={lock.name} />}
                <span className="rounded-md bg-black/60 px-1.5 py-0.5 text-2xs font-medium tabular-nums text-white backdrop-blur-sm">{shot.duration_s}s</span>
                {shot.comments > 0 && (
                  <span title={t("{n} comment(s)", { n: shot.comments })} className="inline-flex items-center gap-0.5 rounded-md bg-info px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-black">
                    <MessageSquare className="size-3" />{shot.comments}
                  </span>
                )}
              </div>

              <div className="absolute right-1.5 top-1.5">
                {picking ? (
                  <span className={clsx("grid size-5 place-items-center rounded-md border-2 transition-colors",
                    picked ? "border-info bg-info text-black" : "border-white/80 bg-black/35 text-transparent")}>
                    <Check className="size-3.5" strokeWidth={3} />
                  </span>
                ) : approved ? (
                  <motion.span initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 520, damping: 22 }}
                    title={t("Approved")} role="img" aria-label={t("Approved")}
                    className="grid size-5 place-items-center rounded-full bg-ok text-black shadow-md">
                    <Check className="size-3.5" strokeWidth={3} />
                  </motion.span>
                ) : null}
              </div>

              {madeBy && (
                <span title={pinned ? t("Pinned engine: {name}", { name: madeBy }) : t("Made by {engine}", { engine: madeBy })}
                  className="absolute bottom-1.5 left-1.5 inline-flex max-w-[78%] items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-2xs text-white backdrop-blur-sm">
                  <Cpu className={clsx("size-3 shrink-0", pinned && "text-accent-2")} />
                  <span className="truncate">{madeBy}</span>
                </span>
              )}
              {m.video && !preview && (
                <span aria-hidden className="absolute bottom-1.5 right-1.5 grid size-5 place-items-center rounded-full bg-black/55 text-white/90 backdrop-blur-sm">
                  <Play className="size-3 translate-x-px" fill="currentColor" />
                </span>
              )}
              <span ref={bar} aria-hidden className={clsx("absolute inset-x-0 bottom-0 h-0.5 origin-left bg-accent", preview && playing ? "opacity-100" : "opacity-0")} style={{ transform: "scaleX(0)" }} />

              <AnimatePresence>
                {busy && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
                    className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55 backdrop-blur-[1px]">
                    <div className="flex max-w-[88%] items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-2xs font-medium text-white">
                      <span className="size-2 shrink-0 animate-pulse rounded-full bg-accent" />
                      <span className="truncate">{shot.active_jobs[0] ? t(shot.active_jobs[0]) : t("working")}</span>
                    </div>
                    <div className="absolute inset-x-0 bottom-0"><Progress indeterminate size="sm" className="!rounded-none !bg-white/15" /></div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* caption + status */}
            <div className="flex flex-1 flex-col justify-between gap-2 p-2.5">
              <p className="line-clamp-2 min-h-[2.1rem] text-xs leading-snug text-mute">
                {shot.framing && <span className="font-medium text-ink">{shot.framing}. </span>}{shot.action}
              </p>
              <div className="flex flex-wrap items-center gap-1">
                <StageIcon icon={<ImageIcon />} state={st.kf} label={st.kf === "done" ? t("Keyframe ready") : t("No keyframe yet")} />
                <StageIcon icon={<Film />} state={st.vid} label={st.vid === "done" ? t("Video ready") : t("No video yet")} />
                {st.voice && <StageIcon icon={<Mic />} state={st.voice}
                  label={st.voice === "done" ? t("Voice ready ({lang})", { lang: LANG_SHORT[lang] ?? lang }) : t("Voice not generated yet ({lang})", { lang: LANG_SHORT[lang] ?? lang })} />}
                {st.lip && <StageIcon icon={<AudioLines />} state={st.lip}
                  label={st.lip === "done" ? t("Lip-synced ({lang})", { lang: LANG_SHORT[lang] ?? lang }) : t("{n} line(s) in {lang}; voice mode {mode}", { n: st.lines, lang, mode: shot.effective_voice_mode })} />}
                <QcMini take={shot.video} lipTake={shot.lipsync} threshold={threshold} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
