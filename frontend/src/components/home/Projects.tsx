import "../../styles/home.css";
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  Archive, ArchiveRestore, ArrowUpRight, Clapperboard, FileText, FolderOpen, Gauge, LayoutGrid, LayoutTemplate, Link2, List, MoreHorizontal,
  SearchX, Wand2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { agoT, copyText, fmtDateTime } from "../growth/common";
import { api } from "../../lib/api";
import { LANG_SHORT, usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useJobs, useProjects } from "../../lib/queries";
import type { Project } from "../../lib/types";
import {
  AnimatedNumber, Alert, Avatar, Button, Empty, IconButton, Menu, Meter, Modal, Panel, rise, ScrollStrip, SearchField, Segmented, Select,
  Skeleton, StatusDot, Tag,
} from "../ui";
import { FilterChip, MediaPill as Pill } from "./Chips";
import { type ProjectKind, useProjectKinds } from "./kinds";
import { type DashState, meterCells, useProjectStats } from "./stats";
import { hueOf, MiniThumb, ThumbArt } from "./ThumbArt";
import type { Tone } from "./util";

type Sort = "recent" | "new" | "old" | "name" | "cost";
type View = "active" | "archived";
type Layout = "grid" | "list";
const SORT_KEY = "veo-home-sort";
const LAYOUT_KEY = "veo-home-layout";
const SORTS: Sort[] = ["recent", "new", "old", "name", "cost"];
const PAGE = { grid: 12, list: 20 } as const;

