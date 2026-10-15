/**
 * Chunked, resumable render upload to the Render Center (docs/DESKTOP.md §2.5): init, PUT chunks at an offset
 * (a 409 says where the server is, so the client resumes there), GET the status to resume after a restart, then
 * complete with the SRT. Electron-free; unit test: test/upload.test.ts.
 */
import { promises as fsp } from "node:fs";
import { isNetworkError } from "./offline.ts";
import { UpstreamError, type Upstream } from "./upstream.ts";

export interface UploadMeta {
  filename: string; size: number; language: string; preset: string; w: number; h: number; fps: number;
  codec: string; encoder: string; cut_version: number | null; duration_s: number; machine: string;
  /** The render plan's fingerprint, so review notes can tell whether the cut changed since. */
  fingerprint?: string;
}

export interface UploadProgress { uploadId: string; received: number; size: number }

const DEFAULT_CHUNK = 8 * 1024 * 1024;
/** Consecutive 409s at the same offset before the upload gives up (a server that never accepts the chunk it asks for). */
export const MAX_SAME_OFFSET_CONFLICTS = 5;

function receivedOf(body: unknown): number | undefined {
  const b = body as { received?: unknown; detail?: { received?: unknown } } | undefined;
  const v = b?.received ?? b?.detail?.received;
  return typeof v === "number" ? v : undefined;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("cancelled")); }, { once: true });
});

export async function uploadFile(up: Upstream, opts: {
  eid: number; file: string; meta: UploadMeta; srt?: string; uploadId?: string; signal?: AbortSignal;
  onProgress?(p: UploadProgress): void; onInit?(uploadId: string): void; retries?: number; retryDelayMs?: number;
}): Promise<{ uploadId: string; export: Record<string, unknown> }> {
  // open once and take the size from the open handle, so the file we measure is the file we send
  const fh = await fsp.open(opts.file, "r");
  let uid = "";
  try {
    uid = await sendChunks(up, opts, fh);
  } finally {
    await fh.close();
  }
  const exp = await up.json<Record<string, unknown>>(`/api/renders/uploads/${uid}/complete`, { method: "POST", body: { srt: opts.srt ?? null } });
  return { uploadId: uid, export: exp };
}

async function sendChunks(up: Upstream, opts: Parameters<typeof uploadFile>[1], fh: fsp.FileHandle): Promise<string> {
  const size = (await fh.stat()).size;
  let uploadId = opts.uploadId;
  let chunk = DEFAULT_CHUNK;
  let received = 0;
  if (uploadId) {
    try {
      const st = await up.json<{ received: number; size: number }>(`/api/renders/uploads/${uploadId}`);
      if (st.size !== size) uploadId = undefined;
      else received = st.received;
    } catch (e) {
      if (e instanceof UpstreamError && (e.status === 404 || e.status === 410)) uploadId = undefined;
      else throw e;
    }
  }
  if (!uploadId) {
    const init = await up.json<{ upload_id: string | number; chunk_size?: number }>(`/api/episodes/${opts.eid}/renders/uploads`, {
      method: "POST", body: { ...opts.meta, size },
    });
    uploadId = String(init.upload_id);
    chunk = init.chunk_size || DEFAULT_CHUNK;
    received = 0;
    opts.onInit?.(uploadId);
  }
  const uid = uploadId;
  opts.onProgress?.({ uploadId: uid, received, size });
  const maxTries = opts.retries ?? 8;
  let tries = 0;
  let conflicts = 0;
  let conflictAt = -1;
  while (received < size) {
    if (opts.signal?.aborted) throw new Error("cancelled");
    const len = Math.min(chunk, size - received);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, received);
    try {
      const r = await up.fetch(`/api/renders/uploads/${uid}?offset=${received}`, {
        method: "PUT", body: buf, headers: { "Content-Type": "application/octet-stream" }, signal: opts.signal,
      });
      const text = await r.text();
      let body: unknown;
      try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
      if (r.status === 409) {
        const at = receivedOf(body);
        if (at === undefined) throw new UpstreamError(409, body, "upload offset rejected without a position");
        // resume where the server says; but a server that keeps answering 409 at the same byte would loop for ever
        conflicts = at === conflictAt ? conflicts + 1 : 1;
        conflictAt = at;
        if (conflicts >= MAX_SAME_OFFSET_CONFLICTS) {
          throw new UpstreamError(409, body, `upload stuck: the server rejected the chunk at byte ${at} ${conflicts} times in a row`);
        }
        received = at;
        continue;
      }
      if (!r.ok) throw new UpstreamError(r.status, (body as { detail?: unknown })?.detail ?? body, `upload chunk: HTTP ${r.status}`);
      received = receivedOf(body) ?? received + len;
      tries = 0;
      conflicts = 0;
      opts.onProgress?.({ uploadId: uid, received, size });
    } catch (e) {
      const retryable = isNetworkError(e) || (e instanceof UpstreamError && e.status >= 500);
      if (!retryable || opts.signal?.aborted || ++tries > maxTries) throw e;
      await sleep(Math.min(30_000, (opts.retryDelayMs ?? 1000) * 2 ** (tries - 1)), opts.signal);
      try { // where did the server get to?
        received = (await up.json<{ received: number }>(`/api/renders/uploads/${uid}`)).received;
      } catch { /* still down: retry the same chunk */ }
    }
  }
  return uid;
}
