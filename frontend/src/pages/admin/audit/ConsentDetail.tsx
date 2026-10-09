import { CalendarClock, CircleCheck, ExternalLink, FileText, ShieldCheck, TriangleAlert } from "lucide-react";
import { agoT, fmtDate, fmtDateTime } from "../../../components/growth/common";
import { Avatar, Badge, Button, Modal } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import type { ConsentRow } from "../../../lib/types";
import { Pill } from "../shared/Pill";
import { CONSENT_KINDS, KIND_ICON, expiry } from "./meta";
import "../../../styles/admin.css";
import "../../../styles/console.css";

/** Where a consent stands, as a toned pill with an icon and a word. */
export function ExpiryPill({ c }: { c: ConsentRow }) {
  const t = useT();
  const e = expiry(c);
  if (e.state === "expired") return <Pill tone="bad"><TriangleAlert aria-hidden />{t("Expired")}</Pill>;
  if (e.state === "soon") return <Pill tone="warn"><CalendarClock aria-hidden />{t("Expiring soon")}</Pill>;
  if (e.state === "valid") return <Pill tone="ok"><CircleCheck aria-hidden />{t("Valid")}</Pill>;
  return <Pill><ShieldCheck aria-hidden />{t("No expiry")}</Pill>;
}

/** The full record of one consent: who, what kind, what it covers, how long it runs and the signed file. */
export function ConsentDetail({ consent, charName, onClose }: { consent: ConsentRow | null; charName?: string; onClose: () => void }) {
  const t = useT();
  const c = consent;
  const e = c ? expiry(c) : null;
  const Icon = c ? KIND_ICON[c.kind] ?? FileText : FileText;
  const barTone = e?.state === "expired" ? "var(--color-bad)" : e?.state === "soon" ? "var(--color-warn)" : "var(--color-ok)";

  return (
    <Modal open={!!c} onClose={onClose} size="md" title={c ? t("Consent from {name}", { name: c.subject_name }) : t("Consent")}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} data-autofocus>{t("Close")}</Button>
          {c?.file_url && (
            <a href={c.file_url} target="_blank" rel="noreferrer"
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-line px-3.5 text-sm font-medium text-ink transition-colors hover:border-dim/50 hover:bg-hover">
              <ExternalLink className="size-4" aria-hidden />{t("View signed file")}
            </a>
          )}
        </>
      )}>
      {c && e && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Avatar name={c.subject_name} size={44} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold tracking-tight">{c.subject_name}</p>
              <p className="mono text-2xs text-dim" title={fmtDateTime(c.created_at)}>{t("Recorded {when}", { when: agoT(c.created_at) })} · #{c.id}</p>
            </div>
            <ExpiryPill c={c} />
          </div>

          <dl className="cx-block grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 px-3.5 py-3 text-sm">
            <dt className="text-dim">{t("Type")}</dt>
            <dd><Badge><Icon className="size-3" aria-hidden />{t(CONSENT_KINDS[c.kind] ?? c.kind)}</Badge></dd>
            <dt className="text-dim">{t("Character")}</dt>
            <dd>{c.character_id ? <Pill tone="info">{charName ?? `#${c.character_id}`}</Pill> : <span className="text-dim">—</span>}</dd>
            <dt className="text-dim">{t("Expires on")}</dt>
            <dd className="mono">{c.expires_on ? fmtDate(c.expires_on) : <span className="font-sans text-mute">{t("Doesn't expire")}</span>}</dd>
          </dl>

          {e.state !== "none" && (
            <div>
              <span className="ad-bar is-lg" style={{ ["--p" as string]: `${(e.state === "expired" ? 1 : e.used) * 100}%`, ["--c" as string]: barTone }}><i /></span>
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-mute">
                {e.state === "expired" ? <TriangleAlert className="size-3.5 text-bad" aria-hidden /> : <CalendarClock className="size-3.5" aria-hidden />}
                {e.state === "expired"
                  ? t("Expired {date}", { date: fmtDate(c.expires_on) })
                  : t("Until {date} · {n} days left", { date: fmtDate(c.expires_on), n: e.days })}
              </p>
            </div>
          )}

          <div>
            <p className="eyebrow mb-1.5">{t("Scope")}</p>
            <p className={`cx-block whitespace-pre-line px-3.5 py-3 text-sm leading-relaxed ${c.scope ? "text-ink" : "text-dim"}`}>{c.scope || t("No scope written down.")}</p>
          </div>

          {!c.file_url && (
            <p className="ad-tx flex items-center gap-1.5 text-xs font-medium" data-tone="warn"><TriangleAlert className="size-3.5" aria-hidden />{t("No signed file")}</p>
          )}
        </div>
      )}
    </Modal>
  );
}
