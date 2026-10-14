/**
 * News Room: the other ratio's monitor (docs/EDITOR.md §16.7–16.8). A both-ratio news edit has one timeline and two
 * outputs: this draws the 9:16 (or 16:9) picture made on the fly (companion.ts) — graphics in that ratio's design,
 * pictures in the layout boxes or reframed — on the GPU engine, following the program clock as it plays or scrubs.
 * Safe areas for that ratio on a toggle. Other edits get a button to turn both ratios on.
 */
import { clsx } from "clsx";
import { Frame, RectangleVertical } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../components/ui";
import { demoCustomSources } from "../../demoSources";
import { buildComposition, createPreview, type PreviewEngine } from "../../engine";
import { seqEnd } from "../../model/ops";
import { program, useFrame } from "../../playback/transport";
import { ed, setFocus, urlFor, useEditor, useProject, useSequence } from "../../store";
import { IBtn, TimecodeField } from "../../ui";
import { fitSize, ScrubBar } from "../../panels/monitor";
import { ensureNewsroom } from "../commands";
import { companionProject } from "../companion";
import { ratioOf } from "../render/index";
import type { GfxRatio } from "../types";
import { host } from "../room/actions";
import { useNewsBoot } from "../room/NewNewsEdit";

const lutUrl = (look: string) => (look.startsWith("lut:") ? ed().urls[look] : undefined);
const lsGet = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } };

export default function CompanionMonitor() {
  useNewsBoot();
  const both = useEditor((x) => x.h.present.newsroom?.ratio === "both");
  const s = useSequence();
  const other: GfxRatio = ratioOf(s.width, s.height) === "9:16" ? "16:9" : "9:16";
  if (!both) return <Off other={other} />;
  return <Monitor other={other} />;
}

function Off({ other }: { other: GfxRatio }) {
  const turnOn = () => host().apply("Both ratios", (d) => { ensureNewsroom(d).ratio = "both"; });
  return (
    <div className="pn-empty" onPointerDown={() => setFocus("other")}>
      <div className="max-w-[240px] space-y-3">
        <RectangleVertical className="mx-auto size-7 text-dim" />
        <p>This monitor shows the {other} version of a news edit made for both 16:9 and 9:16.</p>
        <Button size="sm" variant="primary" onClick={turnOn}>Make both ratios</Button>
        <p className="text-2xs text-dim">One timeline, two outputs: graphics use their {other} design and pictures are reframed to fill. Exports can make both at once.</p>
      </div>
    </div>
  );
}

/** Safe areas as frame fractions [x, y, w, h]: graphics-safe, and for 9:16 the space Reels and Shorts keep clear. */
function safeBoxes(r: GfxRatio): { box: [number, number, number, number]; title: string; dashed?: boolean }[] {
  if (r === "9:16") return [
    { box: [0.05, 0.12, 0.79, 0.66], title: "Clear of the app's buttons: top 12 %, bottom 22 %, right 16 %" },
    { box: [0.05, 0.05, 0.9, 0.9], title: "Graphics safe (5 %)", dashed: true },
  ];
  return [{ box: [0.05, 0.05, 0.9, 0.9], title: "Graphics safe (5 %)" }, { box: [0.1, 0.1, 0.8, 0.8], title: "Title safe (10 %)", dashed: true }];
}

