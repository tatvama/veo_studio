/**
 * The AI tools' studio side (docs/EDITOR.md §8): the edit's studio project (made on first use, kept as
 * studioProjectId), media uploads (cached on the media item as studioKey), price and run of each tool, waiting for its
 * job, and bringing results back into the edit. Paid runs go through runFlow: price first, then the studio's jobs,
 * budgets and approvals.
 */
import { api, ApiError } from "../../lib/api";
import { uid } from "../model/ids";
import { secondsToFrames } from "../model/time";
import { bridgeMessage, editorBridge } from "./bridge";
import { ensureDialogs } from "./dialogs";
import type { EditorHost, MediaItem } from "./host-types";
import { askPrice, useAi } from "./store";
import type { AiJob, Estimate, Output, RunResult, ToolCall, ToolsInfo, UploadedAsset, VoicesInfo } from "./types";

const base = (pid: number) => `/api/edits/${pid}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof ApiError ? e.message : bridgeMessage(e));

// ── the edit's studio project ────────────────────────────────────────────────

export async function ensureStudioProject(host: EditorHost): Promise<number> {
  const have = host.studioProjectId();
  if (have) return have;
  const p = host.project();
  const editId = (p.id || "").replace(/[^A-Za-z0-9_.:-]/g, "_").padEnd(4, "_").slice(0, 80);
  const r = await api.post<{ id: number }>("/api/edits", { name: (p.name || "Untitled edit").slice(0, 200), edit_id: editId });
  host.setStudioProjectId(r.id);
  return r.id;
}

// ── media for the tools ──────────────────────────────────────────────────────

const uploads = new Map<string, Promise<string>>();
const EXT_OF_MIME: Record<string, string> = {
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/flac": "flac", "audio/ogg": "ogg", "image/png": "png",
  "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
};

function fileName(m: MediaItem, mime: string): string {
  const fromPath = (m.path.split(/[\\/]/).pop() ?? "").trim();
  if (/\.[a-z0-9]{2,4}$/i.test(fromPath)) return fromPath;
  if (/\.[a-z0-9]{2,4}$/i.test(m.name)) return m.name;
  return `${m.name || "media"}.${EXT_OF_MIME[mime.split(";")[0]] ?? (m.kind === "audio" ? "wav" : m.kind === "image" ? "png" : "mp4")}`;
}

async function upload(host: EditorHost, pid: number, m: MediaItem): Promise<string> {
  const b = editorBridge();
  if (b?.uploadAsset) {
    try {
      return (await b.uploadAsset(host.path(), m.id, pid)).key;
    } catch (e) {
      throw new Error(`Upload of ${m.name}: ${bridgeMessage(e)}`);
    }
  }
  if (!m.url) throw new Error("Sending media to the AI tools needs Tatvam Desktop");
  const res = await fetch(m.url, { credentials: "include" });
  if (!res.ok) throw new Error(`Couldn't read ${m.name} (${res.status})`);
  const blob = await res.blob();
  const file = new File([blob], fileName(m, blob.type), { type: blob.type });
  return (await api.upload<UploadedAsset>(`${base(pid)}/assets`, file)).key;
}

/** The studio key of a media item: studio media has one, an upload is made once and remembered (studioKey). */
export async function ensureKey(host: EditorHost, mediaId: string, opts: { fresh?: boolean } = {}): Promise<string> {
  const m = host.project().media.find((x) => x.id === mediaId);
  if (!m) throw new Error("That media is no longer in the project");
  if (m.path.startsWith("studio:")) return m.path.slice(7);
  if (m.studioKey && !opts.fresh) return m.studioKey;
  const pid = await ensureStudioProject(host);
  const k = `${pid}:${mediaId}`;
  let job = uploads.get(k);
  if (!job || opts.fresh) {
    job = upload(host, pid, m).finally(() => uploads.delete(k));
    uploads.set(k, job);
  }
  const key = await job;
  if (host.project().media.find((x) => x.id === mediaId)?.studioKey !== key) {
    host.apply(`Send ${m.name} to the studio`, (d) => { const x = d.media.find((i) => i.id === mediaId); if (x) x.studioKey = key; });
  }
  return key;
}