function readSort(): Sort {
  try {
    const v = localStorage.getItem(SORT_KEY) as Sort | null;
    return v && SORTS.includes(v) ? v : "recent";
  } catch {
    return "recent";
  }
}
function readLayout(): Layout {
  try { return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid"; } catch { return "grid"; }
}

interface Activity { running: number; approval: number }
interface PState { tone: Tone; label: string; live?: boolean }

/** One word and one dot for where a production stands. Derived from jobs, the project and its shot counts. */
function useStateOf() {
  const t = useT();
  return (p: Project, act: Activity | undefined, dash: DashState | undefined, archived: boolean): PState => {
    if (archived) return { tone: "neutral", label: t("Archived") };
    if (act?.running) return { tone: "accent", label: t("Generating"), live: true };
    if (act?.approval) return { tone: "warn", label: t("Needs approval") };
    if (p.autopilot?.status === "running") return { tone: "ai", label: t("Autopilot"), live: true };
    const sh = dash?.data?.shots;
    if (sh && sh.total > 0 && sh.approved === sh.total) return { tone: "ok", label: t("Complete") };
    if (sh && sh.in_review > 0) return { tone: "info", label: t("In review") };
    if (sh && sh.total > 0) return { tone: "info", label: t("In progress") };
    return { tone: "neutral", label: t("Draft") };
  };
}

/** The segmented shot meter ("flight path"): one cell per shot, lit when approved. */
function Pipe({ dash, tone = "accent", bare }: { dash: DashState | undefined; tone?: "accent" | "ok"; bare?: boolean }) {
  const t = useT();
  if (!dash || dash.status === "pending") {
    return <div aria-hidden>{!bare && <div className="mb-1.5 flex items-center justify-between"><Skeleton className="h-2.5 w-10" /><Skeleton className="h-2.5 w-8" /></div>}<Skeleton className="h-1.5 w-full" /></div>;
  }
  if (!dash.data) return null; // the numbers failed to load: the card simply has no meter
  const { total, approved } = dash.data.shots;
  const { cells, filled } = meterCells(total, approved);
  return (
    <div>
      {!bare && (
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="eyebrow">{t("Shots")}</span>
          <span className="mono text-2xs text-mute">{total ? <>{approved}<span className="text-dim">/{total}</span></> : <span className="text-dim">—</span>}</span>
        </div>
      )}
      <Meter filled={filled} total={cells} tone={total > 0 && approved === total ? "ok" : tone} />
    </div>
  );
}

interface ItemProps {
  p: Project; index: number; kind: ProjectKind | undefined; activity?: Activity; dash: DashState | undefined;
  /** Showing the archived list: muted look, Restore instead of Archive. */
  archived: boolean;
  /** Creators and above can archive / restore. */
  canManage: boolean;
  onArchive: (p: Project) => void;
  onRestore: (p: Project) => void;
}

/** The "More" menu shared by the card and the list row. */
function ItemMenu({ p, archived, canManage, onArchive, onRestore, className }: Pick<ItemProps, "p" | "archived" | "canManage" | "onArchive" | "onRestore"> & { className?: string }) {
  const t = useT();
  const nav = useNavigate();
  const open = (sub: string) => () => nav(`/p/${p.id}${sub ? `/${sub}` : ""}`);
  return (
    <Menu
      width={188}
      trigger={(tp) => (
        <IconButton title={t("More")} {...tp} className={className}>
          <MoreHorizontal className="size-4" />
        </IconButton>
      )}
      items={[
        archived && canManage && { label: t("Restore"), icon: <ArchiveRestore className="size-4" />, onClick: () => onRestore(p) },
        { label: t("Overview"), icon: <Gauge className="size-4" />, separator: archived && canManage, onClick: open("") },
        { label: t("Open storyboard"), icon: <LayoutGrid className="size-4" />, onClick: open("storyboard") },
        { label: t("Brief"), icon: <FileText className="size-4" />, onClick: open("brief") },
        { label: t("Export"), icon: <Clapperboard className="size-4" />, onClick: open("export") },
        { label: t("Copy link"), icon: <Link2 className="size-4" />, separator: true, onClick: () => void copyText(`${window.location.origin}/p/${p.id}`, t("Link")) },
        !archived && canManage && { label: t("Archive"), icon: <Archive className="size-4" />, separator: true, onClick: () => onArchive(p) },
      ]}
    />
  );
}

function ProductionCard({ p, index, kind, activity, dash, archived, canManage, onArchive, onRestore }: ItemProps) {
  const t = useT();
  const stateOf = useStateOf();
  const r = rise(index);
  const KindIcon = kind?.icon ?? Clapperboard;
  const hue = hueOf(p.id);
  const owner = p.owner;
  const ownerName = owner ? owner.name?.trim() || owner.email.split("@")[0] : "";
  const eps = p.episodes?.length ?? 0;
  const generating = !!activity?.running && !archived;
  const st = stateOf(p, activity, dash, archived);
  // archived pictures lose their colour until you point at them
  const muted = archived ? "grayscale-[0.75] opacity-80 group-hover:grayscale-0 group-hover:opacity-100" : "";
  const tool = "size-8 bg-black/55! text-white! backdrop-blur-sm hover:bg-black/75! hover:text-white! pointer-coarse:size-10";
  const reveal = "opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100";

  return (
    // entrance + generating ring on the wrapper, hover lift on the card (a running CSS animation would otherwise pin the transform)
    <div className={clsx("relative h-full rounded-xl", generating && "gen-ring", r.className)} style={r.style}>
      <article className={clsx("hud lift group relative flex h-full flex-col rounded-xl border border-line bg-panel hover:border-accent/40", archived && "bg-panel/60")}>
        {/* the whole card is one link; its focus ring is drawn inside because the card clips its picture */}
        <Link to={`/p/${p.id}`} aria-label={p.title} className="absolute inset-0 z-10 rounded-xl focus-visible:-outline-offset-2" />

        <div className={clsx("relative aspect-[16/9] shrink-0 overflow-hidden rounded-t-xl bg-raised", generating && "cc-beam")}>
          {p.thumb_url ? (
            <img src={p.thumb_url} alt="" loading="lazy"
              className={clsx("size-full object-cover transition-[transform,filter,opacity] duration-500 ease-out group-hover:scale-[1.05]", p.aspect === "9:16" && "object-[50%_28%]", muted)} />
          ) : (
            <ThumbArt hue={hue} icon={KindIcon} className={clsx("transition-[filter,opacity] duration-500", muted)} />
          )}
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/35" />

          <div className="pointer-events-none absolute left-2.5 top-2.5">
            <Pill className="uppercase tracking-wider"><StatusDot tone={st.tone} live={st.live} />{st.label}</Pill>
          </div>

          <div className="absolute right-2 top-2 z-20 flex gap-1">
            {canManage && (
              <IconButton title={archived ? t("Restore") : t("Archive")} onClick={() => (archived ? onRestore(p) : onArchive(p))} className={clsx(tool, reveal)}>
                {archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
              </IconButton>
            )}
            <ItemMenu p={p} archived={archived} canManage={canManage} onArchive={onArchive} onRestore={onRestore} className={clsx(tool, reveal)} />
          </div>

          <span aria-hidden className="mono pointer-events-none absolute bottom-2 right-2.5 inline-flex translate-y-1 items-center gap-1 text-2xs font-medium uppercase tracking-wider text-white opacity-0 drop-shadow transition-[opacity,transform] duration-200 group-hover:translate-y-0 group-hover:opacity-100">
            {t("Open")}<ArrowUpRight className="size-3" />
          </span>
        </div>

        <div className="flex flex-1 flex-col gap-2.5 p-3">
          <div className="min-w-0">
            <h3 className={clsx("truncate text-sm font-medium leading-snug", archived && "text-mute")} title={p.title}>{p.title}</h3>
            <p className="mt-0.5 line-clamp-1 text-xs text-mute" title={p.concept}>{p.concept}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Tag k={kind?.label ?? p.type}>{p.aspect}</Tag>
            <Tag>{p.languages.map((l) => LANG_SHORT[l] ?? l.toUpperCase()).join(" · ")}</Tag>
            {eps > 1 && <Tag>{t("{n} episodes", { n: eps })}</Tag>}
          </div>
          <Pipe dash={dash} />
          <div className="mt-auto flex items-center justify-between gap-3 border-t border-line pt-2.5 text-xs">
            <span className="flex min-w-0 items-center gap-1.5 text-mute">
              {owner ? <Avatar name={ownerName} size={18} /> : <FolderOpen className="size-4 shrink-0 text-dim" />}
              <span className="truncate">{owner ? ownerName : t("Shared")}</span>
            </span>
            <span className="mono flex shrink-0 items-center gap-1.5 text-2xs">
              <span className="font-medium text-money">{usd(p.spent_usd)}</span>
              <span aria-hidden className="text-dim">·</span>
              <span className="text-dim" title={fmtDateTime(p.updated_at)}>{agoT(p.updated_at)}</span>
            </span>
          </div>
        </div>
      </article>
    </div>
  );
}

/** The dense alternative to the cards: one line per production. */
function ProductionRow({ p, index, kind, activity, dash, archived, canManage, onArchive, onRestore }: ItemProps) {
  const t = useT();
  const stateOf = useStateOf();
  const r = rise(index);
  const hue = hueOf(p.id);
  const KindIcon = kind?.icon ?? Clapperboard;
  const st = stateOf(p, activity, dash, archived);
  const generating = !!activity?.running && !archived;
  const sh = dash?.data?.shots;
  return (
    <div className={clsx("group relative grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 transition-colors hover:bg-hover/40 @2xl:grid-cols-[2.5rem_minmax(0,2fr)_8rem_minmax(7rem,1.1fr)_4.5rem_4.5rem_2rem]", r.className)} style={r.style}>
      <Link to={`/p/${p.id}`} aria-label={p.title} className="absolute inset-0 z-10 focus-visible:-outline-offset-2" />
      <MiniThumb src={p.thumb_url} hue={hue} icon={KindIcon} className={clsx(archived && "grayscale-[0.75] opacity-80")} />
      <div className="min-w-0">
        <p className={clsx("truncate text-sm font-medium", archived && "text-mute")} title={p.title}>{p.title}</p>
        <p className="mono mt-0.5 hidden truncate text-2xs text-dim @2xl:block">
          {kind?.label ?? p.type} · {p.aspect} · {p.languages.map((l) => LANG_SHORT[l] ?? l.toUpperCase()).join(" ")}
        </p>
        <p className="mono mt-0.5 flex items-center gap-1.5 truncate text-2xs text-dim @2xl:hidden">
          <StatusDot tone={st.tone} live={st.live} />{st.label}<span aria-hidden>·</span><span className="text-money">{usd(p.spent_usd)}</span><span aria-hidden>·</span>{agoT(p.updated_at)}
        </p>
      </div>
      <span className="mono hidden items-center gap-1.5 text-2xs uppercase tracking-wider text-mute @2xl:flex">
        <StatusDot tone={st.tone} live={st.live} /><span className="truncate">{st.label}</span>
      </span>
      <div className="hidden items-center gap-2 @2xl:flex">
        <div className="min-w-0 flex-1"><Pipe dash={dash} bare /></div>
        {sh && <span className="mono shrink-0 text-2xs text-dim">{sh.approved}/{sh.total}</span>}
      </div>
      <span className="mono hidden text-right text-2xs text-money @2xl:block">{usd(p.spent_usd)}</span>
      <span className="mono hidden truncate text-right text-2xs text-dim @2xl:block" title={fmtDateTime(p.updated_at)}>{agoT(p.updated_at)}</span>
      <div className="relative z-20 flex items-center justify-end gap-1">
        {generating && <span aria-hidden className="@2xl:hidden"><span className="eq"><i /><i /><i /><i /></span></span>}
        {archived && canManage ? (
          <Button size="sm" variant="outline" className="h-8" icon={<ArchiveRestore className="size-3.5" />} aria-label={t("Restore {title}", { title: p.title })} onClick={() => onRestore(p)}>
            <span className="hidden @2xl:inline">{t("Restore")}</span>
          </Button>
        ) : (
          <ItemMenu p={p} archived={archived} canManage={canManage} onArchive={onArchive} onRestore={onRestore} />
        )}
      </div>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div aria-hidden className="overflow-hidden rounded-xl border border-line bg-panel">
      <Skeleton className="aspect-[16/9] rounded-none" />
      <div className="space-y-2.5 p-3">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-full" />
        <div className="flex gap-1"><Skeleton className="h-5 w-24" /><Skeleton className="h-5 w-14" /></div>
        <Skeleton className="h-1.5 w-full" />
        <div className="flex items-center justify-between border-t border-line pt-3">
          <div className="flex items-center gap-2"><Skeleton className="size-[18px] rounded-full" /><Skeleton className="h-3 w-16" /></div>
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div aria-hidden className="flex items-center gap-3 px-3 py-2.5">
      <Skeleton className="size-10" />
      <div className="flex-1 space-y-2"><Skeleton className="h-3.5 w-1/3" /><Skeleton className="h-2.5 w-1/4" /></div>
      <Skeleton className="h-3 w-16" />
    </div>
  );
}

/** The very first thing a new studio sees where the productions will be. */
function FirstProject({ canCreate, onWrite, onTemplate }: { canCreate: boolean; onWrite: () => void; onTemplate: () => void }) {
  const t = useT();
  if (!canCreate) {
    return <Empty icon={<Clapperboard className="size-7" />} title={t("No projects yet")} sub={t("When your team starts a project it will show up here.")} />;
  }
  const steps = [
    { n: "01", title: t("Describe it"), sub: t("A sentence or two is enough.") },
    { n: "02", title: t("Review the plan"), sub: t("Hooks, script, cast and shots.") },
    { n: "03", title: t("Generate"), sub: t("Approve the cost, get your video.") },
  ];
  return (
    <div className="anim-rise relative overflow-hidden rounded-xl border border-dashed border-line px-4 py-9 text-center sm:py-11">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,color-mix(in_oklab,var(--color-accent)_12%,transparent),transparent_65%)]" />
      <div className="relative mx-auto mb-4 grid size-14 place-items-center">
        <span aria-hidden className="anim-glow absolute inset-0 -m-3 rounded-full bg-accent/20 blur-xl" />
        <span className="hud relative grid size-14 place-items-center rounded-xl border border-accent/30 bg-accent/10 text-accent-ink"><Clapperboard className="size-7" /></span>
      </div>
      <h3 className="relative text-lg font-semibold tracking-tight">{t("Make your first video")}</h3>
      <p className="relative mx-auto mt-1.5 max-w-md text-sm text-mute">{t("Type a concept above and press Start — or pick a template to get going in one click.")}</p>
      <ol className="relative mx-auto mt-6 grid max-w-2xl gap-3 text-left sm:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.n} style={rise(i + 1).style} className={clsx("flex items-start gap-3 rounded-lg border border-line bg-panel/70 p-3", rise(i + 1).className)}>
            <span className="mono mt-px text-xs font-medium text-accent-ink">{s.n}</span>
            <span className="min-w-0"><span className="block text-sm font-medium">{s.title}</span><span className="mt-0.5 block text-xs text-mute">{s.sub}</span></span>
          </li>
        ))}
      </ol>
      <div className="relative mt-6 flex flex-wrap justify-center gap-2">
        <Button variant="primary" icon={<Wand2 className="size-4" />} onClick={onWrite}>{t("Write a concept")}</Button>
        <Button variant="outline" icon={<LayoutTemplate className="size-4" />} onClick={onTemplate}>{t("Try a template")}</Button>
      </div>
    </div>
  );
}

