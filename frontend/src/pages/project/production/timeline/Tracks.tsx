import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { clsx } from "clsx";
import { Subtitles, Trash2, Type } from "lucide-react";
import { motion } from "motion/react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { capturePointer, releasePointer } from "../../../../components/hub/util";
import { WaveCanvas, type WaveSeg } from "../../../../components/review/Waveform";
import { clamp, formatTC, rulerLabel, useClock, type Clock } from "../../../../components/review/utils";
import { Button, Field, Input, Segmented, Select, Tooltip } from "../../../../components/ui";
import { useT } from "../../../../lib/i18n";
import type { Shot } from "../../../../lib/types";
import { FPS, LABEL_W, RULER_H, TRACK_H, type Clip, type Overlay } from "./shared";

// ── readouts ─────────────────────────────────────────────────────────────────

export function PlayheadReadout({ clock, className }: { clock: Clock; className?: string }) {
  const v = useClock(clock);
  return <span className={clsx("font-mono text-xs font-semibold tabular-nums text-ink", className)}>{formatTC(v, FPS)}</span>;
}

// ── ruler, playhead, guides ──────────────────────────────────────────────────

const STEPS = [1 / 24, 2 / 24, 6 / 24, 12 / 24, 1, 2, 5, 10, 15, 30, 60, 120, 300];