function Monitor({ other }: { other: GfxRatio }) {
  const p = useProject();
  const s = useSequence();
  const urls = useEditor((x) => x.urls);
  const holder = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const eng = useRef<PreviewEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [safe, setSafe] = useState(() => lsGet("tatvam-editor:nr-companion-safe", "1") === "1");
  const [res, setRes] = useState(() => Number(lsGet("tatvam-editor:nr-companion-res", "2")) || 2);
  const resRef = useRef(1 / res);
  resRef.current = 1 / res;

  // the other ratio's project, made on the fly
  const comp = useMemo(() => { try { return companionProject(p, s.id, other); } catch (e) { console.warn("[newsroom] companion", e); return null; } }, [p, s.id, other]);
  const cs = comp?.project.sequences.find((x) => x.id === comp.sequenceId);
  const W = Math.max(2, cs?.width ?? (other === "9:16" ? 1080 : 1920)), H = Math.max(2, cs?.height ?? (other === "9:16" ? 1920 : 1080));
  const result = useMemo(() => (comp ? buildComposition(comp.project, comp.sequenceId, { urlFor, lutUrl }) : null), [comp, urls, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    const c = document.createElement("canvas");
    c.className = "block";
    holder.current?.appendChild(c);
    createPreview(c, W, H)
      .then((e) => { if (!alive) { e.dispose(); return; } eng.current = e; setReady(true); })
      .catch((e) => setFailed((e as Error).message || "WebGL2 isn't available"));
    return () => { alive = false; eng.current?.dispose(); eng.current = null; c.remove(); setReady(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { eng.current?.resize(W, H); redraw(); }, [ready, W, H, res]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth - 12, h: el.clientHeight - 12 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const disp = fitSize(box.w, box.h, W, H, "fit");
  useEffect(() => { const c = eng.current?.canvas; if (c) { c.style.width = `${disp.w}px`; c.style.height = `${disp.h}px`; } }, [disp.w, disp.h, ready]);

  useEffect(() => {
    if (!ready || !result) return;
    const id = window.setTimeout(async () => { const e = eng.current; if (!e) return; await e.load(result, demoCustomSources()); redraw(2500); }, ed().h.gesture ? 260 : 60);
    return () => window.clearTimeout(id);
  }, [ready, result]); // eslint-disable-line react-hooks/exhaustive-deps

  // a short settle loop while paused (videos decode a moment later); a redraw while it runs extends it, and a reload
  // gives a clip that just arrived time to open
  const settle = useRef(0);
  const settleUntil = useRef(0);
  function redraw(settleMs = 600) {
    const e = eng.current;
    if (!e) return;
    e.draw(program.time, { playing: program.playing, rate: program.rate, resolution: resRef.current });
    if (program.playing) return;
    settleUntil.current = Math.max(settleUntil.current, performance.now() + settleMs);
    if (settle.current) return;
    const loop = () => {
      if (program.playing || performance.now() > settleUntil.current || !eng.current) { settle.current = 0; return; }
      eng.current.draw(program.time, { playing: false, rate: 1, resolution: resRef.current });
      settle.current = requestAnimationFrame(loop);
    };
    settle.current = requestAnimationFrame(loop);
  }
  useEffect(() => program.onTick((t) => { if (program.playing) eng.current?.draw(t, { playing: true, rate: program.rate, resolution: resRef.current }); else redraw(); }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => program.subscribeState(() => { if (!program.playing) redraw(); }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const len = seqEnd(s);
  return (
    <div className="mon" onPointerDown={() => setFocus("program")}>
      <div ref={stage} className="mon-stage">
        <div ref={holder} className="relative" style={{ width: disp.w || undefined, height: disp.h || undefined }}>
          {safe && disp.w > 0 && safeBoxes(other).map((b, i) => (
            <div key={i} className={clsx("mon-safe", b.dashed && "border-dashed opacity-70")} title={b.title}
              style={{ left: disp.w * b.box[0], top: disp.h * b.box[1], width: disp.w * b.box[2], height: disp.h * b.box[3] }} />
          ))}
        </div>
        <div className="mon-badge left-2 top-2">{other}</div>
        {failed && <div className="absolute inset-0 grid place-items-center p-4 text-center text-xs text-red-300">The GPU engine couldn't start: {failed}</div>}
        {!comp && !failed && <div className="absolute inset-0 grid place-items-center p-4 text-center text-xs text-white/60">The {other} picture isn't ready for this edit.</div>}
      </div>
      <ScrubBar tr={program} length={Math.max(len, 1)} inPoint={s.inPoint} outPoint={s.outPoint} markers={s.markers} />
      <div className="ed-bar bottom gap-1">
        <Tc fps={s.fps} />
        <div className="flex-1" />
        <IBtn title="Safe areas" side="top" on={safe} onClick={() => setSafe((v) => { lsSet("tatvam-editor:nr-companion-safe", v ? "0" : "1"); return !v; })}><Frame className="size-3.5" /></IBtn>
        <select className="ed-field" value={res} title="Playback resolution" onChange={(e) => { const v = Number(e.target.value); setRes(v); lsSet("tatvam-editor:nr-companion-res", String(v)); }}>
          <option value={1}>Full</option><option value={2}>½</option><option value={4}>¼</option>
        </select>
      </div>
    </div>
  );
}

function Tc({ fps }: { fps: number }) {
  const f = useFrame(program);
  return <TimecodeField frame={f} fps={fps} size="sm" className="text-accent-ink" onChange={(v) => program.seek(v)} />;
}
