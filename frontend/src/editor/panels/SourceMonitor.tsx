/**
 * Source monitor (docs/EDITOR.md §3): plays a media item from its URL (video, audio with its waveform, or a still),
 * with in / out (I / O), markers (M), insert (,) and overwrite (.), and drag handles for video only / audio only.
 * Its transport counts the media's own frames (sequence frames for sound and stills).
 */
import { AudioLines, Bookmark, Film, FolderOpen, Grid2x2, ListPlus, Replace } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as A from "../actions";
import { customSource } from "../demoSources";
import { startDrag } from "../dnd";
import { toTimecode, shortDuration } from "../model/time";
import type { MediaItem } from "../model/types";
import { playSource } from "../playback/control";
import { source, useFrame } from "../playback/transport";
import { peaksFor } from "../timeline/draw";
import { audioUrlFor, setFocus, urlFor, useEditor, useProject } from "../store";
import { IBtn, TimecodeField } from "../ui";
import { fitSize, ScrubBar, TransportButtons } from "./monitor";
import { MulticamGrid } from "./MulticamGrid";
import { setMulticamView, useSequence } from "../store";


export default function SourceMonitor() {
  const id = useEditor((x) => x.sourceId);
  useEditor((x) => x.urls);
  const multicam = useEditor((x) => x.multicamView);
  const hasMulticam = useSequence().clips.some((c) => c.multicam);
  const p = useProject();
  const m = id ? p.media.find((x) => x.id === id) : undefined;
  if (multicam) return <MulticamGrid />;
  if (!m) {
    return (
      <div className="mon" onPointerDown={() => setFocus("source")}>
        <div className="pn-empty"><div><FolderOpen className="mx-auto mb-2 size-7 text-dim" />Double-click a clip in the Project panel (or on the timeline) to open it here.<br />Mark in and out with I and O, then insert (,) or overwrite (.).
          {hasMulticam && <><br /><button type="button" className="mt-2 text-accent-ink hover:underline" onClick={() => setMulticamView(true)}>Show the multicam angles</button></>}</div></div>
      </div>
    );
  }
  return <SourceView key={m.id} m={m} />;
}

function SourceView({ m }: { m: MediaItem }) {
  const fps = A.displayFps(m);
  const len = A.displayLength(m);
  const url = urlFor(m);
  const custom = customSource(m.url);
  const sound = audioUrlFor(m);
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const extraAudio = useRef<HTMLAudioElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => { source.configure(fps, len); if (source.frame >= len) source.seek(0); }, [fps, len]);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth - 12, h: el.clientHeight - 12 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the media follows the source transport
  useEffect(() => {
    const follow = (t: number) => {
      const els = [video.current, extraAudio.current].filter(Boolean) as HTMLMediaElement[];
      for (const el of els) {
        if (source.playing && source.rate > 0 && source.rate <= 4) {
          el.playbackRate = source.rate;
          if (el.paused) { el.currentTime = t; void el.play().catch(() => undefined); }
          else if (Math.abs(el.currentTime - t) > 0.15) el.currentTime = t;
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - t) > 0.5 / fps && el.readyState > 0) el.currentTime = t;
        }
      }
      if (custom && cv.current) {
        const g = cv.current.getContext("2d");
        const img = custom.draw(t);
        if (g) g.drawImage(img as CanvasImageSource, 0, 0, cv.current.width, cv.current.height);
      }
    };
    follow(source.time);
    const offT = source.onTick(follow);
    const offS = source.subscribeState(() => follow(source.time));
    return () => { offT(); offS(); video.current?.pause(); extraAudio.current?.pause(); };
  }, [m.id, fps, custom]);
  useEffect(() => () => source.pause(), []);

  const w = m.width || 1920, h = m.height || 1080;
  const disp = m.kind === "audio" ? { w: box.w, h: box.h } : fitSize(box.w, box.h, w, h, "fit");
  const dragBoth = (e: React.DragEvent, video = true, audio = true) =>
    startDrag(e, { kind: "media", items: [{ mediaId: m.id, video, audio }] }, `${m.name}${!audio ? " (video)" : !video ? " (audio)" : ""}`);
  const inD = m.inPoint !== undefined ? A.srcToDisplay(m, m.inPoint) : undefined;
  const outD = m.outPoint !== undefined ? A.srcToDisplay(m, m.outPoint) : undefined;
  const markers = useMemo(() => m.markers.map((x) => ({ ...x, frame: A.srcToDisplay(m, x.frame) })), [m]);
  return (
    <div className="mon" onPointerDown={() => setFocus("source")}>
      <div ref={stage} className="mon-stage" draggable onDragStart={(e) => dragBoth(e)}>
        {m.kind === "image" ? (
          url ? <img src={url} alt="" style={{ width: disp.w, height: disp.h }} draggable={false} /> : null
        ) : custom ? (
          <canvas ref={cv} width={Math.max(2, Math.min(1280, w))} height={Math.max(2, Math.round(Math.min(1280, w) * (h / w)))} style={{ width: disp.w, height: disp.h }} />
        ) : m.kind === "video" ? (
          url ? <video ref={video} src={url} preload="auto" playsInline style={{ width: disp.w, height: disp.h }} /> : null
        ) : (
          <>
            {url && <video ref={video} src={url} preload="auto" className="hidden" />}
            <Waveform m={m} url={url} width={disp.w} height={disp.h} />
          </>
        )}
        {custom && sound && <audio ref={extraAudio} src={sound} preload="auto" className="hidden" />}
        {!url && !custom && <div className="absolute inset-0 grid place-items-center text-sm text-red-300">Media offline — relink it from the Project panel</div>}
        <div className="mon-badge left-2 top-2 max-w-[70%] truncate">{m.name}</div>
        <InOutBadge fps={fps} inD={inD} outD={outD} len={len} />
      </div>
      <ScrubBar tr={source} length={len} inPoint={inD} outPoint={outD} markers={markers} />
      <div className="ed-bar bottom gap-1.5">
        <Tc fps={fps} />
        <div className="flex items-center gap-0.5">
          <IBtn title="Mark in" shortcut="I" side="top" onClick={() => A.sourceMark("in")}><span className="mono text-sm font-semibold">{"{"}</span></IBtn>
          <IBtn title="Mark out" shortcut="O" side="top" onClick={() => A.sourceMark("out")}><span className="mono text-sm font-semibold">{"}"}</span></IBtn>
          <IBtn title="Add marker" shortcut="M" side="top" onClick={() => A.sourceMarker()}><Bookmark className="size-3.5" /></IBtn>
        </div>
        <div className="mx-auto">
          <TransportButtons tr={source} onPlay={playSource} onIn={() => inD !== undefined && source.seek(inD)} onOut={() => outD !== undefined && source.seek(outD)} />
        </div>
        <div className="flex items-center gap-0.5">
          {m.kind !== "audio" && (
            <span draggable onDragStart={(e) => { e.stopPropagation(); dragBoth(e, true, false); }} title="Drag the picture only" className="ed-ibtn cursor-grab"><Film className="size-3.5" /></span>
          )}
          {(m.kind === "audio" || m.hasAudio) && (
            <span draggable onDragStart={(e) => { e.stopPropagation(); dragBoth(e, false, true); }} title="Drag the sound only" className="ed-ibtn cursor-grab"><AudioLines className="size-3.5" /></span>
          )}
          <IBtn title="Multicam angles of the clip under the playhead" side="top" onClick={() => setMulticamView(true)}><Grid2x2 className="size-3.5" /></IBtn>
          <IBtn title="Insert at the playhead" shortcut="," side="top" onClick={() => A.sourceEdit("insert")}><ListPlus className="size-3.5" /></IBtn>
          <IBtn title="Overwrite at the playhead" shortcut="." side="top" onClick={() => A.sourceEdit("overwrite")}><Replace className="size-3.5" /></IBtn>
        </div>
      </div>
    </div>
  );
}