export function TimeRuler({ total, pps, view, clock, onScrub }: {
  total: number; pps: number; view: { left: number; width: number }; clock: Clock;
  onScrub: (t: number, phase: "start" | "move" | "end") => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const major = STEPS.find((s) => s * pps >= 64) ?? 300;
  const minorN = major * pps >= 120 ? 5 : major * pps >= 64 ? 4 : 2;
  const minor = major / minorN;
  const from = Math.max(0, Math.floor((view.left - 40) / pps / major));
  const to = Math.ceil(Math.min(total + major, (view.left + view.width) / pps) / major);
  const ticks: number[] = [];
  for (let i = from; i <= to; i++) ticks.push(i);
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return clamp((clientX - r.left) / pps, 0, total);
  };
  return (
    <div className="flex border-b border-line bg-raised/60" style={{ height: RULER_H }}>
      <div className="sticky left-0 z-30 flex shrink-0 items-center border-r border-line bg-panel px-2.5" style={{ width: LABEL_W }} title={`${FPS} fps`}>
        <PlayheadReadout clock={clock} />
      </div>
      <div
        ref={ref}
        role="slider" aria-label={t("Playhead")} aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(clock.get())} tabIndex={-1}
        className="relative flex-1 cursor-ew-resize touch-none select-none"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = true;
          capturePointer(e.currentTarget, e.pointerId);
          onScrub(at(e.clientX), "start");
        }}
        onPointerMove={(e) => { if (drag.current) onScrub(at(e.clientX), "move"); }}
        onPointerUp={(e) => {
          if (!drag.current) return;
          drag.current = false;
          releasePointer(e.currentTarget, e.pointerId);
          onScrub(at(e.clientX), "end");
        }}
      >
        {/* the part of the ruler that has footage */}
        <div className="pointer-events-none absolute inset-y-0 left-0 border-r border-line bg-hover/60" style={{ width: total * pps }} />
        {ticks.map((i) => {
          const tt = i * major;
          return (
            <div key={i} className="pointer-events-none absolute inset-y-0" style={{ left: tt * pps }}>
              <span className="absolute bottom-0 h-3 border-l border-mute/60" />
              <span className="absolute left-1.5 top-1 whitespace-nowrap font-mono text-2xs text-mute">{rulerLabel(tt, FPS, major < 1)}</span>
              {Array.from({ length: minorN - 1 }, (_, k) => (
                <span key={k} className="absolute bottom-0 h-1.5 border-l border-line" style={{ left: (k + 1) * minor * pps }} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The playhead: a line through every track with a flag in the ruler that carries the timecode. */
export function PlayheadLine({ clock, pps, viewLeft }: { clock: Clock; pps: number; viewLeft: number }) {
  const v = useClock(clock);
  // near the left edge the flag would slide under the track labels: pin it just right of them instead
  const rel = v * pps - viewLeft;
  const shift = rel < 46 ? 46 - rel : 0;
  return (
    <div className="pointer-events-none absolute inset-y-0 z-20 will-change-transform" style={{ left: LABEL_W, transform: `translate3d(${v * pps}px,0,0)` }}>
      <div className="absolute inset-y-0 -left-px w-0.5 bg-accent shadow-[0_0_0_1px_rgb(0_0_0/0.28)]" />
      <div className="absolute left-0 top-1" style={{ transform: `translateX(calc(-50% + ${shift}px))` }}>
        <div className="rounded-md bg-accent px-1.5 py-0.5 font-mono text-2xs font-bold leading-4 tabular-nums text-black shadow-md">{formatTC(v, FPS, true)}</div>
        {shift === 0 && <div className="mx-auto -mt-px size-0 border-x-[4px] border-t-[5px] border-x-transparent border-t-accent" />}
      </div>
    </div>
  );
}

/** Vertical guide shown while a drag or a scrub is snapping to a cut / the playhead. */
export function SnapGuide({ time, pps }: { time: number; pps: number }) {
  return (
    <div className="pointer-events-none absolute inset-y-0 z-[25] w-px" style={{ left: LABEL_W + time * pps }}>
      <div className="absolute inset-y-0 left-0 border-l border-dashed border-accent-2" />
      <span className="absolute bottom-1 left-1.5 rounded bg-accent-2 px-1 font-mono text-2xs font-bold leading-4 tabular-nums text-black shadow">{formatTC(time, FPS, true)}</span>
    </div>
  );
}

/** Waveform canvas covering only the visible part of a lane (a full-length canvas would exceed browser limits when zoomed in). */
export function WaveLane({ segs, view, pps, className, height = TRACK_H - 8 }: {
  segs: WaveSeg[]; view: { left: number; width: number }; pps: number; className?: string; height?: number;
}) {
  const width = Math.max(0, view.width - LABEL_W);
  if (!segs.length || !width) return null;
  return <WaveCanvas segs={segs} t0={view.left / pps} pps={pps} width={width} height={height} className={clsx("absolute top-1", className)} style={{ left: view.left }} />;
}

// ── tracks ───────────────────────────────────────────────────────────────────

const TRACK_TONE = {
  neutral: "bg-raised text-mute", ok: "bg-ok/12 text-ok", info: "bg-info/12 text-info", accent: "bg-accent/12 text-accent-ink",
  warn: "bg-warn/12 text-warn", gold: "bg-accent-2/12 text-accent-2",
} as const;
export type TrackTone = keyof typeof TRACK_TONE;

/** One row: a sticky label column (icon tile, name, item count) and the lane. Odd rows get a faint stripe. */
export function Track({ icon, label, tone = "neutral", count, height = TRACK_H, stripe, children }: {
  icon: ReactNode; label: string; tone?: TrackTone; count?: number | string; height?: number; stripe?: boolean; children: ReactNode;
}) {
  return (
    <div className="flex border-b border-line/60" style={{ height }}>
      <div className="sticky left-0 z-30 flex shrink-0 items-center gap-2 border-r border-line bg-panel px-2.5" style={{ width: LABEL_W }}>
        <span className={clsx("grid size-5 shrink-0 place-items-center rounded-md [&>svg]:size-3", TRACK_TONE[tone])}>{icon}</span>
        <span className="min-w-0 flex-1 truncate text-2xs font-semibold uppercase tracking-wide text-mute">{label}</span>
        {count !== undefined && count !== "" && <span className="shrink-0 text-2xs tabular-nums text-dim">{count}</span>}
      </div>
      <div className={clsx("relative flex-1", stripe && "bg-raised/35")}>{children}</div>
    </div>
  );
}

const ITEM_TONE = {
  ok: "border-ok/40 bg-ok/12 text-ok", info: "border-info/40 bg-info/12 text-info", accent: "border-accent/40 bg-accent/10 text-accent-ink",
  warn: "border-warn/40 bg-warn/12 text-warn", mute: "border-line bg-raised text-mute",
} as const;

/** A block on a lane (spoken line, narration, music bed, effect, caption). Dashed = planned but not generated yet. */
export function LaneItem({ tone, left, width, dashed, title, children, className, pill }: {
  tone: keyof typeof ITEM_TONE; left: number; width: number; dashed?: boolean; title?: string; children?: ReactNode; className?: string;
  /** Put the label on a small solid chip so it stays readable over a waveform. */
  pill?: boolean;
}) {
  return (
    <div title={title} style={{ left, width }}
      className={clsx("absolute inset-y-1 flex items-center overflow-hidden rounded-md border px-1 text-2xs font-medium leading-none", dashed ? "border-dashed bg-transparent text-dim" : ITEM_TONE[tone],
        dashed && (tone === "ok" ? "border-ok/40" : tone === "info" ? "border-info/40" : tone === "warn" ? "border-warn/40" : "border-line"), className)}>
      <span className={clsx("truncate", pill && !dashed ? "rounded-[4px] bg-panel/85 px-1 py-[3px] text-ink" : "px-0.5")}>{children}</span>
    </div>
  );
}

const KIND_TAG: Record<string, string> = { lipsync: "Lip-sync", voicelock: "Voice lock", still: "Still" };

const TITLE_ANIMS: [string, string][] = [["fade", "Fade"], ["pop", "Pop"], ["slide_up", "Slide up"], ["slide_in", "Slide in"],
  ["zoom", "Zoom"], ["blur_in", "Blur in"], ["typewriter", "Typewriter"], ["none", "None"]];

export function ClipBlock({ clip, pps, selected, onClick, onDoubleClick, draggable }: {
  clip: Clip; pps: number; selected: boolean; onClick: () => void; onDoubleClick: () => void; draggable: boolean;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: clip.shot.id, disabled: !draggable });
  const thumb = clip.shot.lipsync?.thumb_url || clip.shot.video?.thumb_url || clip.still;
  const w = clip.duration * pps;
  const code = clip.shot.code.split("-").pop();
  const kindTag = KIND_TAG[clip.kind];
  const style: CSSProperties = {
    width: w, transform: CSS.Transform.toString(transform), transition,
    // the poster repeats along the clip like a filmstrip, keeping its own proportions
    backgroundImage: thumb ? `url(${thumb})` : undefined, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x", backgroundPosition: "left center",
  };
  return (
    <Tooltip content={`${clip.shot.code} · ${t(kindTag ?? "Video")} · ${clip.duration.toFixed(1)}s`} side="top" delay={500}>
      <div ref={setNodeRef} {...attributes} {...listeners} role="button" aria-label={`${clip.shot.code}, ${clip.duration.toFixed(1)}s`} aria-pressed={selected}
        onClick={onClick} onDoubleClick={onDoubleClick} style={style}
        className={clsx("relative my-1 shrink-0 cursor-pointer overflow-hidden rounded-md border bg-raised outline-none transition-[box-shadow,border-color,opacity] duration-150",
          "focus-visible:ring-2 focus-visible:ring-accent/70",
          selected ? "z-[1] border-accent ring-2 ring-accent/50" : "border-black/50 hover:border-dim",
          clip.kind === "still" && "opacity-70", isDragging && "z-20 opacity-90 shadow-lift")}>
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/55 via-transparent to-black/45" />
        <span className="absolute left-1 top-0.5 rounded bg-black/65 px-1 font-mono text-2xs font-semibold leading-4 text-white">{code}</span>
        {clip.shot.fx?.transition && (
          <span title={`${clip.shot.fx.transition.type} · ${clip.shot.fx.transition.duration}s`}
            className="absolute -left-px top-1/2 z-[2] grid size-4 -translate-y-1/2 rotate-45 place-items-center rounded-sm border border-white/70 bg-accent shadow" />
        )}
        {Object.keys(clip.shot.fx ?? {}).some((k) => k !== "transition") && w > 50 && (
          <span className="absolute right-1 top-0.5 rounded bg-accent/85 px-1 text-2xs font-bold leading-4 text-black">fx</span>
        )}
        {w > 70 && <span className="absolute bottom-0.5 right-1 font-mono text-2xs font-medium tabular-nums leading-4 text-white/90">{clip.duration.toFixed(1)}s</span>}
        {kindTag && w > 70 && <span className="absolute bottom-0.5 left-1 rounded bg-black/65 px-1 text-2xs font-medium leading-4 text-white/90">{t(kindTag)}</span>}
      </div>
    </Tooltip>
  );
}

// ── title / lower-third overlays ─────────────────────────────────────────────

export interface OverlayEdit { shot: Shot; clipDuration: number; index: number | null; draft: Overlay; x: number; y: number }
interface OvDrag { sid: number; index: number; mode: "move" | "l" | "r"; x0: number; orig: { start: number; end: number }; cur: { start: number; end: number }; moved: boolean }

export function OverlayLane({ clips, pps, canEdit, snapTime, setSnapLine, onOpen, onCommit }: {
  clips: Clip[]; pps: number; canEdit: boolean; snapTime: (t: number, withPlayhead?: boolean) => number; setSnapLine: (t: number | null) => void;
  onOpen: (e: OverlayEdit) => void; onCommit: (shot: Shot, list: Overlay[]) => void;
}) {
  const t = useT();
  const [drag, setDrag] = useState<OvDrag | null>(null);
  const dragRef = useRef<OvDrag | null>(null);
  dragRef.current = drag;

  const move = (e: React.PointerEvent, c: Clip) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 3) return;
    const ds = dx / pps;
    const len = d.orig.end - d.orig.start;
    let { start, end } = d.orig;
    let snapped: number | null = null;
    if (d.mode === "move") {
      start = clamp(d.orig.start + ds, 0, c.duration - len);
      const sA = snapTime(c.start + start, true) - c.start;
      const sB = snapTime(c.start + start + len, true) - c.start - len;
      if (Math.abs(sA - start) > 1e-6) { start = clamp(sA, 0, c.duration - len); snapped = c.start + start; }
      else if (Math.abs(sB - start) > 1e-6) { start = clamp(sB, 0, c.duration - len); snapped = c.start + start + len; }
      end = start + len;
    } else if (d.mode === "l") {
      start = clamp(snapTime(c.start + d.orig.start + ds, true) - c.start, 0, d.orig.end - 0.2);
      if (Math.abs(c.start + start - (c.start + d.orig.start + ds)) > 1e-6) snapped = c.start + start;
    } else {
      end = clamp(snapTime(c.start + d.orig.end + ds, true) - c.start, d.orig.start + 0.2, c.duration);
      if (Math.abs(c.start + end - (c.start + d.orig.end + ds)) > 1e-6) snapped = c.start + end;
    }
    setSnapLine(snapped);
    setDrag({ ...d, moved: true, cur: { start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 } });
  };

  return (
    <div
      className={clsx("absolute inset-0", canEdit && "cursor-copy")}
      title={canEdit ? t("Click to add a title or lower third") : undefined}
      onClick={(e) => {
        if (!canEdit || e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        const at = (e.clientX - r.left) / pps;
        const c = clips.find((x) => at >= x.start && at < x.start + x.duration);
        if (!c) return;
        const s = clamp(Math.round((at - c.start) * 10) / 10, 0, Math.max(0, c.duration - 0.5));
        onOpen({ shot: c.shot, clipDuration: c.duration, index: null, x: e.clientX, y: e.clientY,
          draft: { text: "", kind: "title", start: s, end: Math.min(c.duration, Math.round((s + 2.5) * 10) / 10) } });
      }}
    >
      {clips.map((c) => (c.shot.overlays ?? []).map((o, i) => {
        const live = drag && drag.sid === c.shot.id && drag.index === i ? drag.cur : null;
        const start = live?.start ?? o.start;
        const end = live?.end ?? (o.end || c.duration);
        const lower = o.kind === "lower_third";
        return (
          <div
            key={`${c.shot.id}-${i}`}
            title={`${lower ? t("Lower third") : t("Title")}: ${o.text}`}
            className={clsx("group absolute inset-y-1 flex items-center gap-1 overflow-hidden rounded-md border px-1.5 text-2xs font-medium leading-none",
              lower ? "border-info/50 bg-info/15 text-info" : "border-accent-2/50 bg-accent-2/15 text-accent-2",
              canEdit && "cursor-grab active:cursor-grabbing", live && "z-10 ring-2 ring-accent/50")}
            style={{ left: (c.start + start) * pps, width: Math.max((end - start) * pps, 6) }}
            onPointerDown={(e) => {
              if (!canEdit || e.button !== 0) return;
              e.stopPropagation();
              const edge = (e.target as HTMLElement).dataset.edge as "l" | "r" | undefined;
              capturePointer(e.currentTarget, e.pointerId);
              setDrag({ sid: c.shot.id, index: i, mode: edge ?? "move", x0: e.clientX, orig: { start: o.start, end: o.end || c.duration },
                cur: { start: o.start, end: o.end || c.duration }, moved: false });
            }}
            onPointerMove={(e) => move(e, c)}
            onPointerUp={(e) => {
              const d = dragRef.current;
              setDrag(null);
              setSnapLine(null);
              if (!d) return;
              releasePointer(e.currentTarget, e.pointerId);
              if (d.moved) {
                const list = (c.shot.overlays ?? []).map((x, k) => (k === i ? { ...x, start: d.cur.start, end: d.cur.end } : x));
                onCommit(c.shot, list);
              } else {
                onOpen({ shot: c.shot, clipDuration: c.duration, index: i, draft: { ...o, end: o.end || c.duration }, x: e.clientX, y: e.clientY });
              }
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {canEdit && <span data-edge="l" className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-current opacity-0 transition-opacity group-hover:opacity-40" />}
            {lower ? <Subtitles className="pointer-events-none size-3 shrink-0" /> : <Type className="pointer-events-none size-3 shrink-0" />}
            <span className="pointer-events-none truncate">{o.text}</span>
            {canEdit && <span data-edge="r" className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-current opacity-0 transition-opacity group-hover:opacity-40" />}
          </div>
        );
      }))}
    </div>
  );
}

/** Where a title sits in its shot, as a bar. */
function SpanBar({ start, end, total }: { start: number; end: number; total: number }) {
  const l = total > 0 ? clamp(start / total, 0, 1) * 100 : 0;
  const w = total > 0 ? clamp((end - start) / total, 0, 1) * 100 : 0;
  return (
    <div className="relative h-2 overflow-hidden rounded-full bg-line" aria-hidden>
      <motion.div className="absolute inset-y-0 rounded-full bg-accent-2" animate={{ left: `${l}%`, width: `${Math.max(w, 1.5)}%` }} transition={{ type: "spring", stiffness: 300, damping: 30 }} />
    </div>
  );
}

export function OverlayPopover({ edit, onClose, onSave }: { edit: OverlayEdit; onClose: () => void; onSave: (list: Overlay[]) => Promise<void> }) {
  const t = useT();
  const [d, setD] = useState<Overlay>(edit.draft);
  const [busy, setBusy] = useState(false);
  const W = 320;
  const H = 360;
  const left = clamp(edit.x - W / 2, 8, window.innerWidth - W - 8);
  const below = edit.y + H < window.innerHeight;
  const top = below ? edit.y + 14 : Math.max(8, edit.y - H);
  const list = edit.shot.overlays ?? [];
  const save = async (next: Overlay[]) => {
    setBusy(true);
    try { await onSave(next); } catch { /* toast shown by the api client */ } finally { setBusy(false); }
  };
  const valid = d.text.trim().length > 0 && d.end > d.start;
  const commit = () => valid && save(edit.index === null ? [...list, d] : list.map((o, i) => (i === edit.index ? d : o)));
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onPointerDown={onClose} />
      <motion.div
        role="dialog" aria-label={edit.index === null ? t("New overlay") : t("Edit overlay")}
        initial={{ opacity: 0, scale: 0.96, y: below ? -6 : 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.1 } }}
        transition={{ type: "spring", stiffness: 520, damping: 34 }}
        className="fixed z-50 space-y-3 rounded-xl border border-line bg-panel p-3.5 shadow-pop"
        style={{ left, top, width: W, transformOrigin: below ? "top center" : "bottom center" }}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
      >
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-lg bg-accent-2/15 text-accent-2"><Type className="size-4" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight">{edit.index === null ? t("New overlay") : t("Edit overlay")}</p>
            <p className="text-2xs text-dim">{t("Shown over {code}", { code: edit.shot.code })}</p>
          </div>
        </div>
        <Input autoFocus value={d.text} maxLength={120} placeholder={t("Text on screen")} aria-label={t("Text on screen")} onChange={(e) => setD({ ...d, text: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
        <Segmented value={d.kind} onChange={(k) => setD({ ...d, kind: k })} className="w-full [&>button]:flex-1" aria-label={t("Overlay type")}
          options={[{ value: "title", label: t("Title") }, { value: "lower_third", label: t("Lower third") }]} />
        <Field label={t("Animation")}>
          <Select value={d.anim ?? "fade"} onChange={(e) => setD({ ...d, anim: e.target.value })} className="!h-8 text-xs">
            {TITLE_ANIMS.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
          </Select>
        </Field>
        <div className="space-y-1.5">
          <SpanBar start={d.start} end={d.end} total={edit.clipDuration} />
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("Start (s, in shot)")}>
              <Input type="number" step={0.1} min={0} max={edit.clipDuration} value={d.start} className="!h-8"
                onChange={(e) => setD({ ...d, start: clamp(Number(e.target.value), 0, edit.clipDuration) })} />
            </Field>
            <Field label={t("End (s, in shot)")}>
              <Input type="number" step={0.1} min={0} max={edit.clipDuration} value={d.end} className="!h-8"
                onChange={(e) => setD({ ...d, end: clamp(Number(e.target.value), 0, edit.clipDuration) })} />
            </Field>
          </div>
        </div>
        {d.end <= d.start && <p className="text-2xs text-bad">{t("End must be after start.")}</p>}
        <div className="flex items-center gap-2 border-t border-line pt-3">
          {edit.index !== null && (
            <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} disabled={busy}
              onClick={() => save(list.filter((_, i) => i !== edit.index))}>{t("Delete")}</Button>
          )}
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
          <Button size="sm" variant="primary" loading={busy} disabled={!valid} onClick={commit}>{t("Save")}</Button>
        </div>
      </motion.div>
    </>,
    document.body,
  );
}
