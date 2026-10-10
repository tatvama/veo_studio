import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowLeftRight, Ban, ChevronDown, ChevronUp, Loader2, Play, RotateCcw, ShieldAlert, X, XCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { ago, secs, usd } from "../lib/format";
import { tr, useT } from "../lib/i18n";
import { useAuthStatus, useJobs, useShotAlternatives } from "../lib/queries";
import { useUI } from "../lib/store";
import { ROLE_RANK, type Job, type SubmitResult } from "../lib/types";
import "../styles/console.css";
import "../styles/director.css";
import { useGenerate } from "./Generate";
import { Button, IconButton, StatusDot, Tooltip } from "./ui";

const TYPE_LABEL: Record<string, string> = {
  keyframe: "Keyframes", video: "Videos", lipsync: "Lip-sync", voice: "Voices", qc: "Quality checks", sfx: "Sound design", music: "Music",
  export: "Renders", marketing: "Marketing pack", train_identity: "Identity training", character_sheet: "Character sheets", dub: "Dubbing",
  table_read: "Table read", search_index: "Search index", animatic: "Animatic", extend: "Extensions", edit: "Edits", shootout: "Shootout",
  scene_chain: "Scenes in order",
  voicelock: "Voice lock", narration: "Narration", location_plate: "Location plates", thumbnail: "Thumbnails",
};

const ACTIVE = new Set(["running", "queued", "awaiting_approval", "proposed"]);
/** How long a failed job keeps the (otherwise idle) bar on screen. */
const FRESH_FAIL_MS = 10 * 60_000;

type Tone = "neutral" | "accent" | "ai" | "ok" | "warn" | "bad" | "info";
const STATUS_TONE: Record<string, Tone> = {
  running: "accent", queued: "info", awaiting_approval: "warn", proposed: "ai", succeeded: "ok", failed: "bad", cancelled: "neutral",
};
const TEXT: Record<Tone, string> = {
  neutral: "text-dim", accent: "text-accent-ink", ai: "text-ai", ok: "text-ok", warn: "text-warn", bad: "text-bad", info: "text-info",
};

function useStatusLabel() {
  const t = useT();
  const labels: Record<string, string> = {
    proposed: t("proposed"), queued: t("queued"), running: t("running"), awaiting_approval: t("awaiting approval"),
    succeeded: t("succeeded"), failed: t("failed"), cancelled: t("cancelled"),
  };
  return (s: string) => labels[s] ?? s.replace(/_/g, " ");
}

/** Re-renders every second while `on` (for elapsed / time-left readouts). */
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  return now;
}

/** Rough time left for a running job from how far it got and how long that took. */
function etaSeconds(j: Job, now: number): number | null {
  if (j.status !== "running" || !j.started_at || j.progress < 0.06 || j.progress >= 1) return null;
  const elapsed = (now - new Date(j.started_at).getTime()) / 1000;
  if (!Number.isFinite(elapsed) || elapsed < 2) return null;
  return Math.max(1, Math.round(elapsed / j.progress - elapsed));
}

/** Seconds a job has been running (running), waiting (queued etc.), or took (finished). */
function spanSeconds(j: Job, now: number): number | null {
  const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN);
  let a: number, b: number;
  if (j.status === "running") { a = ms(j.started_at); b = now; }
  else if (ACTIVE.has(j.status)) { a = ms(j.created_at); b = now; }
  else { a = ms(j.started_at); b = ms(j.finished_at); }
  const s = (b - a) / 1000;
  return Number.isFinite(s) && s >= 0 ? s : null;
}

const jobCost = (j: Job) => j.cost_actual || j.cost_estimate || 0;
/** A shot's video that a provider's safety filter refused (the error text the worker writes). */
const isSafetyBlock = (j: Job) => j.status === "failed" && j.type === "video" && !!j.shot_id && (j.error || "").startsWith("Blocked by safety filter");

interface Group { key: string; jobs: Job[]; newest: number; state: "active" | "failed" | "done" }

