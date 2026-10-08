import "dockview-react/dist/styles/dockview.css";
import "./studio.css";
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type DockviewTheme, type IDockviewHeaderActionsProps, type IDockviewPanelProps } from "dockview-react";
import { Clapperboard, ExternalLink, Film, LayoutGrid, ListTree, Maximize2, PanelsTopLeft, RotateCcw, Sparkles, UsersRound, Workflow } from "lucide-react";
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useGenerate } from "../../../components/Generate";
import { Avatar, Button, Menu, PageSkeleton, Tooltip } from "../../../components/ui";
import { api } from "../../../lib/api";
import { tr, useT } from "../../../lib/i18n";
import { useCharacters, useEpisode } from "../../../lib/queries";
import type { Shot, SubmitResult } from "../../../lib/types";
import { nextShot, type NextShotIn } from "../../../lib/v3";
import { useProjectCtx } from "../context";
import ShotDrawer from "../ShotDrawer";
import { linkOf, type LinkMode } from "./continuity";
import { CastPanel, EmptyStudio, Outline, outlineOrder, type DragData } from "./Outline";
import { StudioCtx, useStudio, type StudioState } from "./state";

const TimelinePage = lazy(() => import("../Timeline"));
const FilmMap = lazy(() => import("./FilmMap"));
const FxEditor = lazy(() => import("../../../components/fx/FxEditor").then((m) => ({ default: m.FxEditor })));

const THEME: DockviewTheme = { name: "veo", className: "dockview-theme-veo", gap: 6, dndOverlayMounting: "absolute" };
const LAYOUT_KEY = "veo:studio-layout:v3";

const PANELS: Record<string, { title: string; icon: typeof Film }> = {
  outline: { title: "Scenes & shots", icon: ListTree },
  map: { title: "Film map", icon: Workflow },
  cast: { title: "Cast", icon: UsersRound },
  shot: { title: "Shot", icon: Clapperboard },
  fx: { title: "Effects", icon: Sparkles },
  timeline: { title: "Timeline", icon: Film },
};

function OutlinePanel() {
  const s = useStudio();
  if (!s.episode) return <PageSkeleton cards={3} />;
  if (!(s.episode.shots ?? []).some((x) => x.include)) return <EmptyStudio onStart={s.goShots} />;
  return <Outline episode={s.episode} cast={s.cast} selected={s.selected} onSelect={s.select} onAddShot={s.addShot} canEdit={s.canEdit} />;
}

function CastPanelView() {
  const s = useStudio();
  return <CastPanel cast={s.cast} onOpenCharacters={s.goCharacters} canEdit={s.canEdit} />;
}

function ShotPanel() {
  const t = useT();
  const s = useStudio();
  const order = s.episode ? outlineOrder(s.episode) : [];
  const i = s.selected != null ? order.indexOf(s.selected) : -1;
  if (s.selected == null || i < 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-mute">
        <div className="space-y-2">
          <Clapperboard className="mx-auto size-8 text-dim" />
          <p>{t("Pick a shot on the left to see it here: its takes, prompt, characters and the buttons to make it.")}</p>
        </div>
      </div>
    );
  }
  return (
    <ShotDrawer key={s.selected} shotId={s.selected} embedded onClose={() => s.select(null)}
      position={{ index: i, total: order.length, hasPrev: i > 0, hasNext: i < order.length - 1 }}
      onPrev={() => i > 0 && s.select(order[i - 1])} onNext={() => i < order.length - 1 && s.select(order[i + 1])} />
  );
}

function FxPanel() {
  const t = useT();
  const s = useStudio();
  if (s.selected == null) {
    return <div className="grid h-full place-items-center p-6 text-center text-sm text-mute">{t("Pick a shot to add transitions, looks, speed changes and camera moves.")}</div>;
  }
  return <Suspense fallback={<PageSkeleton cards={2} />}><FxEditor shotId={s.selected} /></Suspense>;
}

function MapPanel() {
  return <Suspense fallback={<PageSkeleton cards={2} />}><FilmMap /></Suspense>;
}

function TimelinePanel() {
  return <Suspense fallback={<PageSkeleton cards={2} />}><TimelinePage embedded /></Suspense>;
}

const COMPONENTS: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  outline: OutlinePanel, map: MapPanel, cast: CastPanelView, shot: ShotPanel, fx: FxPanel, timeline: TimelinePanel,
};

