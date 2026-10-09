import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Coins, History, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { cn } from "../../lib/cn";
import { LANG_SHORT, usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useUI } from "../../lib/store";
import type { SubmitResult } from "../../lib/types";
import { markFresh, regenerateStale, useImpact, type Impact, type StaleTake } from "../../lib/v3";
import { useGenerate } from "../Generate";
import { LoadError } from "../room/kit";
import { Badge, Button, Modal, Panel, Skeleton } from "../ui";

const KIND_LABELS: Record<string, string> = { keyframe: "Keyframe", video: "Video", voice: "Voice", narration: "Narration", lipsync: "Lip-sync", voicelock: "Voice lock" };

type Target = { shot_ids?: number[]; code?: string };

/** Change impact: every stale take grouped by shot, "Mark fresh" per take, regenerate per shot or everything (with the cost first). */
export function ImpactPanel({ eid, pid, canEdit, canReview, index, className }: { eid: number; pid: number; canEdit: boolean; canReview: boolean; index?: number; className?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { submit } = useGenerate();
  const { data, isLoading, isError, refetch } = useImpact(eid);
  const [confirm, setConfirm] = useState<Target | null>(null);
  const [freshing, setFreshing] = useState<number | null>(null);
  const [running, setRunning] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["impact", eid] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["episode", eid] });
  };
  const fresh = async (take: StaleTake) => {
    setFreshing(take.id);
    try { await markFresh(take.id); refresh(); toast.success(tr("Take #{id} marked fresh", { id: take.id })); } catch { /* api toasts */ } finally { setFreshing(null); }
  };
  const run = async () => {
    if (!confirm) return;
    setRunning(true);
    try {
      const what = confirm.code ? tr("Regenerate {code}", { code: confirm.code }) : tr("Regenerate stale takes");
      const r = await submit(() => regenerateStale(eid, confirm.shot_ids) as Promise<SubmitResult>, what);
      if (r) { setConfirm(null); refresh(); }
    } finally { setRunning(false); }
  };

  const head = { id: "mission-impact", index, className, eyebrow: t("Change impact"), icon: <History /> };
  if (isError && !data) return <Panel {...head}><LoadError what={t("Couldn't load the change impact")} onRetry={() => refetch()} /></Panel>;
  if (isLoading || !data) {
    return <Panel {...head}><div className="space-y-2" aria-busy="true"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div></Panel>;
  }
  const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
  const plan = confirm?.code ? data.plan.filter((l) => l.label.includes(confirm.code!)) : data.plan;
  const planTotal = plan.reduce((a, l) => a + l.usd, 0);
  const stale = data.shots.length > 0;

  return (
    <Panel {...head} tone={stale ? "warn" : undefined}
      actions={canEdit && stale && (
        <Button variant="primary" size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => setConfirm({})}>
          {t("Regenerate all stale")} <span className="mono font-normal opacity-80">· {usd(data.estimate_usd)}</span>
        </Button>
      )}>
      {!stale ? (
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-ok/40 bg-ok/10 text-ok"><CheckCircle2 className="size-4" /></span>
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("Nothing is stale")}</p>
            <p className="mt-0.5 text-xs text-mute">{t("Every take matches its shot. When a shot changes after its takes were made, they are listed here.")}</p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="mono flex items-baseline gap-1.5 text-[1.65rem] font-medium leading-none tracking-tight text-warn">
              {total}<span className="text-sm font-normal text-mute">{total === 1 ? t("stale take") : t("stale takes")} {data.shots.length === 1 ? t("in 1 shot") : t("in {s} shots", { s: data.shots.length })}</span>
            </p>
            <span className="flex flex-wrap items-center gap-1.5">{Object.entries(data.counts).map(([k, n]) => <Badge key={k} tone="warn">{t(KIND_LABELS[k] ?? k)} <span className="mono">{n}</span></Badge>)}</span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-mute">{t("Takes made before their shot changed. Nothing is deleted: a stale take keeps playing until a new one replaces it.")}</p>
          <ul className="mt-3 max-h-[26rem] divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {data.shots.map((s) => <ShotGroup key={s.shot_id} s={s} pid={pid} canEdit={canEdit} canReview={canReview} freshing={freshing}
              estimate={data.plan.filter((l) => l.label.includes(s.code)).reduce((a, l) => a + l.usd, 0)}
              onFresh={fresh} onRegen={() => setConfirm({ shot_ids: [s.shot_id], code: s.code })} />)}
          </ul>
        </>
      )}

      <Modal open={!!confirm} onClose={() => setConfirm(null)} size="md"
        title={<span className="flex items-center gap-2"><Coins className="size-4 text-money" />{confirm?.code ? t("Regenerate {code}", { code: confirm.code }) : t("Regenerate all stale takes")}</span>}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(null)} disabled={running}>{t("Cancel")}</Button>
          <Button variant="primary" data-autofocus loading={running} icon={<Sparkles className="size-4" />} onClick={run}>{t("Regenerate · {usd}", { usd: usd(planTotal) })}</Button>
        </>}>
        <div className="space-y-3">
          <p className="text-sm text-mute">{t("Keyframes first; a shot whose keyframe and video are both stale gets one video job (it remakes the keyframe itself). Voices and lip-syncs follow per language.")}</p>
          <div className="max-h-[40vh] overflow-y-auto rounded-xl border border-line">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 bg-raised text-2xs uppercase tracking-wide text-dim">
                <tr><th scope="col" className="px-3 py-1.5 text-left font-medium">{t("Job")}</th><th scope="col" className="px-3 py-1.5 text-right font-medium">{t("Estimate")}</th></tr>
              </thead>
              <tbody>
                {plan.map((l, i) => (
                  <tr key={i} className="border-t border-line/60">
                    <td className="max-w-0 truncate px-3 py-1.5 text-mute" title={l.label}>{l.label}</td>
                    <td className={cn("mono w-24 px-3 py-1.5 text-right", l.usd === 0 ? "text-dim" : "text-money")}>{usd(l.usd)}</td>
                  </tr>
                ))}
                {!plan.length && <tr><td colSpan={2} className="px-3 py-3 text-center text-xs text-dim">{t("Nothing to regenerate for this selection.")}</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="flex items-center justify-between text-sm"><span className="text-mute">{t("Estimated total")}</span><span className="mono font-semibold text-money">{usd(planTotal)}</span></p>
          <p className="text-xs text-dim">{t("Estimates use list prices; the ledger records the actual cost. Spending past your limits is sent for approval.")}</p>
        </div>
      </Modal>
    </Panel>
  );
}

