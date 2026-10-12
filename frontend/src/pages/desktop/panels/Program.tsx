import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { clamp, shortcutAllowed } from "../../../components/review/utils";
import { api } from "../../../lib/api";
import { publish, throttle } from "../../../lib/bus";
import { isDesktop } from "../../../lib/desktop";
import { fxFilter, fxTransform } from "../../../lib/fx";
import { useT } from "../../../lib/i18n";
import { useEpisode } from "../../../lib/queries";
import { useProjectCtx } from "../../project/context";
import { useTransportBus } from "../../project/finish/transportBus";
import { ratioOf } from "../../project/production/shotMeta";
import { BlendLayer } from "../../project/production/timeline/Blend";
import { LayerPlayback, type LayersDoc } from "../../project/production/timeline/Layers";
import { SequencePlayer } from "../../project/production/timeline/Panels";
import { clipTail, FPS, layoutClips } from "../../project/production/timeline/shared";
import { useTransport, type Transport } from "../../project/production/timeline/transport";

/** Mutes every <video>/<audio> under `root` while `muted` (and only un-mutes the ones it muted). */
function useMuteMedia(root: RefObject<HTMLElement | null>, muted: boolean) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const mine = new Set<HTMLMediaElement>();
    const apply = () => el.querySelectorAll<HTMLMediaElement>("video,audio").forEach((m) => {
      if (muted && !m.muted) { m.muted = true; mine.add(m); }
    });
    if (!muted) return;
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(el, { childList: true, subtree: true });
    return () => { mo.disconnect(); mine.forEach((m) => { m.muted = false; }); };
  }, [root, muted]);
}

/** Hides the cursor after 2 s without movement (clean feed). */
function useIdleCursor(ref: RefObject<HTMLElement | null>, on: boolean) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    let h = window.setTimeout(() => setIdle(true), 2000);
    const move = () => { setIdle(false); window.clearTimeout(h); h = window.setTimeout(() => setIdle(true), 2000); };
    el.addEventListener("pointermove", move);
    return () => { el.removeEventListener("pointermove", move); window.clearTimeout(h); };
  }, [ref, on]);
  return on && idle;
}

/** Double-click → full screen in a browser window (inside the desktop app the window manager does it). */
export function toggleFullscreen() {
  if (isDesktop) return;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  else void document.documentElement.requestFullscreen?.().catch(() => undefined);
}

