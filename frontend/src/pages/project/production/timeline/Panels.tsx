import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  AudioWaveform, Captions, Check, Coins, Music, Pause, Play, Rewind, SkipBack, SkipForward, SlidersHorizontal, Sparkles, StepBack, StepForward, Type, X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatTC, useClock, type Clock } from "../../../../components/review/utils";
import { AnimatedNumber, Badge, Button, Card, Field, IconButton, Input, Kbd, Modal, Toggle, Tooltip } from "../../../../components/ui";
import { api } from "../../../../lib/api";
import { LANG_NAMES, usd } from "../../../../lib/format";
import { fxFilter, fxTransform } from "../../../../lib/fx";
import { useT } from "../../../../lib/i18n";
import type { AudioAsset, Shot, SubmitResult } from "../../../../lib/types";
import { ratioOf } from "../shotMeta";
import { FPS, SFX_USD_PER_SHOT, spansOf, type Clip } from "./shared";
import type { Transport } from "./transport";
import { BlendLayer } from "./Blend";

// ── preview ──────────────────────────────────────────────────────────────────

/** Titles, lower thirds and captions drawn over the preview at the playhead. Sizes follow the frame (cqw), not the window. */
function PreviewOverlays({ clock, clip, showTitles, showCC }: { clock: Clock; clip?: Clip; showTitles: boolean; showCC: boolean }) {
  const now = useClock(clock);
  if (!clip) return null;
  const rel = now - clip.start;
  const ovs = showTitles ? (clip.shot.overlays ?? []).filter((o) => o.text && rel >= o.start && rel < (o.end || clip.duration)) : [];
  const cap = showCC ? spansOf(clip.shot).find((sp) => rel >= sp.start && rel < sp.end) : undefined;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <AnimatePresence>
        {ovs.map((o) => o.kind === "lower_third" ? (
          <motion.div key={`lt-${o.text}-${o.start}`} initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }}
            transition={{ duration: 0.2 }}
            className="absolute bottom-[16%] left-[5%] max-w-[80%] border-l-4 border-accent bg-black/70 px-[3cqw] py-[1.5cqw] text-[clamp(9px,4.6cqw,20px)] font-semibold text-white">
            {o.text}
          </motion.div>
        ) : (
          <motion.div key={`ti-${o.text}-${o.start}`} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="absolute inset-x-[6%] top-1/2 -translate-y-1/2 text-center text-[clamp(11px,7cqw,44px)] font-bold leading-tight text-white [text-shadow:0_2px_12px_rgb(0_0_0/0.8)]">
            {o.text}
          </motion.div>
        ))}
      </AnimatePresence>
      {cap && (
        <div className="absolute inset-x-0 bottom-[5%] flex justify-center px-[6%]">
          <span className="rounded bg-black/75 px-[2cqw] py-[0.6cqw] text-center text-[clamp(9px,4cqw,18px)] font-medium text-white">{cap.text}</span>
        </div>
      )}
    </div>
  );
}

/** Live width / height of an element (ResizeObserver). */
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = (w: number, h: number) => setSize((s) => (Math.abs(s.w - w) < 0.5 && Math.abs(s.h - h) < 0.5 ? s : { w, h }));
    const ro = new ResizeObserver(([e]) => set(e.contentRect.width, e.contentRect.height));
    ro.observe(el);
    set(el.clientWidth, el.clientHeight);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

function PlayheadText({ clock }: { clock: Clock }) {
  const v = useClock(clock);
  return <>{formatTC(v, FPS)}</>;
}

