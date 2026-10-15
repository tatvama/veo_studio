/**
 * Reconnect bookkeeping for a socket: exponential backoff with one pending timer at a time, which `stop()` cancels so a
 * torn-down subscription (the effect re-ran for another project, the component unmounted) can never bring a zombie
 * socket back. Pure; live.ts uses it, and the timers are injectable for tests.
 */
export interface Reconnector {
  /** Schedules `connect` after the current delay (no-op while a reconnect is already pending or after stop()). */
  schedule(): void;
  /** Call on a successful connection: the next failure starts from the initial delay again. */
  reset(): void;
  /** Cancels any pending reconnect and refuses future ones. */
  stop(): void;
  readonly stopped: boolean;
  readonly pending: boolean;
  /** The delay the next schedule() would wait. */
  readonly delay: number;
}

export interface ReconnectOptions {
  initial?: number;
  max?: number;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void };
}

export function createReconnector(connect: () => void, opts: ReconnectOptions = {}): Reconnector {
  const initial = opts.initial ?? 1000;
  const max = opts.max ?? 15000;
  const timers = opts.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };
  let delay = initial;
  let timer: unknown = null;
  let stopped = false;
  return {
    schedule() {
      if (stopped || timer !== null) return;
      timer = timers.set(() => {
        timer = null;
        if (!stopped) connect();
      }, delay);
      delay = Math.min(delay * 2, max);
    },
    reset() { delay = initial; },
    stop() {
      stopped = true;
      if (timer !== null) timers.clear(timer);
      timer = null;
    },
    get stopped() { return stopped; },
    get pending() { return timer !== null; },
    get delay() { return delay; },
  };
}
