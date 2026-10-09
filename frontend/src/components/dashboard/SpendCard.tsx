import { Coins } from "lucide-react";
import { motion } from "motion/react";
import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";
import { usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { Project } from "../../lib/types";
import type { EpisodeDashboard } from "../../lib/v3";
import { AnimatedNumber, Panel } from "../ui";

const PROVIDER_LABELS: Record<string, string> = { google: "Google", fal: "fal.ai", elevenlabs: "ElevenLabs", sarvam: "Sarvam", openai: "OpenAI", other: "Other" };

/** Episode spend: total, by provider, wasted, cost per approved second, what is still to come, and the project budget cap. All money is amber mono. */
export function SpendCard({ d, project, index, className }: { d: EpisodeDashboard; project: Project; index?: number; className?: string }) {
  const t = useT();
  const providers = Object.entries(d.spend.by_provider).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...providers.map(([, v]) => v), 0);
  const cap = project.budget_cap_usd ?? null;
  const spent = project.spent_usd ?? 0;
  const capPct = cap ? spent / cap : 0;
  const over = capPct >= 1;
  return (
    <Panel index={index} className={className} tone="money" eyebrow={t("Spend")} icon={<Coins />}
      actions={<Link to="/costs" className="text-xs font-medium text-accent-ink hover:underline">{t("All costs")} →</Link>}>
      <p className="eyebrow">{t("This episode")}</p>
      <p className="mono mt-2 text-4xl font-medium leading-none tracking-tight text-money">
        <AnimatedNumber value={d.spend.total_usd} format={(n) => usd(n)} />
      </p>

      <dl className="mt-4 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line">
        <Stat label={t("Wasted")} value={usd(d.spend.wasted_usd)} hint={t("Rejected video takes")} flag={d.spend.wasted_usd > 0} />
        <Stat label={t("Per second")} value={d.spend.per_approved_second === null ? "—" : usd(d.spend.per_approved_second)} hint={t("Total spend ÷ approved seconds")} />
        <Stat label={t("Est. left")} value={d.spend.estimated_remaining_usd === null ? "—" : usd(d.spend.estimated_remaining_usd)} hint={t("At today's cost per second, for the footage still to approve")} />
      </dl>

      <div className="mt-4">
        <p className="eyebrow mb-2.5">{t("By provider")}</p>
        {providers.length ? (
          <ul className="space-y-2">
            {providers.map(([p, v], i) => (
              <li key={p} className="grid grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)_auto] items-center gap-3 text-xs">
                <span className="truncate text-mute" title={p}>{t(PROVIDER_LABELS[p] ?? p)}</span>
                <div className="h-1.5 overflow-hidden rounded-full bg-line">
                  <motion.div className="h-full rounded-full bg-money" initial={{ width: 0 }} animate={{ width: `${max ? Math.max(2, (v / max) * 100) : 0}%` }}
                    transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1], delay: i * 0.05 }} />
                </div>
                <span className="mono text-right font-medium text-money">{usd(v)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-dim">{t("Nothing spent yet.")}</p>}
      </div>

      <div className="mt-4 rounded-lg border border-line bg-raised/40 p-3">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="eyebrow">{t("Project budget")}</span>
          <span className={cn("mono text-xs", over ? "font-medium text-bad" : "text-money")}>
            {cap ? <>{usd(spent)} <span className="text-dim">/ {usd(cap)}</span></> : <>{usd(spent)} <span className="text-dim">{t("no cap")}</span></>}
          </span>
        </div>
        <div className="relative h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-label={t("Project budget")} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={cap ? Math.min(100, Math.round(capPct * 100)) : 0}>
          {cap ? <motion.div className={cn("h-full rounded-full", over ? "bg-bad" : "bg-money")} initial={{ width: 0 }} animate={{ width: `${Math.min(100, Math.max(2, capPct * 100))}%` }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }} /> : null}
        </div>
        {cap ? (
          <p className="mono mt-1.5 flex justify-between text-2xs text-dim">
            <span>{Math.round(capPct * 100)}% {t("of cap")}</span><span>{over ? t("over by {a}", { a: usd(spent - cap) }) : t("{a} left", { a: usd(cap - spent) })}</span>
          </p>
        ) : <p className="mt-1.5 text-2xs text-dim">{t("Set a budget cap in the project brief to track it here.")}</p>}
      </div>
    </Panel>
  );
}

function Stat({ label, value, hint, flag }: { label: string; value: string; hint?: string; flag?: boolean }) {
  return (
    <div title={hint} className="min-w-0 bg-panel px-2.5 py-2">
      <dt className="eyebrow truncate">{label}</dt>
      <dd className={cn("mono mt-1.5 truncate text-sm font-medium text-money", flag && "underline decoration-warn decoration-dotted underline-offset-4")}>{value}</dd>
    </div>
  );
}
