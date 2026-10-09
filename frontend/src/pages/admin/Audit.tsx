import { Lock, ScrollText, ShieldCheck } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Empty, Page, PageHeader, Segmented } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { useConsentRows } from "../../components/room/util";
import { useAuthStatus } from "../../lib/queries";
import { ROLE_RANK } from "../../lib/types";
import { AuditLog } from "./audit/AuditLog";
import { Consents } from "./audit/Consents";

export default function AuditPage() {
  const t = useT();
  const { data: auth } = useAuthStatus();
  const role = auth?.user?.role ?? "viewer";
  const isAdmin = role === "admin";
  const canConsents = ROLE_RANK[role] >= ROLE_RANK.producer;
  const [tab, setTab] = useState<"audit" | "consents">(isAdmin ? "audit" : "consents");
  const { data: consents } = useConsentRows(canConsents);  // producer-only: don't even ask otherwise

  if (!canConsents) {
    return (
      <Page width="narrow">
        <Empty icon={<Lock className="size-8" />} title={t("Admins only")} sub={t("The audit log and consent records are only visible to admins and producers.")} />
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader
        icon={<ShieldCheck className="size-5" />}
        title={t("Audit & consent")}
        subtitle={t("Who changed what, from where — and the signed consents that cover cloned voices, faces and music.")}
        actions={isAdmin ? (
          <Segmented value={tab} onChange={setTab} aria-label={t("View")} options={[
            { value: "audit", label: <span className="flex items-center gap-1.5"><ScrollText className="size-4" aria-hidden />{t("Audit log")}</span> },
            {
              value: "consents",
              label: <span className="flex items-center gap-1.5"><ShieldCheck className="size-4" aria-hidden />{t("Consents")}{consents?.length !== undefined && <span className="mono text-2xs text-dim">{consents.length}</span>}</span>,
            },
          ]} />
        ) : undefined}
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
          {tab === "audit" && isAdmin ? <AuditLog /> : <Consents canAdd={canConsents} />}
        </motion.div>
      </AnimatePresence>
    </Page>
  );
}
