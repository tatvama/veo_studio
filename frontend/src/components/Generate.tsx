import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { CheckCircle2, Coins, CornerDownLeft } from "lucide-react";
import { motion } from "motion/react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { usd } from "../lib/format";
import { tr, useT } from "../lib/i18n";
import type { Estimate, SubmitResult } from "../lib/types";
import { AnimatedNumber, Alert, Button, Modal } from "./ui";

interface Pending { eid: number; body: Record<string, any>; title: string; est: Estimate }

interface Ctx {
  /** Estimate → (cost dialog if it costs money) → generate. */
  generate: (eid: number, body: Record<string, any>, title: string) => Promise<void>;
  /** Fire a single-item endpoint that returns a SubmitResult and toast the outcome. */
  submit: (fn: () => Promise<SubmitResult>, what: string) => Promise<SubmitResult | undefined>;
}

const GenerateCtx = createContext<Ctx | null>(null);

export function announce(res: SubmitResult, what: string) {
  if (!res || res.status === "nothing_to_do") return toast.info(tr("{what}: nothing to do", { what }));
  const n = res.jobs?.length ?? 0;
  const cost = res.total_usd ? ` · ${usd(res.total_usd)}` : "";
  if (res.status === "awaiting_approval") toast.warning(tr("{what}: sent for approval", { what }) + cost, { description: res.reason });
  else if (res.status === "proposed") toast.message(tr("{what}: proposed{cost} — approve it in the Director panel", { what, cost }));
  else {
    const queued = n === 1 ? tr("{what}: 1 job queued", { what }) : tr("{what}: {n} jobs queued", { what, n });
    const skipped = res.skipped ? ` ${tr("({n} already running)", { n: res.skipped })}` : "";
    toast.success(queued + cost + skipped);
  }
}

export function GenerateProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const qc = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const fire = useCallback(async (eid: number, body: Record<string, any>, title: string) => {
    const res = await api.post<SubmitResult>(`/api/episodes/${eid}/generate`, body);
    announce(res, title);
    qc.invalidateQueries({ queryKey: ["jobs"] });
    qc.invalidateQueries({ queryKey: ["episode"] });
  }, [qc]);

  const generate = useCallback(async (eid: number, body: Record<string, any>, title: string) => {
    const est = await api.post<Estimate>(`/api/episodes/${eid}/estimate`, body);
    if (est.count === 0) {
      toast.info(tr("{what}: nothing to do", { what: title }));
      return;
    }
    if (est.total_usd === 0 && est.budget.ok) {
      await fire(eid, body, title);
      return;
    }
    setPending({ eid, body, title, est });
  }, [fire]);

  const submit = useCallback(async (fn: () => Promise<SubmitResult>, what: string) => {
    try {
      const r = await fn();
      announce(r, what);
      qc.invalidateQueries({ queryKey: ["jobs"] });
      return r;
    } catch {
      return undefined;
    }
  }, [qc]);

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await fire(pending.eid, pending.body, pending.title);
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  const est = pending?.est;
  return (
    <GenerateCtx.Provider value={{ generate, submit }}>
      {children}
      <Modal
        open={!!pending}
        onClose={() => setPending(null)}
        title={<span className="flex items-center gap-2"><Coins className="size-4 text-accent-ink" />{pending?.title}</span>}
        footer={<>
          <Button variant="ghost" onClick={() => setPending(null)}>{t("Cancel")}<Key>Esc</Key></Button>
          {/* focus lands here when the dialog opens, so Enter confirms */}
          <Button variant="primary" data-autofocus loading={busy} onClick={confirm}>
            {est?.budget.ok ? t("Generate · {usd}", { usd: usd(est.total_usd) }) : t("Request approval")}
            {!busy && <CornerDownLeft className="size-3.5 opacity-70" />}
          </Button>
        </>}
      >
        {est && <CostBody est={est} />}
      </Modal>
    </GenerateCtx.Provider>
  );
}

function Key({ children }: { children: ReactNode }) {
  return <kbd className="ml-1 hidden rounded bg-current/10 px-1 font-mono text-2xs leading-4 opacity-70 sm:inline">{children}</kbd>;
}

