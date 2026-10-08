import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy } from "@dnd-kit/sortable";
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  Check, Clock, Ellipsis, Film, Image as ImageIcon, LayoutGrid, Mic, Moon, Music, Plus, SquareCheck, Sun, Sunrise, Sunset, WandSparkles,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useGenerate } from "../../components/Generate";
import { engineShort, isAutoEngine, useModelList } from "../../components/hub/util";
import { Button, Empty, IconButton, Kbd, Menu, Progress, ProgressRing, ScrollStrip, Skeleton } from "../../components/ui";
import { api } from "../../lib/api";
import { LANG_SHORT, secs } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useEpisode, useSettings } from "../../lib/queries";
import { useUI } from "../../lib/store";
import type { Scene, Shot } from "../../lib/types";
import { useProjectCtx } from "./context";
import { LoadError } from "./production/LoadError";
import { QualityMenu } from "./production/QualityMenu";
import { ShotCard } from "./production/ShotCard";
import { displayMedia, qcFailed, ratioOf, thumbRatio } from "./production/shotMeta";
import ShotDrawer from "./ShotDrawer";

export { displayMedia };

type Filter = "all" | "kf" | "video" | "qc" | "approved";

const GRID = {
  wide: "grid-cols-[repeat(auto-fill,minmax(200px,1fr))]",
  tall: "grid-cols-[repeat(auto-fill,minmax(164px,1fr))]",
} as const;

