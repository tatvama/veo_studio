import { useQueryClient } from "@tanstack/react-query";
import { Calculator, Coins, ScanEye } from "lucide-react";
import { useState } from "react";
import { useGenerate } from "../../../components/Generate";
import { CostConfirm } from "../../../components/growth/common";
import { SectionCard } from "../../../components/room/kit";
import { Button, Segmented } from "../../../components/ui";
import { api } from "../../../lib/api";
import { estimateUpscale, skipLabel, type UpscaleEstimate } from "../../../lib/finish";
import { secs, usd } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import type { SubmitResult } from "../../../lib/types";
import { Quiet } from "./parts";

const TARGETS = [{ value: 2160, label: "4K · 2160p" }, { value: 1440, label: "1440p" }];
const wh = (v?: [number, number]) => (v && v.length === 2 ? `${v[0]}×${v[1]}` : "—");

/**
 * The AI upscale step (a paid cloud call): estimate first, with what each shot costs and which are skipped, then run it
 * through the same budget and approval path as every paid job.
 */
export function UpscaleCard({ eid, canEdit, className }: { eid: number; canEdit: boolean; className?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { submit } = useGenerate();
  const [target, setTarget] = useState(2160);
  const [est, setEst] = useState<UpscaleEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const estimate = async (h = target) => {
    setBusy(true);
    const r = await estimateUpscale(eid, { target_h: h });
    setBusy(false);
    if (r) setEst(r);
  };
  const run = async () => {
    const r = await submit(() => api.post<SubmitResult>(`/api/episodes/${eid}/upscale`, { target_h: target }), t("4K upscale"));
    if (r) { setEst(null); qc.invalidateQueries({ queryKey: ["episode", eid] }); }
    return r;
  };
  const seconds = est?.items.reduce((a, i) => a + (i.seconds || 0), 0) ?? 0;

  return (
    <SectionCard className={className} icon={<ScanEye />} title={t("4K upscale")}
      description={t("AI-upscales the current video of each shot so 4K renders aren't just stretched. Paid per second; shots already sharp enough are skipped.")}
      actions={<Segmented size="sm" value={target} aria-label={t("Target height")} onChange={(v) => { setTarget(v); if (est) void estimate(v); }} options={TARGETS} />}>
      <div className="space-y-3">
        {!est ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" icon={<Calculator className="size-4" />} loading={busy} onClick={() => void estimate()}>{t("Estimate the cost")}</Button>
            <span className="text-2xs text-dim">{t("Nothing is charged until you confirm.")}</span>
          </div>
        ) : (
          <>
            {est.items.length ? (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-raised text-2xs uppercase tracking-wide text-dim">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-medium">{t("Shot")}</th>
                      <th className="px-3 py-1.5 text-left font-medium">{t("From → to")}</th>
                      <th className="px-3 py-1.5 text-right font-medium">{t("Seconds")}</th>
                      <th className="px-3 py-1.5 text-right font-medium">{t("Cost")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {est.items.map((i) => (
                      <tr key={i.shot_id} className="border-t border-line/60">
                        <td className="mono px-3 py-1.5">{i.code}</td>
                        <td className="mono px-3 py-1.5 text-mute">{wh(i.from)} → <span className="text-ink">{wh(i.to)}</span></td>
                        <td className="mono px-3 py-1.5 text-right tabular-nums text-mute">{i.seconds.toFixed(1)}</td>
                        <td className="mono px-3 py-1.5 text-right tabular-nums text-money">{usd(i.usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-line bg-raised/50 font-medium">
                      <td className="px-3 py-1.5">{t("{n} shots", { n: est.items.length })}</td>
                      <td />
                      <td className="mono px-3 py-1.5 text-right tabular-nums">{secs(seconds)}</td>
                      <td className="mono px-3 py-1.5 text-right tabular-nums text-money">{usd(est.total_usd)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : <Quiet>{t("Nothing to upscale: every shot already meets {h}p or has a fresh upscale.", { h: target })}</Quiet>}
            {est.skipped.length > 0 && (
              <details className="rounded-lg border border-line px-3 py-2 text-xs">
                <summary className="cursor-pointer text-mute">{t("{n} skipped", { n: est.skipped.length })}</summary>
                <ul className="mt-1.5 space-y-0.5">{est.skipped.map((s, i) => <li key={i} className="mono text-2xs text-dim">{skipLabel(s)}</li>)}</ul>
              </details>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {est.items.length > 0 && (
                <Button variant="primary" icon={<Coins className="size-4" />} disabled={!canEdit} onClick={() => setConfirm(true)}>
                  {t("Upscale {n} shots · {usd}", { n: est.items.length, usd: usd(est.total_usd) })}
                </Button>
              )}
              <Button variant="ghost" loading={busy} onClick={() => void estimate()}>{t("Estimate again")}</Button>
              {!canEdit && <span className="text-xs text-dim">{t("Creators and producers can run paid steps.")}</span>}
            </div>
          </>
        )}
        <p className="text-2xs leading-relaxed text-dim">{t("Local renders use an upscale when \"Use AI upscales\" is on. It goes stale when the shot gets a new video.")}</p>
      </div>
      <CostConfirm open={confirm} onClose={() => setConfirm(false)} title={t("4K upscale")} amount={est?.total_usd ?? 0}
        lines={(est?.items ?? []).map((i) => ({ label: `${i.code} · ${wh(i.from)} → ${wh(i.to)} · ${i.seconds.toFixed(1)}s`, usd: i.usd }))}
        confirmLabel={est?.total_usd ? t("Upscale · {usd}", { usd: usd(est.total_usd) }) : t("Upscale · free")}
        note={t("Each shot's current video is sent to the upscaler and saved as an upscale take of it.")}
        onConfirm={run} />
    </SectionCard>
  );
}
