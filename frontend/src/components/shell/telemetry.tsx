import { clsx } from "clsx";
import { Bell, Cpu, Wallet } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ago, usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useJobs, useNotifications, useSettings } from "../../lib/queries";
import { useUI } from "../../lib/store";
import { Popover, Progress, ProgressRing, Tooltip } from "../ui";

const RUNNING = new Set(["running"]);
const WAITING = new Set(["queued", "awaiting_approval", "proposed"]);

/** Counts of work in flight across every project. Refetches every 15 s, and live events invalidate it. */
export function useWorkload() {
  const { data } = useJobs(undefined, "active");
  return useMemo(() => {
    const jobs = data ?? [];
    const running = jobs.filter((j) => RUNNING.has(j.status));
    const waiting = jobs.filter((j) => WAITING.has(j.status));
    const progress = running.length ? running.reduce((a, j) => a + (j.progress || 0), 0) / running.length : 0;
    return { jobs, running, waiting, progress };
  }, [data]);
}

const chip = "flex h-8 items-center gap-2 rounded-lg border border-line bg-raised/60 px-2.5 text-xs outline-none transition-colors hover:border-accent/40 hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50";

/** Equalizer bars + counts. Opens a list of what is running right now. */
export function JobsPill() {
  const t = useT();
  const nav = useNavigate();
  const { jobs, running, waiting } = useWorkload();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const busy = running.length > 0;
  return (
    <>
      <Tooltip content={busy ? t("{n} jobs running", { n: running.length }) : t("No jobs running")} side="bottom" disabled={open}>
        <button ref={ref} aria-label={t("Jobs")} aria-expanded={open} onClick={() => setOpen((v) => !v)} className={clsx(chip, open && "border-accent/50 bg-hover")}>
          <span className={clsx("eq", !busy && "is-idle")} aria-hidden><i /><i /><i /><i /></span>
          <span className="mono hidden text-mute lg:inline">
            {busy ? <><b className="font-medium text-ink">{running.length}</b> {t("running")}</> : t("idle")}
            {waiting.length > 0 && <span className="text-dim"> · {waiting.length} {t("queued")}</span>}
          </span>
        </button>
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="bottom-end" width={340} className="p-2">
        <p className="eyebrow px-2 pb-2 pt-1">{t("Live queue")}</p>
        {!jobs.length && <p className="px-2 pb-3 text-sm text-dim">{t("Nothing is running. Generations you start appear here.")}</p>}
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {jobs.slice(0, 12).map((j) => (
            <button key={j.id} onClick={() => { setOpen(false); if (j.project_id) nav(`/p/${j.project_id}/activity`); }}
              className="block w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover">
              <span className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">{j.label || j.type}</span>
                <span className="mono shrink-0 text-2xs text-dim">{RUNNING.has(j.status) ? `${Math.round((j.progress || 0) * 100)}%` : t(j.status.replace(/_/g, " "))}</span>
              </span>
              {RUNNING.has(j.status) && <Progress value={j.progress} size="sm" className="mt-1.5" />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

/** Team spend against the monthly cap, as a ring. Amber past 80 %, red at the cap. */
export function SpendPill() {
  const t = useT();
  const { data } = useSettings();
  const team = data?.team;
  if (!team) return null;
  const pct = team.cap_usd > 0 ? Math.min(team.spent_usd / team.cap_usd, 1) : 0;
  const tone = pct >= 1 ? "var(--color-bad)" : pct >= 0.8 ? "var(--color-warn)" : "var(--color-money)";
  return (
    <Tooltip content={t("Team spend this month: {a} of {b}", { a: usd(team.spent_usd), b: usd(team.cap_usd, 0) })} side="bottom">
      <Link to="/costs" aria-label={t("Costs")} className={chip}>
        <ProgressRing value={pct} size={18} stroke={2.5} tone={tone} />
        <span className="mono hidden text-ink xl:inline">{usd(team.spent_usd)}<span className="text-dim"> / {usd(team.cap_usd, 0)}</span></span>
        <Wallet className="size-3.5 text-money xl:hidden" />
      </Link>
    </Tooltip>
  );
}

/** One dot per AI provider: green = live key, amber = placeholder mode, grey = not set up. */
export function ProviderDots() {
  const t = useT();
  const { data } = useSettings();
  const list = data?.providers ?? [];
  if (!list.length) return null;
  const live = list.filter((p) => p.mode === "live").length;
  const tone = (m: string) => (m === "live" ? "bg-ok" : m === "mock" ? "bg-warn" : "bg-dim/60");
  return (
    <Tooltip
      side="bottom"
      content={<span className="block space-y-0.5">{list.map((p) => <span key={p.provider} className="flex items-center gap-2"><span className={clsx("size-1.5 rounded-full", tone(p.mode))} />{p.label.split(" (")[0]}<span className="text-dim">{p.mode === "live" ? t("live") : p.mode === "mock" ? t("placeholder") : t("no key")}</span></span>)}</span>}
    >
      <Link to="/settings" aria-label={t("AI services")} className={chip}>
        <Cpu className="size-3.5 text-mute" />
        <span className="flex items-center gap-1" aria-hidden>{list.map((p) => <span key={p.provider} className={clsx("size-1.5 rounded-full", tone(p.mode))} />)}</span>
        <span className="mono hidden text-mute 2xl:inline">{live}/{list.length} {t("live")}</span>
      </Link>
    </Tooltip>
  );
}

/** Bell with a dot when something needs attention; the list opens below it. */
export function NotificationsButton({ placement = "bottom-end" }: { placement?: "bottom-end" | "top-end" }) {
  const t = useT();
  const nav = useNavigate();
  const { data: notes } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const count = notes?.length ?? 0;
  return (
    <>
      <Tooltip content={t("Notifications")} side="bottom" disabled={open}>
        <button ref={ref} aria-label={t("Notifications")} aria-expanded={open} onClick={() => setOpen((v) => !v)}
          className={clsx("group relative grid size-8 place-items-center rounded-lg text-mute outline-none transition-colors hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50", open && "bg-hover text-ink")}>
          <Bell className={clsx("size-[18px]", !!count && "origin-top group-hover:animate-[wiggle_0.5s_ease-in-out]")} />
          {!!count && <span className="mono absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[0.625rem] font-bold text-black ring-2 ring-panel">{count}</span>}
        </button>
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement={placement} width={340} className="p-2">
        <p className="eyebrow px-2 pb-2 pt-1">{t("Needs your attention")}</p>
        {!notes?.length && <p className="px-2 pb-3 text-sm text-dim">{t("All clear.")}</p>}
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {notes?.map((n) => (
            <button key={`${n.type}-${n.id}`} className="block w-full rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-hover"
              onClick={() => { setOpen(false); if (n.type === "approval") nav("/approvals"); else if (n.project_id) nav(`/p/${n.project_id}/storyboard`); }}>
              <span className="line-clamp-2">{n.text}</span>
              <span className="mono text-2xs text-dim">{n.type} · {ago(n.created_at)}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

/** Streams the most recent running job into the status bar. */
export function useTicker() {
  const { running, waiting } = useWorkload();
  const first = running[0];
  return { first, running: running.length, waiting: waiting.length };
}
