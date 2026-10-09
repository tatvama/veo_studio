/** Export page side panel: the review links of one finished render at a glance (creating and revoking stay in the modal). */
import { BadgeCheck, Clock, MessageSquareText, Share2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "../../styles/console.css";
import { LANG_SHORT } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useReviewLinks } from "../../lib/queries";
import { Badge, Button, Panel, Select, Skeleton, StatusDot } from "../ui";
import { fmtDate, CopyButton } from "./common";
import type { PresetInfo, RenderRow } from "./ExportCard";
import { linkState } from "./ReviewLinksModal";
import { RoomEmpty } from "../room/kit";

export default function ReviewPanel({ renders, presets, pid, canEdit, onManage, className }: {
  /** Finished renders, newest first. */
  renders: RenderRow[]; presets: Record<string, PresetInfo>; pid: number; canEdit: boolean; onManage: (x: RenderRow) => void; className?: string;
}) {
  const t = useT();
  const nav = useNavigate();
  const [sel, setSel] = useState<number | null>(null);
  const cur = renders.find((r) => r.id === sel) ?? renders.find((r) => r.kind === "final") ?? renders[0] ?? null;
  const { data: links, isLoading } = useReviewLinks(cur?.id ?? null);
  const order = { active: 0, expired: 1, revoked: 2 };
  const rows = [...(links ?? [])].sort((a, b) => order[linkState(a)] - order[linkState(b)] || b.created_at.localeCompare(a.created_at));
  const active = rows.filter((r) => linkState(r) === "active");
  const label = (r: RenderRow) => `#${r.id} · ${r.kind === "final" ? t("Final") : t("Animatic")} · ${LANG_SHORT[r.language] ?? r.language} · ${t(presets[r.preset]?.label ?? r.preset)}`;

  return (
    <Panel className={className} eyebrow={t("Review")} icon={<Share2 />} title={t("Review links")}
      actions={cur ? <span className="mono text-2xs text-dim" title={t("Active links")}>{active.length}/{rows.length}</span> : undefined}>
      {!cur ? (
        <RoomEmpty icon={<Share2 />} title={t("Nothing to review yet")} sub={t("Finish a render to share it with your team and clients.")} />
      ) : (
        <div className="space-y-3">
          <Select value={cur.id} onChange={(e) => setSel(Number(e.target.value))} aria-label={t("Render")} className="!h-8 text-xs max-sm:!h-10">
            {renders.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
          </Select>

          <div className="flex flex-wrap items-center gap-1.5">
            {cur.kind === "final"
              ? (cur.approved_by ? <Badge tone="ok"><BadgeCheck className="size-3" />{t("approved")}</Badge> : <Badge>{t("Not approved yet")}</Badge>)
              : <Badge>{t("Animatic")}</Badge>}
          </div>

          {isLoading ? (
            <div className="space-y-2" aria-hidden><Skeleton className="h-9 rounded-lg" /><Skeleton className="h-9 rounded-lg" /></div>
          ) : rows.length ? (
            <ul className="cx-block divide-y divide-line overflow-hidden">
              {rows.slice(0, 4).map((r) => {
                const st = linkState(r);
                return (
                  <li key={r.token} className="flex items-center gap-2.5 px-3 py-2">
                    <StatusDot tone={st === "active" ? "ok" : st === "expired" ? "warn" : "bad"} />
                    <div className="min-w-0 flex-1">
                      <p className={st === "active" ? "truncate text-xs font-medium" : "truncate text-xs font-medium text-mute"}>{r.label || t("Untitled link")}</p>
                      <p className="mono flex items-center gap-1 truncate text-2xs text-dim">
                        <Clock className="size-3 shrink-0" />
                        {st === "revoked" ? t("Revoked") : st === "expired" ? t("expired {date}", { date: fmtDate(r.expires_at) })
                          : r.expires_at ? t("expires {date}", { date: fmtDate(r.expires_at) }) : t("never expires")}
                      </p>
                    </div>
                    {st === "active" && <CopyButton size="icon" text={r.url} what={t("Link")} />}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-dim">{t("No links yet.")}</p>
          )}
          {rows.length > 4 && <p className="text-2xs text-dim">{t("{n} more in the manager", { n: rows.length - 4 })}</p>}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" variant="outline" className="max-sm:h-10" icon={<Share2 className="size-3.5" />} onClick={() => onManage(cur)}>
              {canEdit ? t("Manage links") : t("View links")}
            </Button>
            <Button size="sm" variant="ghost" className="max-sm:h-10" icon={<MessageSquareText className="size-3.5" />} onClick={() => nav(`/p/${pid}/review?export=${cur.id}`)}>
              {t("Open team review")}
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
