/** Toolbar "Versions": save a named snapshot, and restore an earlier one (after a confirm). */
import { useQueryClient } from "@tanstack/react-query";
import { History, RotateCcw } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button, IconButton, Popover, Skeleton } from "../../../../components/ui";
import { cn } from "../../../../lib/cn";
import { ago } from "../../../../lib/format";
import { useT } from "../../../../lib/i18n";
import { designKeys, designsApi, useVersions } from "../../api";
import { useEditor } from "../../store";

export function VersionsMenu({ designId, saveNow, canEdit }: { designId: number; saveNow: (force?: boolean) => Promise<boolean>; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"save" | number | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const versions = useVersions(open ? designId : 0);

  const saveVersion = async () => {
    setBusy("save");
    try {
      if (!(await saveNow())) { toast.error(t("Save your changes first, then try again.")); return; }
      await designsApi.saveVersion(designId, note.trim());
      setNote("");
      await qc.invalidateQueries({ queryKey: ["design-versions", designId] });
      toast.success(t("Version saved"));
    } catch { /* the API layer showed the error */ } finally { setBusy(null); }
  };

  const restore = async (vid: number) => {
    setBusy(vid);
    try {
      await saveNow();
      const d = await designsApi.restore(designId, vid);
      useEditor.getState().load(d);
      qc.setQueryData(designKeys.one(designId), d);
      void qc.invalidateQueries({ queryKey: ["design-versions", designId] });
      void qc.invalidateQueries({ queryKey: ["designs"] });
      toast.success(t("Version restored"), { description: t("Your previous state was kept as a version too.") });
      setOpen(false);
    } catch { /* shown by the API layer */ } finally { setBusy(null); setConfirm(null); }
  };

  return (
    <>
      <span ref={ref} className="inline-flex">
        <IconButton title={t("Versions")} onClick={() => setOpen((v) => !v)} aria-expanded={open} active={open}>
          <History className="size-4" />
        </IconButton>
      </span>
      <Popover open={open} onClose={() => { setOpen(false); setConfirm(null); }} anchor={ref} placement="bottom-end" width={340} className="overflow-hidden p-0">
        <div className="border-b border-line px-3.5 py-3">
          <span className="eyebrow">{t("Versions")}</span>
          <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (canEdit) void saveVersion(); }}>
            <input
              value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={t("Note, e.g. Sent to client")} disabled={!canEdit}
              className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-panel px-2.5 text-sm placeholder:text-dim focus:border-accent/70 focus:outline-none"
            />
            <Button type="submit" size="sm" variant="primary" loading={busy === "save"} disabled={!canEdit}>{t("Save version")}</Button>
          </form>
        </div>
        <div className="max-h-[min(360px,50vh)] overflow-y-auto p-1.5">
          {versions.isLoading && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="m-1 h-12" />)}
          {versions.data && !versions.data.length && (
            <p className="px-3 py-6 text-center text-sm text-mute">{t("No versions yet. Save one before big changes so you can come back.")}</p>
          )}
          {versions.data?.map((v) => (
            <div key={v.id} className={cn("rounded-lg px-2 py-1.5 transition-colors hover:bg-hover", confirm === v.id && "bg-hover")}>
              <div className="flex items-center gap-2.5">
                <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-raised">
                  {v.thumb_url ? <img src={v.thumb_url} alt="" className="max-h-full max-w-full object-contain" loading="lazy" /> : <History className="size-4 text-dim" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{v.note || t("Untitled version")}</p>
                  <p className="mono text-2xs text-dim">{ago(v.created_at)} · {v.width}×{v.height}</p>
                </div>
                {canEdit && confirm !== v.id && (
                  <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setConfirm(v.id)}>{t("Restore")}</Button>
                )}
              </div>
              {confirm === v.id && (
                <div className="mt-1.5 flex items-center justify-between gap-2 rounded-md border border-warn/30 bg-warn/8 px-2 py-1.5">
                  <span className="text-2xs leading-snug text-mute">{t("Replace the design with this version?")}</span>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>{t("Cancel")}</Button>
                    <Button size="sm" variant="primary" loading={busy === v.id} onClick={() => void restore(v.id)}>{t("Restore")}</Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}
