import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, Layers, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { tr, useT } from "../../lib/i18n";
import { addSeason, patchSeason, useSeasons, type Season } from "../../lib/v3";
import { LoadError, RoomEmpty } from "../room/kit";
import { Badge, Button, Field, Input, Meter, Modal, Panel, Select, Skeleton, Textarea } from "../ui";

const SEASON_STATUS = ["draft", "writing", "in_production", "delivered", "archived"] as const;
const STATUS_TONE: Record<string, "neutral" | "info" | "accent" | "ok"> = { draft: "neutral", writing: "info", in_production: "accent", delivered: "ok", archived: "neutral" };
const EP_TONE: Record<string, "neutral" | "info" | "accent" | "ok" | "warn"> = { draft: "neutral", scripted: "info", in_production: "accent", approved: "ok", delivered: "ok" };

/** Seasons and their episodes. Click an episode to open it; title and status edit inline; "Add season" makes empty episodes. */
export function SeasonsCard({ pid, currentEid, canEdit, onOpenEpisode, index, className }: {
  pid: number; currentEid: number; canEdit: boolean; onOpenEpisode: (eid: number) => void; index?: number; className?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useSeasons(pid);
  const [adding, setAdding] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["seasons", pid] }); qc.invalidateQueries({ queryKey: ["project", pid] }); qc.invalidateQueries({ queryKey: ["dashboard"] }); };

  const head = { index, className, eyebrow: t("Seasons"), icon: <Layers /> };
  if (isError && !data) return <Panel {...head}><LoadError what={t("Couldn't load the seasons")} onRetry={() => refetch()} /></Panel>;
  if (isLoading || !data) return <Panel {...head}><div className="space-y-2" aria-busy="true"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div></Panel>;

  return (
    <Panel {...head} actions={canEdit && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>{t("Add season")}</Button>}>
      <p className="-mt-1 mb-3 text-xs leading-relaxed text-mute">{t("Every episode of the project, grouped by season. Open one to work on it.")}</p>
      {!data.length ? (
        <RoomEmpty icon={<Layers />} title={t("No seasons yet")} sub={t("A season groups episodes and carries the arc they follow.")}
          action={canEdit ? <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>{t("Add a season")}</Button> : undefined} />
      ) : (
        <ul className="space-y-3">
          {data.map((s) => <SeasonRow key={s.id} s={s} currentEid={currentEid} canEdit={canEdit} onOpenEpisode={onOpenEpisode} onSaved={refresh} />)}
        </ul>
      )}
      <AddSeasonModal open={adding} pid={pid} next={(data.length ? Math.max(...data.map((s) => s.number)) : 0) + 1} onClose={() => setAdding(false)} onDone={() => { setAdding(false); refresh(); }} />
    </Panel>
  );
}