export default function Storyboard() {
  const t = useT();
  const { project, eid, lang, canEdit } = useProjectCtx();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { generate } = useGenerate();
  const { data: ep, isLoading, isError, refetch } = useEpisode(eid, lang);
  const { data: settings } = useSettings();
  const selectedShot = useUI((s) => s.selectedShot);
  const setSelectedShot = useUI((s) => s.setSelectedShot);
  const [filter, setFilter] = useState<Filter>("all");
  const [quality, setQuality] = useState("");
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const [order, setOrder] = useState<number[]>([]);
  const [adding, setAdding] = useState(false);
  const [busyAct, setBusyAct] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const threshold = Number(settings?.settings.qc_threshold ?? 0.7);
  const wide = ratioOf(project.aspect).w / ratioOf(project.aspect).h >= 1.2;

  const shots = useMemo(() => (ep?.shots ?? []).filter((s) => s.include), [ep]);
  useEffect(() => setOrder(shots.map((s) => s.id)), [shots.map((s) => s.id).join(",")]);
  const byId = useMemo(() => Object.fromEntries(shots.map((s) => [s.id, s])) as Record<number, Shot>, [shots]);
  const ordered = useMemo(() => order.map((id) => byId[id]).filter(Boolean) as Shot[], [order, byId]);

  // names for pinned engines (shares the Model Hub's cached "enabled" list; only fetched when a shot pins one)
  const anyPinned = shots.some((s) => !isAutoEngine(s.engine));
  const { data: enabledModels } = useModelList({ status: "enabled" }, { enabled: anyPinned });
  const engineNames = useMemo(() => Object.fromEntries((enabledModels?.models ?? []).map((m) => [m.id, m.display_name])) as Record<string, string>, [enabledModels]);

  const counts = useMemo(() => ({
    all: ordered.length,
    kf: ordered.filter((s) => !s.keyframe).length,
    video: ordered.filter((s) => !s.video).length,
    qc: ordered.filter(qcFailed).length,
    approved: ordered.filter((s) => s.status === "approved").length,
  }), [ordered]);

  const visible = useMemo(() => ordered.filter((s) => {
    if (filter === "kf") return !s.keyframe;
    if (filter === "video") return !s.video;
    if (filter === "qc") return qcFailed(s);
    if (filter === "approved") return s.status === "approved";
    return true;
  }), [ordered, filter]);
  const visibleIds = useMemo(() => new Set(visible.map((s) => s.id)), [visible]);

  const groups = useMemo(() => groupByScene(visible, ep?.scenes ?? [], ordered), [visible, ep?.scenes, ordered]);
  const indexOf = useMemo(() => Object.fromEntries(visible.map((s, i) => [s.id, i])) as Record<number, number>, [visible]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const prev = order;
    const next = arrayMove(order, order.indexOf(Number(e.active.id)), order.indexOf(Number(e.over.id)));
    setOrder(next);
    try {
      await api.post(`/api/episodes/${eid}/shots/reorder`, { shot_ids: next });
      qc.invalidateQueries({ queryKey: ["episode", eid] });
    } catch {
      setOrder(prev); // api() showed the error
    }
  };

  /** Next / previous shot that is on screen (skips shots hidden by the filter). */
  const neighbor = useCallback((from: number | null, dir: 1 | -1): number | null => {
    if (!visible.length) return null;
    const i = ordered.findIndex((s) => s.id === from);
    if (i < 0) return dir > 0 ? visible[0].id : visible[visible.length - 1].id;
    for (let k = i + dir; k >= 0 && k < ordered.length; k += dir) if (visibleIds.has(ordered[k].id)) return ordered[k].id;
    return null;
  }, [ordered, visible, visibleIds]);

  /** The card in the row above / below, nearest column (uses the real layout, so it works at any grid width). */
  const rowNeighbor = useCallback((from: number, dir: 1 | -1): number | null => {
    const root = scroller.current;
    if (!root) return null;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-shot-card]"));
    const cur = nodes.find((n) => Number(n.dataset.shotCard) === from);
    if (!cur) return null;
    const cr = cur.getBoundingClientRect();
    const cx = cr.left + cr.width / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const n of nodes) {
      if (n === cur) continue;
      const r = n.getBoundingClientRect();
      const dy = r.top - cr.top;
      if (dir > 0 ? dy <= 12 : dy >= -12) continue;
      const score = Math.abs(dy) * 1000 + Math.abs(r.left + r.width / 2 - cx);
      if (score < bestScore) { best = n; bestScore = score; }
    }
    return best ? Number(best.dataset.shotCard) : null;
  }, []);

  // keyboard: ←/→ previous / next shot, ↑/↓ row above / below, Esc closes (K, V, A live in the drawer)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return;
      if (!selectedShot) return;
      if (document.querySelector("[role=dialog], .fixed.inset-0.z-50")) return; // let modals handle their own keys
      let next: number | null | undefined;
      if (e.key === "ArrowRight") next = neighbor(selectedShot, 1);
      else if (e.key === "ArrowLeft") next = neighbor(selectedShot, -1);
      else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !el.closest?.("aside")) {
        e.preventDefault();
        next = rowNeighbor(selectedShot, e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Escape") { setSelectedShot(null); return; }
      else return;
      if (next != null) setSelectedShot(next);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [selectedShot, neighbor, rowNeighbor, setSelectedShot]);

  // keep the selected card on screen when the selection moves
  useEffect(() => {
    if (!selectedShot) return;
    const id = requestAnimationFrame(() => document.getElementById(`shot-card-${selectedShot}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    return () => cancelAnimationFrame(id);
  }, [selectedShot]);

  // leaving selection mode forgets the selection
  useEffect(() => { if (!picking) setPicked([]); }, [picking]);

  const onOpen = useCallback((id: number) => {
    if (picking) setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
    else setSelectedShot(id);
  }, [picking, setSelectedShot]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusyAct(key);
    try { await fn(); } finally { setBusyAct(null); }
  };

  if (isError && !ep) return <LoadError what={t("the storyboard")} onRetry={() => void refetch()} />;
  if (isLoading || !ep) return <StoryboardSkeleton wide={wide} aspect={project.aspect} />;

  const ids = picking && picked.length ? picked : undefined;
  const total = shots.reduce((a, s) => a + s.duration_s, 0);
  const done = { kf: shots.filter((s) => s.keyframe).length, vid: shots.filter((s) => s.video).length };
  const langShort = LANG_SHORT[lang] ?? lang;
  const pct = shots.length ? done.vid / shots.length : 0;
  const sel = ids ? ` (${ids.length})` : "";

  const addShot = async () => {
    setAdding(true);
    try {
      await api.post(`/api/episodes/${eid}/shots`, { after_shot_id: selectedShot ?? ordered[ordered.length - 1]?.id, action: tr("New shot") });
      qc.invalidateQueries({ queryKey: ["episode", eid] });
    } catch { /* api() showed the error */ } finally { setAdding(false); }
  };

  const two = (title: string, sub: string) => (
    <span className="block">
      <span className="block">{title}</span>
      <span className="block whitespace-normal text-2xs font-normal leading-snug text-dim">{sub}</span>
    </span>
  );
  const moreItems = [
    { icon: <Mic className="size-4" />, label: two(t("Voice + lip-sync {lang}", { lang: langShort }), t("Speak every line, then sync the mouths")),
      onClick: () => void run("lip", () => generate(eid, { action: "lipsync", language: lang, shot_ids: ids }, tr("Voices & lip-sync [{lang}]", { lang: langShort }))) },
    { icon: <Music className="size-4" />, label: two(t("Music"), t("Compose a score for this episode")), onClick: () => void run("music", () => generate(eid, { action: "music" }, tr("Music"))) },
    { icon: <WandSparkles className="size-4" />, label: two(t("Animatic"), t("A quick rough cut with sound, to check pacing")),
      onClick: () => void run("animatic", () => generate(eid, { action: "animatic", language: lang }, tr("Animatic [{lang}]", { lang: langShort }))) },
  ];

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: t("All") }, { id: "kf", label: t("Need keyframe") }, { id: "video", label: t("Need video") },
    { id: "qc", label: t("QC issues") }, { id: "approved", label: t("Approved") },
  ];

  return (
    <div className="@container relative flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* ── toolbar (nothing to summarise or filter while the storyboard is empty) ── */}
        {shots.length > 0 && <div className="shrink-0 border-b border-line bg-panel/60 backdrop-blur">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-5">
            <div className="flex shrink-0 items-center gap-2.5">
              <ProgressRing value={pct} size={38} stroke={4} tone={pct >= 1 ? "var(--color-ok)" : "var(--color-accent)"}>{Math.round(pct * 100)}</ProgressRing>
              <div className="leading-tight">
                <p className="text-sm font-semibold tabular-nums">{t("{vid}/{n} videos", { vid: done.vid, n: shots.length })}</p>
                <p className="text-2xs text-mute">{t("{n} shots", { n: shots.length })} · {secs(total)} · {t("{kf}/{n} keyframes", { kf: done.kf, n: shots.length })}</p>
              </div>
            </div>

            <FilterChips className="min-w-0 flex-1 basis-[260px]" value={filter} onChange={setFilter} filters={filters} counts={counts} />

            {canEdit && (
              <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
                <Button size="sm" variant={picking ? "secondary" : "ghost"} aria-pressed={picking} className={clsx(picking && "border-info/50 text-info")}
                  icon={<SquareCheck className="size-3.5" />} onClick={() => setPicking(!picking)}>{picking ? t("Done") : t("Select")}</Button>
                <span aria-hidden className="mx-0.5 hidden h-5 w-px bg-line sm:block" />
                <div className="flex items-center gap-2">
                  <Button size="sm" icon={<ImageIcon className="size-3.5" />} loading={busyAct === "kf"}
                    onClick={() => run("kf", () => generate(eid, { action: "keyframes", shot_ids: ids, only_missing: !ids }, ids ? tr("Keyframes (selected)") : tr("Keyframes for shots missing one")))}>
                    {t("Keyframes")}{sel}
                  </Button>
                  <div className="inline-flex">
                    <Button size="sm" variant="primary" className="rounded-r-none" icon={<Film className="size-3.5" />} loading={busyAct === "vid"}
                      onClick={() => run("vid", () => generate(eid, { action: "videos", shot_ids: ids, only_missing: !ids, quality: quality || undefined }, ids ? tr("Videos (selected)") : tr("Videos for shots missing one")))}>
                      {t("Videos")}{sel}
                    </Button>
                    <QualityMenu joined value={quality} onChange={setQuality} defaultKey={project.quality_mode} />
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Menu width={288} items={moreItems} trigger={(p) => (
                    <Button size="sm" variant="secondary" icon={<Ellipsis className="size-4" />} loading={busyAct === "lip" || busyAct === "music" || busyAct === "animatic"} {...p}>
                      {t("More")}
                    </Button>
                  )} />
                  <IconButton title={t("Add a shot after the selected one")} disabled={adding} onClick={addShot}>
                    <Plus className={clsx("size-4 transition-transform", adding && "rotate-90")} />
                  </IconButton>
                </div>
              </div>
            )}
          </div>

          <AnimatePresence initial={false}>
            {picking && (
              <motion.div key="pickbar" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-info/20 bg-info/8 px-4 py-1.5 text-xs sm:px-5">
                  <SquareCheck className="size-4 text-info" />
                  <span className="font-medium">{picked.length ? t("{n} selected", { n: picked.length }) : t("Click shots to select them")}</span>
                  <button className="font-medium text-info hover:underline" onClick={() => setPicked(visible.map((s) => s.id))}>{t("Select all {n}", { n: visible.length })}</button>
                  {picked.length > 0 && <button className="text-mute hover:text-ink" onClick={() => setPicked([])}>{t("Clear")}</button>}
                  <span className="text-dim">{picked.length ? t("Generate buttons now apply to the selection.") : t("With nothing selected, generate buttons cover every shot that needs it.")}</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>}

        {/* ── grid ──────────────────────────────────────────────────────────── */}
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {!shots.length ? (
            <div className="p-5">
              <Empty icon={<LayoutGrid className="size-8" />} title={t("No shots yet")}
                sub={t("Write the script, then press 'Plan shots' — or ask the Director to plan them.")}
                action={<Button variant="primary" onClick={() => navigate(`/p/${project.id}/story`)}>{t("Go to Story")}</Button>} />
            </div>
          ) : !visible.length ? (
            <div className="p-5">
              <Empty icon={<LayoutGrid className="size-8" />} title={t("No shots match this filter")}
                action={<Button onClick={() => setFilter("all")}>{t("Show all shots")}</Button>} />
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={visible.map((s) => s.id)} strategy={rectSortingStrategy}>
                <div key={filter}>
                  {groups.map((g) => (
                    <section key={g.key} className="pb-4">
                      {g.title && (
                        <SceneHeader group={g} picking={picking && canEdit}
                          allPicked={g.shots.every((s) => picked.includes(s.id))}
                          onTogglePick={() => {
                            const idsIn = g.shots.map((s) => s.id);
                            setPicked((p) => (idsIn.every((i) => p.includes(i)) ? p.filter((x) => !idsIn.includes(x)) : Array.from(new Set([...p, ...idsIn]))));
                          }} />
                      )}
                      <div className={clsx("grid gap-3 px-4 pt-3 sm:px-5", wide ? GRID.wide : GRID.tall)}>
                        {g.shots.map((s) => (
                          <ShotCard key={s.id} shot={s} lang={lang} aspect={project.aspect} index={indexOf[s.id] ?? 0} threshold={threshold}
                            draggable={canEdit && filter === "all"}
                            selected={selectedShot === s.id} picking={picking} picked={picked.includes(s.id)}
                            engineName={isAutoEngine(s.engine) ? "" : engineNames[s.engine] || engineShort(s.engine)}
                            onOpen={onOpen} />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
          {shots.length > 0 && (
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-4 pb-6 pt-2 text-2xs text-dim sm:px-5">
              {t("Drag to reorder")} · <Kbd>←</Kbd><Kbd>→</Kbd><Kbd>↑</Kbd><Kbd>↓</Kbd> {t("move between shots")} · <Kbd>A</Kbd> {t("approve")} · <Kbd>K</Kbd> {t("keyframe")} · <Kbd>V</Kbd> {t("video")} · <Kbd>Esc</Kbd> {t("close")}
            </p>
          )}
        </div>
      </div>

      <AnimatePresence>
        {selectedShot && byId[selectedShot] && (
          <ShotDrawer key="shot-drawer" shotId={selectedShot} onClose={() => setSelectedShot(null)}
            position={{
              index: Math.max(0, ordered.findIndex((s) => s.id === selectedShot)), total: ordered.length,
              hasPrev: neighbor(selectedShot, -1) != null, hasNext: neighbor(selectedShot, 1) != null,
            }}
            onPrev={() => { const n = neighbor(selectedShot, -1); if (n != null) setSelectedShot(n); }}
            onNext={() => { const n = neighbor(selectedShot, 1); if (n != null) setSelectedShot(n); }} />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── pieces ───────────────────────────────────────────────────────────────────

function FilterChips({ value, onChange, filters, counts, className }: {
  value: Filter; onChange: (f: Filter) => void; filters: { id: Filter; label: string }[]; counts: Record<Filter, number>; className?: string;
}) {
  const id = useId();
  const t = useT();
  return (
    <ScrollStrip role="radiogroup" aria-label={t("Filter shots")} className={clsx("-my-1 py-1", className)}>
      <div className="flex w-max items-center gap-1.5 pr-3">
        {filters.map((f) => {
          const on = value === f.id;
          const n = counts[f.id];
          return (
            <button key={f.id} type="button" role="radio" aria-checked={on} data-active={on || undefined} onClick={() => onChange(f.id)}
              className={clsx("relative inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-medium transition-colors",
                on ? "border-accent/45 text-ink" : "border-line text-mute hover:border-dim/50 hover:text-ink")}>
              {on && <motion.span layoutId={`sbf-${id}`} transition={{ type: "spring", stiffness: 520, damping: 40 }} className="absolute inset-0 rounded-full bg-accent/12" />}
              <span className="relative">{f.label}</span>
              <span className={clsx("relative rounded-full px-1.5 text-2xs font-semibold tabular-nums leading-4", on ? "bg-accent/20 text-accent-ink" : "bg-raised text-dim")}>{n}</span>
            </button>
          );
        })}
      </div>
    </ScrollStrip>
  );
}

const TOD_ICON: [RegExp, ReactNode][] = [
  [/dawn|sunrise|morning/i, <Sunrise key="a" className="size-3" />], [/dusk|sunset|evening/i, <Sunset key="b" className="size-3" />],
  [/night/i, <Moon key="c" className="size-3" />], [/day|noon|afternoon/i, <Sun key="d" className="size-3" />],
];

interface Group { key: string; scene: string; title: string; tod: string; sub: string; shots: Shot[]; done: number; all: number }

function SceneHeader({ group, picking, allPicked, onTogglePick }: { group: Group; picking: boolean; allPicked: boolean; onTogglePick: () => void }) {
  const t = useT();
  const frac = group.all ? group.done / group.all : 0;
  const todIcon = TOD_ICON.find(([re]) => re.test(group.tod))?.[1] ?? <Clock className="size-3" />;
  return (
    <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-line/70 bg-bg/92 px-4 py-2 backdrop-blur-md sm:px-5">
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <h3 className="shrink-0 text-sm font-semibold tracking-tight">{group.title}</h3>
        {group.tod && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-raised px-1.5 py-0.5 text-2xs font-medium text-mute">{todIcon}{group.tod}</span>}
        {group.sub && <span className="hidden min-w-0 truncate text-2xs text-dim @2xl:inline" title={group.sub}>{group.sub}</span>}
      </div>
      {picking && (
        <button type="button" onClick={onTogglePick} className="shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-medium text-info hover:bg-info/10">
          {allPicked ? t("Deselect scene") : t("Select scene")}
        </button>
      )}
      <div className="flex shrink-0 items-center gap-2" title={t("{vid}/{n} videos", { vid: group.done, n: group.all })}>
        <span className="w-16 sm:w-24"><Progress value={frac} size="sm" tone={frac >= 1 ? "ok" : "accent"} /></span>
        <span className={clsx("w-8 text-right text-2xs font-medium tabular-nums", frac >= 1 ? "text-ok" : "text-mute")}>{group.done}/{group.all}</span>
        {frac >= 1 && <Check className="-ml-1 size-3.5 text-ok" strokeWidth={3} />}
      </div>
    </div>
  );
}

function groupByScene(shots: Shot[], scenes: Scene[], all: Shot[]): Group[] {
  const out: Group[] = [];
  for (const s of shots) {
    const last = out[out.length - 1];
    const scene = String(s.scene_id ?? "none");
    if (last && last.scene === scene) last.shots.push(s);
    else {
      const sc = scenes.find((x) => x.id === s.scene_id);
      const inScene = all.filter((x) => String(x.scene_id ?? "none") === scene);
      out.push({
        key: `${scene}-${out.length}`, scene, title: sc?.title ?? "", tod: sc?.time_of_day ?? "", sub: sc?.summary ?? "", shots: [s],
        done: inScene.filter((x) => x.video).length, all: inScene.length,
      });
    }
  }
  return out;
}

function StoryboardSkeleton({ wide, aspect }: { wide: boolean; aspect: string }) {
  return (
    <div className="flex h-full flex-col" aria-busy="true">
      <div className="flex shrink-0 flex-wrap items-center gap-4 border-b border-line bg-panel/60 px-5 py-2.5">
        <div className="flex items-center gap-2.5"><Skeleton className="size-[38px] rounded-full" /><div className="space-y-1.5"><Skeleton className="h-3.5 w-24" /><Skeleton className="h-2.5 w-36" /></div></div>
        <div className="flex gap-1.5">{[64, 104, 96, 88, 84].map((w, i) => <Skeleton key={i} className="h-7 rounded-full" style={{ width: w }} />)}</div>
        <div className="flex-1" />
        <div className="flex gap-2"><Skeleton className="h-7 w-16" /><Skeleton className="h-7 w-24" /><Skeleton className="h-7 w-28" /><Skeleton className="h-7 w-20" /></div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line/70 px-5 py-2"><Skeleton className="h-4 w-20" /><Skeleton className="h-4 w-14 rounded-full" /><div className="flex-1" /><Skeleton className="h-1.5 w-24 rounded-full" /></div>
        <div className={clsx("grid gap-3 px-5 pt-3", wide ? GRID.wide : GRID.tall)}>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-line bg-panel">
              <Skeleton className="rounded-none" style={{ aspectRatio: thumbRatio(aspect) }} />
              <div className="space-y-2 p-2.5"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-3/5" /><div className="flex gap-1"><Skeleton className="size-5" /><Skeleton className="size-5" /><Skeleton className="size-5" /></div></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