function groupJobs(rows: Job[]): Group[] {
  const map = new Map<string, Job[]>();
  for (const j of rows) {
    const k = j.batch_id || `job-${j.id}`;
    map.set(k, [...(map.get(k) ?? []), j]);
  }
  const out: Group[] = [];
  for (const [key, jobs] of map) {
    const state = jobs.some((j) => ACTIVE.has(j.status)) ? "active" : jobs.some((j) => j.status === "failed") ? "failed" : "done";
    out.push({ key, jobs, state, newest: Math.max(...jobs.map((j) => new Date(j.created_at).getTime() || 0)) });
  }
  const rank = { active: 0, failed: 1, done: 2 } as const;
  return out.sort((a, b) => rank[a.state] - rank[b.state] || b.newest - a.newest);
}

type Filter = "all" | "running" | "queued" | "waiting" | "failed" | "done";
const matches = (f: Filter, j: Job) =>
  f === "all" || (f === "running" && j.status === "running") || (f === "queued" && j.status === "queued")
  || (f === "waiting" && (j.status === "awaiting_approval" || j.status === "proposed")) || (f === "failed" && j.status === "failed")
  || (f === "done" && j.status === "succeeded");

type Act = (j: Job, what: "cancel" | "retry" | "confirm") => void;

/** A thin progress bar. A running job carries a sweeping light. */
function Bar({ value, tone, running, indeterminate, className }: {
  value: number; tone?: "ok" | "bad" | "warn" | "info"; running?: boolean; indeterminate?: boolean; className?: string;
}) {
  const pct = Math.max(2, Math.min(100, value * 100));
  return (
    <span role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : Math.round(pct)} className={clsx("jq-track block min-w-0", className)}>
      <span className="jq-fill" data-tone={tone} style={{ width: `${pct}%` }}>{running && <span aria-hidden className="sweep block h-full" />}</span>
    </span>
  );
}

