/**
 * The Source monitor's multicam view (editor-motion): every angle of the multicam clip under the program playhead in a
 * grid, playing in sync with the sequence. The angle on the program is outlined; click an angle (or press 1–9) to cut
 * to it at the playhead — while playing, every press is a cut recorded on the clip.
 */
import { clsx } from "clsx";
import { Grid2x2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { customSource } from "../demoSources";
import * as M from "../motionActions";
import { clipEnd, tracksOf } from "../model/ops";
import { framesToSeconds } from "../model/time";
import type { Sequence, TimelineClip } from "../model/types";
import { program, usePlayState } from "../playback/transport";
import { project, setFocus, setMulticamView, urlFor, useProject, useSequence } from "../store";
import { IBtn } from "../ui";
import "./MotionOverlay.css";

/** The multicam clip under the playhead and its angle (re-renders only when either changes). */
function useMulticamHere(): { clip: TimelineClip | undefined; key: string } {
  const s = useSequence();
  const key = useSyncExternalStore((cb) => program.subscribe(cb), () => { const c = M.multicamUnderPlayhead(); return c ? `${c.id}:${c.multicam?.angle}` : ""; }, () => "");
  const clip = useMemo(() => s.clips.find((c) => c.id === key.split(":")[0]), [s, key]);
  return { clip, key };
}

export function MulticamGrid() {
  const p = useProject();
  const { clip } = useMulticamHere();
  const mc = clip && clip.source.type === "nested" ? p.sequences.find((x) => x.id === (clip.source as { sequenceId: string }).sequenceId) : undefined;
  const angles = mc?.multicam?.angles ?? [];
  const n = angles.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  const vids = useRef<(HTMLVideoElement | null)[]>([]);
  const cvs = useRef<(HTMLCanvasElement | null)[]>([]);
  const { playing } = usePlayState(program);

  // each angle follows the program playhead (muted: the sound comes from the sequence)
  useEffect(() => {
    if (!clip || !mc) return;
    const follow = (t: number) => {
      angles.forEach((_, i) => {
        const at = angleTime(mc, clip, i, t);
        const el = vids.current[i], cv = cvs.current[i];
        if (!at) { if (el && !el.paused) el.pause(); return; }
        const custom = customSource(at.url);
        if (custom && cv) { const g = cv.getContext("2d"); if (g) g.drawImage(custom.draw(at.t) as CanvasImageSource, 0, 0, cv.width, cv.height); return; }
        if (!el) return;
        if (el.getAttribute("src") !== at.url) el.src = at.url;
        if (program.playing && program.rate > 0 && program.rate <= 4) {
          el.playbackRate = program.rate;
          if (el.paused) { el.currentTime = at.t; void el.play().catch(() => undefined); }
          else if (Math.abs(el.currentTime - at.t) > 0.2) el.currentTime = at.t;
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - at.t) > 0.02 && el.readyState > 0) el.currentTime = at.t;
        }
      });
    };
    follow(program.time);
    const a = program.onTick(follow), b = program.subscribeState(() => follow(program.time)), c = program.subscribe(() => { if (!program.playing) follow(program.time); });
    return () => { a(); b(); c(); vids.current.forEach((v) => v?.pause()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id, mc, n]);

  return (
    <div className="mon" onPointerDown={() => setFocus("source")}>
      <div className="ed-bar gap-1">
        <Grid2x2 className="size-3.5 text-accent-ink" />
        <span className="truncate text-xs font-medium">{mc ? `${mc.name} · ${n} angles` : "Multicam"}</span>
        <span className="ml-2 text-2xs text-dim">{playing ? "Recording cuts: press 1–" + Math.max(1, n) : "Click an angle or press 1–" + Math.max(1, n) + " to cut at the playhead"}</span>
        <IBtn title="Back to the Source clip" className="ml-auto" onClick={() => setMulticamView(false)}><X className="size-3.5" /></IBtn>
      </div>
      {!mc ? (
        <div className="pn-empty">Put the playhead over a multicam clip (Clip → Make multicam clip) to see its angles here.</div>
      ) : (
        <div className="mc-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }} data-multicam-grid={n}>
          {angles.map((a, i) => {
            const at = angleTime(mc, clip!, i, program.time);
            const custom = at ? customSource(at.url) : undefined;
            return (
              <button key={i} type="button" className={clsx("mc-tile", clip!.multicam?.angle === i && "live")} onClick={() => M.cutToAngle(i)} title={`Cut to angle ${i + 1} (${i + 1})`}>
                {custom ? <canvas ref={(el) => { cvs.current[i] = el; }} width={480} height={270} /> : <video ref={(el) => { vids.current[i] = el; }} muted playsInline preload="auto" />}
                {!at && <span className="mc-none">No picture here</span>}
                <span className="mc-label"><b>{i + 1}</b> {a.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Angle i's media and its time (seconds) at program time `t` (null where that angle has no clip). */
function angleTime(mc: Sequence, clip: TimelineClip, i: number, t: number): { url: string; t: number } | null {
  const track = tracksOf(mc, "video")[i];
  if (!track || clip.source.type !== "nested") return null;
  const fps = mc.fps;
  const nested = framesToSeconds(clip.source.in, fps) + Math.max(0, t - framesToSeconds(clip.start, fps));
  const f = nested * fps;
  const a = mc.clips.find((x) => x.trackId === track.id && x.start <= f && f < clipEnd(x));
  if (!a || a.source.type !== "media") return null;
  const m = project().media.find((x) => x.id === (a.source as { mediaId: string }).mediaId);
  const url = m ? urlFor(m) : undefined;
  if (!m || !url) return null;
  const inS = a.source.in / (m.fps > 0 ? m.fps : fps);
  return { url, t: Math.max(0, inS + (nested - framesToSeconds(a.start, fps)) * (a.speed > 0 ? a.speed : 1)) };
}
