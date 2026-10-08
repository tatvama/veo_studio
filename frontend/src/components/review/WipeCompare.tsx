import { clsx } from "clsx";
import { ArrowLeftRight, Blend, Columns2, SplitSquareHorizontal, StepBack, StepForward, Volume2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { IconButton, Select, Segmented, Tooltip } from "../ui";
import { ScrubBar } from "./ScrubBar";
import { PlayButton, ShortcutsButton, TimeReadout } from "./Transport";
import { peaksFromList } from "./Waveform";
import {
  clamp, createClock, formatTC, frameOf, frameTime, lsGet, lsSet, shortcutAllowed, useElementWidth,
} from "./utils";

export interface CompareSource { id: number; src: string; label: string; short: string; peaks?: number[]; duration?: number }
type Mode = "wipe" | "side" | "blend";

const WIDE = 700;

function Slot({ letter, tone, value, onChange, sources, label }: {
  letter: string; tone: "accent" | "info"; value: number; onChange: (id: number) => void; sources: CompareSource[]; label: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-panel p-1.5 pr-2">
      <span className={clsx("grid size-8 shrink-0 place-items-center rounded-lg text-sm font-bold",
        tone === "accent" ? "bg-accent/15 text-accent-ink" : "bg-info/15 text-sky-300")}>{letter}</span>
      <Select value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label}
        className="!h-8 min-w-0 flex-1 !border-transparent !bg-transparent !px-1.5 text-xs hover:!border-line">
        {sources.map((s) => <option key={s.id} value={s.id} title={s.label}>{s.short}</option>)}
      </Select>
    </div>
  );
}

/**
 * A/B compare of two renders (versions, languages, aspects): both videos stay in sync (play/pause/seek together,
 * drift-corrected every 250 ms) with wipe, side-by-side and opacity-blend modes.
 * Fills the height of its parent when the parent is wide; otherwise it uses a fixed picture height.
 */
