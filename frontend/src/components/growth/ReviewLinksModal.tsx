import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Ban, Check, Clock, ExternalLink, Link2, MessageSquareOff, MessageSquareText, Plus, Share2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import "../../styles/console.css";
import { api } from "../../lib/api";
import { LANG_NAMES, secs } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useReviewLinks, useSettings } from "../../lib/queries";
import type { ExportRow, ReviewLinkRow } from "../../lib/types";
import { Badge, Button, Field, Input, Modal, Select, Skeleton, Toggle } from "../ui";
import { agoT, CopyButton, fmtDate, listItem, writeClipboard } from "./common";

const EXPIRY = ["1", "3", "7", "14", "30", "never"] as const;

export function linkState(r: ReviewLinkRow): "active" | "expired" | "revoked" {
  if (r.revoked) return "revoked";
  if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) return "expired";
  return "active";
}

function LinkCard({ r, flash, canEdit, revoking, onRevoke }: { r: ReviewLinkRow; flash: boolean; canEdit: boolean; revoking: boolean; onRevoke: () => void }) {
  const t = useT();
  const st = linkState(r);
  const [confirm, setConfirm] = useState(false);
  return (
    <motion.li layout="position" {...listItem}
      className={clsx("cx-block relative p-3 transition-shadow duration-500", st !== "active" && "opacity-80", flash && "!border-ok/50 ring-2 ring-ok/25")}>
      <AnimatePresence>
        {flash && (
          <motion.span initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
            className="pointer-events-none absolute -top-2 right-3 inline-flex items-center gap-1 rounded-md bg-ok px-2 py-0.5 text-2xs font-semibold text-black shadow">
            <Check className="size-3" strokeWidth={3} />{t("New link copied")}
          </motion.span>
        )}
      </AnimatePresence>
      <div className="flex flex-wrap items-center gap-2">
        <span className={clsx("grid size-7 shrink-0 place-items-center rounded-lg border", st === "active" ? "border-ok/30 bg-ok/10 text-ok" : "border-line bg-raised text-dim")}><Link2 className="size-3.5" /></span>
        <span className={clsx("min-w-0 flex-1 truncate text-sm font-medium", st !== "active" && "text-mute")}>{r.label || t("Untitled link")}</span>
        <Badge tone={st === "active" ? "ok" : st === "expired" ? "warn" : "bad"} dot>
          {st === "active" ? t("Active") : st === "expired" ? t("Expired") : t("Revoked")}
        </Badge>
        <span title={r.allow_comments ? t("Comments allowed") : t("View only")} className={r.allow_comments ? "text-mute" : "text-dim"}>
          {r.allow_comments ? <MessageSquareText className="size-4" /> : <MessageSquareOff className="size-4" />}
        </span>
      </div>

      <div className="mt-2.5 flex items-center gap-1.5">
        <input readOnly value={r.url} aria-label={t("Link")} onFocus={(e) => e.currentTarget.select()}
          className={clsx("h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-2.5 font-mono text-2xs outline-none transition-colors focus:border-accent/60 max-sm:h-10", st === "active" ? "text-mute focus:text-ink" : "text-dim line-through")} />
        {st === "active" && <CopyButton size="sm" text={r.url} what={t("Link")} label={t("Copy link")} />}
        {st === "active" && (
          <a href={r.url} target="_blank" rel="noreferrer" aria-label={t("Open")} title={t("Open")}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line text-mute transition-colors hover:bg-hover hover:text-ink max-sm:size-10">
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-mute">
        <span>{t("Created {when}", { when: agoT(r.created_at) })}</span>
        <span className="mono inline-flex items-center gap-1 text-2xs text-dim"><Clock className="size-3" />
          {r.expires_at ? (st === "expired" ? t("expired {date}", { date: fmtDate(r.expires_at) }) : t("expires {date}", { date: fmtDate(r.expires_at) })) : t("never expires")}
        </span>
        {canEdit && st === "active" && (
          <span className="ml-auto flex items-center gap-1.5">
            <AnimatePresence mode="wait" initial={false}>
              {confirm ? (
                <motion.span key="c" initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 6 }} transition={{ duration: 0.12 }} className="flex flex-wrap items-center justify-end gap-1.5">
                  <span className="text-warn">{t("Revoke this link? Anyone using it will lose access straight away.")}</span>
                  <Button size="sm" variant="danger" className="max-sm:h-10" loading={revoking} onClick={onRevoke}>{t("Yes, revoke")}</Button>
                  <Button size="sm" variant="ghost" className="max-sm:h-10" onClick={() => setConfirm(false)}>{t("Cancel")}</Button>
                </motion.span>
              ) : (
                <motion.span key="r" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
                  <Button size="sm" variant="ghost" className="max-sm:h-10" icon={<Ban className="size-3.5" />} onClick={() => setConfirm(true)}>{t("Revoke")}</Button>
                </motion.span>
              )}
            </AnimatePresence>
          </span>
        )}
      </div>
    </motion.li>
  );
}

