/**
 * Long assistant jobs (docs/EDITOR.md §13.2): analysis, local Whisper, auto edit's analysis pass and the AI flows the
 * editor window runs return a job id at once; `job_status` follows them (and can wait, sending MCP progress
 * notifications). Renders keep their own ids in the RenderManager (`render_status`). Electron-free.
 */
import { randomBytes } from "node:crypto";

export type JobState = "queued" | "running" | "awaiting_approval" | "done" | "failed" | "cancelled";
export interface McpJob {
  id: string; kind: string; label: string; status: JobState; progress: number; message: string;
  result?: unknown; error?: string; createdAt: string; finishedAt?: string;
  /** the session that started it */
  session?: string;
  /** the editor window runs it (AI flows) */
  edit?: string;
}

const FINAL = new Set<JobState>(["done", "failed", "cancelled"]);
export const isFinal = (s: string) => FINAL.has(s as JobState);

export class McpJobs {
  private jobs = new Map<string, McpJob>();
  private aborts = new Map<string, AbortController>();
  private waiters = new Map<string, Set<() => void>>();

  /** Starts `run` now; the job ends with its result or error. */
  start<T>(o: { kind: string; label: string; session?: string; edit?: string }, run: (j: { signal: AbortSignal; update(p: Partial<McpJob>): void }) => Promise<T>): McpJob {
    const job = this.create(o);
    const ac = new AbortController();
    this.aborts.set(job.id, ac);
    this.update(job.id, { status: "running" });
    void run({ signal: ac.signal, update: (p) => this.update(job.id, p) })
      .then((result) => this.update(job.id, { status: "done", progress: 1, result, message: "Done" }))
      .catch((e) => this.update(job.id, ac.signal.aborted ? { status: "cancelled", message: "Cancelled" }
        : { status: "failed", error: String((e as Error)?.message ?? e).slice(0, 1000), message: "Failed" }))
      .finally(() => this.aborts.delete(job.id));
    return this.get(job.id)!;
  }

  /** A job something else drives (the editor window): update() moves it on. */
  create(o: { kind: string; label: string; session?: string; edit?: string }): McpJob {
    const id = `j_${randomBytes(5).toString("hex")}`;
    const job: McpJob = { id, kind: o.kind, label: o.label, status: "queued", progress: 0, message: "Queued", createdAt: new Date().toISOString(),
      ...(o.session ? { session: o.session } : {}), ...(o.edit ? { edit: o.edit } : {}) };
    this.jobs.set(id, job);
    if (this.jobs.size > 300) for (const k of [...this.jobs.keys()].slice(0, 50)) if (isFinal(this.jobs.get(k)!.status)) this.jobs.delete(k);
    return { ...job };
  }

  update(id: string, p: Partial<McpJob>): void {
    const j = this.jobs.get(id);
    if (!j || isFinal(j.status)) return;
    Object.assign(j, p);
    if (typeof j.progress === "number") j.progress = Math.max(0, Math.min(1, j.progress));
    if (isFinal(j.status)) j.finishedAt = new Date().toISOString();
    for (const w of this.waiters.get(id) ?? []) w();
  }

  get(id: string): McpJob | undefined {
    const j = this.jobs.get(id);
    return j ? { ...j } : undefined;
  }

  list(): McpJob[] { return [...this.jobs.values()].map((j) => ({ ...j })).reverse(); }

  cancel(id: string): boolean {
    const ac = this.aborts.get(id);
    if (ac) { ac.abort(); return true; }
    const j = this.jobs.get(id);
    if (j && !isFinal(j.status)) { this.update(id, { status: "cancelled", message: "Cancelled" }); return true; }
    return false;
  }

  /** Resolves on the next change of the job, or after `ms`. */
  changed(id: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      const done = () => { clearTimeout(t); set.delete(done); resolve(); };
      const t = setTimeout(done, ms);
      set.add(done);
      this.waiters.set(id, set);
    });
  }

  /** Waits up to `seconds` for the job to end, calling `onProgress` on every change. */
  async wait(id: string, seconds: number, onProgress?: (j: McpJob) => void): Promise<McpJob | undefined> {
    const until = Date.now() + Math.max(0, Math.min(120, seconds)) * 1000;
    let j = this.get(id);
    while (j && !isFinal(j.status) && Date.now() < until) {
      await this.changed(id, Math.min(1000, until - Date.now()));
      j = this.get(id);
      if (j) onProgress?.(j);
    }
    return j;
  }
}
