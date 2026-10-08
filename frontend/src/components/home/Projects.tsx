import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  Archive, ArchiveRestore, Clapperboard, FileText, FolderOpen, LayoutGrid, LayoutTemplate, Link2, MoreHorizontal, SearchX, ShieldAlert, Wand2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { agoT, copyText, fmtDateTime } from "../growth/common";
import { api } from "../../lib/api";
import { LANG_SHORT, usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useJobs, useProjects } from "../../lib/queries";
import type { Project } from "../../lib/types";
import {
  AnimatedNumber, Alert, Avatar, Button, Empty, IconButton, Menu, Modal, SearchField, Section, Segmented, Select, Skeleton, ScrollStrip, rise,
} from "../ui";
import { FilterChip, MediaPill as Pill } from "./Chips";
import { type ProjectKind, useProjectKinds } from "./kinds";
import { hueOf, MiniThumb, ThumbArt } from "./ThumbArt";

type Sort = "recent" | "new" | "old" | "name" | "cost";
type View = "active" | "archived";
const SORT_KEY = "veo-home-sort";
const SORTS: Sort[] = ["recent", "new", "old", "name", "cost"];

function readSort(): Sort {
  try {
    const v = localStorage.getItem(SORT_KEY) as Sort | null;
    return v && SORTS.includes(v) ? v : "recent";
  } catch {
    return "recent";
  }
}

interface Activity { running: number; approval: number }

