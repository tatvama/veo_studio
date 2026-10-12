/**
 * Program monitor (docs/EDITOR.md §3): the active sequence drawn by the GPU engine (editor/engine.ts drawLive),
 * driven by the program transport, with its sound through the WebAudio mixer. Safe margins, playback resolution
 * (full / ½ / ¼), zoom (fit / 100 % / 50 %), in / out, markers, lift / extract, timecode and dropped frames.
 */
import { clsx } from "clsx";
import { Activity, AlertTriangle, ArrowUpFromLine, Bookmark, Frame, MonitorPlay, Move, PanelTopClose } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as A from "../actions";
import { demoCustomSources } from "../demoSources";
import { currentDrag, isEditorDrag } from "../dnd";
import { buildComposition, createPreview, type PreviewEngine } from "../engine";
import { markedRange, seqEnd } from "../model/ops";
import { shortDuration } from "../model/time";
import { toAudioMix } from "../model/toComposition";
import "../../pages/posters/fonts";
import { ensureFont } from "../render/title";
import { mixer } from "../playback/audio";
import { playProgram } from "../playback/control";
import { program, useFrame, usePlayState } from "../playback/transport";
import { audioUrlFor, ed, setFocus, urlFor, useEditor, useProject, useSequence } from "../store";
import { IBtn, TimecodeField } from "../ui";
import { fitSize, ScrubBar, TransportButtons } from "./monitor";
import { setProgramReader } from "../moods/programTap";
import { MotionOverlay } from "./MotionOverlay";
import "./MotionOverlay.css";

/** Additive (editor-looks): the scopes overlay, loaded when it's first shown. */
const ScopesOverlay = lazy(() => import("./Scopes").then((m) => ({ default: m.ScopesOverlay })));

const lsNum = (k: string, d: number) => { try { const v = Number(localStorage.getItem(k)); return Number.isFinite(v) && v > 0 ? v : d; } catch { return d; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } };
/** Imported LUTs by their runtime URL; the rest falls through to the builder (team LUTs, preset looks). */
const lutUrl = (look: string) => (look.startsWith("lut:") ? ed().urls[look] : undefined);