// ── tools ────────────────────────────────────────────────────────────────────

const body = (c: ToolCall) => ({ tool: c.tool, params: c.params, what: (c.what ?? "").slice(0, 120) });
export const estimate = (pid: number, c: ToolCall) => api.post<Estimate>(`${base(pid)}/ai/estimate`, body(c), { silent: true });
export const startTool = (pid: number, c: ToolCall) => api.post<RunResult>(`${base(pid)}/ai/run`, body(c), { silent: true });
export const getJob = (pid: number, jid: number) => api.get<AiJob>(`${base(pid)}/ai/jobs/${jid}`, { silent: true });
export const toolsInfo = (pid: number) => api.get<ToolsInfo>(`${base(pid)}/ai/tools`, { silent: true });
export const voicesFor = (pid: number, language: string) => api.get<VoicesInfo>(`${base(pid)}/ai/voices?language=${encodeURIComponent(language)}`, { silent: true });
export const cancelJob = (jid: number) => api.post(`/api/jobs/${jid}/cancel`, {}, { silent: true });

const FINAL = new Set(["succeeded", "failed", "cancelled"]);

/** Polls a job until it ends (an approval wait keeps polling; the caller shows it). */
export async function waitJob(pid: number, jid: number, onUpdate?: (j: AiJob) => void): Promise<AiJob> {
  let delay = 700;
  for (;;) {
    try {
      const j = await getJob(pid, jid);
      onUpdate?.(j);
      if (FINAL.has(j.status)) return j;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 401 || e.status === 403)) throw e;
    }
    await sleep(delay);
    delay = Math.min(delay * 1.2, 3000);
  }
}

// ── results back into the edit ───────────────────────────────────────────────

export const AUDIO_RATE = 48000;

/**
 * A studio file as a media item without the desktop (browser / demo), played from its studio link. The editor's
 * conventions: audio counts in samples (fps = sample rate), video in frames (the sequence's rate here, a guess: the
 * desktop's import probes the file), images 0 / 0.
 */
export function studioMedia(host: EditorHost, o: Output): MediaItem {
  const seq = host.sequence();
  const fps = o.kind === "audio" ? AUDIO_RATE : o.kind === "image" ? 0 : seq.fps;
  return {
    id: uid("m"), binId: null, name: o.name, kind: o.kind, path: `studio:${o.key}`, url: o.url,
    duration: o.kind === "image" ? 0 : o.kind === "audio" ? Math.max(1, Math.round(o.duration * AUDIO_RATE)) : Math.max(1, secondsToFrames(o.duration, fps)),
    fps, width: o.width ?? (o.kind === "audio" ? 0 : seq.width), height: o.height ?? (o.kind === "audio" ? 0 : seq.height),
    hasAudio: o.kind !== "image", markers: [], studioKey: o.key, seconds: o.duration,
    ...(o.kind === "audio" ? { sampleRate: AUDIO_RATE } : {}),
  };
}

/** Downloads a result into the edit (Media\ on the desktop) and adds it to the AI bin. */
export async function importOutput(host: EditorHost, o: Output, bin = "AI"): Promise<MediaItem> {
  const b = editorBridge();
  let item: MediaItem;
  if (b?.importStudioAsset) {
    try {
      item = { ...(await b.importStudioAsset(host.path(), o.key, o.name)) };
    } catch (e) {
      throw new Error(`Download of ${o.name}: ${bridgeMessage(e)}`);
    }
  } else item = studioMedia(host, o);
  item = { ...item, name: o.name || item.name, studioKey: o.key };
  host.addMedia([item], bin);
  return item;
}

// ── a paid run ───────────────────────────────────────────────────────────────

