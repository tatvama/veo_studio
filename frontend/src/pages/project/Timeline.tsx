import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { AudioWaveform, Captions, Clapperboard, Film, Keyboard, Magnet, Maximize2, Mic, Music, Type, Volume2, ZoomIn, ZoomOut } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useGenerate } from "../../components/Generate";
import { usePeaks, type WaveSeg } from "../../components/review/Waveform";
import { clamp, lsGet, lsSet, shortcutAllowed } from "../../components/review/utils";
import { Button, Card, Empty, IconButton, Kbd, Skeleton, Tooltip } from "../../components/ui";
import { api } from "../../lib/api";
import { secs } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useEpisode, useSettings } from "../../lib/queries";
import type { Episode, Shot, SubmitResult } from "../../lib/types";
import { useProjectCtx } from "./context";
import { LoadError } from "./production/LoadError";
import { AutoSfxDialog, ClipInspector, MixCard, MusicCard, SequencePlayer, ShortcutsDialog } from "./production/timeline/Panels";
import {
  FPS, LABEL_W, MAX_PPS, MIN_PPS, RULER_H, SNAP_PX, TRACK_H, VIDEO_H, layoutClips, mediaUrl, ppsToSlider, sliderToPps, spansOf, type Clip, type Overlay,
} from "./production/timeline/shared";
import {
  LaneItem, OverlayLane, OverlayPopover, PlayheadLine, SnapGuide, TimeRuler, Track, WaveLane, type OverlayEdit,
} from "./production/timeline/Tracks";
import { CutButton, MainClip, TransitionBlock } from "./production/timeline/MainTrack";
import { AddLayerRow, LayerInspector, LayerPlayback, LayerTrackRow, useLayersEditor, type LayerSel } from "./production/timeline/Layers";
import { useTransport } from "./production/timeline/transport";

