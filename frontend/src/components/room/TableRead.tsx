import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Download, Headphones, Pause, Play, RotateCcw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { ago, LANG_NAMES, LANG_SHORT } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useCharacters, useTableRead } from "../../lib/queries";
import type { Episode, SubmitResult, TableRead, TableReadLine } from "../../lib/types";
import { useProjectCtx } from "../../pages/project/context";
import { useGenerate } from "../Generate";
import { Button, IconButton, Progress, Segmented } from "../ui";
import { PanelHead, RoomEmpty } from "./kit";
import { useActiveJobs, useCastTones } from "./util";

const clock = (s: number) => {
  const v = Math.max(0, s || 0);
  return `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`;
};

/** Table read: the episode as an audio drama in the cast voices, with a synced line list. */
export function TableReadPanel({ ep }: { ep: Episode }) {
  const t = useT();
  const qc = useQueryClient();
  const { project, lang, canEdit } = useProjectCtx();
  const { submit } = useGenerate();
  const { data: reads } = useTableRead(ep.id);
  const { data: cast } = useCharacters(project.id);
  const [view, setView] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useActiveJobs(project.id, (j) => j.type === "table_read" && j.episode_id === ep.id);
  const runningHere = running.find((j) => (j.payload?.language || project.primary_language) === lang);

  // The episode query refreshes on live events; refresh the read list whenever a read's timestamp changes.
  const stamp = JSON.stringify(Object.entries(ep.table_read ?? {}).map(([l, v]) => [l, v?.at]));
  useEffect(() => { qc.invalidateQueries({ queryKey: ["table-read", ep.id] }); }, [stamp, ep.id, qc]);

  const langs = Object.keys(reads ?? {}).filter((l) => reads?.[l]?.url);
  const current = view && langs.includes(view) ? view : langs.includes(lang) ? lang : langs[0];
  const read = current ? reads?.[current] : undefined;

  const isPrimary = lang === project.primary_language;
  const dubbed = (ep.shots ?? []).some((s) => s.include && ((s.dialogue?.[lang]?.length ?? 0) > 0 || !!s.narration?.[lang]));
  const ready = isPrimary ? !!ep.script?.scenes?.some((sc) => sc.lines?.length) : dubbed;

  const start = async () => {
    setBusy(true);
    try {
      await submit(() => api.post<SubmitResult>(`/api/episodes/${ep.id}/table-read`, { language: lang }),
        tr("Table read · {lang}", { lang: LANG_NAMES[lang] ?? lang }));
      setView(lang);
    } finally { setBusy(false); }
  };

  const castName = useMemo(() => new Map((cast ?? []).map((c) => [String(c.id), c.name])), [cast]);
  const nameOf = useCallback((l: TableReadLine) => {
    if (l.character) return l.character;
    if (l.character_id === "NARRATOR" || l.character_id == null) return tr("Narrator");
    return castName.get(String(l.character_id)) ?? tr("Character #{id}", { id: l.character_id });
  }, [castName]);

  return (
    <div>
      <PanelHead title={t("Table read")} description={t("Hear the whole episode in the cast voices before spending on video. Catches pacing and clunky lines for cents.")}
        actions={canEdit && (
          <Button size="sm" variant={read ? "secondary" : "primary"} loading={busy} disabled={!ready || !!runningHere}
            title={ready ? undefined : isPrimary ? t("Write the script first") : t("Translate this language first")}
            icon={read ? <RotateCcw className="size-3.5" /> : <Play className="size-3.5" />} onClick={start}>
            {reads?.[lang] ? t("Re-read in {lang}", { lang: LANG_NAMES[lang] ?? lang }) : t("Read in {lang}", { lang: LANG_NAMES[lang] ?? lang })}
          </Button>
        )} />

      <AnimatePresence initial={false}>
        {running.map((j) => (
          <motion.div key={j.id} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="mb-3 rounded-lg border border-info/30 bg-info/10 p-3">
              <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 truncate text-sky-300">{j.message || j.label}</span>
                <span className="shrink-0 tabular-nums text-mute">{Math.round((j.progress || 0) * 100)}%</span>
              </div>
              <Progress value={j.progress || 0} tone="info" />
            </div>
          </motion.div>
        ))}
      </AnimatePresence>

      {langs.length > 1 && (
        <div className="mb-3">
          <Segmented size="sm" value={current!} onChange={setView} aria-label={t("Language")}
            options={langs.map((l) => ({ value: l, label: LANG_SHORT[l] ?? l, title: LANG_NAMES[l] }))} />
        </div>
      )}

      {!read ? (
        <RoomEmpty icon={<Headphones className="size-7" />} title={t("No table read yet")}
          sub={!isPrimary && !dubbed ? t("This language has no translated lines yet — translate it below, then read it.") : t("Generate one for the working language ({lang}).", { lang: LANG_NAMES[lang] ?? lang })} />
      ) : (
        <Player key={`${current}-${read.at}`} read={read as TableRead} nameOf={nameOf} pid={project.id} />
      )}
    </div>
  );
}