/** Group header buttons: send the group to another window (second monitor) or float it. */
function HeaderActions({ containerApi, group, activePanel, location }: IDockviewHeaderActionsProps) {
  const t = useT();
  if (!activePanel) return null;
  const popped = location?.type === "popout";
  return (
    <div className="flex h-full items-center gap-0.5 px-1">
      {!popped && (
        <Tooltip content={t("Open in its own window (e.g. on a second screen)")}>
          <button type="button" aria-label={t("Open in its own window")}
            onClick={() => void containerApi.addPopoutGroup(group, {
              popoutUrl: "/popout.html",
              onDidOpen: ({ window: w }) => { w.document.documentElement.dataset.theme = document.documentElement.dataset.theme ?? ""; },
            }).then((ok) => { if (!ok) toast.error(tr("The browser blocked the new window — allow pop-ups for this site and try again.")); })}
            className="grid size-6 place-items-center rounded-md text-dim hover:bg-hover hover:text-ink"><ExternalLink className="size-3.5" /></button>
        </Tooltip>
      )}
      {location?.type === "grid" && (
        <Tooltip content={t("Float this panel over the others")}>
          <button type="button" aria-label={t("Float this panel")} onClick={() => containerApi.addFloatingGroup(group)}
            className="grid size-6 place-items-center rounded-md text-dim hover:bg-hover hover:text-ink"><Maximize2 className="size-3.5" /></button>
        </Tooltip>
      )}
    </div>
  );
}

/** PATCH /api/shots responses list the takes an edit just made stale; say so once. */
function announceStale(ids?: number[]) {
  if (!ids?.length) return;
  toast.message(ids.length === 1 ? tr("1 earlier take is now marked stale") : tr("{n} earlier takes are now marked stale", { n: ids.length }));
}

function defaultLayout(api: DockviewApi) {
  api.clear();
  api.addPanel({ id: "outline", component: "outline", title: tr(PANELS.outline.title) });
  api.addPanel({ id: "map", component: "map", title: tr(PANELS.map.title), position: { referencePanel: "outline", direction: "right" } });
  // narrow screens: the shot sits as a tab next to the map instead of squeezing it
  const wide = window.innerWidth >= 1200;
  api.addPanel({ id: "shot", component: "shot", title: tr(PANELS.shot.title), position: { referencePanel: "map", direction: wide ? "right" : "within" } });
  api.addPanel({ id: "fx", component: "fx", title: tr(PANELS.fx.title), position: { referencePanel: "shot", direction: "within" }, inactive: true });
  api.addPanel({ id: "cast", component: "cast", title: tr(PANELS.cast.title), position: { referencePanel: "outline", direction: "below" } });
  api.addPanel({ id: "timeline", component: "timeline", title: tr(PANELS.timeline.title), position: { direction: "below" } });
  try {
    api.getPanel("outline")?.group.api.setSize({ width: 300 });
    if (wide) api.getPanel("shot")?.group.api.setSize({ width: Math.max(380, Math.round(window.innerWidth * 0.28)) });
    else api.getPanel("map")?.api.setActive();
    api.getPanel("cast")?.group.api.setSize({ height: 210 });
    api.getPanel("timeline")?.group.api.setSize({ height: Math.round(window.innerHeight * 0.48) });
  } catch { /* sizes are a nicety */ }
}

/**
 * The one-screen Studio: scenes & shots, cast, the selected shot (takes, prompt, generate) and the timeline, as panels
 * you can resize, rearrange, float or pop out to another screen. The layout is remembered per browser.
 */
