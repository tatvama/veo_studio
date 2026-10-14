/**
 * The compact audio preview of an effect row or a chain preset (preview-polish): at rest, a mini waveform of the
 * "after" signal (rendered in idle time, the SFX library's style); playing, live spectrum bars and a scrolling
 * waveform drawn from the audition's AnalyserNode, with a Before / After switch. Plays on hover after 300 ms
 * (`useAuditionHover` on the row) or on its play button; one at a time.
 */
import "./preview.css";
import { clsx } from "clsx";
import { Loader2, Play, Square } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { audioFxDef, CHAIN_PRESETS } from "../audiofx/registry";
import { auditions, knownPeaks, onPeaks, proceduralSample, sampleKindOf, selectedClipSample, wantPeaks, type AuditionChain } from "./audio";
import { reducedMotion } from "./live";

const useAuditions = () => useSyncExternalStore((cb) => auditions.subscribe(cb), () => `${auditions.key}|${auditions.pending}|${auditions.which}`);
let byHover: string | null = null;
/** The one pending hover start (a click, or another row, cancels it). */
let hoverTimer = 0;
/** Starts a hover audition 300 ms from now, unless the chain plays already (a click got there first). */
function hoverStart(c: AuditionChain) {
  window.clearTimeout(hoverTimer);
  hoverTimer = window.setTimeout(() => {
    if (auditions.key === c.key || auditions.pending === c.key) return;
    byHover = c.key; void auditions.play(c, sampleFor(c), 2);
  }, 300);
}
function hoverEnd(c: AuditionChain) {
  window.clearTimeout(hoverTimer);
  if (byHover === c.key) { auditions.stop(c.key); byHover = null; }
}

/** The sample a chain plays now: the selected audio clip's first 4 s, else its procedural sample. */
function sampleFor(c: AuditionChain) {
  const clip = selectedClipSample();
  return clip ? clip.load() : Promise.resolve(proceduralSample(sampleKindOf(c)));
}

/** What a chain's preview says it plays. */
function sampleLabel(c: AuditionChain): string {
  const clip = selectedClipSample();
  return clip ? `your clip “${clip.name}”` : proceduralSample(sampleKindOf(c)).label;
}

/** Hover handlers for a row: 300 ms on it plays the audition (twice round), leaving stops it. */
export function useAuditionHover(chain: AuditionChain | null) {
  useEffect(() => () => { if (chain) hoverEnd(chain); }, [chain?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!chain) return {};
  return { onPointerEnter: () => hoverStart(chain), onPointerLeave: () => hoverEnd(chain) };
}

/** Starts (or stops) a chain's audition from a click: it keeps playing (three times round) after the pointer leaves. */
export function toggleAudition(chain: AuditionChain) {
  window.clearTimeout(hoverTimer);
  byHover = null;
  if (auditions.key === chain.key || auditions.pending === chain.key) { auditions.stop(chain.key); return; }
  void auditions.play(chain, sampleFor(chain), 3);
}

function MiniWave({ peaks, active, dryOnly }: { peaks?: number[]; active: boolean; dryOnly: boolean }) {
  const W = 48, H = 18;
  if (!peaks) return <span className="h-[18px] w-12 shrink-0 rounded-sm bg-raised/70" />;
  let d = "";
  peaks.forEach((x, i) => { const h = Math.max(0.6, x * (H / 2 - 1)); d += `M${i + 0.5} ${H / 2 - h}V${H / 2 + h}`; });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-12 shrink-0" aria-hidden preserveAspectRatio="none">
      <path d={d} stroke={active ? "var(--color-accent)" : "var(--color-mute)"} strokeWidth={0.8} opacity={active ? 1 : dryOnly ? 0.4 : 0.75} strokeDasharray={dryOnly ? "1.2 1.2" : undefined} />
    </svg>
  );
}

/** Live spectrum bars (left) and a scrolling waveform (right) from the audition's analyser. */
function LiveBars({ width = 92 }: { width?: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = cv.current, an = auditions.analyser;
    if (!c || !an) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = width, H = 18;
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    const freq = new Uint8Array(an.frequencyBinCount), time = new Float32Array(an.fftSize);
    const BARS = 12, BW = 2, GAP = 1, bandsW = BARS * (BW + GAP), waveX = bandsW + 4, waveW = W - waveX;
    const hist = new Float32Array(Math.max(1, Math.floor(waveW / 1.5)));
    let raf = 0, hp = 0, lastPush = 0, peak = 0;
    const css = getComputedStyle(c);
    const accent = css.getPropertyValue("--color-accent").trim() || "#22d3ee";
    const mute = css.getPropertyValue("--color-mute").trim() || "#9ba8bd";
    const still = reducedMotion();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      an.getByteFrequencyData(freq);
      an.getFloatTimeDomainData(time);
      let rms = 0; for (let i = 0; i < time.length; i++) rms += time[i] * time[i];
      rms = Math.sqrt(rms / time.length);
      // the scrolling wave moves at 30 steps a second (about 1.2 s across), whatever the screen's rate
      peak = Math.max(peak, rms);
      const now = performance.now();
      if (now - lastPush >= 33) { hist[hp] = Math.min(1, peak * 3.2); hp = (hp + 1) % hist.length; peak = 0; lastPush = now; }
      g.clearRect(0, 0, W, H);
      // log-spaced bands, 60 Hz … 16 kHz
      const ny = (auditions.ctx?.sampleRate ?? 48000) / 2;
      for (let b = 0; b < BARS; b++) {
        const f0 = 60 * Math.pow(16000 / 60, b / BARS), f1 = 60 * Math.pow(16000 / 60, (b + 1) / BARS);
        const i0 = Math.floor((f0 / ny) * freq.length), i1 = Math.max(i0 + 1, Math.ceil((f1 / ny) * freq.length));
        let m = 0; for (let i = i0; i < i1 && i < freq.length; i++) m = Math.max(m, freq[i]);
        const h = Math.max(1, (m / 255) * (H - 2));
        g.fillStyle = accent; g.globalAlpha = 0.55 + 0.45 * (m / 255);
        g.fillRect(b * (BW + GAP), H - 1 - h, BW, h);
      }
      g.globalAlpha = 1;
      g.strokeStyle = mute; g.lineWidth = 1;
      g.beginPath();
      for (let k = 0; k < hist.length; k++) {
        const v = hist[(hp + k) % hist.length], x = waveX + (k / hist.length) * waveW, h = Math.max(0.5, v * (H / 2 - 1));
        g.moveTo(x, H / 2 - h); g.lineTo(x, H / 2 + h);
      }
      g.stroke();
      if (still) cancelAnimationFrame(raf);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [width]);
  return <canvas ref={cv} style={{ width, height: 18 }} aria-hidden />;
}

