import { clsx } from "clsx";
import { Clapperboard, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useMotionPref } from "../../components/shell/theme";
import { useT } from "../../lib/i18n";
import { ENGINES, SLIDES, type Engine } from "./showcase";
import "../../styles/login.css";

export const SLIDE_MS = 7000;
const DRIFT: [string, string][] = [["-2%", "-1.5%"], ["2%", "-1%"], ["-1.5%", "1.5%"], ["1.5%", "1.5%"], ["-2.5%", "0%"], ["2%", "-2%"]];

function useHidden() {
  return useSyncExternalStore(
    (cb) => { document.addEventListener("visibilitychange", cb); return () => document.removeEventListener("visibilitychange", cb); },
    () => document.hidden,
    () => false,
  );
}

function useReducedMotion() {
  const pref = useMotionPref();
  const os = useSyncExternalStore(
    (cb) => { const m = window.matchMedia("(prefers-reduced-motion: reduce)"); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
  return pref === "reduced" || os;
}

/** Which frame of the showreel is on screen. Advances every SLIDE_MS; holds while the tab is hidden, on hover, or with reduced motion. */
export function useShowreel() {
  const [index, setIndex] = useState(0);
  const [hold, setHold] = useState(false);
  const hidden = useHidden();
  const reduced = useReducedMotion();
  const paused = hold || hidden || reduced;
  useEffect(() => {
    if (paused) return;
    const id = window.setTimeout(() => setIndex((i) => (i + 1) % SLIDES.length), SLIDE_MS);
    return () => window.clearTimeout(id);
  }, [index, paused]);
  return { index, go: setIndex, paused, setHold, reduced };
}

/** Full-bleed frames with a slow camera drift, crossfading; theme-aware shade, brand wash and film grain on top. */
export function Stage({ index }: { index: number }) {
  // the frame fading out keeps its end-of-drift framing, so the crossfade never jumps
  const prev = useRef(index);
  const [last, setLast] = useState<number | null>(null);
  useEffect(() => { if (prev.current !== index) { setLast(prev.current); prev.current = index; } }, [index]);
  return (
    <div className="lg-stage" aria-hidden>
      {SLIDES.map((s, i) => {
        const style = { "--kx": DRIFT[i % DRIFT.length][0], "--ky": DRIFT[i % DRIFT.length][1] } as CSSProperties;
        const near = i === index || i === (index + 1) % SLIDES.length; // only the current and next frames need to load now
        const cls = clsx("lg-slide", i === index && "is-on", i === last && i !== index && "was-on");
        return s.loop ? (
          <video key={s.slug} className={cls} style={style} src={near ? `/showcase/${s.loop}` : undefined} poster={`/showcase/${s.slug}.webp`}
            autoPlay muted loop playsInline preload={near ? "auto" : "none"} />
        ) : (
          <img key={s.slug} className={cls} style={style} alt="" decoding="async"
            loading={near ? "eager" : "lazy"} fetchPriority={i === 0 ? "high" : "auto"}
            src={`/showcase/${s.slug}.webp`} srcSet={`/showcase/${s.slug}-sm.webp 720w, /showcase/${s.slug}.webp 1920w`} sizes="100vw" />
        );
      })}
      <div className="lg-wash" />
      <div className="lg-shade" />
      <div className="lg-grain" />
    </div>
  );
}

/** "Now showing": the frame's title and the engine that made it, and a thumbnail per frame with story-style progress. */
export function Reel({ index, paused, onPick, onHold }: { index: number; paused: boolean; onPick: (i: number) => void; onHold: (v: boolean) => void }) {
  const t = useT();
  const cur = SLIDES[index];
  return (
    <div onMouseEnter={() => onHold(true)} onMouseLeave={() => onHold(false)} onFocus={() => onHold(true)} onBlur={() => onHold(false)}>
      <p className="eyebrow flex items-center gap-2">
        <Clapperboard className="size-3.5" />{t("Now showing")}
        <span className="mono text-dim">{String(index + 1).padStart(2, "0")} / {String(SLIDES.length).padStart(2, "0")}</span>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5" aria-live="polite">
        <span className="text-lg font-semibold tracking-tight">{t(cur.title)}</span>
        <span className="lg-glass inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs text-mute">
          <Sparkles className="size-3 text-ai" />{t("Made with {model}", { model: cur.model })}
          {cur.loopModel && <span className="text-dim">· {t("animated with {model}", { model: cur.loopModel })}</span>}
        </span>
      </div>
      <div className="mt-3 flex gap-2" role="tablist" aria-label={t("Showreel")}>
        {SLIDES.map((s, i) => (
          <button key={s.slug} type="button" role="tab" aria-selected={i === index} aria-label={t("Show {title}", { title: t(s.title) })} onClick={() => onPick(i)}
            className={clsx("group relative h-11 w-[4.5rem] shrink-0 overflow-hidden rounded-lg outline-none ring-1 transition-all duration-300 focus-visible:ring-2 focus-visible:ring-accent",
              i === index ? "ring-accent/70 opacity-100" : "ring-line opacity-60 hover:opacity-100")}>
            <img src={`/showcase/${s.slug}-sm.webp`} alt="" loading="lazy" decoding="async" className="size-full object-cover transition-transform duration-500 group-hover:scale-110" />
            <span className={clsx("lg-progress", i === index && "is-on", i < index && "is-done", paused && "is-paused")} style={{ "--slide-ms": `${SLIDE_MS}ms` } as CSSProperties}>
              <i key={i === index ? `on-${index}` : "off"} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

const VIA_DOT: Record<Engine["via"], string> = {
  Google: "bg-info", "fal.ai": "bg-ai", ElevenLabs: "bg-ink", Sarvam: "bg-money", "sync.so": "bg-accent",
};

/** The engines the studio drives, as an endless marquee of glass chips. Pauses on hover. */
export function EngineMarquee({ className }: { className?: string }) {
  const t = useT();
  const chips = (copy: number) => ENGINES.map((e) => (
    <li key={`${copy}-${e.name}`} aria-hidden={copy > 0 || undefined}
      className="lg-glass flex shrink-0 items-center gap-2 rounded-full py-1.5 pl-2.5 pr-3 text-xs">
      <span aria-hidden className={clsx("size-1.5 rounded-full", VIA_DOT[e.via])} />
      <span className="font-medium text-ink">{e.name}</span>
      <span className="mono text-2xs uppercase tracking-wider text-dim">{t(e.kind)} · {e.via}</span>
    </li>
  ));
  return (
    <div className={clsx("flex items-center gap-4", className)}>
      <span className="eyebrow hidden shrink-0 sm:block">{t("Powered by")}</span>
      <div className="lg-marquee min-w-0 flex-1" aria-label={t("AI engines")}>
        <ul className="lg-marquee-track">{chips(0)}{chips(1)}</ul>
      </div>
    </div>
  );
}