export function SequencePlayer({ tp, clips, musicUrl, musicDb, aspect, showTitles, setShowTitles, showCC, setShowCC, total, overlay }: {
  tp: Transport; clips: Clip[]; musicUrl?: string; musicDb: number; aspect: string; lang: string; total: number;
  /** extra layers drawn over the picture (video layers, synced sounds) */
  overlay?: React.ReactNode;
  showTitles: boolean; setShowTitles: (v: boolean) => void; showCC: boolean; setShowCC: (v: boolean) => void;
}) {
  const t = useT();
  const clip = clips[tp.idx];
  const hasVideo = !!clip?.src && !tp.broken.has(clip.shot.id);
  const r = ratioOf(aspect);
  // the frame is the largest box with the project's aspect that fits the stage (measured, so it also follows layout changes)
  const [stageRef, box] = useElementSize<HTMLDivElement>();
  const frameW = Math.max(0, Math.min(box.w, box.h * (r.w / r.h)));
  const frameH = frameW * (r.h / r.w);
  const mainRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const m = tp.mref.current;
    if (m) m.volume = Math.min(1, Math.pow(10, musicDb / 20) * 2.5);
  }, [musicDb, musicUrl]);

  return (
    <Card className="@container flex min-h-[min(72vh,460px)] flex-col overflow-hidden @3xl:min-h-0">
      {/* the stage fills whatever height the layout gives it; the frame inside always keeps the project's aspect ratio */}
      <div ref={stageRef} className="relative min-h-[200px] flex-1 cursor-pointer bg-black" onClick={tp.toggle} role="presentation">
        <div ref={frameRef} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden bg-black shadow-[0_0_0_1px_rgb(255_255_255/0.08)] [container-type:inline-size]"
          style={{ width: frameW, height: frameH }}>
          {/* the playing shot; during a transition the blend layer shows the other one and both animate */}
          <div ref={mainRef} className="absolute inset-0">
          {hasVideo ? (
            <video ref={tp.vref} src={clip.src} playsInline preload="auto" className="h-full w-full object-contain"
              style={{ filter: fxFilter(clip.shot.fx, 0.6) || undefined, transform: fxTransform(clip.shot.fx) || undefined }}
              onLoadedMetadata={tp.onVideoMeta} onError={() => tp.onVideoError(clip.shot.id)} />
          ) : clip?.still ? (
            <img src={clip.still} alt="" className="h-full w-full object-contain" style={{ filter: fxFilter(clip.shot.fx, 0.6) || undefined, transform: fxTransform(clip.shot.fx) || undefined }} />
          ) : <div className="flex h-full items-center justify-center p-3 text-center text-sm text-white/60">{t("No media for {code}", { code: clip?.shot.code ?? "" })}</div>}
          </div>
          <BlendLayer tp={tp} clips={clips} mainRef={mainRef} frameRef={frameRef} />
          {overlay}
          <PreviewOverlays clock={tp.clock} clip={clip} showTitles={showTitles} showCC={showCC} />
          <AnimatePresence>
            {!tp.playing && (
              <motion.span key="hint" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.15 }} transition={{ duration: 0.16 }}
                className="pointer-events-none absolute left-1/2 top-1/2 grid size-12 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white backdrop-blur-md">
                <Play className="size-5 translate-x-px" fill="currentColor" />
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>
      {musicUrl && <audio ref={tp.mref} src={musicUrl} loop preload="auto" onLoadedMetadata={tp.placeMusic} />}

      <div className="grid shrink-0 grid-cols-2 items-center gap-x-3 gap-y-1.5 border-t border-line bg-panel px-3 py-2 @xl:grid-cols-[1fr_auto_1fr]">
        <div className="order-1 flex min-w-0 items-baseline gap-1.5 font-mono tabular-nums">
          <span className="text-sm font-semibold"><PlayheadText clock={tp.clock} /></span>
          <span className="text-2xs text-dim">/ {formatTC(total, FPS)}</span>
          <AnimatePresence>
            {tp.playing && tp.rate !== 1 && (
              <motion.span key={tp.rate} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                className="ml-1 inline-flex items-center gap-0.5 self-center rounded bg-accent/15 px-1.5 py-0.5 text-2xs font-semibold text-accent-ink">
                {tp.rate < 0 && <Rewind className="size-3" fill="currentColor" />}{Math.abs(tp.rate)}×
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <div className="order-3 col-span-2 flex items-center justify-center gap-1 @xl:order-2 @xl:col-span-1">
          <IconButton title={t("Previous cut (↑)")} onClick={() => tp.jump(-1)}><SkipBack className="size-4" /></IconButton>
          <IconButton title={t("Previous frame (←)")} onClick={() => tp.step(-1)}><StepBack className="size-4" /></IconButton>
          <Tooltip content={tp.playing ? t("Pause") : t("Play sequence")} shortcut={<Kbd>Space</Kbd>}>
            <button type="button" onClick={tp.toggle} aria-label={tp.playing ? t("Pause") : t("Play sequence")}
              className="btn-primary mx-1 grid size-9 place-items-center rounded-full text-black transition-transform active:scale-95">
              {tp.playing ? <Pause className="size-4" fill="currentColor" /> : <Play className="size-4 translate-x-px" fill="currentColor" />}
            </button>
          </Tooltip>
          <IconButton title={t("Next frame (→)")} onClick={() => tp.step(1)}><StepForward className="size-4" /></IconButton>
          <IconButton title={t("Next cut (↓)")} onClick={() => tp.jump(1)}><SkipForward className="size-4" /></IconButton>
        </div>
        <div className="order-2 flex min-w-0 items-center justify-end gap-1 @xl:order-3">
          <span className="mr-1 min-w-0 truncate text-xs text-mute">{clip?.shot.code} · {tp.idx + 1}/{clips.length} · {t(clip?.kind ?? "")}</span>
          <IconButton title={t("Show titles & lower thirds")} active={showTitles} aria-pressed={showTitles} onClick={() => setShowTitles(!showTitles)}><Type className="size-4" /></IconButton>
          <IconButton title={t("Show captions")} active={showCC} aria-pressed={showCC} onClick={() => setShowCC(!showCC)}><Captions className="size-4" /></IconButton>
        </div>
      </div>
      <p className="hidden shrink-0 border-t border-line/60 bg-raised/30 px-3 py-1 text-2xs text-dim @2xl:block">{t("Quick preview. For the exact mix, render an animatic or export.")}</p>
    </Card>
  );
}

// ── side panels ──────────────────────────────────────────────────────────────

export function MixCard({ lang, db, duck, canEdit, onVolume, onDuck }: {
  lang: string; db: number; duck: boolean; canEdit: boolean; onVolume: (v: number) => void; onDuck: (v: boolean) => void;
}) {
  const t = useT();
  return (
    <Card className="p-3.5">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <span className="grid size-6 place-items-center rounded-md bg-accent/12 text-accent-ink"><SlidersHorizontal className="size-3.5" /></span>
        {t("Mix")} <Badge>{LANG_NAMES[lang] ?? lang}</Badge>
      </h3>
      <Field label={t("Music volume: {db} dB", { db })}>
        <input type="range" min={-30} max={-4} value={db} disabled={!canEdit} onChange={(e) => onVolume(Number(e.target.value))} className="w-full" />
      </Field>
      <div className="mt-3">
        <Toggle checked={duck} disabled={!canEdit} onChange={onDuck} label={<span className="text-sm">{t("Lower music under voices (ducking)")}</span>} />
      </div>
      <p className="mt-3 text-2xs leading-snug text-dim">{t("Final loudness is normalised to −14 LUFS for YouTube / Instagram.")}</p>
    </Card>
  );
}

function MusicRow({ m, canEdit, selecting, onUse }: { m: AudioAsset; canEdit: boolean; selecting: boolean; onUse: () => void }) {
  const t = useT();
  const a = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [p, setP] = useState(0);
  const toggle = () => {
    const el = a.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {}); else el.pause();
  };
  return (
    <li className={clsx("flex items-center gap-2.5 rounded-lg border p-2 transition-colors", m.selected ? "border-accent/50 bg-accent/5" : "border-line hover:border-dim/40")}>
      <button type="button" onClick={toggle} aria-label={playing ? t("Pause") : t("Play")}
        className="grid size-8 shrink-0 place-items-center rounded-full bg-raised text-ink transition-colors hover:bg-accent hover:text-black">
        {playing ? <Pause className="size-3.5" fill="currentColor" /> : <Play className="size-3.5 translate-x-px" fill="currentColor" />}
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" title={m.prompt}>{m.prompt || t("Music")}</p>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line"><div className="h-full origin-left rounded-full bg-accent transition-transform duration-200" style={{ transform: `scaleX(${p})` }} /></div>
      </div>
      {m.selected ? <Badge tone="accent">{t("in use")}</Badge> : canEdit && (
        <Button size="sm" variant="ghost" icon={<Check className="size-3" />} loading={selecting} onClick={onUse}>{t("Use")}</Button>
      )}
      <audio ref={a} src={m.url} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setP(0); }}
        onTimeUpdate={(e) => setP(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration : 0)} />
    </li>
  );
}