export default function StudioPage() {
  const t = useT();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { project, eid, lang, canEdit } = useProjectCtx();
  const { data: episode } = useEpisode(eid, lang);
  const { data: cast } = useCharacters(project.id);
  const { submit } = useGenerate();
  const [selected, setSelected] = useState<number | null>(null);
  const [dragging, setDragging] = useState<DragData | null>(null);
  const apiRef = useRef<DockviewApi | null>(null);
  const [open, setOpen] = useState<string[]>(Object.keys(PANELS));
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["episode"] });
    qc.invalidateQueries({ queryKey: ["board"] });
    qc.invalidateQueries({ queryKey: ["shot"] });
  }, [qc]);

  const addShot = useCallback(async (sceneId: number | null) => {
    if (!episode) return;
    const inScene = (episode.shots ?? []).filter((s) => s.include && s.scene_id === sceneId);
    try {
      const s = await api.post<Shot>(`/api/episodes/${eid}/shots`, { scene_id: sceneId, after_shot_id: inScene.at(-1)?.id ?? null, duration_s: 8 });
      refresh();
      setSelected(s.id);
      toast.success(tr("Shot added — describe it in the Shot panel"));
    } catch { /* api toasts */ }
  }, [episode, eid, refresh]);

  const moveShot = useCallback(async (shotId: number, sceneId: number | null, at: number) => {
    if (!episode) return;
    const shots = (episode.shots ?? []).filter((s) => s.include);
    const order = outlineOrder(episode).filter((id) => id !== shotId);
    order.splice(Math.max(0, Math.min(at, order.length)), 0, shotId);
    try {
      if ((shots.find((s) => s.id === shotId)?.scene_id ?? null) !== sceneId) await api.patch(`/api/shots/${shotId}`, { scene_id: sceneId });
      await api.post(`/api/episodes/${eid}/shots/reorder`, { shot_ids: order });
    } catch { /* api toasts */ }
    refresh();
  }, [episode, eid, refresh]);

  const setCast = useCallback(async (shotId: number, characterId: number, on: boolean) => {
    const shot = episode?.shots?.find((s) => s.id === shotId);
    if (!shot || shot.characters.includes(characterId) === on) return;
    const next = on ? [...shot.characters, characterId] : shot.characters.filter((c) => c !== characterId);
    try {
      await api.patch(`/api/shots/${shotId}`, { characters: next });
      const who = (cast ?? []).find((c) => c.id === characterId)?.name ?? "";
      toast.success(on ? tr("{name} added to {code}", { name: who, code: shot.code }) : tr("{name} taken out of {code}", { name: who, code: shot.code }));
    } catch { /* api toasts */ }
    refresh();
  }, [episode, cast, refresh]);

  // Film Map continuity: the target shot continues from the source (keyframe from its last frame, or video extending its clip)
  const linkShot = useCallback(async (shotId: number, fromShotId: number | null, mode: LinkMode = "last_frame") => {
    const shots = episode?.shots ?? [];
    const shot = shots.find((s) => s.id === shotId);
    const src = fromShotId != null ? shots.find((s) => s.id === fromShotId) : undefined;
    if (!shot || (fromShotId != null && (!src || fromShotId === shotId))) return;
    try {
      const r = await api.patch<Shot & { stale_takes?: number[] }>(`/api/shots/${shotId}`,
        src ? { continuity_from_shot_id: src.id, continuity_mode: mode } : { continuity_from_shot_id: null });
      if (src) {
        toast.success(mode === "extend" ? tr("{target} now extends {source}'s clip", { target: shot.code, source: src.code })
          : tr("{target} now starts from {source}'s last frame", { target: shot.code, source: src.code }));
      } else toast.success(tr("{code} no longer continues from another shot", { code: shot.code }));
      announceStale(r.stale_takes);
    } catch { /* api toasts */ }
    refresh();
  }, [episode, refresh]);

  const setLinkMode = useCallback(async (shotId: number, mode: LinkMode) => {
    const shot = episode?.shots?.find((s) => s.id === shotId);
    const link = shot ? linkOf(shot) : null;
    if (!shot || !link || link.mode === mode) return;
    const src = episode?.shots?.find((s) => s.id === link.fromId);
    try {
      const r = await api.patch<Shot & { stale_takes?: number[] }>(`/api/shots/${shotId}`, { continuity_mode: mode });
      toast.success(mode === "extend" ? tr("{target} now extends {source}'s clip", { target: shot.code, source: src?.code ?? "" })
        : tr("{target} now starts from {source}'s last frame", { target: shot.code, source: src?.code ?? "" }));
      announceStale(r.stale_takes);
    } catch { /* api toasts */ }
    refresh();
  }, [episode, refresh]);

  // the shot after `shotId`, linked to it; with `generate` the keyframe + video jobs go through the cost / approval flow
  const addNextShot = useCallback(async (shotId: number, body: NextShotIn) => {
    const src = episode?.shots?.find((s) => s.id === shotId);
    if (!src) return null;
    const got: { shot?: Shot } = {};
    try {
      if (body.generate) {
        await submit(async () => {
          const r = await nextShot(shotId, body);
          got.shot = r.shot as Shot;
          return (r.jobs as SubmitResult | null) ?? { batch_id: "", status: "nothing_to_do", total_usd: 0, jobs: [] };
        }, tr("Next shot after {code}", { code: src.code }));
      } else {
        got.shot = (await nextShot(shotId, body)).shot as Shot;
        toast.success(body.mode === "extend" ? tr("{code} added after {src} — its video will extend that clip", { code: got.shot.code, src: src.code })
          : tr("{code} added after {src} — it starts from that shot's last frame", { code: got.shot.code, src: src.code }));
      }
    } catch { /* api toasts */ }
    refresh();
    if (!got.shot) return null;
    setSelected(got.shot.id);
    return got.shot.id;
  }, [episode, refresh, submit]);

  const state: StudioState = useMemo(() => ({
    episode, cast: cast ?? [], selected, select: setSelected, addShot, canEdit, refresh, moveShot, setCast, linkShot, setLinkMode, addNextShot,
    goCharacters: () => nav(`/p/${project.id}/bible`), goShots: () => nav(`/p/${project.id}/shots`),
  }), [episode, cast, selected, addShot, canEdit, nav, project.id, refresh, moveShot, setCast, linkShot, setLinkMode, addNextShot]);

  const onReady = (e: DockviewReadyEvent) => {
    apiRef.current = e.api;
    let restored = false;
    try {
      const saved = localStorage.getItem(LAYOUT_KEY);
      if (saved) { e.api.fromJSON(JSON.parse(saved)); restored = e.api.panels.length > 0; }
    } catch { restored = false; }
    if (!restored) defaultLayout(e.api);
    const sync = () => {
      setOpen(e.api.panels.map((p) => p.id));
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(e.api.toJSON())); } catch { /* storage blocked */ }
    };
    sync();
    e.api.onDidLayoutChange(sync);
  };

  const reopen = (id: string) => {
    const a = apiRef.current;
    if (!a || a.getPanel(id)) return;
    a.addPanel({ id, component: id, title: tr(PANELS[id].title), position: id === "timeline" ? { direction: "below" } : { direction: "right" } });
  };

  // drag a character onto a shot · drag shots to reorder them or move them to another scene
  const onDragEnd = async (e: DragEndEvent) => {
    setDragging(null);
    const a = e.active.data.current as DragData | undefined;
    const o = e.over?.data.current as DragData | undefined;
    if (!a || !o || !episode) return;
    const shots = (episode.shots ?? []).filter((s) => s.include);
    try {
      if (a.type === "character" && o.type === "shot") {
        await setCast(o.shotId, a.characterId, true);
        return;
      }
      if (a.type !== "shot" || (o.type === "shot" && o.shotId === a.shotId)) return;
      const order = outlineOrder(episode).filter((id) => id !== a.shotId);
      const sceneOf = new Map(shots.map((s) => [s.id, s.scene_id]));
      let at: number;
      let scene: number | null;
      if (o.type === "shot") {
        scene = sceneOf.get(o.shotId) ?? null;
        const target = outlineOrder(episode).indexOf(o.shotId);
        const from = outlineOrder(episode).indexOf(a.shotId);
        at = order.indexOf(o.shotId) + (from < target ? 1 : 0);
      } else if (o.type === "scene") {
        scene = o.sceneId;
        const last = [...order].reverse().find((id) => sceneOf.get(id) === scene);
        at = last != null ? order.indexOf(last) + 1 : order.length;
      } else return;
      await moveShot(a.shotId, scene, at);
    } catch { refresh(); }
  };

  const dragChar = dragging?.type === "character" ? (cast ?? []).find((c) => c.id === dragging.characterId) : undefined;
  const closed = Object.keys(PANELS).filter((id) => !open.includes(id));

  return (
    <StudioCtx.Provider value={state}>
      <DndContext sensors={sensors} onDragStart={(e: DragStartEvent) => setDragging((e.active.data.current as DragData) ?? null)}
        onDragCancel={() => setDragging(null)} onDragEnd={(e) => void onDragEnd(e)}>
        <div className="flex h-full flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel/60 px-3 py-1.5 text-xs">
            <PanelsTopLeft className="size-4 text-accent-ink" />
            <span className="font-semibold">{t("Studio")}</span>
            <span className="hidden text-dim md:inline">{t("Drag panel tabs to rearrange · ↗ opens a panel on another screen · drag characters onto shots")}</span>
            <div className="flex-1" />
            {closed.length > 0 && (
              <Menu trigger={(p) => <Button {...p} size="sm" variant="ghost" icon={<LayoutGrid className="size-3.5" />}>{t("Show panel")}</Button>}
                items={closed.map((id) => ({ label: t(PANELS[id].title), onClick: () => reopen(id) }))} />
            )}
            <Tooltip content={t("Back to the standard arrangement")}>
              <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />}
                onClick={() => { if (apiRef.current) defaultLayout(apiRef.current); }}>{t("Reset layout")}</Button>
            </Tooltip>
          </div>
          <div className="min-h-0 flex-1 p-1.5">
            <DockviewReact className="h-full" theme={THEME} components={COMPONENTS} onReady={onReady}
              rightHeaderActionsComponent={HeaderActions} />
          </div>
        </div>
        <DragOverlay dropAnimation={null}>
          {dragChar ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/60 bg-panel px-2 py-1 text-xs shadow-lift">
              <Avatar name={dragChar.name} src={dragChar.avatar_url} size={20} />{dragChar.name}
            </span>
          ) : null}
        </DragOverlay>
      </DndContext>
    </StudioCtx.Provider>
  );
}
