import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, RefreshCw } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { quote } from "../../lib/estimates";
import { tr, useT } from "../../lib/i18n";
import type { SubmitResult } from "../../lib/types";
import { regenerateStale } from "../../lib/v3";
import { useGenerate } from "../Generate";
import { PriceSuffix } from "../kit/Price";
import { Button } from "../ui";

/** GET /api/characters/{id}/impact?project_id=: the project's shots that show the character and are out of date since its look changed. */
export interface CharacterImpact {
  character_id: number; name: string; shots: string[]; shot_ids: number[];
  episodes: { episode_id: number; number: number; shot_ids: number[]; codes: string[]; estimate_usd: number }[];
  estimate: number;
}

const impactQuery = (cid: number, pid: number) => ({
  queryKey: ["character-impact", cid, pid] as const,
  queryFn: () => api.get<CharacterImpact>(`/api/characters/${cid}/impact?project_id=${pid}`, { silent: true }),
  staleTime: 20_000,
  retry: false,
});

/** One character's out-of-date shots in this project (nothing outside a project). */
export function useCharacterImpact(cid: number | null | undefined, pid: number | undefined) {
  return useQuery({ ...impactQuery(cid ?? 0, pid ?? 0), enabled: !!cid && !!pid });
}

/** How many shots are out of date per character (for the "look out of date" mark in the cast list). */
export function useCastImpact(cids: number[], pid: number | undefined): Record<number, number> {
  const res = useQueries({ queries: cids.map((cid) => ({ ...impactQuery(cid, pid ?? 0), enabled: !!pid })) });
  const out: Record<number, number> = {};
  cids.forEach((cid, i) => { out[cid] = res[i]?.data?.shot_ids.length ?? 0; });
  return out;
}

/** After the look of a character changed: re-read which shots are out of date (and the shots themselves). */
export function refreshImpact(qc: ReturnType<typeof useQueryClient>) {
  for (const k of ["character-impact", "impact", "episode", "jobs", "dashboard"]) qc.invalidateQueries({ queryKey: [k] });
}

/** Folds the per-episode answers of one redo into the one result the cost dialog's toast reports. */
function merge(results: SubmitResult[]): SubmitResult {
  const jobs = results.flatMap((r) => r.jobs ?? []);
  const status = results.some((r) => r.status === "awaiting_approval") ? "awaiting_approval"
    : results.some((r) => r.status === "proposed") ? "proposed"
    : jobs.length ? (results.find((r) => r.jobs?.length)?.status ?? "queued") : "nothing_to_do";
  return {
    batch_id: results.find((r) => r.batch_id)?.batch_id ?? "", status, jobs,
    total_usd: results.reduce((a, r) => a + (r.total_usd || 0), 0),
    reason: results.find((r) => r.reason)?.reason,
  };
}

/**
 * "Ravi's look changed: 6 shots are out of date · Redo these 6 shots · $0.84". Shows only when the character's approved
 * pictures, lock or an outfit changed after shots were made with the old look. The price comes first (cost dialog), then
 * each episode's shots are redone (POST /api/episodes/{eid}/impact/regenerate).
 */
export function RedoShotsBanner({ cid, name, projectId, canEdit }: { cid: number; name: string; projectId: number | undefined; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { priced } = useGenerate();
  const { data } = useCharacterImpact(cid, projectId);
  const [busy, setBusy] = useState(false);
  const n = data?.shot_ids.length ?? 0;
  if (!projectId || !data || !n) return null;

  const redo = async () => {
    setBusy(true);
    try {
      await priced({
        quote: () => quote({ action: "redo_shots", character_id: cid, project_id: projectId }),
        run: async () => {
          const results: SubmitResult[] = [];
          for (const e of data.episodes) {
            try { results.push(await regenerateStale(e.episode_id, e.shot_ids) as SubmitResult); } catch { /* api toasts; the other episodes still go */ }
          }
          return merge(results);
        },
        what: n === 1 ? tr("Redo 1 shot of {name}", { name }) : tr("Redo {n} shots of {name}", { n, name }),
      });
      refreshImpact(qc);
    } finally { setBusy(false); }
  };

  const codes = data.shots.slice(0, 8).join(", ") + (data.shots.length > 8 ? ` +${data.shots.length - 8}` : "");
  return (
    <section role="status" aria-label={t("Out-of-date shots")}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warn/35 bg-warn/8 px-3.5 py-3">
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg border border-warn/35 bg-warn/12 text-warn"><History className="size-4" /></span>
      <div className="min-w-0 flex-1 basis-52">
        <p className="text-sm font-medium">
          {n === 1 ? t("{name}'s look changed: 1 shot is out of date", { name }) : t("{name}'s look changed: {n} shots are out of date", { name, n })}
        </p>
        <p className="mono mt-0.5 truncate text-2xs text-mute" title={data.shots.join(", ")}>{codes}</p>
      </div>
      {canEdit && (
        <Button variant="primary" size="sm" className="max-sm:h-10" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={() => void redo()}>
          {n === 1 ? t("Redo this shot") : t("Redo these {n} shots", { n })}<PriceSuffix usd={data.estimate} />
        </Button>
      )}
    </section>
  );
}