export function WipeCompare({ sources, initialA, initialB, fps, className, layout }: {
  sources: CompareSource[]; initialA?: number; initialB?: number; fps: number; className?: string; layout?: "wide" | "stacked";
}) {
  const t = useT();
  const [aId, setAId] = useState<number>(() => initialA ?? sources[0]?.id);
  const [bId, setBId] = useState<number>(() => initialB ?? sources.find((s) => s.id !== (initialA ?? sources[0]?.id))?.id ?? sources[0]?.id);
  const A = sources.find((s) => s.id === aId) ?? sources[0];
  const B = sources.find((s) => s.id === bId) ?? sources[1] ?? sources[0];
  const [mode, setModeState] = useState<Mode>(() => (["wipe", "side", "blend"].includes(lsGet("veo-compare-mode")) ? lsGet("veo-compare-mode") as Mode : "wipe"));
  const [pos, setPos] = useState(0.5);
  const [opacity, setOpacity] = useState(0.5);
  const [audio, setAudio] = useState<"a" | "b">("a");
  const [playing, setPlaying] = useState(false);
  const [dur, setDur] = useState({ a: A?.duration ?? 0, b: B?.duration ?? 0 });
  const [ratio, setRatio] = useState({ a: 16 / 9, b: 16 / 9 });
  const [avail, setAvail] = useState({ w: 0, h: 0 });
  const [rootRef, rootWidth] = useElementWidth<HTMLDivElement>();
  const wide = layout ? layout === "wide" : rootWidth >= WIDE;
  const clock = useMemo(() => createClock(), []);
  const va = useRef<HTMLVideoElement>(null);
  const vb = useRef<HTMLVideoElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const setMode = (m: Mode) => { setModeState(m); lsSet("veo-compare-mode", m); };

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setAvail({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // stage = A's picture size (so the wipe divider spans the picture), side-by-side = two cells
  const side = mode === "side";
  const gap = 4;
  const size = useMemo(() => {
    if (!avail.w || !avail.h) return { w: 0, h: 0 };
    if (side) {
      const cell = (avail.w - gap) / 2;
      const h = Math.min(avail.h, cell / Math.min(ratio.a, ratio.b));
      return { w: avail.w, h };
    }
    const h = Math.min(avail.h, avail.w / ratio.a);
    return { w: Math.min(avail.w, h * ratio.a), h };
  }, [avail, ratio, side]);

  // 60 fps clock from the master (A)
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      if (va.current) clock.set(va.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, clock]);

  // drift correction: keep B on A's clock
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const a = va.current;
      const b = vb.current;
      if (!a || !b) return;
      if (b.playbackRate !== a.playbackRate) b.playbackRate = a.playbackRate;
      const target = a.currentTime;
      if (b.duration && target >= b.duration - 0.05) {
        if (!b.paused) b.pause();
        return;
      }
      if (Math.abs(b.currentTime - target) > 1.5 / fps) b.currentTime = target;
      if (b.paused && !a.paused) b.play().catch(() => {});
    }, 250);
    return () => clearInterval(id);
  }, [playing, fps]);

  useEffect(() => {
    if (va.current) va.current.muted = audio !== "a";
    if (vb.current) vb.current.muted = audio !== "b";
  }, [audio, aId, bId]);

  const duration = dur.a || A?.duration || 0;
  const seek = (to: number) => {
    const a = va.current;
    const b = vb.current;
    const tt = clamp(to, 0, a?.duration || duration || 0);
    if (a) a.currentTime = tt;
    if (b) b.currentTime = Math.min(tt, Math.max(0, (b.duration || tt) - 0.01));
    clock.set(tt);
  };
  const play = () => {
    const a = va.current;
    const b = vb.current;
    if (!a) return;
    if (a.ended || (a.duration && a.currentTime >= a.duration - 0.02)) seek(0);
    if (b) b.currentTime = Math.min(a.currentTime, b.duration || a.currentTime);
    a.play().catch(() => {});
    b?.play().catch(() => {});
  };
  const pause = () => {
    va.current?.pause();
    vb.current?.pause();
    if (va.current) seek(va.current.currentTime);
  };
  const toggle = () => (playing ? pause() : play());
  const step = (n: number) => {
    pause();
    seek(frameTime(frameOf(va.current?.currentTime ?? clock.get(), fps) + n, fps));
  };
  const swap = () => { setAId(B.id); setBId(A.id); };

  const act = useRef({ toggle, step, seek, swap, setMode, mode });
  act.current = { toggle, step, seek, swap, setMode, mode };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!shortcutAllowed(e)) return;
      const a = act.current;
      const k = e.key;
      if (k === " " || k === "Spacebar") { e.preventDefault(); if (!e.repeat) a.toggle(); }
      else if (k === "ArrowLeft") { e.preventDefault(); if (e.shiftKey) a.seek(clock.get() - 1); else a.step(-1); }
      else if (k === "ArrowRight") { e.preventDefault(); if (e.shiftKey) a.seek(clock.get() + 1); else a.step(1); }
      else if (k === "1") a.setMode("wipe");
      else if (k === "2") a.setMode("side");
      else if (k === "3") a.setMode("blend");
      else if (k === "x" || k === "X") a.swap();
      else if (k === "a" || k === "A") setAudio("a");
      else if (k === "b" || k === "B") setAudio("b");
      else if (k === "[" || k === "]") {
        const d = k === "[" ? -0.05 : 0.05;
        if (a.mode === "blend") setOpacity((o) => clamp(o + d, 0, 1));
        else setPos((p) => clamp(p + d, 0, 1));
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [clock]);

  const peakData = useMemo(() => peaksFromList(A?.peaks, A?.duration || duration), [A, duration]);
  const lengthsDiffer = dur.a && dur.b && Math.abs(dur.a - dur.b) > 0.5;

  const onMeta = (which: "a" | "b") => (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    setDur((d) => ({ ...d, [which]: v.duration || 0 }));
    if (v.videoWidth && v.videoHeight) setRatio((r) => ({ ...r, [which]: v.videoWidth / v.videoHeight }));
    v.muted = audio !== which;
    v.currentTime = Math.min(clock.get(), Math.max(0, (v.duration || 0) - 0.01));
    if (playing) v.play().catch(() => {});
  };
  const posFrom = (clientX: number) => {
    const r = stage.current!.getBoundingClientRect();
    setPos(clamp((clientX - r.left) / r.width, 0, 1));
  };

  if (!A || !B) return null;
  const layer = "absolute top-0 bottom-0 overflow-hidden bg-black transition-[left,width] duration-200 ease-out";
  const half = `calc(50% - ${gap / 2}px)`;
  const modes = [
    { value: "wipe" as const, label: <span className="flex items-center gap-1.5 whitespace-nowrap"><SplitSquareHorizontal className="size-3.5" /><span className="max-sm:hidden">{t("Wipe")}</span></span>, title: t("Wipe (1)") },
    { value: "side" as const, label: <span className="flex items-center gap-1.5 whitespace-nowrap"><Columns2 className="size-3.5" /><span className="max-sm:hidden">{t("Side by side")}</span></span>, title: t("Side by side (2)") },
    { value: "blend" as const, label: <span className="flex items-center gap-1.5 whitespace-nowrap"><Blend className="size-3.5" /><span className="max-sm:hidden">{t("Blend")}</span></span>, title: t("Opacity blend (3)") },
  ];

  return (
    <div ref={rootRef} className={clsx("flex min-h-0 flex-col gap-3", wide && "h-full", className)}>
      {/* what is being compared */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-[260px] flex-[1_1_420px] items-center gap-1.5">
          <Slot letter="A" tone="accent" value={A.id} onChange={setAId} sources={sources} label={t("Version A")} />
          <IconButton title={t("Swap A and B (X)")} onClick={swap} className="shrink-0 !rounded-full border border-line bg-panel"><ArrowLeftRight className="size-4" /></IconButton>
          <Slot letter="B" tone="info" value={B.id} onChange={setBId} sources={sources} label={t("Version B")} />
        </div>
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
          <AnimatePresence initial={false}>
            {mode === "blend" && (
              <motion.label initial={{ opacity: 0, width: 0 }} animate={{ opacity: 1, width: "auto" }} exit={{ opacity: 0, width: 0 }}
                transition={{ duration: 0.18 }} className="flex items-center gap-2 overflow-hidden text-xs text-mute">
                <span className="whitespace-nowrap">{t("B opacity")}</span>
                <input type="range" min={0} max={1} step={0.01} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="w-24" />
                <span className="w-9 font-mono tabular-nums text-ink">{Math.round(opacity * 100)}%</span>
              </motion.label>
            )}
          </AnimatePresence>
          <Tooltip content={t("Which version you hear (A / B)")}>
            <span className="inline-flex items-center gap-1.5 text-xs text-mute">
              <Volume2 className="size-3.5" />
              <Segmented value={audio} onChange={setAudio} aria-label={t("Which version you hear (A / B)")} options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} />
            </span>
          </Tooltip>
          <Segmented value={mode} onChange={setMode} aria-label={t("Compare mode")} options={modes} />
        </div>
      </div>

      {/* picture */}
      <div ref={wrap} className={clsx("flex min-h-0 items-center justify-center", wide ? "flex-1" : "h-[min(60vh,520px)]")}>
        <div
          ref={stage}
          className={clsx("relative select-none overflow-hidden rounded-xl border border-line bg-black shadow-card", mode === "wipe" && "cursor-ew-resize touch-none")}
          style={{ width: size.w || "100%", height: size.h || 240 }}
          onPointerDown={(e) => {
            if (mode !== "wipe" || e.button !== 0) return;
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            posFrom(e.clientX);
          }}
          onPointerMove={(e) => { if (dragging.current) posFrom(e.clientX); }}
          onPointerUp={(e) => {
            dragging.current = false;
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onClick={() => mode !== "wipe" && toggle()}
        >
          <div className={layer} style={side ? { left: 0, width: half } : { left: 0, width: "100%" }}>
            <video ref={va} src={A.src} playsInline preload="auto" className="h-full w-full object-contain"
              onLoadedMetadata={onMeta("a")} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
              onEnded={() => { setPlaying(false); vb.current?.pause(); }}
              onSeeked={(e) => { if (!playing) clock.set(e.currentTarget.currentTime); }} />
          </div>
          <div
            className={layer}
            style={side ? { left: `calc(50% + ${gap / 2}px)`, width: half }
              : mode === "wipe" ? { left: 0, width: "100%", clipPath: `inset(0 0 0 ${pos * 100}%)` }
                : { left: 0, width: "100%", opacity }}
          >
            <video ref={vb} src={B.src} playsInline preload="auto" className="h-full w-full object-contain" onLoadedMetadata={onMeta("b")} />
          </div>
          {mode === "wipe" && (
            <div className="pointer-events-none absolute inset-y-0 z-10" style={{ left: `${pos * 100}%` }}>
              <div className="absolute inset-y-0 -left-px w-0.5 bg-white shadow-[0_0_8px_rgb(0_0_0/0.6)]" />
              <div className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-black shadow-[0_4px_14px_rgb(0_0_0/0.5)]">
                <ArrowLeftRight className="size-4" />
              </div>
            </div>
          )}
          <span className="pointer-events-none absolute left-2 top-2 z-10 inline-flex max-w-[46%] items-center gap-1.5 rounded-md bg-black/70 px-1.5 py-1 text-2xs font-medium text-white backdrop-blur-sm">
            <b className="grid size-4 shrink-0 place-items-center rounded bg-accent text-black">A</b><span className="truncate">{A.short}</span>
          </span>
          <span className="pointer-events-none absolute right-2 top-2 z-10 inline-flex max-w-[46%] items-center gap-1.5 rounded-md bg-black/70 px-1.5 py-1 text-2xs font-medium text-white backdrop-blur-sm">
            <b className="grid size-4 shrink-0 place-items-center rounded bg-info text-black">B</b><span className="truncate">{B.short}</span>
          </span>
        </div>
      </div>

      {/* transport */}
      <div className="@container shrink-0 rounded-xl border border-line bg-panel px-2.5 pb-2 pt-1 sm:px-3.5">
        <ScrubBar clock={clock} duration={duration} fps={fps} peaks={peakData} onSeek={seek} />
        <div className="flex flex-wrap items-center gap-0.5">
          <PlayButton playing={playing} onClick={toggle} />
          <IconButton title={t("Previous frame (←)")} onClick={() => step(-1)}><StepBack className="size-4" /></IconButton>
          <IconButton title={t("Next frame (→)")} onClick={() => step(1)}><StepForward className="size-4" /></IconButton>
          <TimeReadout clock={clock} fps={fps} duration={duration} className="ml-1" />
          {lengthsDiffer ? (
            <span className="ml-2 inline-flex items-center rounded-md border border-warn/30 bg-warn/12 px-1.5 py-0.5 text-2xs font-medium text-amber-300" title={t("B holds its last frame past its end")}>
              {t("Different lengths: A {a} · B {b}", { a: formatTC(dur.a, fps, true), b: formatTC(dur.b, fps, true) })}
            </span>
          ) : null}
          <div className="flex-1" />
          <ShortcutsButton extra={[["1 2 3", t("Wipe / side by side / blend")], ["X", t("Swap A and B")], ["[ ]", t("Move the divider")], ["A B", t("Listen to A / B")]]} />
        </div>
      </div>
    </div>
  );
}
