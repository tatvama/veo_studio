/**
 * Small controls shared by the review player and the A/B compare view: timecode readout, play button, speed menu,
 * volume and the keyboard-shortcut popover. The menus render inside the player (not in a portal) so they also work in fullscreen.
 */
import { clsx } from "clsx";
import { Check, Keyboard, Pause, Play, Volume1, Volume2, VolumeX } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useT } from "../../lib/i18n";
import { IconButton, Kbd, Tooltip } from "../ui";
import { formatTC, useClock, type Clock } from "./utils";

export const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

/** Rounded hit area used by every text/icon control on the transport bar: 40px on phones, 32px with a mouse. */
export const BAR_BTN = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg text-mute transition-colors hover:bg-hover hover:text-ink max-sm:h-10";

export function PlayButton({ playing, onClick }: { playing: boolean; onClick: () => void }) {
  const t = useT();
  return (
    <Tooltip content={playing ? t("Pause (Space)") : t("Play (Space)")}>
      <button
        type="button"
        onClick={onClick}
        aria-label={playing ? t("Pause (Space)") : t("Play (Space)")}
        className="mr-1 grid size-9 shrink-0 place-items-center rounded-full bg-accent text-black shadow-[0_6px_16px_-6px_rgb(34_211_238/0.7)] transition-[transform,filter] duration-150 hover:brightness-110 active:scale-90 max-sm:size-10"
      >
        {playing ? <Pause className="size-4" fill="currentColor" /> : <Play className="ml-0.5 size-4" fill="currentColor" />}
      </button>
    </Tooltip>
  );
}

/** HH:MM:SS:FF of the clock, with the total after it on wider screens. */
export function TimeReadout({ clock, fps, duration, className }: { clock: Clock; fps: number; duration: number; className?: string }) {
  const time = useClock(clock);
  return (
    <span className={clsx("select-none whitespace-nowrap rounded-md bg-raised/70 px-2 py-1 font-mono text-xs tabular-nums text-ink", className)}>
      {formatTC(time, fps, true)}
      <span className="hidden text-dim @md:inline"> / {formatTC(duration, fps, true)}</span>
    </span>
  );
}

function useDismiss(open: boolean, onClose: () => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", down); window.removeEventListener("keydown", key, true); };
  }, [open, onClose, ref]);
}

const panel = "absolute bottom-full z-40 mb-2 rounded-xl border border-line bg-raised shadow-pop";
const panelMotion = {
  initial: { opacity: 0, y: 6, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.1 } },
  transition: { duration: 0.15, ease: [0.22, 1, 0.36, 1] as const },
};

export function SpeedMenu({ rate, onPick }: { rate: number; onPick: (r: number) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  return (
    <div ref={box} className="relative">
      <Tooltip content={t("Playback speed")}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t("Playback speed")}
          onClick={() => setOpen((o) => !o)}
          className={clsx(BAR_BTN, "min-w-10 px-2 font-mono text-xs font-medium tabular-nums", rate !== 1 && "bg-accent/12 text-accent-ink", open && "bg-hover text-ink")}
        >
          {rate}×
        </button>
      </Tooltip>
      <AnimatePresence>
        {open && (
          <motion.div role="menu" {...panelMotion} style={{ transformOrigin: "bottom right" }} className={clsx(panel, "right-0 w-36 p-1")}>
            <p className="px-2.5 pb-1 pt-1 text-2xs font-semibold uppercase tracking-wide text-dim">{t("Speed")}</p>
            {RATES.map((r) => (
              <button
                key={r}
                type="button"
                role="menuitemradio"
                aria-checked={r === rate}
                onClick={() => { onPick(r); setOpen(false); }}
                className={clsx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-hover max-sm:py-2.5", r === rate ? "text-accent-ink" : "text-ink")}
              >
                <span className="grid size-4 place-items-center">{r === rate && <Check className="size-3.5" />}</span>
                <span className="font-mono tabular-nums">{r}×</span>
                {r === 1 && <span className="ml-auto text-2xs text-dim">{t("Normal")}</span>}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function VolumeControl({ volume, muted, onVolume, onToggleMute }: {
  volume: number; muted: boolean; onVolume: (v: number) => void; onToggleMute: () => void;
}) {
  const t = useT();
  const Icon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  return (
    <div className="flex items-center">
      <IconButton title={t("Mute (M)")} onClick={onToggleMute} className="max-sm:size-10"><Icon className="size-4" /></IconButton>
      <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label={t("Volume")}
        onChange={(e) => onVolume(Number(e.target.value))} className="hidden w-16 @xl:block @4xl:w-20" />
    </div>
  );
}

/** The cheat-sheet grid (also used on its own). */
export function PlayerShortcuts({ extra }: { extra?: [string, string][] }) {
  const t = useT();
  const rows: [string, string][] = [
    ["Space", t("Play / pause")], ["← →", t("Step one frame")], ["Shift + ← →", t("Jump one second")],
    ["J K L", t("Shuttle reverse / stop / forward")], ["F", t("Fullscreen")], ["M", t("Mute")], ...(extra ?? []),
  ];
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
      {rows.map(([k, label]) => (
        <div key={k + label} className="contents">
          <span className="flex justify-end gap-0.5">{k.split(" ").map((p, i) => (p === "+" || p === "/" ? <span key={i} className="px-0.5 text-dim">{p}</span> : <Kbd key={i}>{p}</Kbd>))}</span>
          <span className="text-mute">{label}</span>
        </div>
      ))}
    </div>
  );
}

/** Keyboard icon that opens a compact cheat-sheet above it. */
export function ShortcutsButton({ extra, align = "right" }: { extra?: [string, string][]; align?: "left" | "right" }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  return (
    <div ref={box} className="relative @max-md:hidden max-md:hidden">
      <IconButton title={t("Keyboard shortcuts")} active={open} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Keyboard className="size-4" />
      </IconButton>
      <AnimatePresence>
        {open && (
          <motion.div role="dialog" aria-label={t("Keyboard shortcuts")} {...panelMotion}
            style={{ transformOrigin: align === "right" ? "bottom right" : "bottom left" }}
            className={clsx(panel, "w-72 p-3.5", align === "right" ? "right-0" : "left-0")}>
            <p className="mb-2.5 text-xs font-semibold">{t("Keyboard shortcuts")}</p>
            <PlayerShortcuts extra={extra} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
