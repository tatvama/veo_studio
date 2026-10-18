import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, Film, Image as ImageIcon, RotateCcw, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Skeleton, Tooltip } from "../../../components/ui";
import { api } from "../../../lib/api";
import { tr, useT } from "../../../lib/i18n";
import { useShot } from "../../../lib/queries";
import type { Shot, Take } from "../../../lib/types";
import { useProjectCtx } from "../context";
import { TryEngineButton } from "../TryEngine";
import { useActions } from "./actions";
import { STEP_LABEL, type Dot, type ShotNote } from "./model";

const KINDS = ["keyframe", "video"];

/**
 * The shot's takes, pictures and videos, newest first (the Flora pattern): the ones in use are marked, a click on
 * another uses it instead (POST /api/takes/{id}/select), so the next step starts from it. Nothing is deleted: every
 * take stays one click away.
 */
export function TakeHistory({ shot, lang }: { shot: Shot; lang: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { canReview } = useProjectCtx();
  const { data, isLoading } = useShot(shot.id, lang);
  const [busy, setBusy] = useState<number | null>(null);
  const takes = useMemo(() => (data?.takes ?? []).filter((x) => KINDS.includes(x.kind) && x.status === "ready")
    .sort((a, b) => b.id - a.id), [data?.takes]);
  // each take's number among its kind, oldest = 1 (as the full shot's Takes tab counts them)
  const number = useMemo(() => {
    const out = new Map<number, number>();
    for (const k of KINDS) takes.filter((x) => x.kind === k).reverse().forEach((x, i) => out.set(x.id, i + 1));
    return out;
  }, [takes]);
  const inUse = new Set([shot.keyframe?.id, shot.video?.id].filter((x): x is number => typeof x === "number"));

  const use = async (x: Take) => {
    if (busy || inUse.has(x.id) || !canReview) return;
    setBusy(x.id);
    try {
      await api.post(`/api/takes/${x.id}/select`);
      for (const k of ["shot", "episode", "board"]) qc.invalidateQueries({ queryKey: [k] });
      toast.success(x.kind === "keyframe"
        ? tr("Picture {n} is used now: the video starts from it", { n: number.get(x.id) ?? "" })
        : tr("Video {n} is used now in the film", { n: number.get(x.id) ?? "" }));
    } catch { /* the api layer showed the error */ } finally { setBusy(null); }
  };

  if (isLoading) return <Skeleton className="h-16" />;
  if (!takes.length) return null;
  return (
    <div>
      <p className="eyebrow mb-1.5 flex items-center justify-between">
        <span>{t("Takes")} · {takes.length}</span>
        <span className="normal-case tracking-normal text-dim">{t("newest first")}</span>
      </p>
      <div className="flex gap-1.5 overflow-x-auto pb-1" role="listbox" aria-label={t("Takes")}>
        {takes.map((x) => {
          const on = inUse.has(x.id);
          const pic = x.kind === "keyframe" ? x.thumb_url || x.url : x.thumb_url;
          const draft = !!x.params?.draft;
          const what = `${x.kind === "keyframe" ? t("Picture") : t("Video")} ${number.get(x.id) ?? ""}`;
          const engine = String(x.params?.engine_label || x.model || x.provider || "");
          const tip = [what, engine, draft ? t("480p draft") : "", on ? t("in use") : canReview ? t("click to use it") : ""].filter(Boolean).join(" · ");
          return (
            <Tooltip key={x.id} content={tip}>
              <button type="button" role="option" aria-selected={on} aria-label={tip} disabled={busy != null || (!on && !canReview)}
                onClick={() => void use(x)}
                className={clsx("relative h-12 w-[72px] shrink-0 overflow-hidden rounded-md border bg-black transition-colors disabled:cursor-default",
                  on ? "border-accent shadow-[0_0_0_1px_var(--color-accent)]" : "border-line hover:border-accent/60")}>
                {pic ? <img src={pic} alt="" loading="lazy" className="size-full object-cover" />
                  : <span className="grid size-full place-items-center text-white/40">{x.kind === "video" ? <Film className="size-4" /> : <ImageIcon className="size-4" />}</span>}
                <span className="absolute left-0.5 top-0.5 grid size-4 place-items-center rounded bg-black/70 text-white/90">
                  {x.kind === "video" ? <Film className="size-2.5" /> : <ImageIcon className="size-2.5" />}
                </span>
                {draft && <span className="mono absolute bottom-0.5 left-0.5 rounded bg-black/70 px-0.5 text-[9px] font-semibold leading-tight text-ai">480p</span>}
                {on && <span className="absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-accent text-black"><Check className="size-2.5" /></span>}
                {busy === x.id && <span className="absolute inset-0 grid place-items-center bg-black/50"><span className="eq"><i /><i /><i /><i /></span></span>}
              </button>
            </Tooltip>
          );
        })}
      </div>
      <p className="mt-0.5 text-2xs leading-snug text-dim">
        {canReview ? t("The marked takes are used. Click another to use it next; nothing is deleted.") : t("The marked takes are used.")}
      </p>
    </div>
  );
}

/**
 * What failed for this shot, in plain words, with its fix: Retry (priced) and, for a video, Try another engine; and
 * what the last run says about the shot otherwise (e.g. a line too long for one clip).
 */
export function ShotFailures({ shotId, code, dots, notes, canEdit }: { shotId: number; code: string; dots: Dot[]; notes?: ShotNote[]; canEdit: boolean }) {
  const t = useT();
  const a = useActions();
  const failed = dots.filter((d) => d.state === "failed");
  if (!failed.length && !notes?.length) return null;
  return (
    <div className="space-y-1.5">
      {failed.map((d) => (
        <div key={d.step} className="rounded-lg border border-bad/40 bg-bad/8 p-2">
          <p className="flex items-start gap-1.5 text-xs leading-snug">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-bad" />
            <span><span className="font-semibold">{t("{step} failed", { step: t(STEP_LABEL[d.step]) })}:</span> {d.reason || d.error}</span>
          </p>
          {d.next && <p className="mt-0.5 pl-5 text-2xs leading-snug text-dim">{d.next}</p>}
          {canEdit && (
            <div className="mt-1.5 flex flex-wrap gap-1.5 pl-5">
              {d.step === "video" && <TryEngineButton shotId={shotId} code={code} variant={d.blocked ? "primary" : "outline"} />}
              <button type="button" onClick={() => void a.runStep(shotId, d.step)} title={t("Make it again (you see the price first)")}
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-line px-2 text-xs font-medium hover:bg-hover">
                <RotateCcw className="size-3.5" />{t("Retry")}
              </button>
            </div>
          )}
        </div>
      ))}
      {notes?.map((n, i) => (
        <div key={i} className="rounded-lg border border-warn/40 bg-warn/8 p-2">
          <p className="flex items-start gap-1.5 text-xs leading-snug"><TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" />{n.reason}</p>
          {n.next && <p className="mt-0.5 pl-5 text-2xs leading-snug text-dim">{n.next}</p>}
        </div>
      ))}
    </div>
  );
}