function ShotGroup({ s, pid, canEdit, canReview, freshing, estimate, onFresh, onRegen }: {
  s: Impact["shots"][number]; pid: number; canEdit: boolean; canReview: boolean; freshing: number | null; estimate: number; onFresh: (t: StaleTake) => void; onRegen: () => void;
}) {
  const t = useT();
  const nav = useNavigate();
  const setSelectedShot = useUI((u) => u.setSelectedShot);
  const open = () => { setSelectedShot(s.shot_id); nav(`/p/${pid}/storyboard`); };
  return (
    <li className="px-3 py-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <button type="button" onClick={open} title={t("Open in the storyboard")} className="mono rounded text-xs font-semibold text-ink hover:text-accent-ink hover:underline">{s.code}</button>
        <Badge>{t(s.status.replaceAll("_", " "))}</Badge>
        <span className="flex-1" />
        {estimate > 0 && <span className="mono text-2xs text-money">{usd(estimate)}</span>}
        {canEdit && <Button size="sm" variant="outline" icon={<RefreshCw className="size-3.5" />} onClick={onRegen}>{t("Regenerate")}</Button>}
      </div>
      <ul className="space-y-1">
        {s.takes.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <Badge tone="warn"><History className="size-3" />{t(KIND_LABELS[x.kind] ?? x.kind)}</Badge>
            {x.language && <Badge className="mono">{LANG_SHORT[x.language] ?? x.language}</Badge>}
            {x.selected && <Badge tone="accent">{t("in use")}</Badge>}
            <span className="min-w-0 flex-1 truncate text-mute" title={x.reason}><span className="mono text-dim">#{x.id}</span> · {x.reason || t("the shot changed")}</span>
            {canReview && (
              <Button size="sm" variant="ghost" loading={freshing === x.id} onClick={() => onFresh(x)} title={t("Keep this take: clear the stale flag")}>{t("Mark fresh")}</Button>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}