function ProjectCard({ p, index, kind, activity, archived, canManage, onArchive, onRestore }: {
  p: Project; index: number; kind: ProjectKind | undefined; activity?: Activity;
  /** Showing the archived list: muted look, Restore instead of Archive. */
  archived: boolean;
  /** Creators and above can archive / restore. */
  canManage: boolean;
  onArchive: (p: Project) => void;
  onRestore: (p: Project) => void;
}) {
  const t = useT();
  const nav = useNavigate();
  const r = rise(index);
  const KindIcon = kind?.icon ?? Clapperboard;
  const hue = hueOf(p.id);
  const owner = p.owner;
  const ownerName = owner ? owner.name?.trim() || owner.email.split("@")[0] : "";
  const eps = p.episodes?.length ?? 0;
  const generating = !!activity?.running && !archived;
  const open = (sub: string) => () => nav(`/p/${p.id}/${sub}`);
  // archived pictures lose their colour until you point at them
  const muted = archived ? "grayscale-[0.75] opacity-80 group-hover:grayscale-0 group-hover:opacity-100" : "";

  return (
    // entrance + generating ring on the wrapper, hover lift on the card (a running CSS animation would otherwise pin the transform)
    <div className={clsx("relative h-full rounded-xl", generating && "gen-ring", r.className)} style={r.style}>
      <article className={clsx("lift group relative flex h-full flex-col overflow-hidden rounded-xl border border-line bg-panel hover:border-accent/40", archived && "bg-panel/60")}>
        {/* the whole card is one link; its focus ring is drawn inside because the card clips overflow */}
        <Link to={`/p/${p.id}/storyboard`} aria-label={p.title} className="absolute inset-0 z-10 rounded-xl focus-visible:-outline-offset-2" />

        <div className="relative aspect-[16/10] shrink-0 overflow-hidden bg-raised">
          {p.thumb_url ? (
            <img src={p.thumb_url} alt="" loading="lazy"
              className={clsx("size-full object-cover transition-[transform,filter,opacity] duration-500 ease-out group-hover:scale-[1.05]", p.aspect === "9:16" && "object-[50%_28%]", muted)} />
          ) : (
            <ThumbArt hue={hue} icon={KindIcon} className={clsx("transition-[filter,opacity] duration-500", muted)} />
          )}
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-black/30" />

          <div className="pointer-events-none absolute left-2.5 top-2.5 flex max-w-[calc(100%-3.5rem)] flex-wrap gap-1">
            <Pill><KindIcon className="size-3" />{kind?.label ?? p.type}</Pill>
            {archived ? <Pill><Archive className="size-3" />{t("Archived")}</Pill> : p.agent_mode === "autopilot" && <Pill>{t("Autopilot")}</Pill>}
          </div>

          <div className="absolute right-2 top-2 z-20">
            <Menu
              width={188}
              trigger={(tp) => (
                <IconButton title={t("More")} {...tp}
                  className="size-10 bg-black/50! text-white! opacity-0 backdrop-blur-sm hover:bg-black/70! hover:text-white! focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100 sm:size-8">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              )}
              items={[
                archived && canManage && { label: t("Restore"), icon: <ArchiveRestore className="size-4" />, onClick: () => onRestore(p) },
                { label: t("Open storyboard"), icon: <LayoutGrid className="size-4" />, separator: archived && canManage, onClick: open("storyboard") },
                { label: t("Brief"), icon: <FileText className="size-4" />, onClick: open("brief") },
                { label: t("Export"), icon: <Clapperboard className="size-4" />, onClick: open("export") },
                { label: t("Copy link"), icon: <Link2 className="size-4" />, separator: true, onClick: () => void copyText(`${window.location.origin}/p/${p.id}/storyboard`, t("Link")) },
                !archived && canManage && { label: t("Archive"), icon: <Archive className="size-4" />, separator: true, onClick: () => onArchive(p) },
              ]}
            />
          </div>

          <div className="pointer-events-none absolute inset-x-2.5 bottom-2 flex items-end justify-between gap-2 text-2xs font-medium text-white">
            <span className="flex min-w-0 items-center gap-1.5 truncate tabular-nums drop-shadow">
              {p.languages.map((l) => LANG_SHORT[l] ?? l.toUpperCase()).join(" · ")}
              <span aria-hidden className="opacity-60">·</span>{p.aspect}
              {eps > 1 && <><span aria-hidden className="opacity-60">·</span>{t("{n} episodes", { n: eps })}</>}
            </span>
            {generating ? (
              <Pill className="bg-accent/90! text-black!"><span className="size-1.5 animate-pulse rounded-full bg-black" />{t("Generating")}</Pill>
            ) : activity?.approval && !archived ? (
              <Pill><ShieldAlert className="size-3 text-amber-400" />{t("Needs approval")}</Pill>
            ) : null}
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-2.5 p-3.5">
          <div className="min-w-0">
            <h3 className={clsx("truncate font-medium leading-snug", archived && "text-mute")} title={p.title}>{p.title}</h3>
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-mute">{p.concept}</p>
          </div>
          <div className="mt-auto flex items-center justify-between gap-3 border-t border-line/70 pt-2.5 text-xs">
            {archived && canManage ? (
              // sits above the card's link (z-20) so it can be clicked on its own
              <Button size="sm" variant="outline" className="relative z-20 h-10 sm:h-7" icon={<ArchiveRestore className="size-3.5" />}
                aria-label={t("Restore {title}", { title: p.title })} onClick={() => onRestore(p)}>
                {t("Restore")}
              </Button>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5 text-mute">
                {owner ? <Avatar name={ownerName} size={20} /> : <FolderOpen className="size-4 text-dim" />}
                <span className="truncate">{owner ? ownerName : t("Shared")}</span>
              </span>
            )}
            <span className="flex shrink-0 items-center gap-1.5 tabular-nums text-dim">
              <span className="font-medium text-mute">{usd(p.spent_usd)}</span>
              <span aria-hidden>·</span>
              <span title={fmtDateTime(p.updated_at)}>{agoT(p.updated_at)}</span>
            </span>
          </div>
        </div>
      </article>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div aria-hidden className="overflow-hidden rounded-xl border border-line bg-panel">
      <Skeleton className="aspect-[16/10] rounded-none" />
      <div className="space-y-2.5 p-3.5">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
        <div className="flex items-center justify-between border-t border-line/70 pt-3">
          <div className="flex items-center gap-2"><Skeleton className="size-5 rounded-full" /><Skeleton className="h-3 w-16" /></div>
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
    </div>
  );
}