/** Line items, the total, what it does to the team budget and whether it needs approval. */
function CostBody({ est }: { est: Estimate }) {
  const t = useT();
  const shown = est.items.slice(0, 60);
  const more = est.items.slice(60);
  const moreUsd = more.reduce((a, i) => a + i.usd, 0);
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-2xs font-medium uppercase tracking-wide text-dim">{t("Estimated cost")}</p>
          <p className="mt-0.5 text-sm text-mute">{est.count === 1 ? t("1 item") : t("{n} items", { n: est.count })}</p>
        </div>
        <p className="text-3xl font-semibold leading-none tracking-tight tabular-nums">
          <AnimatedNumber value={est.total_usd} format={(n) => usd(n)} duration={0.7} />
        </p>
      </div>

      <div className="max-h-[clamp(7rem,28vh,15rem)] overflow-y-auto rounded-xl border border-line">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-[1] bg-raised text-2xs uppercase tracking-wide text-dim">
            <tr>
              <th scope="col" className="px-3 py-1.5 text-left font-medium">{t("Item")}</th>
              <th scope="col" className="px-3 py-1.5 text-right font-medium">{t("Estimate")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((it, i) => (
              <motion.tr key={i} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16, delay: Math.min(i, 12) * 0.015 }}
                className="border-t border-line/60">
                <td className="max-w-0 truncate px-3 py-1.5 text-mute" title={it.label}>{it.label}</td>
                <td className={clsx("w-24 px-3 py-1.5 text-right tabular-nums", it.usd === 0 && "text-dim")}>{usd(it.usd)}</td>
              </motion.tr>
            ))}
            {more.length > 0 && (
              <tr className="border-t border-line/60 text-xs text-dim">
                <td className="px-3 py-1.5">{t("+{n} more", { n: more.length })}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{usd(moreUsd)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {est.team.cap_usd > 0 && <BudgetBar est={est} />}

      {est.budget.ok ? (
        <p className="flex items-center gap-2 text-sm text-ok"><CheckCircle2 className="size-4" />{t("Within your limits.")}</p>
      ) : est.budget.needs_role ? (
        <Alert tone="warn" title={t("Needs approval")}>
          {est.budget.reason} {t("A {role} will be asked to approve.", { role: est.budget.needs_role })}
        </Alert>
      ) : (
        <Alert tone="bad" title={t("Over your limit")}>{est.budget.reason}</Alert>
      )}

      <p className="text-xs text-dim">{t("Estimates use list prices; the ledger records actual cost per job. Google doesn't charge for clips blocked by safety filters.")}</p>
    </div>
  );
}

/** The team's monthly cap as one bar: what's spent, what's reserved, this batch, and what stays free. */
function BudgetBar({ est }: { est: Estimate }) {
  const t = useT();
  const { cap_usd: cap, spent_usd: spent, reserved_usd: reserved } = est.team;
  const batch = est.total_usd;
  const free = Math.max(0, cap - spent - reserved);
  const over = batch > free + 1e-9;
  const left = Math.max(0, free - batch);
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / cap) * 100))}%`;
  const seg = (v: number, cls: string, delay = 0) => (
    <motion.div className={clsx("h-full first:rounded-l-full last:rounded-r-full", cls)} initial={{ width: 0 }} animate={{ width: pct(v) }}
      transition={{ type: "spring", stiffness: 140, damping: 24, delay }} />
  );
  return (
    <div className="rounded-xl border border-line bg-raised/40 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium">{t("Team budget this month")}</span>
        <span className={clsx("tabular-nums", over ? "font-medium text-bad" : "text-mute")}>
          {over ? t("{usd} over what's left", { usd: usd(batch - free) }) : t("{left} left of {cap} after this", { left: usd(left), cap: usd(cap) })}
        </span>
      </div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-line" role="img"
        aria-label={t("Spent {spent}, reserved {reserved}, this batch {batch} of {cap}", { spent: usd(spent), reserved: usd(reserved), batch: usd(batch), cap: usd(cap) })}>
        {seg(spent, "bg-mute/60")}
        {seg(reserved, "bg-info/70", 0.05)}
        {seg(Math.min(batch, free), over ? "bg-bad" : "bg-accent", 0.1)}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-mute">
        <Legend dot="bg-mute/60" label={t("Spent")} value={usd(spent)} />
        <Legend dot="bg-info/70" label={t("Reserved")} value={usd(reserved)} />
        <Legend dot={over ? "bg-bad" : "bg-accent"} label={t("This batch")} value={usd(batch)} strong />
      </ul>
    </div>
  );
}

function Legend({ dot, label, value, strong }: { dot: string; label: string; value: string; strong?: boolean }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      <span className={clsx("size-2 rounded-full", dot)} />{label}
      <span className={clsx("tabular-nums", strong ? "font-semibold text-ink" : "text-ink")}>{value}</span>
    </li>
  );
}

export function useGenerate() {
  const ctx = useContext(GenerateCtx);
  if (!ctx) throw new Error("useGenerate outside GenerateProvider");
  return ctx;
}
