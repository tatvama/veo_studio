import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Pause, Play, StepBack, StepForward } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { clamp, formatTC, shortcutAllowed } from "../../../components/review/utils";
import { IconButton, Kbd, Select } from "../../../components/ui";
import { api } from "../../../lib/api";
import { lastOf, publish, useBus, useBusSource } from "../../../lib/bus";
import { useT } from "../../../lib/i18n";
import { useEpisode, useShot } from "../../../lib/queries";
import { useProjectCtx } from "../../project/context";
import type { LayersDoc } from "../../project/production/timeline/Layers";
import { FPS } from "../../project/production/timeline/shared";
import { toggleFullscreen } from "./Program";

const VIDEO_KINDS = new Set(["video", "lipsync", "voicelock", "upscale"]);

/**
 * The source monitor: the shot selected in any window (its current take, another take, or a layer media file), with in
 * and out marks that go out on the bus. Keys: Space, J / K / L, ← →, I / O, X clears.
 */
export default function SourcePanel({ clean }: { clean: boolean }) {
  const t = useT();
  const { eid, lang } = useProjectCtx();
  const src = useBusSource();
  const [sid, setSid] = useState<number | null>(() => lastOf("select", eid)?.shotId ?? null);
  useBus("select", (m) => { if (m.shotId) setSid(m.shotId); }, { eid, self: src });
  const { data: ep } = useEpisode(eid, lang);
  const shots = ep?.shots ?? [];
  useEffect(() => { if (!sid && shots.length) setSid(shots.find((s) => s.include)?.id ?? shots[0].id); }, [shots.length]);
  const { data: shot } = useShot(sid, lang);
  const { data: layers } = useQuery({ queryKey: ["layers", eid], queryFn: () => api.get<LayersDoc>(`/api/episodes/${eid}/layers`), enabled: !!eid });
  const [choice, setChoice] = useState("current");
  useEffect(() => setChoice("current"), [sid]);

  const current = shot ? shot.lipsync || shot.voicelock || shot.video : null;
  const takes = (shot?.takes ?? []).filter((x) => VIDEO_KINDS.has(x.kind) && x.url);
  const media = (layers?.media ?? []).filter((m) => m.kind === "video" || m.kind === "audio");
  const url = useMemo(() => {
    if (choice.startsWith("take:")) return takes.find((x) => `take:${x.id}` === choice)?.url ?? "";
    if (choice.startsWith("media:")) return media.find((m) => `media:${m.src}` === choice)?.url ?? "";
    return current?.url ?? "";
  }, [choice, current?.url, takes.length, media.length]);

  const v = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(0);
  const [dur, setDur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [marks, setMarks] = useState<{ in: number | null; out: number | null }>({ in: null, out: null });
  const rev = useRef<number | null>(null);
  useEffect(() => { setMarks({ in: null, out: null }); setNow(0); }, [url]);
  const sendMarks = (m: { in: number | null; out: number | null }) => {
    setMarks(m);
    publish({ type: "marks", eid, in: m.in, out: m.out, shotId: choice === "current" || choice.startsWith("take:") ? sid : null }, src);
  };

  const stopReverse = () => { if (rev.current) { window.clearInterval(rev.current); rev.current = null; } };
  useEffect(() => stopReverse, []);
  // the controls read the latest marks, so they are rebuilt every render (the key handler reads them through the ref)
  const ctl = useRef<Record<"toggle" | "pause" | "fwd" | "back" | "markIn" | "markOut" | "clear", () => void> & { step: (f: number) => void }>(null!);
  ctl.current = {
    toggle: () => { const el = v.current; if (!el) return; stopReverse(); if (el.paused) void el.play().catch(() => undefined); else el.pause(); },
    pause: () => { stopReverse(); v.current?.pause(); if (v.current) v.current.playbackRate = 1; },
    fwd: () => {
      const el = v.current; if (!el) return;
      stopReverse();
      if (!el.paused) el.playbackRate = Math.min(4, el.playbackRate * 2);
      else { el.playbackRate = 1; void el.play().catch(() => undefined); }
    },
    back: () => {
      const el = v.current; if (!el) return;
      el.pause();
      if (rev.current) return;
      rev.current = window.setInterval(() => { if (!v.current) return; v.current.currentTime = Math.max(0, v.current.currentTime - 0.1); setNow(v.current.currentTime); }, 100);
    },
    step: (f: number) => { const el = v.current; if (!el) return; stopReverse(); el.pause(); el.currentTime = clamp(el.currentTime + f / FPS, 0, el.duration || 0); },
    markIn: () => { const el = v.current; if (el) sendMarks({ in: el.currentTime, out: marks.out !== null && marks.out <= el.currentTime ? null : marks.out }); },
    markOut: () => { const el = v.current; if (el) sendMarks({ in: marks.in !== null && marks.in >= el.currentTime ? null : marks.in, out: el.currentTime }); },
    clear: () => sendMarks({ in: null, out: null }),
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!shortcutAllowed(e)) return;
      const c = ctl.current;
      const map: Record<string, () => void> = {
        " ": () => { if (!e.repeat) c.toggle(); }, k: c.pause, K: c.pause, l: c.fwd, L: c.fwd, j: c.back, J: c.back,
        ArrowLeft: () => c.step(e.shiftKey ? -FPS : -1), ArrowRight: () => c.step(e.shiftKey ? FPS : 1),
        i: c.markIn, I: c.markIn, o: c.markOut, O: c.markOut, x: c.clear, X: c.clear, f: toggleFullscreen, F: toggleFullscreen,
      };
      const fn = map[e.key];
      if (fn) { e.preventDefault(); fn(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!clean) return;
    let h = window.setTimeout(() => setIdle(true), 2000);
    const move = () => { setIdle(false); window.clearTimeout(h); h = window.setTimeout(() => setIdle(true), 2000); };
    window.addEventListener("pointermove", move);
    return () => { window.removeEventListener("pointermove", move); window.clearTimeout(h); };
  }, [clean]);

  const video = (
    <video ref={v} src={url || undefined} playsInline preload="auto" className="h-full w-full object-contain"
      onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} onSeeked={(e) => setNow(e.currentTarget.currentTime)}
      onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
      onClick={() => ctl.current.toggle()} />
  );
  if (clean) {
    return (
      <div className="h-full bg-black" onDoubleClick={toggleFullscreen} style={idle ? { cursor: "none" } : undefined}>
        {url ? video : null}
      </div>
    );
  }

  const pct = (x: number | null) => (x === null || !dur ? 0 : (x / dur) * 100);
  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={sid ?? ""} onChange={(e) => setSid(Number(e.target.value) || null)} aria-label={t("Shot")} className="!h-8 w-auto max-w-[40%] text-xs">
          {shots.map((s) => <option key={s.id} value={s.id}>{s.code}{s.include ? "" : ` (${t("not in cut")})`}</option>)}
        </Select>
        <Select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label={t("Media")} className="!h-8 w-auto min-w-0 flex-1 text-xs">
          <option value="current">{t("Current take")}{current ? ` · ${current.kind}` : ""}</option>
          {takes.length > 0 && (
            <optgroup label={t("Takes")}>
              {takes.map((x, i) => <option key={x.id} value={`take:${x.id}`}>{`${x.kind} ${i + 1}${x.language ? ` · ${x.language}` : ""}${x.selected ? ` · ${t("selected")}` : ""} · ${x.duration_s.toFixed(1)}s`}</option>)}
            </optgroup>
          )}
          {media.length > 0 && (
            <optgroup label={t("Layer media")}>
              {media.map((m) => <option key={m.src} value={`media:${m.src}`}>{m.name}</option>)}
            </optgroup>
          )}
        </Select>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-black" onDoubleClick={toggleFullscreen}>
        {url ? video : <div className="grid h-full place-items-center text-sm text-white/50">{shot ? t("{code} has no video yet", { code: shot.code }) : t("Select a shot on the timeline")}</div>}
        {shot && <span className="mono pointer-events-none absolute left-3 top-3 rounded bg-black/55 px-1.5 py-0.5 text-2xs uppercase tracking-wider text-white/85">{shot.code}</span>}
      </div>
      <div className="space-y-1.5">
        <div className="relative h-6">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-line" />
          {(marks.in !== null || marks.out !== null) && (
            <div aria-hidden className="pointer-events-none absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent/70 shadow-[0_0_8px_var(--color-accent)]"
              style={{ left: `${pct(marks.in ?? 0)}%`, right: `${100 - (marks.out !== null ? pct(marks.out) : 100)}%` }} />
          )}
          <input type="range" min={0} max={dur || 1} step={1 / FPS} value={Math.min(now, dur || 1)} aria-label={t("Position")}
            onChange={(e) => { const el = v.current; if (el) el.currentTime = Number(e.target.value); }}
            className="absolute inset-0 w-full cursor-pointer opacity-0" />
          <div aria-hidden className="pointer-events-none absolute top-0 h-6 w-0.5 bg-accent" style={{ left: `${pct(now)}%` }} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <IconButton title={t("Previous frame (←)")} onClick={() => ctl.current.step(-1)}><StepBack className="size-4" /></IconButton>
          <IconButton title={playing ? t("Pause") : t("Play")} onClick={() => ctl.current.toggle()} className="btn-primary !text-black"><span>{playing ? <Pause className="size-4" fill="currentColor" /> : <Play className="size-4" fill="currentColor" />}</span></IconButton>
          <IconButton title={t("Next frame (→)")} onClick={() => ctl.current.step(1)}><StepForward className="size-4" /></IconButton>
          <span className="mono ml-1 text-sm tabular-nums">{formatTC(now, FPS)}</span>
          <span className="mono text-2xs text-dim">/ {formatTC(dur, FPS, true)}</span>
          <span className="flex-1" />
          <button type="button" onClick={() => ctl.current.markIn()} className={clsx("mono inline-flex h-7 items-center gap-1 rounded-md border px-2 text-2xs", marks.in !== null ? "border-accent/40 text-accent-ink" : "border-line text-mute hover:text-ink")}>
            <Kbd>I</Kbd>{marks.in !== null ? formatTC(marks.in, FPS, true) : t("In")}
          </button>
          <button type="button" onClick={() => ctl.current.markOut()} className={clsx("mono inline-flex h-7 items-center gap-1 rounded-md border px-2 text-2xs", marks.out !== null ? "border-accent/40 text-accent-ink" : "border-line text-mute hover:text-ink")}>
            <Kbd>O</Kbd>{marks.out !== null ? formatTC(marks.out, FPS, true) : t("Out")}
          </button>
          {(marks.in !== null || marks.out !== null) && (
            <span className="mono text-2xs tabular-nums text-dim">{(((marks.out ?? dur) - (marks.in ?? 0))).toFixed(2)}s</span>
          )}
        </div>
      </div>
    </div>
  );
}
