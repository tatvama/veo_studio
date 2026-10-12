/**
 * Loudness (docs/EDITOR.md §11): the master's BS.1770 / EBU R128 meter from the mixer's worklet: momentary (400 ms),
 * short-term (3 s) and integrated (gated) loudness in LUFS, true peak (dBTP, 4× oversampled) and the stereo phase
 * correlation. It meters the mix after the master effects and before the monitoring level. `LoudnessReadout` is
 * the compact version in the Audio Mixer's master strip.
 */
import "../audiofx/audiofx.css";
import { clsx } from "clsx";
import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { mixer, type Loudness } from "../playback/audio";
import { setFocus } from "../store";
import { IBtn } from "../ui";

const TARGETS = [{ v: -14, l: "−14 (YouTube, Spotify)" }, { v: -16, l: "−16 (Apple, podcasts)" }, { v: -23, l: "−23 (EBU R128)" }, { v: -24, l: "−24 (ATSC / OTT)" }];
const LS_TARGET = "tatvam-editor:lufs-target";

export function useLoudness(): Loudness | null {
  const [l, setL] = useState<Loudness | null>(mixer.loud);
  useEffect(() => mixer.onLoudness(setL), []);
  return l;
}
const fmt = (x: number | undefined, d = 1) => (x === undefined || !Number.isFinite(x) || x < -120 ? "—" : x.toFixed(d));

/** The master strip's numbers: M / S / I, true peak and a correlation bar. */
export function LoudnessReadout({ compact }: { compact?: boolean }) {
  const l = useLoudness();
  return (
    <div className={clsx("w-full", compact ? "px-0.5" : "")} title="Loudness of the mix (LUFS), true peak (dBTP) and phase correlation">
      <div className="lufs">
        <span className="k">M</span><span className="v">{fmt(l?.m)}</span>
        <span className="k">S</span><span className="v">{fmt(l?.s)}</span>
        <span className="k">I</span><span className="v font-semibold">{fmt(l?.i)}</span>
        <span className="k">TP</span><span className={clsx("v", (l?.tp ?? -99) > -1 && "text-bad")}>{fmt(l?.tp)}</span>
      </div>
      <Correlation v={l?.corr ?? 0} />
    </div>
  );
}

function Correlation({ v }: { v: number }) {
  return (
    <div className="mt-1.5" title={`Phase correlation ${v.toFixed(2)} (−1 out of phase, 0 unrelated, +1 mono)`}>
      <div className="corr"><i style={{ left: `${((v + 1) / 2) * 100}%` }} /></div>
      <div className="mt-0.5 flex justify-between text-[9px] text-dim"><span>−1</span><span>0</span><span>+1</span></div>
    </div>
  );
}

/** A horizontal loudness bar on a −60…0 LUFS scale with the target marked. */
function Bar({ label, v, target }: { label: string; v: number | undefined; target: number }) {
  const f = (x: number) => Math.max(0, Math.min(1, (x + 60) / 60));
  const ok = v !== undefined && Number.isFinite(v);
  const over = ok && v! > target + 1, under = ok && v! < target - 6;
  return (
    <div className="grid grid-cols-[86px_1fr_54px] items-center gap-2">
      <span className="text-2xs text-mute">{label}</span>
      <div className="relative h-3 overflow-hidden rounded-sm bg-white/5">
        <div className={clsx("absolute inset-y-0 left-0", over ? "bg-bad" : under ? "bg-warn/70" : "bg-ok")} style={{ width: `${ok ? f(v!) * 100 : 0}%` }} />
        <div className="absolute inset-y-0 w-px bg-ink" style={{ left: `${f(target) * 100}%` }} title={`Target ${target} LUFS`} />
      </div>
      <span className="mono text-right text-xs">{fmt(v)}</span>
    </div>
  );
}

export default function LoudnessMeter() {
  const l = useLoudness();
  const [target, setTarget] = useState<number>(() => { try { return Number(localStorage.getItem(LS_TARGET)) || -14; } catch { return -14; } });
  useEffect(() => { try { localStorage.setItem(LS_TARGET, String(target)); } catch { /* blocked */ } }, [target]);
  const on = !!mixer.ctx;
  return (
    <div className="pn" onPointerDown={() => setFocus("mixer")}>
      <div className="ed-bar gap-2">
        <span className="text-xs font-medium">Mix loudness</span>
        <select className="ed-field ml-auto" value={target} onChange={(e) => setTarget(Number(e.target.value))} aria-label="Loudness target">
          {TARGETS.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
        </select>
        <IBtn title="Reset the integrated loudness and the peak hold" onClick={() => mixer.resetLoudness()}><RotateCcw className="size-3.5" /></IBtn>
      </div>
      <div className="pn-scroll space-y-2.5 p-3">
        <Bar label="Momentary" v={l?.m} target={target} />
        <Bar label="Short-term" v={l?.s} target={target} />
        <Bar label="Integrated" v={l?.i} target={target} />
        <div className="grid grid-cols-3 gap-2 pt-1 text-center">
          <Stat k="Integrated" v={`${fmt(l?.i)} LUFS`} warn={l ? Math.abs(l.i - target) > 1 && Number.isFinite(l.i) : false} />
          <Stat k="True peak (max)" v={`${fmt(l?.tp)} dBTP`} warn={(l?.tp ?? -99) > -1} />
          <Stat k="Sample peak" v={`${fmt(l?.peak)} dBFS`} warn={(l?.peak ?? -99) > -0.1} />
        </div>
        <div>
          <div className="mb-1 text-2xs text-mute">Phase correlation</div>
          <Correlation v={l?.corr ?? 0} />
        </div>
        {!on && <p className="text-2xs text-dim">Press play to meter the mix.</p>}
        <p className="text-2xs text-dim">ITU-R BS.1770-4 K-weighted loudness, gated like EBU R128. The meter reads the mix after the master effects, before the monitoring level. The export normalises to its own target.</p>
      </div>
    </div>
  );
}

function Stat({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="rounded-md border border-line px-2 py-1.5">
      <div className="text-[10px] text-dim">{k}</div>
      <div className={clsx("mono text-xs", warn ? "text-warn" : "text-ink")}>{v}</div>
    </div>
  );
}
