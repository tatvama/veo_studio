import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy } from "@dnd-kit/sortable";
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  Check, ChevronDown, Clock, Ellipsis, Film, Image as ImageIcon, Layers, LayoutGrid, Mic, Moon, Music, Plus, SquareCheck, Sun, Sunrise, Sunset,
  Users, WandSparkles, X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StoryboardFramesModal } from "../../components/board/StoryboardFrames";
import { useGenerate } from "../../components/Generate";
import { engineShort, isAutoEngine, useModelList } from "../../components/hub/util";
import { Avatar, Button, Empty, IconButton, Kbd, Menu, Meter, ProgressRing, ScrollStrip, Skeleton } from "../../components/ui";
import { api } from "../../lib/api";
import { LANG_SHORT, secs } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useCharacters, useEpisode, useSettings } from "../../lib/queries";
import { useUI } from "../../lib/store";
import type { Character, Scene, Shot } from "../../lib/types";
import { useProjectCtx } from "./context";
import { RailSeg } from "./production/instruments";
import { LoadError } from "./production/LoadError";
import { QualityMenu } from "./production/QualityMenu";
import { ShotCard, type CardFace } from "./production/ShotCard";
import { displayMedia, qcFailed, ratioOf, thumbRatio } from "./production/shotMeta";
import { isOwnMaterial } from "./flow";
import { MakeItForMe } from "./MakeItForMe";
import { openImport } from "./importEvent";
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
  const [makeOpen, setMakeOpen] = useState(false);
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
  // storyboard frames (start + end frames in order) for some scenes or the picked shots
  const [framesFor, setFramesFor] = useState<{ sceneIds?: number[]; shotIds?: number[]; scope: string } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const threshold = Number(settings?.settings.qc_threshold ?? 0.7);
  const wide = ratioOf(project.aspect).w / ratioOf(project.aspect).h >= 1.2;

  const shots = useMemo(() => (ep?.shots ?? []).filter((s) => s.include), [ep]);
  useEffect(() => setOrder(shots.map((s) => s.id)), [shots.map((s) => s.id).join(",")]);
  const byId = useMemo(() => Object.fromEntries(shots.map((s) => [s.id, s])) as Record<number, Shot>, [shots]);
  const ordered = useMemo(() => order.map((id) => byId[id]).filter(Boolean) as Shot[], [order, byId]);

  // the cast: faces on the cards, and "Who" (one character's shots only)
  const { data: cast } = useCharacters(project.id);
  const [who, setWho] = useState<number | null>(null);
  const faceOf = useMemo(() => Object.fromEntries((cast ?? []).map((c) => [c.id, { id: c.id, name: c.name, avatar_url: c.avatar_url }])) as Record<number, CardFace>, [cast]);
  const facesOf = useCallback((s: Shot) => (s.characters ?? []).map((id) => faceOf[Number(id)]).filter(Boolean), [faceOf]);
  const inShot = useCallback((s: Shot, cid: number) => (s.characters ?? []).some((id) => Number(id) === cid), []);
  const people = useMemo(() => (cast ?? []).map((c) => ({ c, n: ordered.filter((s) => inShot(s, c.id)).length })).filter((p) => p.n > 0), [cast, ordered, inShot]);
  useEffect(() => { if (who && cast && !cast.some((c) => c.id === who)) setWho(null); }, [cast, who]);
  const base = useMemo(() => (who ? ordered.filter((s) => inShot(s, who)) : ordered), [ordered, who, inShot]);

  // names for pinned engines (shares the Model Hub's cached "enabled" list; only fetched when a shot pins one)
  const anyPinned = shots.some((s) => !isAutoEngine(s.engine));
  const { data: enabledModels } = useModelList({ status: "enabled" }, { enabled: anyPinned });
  const engineNames = useMemo(() => Object.fromEntries((enabledModels?.models ?? []).map((m) => [m.id, m.display_name])) as Record<string, string>, [enabledModels]);

  const counts = useMemo(() => ({
    all: base.length,
    kf: base.filter((s) => !s.keyframe).length,
    video: base.filter((s) => !s.video).length,
    qc: base.filter(qcFailed).length,
    approved: base.filter((s) => s.status === "approved").length,
  }), [base]);

  const visible = useMemo(() => base.filter((s) => {
    if (filter === "kf") return !s.keyframe;
    if (filter === "video") return !s.video;
    if (filter === "qc") return qcFailed(s);
    if (filter === "approved") return s.status === "approved";
    return true;
  }), [base, filter]);
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

  // keyboard: ←/→ previous / next shot, ↑/↓ row above / below, Esc closes (A, approve, lives in the drawer; nothing that costs money is on one key)
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
  // with "Who" set, the make buttons cover that person's shots (only what they still need, unless shots are picked)
  const scopeIds = ids ?? (who ? base.map((s) => s.id) : undefined);
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
    { icon: <Mic className="size-4" />, label: two(t("Voice + mouth sync {lang}", { lang: langShort }), t("Speak every line, then match the lips")),
      onClick: () => void run("lip", () => generate(eid, { action: "lipsync", language: lang, shot_ids: ids }, tr("Voices & mouth sync [{lang}]", { lang: langShort }))) },
    { icon: <Music className="size-4" />, label: two(t("Music"), t("Compose a score for this episode")), onClick: () => void run("music", () => generate(eid, { action: "music" }, tr("Music"))) },
    { icon: <WandSparkles className="size-4" />, label: two(t("Animatic"), t("A quick rough cut with sound, to check pacing")),
      onClick: () => void run("animatic", () => generate(eid, { action: "animatic", language: lang }, tr("Animatic [{lang}]", { lang: langShort }))) },
  ];

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: t("All") }, { id: "kf", label: t("Need picture") }, { id: "video", label: t("Need video") },
    { id: "qc", label: t("Quality issues") }, { id: "approved", label: t("Approved") },
  ];

  return (
    <div className="@container relative flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* ── one toolbar: how far it got, the filters, who, and the actions (nothing to filter while the storyboard is empty) ── */}
        {shots.length > 0 && <div className="relative shrink-0 border-b border-line bg-panel/75 backdrop-blur">
          <span aria-hidden className="edge-light pointer-events-none absolute inset-x-6 top-0 h-px opacity-70" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-2 py-1.5 sm:px-3">
            <div className="flex shrink-0 items-center gap-2" title={`${t("{vid}/{n} videos", { vid: done.vid, n: shots.length })} · ${t("{kf}/{n} pictures", { kf: done.kf, n: shots.length })} · ${secs(total)}`}>
              <ProgressRing value={pct} size={30} stroke={3} tone={pct >= 1 ? "var(--color-ok)" : "var(--color-accent)"}>{Math.round(pct * 100)}</ProgressRing>
              <span className="mono flex flex-col text-2xs leading-tight">
                <span className="eyebrow">{t("Videos")}</span>
                <span className="font-medium"><span className={pct >= 1 ? "text-ok" : "text-ink"}>{done.vid}</span><span className="text-dim">/{shots.length}</span></span>
              </span>
            </div>
            <FilterRail className="min-w-0 flex-1 basis-[260px]" value={filter} onChange={setFilter} filters={filters} counts={counts} />
            {people.length > 0 && <WhoFilter people={people} value={who} onChange={setWho} />}

            {canEdit && (
              <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
                <Button size="sm" variant={picking ? "secondary" : "ghost"} aria-pressed={picking} className={clsx(picking && "border-info/50 text-info")}
                  icon={<SquareCheck className="size-3.5" />} onClick={() => setPicking(!picking)}>{picking ? t("Done") : t("Select")}</Button>
                <span aria-hidden className="tick-v hidden h-5 sm:block" />
                <div className="flex items-center gap-2">
                  <Button size="sm" icon={<ImageIcon className="size-3.5" />} loading={busyAct === "kf"}
                    onClick={() => run("kf", () => generate(eid, { action: "keyframes", shot_ids: scopeIds, only_missing: !ids }, ids ? tr("Pictures (selected)") : tr("Pictures for shots missing one")))}>
                    {t("Pictures")}{sel}
                  </Button>
                  <Button size="sm" icon={<Layers className="size-3.5" />} title={t("Start and end frames for every shot, made in order (each follows the one before); optionally synced so the clips join without a jump")}
                    onClick={() => setFramesFor(ids ? { shotIds: ids, scope: t("{n} selected shots", { n: ids.length }) } : { scope: t("Every scene") })}>
                    {t("Frames")}{sel}
                  </Button>
                  <div className="inline-flex">
                    <Button size="sm" variant="primary" className="rounded-r-none" icon={<Film className="size-3.5" />} loading={busyAct === "vid"}
                      onClick={() => run("vid", () => generate(eid, { action: "videos", shot_ids: scopeIds, only_missing: !ids, quality: quality || undefined }, ids ? tr("Videos (selected)") : tr("Videos for shots missing one")))}>
                      {t("Videos")}{sel}
                    </Button>
                    <QualityMenu joined value={quality} onChange={setQuality} defaultKey={project.quality_mode} />
                  </div>
                </div>
                <span aria-hidden className="tick-v hidden h-5 sm:block" />
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
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-info/25 bg-info/8 px-3 py-1.5 text-xs">
                  <SquareCheck className="size-4 text-info" />
                  <span className="mono font-medium">{picked.length ? t("{n} selected", { n: picked.length }) : t("Click shots to select them")}</span>
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
                sub={isOwnMaterial(project) ? t("Bring your script and we turn it into shots: paste it or upload a Word, PDF or text file.")
                  : t("Bring your script and we turn it into shots, or let the studio make the whole film from your idea.")}
                action={canEdit ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button variant="primary" onClick={() => openImport()}>{t("Import script")}</Button>
                    {!isOwnMaterial(project) && <Button onClick={() => setMakeOpen(true)}>{t("Make it for me")}</Button>}
                  </div>
                ) : undefined} />
              <MakeItForMe open={makeOpen} onClose={() => setMakeOpen(false)} hasShots={false} />
            </div>
          ) : !visible.length ? (
            <div className="p-5">
              <Empty icon={<LayoutGrid className="size-8" />} title={t("No shots match this filter")}
                action={<Button onClick={() => { setFilter("all"); setWho(null); }}>{t("Show all shots")}</Button>} />
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={visible.map((s) => s.id)} strategy={rectSortingStrategy}>
                <div key={`${filter}-${who ?? ""}`}>
                  {groups.map((g) => (
                    <section key={g.key} className="pb-5">
                      {g.title && (
                        <SceneHeader group={g} picking={picking && canEdit}
                          onFrames={canEdit && g.scene !== "none" ? () => setFramesFor({ sceneIds: [Number(g.scene)], scope: g.no ? t("Scene {n}", { n: g.no }) : g.title }) : undefined}
                          allPicked={g.shots.every((s) => picked.includes(s.id))}
                          onTogglePick={() => {
                            const idsIn = g.shots.map((s) => s.id);
                            setPicked((p) => (idsIn.every((i) => p.includes(i)) ? p.filter((x) => !idsIn.includes(x)) : Array.from(new Set([...p, ...idsIn]))));
                          }} />
                      )}
                      <div className={clsx("grid gap-3 px-3 pt-3 sm:px-4", wide ? GRID.wide : GRID.tall)}>
                        {g.shots.map((s) => (
                          <ShotCard key={s.id} shot={s} lang={lang} aspect={project.aspect} index={indexOf[s.id] ?? 0} threshold={threshold}
                            draggable={canEdit && filter === "all" && !who}
                            selected={selectedShot === s.id} picking={picking} picked={picked.includes(s.id)}
                            engineName={isAutoEngine(s.engine) ? "" : engineNames[s.engine] || engineShort(s.engine)}
                            onOpen={onOpen} faces={facesOf(s)} />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
          {shots.length > 0 && (
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-3 pb-6 pt-2 text-2xs text-dim sm:px-4">
              {t("Drag to reorder")} · <Kbd>←</Kbd><Kbd>→</Kbd><Kbd>↑</Kbd><Kbd>↓</Kbd> {t("move between shots")} · <Kbd>A</Kbd> {t("approve")} · <Kbd>Esc</Kbd> {t("close")}
            </p>
          )}
        </div>
      </div>

      <StoryboardFramesModal open={!!framesFor} onClose={() => setFramesFor(null)} projectId={project.id} eid={eid}
        sceneIds={framesFor?.sceneIds} shotIds={framesFor?.shotIds} scope={framesFor?.scope ?? ""} />

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

function FilterRail({ value, onChange, filters, counts, className }: {
  value: Filter; onChange: (f: Filter) => void; filters: { id: Filter; label: string }[]; counts: Record<Filter, number>; className?: string;
}) {
  const t = useT();
  return (
    <ScrollStrip className={clsx("-my-1 py-1", className)}>
      <RailSeg label={t("Filter shots")} value={value} onChange={onChange} className="w-max"
        options={filters.map((f) => ({ value: f.id, label: f.label, count: counts[f.id] }))} />
    </ScrollStrip>
  );
}

/** "Who": pick a character to see only the shots they are in (a face and a count per person). */
function WhoFilter({ people, value, onChange }: { people: { c: Character; n: number }[]; value: number | null; onChange: (id: number | null) => void }) {
  const t = useT();
  const cur = people.find((p) => p.c.id === value)?.c;
  return (
    <span className="inline-flex shrink-0 items-center">
      <Menu placement="bottom-start" width={240} items={[
        { label: t("Everyone"), icon: <Users className="size-4" />, active: value === null, onClick: () => onChange(null) },
        ...people.map((p, i) => ({
          label: <span className="flex min-w-0 items-center justify-between gap-2"><span className="truncate">{p.c.name}</span><span className="mono text-2xs text-dim">{p.n}</span></span>,
          icon: <Avatar name={p.c.name} src={p.c.avatar_url || undefined} size={20} />, active: value === p.c.id, separator: i === 0, onClick: () => onChange(p.c.id),
        })),
      ]} trigger={(tp) => (
        <button type="button" {...tp} aria-label={cur ? t("Who: {name}", { name: cur.name }) : t("Who: everyone")}
          className={clsx("inline-flex h-8 items-center gap-1.5 border px-2 text-xs font-medium transition-colors max-sm:h-10",
            cur ? "rounded-l-lg border-accent/45 bg-accent/10 text-ink" : "rounded-lg border-line bg-raised/60 text-mute hover:text-ink")}>
          {cur ? <Avatar name={cur.name} src={cur.avatar_url || undefined} size={20} /> : <Users className="size-3.5" />}
          <span className="max-w-[8rem] truncate">{cur ? cur.name : t("Who")}</span>
          <ChevronDown className="size-3 text-dim" />
        </button>
      )} />
      {cur && (
        <button type="button" onClick={() => onChange(null)} aria-label={t("Show everyone")} title={t("Show everyone")}
          className="-ml-px grid h-8 w-7 place-items-center rounded-r-lg border border-accent/45 bg-accent/10 text-mute transition-colors hover:text-ink max-sm:h-10 max-sm:w-10">
          <X className="size-3.5" />
        </button>
      )}
    </span>
  );
}

const TOD_ICON: [RegExp, ReactNode][] = [
  [/dawn|sunrise|morning/i, <Sunrise key="a" className="size-3" />], [/dusk|sunset|evening/i, <Sunset key="b" className="size-3" />],
  [/night/i, <Moon key="c" className="size-3" />], [/day|noon|afternoon/i, <Sun key="d" className="size-3" />],
];

interface Group { key: string; scene: string; no: number; title: string; tod: string; sub: string; shots: Shot[]; done: number; all: number }

/** A sticky mono rail above each scene: "SC01 · title · DUSK · 4 SHOTS" and a segmented progress meter. */
function SceneHeader({ group, picking, allPicked, onTogglePick, onFrames }: {
  group: Group; picking: boolean; allPicked: boolean; onTogglePick: () => void; onFrames?: () => void;
}) {
  const t = useT();
  const frac = group.all ? group.done / group.all : 0;
  const todIcon = TOD_ICON.find(([re]) => re.test(group.tod))?.[1] ?? <Clock className="size-3" />;
  const cells = Math.max(1, Math.min(group.all, 10));
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-line/70 bg-bg/90 px-3 py-1.5 backdrop-blur-md sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="mono inline-flex h-5 shrink-0 items-center rounded border border-accent/30 bg-accent/10 px-1.5 text-2xs font-semibold tracking-wide text-accent-ink">
          {group.no ? `SC${String(group.no).padStart(2, "0")}` : "—"}
        </span>
        <h3 className="min-w-0 truncate text-xs font-semibold tracking-tight">{group.title}</h3>
        {group.tod && <span className="mono inline-flex shrink-0 items-center gap-1 text-2xs uppercase tracking-wider text-mute">· {todIcon}{group.tod}</span>}
        <span className="mono shrink-0 text-2xs uppercase tracking-wider text-dim">· {t("{n} shots", { n: group.all })}</span>
        {group.sub && <span className="hidden min-w-0 truncate text-2xs text-dim @2xl:inline" title={group.sub}>{group.sub}</span>}
      </div>
      {picking && (
        <button type="button" onClick={onTogglePick} className="shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-medium text-info hover:bg-info/10">
          {allPicked ? t("Deselect scene") : t("Select scene")}
        </button>
      )}
      {onFrames && !picking && (
        <button type="button" onClick={onFrames} title={t("Start and end frames for this scene's shots, in order")}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium text-mute transition-colors hover:bg-hover hover:text-ink">
          <Layers className="size-3" />{t("Frames")}
        </button>
      )}
      <div className="flex shrink-0 items-center gap-2" title={t("{vid}/{n} videos", { vid: group.done, n: group.all })}>
        <Meter className="w-14 sm:w-24" filled={Math.round(frac * cells)} total={cells} tone={frac >= 1 ? "ok" : "accent"} />
        <span className={clsx("mono w-9 text-right text-2xs font-medium tabular-nums", frac >= 1 ? "text-ok" : "text-mute")}>{group.done}/{group.all}</span>
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
        key: `${scene}-${out.length}`, scene, no: sc ? scenes.indexOf(sc) + 1 : 0, title: sc?.title ?? "", tod: sc?.time_of_day ?? "", sub: sc?.summary ?? "", shots: [s],
        done: inScene.filter((x) => x.video).length, all: inScene.length,
      });
    }
  }
  return out;
}

function StoryboardSkeleton({ wide, aspect }: { wide: boolean; aspect: string }) {
  return (
    <div className="flex h-full flex-col" aria-busy="true">
      <div className="shrink-0 border-b border-line bg-panel/75">
        <div className="flex flex-wrap items-center gap-3 px-3 py-1.5">
          <div className="flex items-center gap-2"><Skeleton className="size-[30px] rounded-full" /><div className="space-y-1"><Skeleton className="h-2.5 w-10" /><Skeleton className="h-3 w-8" /></div></div>
          <Skeleton className="h-8 w-[22rem] max-w-full" />
          <div className="flex-1" />
          <div className="flex gap-2"><Skeleton className="h-7 w-16" /><Skeleton className="h-7 w-24" /><Skeleton className="h-7 w-28" /><Skeleton className="h-7 w-20" /></div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line/70 px-4 py-2"><Skeleton className="h-5 w-12" /><Skeleton className="h-3.5 w-28" /><div className="flex-1" /><Skeleton className="h-1.5 w-24" /></div>
        <div className={clsx("grid gap-3 px-4 pt-3", wide ? GRID.wide : GRID.tall)}>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-line bg-panel">
              <Skeleton className="h-7 rounded-none" />
              <div className="p-1.5 pb-0"><Skeleton className="rounded-md" style={{ aspectRatio: thumbRatio(aspect) }} /></div>
              <div className="space-y-2 p-2.5"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-3/5" /><div className="grid grid-cols-5 gap-1.5"><Skeleton className="h-5" /><Skeleton className="h-5" /><Skeleton className="h-5" /><Skeleton className="h-5" /><Skeleton className="h-5" /></div></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