/** The very first thing a new studio sees where the projects will be. */
function FirstProject({ canCreate, onWrite, onTemplate }: { canCreate: boolean; onWrite: () => void; onTemplate: () => void }) {
  const t = useT();
  if (!canCreate) {
    return <Empty icon={<Clapperboard className="size-7" />} title={t("No projects yet")} sub={t("When your team starts a project it will show up here.")} />;
  }
  const steps = [
    { n: 1, title: t("Describe it"), sub: t("A sentence or two is enough.") },
    { n: 2, title: t("Review the plan"), sub: t("Hooks, script, cast and shots.") },
    { n: 3, title: t("Generate"), sub: t("Approve the cost, get your video.") },
  ];
  return (
    <div className="anim-rise relative overflow-hidden rounded-2xl border border-dashed border-line px-5 py-12 text-center sm:py-14">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,color-mix(in_oklab,var(--color-accent)_14%,transparent),transparent_65%)]" />
      <div className="relative mx-auto mb-5 grid size-16 place-items-center">
        <span aria-hidden className="anim-glow absolute inset-0 -m-3 rounded-full bg-accent/20 blur-xl" />
        <span className="anim-float relative grid size-16 place-items-center rounded-2xl bg-accent text-black shadow-glow"><Clapperboard className="size-8" /></span>
      </div>
      <h3 className="relative text-xl font-semibold tracking-tight">{t("Make your first video")}</h3>
      <p className="relative mx-auto mt-1.5 max-w-md text-sm text-mute">{t("Type a concept above and press Start — or pick a template to get going in one click.")}</p>
      <ol className="relative mx-auto mt-7 grid max-w-2xl gap-4 text-left sm:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.n} style={rise(i + 1).style} className={clsx("flex items-start gap-3 rounded-xl border border-line bg-panel/70 p-3.5", rise(i + 1).className)}>
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/15 text-xs font-semibold tabular-nums text-accent-ink">{s.n}</span>
            <span className="min-w-0"><span className="block text-sm font-medium">{s.title}</span><span className="mt-0.5 block text-xs text-mute">{s.sub}</span></span>
          </li>
        ))}
      </ol>
      <div className="relative mt-7 flex flex-wrap justify-center gap-2">
        <Button variant="primary" icon={<Wand2 className="size-4" />} onClick={onWrite}>{t("Write a concept")}</Button>
        <Button variant="outline" icon={<LayoutTemplate className="size-4" />} onClick={onTemplate}>{t("Try a template")}</Button>
      </div>
    </div>
  );
}