export function MusicCard({ music, canEdit, prompt, setPrompt, onCompose, eid }: {
  music: AudioAsset[]; canEdit: boolean; prompt: string; setPrompt: (v: string) => void; onCompose: () => void; eid: number;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [selecting, setSelecting] = useState<number | null>(null);
  const use = async (m: AudioAsset) => {
    setSelecting(m.id);
    try {
      await api.post(`/api/audio/${m.id}/select`);
      toast.success(t("Music track selected"));
    } catch {
      /* toast shown by the api client */
    }
    await qc.invalidateQueries({ queryKey: ["episode", eid] });
    setSelecting(null);
  };
  return (
    <Card className="p-3.5">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <span className="grid size-6 place-items-center rounded-md bg-accent/12 text-accent-ink"><Music className="size-3.5" /></span>
        {t("Music")}
        {music.length > 0 && <span className="rounded-full bg-raised px-1.5 text-2xs font-semibold tabular-nums leading-4 text-dim">{music.length}</span>}
      </h3>
      {music.length > 0 ? (
        <ul className="mb-3 space-y-1.5">
          {music.map((m) => <MusicRow key={m.id} m={m} canEdit={canEdit} selecting={selecting === m.id} onUse={() => use(m)} />)}
        </ul>
      ) : <p className="mb-3 text-xs text-mute">{t("No music yet")}</p>}
      {canEdit && (
        <div className="flex gap-2">
          <Input placeholder={t("Describe the music (optional)")} aria-label={t("Describe the music (optional)")} value={prompt} onChange={(e) => setPrompt(e.target.value)} className="!h-8"
            onKeyDown={(e) => { if (e.key === "Enter") onCompose(); }} />
          <Button size="sm" icon={<Sparkles className="size-3.5" />} onClick={onCompose}>{t("Compose")}</Button>
        </div>
      )}
    </Card>
  );
}

/** Trim controls for the selected clip. The bar shows how much of the source clip is kept. */
export function ClipInspector({ shot, clip, canEdit, onClose, onSeek }: { shot: Shot; clip: Clip; canEdit: boolean; onClose: () => void; onSeek: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [tin, setTin] = useState(shot.trim_in);
  const [tout, setTout] = useState(shot.trim_out);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { setTin(shot.trim_in); setTout(shot.trim_out); }, [shot.id]);
  const save = async (what: string, body: Record<string, any>) => {
    setBusy(what);
    try {
      await api.patch(`/api/shots/${shot.id}`, body);
      qc.invalidateQueries({ queryKey: ["episode"] });
      toast.success(t("Updated"));
    } catch {
      /* toast shown by the api client */
    } finally {
      setBusy(null);
    }
  };
  const raw = Math.max(0.5, shot.video?.duration_s || shot.duration_s);
  const lo = Math.min(100, Math.max(0, ((Number(tin) || 0) / raw) * 100));
  const hi = Math.min(100, Math.max(0, ((Number(tout) || 0) / raw) * 100));
  return (
    <Card className="space-y-3 border-accent/30 p-3.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-mono text-sm font-semibold">
            {shot.code}
            <Tooltip content={t("Move the playhead here")}>
              <button type="button" onClick={onSeek} className="inline-flex h-6 items-center rounded-md bg-raised px-2 text-2xs font-normal tabular-nums text-mute transition-colors hover:bg-hover hover:text-ink">
                {formatTC(clip.start, FPS, true)} · {clip.duration.toFixed(1)}s
              </button>
            </Tooltip>
          </p>
          <p className="mt-0.5 line-clamp-2 text-xs text-mute">{shot.action}</p>
        </div>
        <IconButton title={t("Close")} onClick={onClose} className="-mr-1 -mt-1 !size-7"><X className="size-4" /></IconButton>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("Trim start (s)")}><Input type="number" step="0.1" min={0} value={tin} disabled={!canEdit} onChange={(e) => setTin(Number(e.target.value))} /></Field>
        <Field label={t("Trim end (s)")}><Input type="number" step="0.1" min={0} value={tout} disabled={!canEdit} onChange={(e) => setTout(Number(e.target.value))} /></Field>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-accent/70" aria-hidden title={t("The part of the clip that stays in the cut")}>
        <div className="absolute inset-y-0 left-0 bg-line" style={{ width: `${lo}%` }} />
        <div className="absolute inset-y-0 right-0 bg-line" style={{ width: `${hi}%` }} />
      </div>
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" loading={busy === "trim"} onClick={() => save("trim", { trim_in: tin, trim_out: tout })}>{t("Apply trim")}</Button>
          <Button size="sm" variant="ghost" loading={busy === "remove"} onClick={() => save("remove", { include: false })}>{t("Remove from cut")}</Button>
        </div>
      )}
    </Card>
  );
}