function Player({ read, nameOf, pid }: { read: TableRead; nameOf: (l: TableReadLine) => string; pid: number }) {
  const t = useT();
  const audio = useRef<HTMLAudioElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(read.duration || 0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const lines = read.lines ?? [];
  const names = useMemo(() => lines.map((l) => nameOf(l)), [lines, nameOf]);
  const tone = useCastTones(pid, names);

  // Smooth clock while playing (timeupdate only fires ~4×/s).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = -1;
    const tick = () => {
      const now = audio.current?.currentTime ?? 0;
      if (Math.abs(now - last) > 0.06) { last = now; setTime(now); } // ~15 fps is plenty for the highlight + bar
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => { if (audio.current) audio.current.playbackRate = rate; }, [rate]);

  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].start <= time + 0.01) active = i;
    else break;
  }
  if (active >= 0 && time > lines[active].end + 0.6 && active === lines.length - 1) active = -1;

  useEffect(() => {
    if (active < 0 || !list.current) return;
    const box = list.current;
    const el = box.querySelector<HTMLElement>(`[data-line="${active}"]`);
    if (!el) return;
    const top = el.offsetTop;
    if (top < box.scrollTop + 24 || top + el.offsetHeight > box.scrollTop + box.clientHeight - 24) {
      box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3), behavior: "smooth" });
    }
  }, [active]);

  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => undefined);
    else a.pause();
  };
  const seek = (s: number, play = true) => {
    const a = audio.current;
    if (!a) return;
    a.currentTime = Math.max(0, s);
    setTime(a.currentTime);
    if (play) a.play().catch(() => undefined);
  };
  const total = dur || read.duration || 1;
  const progress = Math.min(1, time / total);
  const sceneStarts = lines.filter((l, i) => i === 0 || l.scene !== lines[i - 1].scene).map((l) => l.start);

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg/40">
      <audio ref={audio} src={read.url} preload="metadata"
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || read.duration)}
        onTimeUpdate={(e) => !playing && setTime(e.currentTarget.currentTime)} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-3 py-2.5">
        <button type="button" onClick={toggle} title={playing ? t("Pause") : t("Play")} aria-label={playing ? t("Pause") : t("Play")}
          className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-[color:var(--on-accent)] shadow-card transition-[transform,box-shadow] hover:scale-105 hover:shadow-glow active:scale-95">
          {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
        </button>
        <div className="min-w-0 flex-1 basis-40">
          <div role="slider" aria-label={t("Seek")} aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(time)} aria-valuetext={`${clock(time)} / ${clock(total)}`} tabIndex={0}
            className="group relative flex h-5 cursor-pointer items-center"
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * total, playing); }}
            onKeyDown={(e) => { if (e.key === "ArrowRight") { e.preventDefault(); seek(time + 5, playing); } if (e.key === "ArrowLeft") { e.preventDefault(); seek(time - 5, playing); } }}>
            <div className="relative h-1.5 w-full rounded-full bg-line transition-[height] group-hover:h-2 group-focus-visible:h-2">
              <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${progress * 100}%` }} />
              {sceneStarts.slice(1).map((s, i) => (
                <span key={i} aria-hidden className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-mute/50" style={{ left: `${(s / total) * 100}%` }} />
              ))}
              <span aria-hidden className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-accent shadow-card transition-transform group-hover:scale-100 group-focus-visible:scale-100"
                style={{ left: `${progress * 100}%` }} />
            </div>
          </div>
          <div className="mono flex justify-between text-2xs text-dim">
            <span>{clock(time)}</span><span>{clock(total)}</span>
          </div>
        </div>
        <Segmented size="sm" value={rate} onChange={setRate} aria-label={t("Playback speed")}
          options={[1, 1.25, 1.5].map((v) => ({ value: v, label: `${v}×` }))} />
        <IconButton title={t("Download audio")} onClick={() => { const a = document.createElement("a"); a.href = read.url; a.download = ""; a.click(); }}><Download className="size-4" /></IconButton>
      </div>

      <div ref={list} className="relative max-h-[min(52vh,26rem)] overflow-y-auto py-1">
        {lines.map((l, i) => {
          const header = i === 0 || l.scene !== lines[i - 1].scene;
          const name = names[i];
          const tn = tone(name);
          const on = i === active;
          return (
            <div key={i}>
              {header && (
                <div className="eyebrow sticky top-0 z-[1] border-y border-line/60 bg-panel/95 px-3.5 py-1.5 backdrop-blur first:border-t-0">
                  {l.scene_title || t("Scene {n}", { n: (Number(l.scene) || 0) + 1 })}
                </div>
              )}
              <button type="button" data-line={i} onClick={() => seek(l.start)}
                className={clsx("relative grid w-full grid-cols-[2.75rem_minmax(0,1fr)] items-baseline gap-x-2 px-3.5 py-2 text-left text-sm transition-colors @md:grid-cols-[2.75rem_7.5rem_minmax(0,1fr)]",
                  on ? "bg-accent/10" : "hover:bg-hover/60")}>
                {on && <motion.span layoutId={`tr-active-${read.at}`} aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-accent" transition={{ duration: 0.15 }} />}
                <span className="mono col-start-1 row-span-2 text-2xs text-dim @md:row-span-1">{clock(l.start)}</span>
                <span className={clsx("col-start-2 truncate text-xs font-semibold uppercase tracking-wide", tn.className)} style={tn.style} title={name}>{name}</span>
                <span className={clsx("col-start-2 leading-snug @md:col-start-3 @md:row-start-1", on ? "text-ink" : "text-mute")}>{l.text}</span>
              </button>
            </div>
          );
        })}
      </div>
      {read.at && <p className="border-t border-line px-3.5 py-1.5 text-2xs text-dim">{t("Recorded {when}", { when: ago(read.at) })} · {t("{n} lines", { n: lines.length })}</p>}
    </div>
  );
}