export default function JobTray({ projectId }: { projectId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const open = useUI((s) => s.trayOpen);
  const setOpen = useUI((s) => s.setTrayOpen);
  const { data: active } = useJobs(projectId, "active");
  const { data: recent } = useJobs(projectId, "");
  const { data: auth } = useAuthStatus();
  const role = auth?.user?.role ?? "viewer";
  const canAct = ROLE_RANK[role] >= ROLE_RANK.creator; // cancel / retry need a creator
  const canApprove = ROLE_RANK[role] >= ROLE_RANK.producer;
  const root = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const running = useMemo(() => (active ?? []).filter((j) => j.status === "running"), [active]);
  const queued = useMemo(() => (active ?? []).filter((j) => j.status === "queued"), [active]);
  const waiting = useMemo(() => (active ?? []).filter((j) => j.status === "awaiting_approval" || j.status === "proposed"), [active]);
  const failed = useMemo(() => (recent ?? []).filter((j) => j.status === "failed").slice(0, 5), [recent]);
  const done = useMemo(() => (recent ?? []).filter((j) => j.status === "succeeded").slice(0, 8), [recent]);
  const busy = running.length + queued.length;
  const now = useNow(running.length > 0);
  // what the running, queued and waiting jobs are expected to cost
  const inFlight = useMemo(() => (active ?? []).reduce((a, j) => a + jobCost(j), 0), [active]);
  // the open state lives in the UI store (so the Director or a toast action can open it); don't carry it between projects
  useEffect(() => () => setOpen(false), [setOpen]);

  const act: Act = async (j, what) => {
    setPending(j.id);
    try {
      // a proposal (from the Director or an MCP app) starts as a whole batch, after the budget check
      await api.post(what === "confirm" ? `/api/batches/${j.batch_id}/confirm` : `/api/jobs/${j.id}/${what}`);
      qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch { /* api() showed the error */ } finally { setPending(null); }
  };

  const rows = useMemo(() => [...running, ...queued, ...waiting, ...failed, ...done], [running, queued, waiting, failed, done]);
  // a chip with nothing left in it falls back to "All" (the last running job finished, say)
  const view: Filter = filter !== "all" && !rows.some((j) => matches(filter, j)) ? "all" : filter;
  const shown = useMemo(() => rows.filter((j) => matches(view, j)), [rows, view]);
  const groups = useMemo(() => groupJobs(shown), [shown]);

  // Esc / click outside close the panel (Esc must not also close the shot drawer behind it)
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("[role=dialog]")) return; // a dialog / menu on top handles its own Esc
      e.stopPropagation();
      setOpen(false);
    };
    const down = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", key, true);
    window.addEventListener("mousedown", down);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("mousedown", down); };
  }, [open, setOpen]);

  const head = running[0];
  const overall = busy ? (running.reduce((a, j) => a + j.progress, 0) / busy) : 0;
  const eta = head ? etaSeconds(head, now) : null;
  // the bar takes a row of the page, so it only shows while there is something to follow: work in flight, work waiting for
  // approval, a failure from the last few minutes, or the panel opened from elsewhere (the status bar, the Overview)
  const lastFail = useMemo(() => Math.max(0, ...failed.map((j) => new Date(j.finished_at || j.created_at).getTime() || 0)), [failed]);
  const [, wake] = useState(0);
  useEffect(() => {
    const left = lastFail + FRESH_FAIL_MS - Date.now();
    if (left <= 0) return;
    const id = window.setTimeout(() => wake((n) => n + 1), left + 50); // re-render once the failure is no longer fresh
    return () => window.clearTimeout(id);
  }, [lastFail]);
  const freshFail = lastFail + FRESH_FAIL_MS > Date.now();
  if (!open && !busy && !waiting.length && !freshFail) return null;

  const chips: { id: Filter; label: string; n: number; tone?: string }[] = [
    { id: "all", label: t("All"), n: rows.length },
    { id: "running", label: t("Running"), n: running.length },
    { id: "queued", label: t("Queued"), n: queued.length, tone: "info" },
    { id: "waiting", label: t("Waiting"), n: waiting.length, tone: "warn" },
    { id: "failed", label: t("Failed"), n: failed.length, tone: "bad" },
    { id: "done", label: t("Done"), n: done.length, tone: "ok" },
  ];

  return (
    <div ref={root} className="@container relative z-[45] border-t border-line bg-panel">
      <AnimatePresence>
        {open && (
          <motion.section
            key="panel" role="region" aria-label={t("Jobs")} id="job-tray-panel"
            initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12, transition: { duration: 0.14 } }}
            transition={{ type: "spring", stiffness: 420, damping: 36, mass: 0.8 }}
            className="absolute bottom-full left-2 right-2 flex max-h-[min(66vh,520px)] flex-col overflow-hidden rounded-t-xl border border-b-0 border-line bg-panel shadow-pop sm:left-3 sm:right-auto sm:w-[min(calc(100%-1.5rem),1120px)]"
          >
            <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px" />
            <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2.5">
              <h2 className="mono flex items-center gap-2 text-2xs font-medium uppercase tracking-[0.16em] text-accent-ink">
                <span className={clsx("eq", !busy && "is-idle")} aria-hidden><i /><i /><i /><i /></span>{t("Jobs")}
              </h2>
              <div role="group" aria-label={t("Jobs")} className="no-scrollbar flex min-w-0 flex-1 flex-wrap items-center gap-1.5 max-sm:order-last max-sm:basis-full max-sm:flex-nowrap max-sm:overflow-x-auto">
                {chips.filter((c) => c.id === "all" || c.n > 0).map((c) => (
                  <button key={c.id} type="button" className="cx-chip" data-tone={c.tone} aria-pressed={view === c.id} onClick={() => setFilter(c.id)}>
                    {c.label}<span className="cx-n">{c.n}</span>
                  </button>
                ))}
              </div>
              {inFlight > 0 && (
                <span className="mono flex items-center gap-1.5 text-2xs text-dim">
                  <span className="uppercase tracking-[0.12em]">{t("In flight")}</span><span className="text-sm font-medium text-money">{usd(inFlight)}</span>
                </span>
              )}
              <IconButton title={t("Close")} onClick={() => setOpen(false)} className="-mr-1 !size-7"><X className="size-4" /></IconButton>
            </header>

            <div className="cx-scroll @container min-h-0 flex-1">
              {!groups.length ? (
                <div className="grid place-items-center gap-1 px-4 py-9 text-center">
                  <span className="grid size-9 place-items-center rounded-lg bg-ok/12 text-ok"><AnimatedCheck className="size-5" /></span>
                  <p className="text-sm font-medium">{t("Nothing yet.")}</p>
                  <p className="max-w-xs text-xs text-mute">{t("Generations and renders show up here while they run, with their cost.")}</p>
                </div>
              ) : (
                <table className="cx-table is-dense">
                  <thead>
                    <tr>
                      <th className="cx-stick">{t("Status")}</th>
                      <th className="max-sm:hidden">{t("ID")}</th>
                      <th>{t("Job")}</th>
                      <th>{t("Progress")}</th>
                      <th className="cx-r max-sm:hidden">{t("Time")}</th>
                      <th className="cx-r">{t("Cost")}</th>
                      <th className="hidden @min-[1040px]:table-cell">{t("By")}</th>
                      <th className="cx-fit"><span className="sr-only">{t("Actions")}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => (
                      <GroupRows key={g.key} group={g} now={now} pending={pending} onAct={act} canAct={canAct} canApprove={canApprove} />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="job-tray-panel"
        className="relative flex h-10 w-full items-center gap-3 px-3 text-left text-xs transition-colors hover:bg-hover/50 sm:px-4">
        <span aria-hidden className="jq-line" style={{ width: busy ? `${Math.max(overall, 0.03) * 100}%` : 0, opacity: busy ? 1 : 0 }} />
        <span className={clsx("eq shrink-0", !busy && "is-idle")} aria-hidden><i /><i /><i /><i /></span>
        <span className="mono flex min-w-0 items-center gap-1.5 text-xs font-medium" aria-live="polite">
          <span className="truncate">{busy ? t("{running} running · {queued} queued", { running: running.length, queued: queued.length }) : t("No jobs running")}</span>
          {busy > 0 && <span className="shrink-0 rounded-md bg-accent/15 px-1.5 text-2xs font-semibold tabular-nums leading-4 text-accent-ink">{busy}</span>}
        </span>
        {head ? (
          <motion.span key={`head-${head.id}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}
            className="hidden min-w-0 flex-1 items-center gap-2.5 text-mute @min-[520px]:flex">
            <span className="min-w-0 truncate">{head.label}<span className="text-dim"> — {head.message || head.status}</span></span>
            <Bar value={head.progress} running className="ml-auto w-28 shrink-0" />
            <span className="mono w-9 shrink-0 text-right tabular-nums">{Math.round(head.progress * 100)}%</span>
            {eta != null && <span className="mono hidden shrink-0 tabular-nums text-dim @min-[760px]:inline">{t("~{time} left", { time: secs(eta) })}</span>}
          </motion.span>
        ) : null}
        <span aria-hidden className={clsx("min-w-0 flex-1", head && "@min-[520px]:hidden")} />
        {!!waiting.length && <span title={t("{n} waiting for approval", { n: waiting.length })} className="mono inline-flex shrink-0 items-center gap-1 text-warn"><ShieldAlert className="size-3.5" /><span className="hidden @min-[900px]:inline">{t("{n} waiting for approval", { n: waiting.length })}</span><span className="@min-[900px]:hidden">{waiting.length}</span></span>}
        {!!failed.length && <span title={t("{n} failed", { n: failed.length })} className="mono inline-flex shrink-0 items-center gap-1 text-bad"><XCircle className="size-3.5" /><span className="hidden @min-[900px]:inline">{t("{n} failed", { n: failed.length })}</span><span className="@min-[900px]:hidden">{failed.length}</span></span>}
        {inFlight > 0 && <span className="mono hidden shrink-0 text-money @min-[400px]:inline" title={t("In flight")}>{usd(inFlight)}</span>}
        <ChevronUp className={clsx("size-4 shrink-0 text-mute transition-transform duration-200", open && "rotate-180")} />
      </button>
    </div>
  );
}

/** A check that draws itself (CSS keyframes in index.css). */
function AnimatedCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" strokeDasharray="24" style={{ animation: "check-draw 0.45s 0.08s ease-out both" }} />
    </svg>
  );
}

/** One batch of jobs: a summary row you can fold, then its jobs. A single job is just its row. */
function GroupRows({ group, now, pending, onAct, canAct, canApprove }: {
  group: Group; now: number; pending: number | null; onAct: Act; canAct: boolean; canApprove: boolean;
}) {
  const t = useT();
  const { jobs } = group;
  const [open, setOpen] = useState(jobs.length === 1 || group.state !== "done");
  if (jobs.length === 1) return <JobRow j={jobs[0]} now={now} pending={pending} onAct={onAct} canAct={canAct} canApprove={canApprove} />;

  const types = Array.from(new Set(jobs.map((j) => j.type)));
  const typeName = (ty: string) => t(TYPE_LABEL[ty] ?? ty.replaceAll("_", " "));
  const what = types.length <= 2 ? types.map(typeName).join(" + ") : `${types.slice(0, 2).map(typeName).join(" + ")} +${types.length - 2}`;
  const finished = jobs.filter((j) => j.status === "succeeded").length;
  const bad = jobs.filter((j) => j.status === "failed").length;
  const runN = jobs.filter((j) => j.status === "running").length;
  const frac = jobs.reduce((a, j) => a + (j.status === "succeeded" ? 1 : j.status === "running" ? j.progress : 0), 0) / jobs.length;
  const cost = jobs.reduce((a, j) => a + jobCost(j), 0);
  const tone: Tone = bad ? "bad" : group.state === "active" ? "accent" : "ok";
  return (
    <Fragment>
      <tr className="bg-raised/40">
        <td colSpan={8} className="!p-0">
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
            className="flex min-h-9 w-full items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-hover/50">
            <ChevronDown className={clsx("size-3.5 shrink-0 text-dim transition-transform duration-200", !open && "-rotate-90")} />
            <span className="min-w-0 truncate text-sm font-medium">{what}</span>
            <span className="mono shrink-0 rounded-md bg-raised px-1.5 text-2xs font-semibold tabular-nums leading-4 text-mute">{jobs.length}</span>
            {bad > 0 && <span className="mono shrink-0 text-2xs font-medium text-bad">{t("{n} failed", { n: bad })}</span>}
            {runN > 0 && <span className="mono shrink-0 text-2xs font-medium text-accent-ink">{t("{n} running", { n: runN })}</span>}
            <Bar value={frac} running={runN > 0} tone={bad ? "bad" : finished === jobs.length ? "ok" : undefined} className="w-28 shrink-0 max-sm:hidden" />
            <span className={clsx("mono shrink-0 text-2xs tabular-nums", TEXT[tone])}>{finished}/{jobs.length}</span>
            <span className="flex-1" />
            <span className="mono shrink-0 text-xs tabular-nums text-money">{usd(cost)}</span>
            <span className="mono hidden w-16 shrink-0 text-right text-2xs text-dim sm:block">{ago(new Date(group.newest).toISOString())}</span>
          </button>
        </td>
      </tr>
      {open && jobs.map((j) => <JobRow key={j.id} j={j} now={now} pending={pending} onAct={onAct} canAct={canAct} canApprove={canApprove} nested />)}
    </Fragment>
  );
}

function JobRow({ j, now, pending, onAct, canAct, canApprove, nested }: {
  j: Job; now: number; pending: number | null; onAct: Act; canAct: boolean; canApprove: boolean; nested?: boolean;
}) {
  const t = useT();
  const status = useStatusLabel();
  const tone = STATUS_TONE[j.status] ?? "neutral";
  const isActive = ACTIVE.has(j.status);
  const eta = etaSeconds(j, now);
  const failed = j.status === "failed";
  const cost = jobCost(j);
  const span = spanSeconds(j, now);
  return (
    <tr className={clsx(failed && "[&>td]:bg-[color-mix(in_oklab,var(--color-bad)_6%,var(--color-panel))]")}>
      <td className={clsx("cx-stick whitespace-nowrap", nested && "pl-7")}>
        <span className={clsx("inline-flex items-center gap-2 text-xs font-medium", TEXT[tone])}>
          {j.status === "succeeded" ? <AnimatedCheck className="size-3.5" />
            : j.status === "cancelled" ? <Ban className="size-3.5" />
            : <StatusDot tone={tone} live={j.status === "running"} />}
          {status(j.status)}
        </span>
      </td>
      <td className="cx-mono max-sm:hidden">#{j.id}</td>
      <td className="max-w-[24rem]">
        <p className="truncate text-sm font-medium" title={j.label}>{j.label}</p>
        {failed ? (
          <p className="line-clamp-2 break-words text-2xs leading-snug text-bad" title={j.error}>{j.error || t("The job failed.")}</p>
        ) : j.message ? (
          <p className="truncate text-2xs text-dim" title={j.message}>{j.message}</p>
        ) : null}
      </td>
      <td className="min-w-[8.5rem]">
        {j.status === "running" ? (
          <span className="flex items-center gap-2"><Bar value={j.progress} running className="w-24 shrink-0" /><span className="mono text-2xs tabular-nums text-mute">{Math.round(j.progress * 100)}%</span></span>
        ) : j.status === "queued" && j.progress === 0 ? (
          <Bar value={0.35} tone="info" indeterminate className="w-24 opacity-60" />
        ) : j.status === "succeeded" ? (
          <span className="flex items-center gap-2"><Bar value={1} tone="ok" className="w-24 shrink-0" /><span className="mono text-2xs text-ok">100%</span></span>
        ) : <span className="mono text-2xs text-dim">{j.progress > 0 ? `${Math.round(j.progress * 100)}%` : "—"}</span>}
      </td>
      <td className="cx-r max-sm:hidden">
        {span != null ? <span className="text-xs text-mute">{secs(span)}</span> : <span className="text-dim">—</span>}
        {eta != null && <p className="text-2xs text-dim">{t("~{time} left", { time: secs(eta) })}</p>}
      </td>
      <td className={clsx("cx-r", cost ? "text-money" : "text-dim")}>{usd(cost || null)}</td>
      <td className="mono hidden whitespace-nowrap text-2xs text-dim @min-[1040px]:table-cell">{j.requested_by_user?.name?.split(" ")[0]} · {ago(j.created_at)}</td>
      <td className="cx-fit">
        <span className="flex items-center justify-end gap-1">
          {failed && canAct && (
            <Button size="sm" variant="outline" loading={pending === j.id} icon={<RotateCcw className="size-3.5" />} onClick={() => onAct(j, "retry")}>{t("Retry")}</Button>
          )}
          {j.status === "proposed" && canAct && (
            <Tooltip content={t("Start this proposal (its estimate is in the cost column)")}>
              <Button size="sm" variant="outline" loading={pending === j.id} icon={<Play className="size-3.5" />} onClick={() => onAct(j, "confirm")}>{t("Start")}</Button>
            </Tooltip>
          )}
          {canAct && isSafetyBlock(j) && <RecoverButton j={j} />}
          {j.status === "awaiting_approval" && canApprove && (
            <Link to="/approvals" className="cx-chip" data-tone="warn"><ShieldAlert />{t("Approvals")}</Link>
          )}
          {isActive && canAct && (
            <Tooltip content={t("Cancel")}>
              <button type="button" aria-label={t("Cancel")} disabled={pending === j.id} onClick={() => onAct(j, "cancel")}
                className="grid size-7 place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-ink disabled:opacity-50 max-sm:size-9">
                {pending === j.id ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-4" />}
              </button>
            </Tooltip>
          )}
        </span>
      </td>
    </tr>
  );
}

/** "Another engine": retry a shot's blocked video on the best other engine, with its price on the button before it is spent. */
function RecoverButton({ j }: { j: Job }) {
  const t = useT();
  const qc = useQueryClient();
  const { submit } = useGenerate();
  const [busy, setBusy] = useState(false);
  const sid = j.shot_id as number;
  const { data } = useShotAlternatives(sid, "recover");
  const o = data?.options[0];
  // only while this job is still what blocks the shot (not once it was retried or replaced)
  if (!o || data?.blocked?.job_id !== j.id) return null;
  const price = usd(o.est_usd);
  const go = async () => {
    setBusy(true);
    try {
      const r = await submit(() => api.post<SubmitResult>(`/api/shots/${sid}/recover`, { engine: o.id }), tr("Retry on {engine}", { engine: o.display_name }));
      if (!r) return;
      qc.invalidateQueries({ queryKey: ["shot-alternatives", sid] });
      qc.invalidateQueries({ queryKey: ["shot", sid] });
      qc.invalidateQueries({ queryKey: ["episode"] });
    } finally { setBusy(false); }
  };
  return (
    <Tooltip content={o.uses_registered ? t("Retry on {engine} · {price}. It keeps the characters' look.", { engine: o.display_name, price })
      : t("Retry on {engine} · {price}", { engine: o.display_name, price })}>
      <Button size="sm" variant="outline" loading={busy} icon={<ArrowLeftRight className="size-3.5" />} onClick={() => void go()}>
        {t("Another engine")}<span className="mono text-money">{price}</span>
      </Button>
    </Tooltip>
  );
}