export function ProjectsSection({ canCreate, onWrite, onTemplate }: { canCreate: boolean; onWrite: () => void; onTemplate: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const kinds = useProjectKinds();
  const activeQ = useProjects(false);
  const archivedQ = useProjects(true);
  const { data: jobs } = useJobs();
  const [view, setView] = useState<View>("active");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");
  const [sort, setSort] = useState<Sort>(readSort);
  const [confirm, setConfirm] = useState<Project | null>(null);
  const inflight = useRef(0);

  const archivedView = view === "archived";
  const cur = archivedView ? archivedQ : activeQ;
  const { isLoading, isError, refetch } = cur;
  const archivedCount = archivedQ.data?.length ?? 0;
  // The switch only appears once there is something archived (or while you are looking at the archive).
  const showSwitch = archivedCount > 0 || archivedView;

  const setSortPersist = (v: Sort) => {
    setSort(v);
    try { localStorage.setItem(SORT_KEY, v); } catch { /* private mode */ }
  };

  const switchView = (v: View) => {
    setView(v);
    setKind("all");
  };

  /**
   * Archive or restore. The card moves between the two cached lists straight away (so it animates out and the sidebar's
   * "Recent" list and the counts follow), then the server confirms; on failure both lists roll back.
   */
  const setArchived = async (p: Project, archived: boolean, undo = false) => {
    inflight.current += 1;
    await qc.cancelQueries({ queryKey: ["projects"] });
    const from = ["projects", !archived] as const;
    const to = ["projects", archived] as const;
    const prevFrom = qc.getQueryData<Project[]>(from);
    const prevTo = qc.getQueryData<Project[]>(to);
    qc.setQueryData<Project[]>(from, (old) => old?.filter((x) => x.id !== p.id));
    qc.setQueryData<Project[]>(to, (old) => old && [{ ...p, archived }, ...old.filter((x) => x.id !== p.id)]);
    try {
      await api.patch<Project>(`/api/projects/${p.id}`, { archived });
      if (archived) {
        toast.success(tr("“{title}” archived", { title: p.title }), {
          description: tr("It's in the Archived view whenever you need it."),
          duration: 8000,
          action: { label: tr("Undo"), onClick: () => void setArchived(p, false, true) },
        });
      } else if (undo) {
        toast.success(tr("“{title}” is back in your projects", { title: p.title }));
      } else {
        toast.success(tr("“{title}” restored", { title: p.title }), {
          duration: 8000,
          action: { label: tr("Undo"), onClick: () => void setArchived(p, true, true) },
        });
      }
    } catch {
      // the api helper already showed the error
      qc.setQueryData(from, prevFrom);
      qc.setQueryData(to, prevTo);
    } finally {
      inflight.current -= 1;
      void qc.invalidateQueries({ queryKey: ["project", p.id] });
      if (inflight.current === 0) void qc.invalidateQueries({ queryKey: ["projects"] }); // active + archived lists, sidebar, counts
    }
  };

  const activity = useMemo(() => {
    const m = new Map<number, Activity>();
    for (const j of jobs ?? []) {
      if (!j.project_id) continue;
      const a = m.get(j.project_id) ?? { running: 0, approval: 0 };
      if (j.status === "awaiting_approval") a.approval += 1;
      else if (j.status === "running" || j.status === "queued") a.running += 1;
      m.set(j.project_id, a);
    }
    return m;
  }, [jobs]);

  const all = useMemo(() => cur.data ?? [], [cur.data]);
  const typeCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const p of all) c.set(p.type, (c.get(p.type) ?? 0) + 1);
    return c;
  }, [all]);

  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const list = all.filter((p) =>
      (kind === "all" || p.type === kind) &&
      (!needle || [p.title, p.concept, p.owner?.name, p.owner?.email].some((s) => (s || "").toLowerCase().includes(needle))));
    const by: Record<Sort, (a: Project, b: Project) => number> = {
      recent: (a, b) => +new Date(b.updated_at) - +new Date(a.updated_at),
      new: (a, b) => +new Date(b.created_at) - +new Date(a.created_at),
      old: (a, b) => +new Date(a.created_at) - +new Date(b.created_at),
      name: (a, b) => a.title.localeCompare(b.title),
      cost: (a, b) => (b.spent_usd || 0) - (a.spent_usd || 0),
    };
    return [...list].sort(by[sort]);
  }, [all, kind, needle, sort]);

  const kindOf = (v: string) => kinds.find((k) => k.value === v);
  const filtering = !!needle || kind !== "all";
  const clear = () => { setQ(""); setKind("all"); };

  const confirmKind = confirm ? kindOf(confirm.type) : undefined;

  return (
    <Section
      className="mb-6"
      title={(
        <span className="flex items-center gap-2.5">
          {archivedView ? t("Archived projects") : t("Projects")}
          {!!all.length && <span className="rounded-full bg-raised px-2 py-0.5 text-xs font-medium tabular-nums text-mute"><AnimatedNumber value={all.length} duration={0.6} /></span>}
        </span>
      )}
      actions={showSwitch || all.length > 0 ? (
        <>
          {showSwitch && (
            <div className="anim-pop">
              <Segmented<View>
                aria-label={t("Project list")}
                value={view}
                onChange={switchView}
                className="h-10 sm:h-9"
                options={[
                  { value: "active", label: <span className="flex items-center gap-1.5">{t("Active")}{activeQ.data && <span className="tabular-nums text-dim"><AnimatedNumber value={activeQ.data.length} duration={0.5} /></span>}</span> },
                  { value: "archived", label: <span className="flex items-center gap-1.5"><Archive className="size-3.5" />{t("Archived")}<span className="tabular-nums text-dim"><AnimatedNumber value={archivedCount} duration={0.5} /></span></span> },
                ]}
              />
            </div>
          )}
          {all.length > 0 && (
            <>
              <SearchField value={q} onChange={setQ} placeholder={t("Search projects…")} aria-label={t("Search projects")} className="w-full sm:w-60" />
              <div className="w-full shrink-0 sm:w-48">
                <Select value={sort} onChange={(e) => setSortPersist(e.target.value as Sort)} aria-label={t("Sort by")}>
                  <option value="recent">{t("Recently updated")}</option>
                  <option value="new">{t("Newest first")}</option>
                  <option value="old">{t("Oldest first")}</option>
                  <option value="name">{t("Name (A–Z)")}</option>
                  <option value="cost">{t("Most spent")}</option>
                </Select>
              </div>
            </>
          )}
        </>
      ) : undefined}
    >
      {all.length > 1 && typeCounts.size > 1 && (
        <ScrollStrip className="-mx-4 mb-4 px-4 py-0.5 sm:mx-0 sm:px-0">
          <div className="flex gap-2 pr-6">
            <FilterChip active={kind === "all"} onClick={() => setKind("all")} count={all.length}>{t("All")}</FilterChip>
            {kinds.filter((k) => typeCounts.has(k.value)).map((k) => (
              <FilterChip key={k.value} active={kind === k.value} onClick={() => setKind(k.value)} count={typeCounts.get(k.value)} icon={<k.icon />}>{k.label}</FilterChip>
            ))}
          </div>
        </ScrollStrip>
      )}

      {isLoading ? (
        <div aria-busy="true" className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {Array.from({ length: 8 }, (_, i) => <CardSkeleton key={i} />)}
        </div>
      ) : isError ? (
        <Alert tone="bad" title={t("Couldn't load your projects")} action={<Button size="sm" variant="outline" onClick={() => void refetch()}>{t("Try again")}</Button>}>
          {t("Check your connection and try again.")}
        </Alert>
      ) : !all.length ? (
        archivedView ? (
          <Empty icon={<Archive className="size-7" />} title={t("Nothing archived")}
            sub={t("Projects you archive are tucked away here, not deleted. Restore one any time to bring it back.")}
            action={<Button variant="outline" onClick={() => switchView("active")}>{t("Back to active projects")}</Button>} />
        ) : archivedCount > 0 ? (
          <Empty icon={<Archive className="size-7" />} title={t("No active projects")}
            sub={t("Everything is archived right now. Restore a project or start a new one.")}
            action={(
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" icon={<ArchiveRestore className="size-4" />} onClick={() => switchView("archived")}>{t("View archived")}</Button>
                {canCreate && <Button variant="outline" icon={<Wand2 className="size-4" />} onClick={onWrite}>{t("Write a concept")}</Button>}
              </div>
            )} />
        ) : (
          <FirstProject canCreate={canCreate} onWrite={onWrite} onTemplate={onTemplate} />
        )
      ) : !shown.length ? (
        <Empty icon={<SearchX className="size-7" />} title={t("No projects match")} sub={t("Try a different word or clear the filters.")}
          action={<Button variant="outline" onClick={clear}>{t("Clear filters")}</Button>} />
      ) : (
        <>
          {archivedView && <p className="mb-3 text-xs text-mute">{t("Archived projects are tucked away, not deleted. Restore one to bring it back to your projects.")}</p>}
          {filtering && <p className="mb-3 text-xs text-mute">{t("Showing {n} of {total}", { n: shown.length, total: all.length })}</p>}
          {/* keyed by view so switching lists doesn't animate every card; archiving / restoring animates just that card out */}
          <div key={view} className="relative grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
            <AnimatePresence initial={false} mode="popLayout">
              {shown.map((p, i) => (
                <motion.div
                  key={p.id}
                  layout={shown.length <= 40 ? "position" : false}
                  exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.18 } }}
                  transition={{ type: "spring", stiffness: 420, damping: 38 }}
                >
                  <ProjectCard p={p} index={i} kind={kindOf(p.type)} activity={activity.get(p.id)}
                    archived={archivedView} canManage={canCreate} onArchive={setConfirm} onRestore={(x) => void setArchived(x, false)} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </>
      )}

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        size="sm"
        title={t("Archive this project?")}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>{t("Cancel")}</Button>
            <Button variant="primary" icon={<Archive className="size-4" />} data-autofocus
              onClick={() => { const p = confirm; setConfirm(null); if (p) void setArchived(p, true); }}>
              {t("Archive")}
            </Button>
          </>
        )}
      >
        {confirm && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl border border-line bg-raised/50 p-2.5">
              <MiniThumb src={confirm.thumb_url} hue={hueOf(confirm.id)} className="size-12" icon={confirmKind?.icon} />
              <div className="min-w-0">
                <p className="truncate font-medium">{confirm.title}</p>
                <p className="mt-0.5 truncate text-xs text-mute">{[confirmKind?.label, confirm.aspect, usd(confirm.spent_usd)].filter(Boolean).join(" · ")}</p>
              </div>
            </div>
            <p className="text-sm leading-relaxed text-mute">
              {t("It will be hidden from your projects and the sidebar. Nothing is deleted — you can restore it any time from the Archived view.")}
            </p>
          </div>
        )}
      </Modal>
    </Section>
  );
}
