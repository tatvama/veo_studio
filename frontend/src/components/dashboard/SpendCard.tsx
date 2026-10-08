import { clsx } from "clsx";
import { Coins } from "lucide-react";
import { motion } from "motion/react";
import { Link } from "react-router-dom";
import { usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { Project } from "../../lib/types";
import type { EpisodeDashboard } from "../../lib/v3";
import { SectionCard } from "../room/kit";
import { AnimatedNumber, Progress } from "../ui";

const PROVIDER_LABELS: Record<string, string> = { google: "Google", fal: "fal.ai", elevenlabs: "ElevenLabs", sarvam: "Sarvam", openai: "OpenAI", other: "Other" };

/** Episode spend: total, by provider, wasted, cost per approved second, what's still to come, and the project budget cap. */
export function SpendCard({ d, project, index }: { d: EpisodeDashboard; project: Project; index?: number }) {
  const t = useT();
  const providers = Object.entries(d.spend.by_provider).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...providers.map(([, v]) => v), 0);
  const cap = project.budget_cap_usd ?? null;
  const spent = project.spent_usd ?? 0;
  const capPct = cap ? spent / cap : 0;
  return (
    <SectionCard index={index} icon={<Coins />} title={t("Spend")} description={t("Actual cost from the ledger for this episode's jobs.")}
      actions={<Link to="/costs" className="text-xs font-medium text-accent-ink hover:underline">{t("See all costs")} →</Link>}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <p className="text-xs font-medium text-mute">{t("Total this episode")}</p>
          <p className="mt-1 text-2xl font-semibold leading-none tracking-tight tabular-nums"><AnimatedNumber value={d.spend.total_usd} format={(n) => usd(n)} /></p>
        </div>
        <dl className="grid grid-cols-3 gap-x-5 gap-y-1 text-right">
          <Num label={t("Wasted")} value={usd(d.spend.wasted_usd)} tone={d.spend.wasted_usd > 0 ? "warn" : undefined} hint={t("Rejected video takes")} />
          <Num label={t("Per approved second")} value={d.spend.per_approved_second === null ? "—" : usd(d.spend.per_approved_second)} hint={t("Total spend ÷ approved seconds")} />
          <Num label={t("Est. remaining")} value={d.spend.estimated_remaining_usd === null ? "—" : usd(d.spend.estimated_remaining_usd)} hint={t("At today's cost per second, for the footage still to approve")} />
        </dl>
      </div>

      <div className="mt-4">
        <p className="mb-2 text-xs font-medium text-mute">{t("By provider")}</p>
        {providers.length ? (
          <ul className="space-y-1.5">
            {providers.map(([p, v], i) => (
              <li key={p} className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_4.5rem] items-center gap-3 text-xs">
                <span className="truncate text-mute" title={p}>{t(PROVIDER_LABELS[p] ?? p)}</span>
                <div className="h-1.5 overflow-hidden rounded-full bg-line">
                  <motion.div className="h-full rounded-full bg-accent" initial={{ width: 0 }} animate={{ width: `${max ? Math.max(2, (v / max) * 100) : 0}%` }}
                    transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1], delay: i * 0.05 }} />
                </div>
                <span className="text-right font-medium tabular-nums">{usd(v)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-dim">{t("Nothing spent yet.")}</p>}
      </div>

      <div className="mt-4 rounded-lg border border-line bg-raised/40 p-3">
        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
          <span className="font-medium">{t("Project budget")}</span>
          <span className={clsx("tabular-nums", capPct >= 1 ? "font-medium text-bad" : "text-mute")}>
            {cap ? t("{spent} of {cap} cap", { spent: usd(spent), cap: usd(cap) }) : t("{spent} spent · no cap set", { spent: usd(spent) })}
          </span>
        </div>
        <Progress value={cap ? capPct : 0} size="md" tone={capPct >= 1 ? "bad" : capPct >= 0.8 ? "warn" : "accent"} />
        {!cap && <p className="mt-1.5 text-2xs text-dim">{t("Set a budget cap in the project brief to track it here.")}</p>}
      </div>
    </SectionCard>
  );
}

function Num({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warn" }) {
  return (
    <div title={hint}>
      <dt className="text-2xs text-dim">{label}</dt>
      <dd className={clsx("text-sm font-semibold tabular-nums", tone === "warn" && "text-amber-300")}>{value}</dd>
    </div>
  );
}
