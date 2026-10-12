/**
 * Resumable downloads from the server: a `.part` file next to the target, `Range` to resume, the size checked
 * against Content-Length / Content-Range, then an atomic rename into place. Used by sync and render.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { Upstream } from "./upstream.ts";

export interface DownloadResult { size: number; etag: string }

export async function downloadTo(up: Upstream, urlPath: string, dest: string,
  opts: { signal?: AbortSignal; onBytes?(delta: number, received: number, total: number): void } = {}): Promise<DownloadResult> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let have = 0;
    try { have = (await fsp.stat(part)).size; } catch { have = 0; }
    const headers: Record<string, string> = { Accept: "*/*" };
    if (have > 0) headers.Range = `bytes=${have}-`;
    const r = await up.fetch(urlPath, { headers, signal: opts.signal });
    if (r.status === 416 && have > 0) { // the .part is stale or already complete: start over once
      await r.body?.cancel();
      await fsp.rm(part, { force: true });
      continue;
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error(`download ${urlPath}: HTTP ${r.status}`);
    }
    const resumed = r.status === 206 && have > 0;
    let total = 0;
    if (r.status === 206) {
      const m = /\/(\d+)\s*$/.exec(r.headers.get("content-range") || "");
      total = m ? Number(m[1]) : 0;
    } else {
      total = Number(r.headers.get("content-length") || 0);
    }
    let received = resumed ? have : 0;
    const fh = await fsp.open(part, resumed ? "a" : "w");
    try {
      if (r.body) {
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
          await fh.write(chunk);
          received += chunk.byteLength;
          opts.onBytes?.(chunk.byteLength, received, total);
        }
      }
    } finally {
      await fh.close();
    }
    const size = (await fsp.stat(part)).size;
    if (total && size !== total) throw new Error(`download ${urlPath}: got ${size} of ${total} bytes`);
    await fsp.rm(dest, { force: true });
    await fsp.rename(part, dest);
    return { size, etag: r.headers.get("etag") || "" };
  }
  throw new Error(`download ${urlPath}: could not resume`);
}

/** A tiny promise pool: runs `worker` over `items`, `limit` at a time. */
export async function pool<T>(items: T[], limit: number, worker: (item: T, i: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !signal?.aborted) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}
