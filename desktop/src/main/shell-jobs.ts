/**
 * One queue of everything the desktop is doing (renders, local AI upscales, editor tool jobs, tool downloads, folder
 * syncs), for the status bar, the taskbar progress and the tray. It also notices when a job finishes or fails, so the
 * shell can notify. Pure (test/shell.test.ts).
 */
import type { EditorJob, JobItem, JobsSummary, RenderJob, SyncStatus, ToolStatus, UpscaleJob } from "../shared/types.ts";

export type JobEvent =
  | { type: "done" | "failed"; item: JobItem; source: "render"; job: RenderJob }
  | { type: "done" | "failed"; item: JobItem; source: "upscale"; job: UpscaleJob }
  | { type: "done" | "failed"; item: JobItem; source: "editor"; job: EditorJob }
  | { type: "done" | "failed"; item: JobItem; source: "tool"; job: ToolStatus }
  | { type: "done" | "failed"; item: JobItem; source: "sync"; job: SyncStatus };

const ACTIVE_RENDER = ["queued", "preparing", "downloading", "rendering", "uploading"];
const ACTIVE_UPSCALE = ["queued", "preparing", "extracting", "upscaling", "encoding", "uploading"];
const ACTIVE_EDITOR = ["queued", "preparing", "extracting", "processing", "encoding", "importing"];
const ACTIVE_SYNC = ["manifest", "downloading", "renaming", "cleaning"];

const presetName = (p: string) => p.replace(/_/g, " ");

export function renderItem(j: RenderJob): JobItem {
  const label = j.kind === "edit" ? `Export ${j.sequenceName ?? "sequence"} · ${presetName(j.preset)}` : `Render E${j.eid} ${j.lang.toUpperCase()} · ${presetName(j.preset)}`;
  return { id: `render:${j.id}`, kind: "render", label, progress: clamp(j.progress), status: j.status, ...(j.error ? { error: j.error } : {}), ...(j.eta_s !== undefined ? { eta_s: j.eta_s } : {}) };
}
export function upscaleItem(j: UpscaleJob): JobItem {
  return { id: `upscale:${j.id}`, kind: "upscale", label: `AI upscale ${j.code} → ${j.to[1]}p`, progress: clamp(j.progress), status: j.status,
    ...(j.error ? { error: j.error } : {}), ...(j.eta_s !== undefined ? { eta_s: j.eta_s } : {}) };
}
export function editorItem(j: EditorJob): JobItem {
  return { id: `editor:${j.id}`, kind: "editor", label: `${j.kind === "interpolate" ? "Slow motion" : "Transcribe"} · ${j.name}`, progress: clamp(j.progress), status: j.status,
    ...(j.error ? { error: j.error } : {}), ...(j.eta_s !== undefined ? { eta_s: j.eta_s } : {}) };
}
export function toolItem(t: ToolStatus): JobItem {
  return { id: `tool:${t.id}`, kind: "tool", label: `Download ${t.label}`, progress: clamp(t.progress), status: t.installing ? "downloading" : t.error ? "failed" : t.installed ? "done" : "idle",
    ...(t.error ? { error: t.error } : {}) };
}
export function syncItem(s: SyncStatus): JobItem {
  const p = s.bytesTotal > 0 ? s.bytes / s.bytesTotal : s.total > 0 ? s.done / s.total : 0;
  return { id: `sync:${s.pid}`, kind: "sync", label: `Sync project #${s.pid}${s.current ? ` · ${s.current}` : ""}`, progress: clamp(p), status: s.phase,
    ...(s.errors?.length && s.phase === "error" ? { error: s.errors[s.errors.length - 1] } : {}) };
}

function clamp(v: number | undefined): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v as number)) : 0;
}

function isActive(it: JobItem): boolean {
  switch (it.kind) {
    case "render": return ACTIVE_RENDER.includes(it.status);
    case "upscale": return ACTIVE_UPSCALE.includes(it.status);
    case "editor": return ACTIVE_EDITOR.includes(it.status);
    case "tool": return it.status === "downloading";
    case "sync": return ACTIVE_SYNC.includes(it.status);
  }
}

export class JobTracker {
  private items = new Map<string, JobItem>();
  private lastError = 0;
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Feed a job update; "done" / "failed" when this update moved it into that state (not on repeats). */
  private put(it: JobItem, terminal: "done" | "failed" | null): "done" | "failed" | null {
    const prev = this.items.get(it.id);
    this.items.set(it.id, it);
    if (!terminal || prev?.status === it.status) return null;
    if (terminal === "failed") this.lastError = this.now();
    return terminal;
  }

  private static term(status: string): "done" | "failed" | null {
    return status === "done" ? "done" : status === "failed" ? "failed" : null;
  }

  render(j: RenderJob): JobEvent | null {
    const it = renderItem(j);
    const r = this.put(it, JobTracker.term(j.status));
    return r ? { type: r, item: it, source: "render", job: j } : null;
  }
  upscale(j: UpscaleJob): JobEvent | null {
    const it = upscaleItem(j);
    const r = this.put(it, JobTracker.term(j.status));
    return r ? { type: r, item: it, source: "upscale", job: j } : null;
  }
  editor(j: EditorJob): JobEvent | null {
    const it = editorItem(j);
    const r = this.put(it, JobTracker.term(j.status));
    return r ? { type: r, item: it, source: "editor", job: j } : null;
  }
  tool(t: ToolStatus): JobEvent | null {
    const it = toolItem(t);
    const prev = this.items.get(it.id);
    this.items.set(it.id, it);
    if (prev?.status === "downloading" && !t.installing) {
      if (t.error) { this.lastError = this.now(); return { type: "failed", item: it, source: "tool", job: t }; }
      if (t.installed) return { type: "done", item: it, source: "tool", job: t };
    }
    return null;
  }
  sync(s: SyncStatus): JobEvent | null {
    const it = syncItem(s);
    const prev = this.items.get(it.id);
    this.items.set(it.id, it);
    const was = prev ? ACTIVE_SYNC.includes(prev.status) : false;
    if (was && s.phase === "done") return { type: "done", item: it, source: "sync", job: s };
    if (was && s.phase === "error") { this.lastError = this.now(); return { type: "failed", item: it, source: "sync", job: s }; }
    return null;
  }

  summary(): JobsSummary {
    const all = [...this.items.values()];
    const active = all.filter(isActive);
    const running = active.filter((i) => i.status !== "queued").length;
    const queued = active.length - running;
    const prog = active.length ? active.reduce((a, i) => a + i.progress, 0) / active.length : null;
    // the 8 newest active jobs first, then the finished ones of the last while
    const items = [...active, ...all.filter((i) => !isActive(i) && i.status !== "idle")].slice(0, 12);
    return { running, queued, items, progress: prog, error: this.now() - this.lastError < 15_000 };
  }

  /** Is a render (or export) running? (the taskbar's Cancel button, "keep rendering when closed") */
  activeRenders(): JobItem[] {
    return [...this.items.values()].filter((i) => i.kind === "render" && isActive(i));
  }
}