function Tc({ fps }: { fps: number }) {
  const f = useFrame(source);
  return <TimecodeField frame={f} fps={fps} className="text-accent-ink" onChange={(v) => source.seek(v)} />;
}

function InOutBadge({ fps, inD, outD, len }: { fps: number; inD?: number; outD?: number; len: number }) {
  const a = inD ?? 0, b = outD !== undefined ? outD + 1 : len;
  return (
    <div className="mon-badge right-2 top-2 mono" title={`In ${toTimecode(a, fps)} · Out ${toTimecode(b - 1, fps)}`}>
      {inD !== undefined || outD !== undefined ? `${shortDuration(b - a, fps)} marked` : shortDuration(len, fps)}
    </div>
  );
}

/** The whole file's waveform with the playhead (sound files). */
function Waveform({ m, url, width, height }: { m: MediaItem; url?: string; width: number; height: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const len = A.displayLength(m);
  useEffect(() => {
    let alive = true;
    void peaksFor(m, url).then((pk) => {
      const c = cv.current;
      if (!alive || !c || !pk || width < 2) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.round(width * dpr); c.height = Math.round(height * dpr);
      const g = c.getContext("2d")!;
      g.clearRect(0, 0, c.width, c.height);
      g.fillStyle = getComputedStyle(c).color;
      const n = pk.peaks.length, W = c.width, H = c.height;
      for (let x = 0; x < W; x++) {
        let mx = 0;
        for (let i = Math.floor((x / W) * n); i < Math.ceil(((x + 1) / W) * n); i++) mx = Math.max(mx, pk.peaks[i] ?? 0);
        const y = Math.max(1, mx * H * 0.45);
        g.fillRect(x, H / 2 - y, 1, y * 2);
      }
    });
    return () => { alive = false; };
  }, [m, url, width, height]);
  useEffect(() => {
    const place = () => { if (head.current) head.current.style.left = `${(source.frame / Math.max(1, len)) * 100}%`; };
    place();
    return source.subscribe(place);
  }, [len]);
  return (
    <div className="relative" style={{ width, height }}>
      <canvas ref={cv} className={"absolute inset-0 text-ok/80"} style={{ width, height }} />
      <div ref={head} className="absolute bottom-0 top-0 w-px bg-bad" />
    </div>
  );
}
