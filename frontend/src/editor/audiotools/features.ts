/**
 * Per-10 ms features of a mono signal for the breath remover and room-tone finder (docs/EDITOR.md §15.4), streamed so
 * an hour of sound needs only its features in memory:
 *  - rms: the level of each 10 ms hop (dBFS RMS: a full-scale sine reads −3), and its sample peak (dBFS);
 *  - hf: the share of the power between 1 and 6 kHz (of 80 Hz – 7.9 kHz), from a 32 ms Hann window around the hop;
 *  - flat: the spectral flatness (geometric / arithmetic mean of the power) between 1 and 6 kHz: noise ≈ 0.5, voice
 *    (harmonics) much lower;
 *  - voiced: the harmonicity, the window's normalised autocorrelation peak at 70–400 Hz pitch lags divided by the
 *    window's own (Boersma's method): voice ≈ 0.6–1, breath and noise below ≈ 0.3.
 * Pure: the desktop feeds FFmpeg's PCM, the page an OfflineAudioContext's.
 */
import { fft, hann, powDb, SampleQueue } from "./dsp.ts";

export const FEATURE_RATE = 16000;
export const HOP_S = 0.01;
const WIN = 512;
const NFFT = 1024;

export interface Features {
  rate: number; hopS: number;
  /** Hops analysed. */
  n: number;
  rms: Float32Array; peak: Float32Array;
  /** Empty when the extractor ran without the spectral features. */
  hf: Float32Array; flat: Float32Array; voiced: Float32Array;
}

/** Streams samples in (any chunk sizes), features out. `spectral: false` measures only the levels (room tone). */
export class FeatureExtractor {
  readonly rate: number;
  readonly hop: number;
  private q = new SampleQueue();
  private next = 0;
  private spectral: boolean;
  private rms: number[] = []; private peak: number[] = []; private hf: number[] = []; private flat: number[] = []; private voiced: number[] = [];
  private win: Float64Array;
  private winAc: Float64Array;
  private re = new Float64Array(NFFT); private im = new Float64Array(NFFT);
  private hopBuf: Float64Array; private winBuf = new Float64Array(WIN);
  private bins: { lo: number; hi: number; hfLo: number; hfHi: number; lagLo: number; lagHi: number };

  constructor(rate = FEATURE_RATE, opts: { spectral?: boolean } = {}) {
    this.rate = rate;
    this.hop = Math.max(1, Math.round(rate * HOP_S));
    this.hopBuf = new Float64Array(this.hop);
    this.spectral = opts.spectral !== false;
    this.win = hann(WIN);
    // the window's own autocorrelation (normalises the signal's, so a periodic signal reads ≈ 1 at its period)
    const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
    re.set(this.win);
    fft(re, im);
    for (let k = 0; k < NFFT; k++) { re[k] = re[k] * re[k] + im[k] * im[k]; im[k] = 0; }
    fft(re, im);
    this.winAc = new Float64Array(NFFT / 2);
    for (let l = 0; l < NFFT / 2; l++) this.winAc[l] = re[l] / re[0];
    const df = rate / NFFT;
    this.bins = {
      lo: Math.max(1, Math.round(80 / df)), hi: Math.min(NFFT / 2 - 1, Math.round(Math.min(7900, rate / 2 - df) / df)),
      hfLo: Math.round(1000 / df), hfHi: Math.min(NFFT / 2 - 1, Math.round(Math.min(6000, rate / 2 - df) / df)),
      lagLo: Math.max(2, Math.floor(rate / 400)), lagHi: Math.min(WIN - 2, Math.ceil(rate / 70)),
    };
  }

  /** Hops measured so far. */
  get count() { return this.rms.length; }

  push(x: Float32Array) {
    this.q.push(x);
    this.drain(false);
  }

  finish(): Features {
    this.drain(true);
    const f = (a: number[]) => Float32Array.from(a);
    return { rate: this.rate, hopS: this.hop / this.rate, n: this.rms.length, rms: f(this.rms), peak: f(this.peak), hf: f(this.hf), flat: f(this.flat), voiced: f(this.voiced) };
  }

  private drain(final: boolean) {
    const total = this.q.total;
    for (;;) {
      const h = this.next;
      const s0 = h * this.hop;
      if (s0 >= total) break;
      const centre = s0 + (this.hop >> 1);
      const w0 = centre - WIN / 2;
      if (!final && (s0 + this.hop > total || (this.spectral && w0 + WIN > total))) break;
      this.measure(s0, w0, Math.min(this.hop, total - s0));
      this.next++;
      this.q.drop(Math.min((this.next * this.hop) + (this.hop >> 1) - WIN / 2, this.next * this.hop));
    }
  }

  private measure(s0: number, w0: number, n: number) {
    const hb = this.hopBuf;
    this.q.read(s0, hb);
    let e = 0, pk = 0;
    for (let i = 0; i < n; i++) { const v = hb[i]; e += v * v; const a = Math.abs(v); if (a > pk) pk = a; }
    this.rms.push(powDb(e / Math.max(1, n)));
    this.peak.push(pk > 0 ? 20 * Math.log10(pk) : -240);
    if (!this.spectral) return;
    const { re, im, win, winBuf } = this;
    this.q.read(w0, winBuf);
    let we = 0;
    for (let i = 0; i < WIN; i++) { const v = winBuf[i] * win[i]; re[i] = v; im[i] = 0; we += v * v; }
    re.fill(0, WIN); im.fill(0, WIN);
    if (we < 1e-14) { this.hf.push(0); this.flat.push(0); this.voiced.push(0); return; }
    fft(re, im);
    const b = this.bins;
    let all = 0, band = 0, logSum = 0, cnt = 0;
    for (let k = 0; k <= NFFT / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      if (k >= b.lo && k <= b.hi) all += p;
      if (k >= b.hfLo && k <= b.hfHi) { band += p; logSum += Math.log(p + 1e-20); cnt++; }
      re[k] = p; im[k] = 0;
    }
    this.hf.push(all > 0 ? band / all : 0);
    this.flat.push(cnt && band > 0 ? Math.exp(logSum / cnt) / (band / cnt) : 0);
    // autocorrelation = the inverse transform of the power spectrum (real, even: the forward FFT of it, mirrored)
    for (let k = NFFT / 2 + 1; k < NFFT; k++) { re[k] = re[NFFT - k]; im[k] = 0; }
    fft(re, im);
    const r0 = re[0];
    let best = 0;
    if (r0 > 0) {
      for (let l = b.lagLo; l <= b.lagHi; l++) {
        const wa = this.winAc[l];
        if (wa < 0.2) break;
        // a local maximum only (the main lobe at lag 0 falls off slowly for low-passed sound)
        if (re[l] < re[l - 1] || re[l] < re[l + 1]) continue;
        const r = re[l] / r0 / wa;
        if (r > best) best = r;
      }
    }
    this.voiced.push(Math.min(1, best));
  }
}

/** Features of whole samples (tests, the page). */
export function featuresOf(samples: Float32Array, rate = FEATURE_RATE, opts: { spectral?: boolean } = {}): Features {
  const fx = new FeatureExtractor(rate, opts);
  fx.push(samples);
  return fx.finish();
}
