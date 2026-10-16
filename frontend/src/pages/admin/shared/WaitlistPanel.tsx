import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ListChecks, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { agoT, fmtDateTime } from "../../../components/growth/common";
import { Alert, Button, Empty, IconButton, Panel, Skeleton } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";

interface Entry { id: number; email: string; phone: string; phone_display: string; created_at: string }
interface WaitlistData { total: number; entries: Entry[] }

const SHOWN = 200;

/** Everyone who asked for an invite on the public landing page (GET /api/admin/waitlist). Admins only. */
export function WaitlistPanel() {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["waitlist"],
    queryFn: () => api.get<WaitlistData>(`/api/admin/waitlist?limit=${SHOWN}`, { silent: true }),
    staleTime: 30_000,
  });
  const [removing, setRemoving] = useState<Entry | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.del(`/api/admin/waitlist/${removing.id}`);
      toast.success(t("Removed from the waitlist"));
      setRemoving(null);
      await qc.invalidateQueries({ queryKey: ["waitlist"] });
    } finally {
      setBusy(false);
    }
  };

  const total = data?.total ?? 0;
  return (
    <>
      <Panel flush index={3} className="mt-4" bodyClassName="overflow-hidden rounded-b-xl" icon={<ListChecks />} eyebrow={t("Waitlist")}
        title={data ? t("{n} joined from the landing page", { n: total }) : t("People who asked for an invite")}
        actions={total > 0 && (
          <a href="/api/admin/waitlist.csv" download
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 text-xs font-medium text-ink transition-colors hover:border-dim/40 hover:bg-hover">
            <Download className="size-3.5" />{t("Download CSV")}
          </a>
        )}>
        {isLoading ? (
          <div aria-busy="true" className="mt-3 space-y-2 border-t border-line p-4">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
        ) : isError ? (
          <div className="mt-3 border-t border-line p-4">
            <Alert tone="bad" title={t("Couldn't load the waitlist")} action={<Button size="sm" variant="outline" onClick={() => void refetch()}>{t("Try again")}</Button>}>
              {t("Check your connection and try again.")}
            </Alert>
          </div>
        ) : !data?.entries.length ? (
          <div className="mt-3 border-t border-line p-4">
            <Empty icon={<ListChecks className="size-7" />} title={t("No one has joined yet")}
              sub={t("People who join from the home page (the landing page signed-out visitors see) appear here, newest first.")} />
          </div>
        ) : (
          <div className="mt-3 border-t border-line">
            <div className="cx-scroll max-h-[26rem]">
              <table className="cx-table">
                <thead><tr><th>{t("Joined")}</th><th>{t("Email")}</th><th>{t("Mobile")}</th><th className="w-12"><span className="sr-only">{t("Remove")}</span></th></tr></thead>
                <tbody>
                  {data.entries.map((e) => (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap text-mute" title={fmtDateTime(e.created_at)}>{agoT(e.created_at)}</td>
                      <td className="cx-mono">{e.email}</td>
                      <td className="cx-mono whitespace-nowrap">{e.phone_display}</td>
                      <td className="text-right">
                        <IconButton title={t("Remove {email}", { email: e.email })} onClick={() => setRemoving(e)} className="size-7 hover:text-bad"><Trash2 className="size-3.5" /></IconButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {total > data.entries.length && (
              <p className="border-t border-line px-4 py-2.5 text-2xs text-dim">{t("Showing the newest {shown} of {total}. The CSV has everyone.", { shown: data.entries.length, total })}</p>
            )}
          </div>
        )}
      </Panel>

      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} busy={busy} title={t("Remove from the waitlist?")}
        confirmLabel={t("Remove")} icon={<Trash2 className="size-4" />} onConfirm={remove}>
        {removing && t("{email} and their number are deleted for good. Do this when someone asks to be taken off the list.", { email: removing.email })}
      </ConfirmDialog>
    </>
  );
}
