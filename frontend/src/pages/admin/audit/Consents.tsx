import { useQueries, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { AudioLines, CalendarClock, FileCheck, FileText, Music, Plus, ScanFace, ShieldCheck, TriangleAlert, type LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { agoT, fmtDate } from "../../../components/growth/common";
import { Avatar, Badge, Button, Empty, Progress, SearchField, Skeleton, rise } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { useConsents } from "../../../lib/queries";
import type { Character, ConsentRow } from "../../../lib/types";
import { ChipGroup } from "../shared/ChipGroup";
import { ConsentModal } from "./ConsentModal";
import { CONSENT_KINDS } from "./meta";

import { Pill } from "../shared/Pill";
type ExpiryState = "none" | "valid" | "soon" | "expired";

function expiry(c: ConsentRow): { state: ExpiryState; days: number; used: number } {
  if (!c.expires_on) return { state: "none", days: 0, used: 0 };
  const end = new Date(`${c.expires_on}T23:59:59`).getTime();
  if (Number.isNaN(end)) return { state: "none", days: 0, used: 0 };
  const now = Date.now();
  const days = Math.ceil((end - now) / 86_400_000);
  const start = new Date(c.created_at).getTime();
  const used = Number.isNaN(start) || end <= start ? 1 : Math.max(0, Math.min(1, (now - start) / (end - start)));
  return { state: end < now ? "expired" : days <= 30 ? "soon" : "valid", days, used };
}

const KIND_ICON: Record<string, LucideIcon> = { voice_replication: AudioLines, likeness: ScanFace, music: Music, other: FileText };
const STATE_RANK: Record<ExpiryState, number> = { expired: 0, soon: 1, valid: 2, none: 3 };

function ConsentCard({ c, charName, index }: { c: ConsentRow; charName?: string; index: number }) {
  const t = useT();
  const e = expiry(c);
  const Icon = KIND_ICON[c.kind] ?? FileText;
  const tone = e.state === "expired" ? "bad" : e.state === "soon" ? "warn" : "ok";
  const r = rise(index);
  return (
    <motion.article layout="position" whileHover={{ y: -2 }} transition={{ duration: 0.18 }}
      className={clsx("flex flex-col rounded-xl border bg-panel p-4 transition-[border-color,box-shadow] hover:shadow-lift",
        e.state === "expired" ? "border-bad/40" : e.state === "soon" ? "border-warn/40" : "border-line", r.className)} style={r.style}>
      <header className="flex items-start gap-3">
        <Avatar name={c.subject_name} size={40} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold" title={c.subject_name}>{c.subject_name}</h3>
          <p className="text-2xs text-dim">{t("Recorded {when}", { when: agoT(c.created_at) })}</p>
        </div>
        {e.state === "expired" ? <Pill tone="bad" dot>{t("Expired")}</Pill>
          : e.state === "soon" ? <Pill tone="warn" dot>{t("Expiring soon")}</Pill>
            : e.state === "valid" ? <Pill tone="ok" dot>{t("Valid")}</Pill> : <Badge>{t("No expiry")}</Badge>}
      </header>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge><Icon className="size-3" />{t(CONSENT_KINDS[c.kind] ?? c.kind)}</Badge>
        {c.character_id ? <Pill tone="info">{charName ?? `#${c.character_id}`}</Pill> : null}
      </div>

      <p className={clsx("mt-3 line-clamp-3 whitespace-pre-line text-xs leading-relaxed", c.scope ? "text-mute" : "text-dim")} title={c.scope}>{c.scope || t("No scope written down.")}</p>

      <div className="mt-4">
        {e.state === "none" ? (
          <p className="flex items-center gap-1.5 text-xs text-dim"><ShieldCheck className="size-3.5" />{t("Doesn't expire")}</p>
        ) : (
          <>
            <Progress value={e.state === "expired" ? 1 : e.used} size="sm" tone={tone} />
            <p className={clsx("mt-1.5 flex items-center gap-1.5 text-xs", e.state === "expired" ? "text-red-300" : e.state === "soon" ? "text-amber-300" : "text-mute")}>
              {e.state === "expired" ? <TriangleAlert className="size-3.5" /> : <CalendarClock className="size-3.5" />}
              {e.state === "expired"
                ? t("Expired {date}", { date: fmtDate(c.expires_on) })
                : t("Until {date} · {n} days left", { date: fmtDate(c.expires_on), n: e.days })}
            </p>
          </>
        )}
      </div>

      <footer className="mt-auto pt-4">
        <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
          {c.file_url ? (
            <a href={c.file_url} target="_blank" rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-medium text-mute transition-colors hover:border-dim/50 hover:text-ink">
              <FileText className="size-3.5" />{t("View signed file")}
            </a>
          ) : <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-300"><TriangleAlert className="size-3.5" />{t("No signed file")}</span>}
        </div>
      </footer>
    </motion.article>
  );
}

/** Signed consents as cards, most urgent first, with how long each one still runs. */
export function Consents({ canAdd }: { canAdd: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useConsents();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<"all" | "valid" | "soon" | "expired">("all");
  const [text, setText] = useState("");
  const rows = data ?? [];
  const charIds = [...new Set(rows.map((c) => c.character_id).filter((x): x is number => !!x))];
  const charQs = useQueries({
    queries: charIds.map((id) => ({
      queryKey: ["character", id],
      queryFn: () => api.get<Character>(`/api/characters/${id}`, { silent: true }),
      staleTime: 5 * 60_000,
    })),
  });
  const charName: Record<number, string> = {};
  charQs.forEach((q, i) => { if (q.data) charName[charIds[i]] = q.data.name; });

  const counts = { valid: 0, soon: 0, expired: 0 };
  for (const c of rows) {
    const s = expiry(c).state;
    if (s === "expired") counts.expired += 1;
    else if (s === "soon") counts.soon += 1;
    else counts.valid += 1;
  }
  const needle = text.trim().toLowerCase();
  const shown = useMemo(() => rows.filter((c) => {
    const s = expiry(c).state;
    const okFilter = filter === "all" || (filter === "valid" ? s === "valid" || s === "none" : s === filter);
    return okFilter && (!needle || `${c.subject_name} ${c.kind} ${c.scope} ${charName[c.character_id ?? 0] ?? ""}`.toLowerCase().includes(needle));
  }).sort((a, b) => {
    const ea = expiry(a), eb = expiry(b);
    return STATE_RANK[ea.state] - STATE_RANK[eb.state] || ea.days - eb.days;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [rows, filter, needle, charQs.map((q) => q.dataUpdatedAt).join("|")]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ChipGroup label={t("Status")} value={filter} onChange={(v) => setFilter(v as typeof filter)} className="min-w-0 flex-1"
          items={[
            { value: "all", label: t("All"), count: rows.length },
            { value: "valid", label: t("Valid"), count: counts.valid },
            { value: "soon", label: t("Expiring in 30 days"), count: counts.soon },
            { value: "expired", label: t("Expired"), count: counts.expired },
          ]} />
        <SearchField value={text} onChange={setText} placeholder={t("Search consents…")} aria-label={t("Search consents")} className="w-full sm:w-60" />
        {canAdd && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>{t("Record consent")}</Button>}
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-52 rounded-xl" />)}</div>
      ) : !rows.length ? (
        <Empty icon={<FileCheck className="size-8" />} title={t("No consents recorded")}
          sub={t("Keep a signed release for every real person whose voice or likeness you clone, and for licensed music.")}
          action={canAdd ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>{t("Record consent")}</Button> : undefined} />
      ) : !shown.length ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-12 text-center text-sm text-dim">{t("No consents match these filters.")}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((c, i) => <ConsentCard key={c.id} c={c} index={i} charName={c.character_id ? charName[c.character_id] : undefined} />)}
        </div>
      )}

      {canAdd && <ConsentModal open={adding} onClose={() => setAdding(false)} onSaved={() => { void qc.invalidateQueries({ queryKey: ["consents"] }); void qc.invalidateQueries({ queryKey: ["audit"] }); }} />}
    </div>
  );
}