// ── dialogs ──────────────────────────────────────────────────────────────────

/** Cost confirmation for sound design (one ElevenLabs call per shot). */
export function AutoSfxDialog({ open, onClose, clips, selected, mode, run }: {
  open: boolean; onClose: () => void; clips: Clip[]; selected: Shot | null; mode?: string;
  run: (ids: number[] | null) => Promise<SubmitResult | undefined>;
}) {
  const t = useT();
  const [only, setOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setOnly(false); }, [open]);
  const n = only && selected ? 1 : clips.length;
  const live = mode === "live" || mode === undefined; // unknown → assume it costs money
  const cost = live ? SFX_USD_PER_SHOT * n : 0;
  const replacing = clips.filter((c) => c.shot.sfx_track?.path && (!only || c.shot.id === selected?.id)).length;
  const go = async () => {
    setBusy(true);
    try {
      const r = await run(only && selected ? [selected.id] : null);
      if (r) onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} size="md" title={<span className="flex items-center gap-2"><AudioWaveform className="size-4 text-accent-ink" />{t("Auto SFX")}</span>}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="primary" data-autofocus loading={busy} icon={<Coins className="size-4" />} onClick={go}>{cost ? t("Generate · ~{usd}", { usd: usd(cost) }) : t("Generate")}</Button>
      </>}>
      <div className="space-y-4">
        <p className="text-sm text-mute">{t("The sound designer plans ambience and spot effects for each shot, generates them and places them on the SFX track. They're mixed into renders under dialogue.")}</p>
        {selected && (
          <Toggle checked={only} onChange={setOnly} label={<span className="text-sm">{t("Only the selected shot ({code})", { code: selected.code })}</span>} />
        )}
        <div className="flex items-end justify-between rounded-xl border border-line bg-raised/40 px-4 py-3">
          <div>
            <p className="text-2xs font-medium uppercase tracking-wide text-dim">{t("Estimated cost")}</p>
            <p className="mt-0.5 text-sm text-mute">{t("{n} shots", { n })}</p>
          </div>
          <span className="text-3xl font-semibold leading-none tabular-nums">{live ? "~" : ""}<AnimatedNumber value={cost} format={(v) => usd(v)} duration={0.6} /></span>
        </div>
        {replacing > 0 && <p className="rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">{t("{n} shots already have effects — they'll be replaced.", { n: replacing })}</p>}
        {mode === "missing" ? (
          <p className="rounded-lg bg-bad/10 px-3 py-2 text-xs text-bad">{t("ElevenLabs isn't connected — add its key in Settings first, or the job will fail.")}</p>
        ) : (
          <p className="text-xs text-dim">{t("Estimate at list price (ElevenLabs sound effects, ~6 s per shot) plus a small planning call. Team budget rules apply — large batches may need a producer's approval.")}</p>
        )}
      </div>
    </Modal>
  );
}