/** J / K / L, space, arrows, Home / End for a transport. */
export function useTransportKeys(tp: Transport, total: number) {
  const ref = useRef({ tp, total });
  ref.current = { tp, total };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!shortcutAllowed(e)) return;
      const { tp: p, total: tot } = ref.current;
      const map: Record<string, () => void> = {
        " ": () => { if (!e.repeat) p.toggle(); },
        j: () => p.shuttle(-1), J: () => p.shuttle(-1), k: () => p.pause(), K: () => p.pause(), l: () => p.shuttle(1), L: () => p.shuttle(1),
        ArrowLeft: () => p.step(e.shiftKey ? -FPS : -1), ArrowRight: () => p.step(e.shiftKey ? FPS : 1),
        ArrowUp: () => p.jump(-1), ArrowDown: () => p.jump(1), Home: () => p.seek(0), End: () => p.seek(tot),
        f: () => toggleFullscreen(), F: () => toggleFullscreen(),
      };
      const fn = map[e.key];
      if (fn) { e.preventDefault(); fn(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
}

/** The picture alone, letterboxed in black: the clean feed for a client monitor. */
function CleanFrame({ tp, clips, layers, aspect }: { tp: Transport; clips: ReturnType<typeof layoutClips>; layers: LayersDoc | null; aspect: string }) {
  const t = useT();
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const r = ratioOf(aspect);
  const w = Math.max(0, Math.min(box.w, box.h * (r.w / r.h)));
  const h = w * (r.h / r.w);
  const mainRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const clip = clips[tp.idx];
  const hasVideo = !!clip?.src && !tp.broken.has(clip.shot.id);
  return (
    <div ref={stage} className="absolute inset-0 bg-black">
      <div ref={frameRef} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden bg-black [container-type:inline-size]" style={{ width: w, height: h }}>
        <div ref={mainRef} className="absolute inset-0">
          {hasVideo ? (
            <video ref={tp.vref} src={clip.src} playsInline preload="auto" className="h-full w-full object-contain"
              style={{ filter: fxFilter(clip.shot.fx, 1) || undefined, transform: fxTransform(clip.shot.fx) || undefined }}
              onLoadedMetadata={tp.onVideoMeta} onError={() => tp.onVideoError(clip.shot.id)} />
          ) : clip?.still ? (
            <img src={clip.still} alt="" className="h-full w-full object-contain" style={{ filter: fxFilter(clip.shot.fx, 1) || undefined }} />
          ) : <div className="grid h-full place-items-center text-sm text-white/40">{clip ? t("No media for {code}", { code: clip.shot.code }) : ""}</div>}
        </div>
        <BlendLayer tp={tp} clips={clips} mainRef={mainRef} frameRef={frameRef} />
        <LayerPlayback tp={tp} doc={layers} />
      </div>
    </div>
  );
}

/**
 * The program monitor: the cut, played like the timeline's preview (same transport, transitions and layers), slaved to
 * the bus. It follows whichever window is playing (muted, so the sound isn't doubled) and leads as soon as its own
 * controls are used. `clean`: picture only, cursor hidden after 2 s.
 */
export default function ProgramPanel({ clean }: { clean: boolean }) {
  const t = useT();
  const { project, eid, lang } = useProjectCtx();
  const { data: ep, isLoading } = useEpisode(eid, lang);
  const { data: layers } = useQuery({ queryKey: ["layers", eid], queryFn: () => api.get<LayersDoc>(`/api/episodes/${eid}/layers`), enabled: !!eid });
  const shots = useMemo(() => (ep?.shots ?? []).filter((s) => s.include), [ep]);
  const clips = useMemo(() => layoutClips(shots, null, null, layers?.holds), [shots, layers?.holds]);
  const total = clips.length ? clipTail(clips[clips.length - 1]) : 0;
  const tp = useTransport(clips, total);
  const { src, user, following } = useTransportBus(eid, tp, { total, follow: "play" });
  const [showTitles, setShowTitles] = useState(!clean);
  const [showCC, setShowCC] = useState(!clean);
  const root = useRef<HTMLDivElement>(null);
  const slaved = tp.playing && following.current;
  useMuteMedia(root, slaved);
  useTransportKeys(user, total);
  const idle = useIdleCursor(root, clean);
  const music = ep?.music?.find((m) => m.selected) ?? ep?.music?.[0];
  const musicDb = Number(ep?.settings?.music_volume_db ?? -16);

  // tell the scopes and the meter what is on screen (the file and the time in it)
  useEffect(() => {
    const send = throttle(() => {
      const c = clips[tp.idx];
      if (!c?.src) return;
      const v = tp.vref.current;
      const time = v && v.readyState >= 1 ? v.currentTime : c.trimIn + clamp(tp.clock.get() - c.start, 0, c.duration) * c.speed;
      publish({ type: "frame", eid, url: c.src, time, shotId: c.shot.id, filter: fxFilter(c.shot.fx) || undefined, playing: tp.playing, rate: tp.rate * (c.speed || 1) }, src);
    }, 250);
    send();
    return tp.clock.subscribe(send);
  }, [tp.idx, clips, tp.playing, tp.rate, eid, src]);

  // clean feed has no music element of its own: the sequence player normally carries it
  useEffect(() => {
    const m = tp.mref.current;
    if (m) m.volume = Math.min(1, Math.pow(10, musicDb / 20) * 2.5);
  }, [musicDb, music?.url, clean]);

  if (!isLoading && !clips.length) {
    return <div className="grid h-full place-items-center bg-black p-6 text-center text-sm text-white/50">{t("Nothing in the cut yet.")}</div>;
  }
  return (
    <div ref={root} className="relative h-full" onDoubleClick={toggleFullscreen} style={idle ? { cursor: "none" } : undefined}>
      {clean ? (
        <>
          <CleanFrame tp={tp} clips={clips} layers={layers ?? null} aspect={project.aspect} />
          {music?.url && <audio ref={tp.mref} src={music.url} loop preload="auto" onLoadedMetadata={tp.placeMusic} />}
        </>
      ) : (
        <div className="@container grid h-full grid-rows-[minmax(0,1fr)] p-2">
          <SequencePlayer tp={user} clips={clips} musicUrl={music?.url} musicDb={musicDb} aspect={project.aspect} lang={lang} total={total}
            showTitles={showTitles} setShowTitles={setShowTitles} showCC={showCC} setShowCC={setShowCC}
            overlay={<LayerPlayback tp={tp} doc={layers ?? null} />} />
        </div>
      )}
      {slaved && !clean && (
        <span className="mono pointer-events-none absolute right-5 top-12 z-10 rounded bg-black/60 px-1.5 py-0.5 text-2xs uppercase tracking-wider text-white/70">{t("following")}</span>
      )}
    </div>
  );
}
