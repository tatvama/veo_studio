import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Boxes, RefreshCw, Route } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { announce } from "../../components/Generate";
import { useIsAdmin } from "../../components/hub/util";
import { Button, Page, PageHeader, Progress, Tabs, Tooltip } from "../../components/ui";
import { api } from "../../lib/api";
import { tr, useT } from "../../lib/i18n";
import { useJobs } from "../../lib/queries";
import type { SubmitResult } from "../../lib/types";
import { useCatalogFilters, useCatalogMeta } from "./catalogData";
import Catalog from "./Catalog";
import HubKpis from "./HubKpis";
import PolicyEditor from "./PolicyEditor";

import "../../styles/console.css";
import "../../styles/models.css";

type TabKey = "catalog" | "policy";
const SYNC_TIMEOUT_MS = 6 * 60_000;

export default function ModelHub() {
  const t = useT();
  const qc = useQueryClient();
  const admin = useIsAdmin();
  const ctl = useCatalogFilters();
  const [tab, setTab] = useState<TabKey>("catalog");
  const [seenPolicy, setSeenPolicy] = useState(false);
  useEffect(() => { if (tab === "policy") setSeenPolicy(true); }, [tab]);
  const [sync, setSync] = useState<{ jobIds: number[]; since: string; started: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const { data: meta, isError: metaError, refetch: refetchMeta } = useCatalogMeta(sync ? 4000 : false);
  const { data: active } = useJobs(undefined, "active");
  const doneRef = useRef(false);

  // a sync is finished when last_sync.at moves, or its job leaves the active list, or it times out
  useEffect(() => {
    if (!sync) return;
    const at = meta?.last_sync?.at ?? "";
    const stillRunning = sync.jobIds.length > 0 && (active ?? []).some((j) => sync.jobIds.includes(j.id));
    const moved = !!at && at !== sync.since;
    const timedOut = Date.now() - sync.started > SYNC_TIMEOUT_MS;
    const jobGone = sync.jobIds.length > 0 && !!active && !stillRunning && Date.now() - sync.started > 3000;
    if ((moved || jobGone || timedOut) && !doneRef.current) {
      doneRef.current = true;
      setSync(null);
      qc.invalidateQueries({ queryKey: ["models"] });
      if (moved) {
        const n = meta?.last_sync?.new_count ?? 0;
        toast.success(n ? tr("Sync finished — {n} new models", { n }) : tr("Sync finished — no new models"));
      }
    }
  }, [sync, meta, active, qc]);

  const runSync = async (full: boolean) => {
    setStarting(true);
    try {
      const res = await api.post<SubmitResult>(`/api/models/sync${full ? "?full=true" : ""}`);
      announce(res, full ? tr("Full model re-map") : tr("Model Hub sync"));
      qc.invalidateQueries({ queryKey: ["jobs"] });
      doneRef.current = false;
      setSync({ jobIds: (res.jobs ?? []).map((j) => j.id), since: meta?.last_sync?.at ?? "", started: Date.now() });
    } catch {
      /* api() showed the error */
    } finally {
      setStarting(false);
    }
  };

  const counts = meta?.counts ?? {};
  const total = (counts.enabled ?? 0) + (counts.new ?? 0) + (counts.disabled ?? 0);

  // KPI cells double as shortcuts into the catalog
  const showCatalog = (status: string) => {
    setTab("catalog");
    ctl.update({ status, task: "", provider: "", mode: "", q: "" });
    window.setTimeout(() => document.getElementById("hub-catalog")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };

  return (
    <Page width="wide">
      <PageHeader
        icon={<Boxes className="size-5" />}
        title={t("Model Hub")}
        subtitle={t("Every engine the studio can use — video, avatars, lip-sync, images and more. New releases appear automatically after a sync.")}
        actions={admin ? (
          <>
            <Tooltip content={t("Re-read every model's input schema (slower)")}>
              <Button variant="ghost" size="sm" disabled={!!sync || starting} onClick={() => runSync(true)}>{t("Full re-map")}</Button>
            </Tooltip>
            <Button variant="primary" loading={starting} disabled={!!sync}
              icon={<RefreshCw className={clsx("size-4", sync && "animate-spin")} />} onClick={() => runSync(false)}>
              {sync ? t("Syncing…") : t("Sync now")}
            </Button>
          </>
        ) : undefined}
      />

      <AnimatePresence initial={false}>
        {sync && (
          <motion.div key="sync" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22 }} className="-mt-3 mb-5 overflow-hidden" role="status">
            <div className="cx-block px-4 py-3" data-tone="accent">
              <p className="mb-2 flex items-center gap-2 text-sm"><RefreshCw className="size-3.5 animate-spin text-accent-ink" />{t("Checking the providers for new engines and prices…")}</p>
              <Progress indeterminate size="sm" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <HubKpis meta={meta} error={metaError} onRetry={() => void refetchMeta()} onShow={showCatalog} />

      <div id="hub-catalog" className="mb-5 scroll-mt-4">
        <Tabs value={tab} onChange={setTab} tabs={[
          { value: "catalog", label: <span className="flex items-center gap-1.5"><Boxes className="size-4" />{t("Catalog")}</span>, count: meta ? total : undefined },
          { value: "policy", label: <span className="flex items-center gap-1.5"><Route className="size-4" />{t("Routing policy")}</span> },
        ]} />
      </div>

      {/* both tabs stay mounted once opened, so unsaved routing edits survive a tab switch */}
      <TabPane active={tab === "catalog"}><Catalog admin={admin} ctl={ctl} active={tab === "catalog"} /></TabPane>
      {seenPolicy && <TabPane active={tab === "policy"}><PolicyEditor admin={admin} /></TabPane>}
    </Page>
  );
}

function TabPane({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <motion.div className={active ? "block" : "hidden"} initial={false}
      animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }} transition={{ duration: 0.2, ease: "easeOut" }}>
      {children}
    </motion.div>
  );
}