/** The audio preview of one chain (an effect or a preset). `note`: show what's playing next to it. */
export function AudioWave({ chain, className, note = true, barsWidth }: { chain: AuditionChain; className?: string; note?: boolean; barsWidth?: number }) {
  useAuditions();
  const el = useRef<HTMLSpanElement>(null);
  const [, bump] = useState(0);
  const kind = sampleKindOf(chain);
  const peaks = knownPeaks(chain, `proc:${kind}`);
  useEffect(() => onPeaks(() => bump((x) => x + 1)), []);
  useEffect(() => {
    if (peaks || !el.current) return;
    const node = el.current;
    let vis = false;
    const io = new IntersectionObserver((es) => { vis = es.some((x) => x.isIntersecting); if (vis) wantPeaks(chain, () => vis && document.contains(node)); }, { rootMargin: "120px" });
    io.observe(node);
    return () => { vis = false; io.disconnect(); };
  }, [chain.key, !!peaks]); // eslint-disable-line react-hooks/exhaustive-deps
  const playing = auditions.key === chain.key, loading = auditions.pending === chain.key;
  const dryOnly = chain.effects.every((e) => audioFxDef(e.id)?.preview !== "realtime");
  const what = dryOnly ? "rendered by the export only: the preview plays it dry" : sampleLabel(chain);
  return (
    <span ref={el} className={clsx("pv-wave", className)} data-audition={chain.key} data-audition-state={playing ? "playing" : loading ? "loading" : "idle"}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button type="button" tabIndex={-1} className={clsx("pv-play", (playing || loading) && "on")} onMouseDown={(e) => e.preventDefault()}
        aria-label={playing ? "Stop the preview" : "Play a preview"} title={playing ? "Stop" : `Play a preview: ${what}`} onClick={() => toggleAudition(chain)}>
        {loading ? <Loader2 className="size-2.5 animate-spin" /> : playing ? <Square className="size-2" fill="currentColor" /> : <Play className="ml-px size-2.5" fill="currentColor" />}
      </button>
      {playing ? <LiveBars width={barsWidth} /> : <MiniWave peaks={peaks} active={false} dryOnly={dryOnly} />}
      {playing && !dryOnly && (
        <button type="button" tabIndex={-1} className="pv-ab" aria-pressed={auditions.which === "after"} onMouseDown={(e) => e.preventDefault()}
          title="Before / After: the sample without the effect, or with it" onClick={() => auditions.setWhich(auditions.which === "after" ? "before" : "after")}>
          {auditions.which === "after" ? "After" : "Before"}
        </button>
      )}
      {playing && note && <span className="pv-wave-note truncate" title={what}>{what}</span>}
    </span>
  );
}

// ── for list rows rendered without a component of their own ─────────────────────────────────────────────

const chains = new Map<string, AuditionChain>();
/** The audition chain of one registry effect (stable per id). */
export function fxChain(id: string): AuditionChain {
  let c = chains.get(id);
  if (!c) { c = { key: `fx:${id}`, effects: [{ id }], group: audioFxDef(id)?.group }; chains.set(id, c); }
  return c;
}
/** Hover handlers (no hooks) for a row: 300 ms on it plays, leaving stops what the hover started. */
export const rowAudition = {
  enter: hoverStart,
  leave: hoverEnd,
};
/** The audition chain of a chain preset (stable per id). */
export function presetChain(p: { id: string; group: string; effects: AuditionChain["effects"] }): AuditionChain {
  const k = `preset:${p.id}`;
  let c = chains.get(k);
  if (!c) { c = { key: k, effects: p.effects, group: p.group }; chains.set(k, c); }
  return c;
}

/** What the playing audition is (the effect, the sample, before / after), else `fallback`. */
export function AuditionNote({ fallback, className }: { fallback?: ReactNode; className?: string }) {
  useAuditions();
  const a = auditions.audition, key = auditions.key;
  if (!a || !key) return <span className={clsx("min-w-0 truncate", className)}>{fallback}</span>;
  const names = a.key.split("|")[0];
  const label = names.startsWith("preset:") ? (CHAIN_PRESETS.find((p) => p.id === names.slice(7))?.name ?? names.slice(7).replace(/_/g, " ")) : (audioFxDef(names.slice(3))?.label ?? names.slice(3));
  return (
    <span className={clsx("min-w-0 truncate", className)} data-audition-note>
      <b className="font-medium text-ink">{label}</b> on {a.sample.label} · {auditions.which === "after" ? "after" : "before"}{a.dry.length ? ` · ${a.dry.join(", ")} rendered by the export only (heard dry)` : ""}
    </span>
  );
}
