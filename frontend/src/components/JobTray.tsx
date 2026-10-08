import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Ban, ChevronDown, ChevronUp, Clock, Lightbulb, Loader2, RotateCcw, ShieldAlert, X, XCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { ago, secs, usd } from "../lib/format";
import { useT } from "../lib/i18n";
import { useAuthStatus, useJobs } from "../lib/queries";
import { useUI } from "../lib/store";
import { ROLE_RANK, type Job } from "../lib/types";
import { Button, IconButton, Progress, ProgressRing, Tooltip } from "./ui";

const TYPE_LABEL: Record<string, string> = {
  keyframe: "Keyframes", video: "Videos", lipsync: "Lip-sync", voice: "Voices", qc: "Quality checks", sfx: "Sound design", music: "Music",
  export: "Renders", marketing: "Marketing pack", train_identity: "Identity training", character_sheet: "Character sheets", dub: "Dubbing",
  table_read: "Table read", search_index: "Search index", animatic: "Animatic", extend: "Extensions", edit: "Edits", shootout: "Shootout",
  voicelock: "Voice lock", narration: "Narration", location_plate: "Location plates", thumbnail: "Thumbnails",
};

const ACTIVE = new Set(["running", "queued", "awaiting_approval", "proposed"]);

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

export default function JobTray({ projectId }: { projectId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const open = useUI((s) => s.trayOpen);
  const setOpen = useUI((s) => s.setTrayOpen);
  const { data: active } = useJobs(projectId, "active");
  const { data: recent } = useJobs(projectId, "");
  const root = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<number | null>(null);

  const running = useMemo(() => (active ?? []).filter((j) => j.status === "running"), [active]);
  const queued = useMemo(() => (active ?? []).filter((j) => j.status === "queued"), [active]);
  const waiting = useMemo(() => (active ?? []).filter((j) => j.status === "awaiting_approval" || j.status === "proposed"), [active]);
  const failed = useMemo(() => (recent ?? []).filter((j) => j.status === "failed").slice(0, 5), [recent]);
  const done = useMemo(() => (recent ?? []).filter((j) => j.status === "succeeded").slice(0, 8), [recent]);
  const busy = running.length + queued.length;
  const now = useNow(running.length > 0);
  // the open state lives in the UI store (so the Director or a toast action can open it); don't carry it between projects
  useEffect(() => () => setOpen(false), [setOpen]);

  const act = async (j: Job, what: "cancel" | "retry") => {
    setPending(j.id);
    try {
      await api.post(`/api/jobs/${j.id}/${what}`);
      qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch { /* api() showed the error */ } finally { setPending(null); }
  };

  const rows = useMemo(() => [...running, ...queued, ...waiting, ...failed, ...done], [running, queued, waiting, failed, done]);
  const groups = useMemo(() => groupJobs(rows), [rows]);

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

  return (
    <div ref={root} className="relative z-[45] border-t border-line bg-panel">
      <AnimatePresence>
        {open && (
          <motion.section
            key="panel" role="region" aria-label={t("Jobs")} id="job-tray-panel"
            initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12, transition: { duration: 0.14 } }}
            transition={{ type: "spring", stiffness: 420, damping: 36, mass: 0.8 }}
            className="absolute bottom-full left-2 right-2 flex max-h-[min(62vh,460px)] flex-col overflow-hidden rounded-t-xl border border-b-0 border-line bg-panel shadow-pop sm:left-3 sm:right-auto sm:w-[min(calc(100%-1.5rem),780px)]"
          >
            <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
              <h2 className="text-sm font-semibold tracking-tight">{t("Jobs")}</h2>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-mute">
                {running.length > 0 && <Count tone="bg-accent" label={t("{n} running", { n: running.length })} />}
                {queued.length > 0 && <Count tone="bg-info" label={t("{n} queued", { n: queued.length })} />}
                {waiting.length > 0 && <Count tone="bg-warn" label={t("{n} waiting for approval", { n: waiting.length })} />}
                {failed.length > 0 && <Count tone="bg-bad" label={t("{n} failed", { n: failed.length })} />}
                {done.length > 0 && <Count tone="bg-ok" label={t("{n} done", { n: done.length })} />}
              </div>
              <IconButton title={t("Close")} onClick={() => setOpen(false)} className="-mr-1.5 !size-7"><X className="size-4" /></IconButton>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
              {!groups.length && (
                <div className="grid place-items-center gap-1 py-8 text-center">
                  <span className="grid size-9 place-items-center rounded-full bg-ok/12 text-ok"><AnimatedCheck className="size-5" /></span>
                  <p className="text-sm font-medium">{t("Nothing yet.")}</p>
                  <p className="max-w-xs text-xs text-mute">{t("Generations and renders show up here while they run, with their cost.")}</p>
                </div>
              )}
              <ul className="space-y-1.5">
                <AnimatePresence initial={false}>
                  {groups.map((g, i) => (
                    <motion.li key={g.key} layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 8 }}
                      transition={{ duration: 0.18, delay: Math.min(i, 6) * 0.02 }}>
                      <GroupView group={g} now={now} pending={pending} onAct={act} />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="job-tray-panel"
        className="flex h-10 w-full items-center gap-3 px-4 text-left text-xs transition-colors hover:bg-hover/50">
        {busy ? (
          <ProgressRing value={Math.max(overall, 0.04)} size={22} stroke={3} />
        ) : failed.length ? (
          <XCircle className="size-[18px] text-bad" />
        ) : (
          <span className="grid size-[18px] place-items-center rounded-full bg-ok/15 text-ok"><AnimatedCheck className="size-3" /></span>
        )}
        <span className="flex items-center gap-1.5 font-medium" aria-live="polite">
          {busy ? t("{running} running · {queued} queued", { running: running.length, queued: queued.length }) : t("No jobs running")}
          {busy > 0 && <span className="rounded-full bg-accent/15 px-1.5 text-2xs font-semibold tabular-nums leading-4 text-accent-ink">{busy}</span>}
        </span>
        {head ? (
          <motion.span key={`head-${head.id}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}
            className="hidden min-w-0 flex-1 items-center gap-2 text-mute sm:flex">
            <span className="min-w-0 truncate">{head.label} — {head.message || head.status}</span>
            <span className="ml-auto w-24 shrink-0"><Progress value={head.progress} /></span>
            <span className="w-9 shrink-0 text-right tabular-nums">{Math.round(head.progress * 100)}%</span>
            {eta != null && <span className="hidden shrink-0 tabular-nums text-dim lg:inline">{t("~{time} left", { time: secs(eta) })}</span>}
          </motion.span>
        ) : <span className="flex-1" />}
        {!!waiting.length && <span title={t("{n} waiting for approval", { n: waiting.length })} className="inline-flex shrink-0 items-center gap-1 text-warn"><ShieldAlert className="size-3.5" /><span className="hidden xl:inline">{t("{n} waiting for approval", { n: waiting.length })}</span><span className="xl:hidden">{waiting.length}</span></span>}
        {!!failed.length && <span title={t("{n} failed", { n: failed.length })} className="inline-flex shrink-0 items-center gap-1 text-bad"><XCircle className="size-3.5" /><span className="hidden xl:inline">{t("{n} failed", { n: failed.length })}</span><span className="xl:hidden">{failed.length}</span></span>}
        <ChevronUp className={clsx("size-4 shrink-0 text-mute transition-transform duration-200", open && "rotate-180")} />
      </button>
    </div>
  );
}

function Count({ tone, label }: { tone: string; label: string }) {
  return <span className="inline-flex items-center gap-1.5"><span className={clsx("size-1.5 rounded-full", tone)} />{label}</span>;
}

/** A check that draws itself (CSS keyframes in index.css). */
function AnimatedCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" strokeDasharray="24" style={{ animation: "check-draw 0.45s 0.08s ease-out both" }} />
    </svg>
  );
}

function StatusIcon({ status }: { status: string }) {
  const base = "grid size-6 shrink-0 place-items-center rounded-full";
  if (status === "running") return <span className={clsx(base, "bg-accent/12 text-accent-ink")}><Loader2 className="size-3.5 animate-spin" /></span>;
  if (status === "queued") return <span className={clsx(base, "bg-info/12 text-info")}><Clock className="size-3.5" /></span>;
  if (status === "awaiting_approval") return <span className={clsx(base, "bg-warn/12 text-warn")}><ShieldAlert className="size-3.5" /></span>;
  if (status === "proposed") return <span className={clsx(base, "bg-accent-2/12 text-accent-2")}><Lightbulb className="size-3.5" /></span>;
  if (status === "succeeded") return <span className={clsx(base, "bg-ok/12 text-ok")}><AnimatedCheck className="size-3.5" /></span>;
  if (status === "failed") return <span className={clsx(base, "bg-bad/12 text-bad")}><XCircle className="size-3.5" /></span>;
  return <span className={clsx(base, "bg-raised text-dim")}><Ban className="size-3.5" /></span>;
}

function GroupView({ group, now, pending, onAct }: { group: Group; now: number; pending: number | null; onAct: (j: Job, what: "cancel" | "retry") => void }) {
  const t = useT();
  const { jobs } = group;
  const [open, setOpen] = useState(jobs.length === 1 || group.state !== "done");
  if (jobs.length === 1) return <JobRow j={jobs[0]} now={now} pending={pending} onAct={onAct} />;

  const types = Array.from(new Set(jobs.map((j) => j.type)));
  const typeName = (ty: string) => t(TYPE_LABEL[ty] ?? ty.replaceAll("_", " "));
  const what = types.length <= 2 ? types.map(typeName).join(" + ") : `${types.slice(0, 2).map(typeName).join(" + ")} +${types.length - 2}`;
  const finished = jobs.filter((j) => j.status === "succeeded").length;
  const bad = jobs.filter((j) => j.status === "failed").length;
  const runN = jobs.filter((j) => j.status === "running").length;
  const frac = jobs.reduce((a, j) => a + (j.status === "succeeded" ? 1 : j.status === "running" ? j.progress : 0), 0) / jobs.length;
  const cost = jobs.reduce((a, j) => a + (j.cost_actual || j.cost_estimate || 0), 0);
  return (
    <div className={clsx("rounded-xl border", group.state === "failed" ? "border-bad/25" : "border-line")}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-hover/50">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{what}</span>
            <span className="rounded-full bg-raised px-1.5 text-2xs font-semibold tabular-nums leading-4 text-mute">{jobs.length}</span>
            {bad > 0 && <span className="text-2xs font-medium text-bad">{t("{n} failed", { n: bad })}</span>}
            {runN > 0 && <span className="text-2xs font-medium text-accent-ink">{t("{n} running", { n: runN })}</span>}
          </span>
          <span className="mt-1 flex items-center gap-2">
            <Progress value={frac} size="sm" tone={bad ? "bad" : finished === jobs.length ? "ok" : "accent"} className="max-w-[220px]" />
            <span className="text-2xs tabular-nums text-mute">{finished}/{jobs.length}</span>
          </span>
        </span>
        <span className="hidden shrink-0 text-right text-2xs tabular-nums text-mute sm:block">{usd(cost)}</span>
        <span className="hidden w-14 shrink-0 text-right text-2xs text-dim sm:block">{ago(new Date(group.newest).toISOString())}</span>
        <ChevronDown className={clsx("size-4 shrink-0 text-dim transition-transform duration-200", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="rows" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
            <div className="space-y-px border-t border-line/70 px-1 py-1">
              {jobs.map((j) => <JobRow key={j.id} j={j} now={now} pending={pending} onAct={onAct} nested />)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function JobRow({ j, now, pending, onAct, nested }: { j: Job; now: number; pending: number | null; onAct: (j: Job, what: "cancel" | "retry") => void; nested?: boolean }) {
  const t = useT();
  const status = useStatusLabel();
  const isActive = j.status === "running" || j.status === "queued" || j.status === "awaiting_approval" || j.status === "proposed";
  const eta = etaSeconds(j, now);
  const failed = j.status === "failed";
  const cost = j.cost_actual || j.cost_estimate;
  const { data: auth } = useAuthStatus();
  const canAct = ROLE_RANK[auth?.user?.role ?? "viewer"] >= ROLE_RANK.creator;  // cancel / retry need a creator
  return (
    <div className={clsx("flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-xs", failed ? "border border-bad/25 bg-bad/6" : nested ? "hover:bg-hover/40" : "border border-line hover:bg-hover/40")}>
      <StatusIcon status={j.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{j.label}</span>
          <span className={clsx("shrink-0 text-2xs font-medium", failed ? "text-bad" : j.status === "succeeded" ? "text-ok" : j.status === "running" ? "text-accent-ink" : j.status === "awaiting_approval" ? "text-warn" : "text-mute")}>{status(j.status)}</span>
        </div>
        {failed ? (
          <div className="mt-0.5 space-y-1.5">
            <p className="line-clamp-2 break-words text-red-300" title={j.error}>{j.error || t("The job failed.")}</p>
            {canAct && <Button size="sm" variant="outline" loading={pending === j.id} icon={<RotateCcw className="size-3.5" />} onClick={() => onAct(j, "retry")}>{t("Retry")}</Button>}
          </div>
        ) : j.message ? (
          <p className="mt-0.5 truncate text-mute" title={j.message}>{j.message}</p>
        ) : null}
        {j.status === "running" && (
          <div className="mt-1.5 flex items-center gap-2">
            <Progress value={j.progress} className="max-w-[260px]" />
            <span className="whitespace-nowrap tabular-nums text-mute">{Math.round(j.progress * 100)}%</span>
            {eta != null && <span className="whitespace-nowrap tabular-nums text-dim">{t("~{time} left", { time: secs(eta) })}</span>}
          </div>
        )}
        {j.status === "queued" && j.progress === 0 && <Progress indeterminate size="sm" className="mt-1.5 max-w-[160px] opacity-60" />}
      </div>
      <div className="hidden shrink-0 text-right sm:block">
        <p className={clsx("tabular-nums", cost ? "text-ink" : "text-dim")}>{usd(cost)}</p>
        <p className="text-2xs text-dim">{j.requested_by_user?.name?.split(" ")[0]} · {ago(j.created_at)}</p>
      </div>
      <div className="flex w-7 shrink-0 justify-end">
        {isActive && canAct && (
          <Tooltip content={t("Cancel")}>
            <button type="button" aria-label={t("Cancel")} disabled={pending === j.id} onClick={() => onAct(j, "cancel")}
              className="grid size-7 place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-ink disabled:opacity-50">
              {pending === j.id ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-4" />}
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