export default function TimelinePage() {
  const { project, eid, lang, canEdit } = useProjectCtx();
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { generate, submit } = useGenerate();
  const { data: ep, isLoading, isError, refetch } = useEpisode(eid, lang);
  const { data: settingsData } = useSettings();
  const [pps, setPpsState] = useState(() => clamp(Number(lsGet("veo-timeline-pps")) || 18, MIN_PPS, MAX_PPS));
  const [sel, setSel] = useState<number | null>(null);
  const [order, setOrder] = useState<number[]>([]);
  const [musicPrompt, setMusicPrompt] = useState("");
  const [snap, setSnap] = useState(() => lsGet("veo-timeline-snap") !== "0");
  const [view, setView] = useState({ left: 0, width: 900 });
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [ovEdit, setOvEdit] = useState<OverlayEdit | null>(null);
  const [sfxOpen, setSfxOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [showTitles, setShowTitles] = useState(true);
  const [showCC, setShowCC] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | null>(null);

  const shots = useMemo(() => (ep?.shots ?? []).filter((s) => s.include), [ep]);
  useEffect(() => setOrder(shots.map((s) => s.id)), [shots.map((s) => s.id).join(",")]);
  const byId = useMemo(() => Object.fromEntries(shots.map((s) => [s.id, s])) as Record<number, Shot>, [shots]);

  // live edits while dragging (trim edges, transition length); saved on release
  const [trimDraft, setTrimDraft] = useState<{ id: number; trim_in: number; trim_out: number } | null>(null);
  const [trDraft, setTrDraft] = useState<{ id: number; duration: number } | null>(null);
  const clips: Clip[] = useMemo(() => layoutClips(order.map((id) => byId[id]).filter(Boolean), trimDraft, trDraft), [order, byId, trimDraft, trDraft]);
  const total = clips.length ? clips[clips.length - 1].start + clips[clips.length - 1].duration : 0;
  const { layers, edit: editLayers, upload: uploadMedia, saving: layersSaving } = useLayersEditor(eid);
  const [layerSel, setLayerSel] = useState<LayerSel>(null);
  const music = ep?.music?.find((m) => m.selected) ?? ep?.music?.[0];
  const settings = ep?.settings ?? {};
  const tp = useTransport(clips, total);

  // waveforms: decoded in the browser (the API stores peaks only for finished renders)
  const peaks = usePeaks([
    ...clips.map((c) => c.shot.voice?.url ?? ""), ...clips.map((c) => c.shot.narration_take?.url ?? ""),
    ...clips.map((c) => mediaUrl(c.shot.sfx_track?.path)), music?.url ?? "",
  ]);
  const voiceSegs = useMemo(() => clips.flatMap((c): WaveSeg[] => {
    const d = c.shot.voice?.url ? peaks[c.shot.voice.url] : null;
    return d ? [{ start: c.start, dur: Math.min(d.duration, c.duration), data: d }] : [];
  }), [clips, peaks]);
  const narrSegs = useMemo(() => clips.flatMap((c): WaveSeg[] => {
    const d = c.shot.narration_take?.url ? peaks[c.shot.narration_take.url] : null;
    return d ? [{ start: c.start, dur: Math.min(d.duration, c.duration), data: d }] : [];
  }), [clips, peaks]);
  const sfxSegs = useMemo(() => clips.flatMap((c): WaveSeg[] => {
    const d = peaks[mediaUrl(c.shot.sfx_track?.path)];
    const off = c.shot.sfx_track?.start ?? 0;
    return d ? [{ start: c.start + off, dur: Math.max(0, Math.min(d.duration, c.duration - off)), data: d }] : [];
  }), [clips, peaks]);
  const musicSegs = useMemo((): WaveSeg[] => {
    const d = music?.url ? peaks[music.url] : null;
    return d ? [{ start: 0, dur: total, data: d, loop: true }] : [];
  }, [music?.url, peaks, total]);

  // zoom (anchored so the time under the cursor / playhead stays put)
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  const zoomTo = (next: number, anchorX?: number) => {
    const el = scrollRef.current;
    const n = clamp(next, MIN_PPS, MAX_PPS);
    if (Math.abs(n - ppsRef.current) < 1e-3) return;
    if (el) {
      const playX = LABEL_W + tp.clock.get() * ppsRef.current - el.scrollLeft;
      const x = anchorX ?? (playX > LABEL_W && playX < el.clientWidth ? playX : (el.clientWidth + LABEL_W) / 2);
      const tAt = (el.scrollLeft + x - LABEL_W) / ppsRef.current;
      pendingScroll.current = Math.max(0, tAt * n + LABEL_W - x);
    }
    setPpsState(n);
    lsSet("veo-timeline-pps", String(Math.round(n * 100) / 100));
  };
  useLayoutEffect(() => {
    if (pendingScroll.current !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
  }, [pps]);
  const fit = () => zoomTo((view.width - LABEL_W - 32) / Math.max(total, 1), LABEL_W);

  const mounted = !isLoading && !!ep && shots.length > 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const upd = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setView({ left: el.scrollLeft, width: el.clientWidth }));
    };
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomTo(ppsRef.current * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left);
    };
    el.addEventListener("scroll", upd, { passive: true });
    el.addEventListener("wheel", wheel, { passive: false });
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    upd();
    return () => {
      el.removeEventListener("scroll", upd);
      el.removeEventListener("wheel", wheel);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [mounted]);

  // keep the playhead in view while playing; selection follows the playing clip
  useEffect(() => {
    if (!tp.playing) return;
    return tp.clock.subscribe(() => {
      const el = scrollRef.current;
      if (!el) return;
      const x = LABEL_W + tp.clock.get() * ppsRef.current;
      if (x > el.scrollLeft + el.clientWidth - 24 || x < el.scrollLeft + LABEL_W) el.scrollLeft = Math.max(0, x - LABEL_W - 48);
    });
  }, [tp.playing, tp.clock]);
  useEffect(() => {
    if (tp.playing && clips[tp.idx]) setSel(clips[tp.idx].shot.id);
  }, [tp.idx, tp.playing]);

  // snapping to shot boundaries and layer clips (and the playhead when dragging other things)
  const boundaries = useMemo(() => [0, ...clips.flatMap((c) => [c.start, c.start + c.duration]),
    ...[...(layers?.video ?? []), ...(layers?.audio ?? [])].flatMap((tk) => tk.clips.flatMap((c) => [c.start, c.start + c.dur]))], [clips, layers]);
  const snapTime = (x: number, withPlayhead = false): number => {
    if (!snap) return x;
    let best = x;
    let bd = SNAP_PX / pps;
    for (const b of boundaries) {
      const d = Math.abs(b - x);
      if (d < bd) { bd = d; best = b; }
    }
    if (withPlayhead) {
      const p = tp.clock.get();
      if (Math.abs(p - x) < bd) best = p;
    }
    return best;
  };
  const toggleSnap = () => setSnap((s) => { lsSet("veo-timeline-snap", s ? "0" : "1"); return !s; });

  // keyboard
  const keyRef = useRef({ tp, zoomTo, fit, toggleSnap, total, setSel, ovEdit });
  keyRef.current = { tp, zoomTo, fit, toggleSnap, total, setSel, ovEdit };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!shortcutAllowed(e)) return;
      const k = keyRef.current;
      if (k.ovEdit) return;
      const key = e.key;
      const map: Record<string, () => void> = {
        " ": () => { if (!e.repeat) k.tp.toggle(); },
        j: () => k.tp.shuttle(-1), J: () => k.tp.shuttle(-1),
        k: () => k.tp.pause(), K: () => k.tp.pause(),
        l: () => k.tp.shuttle(1), L: () => k.tp.shuttle(1),
        ArrowLeft: () => k.tp.step(e.shiftKey ? -FPS : -1),
        ArrowRight: () => k.tp.step(e.shiftKey ? FPS : 1),
        ArrowUp: () => k.tp.jump(-1),
        ArrowDown: () => k.tp.jump(1),
        Home: () => k.tp.seek(0),
        End: () => k.tp.seek(k.total),
        "=": () => k.zoomTo(ppsRef.current * 1.25), "+": () => k.zoomTo(ppsRef.current * 1.25),
        "-": () => k.zoomTo(ppsRef.current / 1.25), _: () => k.zoomTo(ppsRef.current / 1.25),
        "\\": () => k.fit(),
        s: () => k.toggleSnap(), S: () => k.toggleSnap(),
        Escape: () => k.setSel(null),
      };
      const fn = map[key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const next = arrayMove(order, order.indexOf(Number(e.active.id)), order.indexOf(Number(e.over.id)));
    setOrder(next);
    try {
      await api.post(`/api/episodes/${eid}/shots/reorder`, { shot_ids: next });
      toast.success(t("Order saved"));
    } catch {
      /* toast shown by the api client */
    } finally {
      qc.invalidateQueries({ queryKey: ["episode", eid] });
    }
  };
  const patchSettings = async (s: Record<string, any>) => {
    try {
      await api.patch(`/api/episodes/${eid}`, { settings: s });
      toast.success(t("Mix updated"), { id: "mix-updated" });
    } catch {
      /* toast shown by the api client */
    }
    qc.invalidateQueries({ queryKey: ["episode", eid] });
  };
  // music volume: move locally while dragging, save once it settles
  const [volDraft, setVolDraft] = useState<number | null>(null);
  const volTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (volTimer.current) clearTimeout(volTimer.current); }, []);
  const onVolume = (v: number) => {
    setVolDraft(v);
    if (volTimer.current) clearTimeout(volTimer.current);
    volTimer.current = setTimeout(async () => {
      await patchSettings({ music_volume_db: v });
      setVolDraft(null);
    }, 350);
  };

  const saveOverlays = async (shot: Shot, list: Overlay[]) => {
    const clean = list.filter((o) => o.text.trim()).map((o) => ({ ...o, text: o.text.trim().slice(0, 120) }));
    qc.setQueryData<Episode>(["episode", eid, lang], (old) => old && {
      ...old, shots: old.shots?.map((s) => (s.id === shot.id ? { ...s, overlays: clean } : s)),
    });
    try {
      await api.put(`/api/shots/${shot.id}/overlays`, { overlays: clean });
      toast.success(t("Overlays saved"));
    } finally {
      qc.invalidateQueries({ queryKey: ["episode", eid] });
    }
  };

  const elevenMode = settingsData?.providers.find((p) => p.provider === "elevenlabs")?.mode;
  const runSfx = async (ids: number[] | null) =>
    submit(() => api.post<SubmitResult>(`/api/episodes/${eid}/sfx`, { shot_ids: ids }), t("Sound design"));
  const autoSfx = () => {
    if (elevenMode === "mock") void runSfx(null);
    else setSfxOpen(true);
  };

  if (isError && !ep) return <LoadError what={t("the timeline")} onRetry={() => void refetch()} />;
  if (isLoading || !ep) return <TimelineSkeleton />;
  if (!shots.length) {
    return (
      <div className="p-6">
        <Empty icon={<Clapperboard className="size-8" />} title={t("Nothing on the timeline yet")} sub={t("Plan shots and generate keyframes or videos first.")}
          action={<Button variant="primary" onClick={() => navigate(`/p/${project.id}/storyboard`)}>{t("Go to Storyboard")}</Button>} />
      </div>
    );
  }
  const saveTrim = async (shot: Shot, trim_in: number, trim_out: number) => {
    try {
      await api.patch(`/api/shots/${shot.id}`, { trim_in, trim_out });
      toast.success(t("{code} trimmed", { code: shot.code }), { id: "trim" });
    } catch { /* api toasts */ }
    await qc.invalidateQueries({ queryKey: ["episode", eid] });
    setTrimDraft(null);
  };
  const saveTransition = async (shot: Shot, duration: number | null) => {
    const fx = { ...(shot.fx ?? {}) };
    if (duration == null) delete fx.transition;
    else fx.transition = { type: fx.transition?.type ?? "fade", duration };
    try { await api.put(`/api/shots/${shot.id}/fx`, { fx }); } catch { /* api toasts */ }
    await qc.invalidateQueries({ queryKey: ["episode", eid] });
    setTrDraft(null);
  };
  const selShot = sel ? byId[sel] : null;
  const selClip = clips.find((c) => c.shot.id === sel) ?? null;
  const contentW = Math.max(total * pps + LABEL_W + 96, view.width);
  const lane = { view, pps };
  const dialogueCount = clips.reduce((a, c) => a + (spansOf(c.shot).length || (c.shot.dialogue?.[lang]?.length ? 1 : 0)), 0);
  const narrationCount = clips.filter((c) => c.shot.narration?.[lang]).length;
  const sfxCount = clips.filter((c) => c.shot.sfx_track?.path || c.shot.sfx).length;
  const titleCount = clips.reduce((a, c) => a + (c.shot.overlays?.length ?? 0), 0);
  const captionCount = clips.reduce((a, c) => a + spansOf(c.shot).length, 0);
  const musicDb = volDraft ?? settings.music_volume_db ?? -16;

  return (
    <div className="@container h-full overflow-y-auto overscroll-contain">
      <div className="flex min-h-full flex-col gap-3 p-3 sm:p-4">
        {/* preview + inspector: takes the height the timeline leaves free (at least 340px) */}
        <div className="grid min-h-[340px] flex-1 gap-3 @3xl:grid-cols-[minmax(0,1fr)_minmax(280px,340px)] @3xl:grid-rows-[minmax(0,1fr)]">
          <SequencePlayer tp={tp} clips={clips} musicUrl={music?.url} musicDb={musicDb} aspect={project.aspect}
            lang={lang} showTitles={showTitles} setShowTitles={setShowTitles} showCC={showCC} setShowCC={setShowCC} total={total}
            overlay={<LayerPlayback tp={tp} doc={layers} />} />
          <div className="flex min-h-0 flex-col gap-3 @3xl:overflow-y-auto @3xl:pr-0.5">
            {layerSel && layers && (
              <LayerInspector doc={layers} sel={layerSel} canEdit={canEdit} edit={editLayers} onClose={() => setLayerSel(null)} onSeek={(s) => tp.seek(s)} />
            )}
            <AnimatePresence initial={false}>
              {!layerSel && selShot && selClip && (
                <motion.div key={selShot.id} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }} className="-m-px shrink-0 overflow-hidden p-px">
                  <ClipInspector shot={selShot} clip={selClip} canEdit={canEdit} onClose={() => setSel(null)} onSeek={() => tp.seek(selClip.start)} />
                </motion.div>
              )}
            </AnimatePresence>
            <MixCard lang={lang} db={musicDb} duck={settings.duck !== false} canEdit={canEdit} onVolume={onVolume} onDuck={(v) => patchSettings({ duck: v })} />
            <MusicCard music={ep.music ?? []} canEdit={canEdit} prompt={musicPrompt} setPrompt={setMusicPrompt} eid={eid}
              onCompose={() => generate(eid, { action: "music", prompt: musicPrompt }, t("Music"))} />
          </div>
        </div>

        {/* ── timeline ──────────────────────────────────────────────────────── */}
        <Card className="@container shrink-0 overflow-hidden">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-3 py-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="grid size-6 place-items-center rounded-md bg-raised text-mute"><Film className="size-3.5" /></span>
              <span className="font-semibold">{t("{n} clips", { n: shots.length })}</span>
              <span className="tabular-nums text-mute">· {secs(total)}</span>
            </div>
            <p className="hidden items-center gap-x-2 gap-y-1 text-2xs text-dim @4xl:flex">
              <span className="inline-flex items-center gap-1"><Kbd>Space</Kbd>{t("play")}</span>
              <span className="inline-flex items-center gap-1"><Kbd>J</Kbd><Kbd>K</Kbd><Kbd>L</Kbd>{t("shuttle")}</span>
              <span className="inline-flex items-center gap-1"><Kbd>S</Kbd>{t("snap")}</span>
              <span className="inline-flex items-center gap-1"><Kbd>\</Kbd>{t("fit")}</span>
            </p>
            <div className="flex-1" />
            {canEdit && (
              <Tooltip content={t("Plan and generate ambience and spot effects for every shot")}>
                <Button size="sm" variant="outline" icon={<AudioWaveform className="size-3.5" />} onClick={autoSfx}>{t("Auto SFX")}</Button>
              </Tooltip>
            )}
            <Tooltip content={snap ? t("Snapping on (S)") : t("Snapping off (S)")}>
              <button type="button" aria-pressed={snap} onClick={toggleSnap}
                className={clsx("inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors",
                  snap ? "border-accent/40 bg-accent/12 text-accent-ink" : "border-line text-mute hover:bg-hover hover:text-ink")}>
                <Magnet className="size-3.5" />{t("Snap")}
              </button>
            </Tooltip>
            <div className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-raised/60 p-0.5" role="group" aria-label={t("Zoom")}>
              <IconButton title={t("Zoom out (−)")} onClick={() => zoomTo(pps / 1.25)} className="!size-7"><ZoomOut className="size-4" /></IconButton>
              <input type="range" min={0} max={100} step={0.5} value={ppsToSlider(pps)} aria-label={t("Zoom")}
                onChange={(e) => zoomTo(sliderToPps(Number(e.target.value)))} className="mx-1 w-20 @2xl:w-28" />
              <IconButton title={t("Zoom in (+ / Ctrl+wheel)")} onClick={() => zoomTo(pps * 1.25)} className="!size-7"><ZoomIn className="size-4" /></IconButton>
              <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />
              <IconButton title={t("Fit to window (\\)")} onClick={fit} className="!size-7"><Maximize2 className="size-4" /></IconButton>
            </div>
            <IconButton title={t("Keyboard shortcuts")} onClick={() => setKeysOpen(true)}><Keyboard className="size-4" /></IconButton>
          </div>

          <div ref={scrollRef} className="overflow-x-auto">
            <div className="relative" style={{ width: contentW }}>
              <TimeRuler total={total} pps={pps} view={view} clock={tp.clock}
                onScrub={(x, phase) => {
                  const s = snapTime(x);
                  setSnapLine(phase !== "end" && s !== x ? s : null);
                  if (phase !== "end") tp.seek(s);
                }} />
              {layers && [...layers.video].reverse().map((tk, i) => (
                <LayerTrackRow key={tk.id} kind="video" track={tk} index={i} doc={layers} pps={pps} view={view} canEdit={canEdit} sel={layerSel}
                  onSelect={(s) => { setLayerSel(s); setSel(null); }} edit={editLayers} upload={uploadMedia} playhead={() => tp.clock.get()} snapTime={(x) => snapTime(x, true)} />
              ))}
              <Track icon={<Film />} label={t("Video")} count={clips.length} height={VIDEO_H}>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                  <SortableContext items={order} strategy={horizontalListSortingStrategy}>
                    <div className="group/track relative h-full">
                      {clips.map((c) => (
                        <MainClip key={c.shot.id} clip={c} pps={pps} selected={sel === c.shot.id} canEdit={canEdit}
                          onClick={() => { setSel(c.shot.id); setLayerSel(null); }} onDoubleClick={() => tp.seek(c.start)}
                          onTrim={(ti, to) => setTrimDraft({ id: c.shot.id, trim_in: ti, trim_out: to })}
                          onTrimEnd={(ti, to) => void saveTrim(c.shot, ti, to)} />
                      ))}
                      {clips.map((c) => (
                        <TransitionBlock key={`tr-${c.shot.id}`} clip={c} pps={pps} canEdit={canEdit} onClick={() => { setSel(c.shot.id); setLayerSel(null); }}
                          onResize={(d) => setTrDraft({ id: c.shot.id, duration: d })} onResizeEnd={(d) => void saveTransition(c.shot, d)} />
                      ))}
                      {canEdit && clips.slice(1).filter((c) => !c.shot.fx?.transition).map((c) => (
                        <CutButton key={`cut-${c.shot.id}`} clip={c} pps={pps} onAdd={() => void saveTransition(c.shot, 0.5)} />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </Track>
              <Track icon={<Mic />} label={t("Dialogue")} tone="ok" count={dialogueCount || undefined} stripe>
                <WaveLane segs={voiceSegs} {...lane} className="text-ok opacity-60" />
                {clips.map((c) => {
                  const spans = spansOf(c.shot);
                  const lines = c.shot.dialogue?.[lang] ?? [];
                  return spans.length ? spans.map((sp, i) => (
                    <LaneItem key={`${c.shot.id}-${i}`} tone="ok" pill left={(c.start + sp.start) * pps} width={Math.max((sp.end - sp.start) * pps, 4)} title={sp.text}>{sp.text}</LaneItem>
                  )) : lines.length ? (
                    <LaneItem key={c.shot.id} tone="ok" dashed left={c.start * pps} width={Math.max(c.duration * pps - 3, 4)} title={t("Not voiced yet")}>
                      {lines.map((l) => l.line).join(" / ")}
                    </LaneItem>
                  ) : null;
                })}
              </Track>
              <Track icon={<Volume2 />} label={t("Narration")} tone="info" count={narrationCount || undefined}>
                <WaveLane segs={narrSegs} {...lane} className="text-info opacity-60" />
                {clips.filter((c) => c.shot.narration?.[lang]).map((c) => (
                  <LaneItem key={c.shot.id} tone="info" pill dashed={!c.shot.narration_take} left={c.start * pps}
                    width={Math.max(Math.min((c.shot.narration_take?.duration_s || c.duration) * pps, c.duration * pps), 4)} title={c.shot.narration[lang]}>
                    {c.shot.narration[lang]}
                  </LaneItem>
                ))}
              </Track>
              <Track icon={<Music />} label={t("Music")} tone="accent" count={music ? 1 : undefined} stripe>
                <WaveLane segs={musicSegs} {...lane} className="text-accent-ink opacity-50" />
                {music ? (
                  <LaneItem tone="accent" pill left={0} width={total * pps}>
                    ♪ {music.prompt.slice(0, 80)} · {settings.music_volume_db ?? -16} dB{settings.duck !== false ? ` · ${t("ducked")}` : ""}
                  </LaneItem>
                ) : <span className="sticky left-[140px] inline-block px-2 text-2xs leading-[38px] text-dim">{t("No music yet")}</span>}
              </Track>
              <Track icon={<AudioWaveform />} label={t("SFX")} tone="warn" count={sfxCount || undefined}>
                <WaveLane segs={sfxSegs} {...lane} className="text-warn opacity-60" />
                {clips.map((c) => {
                  const fx = c.shot.sfx_track;
                  if (fx?.path) {
                    const off = fx.start ?? 0;
                    const d = peaks[mediaUrl(fx.path)];
                    const w = Math.max(0, Math.min(d?.duration ?? c.duration - off, c.duration - off));
                    return (
                      <LaneItem key={c.shot.id} tone="warn" pill left={(c.start + off) * pps} width={Math.max(w * pps, 4)}
                        title={`${fx.prompt ?? ""}${fx.volume_db != null ? ` · ${fx.volume_db} dB` : ""}`}>{fx.prompt}</LaneItem>
                    );
                  }
                  return c.shot.sfx ? (
                    <LaneItem key={c.shot.id} tone="warn" dashed left={c.start * pps} width={Math.max(c.duration * pps - 3, 4)} title={t("Written cue — not generated yet")}>{c.shot.sfx}</LaneItem>
                  ) : null;
                })}
              </Track>
              {layers && layers.audio.map((tk, i) => (
                <LayerTrackRow key={tk.id} kind="audio" track={tk} index={i} doc={layers} pps={pps} view={view} canEdit={canEdit} sel={layerSel}
                  onSelect={(s) => { setLayerSel(s); setSel(null); }} edit={editLayers} upload={uploadMedia} playhead={() => tp.clock.get()} snapTime={(x) => snapTime(x, true)} />
              ))}
              <Track icon={<Type />} label={t("Titles")} tone="gold" count={titleCount || undefined} stripe>
                <OverlayLane clips={clips} pps={pps} canEdit={canEdit} snapTime={snapTime} setSnapLine={setSnapLine}
                  onOpen={(e) => setOvEdit(e)} onCommit={(shot, list) => { saveOverlays(shot, list).catch(() => {}); }} />
              </Track>
              <Track icon={<Captions />} label={t("Captions")} count={captionCount || undefined}>
                {clips.map((c) => spansOf(c.shot).map((sp, i) => (
                  <LaneItem key={`${c.shot.id}-${i}`} tone="mute" left={(c.start + sp.start) * pps} width={Math.max((sp.end - sp.start) * pps, 4)} title={sp.text}>{sp.text}</LaneItem>
                )))}
              </Track>
              <AddLayerRow canEdit={canEdit} edit={editLayers} saving={layersSaving} />
              {snapLine !== null && <SnapGuide time={snapLine} pps={pps} />}
              <PlayheadLine clock={tp.clock} pps={pps} viewLeft={view.left} />
            </div>
          </div>
        </Card>
      </div>

      <AnimatePresence>
        {ovEdit && (
          <OverlayPopover key={`${ovEdit.shot.id}-${ovEdit.index ?? "new"}`} edit={ovEdit} onClose={() => setOvEdit(null)}
            onSave={async (list) => { await saveOverlays(ovEdit.shot, list); setOvEdit(null); }} />
        )}
      </AnimatePresence>
      <AutoSfxDialog open={sfxOpen} onClose={() => setSfxOpen(false)} clips={clips} selected={selShot} mode={elevenMode} run={runSfx} />
      <ShortcutsDialog open={keysOpen} onClose={() => setKeysOpen(false)} />
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden p-4" aria-busy="true">
      <div className="grid min-h-[300px] flex-1 grid-rows-[minmax(0,1fr)] gap-3 md:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel">
          <Skeleton className="flex-1 rounded-none" />
          <div className="flex items-center justify-center gap-2 border-t border-line p-3"><Skeleton className="size-8" /><Skeleton className="size-8" /><Skeleton className="size-9 rounded-full" /><Skeleton className="size-8" /><Skeleton className="size-8" /></div>
        </div>
        <div className="hidden space-y-3 md:block"><Skeleton className="h-28 rounded-xl" /><Skeleton className="h-44 rounded-xl" /></div>
      </div>
      <div className="shrink-0 overflow-hidden rounded-xl border border-line bg-panel">
        <div className="flex items-center gap-3 border-b border-line p-2.5"><Skeleton className="h-6 w-32" /><div className="flex-1" /><Skeleton className="h-8 w-24" /><Skeleton className="h-8 w-40" /></div>
        <Skeleton className="rounded-none" style={{ height: RULER_H }} />
        {[VIDEO_H, TRACK_H, TRACK_H, TRACK_H].map((h, i) => (
          <div key={i} className="flex border-t border-line/60" style={{ height: h }}><div className="border-r border-line bg-panel" style={{ width: LABEL_W }} /><Skeleton className="m-1 flex-1" /></div>
        ))}
      </div>
    </div>
  );
}