export default function ProgramMonitor() {
  const s = useSequence();
  const p = useProject();
  const urls = useEditor((x) => x.urls);
  const holder = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const eng = useRef<PreviewEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [res, setRes] = useState(() => lsNum("tatvam-editor:program-res", 1));
  // the engine draws at 1, ½ or ¼ of the sequence size and scales up (drawLive's resolution)
  const resRef = useRef(1 / res);
  resRef.current = 1 / res;
  const [zoomMode, setZoomMode] = useState<"fit" | number>("fit");
  const [safe, setSafe] = useState(false);
  // editor-motion: the Motion overlay (box, handles, motion path) for the selected clip
  const [motionUi, setMotionUi] = useState(() => lsNum("tatvam-editor:motion-overlay", 1) === 1);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const [scopes, setScopes] = useState(false);

  // the engine draws into its own canvas (a lost WebGL context can't be reused)
  useEffect(() => {
    let alive = true;
    const c = document.createElement("canvas");
    c.className = "block";
    holder.current?.appendChild(c);
    createPreview(c, Math.max(2, s.width), Math.max(2, s.height))
      .then((e) => { if (!alive) { e.dispose(); return; } eng.current = e; setProgramReader(() => eng.current?.readFrame() ?? null); setReady(true); })
      .catch((e) => setFailed((e as Error).message || "WebGL2 isn't available"));
    return () => { alive = false; setProgramReader(null); eng.current?.dispose(); eng.current = null; c.remove(); setReady(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // render size: the sequence's (the playback resolution is applied per draw)
  useEffect(() => { eng.current?.resize(Math.max(2, s.width), Math.max(2, s.height)); redraw(); }, [ready, s.width, s.height, res]);

  // stage size → the canvas's display size
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth - 16, h: el.clientHeight - 16 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const disp = fitSize(box.w, box.h, s.width, s.height, zoomMode);
  useEffect(() => {
    const c = eng.current?.canvas;
    if (c) { c.style.width = `${disp.w}px`; c.style.height = `${disp.h}px`; }
  }, [disp.w, disp.h, ready]);

  // the sequence → a composition, loaded (debounced while it changes quickly, e.g. during a drag)
  const result = useMemo(() => buildComposition(p, s.id, { urlFor, lutUrl }), [p, s.id, urls, ready]);
  useEffect(() => {
    if (!ready) return;
    const wait = ed().h.gesture ? 220 : 40;
    const id = window.setTimeout(async () => {
      const e = eng.current;
      if (!e) return;
      await e.load(result, demoCustomSources());
      setWarnings([...new Set([...result.warnings, ...e.warnings()])]);
      redraw();
    }, wait);
    return () => window.clearTimeout(id);
  }, [ready, result]);

  // titles: their fonts load on first use; draw again once they're in
  useEffect(() => {
    const specs = s.clips.filter((c) => c.source.type === "title").map((c) => (c.source as { text: Parameters<typeof ensureFont>[0] }).text);
    if (!specs.length) return;
    let alive = true;
    void Promise.all(specs.map(ensureFont)).then(() => { if (alive) redraw(); });
    return () => { alive = false; };
  }, [s.clips]);

  // sound
  useEffect(() => { mixer.setMix(toAudioMix(p, s.id, { urlFor: audioUrlFor })); mixer.sync(program.time, program.playing, program.rate); }, [p, s.id, urls]);
  useEffect(() => () => mixer.stopAll(), []);

  // drawing: every playback tick, and a short settle loop after a seek while paused (videos decode a moment later)
  const settle = useRef(0);
  function redraw() {
    const e = eng.current;
    if (!e) return;
    e.draw(program.time, { playing: program.playing, rate: program.rate, resolution: resRef.current });
    if (!program.playing) {
      const until = performance.now() + 700;
      if (settle.current) return;
      const loop = () => {
        if (program.playing || performance.now() > until || !eng.current) { settle.current = 0; return; }
        eng.current.draw(program.time, { playing: false, rate: 1, resolution: resRef.current });
        settle.current = requestAnimationFrame(loop);
      };
      settle.current = requestAnimationFrame(loop);
    }
  }
  useEffect(() => program.onTick((t) => {
    if (program.playing) eng.current?.draw(t, { playing: true, rate: program.rate, resolution: resRef.current }); else redraw();
    mixer.sync(t, program.playing, program.rate);
  }), []);
  useEffect(() => program.subscribeState(() => { if (!program.playing) { mixer.sync(program.time, false, 1); redraw(); } }), []);

  const range = markedRange(s);
  const len = seqEnd(s);
  const sw = disp.w, sh = disp.h;
  return (
    <div className="mon" onPointerDown={() => setFocus("program")}>
      <div ref={stage} className={clsx("mon-stage", over && "ring-2 ring-inset ring-accent")}
        onDragOver={(e) => { if (isEditorDrag(e) && currentDrag(e)?.kind === "media") { e.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const pay = currentDrag(e);
          if (pay?.kind !== "media") return;
          e.preventDefault();
          for (const it of pay.items.slice(0, 1)) A.sourceEdit(e.ctrlKey ? "insert" : "overwrite", { mediaId: it.mediaId, video: it.video, audio: it.audio });
        }}>
        <div ref={holder} className="relative" style={{ width: sw || undefined, height: sh || undefined }}>
          {safe && sw > 0 && (
            <>
              <div className="mon-safe" style={{ left: sw * 0.05, top: sh * 0.05, width: sw * 0.9, height: sh * 0.9 }} title="Action safe (90 %)" />
              <div className="mon-safe border-dashed" style={{ left: sw * 0.1, top: sh * 0.1, width: sw * 0.8, height: sh * 0.8 }} title="Title safe (80 %)" />
              <div className="mon-safe" style={{ left: sw / 2 - 8, top: sh / 2, width: 16, height: 0 }} />
              <div className="mon-safe" style={{ left: sw / 2, top: sh / 2 - 8, width: 0, height: 16 }} />
            </>
          )}
          {motionUi && sw > 0 && <MotionOverlay seq={s} w={sw} h={sh} />}
        </div>
        {!len && ready && <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-white/60"><div className="text-center"><MonitorPlay className="mx-auto mb-2 size-8 opacity-60" />Drag clips onto the timeline, or open one in the Source monitor and press , or .</div></div>}
        {failed && <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-red-300">The GPU engine couldn't start: {failed}</div>}
        {warnings.length > 0 && (
          <div className="mon-badge left-2 top-2 flex cursor-help items-center gap-1 text-amber-300" title={warnings.join("\n")}>
            <AlertTriangle className="size-3" />{warnings.length} note{warnings.length === 1 ? "" : "s"}
          </div>
        )}
        <Dropped />
        {scopes && ready && <Suspense fallback={null}><ScopesOverlay /></Suspense>}
        {res !== 1 && <div className="mon-badge bottom-2 left-2">{res === 2 ? "½" : "¼"} resolution</div>}
      </div>
      <ScrubBar tr={program} length={Math.max(len, 1)} inPoint={s.inPoint} outPoint={s.outPoint} markers={s.markers} />
      <div className="ed-bar bottom gap-1.5">
        <Tc fps={s.fps} />
        <div className="flex items-center gap-0.5">
          <IBtn title="Mark in" shortcut="I" side="top" onClick={() => A.markIn()}><span className="mono text-sm font-semibold">{"{"}</span></IBtn>
          <IBtn title="Mark out" shortcut="O" side="top" onClick={() => A.markOut()}><span className="mono text-sm font-semibold">{"}"}</span></IBtn>
          <IBtn title="Add marker" shortcut="M" side="top" onClick={() => A.addSeqMarker()}><Bookmark className="size-3.5" /></IBtn>
        </div>
        <div className="mx-auto">
          <TransportButtons tr={program} onPlay={playProgram} onIn={() => A.gotoInOut("in")} onOut={() => A.gotoInOut("out")} onPrevEdit={() => A.gotoEdit(-1)} onNextEdit={() => A.gotoEdit(1)} />
        </div>
        <div className="flex items-center gap-0.5">
          <IBtn title="Lift" shortcut=";" side="top" onClick={() => A.liftExtract("lift")}><ArrowUpFromLine className="size-3.5" /></IBtn>
          <IBtn title="Extract" shortcut="'" side="top" onClick={() => A.liftExtract("extract")}><PanelTopClose className="size-3.5" /></IBtn>
          <IBtn title="Safe margins" side="top" on={safe} onClick={() => setSafe((v) => !v)}><Frame className="size-3.5" /></IBtn>
          <IBtn title="Scopes overlay" side="top" on={scopes} onClick={() => setScopes((v) => !v)}><Activity className="size-3.5" /></IBtn>
          <IBtn title="Motion overlay: move, scale and rotate the selected clip on the picture; its motion path" side="top" on={motionUi}
            onClick={() => setMotionUi((v) => { lsSet("tatvam-editor:motion-overlay", v ? "2" : "1"); return !v; })}><Move className="size-3.5" /></IBtn>
        </div>
        <select className="ed-field" value={String(zoomMode)} title="Zoom" onChange={(e) => setZoomMode(e.target.value === "fit" ? "fit" : Number(e.target.value))}>
          <option value="fit">Fit</option><option value="1">100%</option><option value="0.5">50%</option><option value="0.25">25%</option>
        </select>
        <select className="ed-field" value={res} title="Playback resolution" onChange={(e) => { const v = Number(e.target.value); setRes(v); lsSet("tatvam-editor:program-res", String(v)); }}>
          <option value={1}>Full</option><option value={2}>½</option><option value={4}>¼</option>
        </select>
        <span className="mono w-[4.5rem] text-right text-2xs text-dim" title={range ? "In to out" : "Sequence length"}>{shortDuration(range ? range[1] - range[0] : len, s.fps)}</span>
      </div>
    </div>
  );
}

function Tc({ fps }: { fps: number }) {
  const f = useFrame(program);
  return <TimecodeField frame={f} fps={fps} className="text-accent-ink" onChange={(v) => program.seek(v)} />;
}

function Dropped() {
  const { playing, dropped } = usePlayState(program);
  if (!playing) return null;
  return <div className={clsx("mon-badge right-2 top-2 mono", dropped > 0 && "text-amber-300")} title="Frames skipped in the last second of playback">{dropped} dropped</div>;
}