function SeasonRow({ s, currentEid, canEdit, onOpenEpisode, onSaved }: { s: Season; currentEid: number; canEdit: boolean; onOpenEpisode: (eid: number) => void; onSaved: () => void }) {
  const t = useT();
  const [title, setTitle] = useState(s.title);
  const [saving, setSaving] = useState<"title" | "status" | null>(null);
  const save = async (body: { title?: string; status?: string }, what: "title" | "status") => {
    setSaving(what);
    try { await patchSeason(s.id, body); onSaved(); } catch { setTitle(s.title); } finally { setSaving(null); }
  };
  return (
    <li className="rounded-lg border border-line bg-raised/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono shrink-0 rounded-md border border-line bg-panel px-1.5 py-0.5 text-2xs font-semibold text-accent-ink">S{String(s.number).padStart(2, "0")}</span>
        <input value={title} disabled={!canEdit} aria-label={t("Season title")} placeholder={t("Season {n}", { n: s.number })}
          onChange={(e) => setTitle(e.target.value)} onBlur={() => { if (title.trim() && title !== s.title) void save({ title: title.trim() }, "title"); else setTitle(s.title); }}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setTitle(s.title); e.currentTarget.blur(); } }}
          className="h-7 min-w-0 flex-1 basis-40 truncate rounded-md bg-transparent px-1.5 text-sm font-semibold text-ink transition-colors placeholder:text-dim hover:bg-hover focus:bg-raised focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:hover:bg-transparent" />
        {canEdit ? (
          <Select value={s.status} aria-label={t("Season status")} className="h-7! w-auto! text-xs!" disabled={saving === "status"} onChange={(e) => void save({ status: e.target.value }, "status")}>
            {SEASON_STATUS.map((v) => <option key={v} value={v}>{t(v.replaceAll("_", " "))}</option>)}
          </Select>
        ) : <Badge tone={STATUS_TONE[s.status] ?? "neutral"} dot>{t(s.status.replaceAll("_", " "))}</Badge>}
      </div>
      {s.arc && <p className="mt-1 line-clamp-2 pl-1 text-xs text-mute" title={s.arc}>{s.arc}</p>}
      {s.episodes.length > 0 && (
        <div className="mt-2.5 flex items-center gap-3 pl-1">
          <Meter className="max-w-40 flex-1" filled={s.episodes.filter((e) => e.status === "approved" || e.status === "delivered").length} total={Math.min(s.episodes.length, 12)} tone="ok" />
          <span className="mono text-2xs text-dim">{s.episodes.filter((e) => e.status === "approved" || e.status === "delivered").length}/{s.episodes.length} {t("done")}</span>
        </div>
      )}
      <ul className="mt-2.5 flex flex-wrap gap-1.5">
        {s.episodes.map((e) => {
          const on = e.id === currentEid;
          return (
            <li key={e.id}>
              <button type="button" onClick={() => onOpenEpisode(e.id)} aria-current={on ? "true" : undefined}
                className={clsx("inline-flex h-8 max-w-56 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors max-sm:h-10",
                  on ? "border-accent/50 bg-accent/10 text-ink" : "border-line text-mute hover:border-dim/60 hover:bg-hover hover:text-ink")}>
                <span className="mono font-semibold">E{String(e.number).padStart(2, "0")}</span>
                <span className="truncate">{e.title || t("Untitled")}</span>
                <span className={clsx("size-1.5 shrink-0 rounded-full", { neutral: "bg-dim", info: "bg-info", accent: "bg-accent", ok: "bg-ok", warn: "bg-warn" }[EP_TONE[e.status] ?? "neutral"])} title={t(e.status.replaceAll("_", " "))} />
              </button>
            </li>
          );
        })}
        {!s.episodes.length && <li className="text-xs text-dim">{t("No episodes in this season.")}</li>}
      </ul>
    </li>
  );
}

function AddSeasonModal({ open, pid, next, onClose, onDone }: { open: boolean; pid: number; next: number; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [arc, setArc] = useState("");
  const [count, setCount] = useState("4");
  const [saving, setSaving] = useState(false);
  const n = Number(count);
  const bad = !Number.isInteger(n) || n < 0 || n > 50;
  const save = async () => {
    if (bad) return;
    setSaving(true);
    try {
      const s = await addSeason(pid, { title: title.trim() || undefined, arc: arc.trim(), episodes: n });
      toast.success(tr("{title} added with {n} episodes", { title: s.title, n: s.episodes.length }));
      setTitle(""); setArc(""); setCount("4");
      onDone();
    } catch { /* api toasts */ } finally { setSaving(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={t("New season")} size="sm"
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={saving}>{t("Cancel")}</Button>
        <Button variant="primary" loading={saving} disabled={bad} icon={<Check className="size-4" />} onClick={save}>{t("Add season")}</Button>
      </>}>
      <div className="space-y-4">
        <Field label={t("Title")}>
          <Input value={title} data-autofocus placeholder={t("Season {n}", { n: next })} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
        </Field>
        <Field label={t("Arc")} hint={t("Where the season goes: the question it asks and how it pays off. Writers see it on every episode.")}>
          <Textarea rows={3} value={arc} onChange={(e) => setArc(e.target.value)} />
        </Field>
        <Field label={t("Empty episodes to create")} hint={t("0 to 50. Each gets a title like 'Episode 3' that you can rename.")}>
          <Input type="number" min={0} max={50} step={1} value={count} aria-invalid={bad || undefined} className={clsx("w-28 tabular-nums", bad && "border-bad/60 focus:border-bad")} onChange={(e) => setCount(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