const GROUPS: { title: string; rows: [string[], string][] }[] = [
  { title: "Playback", rows: [[["Space"], "Play / pause"], [["J", "K", "L"], "Shuttle reverse / stop / forward (repeat for 2× / 4×)"], [["Home", "End"], "Start / end"]] },
  { title: "Move", rows: [[["←", "→"], "Step one frame"], [["Shift", "← →"], "Step one second"], [["↑", "↓"], "Previous / next cut"], [["Double-click clip"], "Move the playhead to the clip"]] },
  { title: "View", rows: [[["+", "−"], "Zoom in / out"], [["Ctrl", "wheel"], "Zoom at the cursor"], [["\\"], "Fit to window"], [["S"], "Toggle snapping"]] },
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  return (
    <Modal open={open} onClose={onClose} title={t("Timeline shortcuts")}>
      <div className="space-y-4">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h4 className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-dim">{t(g.title)}</h4>
            <dl className="space-y-1.5">
              {g.rows.map(([keys, label]) => (
                <div key={label} className="flex items-center gap-3 text-sm">
                  <dt className="flex w-40 shrink-0 flex-wrap items-center justify-end gap-1">{keys.map((k) => <Kbd key={k}>{k.includes(" ") || k.length > 5 ? t(k) : k}</Kbd>)}</dt>
                  <dd className="min-w-0 flex-1 text-mute">{t(label)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