export function ProjectsSection({ canCreate, onWrite, onTemplate, index, className }: {
  canCreate: boolean; onWrite: () => void; onTemplate: () => void; index?: number; className?: string;
}) {
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
  const [layout, setLayout] = useState<Layout>(readLayout);
  const [limit, setLimit] = useState<number>(PAGE[readLayout()]);
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
  const setLayoutPersist = (v: Layout) => {
    setLayout(v);
    try { localStorage.setItem(LAYOUT_KEY, v); } catch { /* private mode */ }
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

  // A new filter or layout starts from the first page again.
  useEffect(() => { setLimit(PAGE[layout]); }, [view, kind, needle, sort, layout]);
  const page = useMemo(() => shown.slice(0, limit), [shown, limit]);
  const stats = useProjectStats(useMemo(() => page.map((p) => p.id), [page]));

  const kindOf = (v: string) => kinds.find((k) => k.value === v);
  const filtering = !!needle || kind !== "all";
  const clear = () => { setQ(""); setKind("all"); };
  const remaining = shown.length - page.length;

  const confirmKind = confirm ? kindOf(confirm.type) : undefined;
  const itemProps = (p: Project, i: number): ItemProps => ({
    p, index: i, kind: kindOf(p.type), activity: activity.get(p.id), dash: stats.byId.get(p.id),
    archived: archivedView, canManage: canCreate, onArchive: setConfirm, onRestore: (x) => void setArchived(x, false),
  });

  return (
    <Panel
      index={index}
      className={className}
      eyebrow={archivedView ? t("Archived projects") : t("Productions")}
      icon={<Clapperboard />}
      actions={all.length > 0 ? (
        <>
          <span className="mono rounded-md bg-raised px-1.5 py-1 text-2xs leading-none text-mute"><AnimatedNumber value={all.length} duration={0.6} /></span>
          <Segmented<Layout>
            aria-label={t("Layout")}
            size="sm"
            value={layout}
            onChange={setLayoutPersist}
            options={[
              { value: "grid", label: <LayoutGrid className="size-3.5" />, title: t("Cards") },
              { value: "list", label: <List className="size-3.5" />, title: t("List") },
            ]}
          />
        </>
      ) : undefined}
    >
      <div className="@container">
        {(all.length > 0 || showSwitch) && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {all.length > 0 && <SearchField value={q} onChange={setQ} placeholder={t("Search projects…")} aria-label={t("Search projects")} className="min-w-[11rem] flex-1 @xl:max-w-xs" />}
            {all.length > 0 && (
              <div className="w-full shrink-0 @xl:w-44">
                <Select value={sort} onChange={(e) => setSortPersist(e.target.value as Sort)} aria-label={t("Sort by")}>
                  <option value="recent">{t("Recently updated")}</option>
                  <option value="new">{t("Newest first")}</option>
                  <option value="old">{t("Oldest first")}</option>
                  <option value="name">{t("Name (A–Z)")}</option>
                  <option value="cost">{t("Most spent")}</option>
                </Select>
              </div>
            )}
            {showSwitch && (
              <div className="anim-pop @xl:ml-auto">
                <Segmented<View>
                  aria-label={t("Project list")}
                  value={view}
                  onChange={switchView}
                  className="h-10 @xl:h-9"
                  options={[
                    { value: "active", label: <span className="flex items-center gap-1.5">{t("Active")}{activeQ.data && <span className="mono text-dim"><AnimatedNumber value={activeQ.data.length} duration={0.5} /></span>}</span> },
                    { value: "archived", label: <span className="flex items-center gap-1.5"><Archive className="size-3.5" />{t("Archived")}<span className="mono text-dim"><AnimatedNumber value={archivedCount} duration={0.5} /></span></span> },
                  ]}
                />
              </div>
            )}
          </div>
        )}

        {all.length > 1 && typeCounts.size > 1 && (
          <ScrollStrip className="-mx-4 mb-4 px-4 py-0.5">
            <div className="flex gap-2 pr-6">
              <FilterChip active={kind === "all"} onClick={() => setKind("all")} count={all.length}>{t("All")}</FilterChip>
              {kinds.filter((k) => typeCounts.has(k.value)).map((k) => (
                <FilterChip key={k.value} active={kind === k.value} onClick={() => setKind(k.value)} count={typeCounts.get(k.value)} icon={<k.icon />}>{k.label}</FilterChip>
              ))}
            </div>
          </ScrollStrip>
        )}

        {isLoading ? (
          layout === "list" ? (
            <div aria-busy="true" className="divide-y divide-line rounded-lg border border-line">{Array.from({ length: 6 }, (_, i) => <RowSkeleton key={i} />)}</div>
          ) : (
            <div aria-busy="true" className="grid grid-cols-[repeat(auto-fill,minmax(15.5rem,1fr))] gap-4">
              {Array.from({ length: 6 }, (_, i) => <CardSkeleton key={i} />)}
            </div>
          )
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
            {filtering && <p className="mono mb-3 text-2xs text-mute">{t("Showing {n} of {total}", { n: shown.length, total: all.length })}</p>}
            {/* keyed by view and layout so switching doesn't animate every item; archiving / restoring animates just that one out */}
            {layout === "grid" ? (
              <div key={`${view}-grid`} className="relative grid grid-cols-[repeat(auto-fill,minmax(15.5rem,1fr))] gap-4">
                <AnimatePresence initial={false} mode="popLayout">
                  {page.map((p, i) => (
                    <motion.div key={p.id} layout={page.length <= 40 ? "position" : false}
                      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.18 } }} transition={{ type: "spring", stiffness: 420, damping: 38 }}>
                      <ProductionCard {...itemProps(p, i)} />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            ) : (
              <div key={`${view}-list`} className="overflow-hidden rounded-lg border border-line">
                <div aria-hidden className="eyebrow hidden grid-cols-[2.5rem_minmax(0,2fr)_8rem_minmax(7rem,1.1fr)_4.5rem_4.5rem_2rem] gap-3 border-b border-line bg-raised/40 px-3 py-2 @2xl:grid">
                  <span /><span>{t("Production")}</span><span>{t("Status")}</span><span>{t("Shots")}</span><span className="text-right">{t("Spend")}</span><span className="text-right">{t("Updated")}</span><span />
                </div>
                <div className="divide-y divide-line">
                  <AnimatePresence initial={false} mode="popLayout">
                    {page.map((p, i) => (
                      <motion.div key={p.id} layout={page.length <= 40 ? "position" : false}
                        exit={{ opacity: 0, transition: { duration: 0.15 } }} transition={{ type: "spring", stiffness: 420, damping: 38 }}>
                        <ProductionRow {...itemProps(p, i)} />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            )}
            {remaining > 0 && (
              <div className="mt-4 flex items-center justify-center gap-3">
                <span className="mono text-2xs text-dim">{page.length} / {shown.length}</span>
                <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + PAGE[layout])}>{t("Show {n} more", { n: Math.min(PAGE[layout], remaining) })}</Button>
              </div>
            )}
          </>
        )}
      </div>

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
                <p className="mt-0.5 truncate text-xs text-mute">{[confirmKind?.label, confirm.aspect].filter(Boolean).join(" · ")} · <span className="mono text-money">{usd(confirm.spent_usd)}</span></p>
              </div>
            </div>
            <p className="text-sm leading-relaxed text-mute">
              {t("It will be hidden from your projects and the sidebar. Nothing is deleted — you can restore it any time from the Archived view.")}
            </p>
          </div>
        )}
      </Modal>
    </Panel>
  );
}
