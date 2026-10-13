/**
 * The page's side of the SFX render worker (worker.ts): renders queue there, and fall back to rendering on the main
 * thread when a worker can't start. Page-only (it imports the worker through Vite).
 */
import SfxWorker from "./worker.ts?worker";
import { renderSfx } from "./engine.ts";
import { peaksOf } from "./level.ts";

export interface Rendered { channels: Float32Array[]; peaks: number[] }
type Pending = { ok: (r: Rendered) => void; local: () => void };

let w: Worker | null = null;
let broken = false;
let seq = 0;
const pending = new Map<number, Pending>();

function local(id: string, values: Record<string, number>, seed: number, peaks: number): Rendered {
  const channels = renderSfx(id, values, seed);
  return { channels, peaks: peaks > 0 ? peaksOf(channels, peaks) : [] };
}

function worker(): Worker | null {
  if (broken) return null;
  if (w) return w;
  try {
    w = new SfxWorker();
    w.onmessage = (e: MessageEvent<{ n: number; channels?: Float32Array[]; peaks?: number[]; error?: string }>) => {
      const p = pending.get(e.data.n);
      if (!p) return;
      pending.delete(e.data.n);
      if (e.data.channels) p.ok({ channels: e.data.channels, peaks: e.data.peaks ?? [] }); else p.local();
    };
    w.onerror = () => {
      broken = true;
      w?.terminate(); w = null;
      const all = [...pending.values()];
      pending.clear();
      for (const p of all) p.local();
    };
  } catch {
    broken = true;
    w = null;
  }
  return w;
}

/** Renders a sound in the worker (with `peaks` waveform buckets when asked). */
export function renderInWorker(id: string, values: Record<string, number>, seed: number, peaks = 0): Promise<Rendered> {
  const wk = worker();
  if (!wk) return Promise.resolve().then(() => local(id, values, seed, peaks));
  return new Promise<Rendered>((resolve, reject) => {
    const n = ++seq;
    pending.set(n, { ok: resolve, local: () => { try { resolve(local(id, values, seed, peaks)); } catch (e) { reject(e); } } });
    wk.postMessage({ n, id, values, seed, peaks });
  });
}
