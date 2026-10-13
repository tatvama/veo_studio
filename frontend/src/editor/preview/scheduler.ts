/**
 * The idle scheduler of the preview thumbnails (preview-polish): renders wait for the browser's idle time, a few per
 * idle callback (`maxPerIdle`) and only while the callback has time left (`budgetMs` of work, `reserveMs` kept back
 * for the browser), so typing and scrolling never wait on a thumbnail. The most wanted job runs first (higher
 * priority, then the newest); a job whose card has gone (`wanted()` false) is dropped unrun; adding a key that is
 * queued only raises its priority. An editor drawing every frame (a 144 Hz screen, meters) has only slivers of
 * idle time, shorter than one render, so what counts is the user: while they type, scroll or drag (`busy()`),
 * renders wait for real idle time; once they stop, each idle callback runs a job (within `budgetMs`). Without a
 * `busy` signal, a callback that timed out, or one that comes after `starveMs` without a job, runs a small slice.
 * Pure: the clock and the idle callback are passed in (the node tests drive them by hand).
 */

export interface IdleDeadlineLike { timeRemaining(): number; readonly didTimeout?: boolean }
export interface SchedulerEnv {
  now(): number;
  /** requestIdleCallback (with a timeout), or a stand-in. */
  requestIdle(cb: (d: IdleDeadlineLike) => void): void;
  /** True while the user types, scrolls or drags (then only real idle time is used). */
  busy?(): boolean;
}
export interface IdleJob {
  key: string;
  /** Higher runs first. */
  priority: number;
  run(): unknown;
  /** False when nobody needs the result any more (the card scrolled away or unmounted). */
  wanted?(): boolean;
}
export interface SchedulerOptions { maxPerIdle: number; budgetMs: number; reserveMs: number; starveMs: number; starveSliceMs: number }
export const DEFAULT_SCHEDULER: SchedulerOptions = { maxPerIdle: 3, budgetMs: 8, reserveMs: 2, starveMs: 120, starveSliceMs: 6 };

interface Entry { job: IdleJob; seq: number }

export class IdleScheduler {
  private queue = new Map<string, Entry>();
  private seq = 0;
  private scheduled = false;
  private running = false;
  private o: SchedulerOptions;
  private env: SchedulerEnv;
  private lastRun = -Infinity;
  /** How long each job took (ms), the last 64; and how many each idle callback ran. */
  readonly stats = { runs: [] as number[], perIdle: [] as number[], dropped: 0 };
  constructor(env: SchedulerEnv, opts: Partial<SchedulerOptions> = {}) { this.env = env; this.o = { ...DEFAULT_SCHEDULER, ...opts }; }

  get pending(): number { return this.queue.size; }
  has(key: string): boolean { return this.queue.has(key); }

  /** Queues a job. A key that is already queued keeps its job and only takes the higher priority (and counts as
   *  the newest request). */
  add(job: IdleJob): void {
    const had = this.queue.get(job.key);
    if (had) { had.job = { ...had.job, priority: Math.max(had.job.priority, job.priority) }; had.seq = ++this.seq; }
    else this.queue.set(job.key, { job, seq: ++this.seq });
    this.kick();
  }
  cancel(key: string): void { this.queue.delete(key); }
  clear(): void { this.queue.clear(); }

  private kick() {
    if (this.scheduled || this.running || !this.queue.size) return;
    this.scheduled = true;
    this.env.requestIdle((d) => { this.scheduled = false; void this.pump(d); });
  }

  private take(): IdleJob | null {
    let best: Entry | null = null;
    for (const e of this.queue.values()) if (!best || e.job.priority > best.job.priority || (e.job.priority === best.job.priority && e.seq > best.seq)) best = e;
    if (!best) return null;
    this.queue.delete(best.job.key);
    return best.job;
  }

  /** Runs what fits in one idle period; returns how many jobs ran. */
  async pump(d: IdleDeadlineLike): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const start = this.env.now();
    // the work this callback may do: what the idle period leaves after the reserve, at most the budget; a forced
    // slice when the callback timed out or nothing ran for a while
    const idle = Math.min(this.o.budgetMs, d.timeRemaining() - this.o.reserveMs);
    const busy = this.env.busy?.();
    const budget = busy === false ? Math.max(idle, this.o.budgetMs)
      : busy === true ? idle
      : !!d.didTimeout || start - this.lastRun > this.o.starveMs ? this.o.starveSliceMs : idle;
    let n = 0;
    try {
      while (this.queue.size && n < this.o.maxPerIdle) {
        if (n === 0 ? budget <= 0 : this.env.now() - start >= budget) break;
        const job = this.take();
        if (!job) break;
        if (job.wanted && !job.wanted()) { this.stats.dropped++; continue; }
        const t0 = this.env.now();
        try { await job.run(); } catch { /* a failed render shows no picture; the next request tries again */ }
        this.lastRun = this.env.now();
        this.stats.runs.push(this.lastRun - t0);
        if (this.stats.runs.length > 64) this.stats.runs.shift();
        n++;
      }
    } finally {
      this.running = false;
      this.stats.perIdle.push(n);
      if (this.stats.perIdle.length > 64) this.stats.perIdle.shift();
      this.kick();
    }
    return n;
  }
}

/** The browser's idle callback (with a 250 ms timeout so a busy page still fills in), else a timer stand-in. */
export function browserIdleEnv(timeout = 250, quietMs = 220): SchedulerEnv {
  const g = globalThis as unknown as { requestIdleCallback?: (cb: (d: IdleDeadlineLike) => void, o?: { timeout: number }) => number };
  // the user's typing, scrolling and dragging (a pointer moving over cards is not: their hover needs the renders)
  let lastInput = -Infinity;
  if (typeof window !== "undefined") {
    const mark = () => { lastInput = performance.now(); };
    for (const ev of ["keydown", "wheel", "pointerdown", "touchmove"]) window.addEventListener(ev, mark, { capture: true, passive: true });
    window.addEventListener("scroll", mark, { capture: true, passive: true });
    window.addEventListener("pointermove", (e) => { if (e.buttons) mark(); }, { capture: true, passive: true });
  }
  return {
    busy: () => performance.now() - lastInput < quietMs,
    now: () => performance.now(),
    requestIdle: (cb) => {
      if (typeof g.requestIdleCallback === "function") g.requestIdleCallback(cb, { timeout });
      else setTimeout(() => { const end = performance.now() + 12; cb({ timeRemaining: () => Math.max(0, end - performance.now()), didTimeout: false }); }, 16);
    },
  };
}
