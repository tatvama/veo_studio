/**
 * One-at-a-time guard for actions that must not run twice (a double click on "Generate" would spend twice).
 * Pure: the React hook in useBusyAction.ts wraps it. `run(key, fn)` runs `fn` unless something is already running,
 * reports the active key through `onChange`, and swallows rejections (the api layer has already shown the error).
 */
export interface BusyLatch {
  /** The key of the action in flight, or null. */
  readonly key: string | null;
  /** Runs `fn` tagged `key`; resolves to its value, or to undefined when it was skipped (busy) or threw. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined>;
}

export function createBusyLatch(onChange?: (key: string | null) => void): BusyLatch {
  let key: string | null = null;
  const set = (k: string | null) => {
    key = k;
    onChange?.(k);
  };
  return {
    get key() { return key; },
    async run<T>(k: string, fn: () => Promise<T>): Promise<T | undefined> {
      if (key !== null) return undefined;
      set(k);
      try {
        return await fn();
      } catch {
        return undefined;
      } finally {
        set(null);
      }
    },
  };
}
