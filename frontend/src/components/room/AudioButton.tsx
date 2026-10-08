import { clsx } from "clsx";
import { Loader2, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";

/** Only one voice sample plays at a time: starting a new one stops whichever was playing. */
let stopCurrent: (() => void) | null = null;

/** Round play / pause button for a short audio sample, with a thin progress ring while it plays. */
export function AudioButton({ src, size = 28, label }: { src: string; size?: number; label?: string }) {
  const t = useT();
  const audio = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const [progress, setProgress] = useState(0);

  const stop = useCallback(() => {
    const a = audio.current;
    if (a) { a.pause(); a.currentTime = 0; }
    setState("idle");
    setProgress(0);
  }, []);

  useEffect(() => () => {
    audio.current?.pause();
    if (stopCurrent === stop) stopCurrent = null;
  }, [stop]);

  const toggle = () => {
    if (state !== "idle") { stop(); return; }
    stopCurrent?.();
    stopCurrent = stop;
    if (!audio.current) {
      const a = new Audio();
      a.ontimeupdate = () => setProgress(a.duration ? a.currentTime / a.duration : 0);
      a.onended = () => { setState("idle"); setProgress(0); };
      a.onerror = () => { setState("idle"); setProgress(0); };
      audio.current = a;
    }
    audio.current.src = src;
    setState("loading");
    audio.current.play().then(() => setState("playing")).catch(() => { setState("idle"); });
  };

  const r = size / 2 - 1.5;
  const c = 2 * Math.PI * r;
  const name = label ?? t("Play");
  return (
    <button type="button" onClick={toggle} title={state === "idle" ? name : t("Stop")} aria-label={state === "idle" ? name : t("Stop")} aria-pressed={state !== "idle"}
      style={{ width: size, height: size }}
      className={clsx("relative grid shrink-0 place-items-center rounded-full transition-colors",
        state === "idle" ? "bg-raised text-ink hover:bg-hover" : "bg-accent/15 text-accent-ink")}>
      {state !== "idle" && (
        <svg aria-hidden width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - progress)} className="transition-[stroke-dashoffset] duration-200 ease-linear" />
        </svg>
      )}
      {state === "loading" ? <Loader2 className="size-3 animate-spin" /> : state === "playing" ? <Pause className="size-3 fill-current" /> : <Play className="ml-px size-3 fill-current" />}
    </button>
  );
}
