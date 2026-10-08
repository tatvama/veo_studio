import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { AlertTriangle, ArrowUpRight, Check, ChevronDown, Music2, Plus, Radar, TrendingUp, Zap } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { ago } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import type { Trends } from "../../lib/types";
import { useProjectCtx } from "../../pages/project/context";
import { Button, Skeleton } from "../ui";
import { RoomEmpty, SectionCard } from "./kit";

export type BriefField = "tone" | "notes" | "key_message";

const COLLAPSED = 4;

/** Trend scout (web-grounded) — results persist in project.brief.trends and feed the hook writer. */
export function TrendScout({ trends, brief, onScouted, onAdd, index }: {
  trends: Partial<Trends> | undefined;
  brief: Record<string, any>;
  onScouted: (t: Trends) => void;
  onAdd: (field: BriefField, text: string) => void;
  index?: number;
}) {
  const t = useT();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { project, canEdit } = useProjectCtx();
  const [busy, setBusy] = useState(false);
  const has = !!(trends && (trends.trends?.length || trends.hook_patterns?.length));

  const scout = async () => {
    setBusy(true);
    try {
      const r = await api.post<Trends>(`/api/projects/${project.id}/trends`);
      onScouted(r);
      qc.invalidateQueries({ queryKey: ["project", project.id] });
      toast.success(tr("Found {n} trends and {m} hook patterns", { n: r.trends?.length ?? 0, m: r.hook_patterns?.length ?? 0 }));
    } catch { /* api toasts */ } finally { setBusy(false); }
  };

  const inBrief = (field: BriefField, text: string) => String(brief[field] || "").includes(text);

  const addBtn = (field: BriefField, label: string, text: string) => (
    <AddChip key={field} added={inBrief(field, text)} disabled={!canEdit} label={label} onClick={() => onAdd(field, text)} />
  );

  return (
    <SectionCard id="trends" index={index} icon={<Radar />} title={t("Trend scout")}
      description={<>
        {t("What's working right now for this audience and platform, from a live web search.")}
        {trends?.at && <span className="text-dim"> · {t("Scouted {when}", { when: ago(trends.at) })}</span>}
      </>}
      actions={canEdit && has && (
        <Button size="sm" variant="secondary" loading={busy} icon={<Radar className="size-3.5" />} onClick={scout}>{t("Scout again")}</Button>
      )}>
      <AnimatePresence mode="wait" initial={false}>
        {busy ? (
          <motion.div key="busy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
            className="grid gap-3 @2xl:grid-cols-2" aria-busy="true" aria-label={t("Scouting trends…")}>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="rounded-xl border border-line bg-bg/40 p-3.5">
                <Skeleton className="mb-3 h-4 w-32" />
                <div className="space-y-3">
                  {[0, 1, 2].map((k) => <div key={k} className="space-y-1.5"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-3/5" /></div>)}
                </div>
              </div>
            ))}
          </motion.div>
        ) : !has ? (
          <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <RoomEmpty icon={<TrendingUp className="size-7" />} title={t("No trends scouted yet")}
              sub={t("Uses the concept, audience and platform from this brief. Hook patterns found here are used by the hook writer automatically.")}
              action={canEdit ? <Button variant="primary" icon={<Radar className="size-4" />} onClick={scout}>{t("Scout trends")}</Button> : undefined} />
          </motion.div>
        ) : (
          <motion.div key={`has-${trends?.at ?? "x"}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
            className="grid gap-3 @2xl:grid-cols-2">
            <Group index={0} icon={<TrendingUp className="size-4" />} iconTone="accent" title={t("Trends")} items={trends?.trends ?? []}
              actions={(s) => [addBtn("tone", t("Tone"), s), addBtn("notes", t("Notes"), s)]} />
            <Group index={1} icon={<Zap className="size-4" />} iconTone="accent" title={t("Hook patterns")} items={trends?.hook_patterns ?? []}
              sub={t("The hook writer uses these automatically.")}
              actions={(s) => canEdit ? [
                <button key="try" type="button" onClick={() => nav(`/p/${project.id}/story`, { state: { angle: s } })}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-line px-1.5 text-2xs font-medium text-mute transition-colors hover:border-accent/50 hover:bg-accent/8 hover:text-ink">
                  <ArrowUpRight className="size-3" />{t("Try as hook angle")}
                </button>,
              ] : []} />
            <Group index={2} icon={<Music2 className="size-4" />} iconTone="info" title={t("Sounds & formats")} items={trends?.sounds_or_formats ?? []}
              actions={(s) => [addBtn("notes", t("Notes"), s)]} />
            <Group index={3} icon={<AlertTriangle className="size-4" />} iconTone="warn" title={t("Cautions")} items={trends?.cautions ?? []} tone="warn"
              actions={(s) => [addBtn("notes", t("Notes"), s)]} />
          </motion.div>
        )}
      </AnimatePresence>
    </SectionCard>
  );
}

/** "+ Tone" → "✓ Tone": a small action chip that confirms where the text went. */
function AddChip({ added, disabled, label, onClick }: { added: boolean; disabled?: boolean; label: string; onClick: () => void }) {
  const t = useT();
  return (
    <button type="button" disabled={disabled || added} onClick={onClick}
      aria-label={added ? t("Already in {field}", { field: label }) : t("Add to {field}", { field: label })}
      className={clsx("inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-2xs font-medium transition-colors disabled:cursor-default",
        added ? "border-ok/30 bg-ok/10 text-green-300" : "border-line text-mute hover:border-accent/50 hover:bg-accent/8 hover:text-ink disabled:opacity-50 disabled:hover:border-line disabled:hover:bg-transparent")}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={added ? "y" : "n"} initial={{ scale: 0.4, opacity: 0, rotate: -40 }} animate={{ scale: 1, opacity: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 600, damping: 26 }} className="grid place-items-center">
          {added ? <Check className="size-3" strokeWidth={2.75} /> : <Plus className="size-3" />}
        </motion.span>
      </AnimatePresence>
      {label}
    </button>
  );
}

const ICON_TONE = {
  accent: "bg-accent/12 text-accent-ink", info: "bg-info/12 text-info", warn: "bg-warn/12 text-warn",
} as const;

function Group({ icon, iconTone, title, sub, items, actions, tone, index }: {
  icon: ReactNode; iconTone: keyof typeof ICON_TONE; title: string; sub?: string; items: string[];
  actions: (s: string) => ReactNode[]; tone?: "warn"; index: number;
}) {
  const t = useT();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, COLLAPSED);
  return (
    <div className={clsx("flex min-w-0 flex-col rounded-xl border p-3.5", tone === "warn" ? "border-warn/30 bg-warn/5" : "border-line bg-bg/40")}>
      <div className="mb-2.5 flex items-center gap-2">
        <span className={clsx("grid size-7 shrink-0 place-items-center rounded-lg", ICON_TONE[iconTone])}>{icon}</span>
        <h3 className="min-w-0 truncate text-sm font-semibold">{title}</h3>
        <span className="rounded-full bg-raised px-1.5 py-px text-2xs font-semibold tabular-nums text-dim">{items.length}</span>
      </div>
      {sub && <p className="-mt-1 mb-2 text-2xs text-dim">{sub}</p>}
      {!items.length ? <p className="text-xs text-dim">{t("Nothing found.")}</p> : (
        <ul className="-mx-1 space-y-0.5">
          <AnimatePresence initial>
            {shown.map((s, i) => {
              const acts = actions(s);
              return (
                <motion.li key={`${i}-${s}`} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1], delay: Math.min(i, 8) * 0.035 + index * 0.05 }}
                  className="rounded-lg px-2 py-1.5 transition-colors hover:bg-panel">
                  <p className="text-sm leading-snug">{s}</p>
                  {acts.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{acts}</div>}
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
      {items.length > COLLAPSED && (
        <button type="button" onClick={() => setAll(!all)}
          className="mt-2 inline-flex items-center gap-1 self-start rounded-md px-1.5 py-1 text-xs font-medium text-mute transition-colors hover:bg-hover hover:text-ink">
          <ChevronDown className={clsx("size-3.5 transition-transform", all && "rotate-180")} />
          {all ? t("Show fewer") : t("Show {n} more", { n: items.length - COLLAPSED })}
        </button>
      )}
    </div>
  );
}
