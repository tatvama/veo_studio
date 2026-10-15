/**
 * One process-wide gate for work on the graphics card (docs/DESKTOP.md §4.1). A consumer GeForce allows only a few
 * NVENC sessions at once (3 on current drivers, 2 on older ones) and Vulkan / CUDA tools share the same card, so every
 * runner that encodes or runs a model on it takes a slot first and gives it back after: render steps and the GPU frame
 * pass (render.ts), proxies (proxies.ts, editor.ts), the local upscaler (aiupscale.ts), RIFE and CUDA Whisper (editor.ts).
 * Slots come from settings.encoder.gpuSlots (default 2; TATVAM_GPU_SLOTS overrides the default). Electron-free.
 */

interface Waiter { resolve(release: () => void): void; reject(e: Error): void; signal?: AbortSignal; onAbort?: () => void }

export class Semaphore {
  private limit: number;
  private active = 0;
  private waiting: Waiter[] = [];

  constructor(slots: number) {
    this.limit = Math.max(1, Math.floor(slots) || 1);
  }

  get slots(): number { return this.limit; }
  get inUse(): number { return this.active; }
  get queued(): number { return this.waiting.length; }

  /** Change the number of slots; waiters start at once when it grows (running work is never interrupted when it shrinks). */
  setSlots(n: number): void {
    this.limit = Math.max(1, Math.floor(n) || 1);
    this.pump();
  }

  /** Take a slot (waiting for one); resolves with the release function (safe to call twice). Rejects with "cancelled" on abort while waiting. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error("cancelled")); return; }
      const w: Waiter = { resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          this.waiting = this.waiting.filter((x) => x !== w);
          reject(new Error("cancelled"));
        };
        signal.addEventListener("abort", w.onAbort, { once: true });
      }
      this.waiting.push(w);
      this.pump();
    });
  }

  /** Run `fn` holding a slot. */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private pump(): void {
    while (this.active < this.limit && this.waiting.length) {
      const w = this.waiting.shift()!;
      if (w.onAbort) w.signal?.removeEventListener("abort", w.onAbort);
      this.active++;
      let done = false;
      w.resolve(() => {
        if (done) return;
        done = true;
        this.active--;
        this.pump();
      });
    }
  }
}

/** The default number of slots: TATVAM_GPU_SLOTS (1..8) or 2. */
export function defaultGpuSlots(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.TATVAM_GPU_SLOTS);
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 2;
}

/** The one gate every GPU runner in this process shares (index.ts sets its slots from settings). */
export const gpuGate = new Semaphore(defaultGpuSlots());
