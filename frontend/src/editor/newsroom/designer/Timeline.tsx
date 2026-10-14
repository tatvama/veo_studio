/**
 * The Designer's preview timeline (docs/EDITOR.md §16.8): play / pause / loop, a scrubber showing the template's in,
 * hold and out phases (and a stinger's cut), the selected layer's own in and out steps, and the template timing as
 * numbers you can drag.
 */
import { Pause, Play, Repeat } from "lucide-react";
import { useEffect, useRef } from "react";
import { layerTiming, phasesOf } from "../render/anim";
import { layerOf, ratiosOf } from "./doc";
import { Num } from "./controls";
import { change, clock, isReadOnly, previewLength, useDesigner } from "./state";

/** Runs the preview clock while playing. */
function usePlayback() {
  const playing = clock((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const { t, loop } = clock.getState();
      const dur = previewLength(useDesigner.getState().h.present);
      let nt = t + dt;
      if (nt >= dur) {
        if (loop) nt = nt % dur;
        else { clock.setState({ t: dur, playing: false }); return; }
      }
      clock.setState({ t: nt });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
}

export const togglePlay = () => {
  const s = clock.getState();
  const dur = previewLength(useDesigner.getState().h.present);
  clock.setState({ playing: !s.playing, t: !s.playing && s.t >= dur - 0.01 ? 0 : s.t });
};

export function Timeline() {
  usePlayback();
  const t = useDesigner((s) => s.h.present);
  const sel = useDesigner((s) => s.sel);
  const ratio = useDesigner((s) => s.ratio);
  const readOnly = useDesigner((s) => isReadOnly(s) || s.mode === "clip");
  const { t: now, playing, loop } = clock();
  const bar = useRef<HTMLDivElement>(null);
  const dur = previewLength(t);
  const ph = phasesOf(t, dur);
  const r = t.designs[ratio] ? ratio : ratiosOf(t)[0];
  const layer = sel && r ? layerOf(t, r, sel) : undefined;
  const lt = layer ? layerTiming(t, layer, dur) : null;
  const pct = (s: number) => `${Math.max(0, Math.min(100, (s / dur) * 100))}%`;
  const seek = (clientX: number) => {
    const rc = bar.current!.getBoundingClientRect();
    clock.setState({ t: Math.max(0, Math.min(dur, ((clientX - rc.left) / rc.width) * dur)), playing: false });
  };
  const setT = (patch: Partial<typeof t.timing>, key: string) => change((tt) => ({ ...tt, timing: { ...tt.timing, ...patch } }), `timing:${key}`);
  return (
    <div className="flex h-[58px] shrink-0 items-center gap-3 border-t border-line bg-panel px-3">
      <button type="button" className="ed-ibtn" title={playing ? "Pause (Space)" : "Play (Space)"} onClick={togglePlay}>
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </button>
      <button type="button" className="ed-ibtn" aria-pressed={loop} title="Loop the preview" onClick={() => clock.setState({ loop: !loop })}><Repeat className="size-4" /></button>
      <span className="ed-tc w-[54px] shrink-0 text-xs text-mute">{now.toFixed(2)}s</span>
      <div className="relative min-w-0 flex-1 select-none">
        <div ref={bar} className="relative h-7 cursor-pointer"
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seek(e.clientX); }}
          onPointerMove={(e) => { if (e.buttons & 1) seek(e.clientX); }}>
          <div className="absolute inset-x-0 top-[9px] h-2.5 overflow-hidden rounded bg-line/70">
            <div className="absolute inset-y-0 bg-accent/45" style={{ left: 0, width: pct(ph.inLen) }} title="Coming in" />
            {!t.loop || t.timing.out > 0 ? <div className="absolute inset-y-0 bg-warn/40" style={{ left: pct(ph.outStart), right: 0 }} title="Going out" /> : null}
          </div>
          {t.cut !== undefined && <div className="absolute top-1 h-5 w-0.5 bg-bad" style={{ left: pct(t.cut * dur) }} title="The cut" />}
          {lt?.in && <div className="absolute top-[22px] h-1 rounded bg-accent-ink" style={{ left: pct(lt.in.start), width: pct(lt.in.dur) }} title={`${layer!.name} comes in`} />}
          {lt?.out && <div className="absolute top-[22px] h-1 rounded bg-warn" style={{ left: pct(lt.out.start), width: pct(lt.out.dur) }} title={`${layer!.name} goes out`} />}
          <div className="pointer-events-none absolute top-0 h-7 w-0.5 -translate-x-1/2 rounded bg-[var(--ed-playhead,#ef4444)]" style={{ left: pct(now) }} />
        </div>
        <div className="pointer-events-none flex justify-between text-[10px] leading-none text-dim">
          <span>In</span><span>Hold</span><span>{t.loop && !t.timing.out ? "Loops" : "Out"}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 text-2xs text-mute">
        <span title="Seconds for layers to come in">In</span><Num value={t.timing.in} min={0} max={10} step={0.05} unit="s" disabled={readOnly} onChange={(v) => setT({ in: Math.round(v * 100) / 100 }, "in")} />
        <span className="pl-1" title="Seconds for layers to go out">Out</span><Num value={t.timing.out} min={0} max={10} step={0.05} unit="s" disabled={readOnly} onChange={(v) => setT({ out: Math.round(v * 100) / 100 }, "out")} />
        <span className="pl-1" title="0 = to the end of the sequence">Length</span><Num value={t.seconds} min={0} max={600} step={0.5} unit="s" disabled={readOnly}
          onChange={(v) => change((tt) => ({ ...tt, seconds: Math.round(v * 10) / 10 }), "timing:len")} />
      </div>
    </div>
  );
}
