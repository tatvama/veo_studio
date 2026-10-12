import { useQueryClient } from "@tanstack/react-query";
import { GitCommitVertical, History, RotateCcw, Save } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { agoT, fmtDateTime } from "../../../components/growth/common";
import { SectionCard } from "../../../components/room/kit";
import { Avatar, Badge, Button, Field, Modal, Skeleton, Textarea, Tooltip } from "../../../components/ui";
import { restoreVersion, saveVersion, useCheckout, useVersions, type CutVersion } from "../../../lib/finish";
import { secs } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { ConfirmDialog } from "../../admin/shared/ConfirmDialog";
import { Quiet } from "./parts";

const SHOWN = 8;

/** The cut's check-in history: save a version now, or roll the cut back to one (a safety copy is saved first). */
export function VersionsCard({ eid, canEdit, className }: { eid: number; canEdit: boolean; className?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { versions, isLoading, available, isError, refetch } = useVersions(eid);
  const { lockedByOther, lock } = useCheckout(eid);
  const [saveOpen, setSaveOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<CutVersion | null>(null);
  const [all, setAll] = useState(false);
  const canWrite = canEdit && !lockedByOther;
  const byId = new Map(versions.map((v) => [v.id, v]));

  const save = async () => {
    setBusy(true);
    const v = await saveVersion(qc, eid, note);
    setBusy(false);
    if (v) {
      toast.success(t("Saved as v{n}", { n: v.number }));
      setSaveOpen(false);
      setNote("");
    }
  };
  const restore = async () => {
    if (!restoring) return;
    setBusy(true);
    const ok = await restoreVersion(qc, eid, restoring.id);
    setBusy(false);
    if (ok) {
      toast.success(t("Cut restored to v{n}", { n: restoring.number }), { description: t("The cut before it was saved as a version too.") });
      setRestoring(null);
    }
  };
  const list = all ? versions : versions.slice(0, SHOWN);
  const lockTip = lockedByOther ? t("{name} has the cut checked out", { name: lock?.user?.name ?? t("Someone") }) : undefined;

  return (
    <SectionCard className={className} icon={<History />} title={t("Versions")}
      description={t("Every check-in saves the cut: order, trims, effects, takes, layers, mix and music. Roll back any time.")}
      actions={available && (
        <Tooltip content={lockTip ?? t("Save the cut as it is now")} disabled={!lockTip && canWrite}>
          <span className="inline-flex">
            <Button size="sm" variant="outline" icon={<Save className="size-3.5" />} disabled={!canWrite} onClick={() => setSaveOpen(true)}>{t("Save version")}</Button>
          </span>
        </Tooltip>
      )}>
      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
      ) : isError ? (
        <Quiet>{t("Couldn't load the versions.")} <button type="button" className="font-medium text-accent-ink hover:underline" onClick={() => void refetch()}>{t("Retry")}</button></Quiet>
      ) : !available ? (
        <Quiet>{t("This server doesn't keep cut versions yet.")}</Quiet>
      ) : !versions.length ? (
        <Quiet>{t("No versions yet. Check in, or press Save version, to keep the cut as it is now.")}</Quiet>
      ) : (
        <>
          <ol className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {list.map((v, i) => {
              const from = v.restored_from ? byId.get(v.restored_from) : undefined;
              return (
                <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 hover:bg-hover/50">
                  <span className={i === 0 ? "mono grid h-7 min-w-10 place-items-center rounded-md border border-accent/35 bg-accent/12 px-1.5 text-xs font-semibold text-accent-ink"
                    : "mono grid h-7 min-w-10 place-items-center rounded-md border border-line bg-raised px-1.5 text-xs font-semibold text-mute"}>v{v.number}</span>
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="truncate text-sm" title={v.note}>{v.note || <span className="text-dim">{t("No note")}</span>}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-dim">
                      {v.created_by && <span className="inline-flex items-center gap-1"><Avatar name={v.created_by.name} size={14} />{v.created_by.name}</span>}
                      <span title={fmtDateTime(v.created_at)}>{agoT(v.created_at)}</span>
                      {v.client && <span className="mono uppercase">{v.client}</span>}
                      {v.restored_from && <Badge tone="info"><GitCommitVertical className="size-3" />{t("restored from v{n}", { n: from?.number ?? "?" })}</Badge>}
                    </p>
                  </div>
                  <span className="mono shrink-0 text-2xs tabular-nums text-mute" title={t("Shots in the cut / all shots · length")}>
                    {v.stats ? `${v.stats.included}/${v.stats.shots} · ${secs(v.stats.duration_s)}` : ""}
                  </span>
                  {canWrite && i > 0 && (
                    <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setRestoring(v)}>{t("Restore")}</Button>
                  )}
                  {i === 0 && <Badge tone="accent">{t("latest")}</Badge>}
                </li>
              );
            })}
          </ol>
          {versions.length > SHOWN && (
            <button type="button" onClick={() => setAll((a) => !a)} className="mt-2 text-xs font-medium text-accent-ink hover:underline">
              {all ? t("Show fewer") : t("Show all {n}", { n: versions.length })}
            </button>
          )}
        </>
      )}

      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title={t("Save a version")}
        footer={<>
          <Button variant="ghost" onClick={() => setSaveOpen(false)}>{t("Cancel")}</Button>
          <Button variant="primary" loading={busy} disabled={!note.trim()} onClick={save}>{t("Save version")}</Button>
        </>}>
        <Field label={t("Note")} hint={t("A few words so the team can find this version again.")}>
          <Textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={t("e.g. Director's cut before notes")} />
        </Field>
      </Modal>
      <ConfirmDialog open={!!restoring} onClose={() => setRestoring(null)} busy={busy} onConfirm={restore} danger={false} icon={<RotateCcw className="size-4" />}
        title={t("Restore v{n}?", { n: restoring?.number ?? "" })} confirmLabel={t("Restore v{n}", { n: restoring?.number ?? "" })}>
        <p>{t("The current cut is saved first as a safety copy (\"Before restoring v{n}\"), so nothing is lost. Then the order, trims, effects, takes, layers, mix and music of v{n} are written back.", { n: restoring?.number ?? "" })}</p>
        <p className="mt-2 text-xs text-dim">{t("Shots deleted since then are skipped.")}</p>
      </ConfirmDialog>
    </SectionCard>
  );
}