export default function ReviewLinksModal({ x, onClose, pid, canEdit }: { x: ExportRow | null; onClose: () => void; pid: number; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const xid = x?.id ?? null;
  const { data: links, isLoading } = useReviewLinks(xid);
  const { data: settings } = useSettings();
  const [label, setLabel] = useState("");
  const [comments, setComments] = useState(true);
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]>("14");
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["review-links", xid] });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!xid) return;
    setBusy(true);
    try {
      const r = await api.post<ReviewLinkRow>(`/api/exports/${xid}/review-links`, {
        label: label.trim(), allow_comments: comments, expires_days: expiry === "never" ? null : Number(expiry),
      });
      await refresh();
      setLabel("");
      if (await writeClipboard(r.url)) {
        setJustCreated(r.token);
        window.setTimeout(() => setJustCreated(null), 2400);
        toast.success(t("Review link created and copied"), { description: r.url });
      } else {
        toast.success(t("Review link created"), { description: r.url });
      }
    } catch {
      /* toasted by api */
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (r: ReviewLinkRow) => {
    setRevoking(r.token);
    try {
      await api.del(`/api/review-links/${r.token}`);
      await refresh();
      toast.success(t("Link revoked"));
    } catch {
      /* toasted */
    } finally {
      setRevoking(null);
    }
  };

  const rows = [...(links ?? [])].sort((a, b) => {
    const order = { active: 0, expired: 1, revoked: 2 };
    return order[linkState(a)] - order[linkState(b)] || b.created_at.localeCompare(a.created_at);
  });
  const activeCount = rows.filter((r) => linkState(r) === "active").length;

  return (
    <Modal
      open={!!x}
      onClose={onClose}
      size="lg"
      title={<span className="flex items-center gap-2"><span className="grid size-7 place-items-center rounded-lg border border-accent/25 bg-accent/10 text-accent-ink"><Share2 className="size-4" /></span>{t("Client review links")}</span>}
      footer={<>
        {x && (
          <Link to={`/p/${pid}/review?export=${x.id}`} onClick={onClose}
            className="mr-auto inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm text-mute transition-colors hover:bg-hover hover:text-ink">
            <MessageSquareText className="size-4" />{t("Open team review")}
          </Link>
        )}
        <Button variant="ghost" onClick={onClose}>{t("Done")}</Button>
      </>}
    >
      {x && (
        <div className="space-y-5">
          <div className="flex items-start gap-3">
            <span className="cx-monitor grid h-14 w-10 shrink-0 place-items-center">
              {x.thumb_url ? <img src={x.thumb_url} alt="" className="size-full object-contain" /> : <Share2 className="size-4 text-dim" />}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">{x.kind === "final" ? t("Final") : t("Animatic")} · {t(LANG_NAMES[x.language] ?? x.language)}</p>
              <p className="mono mt-0.5 text-2xs text-dim">{t(settings?.catalog.export_presets[x.preset]?.label ?? x.preset)} · {secs(x.duration_s)} · #{x.id}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-mute">
                {t("Share this render with people outside the team. They can watch it — and leave timecoded comments if you allow — without an account.")}
              </p>
            </div>
          </div>

          {canEdit && (
            <form onSubmit={create} className="cx-block space-y-3.5 p-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_150px]">
                <Field label={t("Label (optional)")}>
                  <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("e.g. Client — first cut")} maxLength={160} />
                </Field>
                <Field label={t("Expires")}>
                  <Select value={expiry} onChange={(e) => setExpiry(e.target.value as (typeof EXPIRY)[number])}>
                    {EXPIRY.map((d) => (
                      <option key={d} value={d}>{d === "never" ? t("Never") : d === "1" ? t("In 1 day") : t("In {n} days", { n: d })}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Toggle checked={comments} onChange={setComments} label={<span className="text-sm">{t("Allow comments")}</span>} />
                <Button type="submit" variant="primary" loading={busy} icon={<Plus className="size-4" />}>{t("Create link")}</Button>
              </div>
            </form>
          )}

          <div>
            <p className="eyebrow mb-2 flex items-center gap-2">
              {t("Links for this render")}
              {rows.length > 0 && <span className="mono rounded-md bg-raised px-1.5 py-px text-2xs text-dim">{activeCount}/{rows.length}</span>}
            </p>
            {isLoading ? (
              <div className="space-y-2" aria-hidden><Skeleton className="h-24 rounded-xl" /><Skeleton className="h-24 rounded-xl" /></div>
            ) : !rows.length ? (
              <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
                <span className="mx-auto mb-2 grid size-10 place-items-center rounded-lg border border-line bg-raised text-mute"><Link2 className="size-5" /></span>
                <p className="text-sm font-medium">{t("No links yet.")}</p>
                {canEdit && <p className="mt-0.5 text-xs text-mute">{t("Create one above and send it to your client.")}</p>}
              </div>
            ) : (
              <ul className="space-y-2.5">
                <AnimatePresence initial={false}>
                  {rows.map((r) => (
                    <LinkCard key={r.token} r={r} flash={justCreated === r.token} canEdit={canEdit} revoking={revoking === r.token} onRevoke={() => revoke(r)} />
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
