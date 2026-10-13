/**
 * The editor's local tool jobs (docs/EDITOR.md §10): RIFE slow motion and whisper.cpp transcription run as jobs with a
 * list, progress events, ETA, measured speed and cancel, like aiupscale's LocalUpscaler. Jobs run one at a time per
 * lane ("gpu" for RIFE and the CUDA build, "cpu" for the CPU build), so a long slow-motion render doesn't hold up a
 * short CPU transcription. Also the process runner the tools use (line-split output, kill on cancel).
 * Electron-free; tests drive it with fake runners.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { EditorJob, EditorJobKind } from "../shared/types.ts";
import { killTree } from "./ffmpeg.ts";

/** Run a program; every output line (stdout and stderr) goes to `onLine`; rejects with the last lines on failure. */
export type ProcRunner = (exe: string, args: string[], o: { cwd?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; onLine?(line: string): void })
  => Promise<void>;

export const runProc: ProcRunner = (exe, args, o) => new Promise((resolve, reject) => {
  if (o.signal?.aborted) { reject(new Error("cancelled")); return; }
  let child;
  try {
    child = spawn(exe, args, { cwd: o.cwd, env: o.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    reject(e as Error);
    return;
  }
  const tail: string[] = [];
  const feed = () => {
    let buf = "";
    return (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.search(/\r?\n|\r/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + (buf[i] === "\r" && buf[i + 1] === "\n" ? 2 : 1));
        if (!line) continue;
        o.onLine?.(line);
        tail.push(line);
        if (tail.length > 20) tail.shift();
      }
    };
  };
  child.stdout!.on("data", feed());
  child.stderr!.on("data", feed());
  const onAbort = () => { if (child.pid) killTree(child.pid); };
  o.signal?.addEventListener("abort", onAbort, { once: true });
  child.on("error", (e) => { o.signal?.removeEventListener("abort", onAbort); reject(e); });
  child.on("close", (code) => {
    o.signal?.removeEventListener("abort", onAbort);
    if (o.signal?.aborted) reject(new Error("cancelled"));
    else if (code === 0) resolve();
    else reject(new Error(`${exe.split(/[\\/]/).pop()} stopped (${code}): ${tail.slice(-4).join(" ").slice(0, 600)}`));
  });
});

const nowIso = () => new Date().toISOString();
const ACTIVE = new Set(["preparing", "extracting", "processing", "encoding", "importing"]);

export interface JobControl {
  signal: AbortSignal;
  /** merge into the job and send it (throttled unless `force`) */
  update(patch: Partial<EditorJob>, force?: boolean): void;
}

export class LocalJobs {
  private jobs: EditorJob[] = [];
  private aborts = new Map<string, AbortController>();
  private lanes = new Map<string, Promise<unknown>>();
  private lastEmit = new Map<string, number>();
  private o: { broadcast(j: EditorJob): void; log(msg: string): void };

  constructor(o: { broadcast(j: EditorJob): void; log(msg: string): void }) {
    this.o = o;
  }

  list(): EditorJob[] {
    return structuredClone([...this.jobs].reverse().slice(0, 100));
  }

  get(id: string): EditorJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  private emit(j: EditorJob, force = false): void {
    const now = Date.now();
    if (!force && now - (this.lastEmit.get(j.id) ?? 0) < 300) return;
    this.lastEmit.set(j.id, now);
    this.o.broadcast(structuredClone(j));
  }

  /**
   * Queue a job on a lane and run `fn` when its turn comes. Resolves with fn's result; rejects with its error, or
   * "cancelled". The job ends "done", "failed" or "cancelled".
   */
  run<T>(init: { kind: EditorJobKind; editPath: string; mediaId: string; name: string; id?: string }, lane: string,
    fn: (job: EditorJob, c: JobControl) => Promise<T>): { job: EditorJob; result: Promise<T> } {
    const id = init.id && /^[A-Za-z0-9_-]{6,64}$/.test(init.id) && !this.get(init.id) ? init.id : randomUUID();
    const job: EditorJob = { id, kind: init.kind, editPath: init.editPath, mediaId: init.mediaId, name: init.name, status: "queued", progress: 0,
      step: "Waiting", createdAt: nowIso() };
    this.jobs.push(job);
    if (this.jobs.length > 200) this.jobs.splice(0, this.jobs.length - 200);
    const abort = new AbortController();
    this.aborts.set(id, abort);
    this.emit(job, true);
    const prev = this.lanes.get(lane) ?? Promise.resolve();
    const t0 = { v: 0 };
    const result = prev.catch(() => undefined).then(async () => {
      if (abort.signal.aborted) throw new Error("cancelled");
      t0.v = Date.now();
      Object.assign(job, { status: "preparing", step: "Starting" });
      this.emit(job, true);
      const control: JobControl = {
        signal: abort.signal,
        update: (patch, force) => {
          Object.assign(job, patch);
          job.elapsed_s = Math.round((Date.now() - t0.v) / 1000);
          this.emit(job, force);
        },
      };
      return fn(job, control);
    }).then((v) => {
      Object.assign(job, { status: "done", progress: 1, step: "Done", eta_s: 0, finishedAt: nowIso() });
      if (t0.v) job.elapsed_s = Math.round((Date.now() - t0.v) / 1000);
      this.emit(job, true);
      return v;
    }, (e: Error) => {
      const cancelled = abort.signal.aborted;
      Object.assign(job, { status: cancelled ? "cancelled" : "failed", step: cancelled ? "Cancelled" : "Failed", eta_s: undefined,
        error: cancelled ? undefined : String(e?.message ?? e).slice(0, 1500), finishedAt: nowIso() });
      if (t0.v) job.elapsed_s = Math.round((Date.now() - t0.v) / 1000);
      if (!cancelled) this.o.log(`editor ${job.kind} ${job.name}: ${e?.message ?? e}`);
      this.emit(job, true);
      throw cancelled ? new Error("cancelled") : e;
    }).finally(() => { this.aborts.delete(id); });
    this.lanes.set(lane, result.catch(() => undefined));
    return { job, result };
  }

  cancel(id: string): void {
    const j = this.get(id);
    if (!j) return;
    const a = this.aborts.get(id);
    if (!a) return;
    a.abort();
    if (j.status === "queued") {
      Object.assign(j, { status: "cancelled", step: "Cancelled", finishedAt: nowIso() });
      this.emit(j, true);
    }
  }

  cancelAll(): void {
    for (const j of this.jobs) if (j.status === "queued" || ACTIVE.has(j.status)) this.cancel(j.id);
  }
}

/** ETA (s) from progress so far: elapsed / done × left, once a little is done. */
export function etaFrom(elapsedS: number, done: number, total: number): number | undefined {
  if (!(done > 0) || !(total > done) || elapsedS <= 0) return done >= total && total > 0 ? 0 : undefined;
  return Math.round((elapsedS / done) * (total - done));
}
