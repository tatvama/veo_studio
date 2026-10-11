import { clsx } from "clsx";
import { ArrowUpRight, CircleCheck, MessageSquareText, Pencil } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { agoT } from "../../../components/growth/common";
import { formatTC } from "../../../components/review/utils";
import { SectionCard } from "../../../components/room/kit";
import { Badge, Segmented, Skeleton, Tooltip } from "../../../components/ui";
import { panelOpen, publish } from "../../../lib/bus";
import { noteAuthor, useReviewNotes, type ReviewNote } from "../../../lib/finish";
import { useT } from "../../../lib/i18n";
import { Quiet } from "./parts";

type Filter = "open" | "all";

/**
 * Notes on this episode's renders, grouped by render version. A note on a render of the current cut "maps to the cut":
 * clicking it moves every window's playhead there (and opens the timeline when nothing else would follow).
 */
export function NotesList({ eid, pid, inPanel = false }: { eid: number; pid: number; inPanel?: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const { notes, isLoading, available, isError, refetch } = useReviewNotes(eid);
  const [filter, setFilter] = useState<Filter>("open");
  const shown = filter === "open" ? notes.filter((n) => !n.resolved) : notes;
  const groups = useMemo(() => {
    const m = new Map<number, { id: number; version: number | null; cut: number | null; maps: boolean; list: ReviewNote[] }>();
    for (const n of shown) {
      const g = m.get(n.export_id) ?? { id: n.export_id, version: n.export_version, cut: n.cut_version, maps: n.maps_to_cut, list: [] };
      g.list.push(n);
      m.set(n.export_id, g);
    }
    for (const g of m.values()) g.list.sort((a, b) => (a.timecode ?? 1e9) - (b.timecode ?? 1e9));
    return [...m.values()];
  }, [shown]);

  const seek = (n: ReviewNote) => {
    if (n.timecode == null) return;
    publish({ type: "seek", eid, t: n.timecode });
    if (!inPanel && !panelOpen("program", eid) && !panelOpen("timeline", eid)) navigate(`/p/${pid}/timeline`);
  };
  const reviewHref = (xid: number) => `/p/${pid}/review?export=${xid}`;

  if (isLoading) return <div className="space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>;
  if (isError) return <Quiet>{t("Couldn't load the notes.")} <button type="button" className="font-medium text-accent-ink hover:underline" onClick={() => void refetch()}>{t("Retry")}</button></Quiet>;
  if (!available) return <Quiet>{t("This server doesn't list review notes per episode yet. Open Review to read them per render.")}</Quiet>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented size="sm" value={filter} onChange={setFilter} aria-label={t("Show")}
          options={[{ value: "open", label: `${t("Open")} ${notes.filter((n) => !n.resolved).length}` }, { value: "all", label: `${t("All")} ${notes.length}` }]} />
      </div>
      {!groups.length ? (
        <Quiet>{notes.length ? t("Every note is resolved.") : t("No review notes on this episode's renders yet. Share a render from Export to collect them.")}</Quiet>
      ) : groups.map((g) => (
        <section key={g.id} className="overflow-hidden rounded-xl border border-line">
          <header className="flex flex-wrap items-center gap-2 border-b border-line bg-raised/40 px-3 py-1.5">
            <span className="mono text-xs font-semibold">{g.version ? t("Render v{n}", { n: g.version }) : t("Render #{id}", { id: g.id })}</span>
            {g.maps ? <Badge tone="ok" dot>{t("maps to the current cut")}</Badge>
              : <Badge tone="neutral">{g.cut ? t("older cut (v{n})", { n: g.cut }) : t("older cut")}</Badge>}
            <span className="flex-1" />
            {inPanel
              ? <a href={reviewHref(g.id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-2xs font-medium text-accent-ink hover:underline">{t("Review")}<ArrowUpRight className="size-3" /></a>
              : <Link to={reviewHref(g.id)} className="inline-flex items-center gap-0.5 text-2xs font-medium text-accent-ink hover:underline">{t("Review")}<ArrowUpRight className="size-3" /></Link>}
          </header>
          <ul className="divide-y divide-line/60">
            {g.list.map((n) => {
              const can = g.maps && n.timecode != null;
              return (
                <li key={n.id}>
                  <button type="button" disabled={!can} onClick={() => seek(n)}
                    className={clsx("flex w-full items-start gap-2.5 px-3 py-2 text-left", can ? "hover:bg-hover" : "cursor-default")}>
                    <Tooltip content={can ? t("Move the playhead here") : t("From an older cut: open it in Review")} disabled={n.timecode == null}>
                      <span className={clsx("mono mt-0.5 shrink-0 rounded-md border px-1.5 py-0.5 text-2xs tabular-nums",
                        can ? "border-accent/35 bg-accent/10 text-accent-ink" : "border-line bg-raised text-dim")}>
                        {n.timecode != null ? formatTC(n.timecode, 24, true) : "—"}
                      </span>
                    </Tooltip>
                    <span className="min-w-0 flex-1">
                      <span className={clsx("block text-sm leading-snug", n.resolved && "text-mute line-through decoration-dim/60")}>{n.body}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-dim">
                        <span>{noteAuthor(n)}</span><span>{agoT(n.created_at)}</span>
                        {Array.isArray(n.drawing) && n.drawing.length > 0 && <span className="inline-flex items-center gap-0.5"><Pencil className="size-3" />{t("drawing")}</span>}
                      </span>
                    </span>
                    {n.resolved && <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-ok" aria-label={t("Resolved")} />}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function NotesCard({ eid, pid, className }: { eid: number; pid: number; className?: string }) {
  const t = useT();
  return (
    <SectionCard className={className} icon={<MessageSquareText />} title={t("Review notes")}
      description={t("Feedback on this episode's renders. Notes on a render of the current cut land on the timeline as they are.")}>
      <NotesList eid={eid} pid={pid} />
    </SectionCard>
  );
}
