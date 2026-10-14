/**
 * The News delivery jobs list (docs/EDITOR.md §16.11): every export the panel starts is a desktop render job
 * (`newsroom.exportGraphics` queues it; the Render queue shows it too). Here they're followed through
 * `render.onProgress`, grouped (a batch, the shorts), cancelled, revealed in Explorer, and their errors put in plain
 * words. Lives for the window, so closing the panel keeps the list. No DOM at import time.
 */
import { useSyncExternalStore } from "react";
import { desktop, newsroomBridge, type NewsExportOptions, type RenderJob } from "../../../lib/desktop";

export interface DeliveryJob {
  /** The render job id (or a local id while it's being queued / when it couldn't start). */
  id: string; label: string; group?: string;
  status: RenderJob["status"] | "starting";
  progress: number; step: string; eta_s?: number;
  /** Where it's written (known when queued) and the file once done. */
  path?: string; output?: string;
  error?: string;
  started: number;
}

let jobs: DeliveryJob[] = [];
const subs = new Set<() => void>();
const set = (next: DeliveryJob[]) => { jobs = next; for (const s of subs) s(); };
const patch = (id: string, p: Partial<DeliveryJob>) => set(jobs.map((j) => (j.id === id ? { ...j, ...p } : j)));
let listening = false;
/** The newest progress of render jobs not in the list yet (a job can report before its id comes back). */
const early = new Map<string, RenderJob>();

const fromRender = (j: RenderJob): Partial<DeliveryJob> => ({ status: j.status, progress: j.progress, step: j.step, eta_s: j.eta_s,
  output: j.output ?? undefined, error: j.status === "failed" ? plainError(j.error) : undefined });

const ACTIVE = new Set(["starting", "queued", "preparing", "downloading", "rendering", "uploading"]);
export const isActive = (j: DeliveryJob) => ACTIVE.has(j.status);

/** An error from the desktop in plain words (no IPC wrapper, no FFmpeg log tail). */
export function plainError(e: unknown): string {
  let m = String((e as Error)?.message ?? e ?? "").replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^(Error|EditorError):\s*/, "");
  if (/ffmpeg failed/i.test(m)) m = "The video encoder stopped. Check there is free disk space, then try again.";
  else if (/GPU engine|WebGL|graphics card/i.test(m)) m = `The graphics card couldn't draw it: ${m.replace(/^GPU engine:\s*/, "")}`;
  else if (/render window closed/i.test(m)) m = "The render window closed before the export finished. Try again.";
  return m.split("\n")[0].slice(0, 300) || "Something went wrong";
}

function listen() {
  if (listening) return;
  const d = desktop();
  if (!d) return;
  listening = true;
  d.render.onProgress((j) => {
    if (!jobs.some((x) => x.id === j.id)) {
      early.set(j.id, j);
      if (early.size > 50) early.delete(early.keys().next().value!);
      return;
    }
    patch(j.id, fromRender(j));
  });
}

/** Queues one export; returns its job (status "failed" with the reason when it couldn't start). */
export async function queueExport(label: string, o: NewsExportOptions, group?: string): Promise<DeliveryJob> {
  listen();
  const local = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const job: DeliveryJob = { id: local, label, group, status: "starting", progress: 0, step: "Starting", started: Date.now() };
  set([job, ...jobs].slice(0, 200));
  const b = newsroomBridge();
  if (!b) {
    patch(local, { status: "failed", error: "Exports need the Tatvam Desktop app" });
    return jobs.find((j) => j.id === local)!;
  }
  try {
    const r = await b.exportGraphics(o);
    if (!r?.jobId) throw new Error("The export didn't start");
    // the render may already have reported under its own id
    const seen = early.get(r.jobId);
    early.delete(r.jobId);
    set(jobs.map((j) => (j.id === local ? { ...j, id: r.jobId!, path: r.path, status: "queued" as const, step: "Waiting", ...(seen ? fromRender(seen) : {}) } : j)));
    return jobs.find((j) => j.id === r.jobId)!;
  } catch (e) {
    patch(local, { status: "failed", error: plainError(e) });
    return jobs.find((j) => j.id === local)!;
  }
}

export async function cancelJob(id: string): Promise<void> {
  const j = jobs.find((x) => x.id === id);
  if (!j || !isActive(j)) return;
  if (id.startsWith("local-")) { patch(id, { status: "cancelled", step: "Cancelled" }); return; }
  await desktop()?.render.cancel(id).catch(() => undefined);
}

export async function cancelGroup(group: string): Promise<void> {
  for (const j of jobs.filter((x) => x.group === group && isActive(x))) await cancelJob(j.id);
}

/** Shows the file (or the PNG folder) in Explorer. */
export async function revealJob(id: string): Promise<void> {
  await desktop()?.render.reveal(id).catch(() => undefined);
}

export function clearFinished(): void { set(jobs.filter(isActive)); }

export function useDeliveryJobs(): DeliveryJob[] {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => jobs);
}
