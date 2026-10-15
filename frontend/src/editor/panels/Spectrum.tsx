/**
 * Spectrum (docs/EDITOR.md §11): the mix's frequency spectrum from an AnalyserNode (8192-point FFT) on a log frequency
 * axis (20 Hz – 20 kHz), −100…0 dB, with a peak hold that falls 12 dB a second. Reads the mix after the master
 * effects, before the monitoring level.
 */
import "../audiofx/audiofx.css";
import { useEffect, useRef, useState } from "react";
import { useVisible } from "../moods/ui";
import { mixer } from "../playback/audio";
import { setFocus } from "../store";

const F0 = 20, F1 = 20000, DB0 = -100, DB1 = 0;
const GRID_F = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const GRID_DB = [-80, -60, -40, -20];
const fLabel = (f: number) => (f >= 1000 ? `${f / 1000}k` : String(f));

export default function Spectrum() {
  const root = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const visible = useVisible(root);
  const [hold, setHold] = useState(true);
  const [on, setOn] = useState(!!mixer.analyser());
  // off screen (a hidden tab) nothing is drawn; without an analyser (the context wakes on the first play) the grid is
  // drawn once and the mixer is polled for one, instead of a requestAnimationFrame loop running all the while
  useEffect(() => {
    if (!visible) return;
    if (!mixer.analyser()) {
      const id = window.setInterval(() => { if (mixer.analyser()) setOn(true); }, 500);
      return () => window.clearInterval(id);
    }
    return undefined;
  }, [visible, on]);
  useEffect(() => {
    if (!visible) return;
    let raf = 0, last = performance.now();
    let data = new Float32Array(0), peak = new Float32Array(0);
    const draw = (now: number) => {
      const c = cv.current, an = mixer.analyser();
      if (!c) return;
      if (!!an !== on) { setOn(!!an); if (!an) return; }
      if (an) raf = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const W = Math.max(1, Math.round(c.clientWidth * dpr)), H = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const g = c.getContext("2d");
      if (!g) return;
      const css = getComputedStyle(c);
      const accent = css.getPropertyValue("--color-accent").trim() || "#67e8f9", ink = css.getPropertyValue("--color-ink").trim() || "#fff";
      const dim = css.getPropertyValue("--color-dim").trim() || "#888", line = css.getPropertyValue("--color-line").trim() || "#333";
      g.clearRect(0, 0, W, H);
      const padL = 30 * dpr, padB = 16 * dpr, w = W - padL, h = H - padB;
      const xf = (f: number) => padL + (Math.log(f / F0) / Math.log(F1 / F0)) * w;
      const yd = (d: number) => ((DB1 - Math.max(DB0, Math.min(DB1, d))) / (DB1 - DB0)) * h;
      // grid
      g.strokeStyle = line; g.lineWidth = 1; g.fillStyle = dim; g.font = `${10 * dpr}px Inter Variable, system-ui`;
      for (const f of GRID_F) { const x = Math.round(xf(f)) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); g.fillText(fLabel(f), x - 8 * dpr, H - 3 * dpr); }
      for (const d of GRID_DB) { const y = Math.round(yd(d)) + 0.5; g.beginPath(); g.moveTo(padL, y); g.lineTo(W, y); g.stroke(); g.fillText(String(d), 2 * dpr, y + 3 * dpr); }
      if (!an) return;
      const n = an.frequencyBinCount;
      if (data.length !== n) { data = new Float32Array(n); peak = new Float32Array(n).fill(DB0); }
      an.getFloatFrequencyData(data);
      const sr = an.context.sampleRate, binHz = sr / an.fftSize;
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      for (let i = 0; i < n; i++) { const v = Number.isFinite(data[i]) ? data[i] : DB0; peak[i] = v > peak[i] ? v : peak[i] - 12 * dt; }
      // one point per pixel column: the loudest bin in it (log axis)
      const col = (arr: Float32Array) => {
        const pts: [number, number][] = [];
        for (let px = 0; px <= w; px += dpr) {
          const fa = F0 * Math.pow(F1 / F0, px / w), fb = F0 * Math.pow(F1 / F0, (px + dpr) / w);
          const ba = fa / binHz, bb = fb / binHz;
          let m = DB0;
          if (Math.floor(bb) <= Math.floor(ba)) {
            // a column narrower than a bin (the lows): interpolate between the bins around it
            const k = Math.min(n - 2, Math.max(1, Math.floor(ba))), fr = Math.min(1, Math.max(0, ba - k));
            m = arr[k] + (arr[k + 1] - arr[k]) * fr;
          } else {
            const ia = Math.max(1, Math.ceil(ba)), ib = Math.min(n - 1, Math.floor(bb));
            for (let k = ia; k <= ib; k++) if (arr[k] > m) m = arr[k];
          }
          pts.push([padL + px, yd(m)]);
        }
        return pts;
      };
      const pts = col(data);
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, accent); grad.addColorStop(1, "transparent");
      g.beginPath(); g.moveTo(padL, h);
      for (const [x, y] of pts) g.lineTo(x, y);
      g.lineTo(W, h); g.closePath();
      g.globalAlpha = 0.35; g.fillStyle = grad; g.fill(); g.globalAlpha = 1;
      g.strokeStyle = accent; g.lineWidth = 1.25 * dpr; g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
      if (hold) {
        g.strokeStyle = ink; g.globalAlpha = 0.55; g.lineWidth = 1 * dpr; g.beginPath();
        col(peak).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); g.globalAlpha = 1;
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [hold, on, visible]);
  return (
    <div ref={root} className="pn" onPointerDown={() => setFocus("mixer")}>
      <div className="ed-bar gap-2">
        <span className="text-xs font-medium">Spectrum</span>
        <label className="ml-auto flex items-center gap-1 text-2xs text-mute"><input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} />Peak hold</label>
      </div>
      <div className="relative min-h-0 flex-1 p-1.5">
        <canvas ref={cv} className="size-full" aria-label="Spectrum of the mix" />
        {!on && <div className="pointer-events-none absolute inset-0 grid place-items-center text-2xs text-dim">Press play to see the mix's spectrum</div>}
      </div>
      <div className="ed-bar bottom text-2xs text-dim">Log frequency · −100 to 0 dB · the mix after the master effects</div>
    </div>
  );
}
