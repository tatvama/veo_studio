/**
 * The preview's AudioWorklet processors (loaded once per AudioContext by audiofx/graph.ts through Vite's
 * `?worker&url`, bundled with the DSP they import):
 *  - "tatvam-fx": one sample-level effect (gate, expander, crusher, phaser, flanger, vibrato, chorus: audiofx/dsp.ts,
 *    FFmpeg's algorithms), stereo in → stereo out; params arrive on the port ({ params }).
 *  - "tatvam-meter": the master meters (BS.1770 loudness, true peak, phase correlation: audiofx/loudness.ts), posting
 *    { m, s, i, tp, tpNow, peak, corr } ten times a second; { reset: true } restarts the integrated loudness.
 */
import { Chorus, Crusher, Expander, Flanger, Gate, Phaser, Vibrato } from "./dsp.ts";
import { LoudnessMeter } from "./loudness.ts";

// the AudioWorkletGlobalScope (not in the DOM lib)
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(options?: unknown) }

type Proc = { set(p: Record<string, number | string>, channels?: number): void; process(i: Float32Array[], o: Float32Array[], n: number): void };

function make(kind: string): Proc | null {
  switch (kind) {
    case "gate": return new Gate(sampleRate) as unknown as Proc;
    case "expander": return new Expander(sampleRate) as unknown as Proc;
    case "crusher": return new Crusher() as unknown as Proc;
    case "phaser": return new Phaser(sampleRate) as unknown as Proc;
    case "flanger": return new Flanger(sampleRate) as unknown as Proc;
    case "vibrato": return new Vibrato(sampleRate) as unknown as Proc;
    case "chorus": return new Chorus(sampleRate) as unknown as Proc;
    default: return null;
  }
}

class FxProcessor extends AudioWorkletProcessor {
  private fx: Proc | null;
  private alive = true;
  private scratch: Float32Array[] = [new Float32Array(128), new Float32Array(128)];
  constructor(options: { processorOptions?: { kind: string; params: Record<string, number | string> } }) {
    super();
    const o = options.processorOptions ?? { kind: "", params: {} };
    this.fx = make(o.kind);
    this.fx?.set(o.params, 2);
    this.port.onmessage = (e: MessageEvent<{ params?: Record<string, number | string>; stop?: boolean }>) => {
      if (e.data.params) this.fx?.set(e.data.params, 2);
      if (e.data.stop) this.alive = false;
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const n = out[0]?.length ?? 128;
    let inp = inputs[0];
    if (!inp || !inp.length) {
      // nothing connected: keep the tails (delays, feedback) running on silence
      for (const s of this.scratch) s.fill(0);
      inp = this.scratch;
    } else if (inp.length === 1) inp = [inp[0], inp[0]];
    if (!this.fx) { for (let c = 0; c < out.length; c++) out[c].set(inp[c] ?? inp[0]); return this.alive; }
    this.fx.process(inp, out.length === 1 ? [out[0], new Float32Array(n)] : out, n);
    return this.alive;
  }
}

class MeterProcessor extends AudioWorkletProcessor {
  private m = new LoudnessMeter(sampleRate, 2);
  private since = 0;
  private alive = true;
  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ reset?: boolean; stop?: boolean }>) => {
      if (e.data.reset) this.m.reset();
      if (e.data.stop) this.alive = false;
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const inp = inputs[0];
    const n = outputs[0]?.[0]?.length ?? 128;
    if (inp && inp.length) this.m.push(inp.length === 1 ? [inp[0], inp[0]] : inp, n);
    else this.m.push([new Float32Array(n), new Float32Array(n)], n);
    this.since += n;
    if (this.since >= sampleRate / 10) {
      this.since = 0;
      this.port.postMessage({ m: this.m.momentary(), s: this.m.shortTerm(), i: this.m.integrated(), tp: this.m.truePeak(), tpNow: this.m.truePeakNow(),
        peak: 20 * Math.log10(Math.max(1e-12, this.m.samplePeak)), corr: this.m.correlation() });
    }
    return this.alive;
  }
}

registerProcessor("tatvam-fx", FxProcessor);
registerProcessor("tatvam-meter", MeterProcessor);