export interface Flow {
  /** Shown in the runs list and the price dialog. */
  title: string;
  /** The tool calls (uploading what they need); `fresh` re-uploads media the studio lost. */
  prepare(say: (msg: string) => void, fresh: boolean): Promise<ToolCall[]>;
  /** Puts the finished results into the edit. */
  apply(jobs: AiJob[]): Promise<void> | void;
  note?: string;
}

/**
 * Price first, then the run: uploads → estimate (one line per call) → the price dialog (free runs within budget start
 * at once) → jobs.submit on the studio (over a limit it waits for an approval) → wait → apply. Null when it was
 * stopped or failed (already shown).
 */
export async function runFlow(host: EditorHost, flow: Flow): Promise<AiJob[] | null> {
  ensureDialogs();
  const { upsert } = useAi.getState();
  const id = uid("run");
  upsert({ id, title: flow.title, status: "preparing", message: "Connecting to the studio" });
  try {
    const pid = await ensureStudioProject(host);
    upsert({ id, pid, status: "uploading", message: "Preparing" });
    const say = (message: string) => upsert({ id, message });
    let calls = await flow.prepare(say, false);
    if (!calls.length) throw new Error("Nothing to work on");
    upsert({ id, status: "pricing", message: "Pricing" });
    let ests: Estimate[];
    try {
      ests = await Promise.all(calls.map((c) => estimate(pid, c)));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
      calls = await flow.prepare(say, true);  // the studio lost an upload: send it again
      ests = await Promise.all(calls.map((c) => estimate(pid, c)));
    }
    const total = Math.round(ests.reduce((s, e) => s + e.total_usd, 0) * 10000) / 10000;
    const lines = ests.flatMap((e, i) => e.items.map((l) => ({ label: calls.length > 1 && calls[i].what ? `${calls[i].what} · ${l.label}` : l.label, usd: l.usd })));
    if (!(await askPrice(flow.title, total, lines, ests.map((e) => e.budget), flow.note))) {
      useAi.getState().dismiss(id);
      return null;
    }
    const started: RunResult[] = [];
    for (const c of calls) started.push(await startTool(pid, c));
    const jobIds = started.map((r) => r.job_id).filter((x): x is number => !!x);
    const waiting = started.some((r) => r.status === "awaiting_approval");
    if (waiting) host.toast(`${flow.title}: sent to a producer for approval (${started.find((r) => r.reason)?.reason ?? "over a limit"})`, "warn");
    upsert({ id, jobIds, usd: total, status: waiting ? "awaiting_approval" : "queued", message: waiting ? "Waiting for approval" : "Queued" });
    const last = new Map<number, AiJob>();
    const report = () => {
      const js = [...last.values()];
      const progress = js.reduce((s, j) => s + (FINAL.has(j.status) ? 1 : j.progress || 0), 0) / Math.max(jobIds.length, 1);
      const approval = js.some((j) => j.status === "awaiting_approval");
      const run = js.find((j) => j.status === "running");
      upsert({ id, progress, status: approval ? "awaiting_approval" : run ? "running" : "queued",
        message: approval ? "Waiting for approval" : run?.message || (run ? "Working" : "Queued") });
    };
    const jobs = await Promise.all(jobIds.map((jid) => waitJob(pid, jid, (j) => { last.set(jid, j); report(); })));
    const bad = jobs.find((j) => j.status !== "succeeded");
    if (bad) {
      upsert({ id, status: bad.status === "cancelled" ? "cancelled" : "failed", error: bad.error || bad.status, progress: 1 });
      if (bad.status !== "cancelled") host.toast(`${flow.title}: ${(bad.error || "failed").split("\n")[0].slice(0, 200)}`, "error");
      return null;
    }
    upsert({ id, status: "applying", message: "Adding to the edit", progress: 1 });
    await flow.apply(jobs);
    upsert({ id, status: "done", message: "Done", usd: jobs.reduce((s, j) => s + (j.cost_actual || 0), 0) || total });
    return jobs;
  } catch (e) {
    const msg = errText(e);
    upsert({ id, status: "failed", error: msg });
    host.toast(`${flow.title}: ${msg}`, "error");
    return null;
  }
}
