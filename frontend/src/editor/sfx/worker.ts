/**
 * The SFX render worker: renderSfx off the page's main thread (the library's previews and thumbnails, generated
 * media). One message per render; the samples come back transferred.
 */
import { renderSfx } from "./engine.ts";
import { peaksOf } from "./level.ts";

interface Job { n: number; id: string; values: Record<string, number>; seed: number; peaks: number }
const scope = self as unknown as { postMessage(m: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<Job>) => void) | null };

scope.onmessage = (e) => {
  const j = e.data;
  try {
    const channels = renderSfx(j.id, j.values, j.seed);
    scope.postMessage({ n: j.n, channels, peaks: j.peaks > 0 ? peaksOf(channels, j.peaks) : [] }, channels.map((c) => c.buffer as ArrayBuffer));
  } catch (err) {
    scope.postMessage({ n: j.n, error: String((err as Error)?.message ?? err) });
  }
};
