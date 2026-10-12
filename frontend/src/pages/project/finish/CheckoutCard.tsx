import { useQueryClient } from "@tanstack/react-query";
import { Laptop, Lock, LockOpen, LogIn, LogOut, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { agoT } from "../../../components/growth/common";
import { SectionCard } from "../../../components/room/kit";
import { Avatar, Badge, Button, Field, Modal, Skeleton, Textarea } from "../../../components/ui";
import { isDesktop } from "../../../lib/desktop";
import { checkin, checkout, releaseCheckout, useCheckout } from "../../../lib/finish";
import { useT } from "../../../lib/i18n";
import { ConfirmDialog } from "../../admin/shared/ConfirmDialog";
import { clientLabel, sinceLabel } from "./CutGuard";
import { Quiet } from "./parts";

/** Who holds the cut, and the buttons to take it, hand it back or (producers) free it. */
export function CheckoutCard({ eid, canEdit, canProduce, className }: { eid: number; canEdit: boolean; canProduce: boolean; className?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { lock, isLoading, available, isError, refetch } = useCheckout(eid);
  const [busy, setBusy] = useState<string | null>(null);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [note, setNote] = useState("");
  const [forceOpen, setForceOpen] = useState(false);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try { await fn(); } finally { setBusy(null); }
  };
  const take = () => run("out", async () => {
    const l = await checkout(qc, eid);
    if (l) toast.success(t("Cut checked out — it's yours until you check in"));
  });
  const giveBack = () => run("in", async () => {
    const v = await checkin(qc, eid, note);
    if (v !== undefined) {
      toast.success(v ? t("Checked in as v{n}", { n: v }) : t("Checked in"));
      setCheckinOpen(false);
      setNote("");
    }
  });
  const release = () => run("release", async () => {
    if (await releaseCheckout(qc, eid)) toast.success(t("Cut released"));
  });
  const force = () => run("force", async () => {
    if (await releaseCheckout(qc, eid)) { toast.success(t("Checkout released")); setForceOpen(false); }
  });

  return (
    <SectionCard className={className} icon={lock ? <Lock /> : <LockOpen />} title={t("Checkout")}
      description={t("While checked out, the web timeline is read-only for everyone else.")}
      actions={lock ? <Badge tone={lock.mine ? "accent" : "warn"} dot>{lock.mine ? t("You have it") : t("Checked out")}</Badge> : available ? <Badge tone="ok" dot>{t("Free")}</Badge> : undefined}>
      {isLoading ? (
        <div className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-8 w-40" /></div>
      ) : isError ? (
        <Quiet>{t("Couldn't read the checkout.")} <button type="button" className="font-medium text-accent-ink hover:underline" onClick={() => void refetch()}>{t("Retry")}</button></Quiet>
      ) : !available ? (
        <Quiet>{t("This server doesn't support checkouts yet. Update the studio server to lock the cut while you finish it.")}</Quiet>
      ) : (
        <div className="space-y-4">
          {lock ? (
            <div className="flex items-start gap-3 rounded-xl border border-line bg-raised/40 p-3">
              <Avatar name={lock.user?.name ?? "?"} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{lock.mine ? t("You") : lock.user?.name ?? t("Someone")}
                  {!lock.mine && lock.user?.role && <span className="ml-2 text-2xs font-normal text-dim">{lock.user.role}</span>}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-mute">
                  <span className="inline-flex items-center gap-1"><Laptop className="size-3.5" />{t("on {client}", { client: t(clientLabel(lock.client)) })}</span>
                  {lock.machine && <span className="mono text-2xs text-dim">{lock.machine}</span>}
                </p>
                <p className="mono mt-1 text-2xs text-dim">
                  {t("since {since}", { since: sinceLabel(lock.acquired_at) })}
                  {lock.heartbeat_at && <> · {t("last seen {ago}", { ago: agoT(lock.heartbeat_at) })}</>}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-mute">{t("Nobody has the cut checked out. Check it out before a long finishing session so nobody changes it under you.")}</p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {!lock && canEdit && (
              <Button variant="primary" icon={<LogIn className="size-4" />} loading={busy === "out"} onClick={take}>
                {isDesktop ? t("Check out to this computer") : t("Check out")}
              </Button>
            )}
            {lock?.mine && (
              <>
                <Button variant="primary" icon={<LogOut className="size-4" />} onClick={() => setCheckinOpen(true)}>{t("Check in…")}</Button>
                <Button variant="ghost" loading={busy === "release"} onClick={release}>{t("Release")}</Button>
              </>
            )}
            {lock && !lock.mine && canProduce && (
              <Button variant="danger" icon={<ShieldAlert className="size-4" />} onClick={() => setForceOpen(true)}>{t("Force release")}</Button>
            )}
            {lock && !lock.mine && !canProduce && <p className="text-xs text-dim">{t("Ask them to check in, or a producer to release it.")}</p>}
            {!lock && !canEdit && <p className="text-xs text-dim">{t("Creators and producers can check the cut out.")}</p>}
          </div>
          {lock?.mine && !isDesktop && <p className="text-2xs text-dim">{t("The lock doesn't expire: check in or release it when you're done.")}</p>}
        </div>
      )}

      <Modal open={checkinOpen} onClose={() => setCheckinOpen(false)} title={t("Check in the cut")}
        footer={<>
          <Button variant="ghost" onClick={() => setCheckinOpen(false)}>{t("Cancel")}</Button>
          <Button variant="primary" loading={busy === "in"} onClick={giveBack}>{t("Save version and check in")}</Button>
        </>}>
        <div className="space-y-3">
          <p className="text-sm text-mute">{t("Checking in saves the cut as a new version and frees it for everyone.")}</p>
          <Field label={t("What changed? (optional)")}>
            <Textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={t("e.g. Tightened the opening, new music level")} />
          </Field>
        </div>
      </Modal>
      <ConfirmDialog open={forceOpen} onClose={() => setForceOpen(false)} busy={busy === "force"} onConfirm={force}
        title={t("Force release the cut?")} confirmLabel={t("Force release")}>
        {t("{name} keeps what is already saved on the server, but edits they make offline won't sync until they check the cut out again. No version is saved.", { name: lock?.user?.name ?? t("The editor") })}
      </ConfirmDialog>
    </SectionCard>
  );
}
