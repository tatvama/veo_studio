import "@xyflow/react/dist/style.css";
import "../../../styles/production.css";
import "./canvas.css";
import {
  Background, Controls, MarkerType, MiniMap, Panel, ReactFlow, ReactFlowProvider, SelectionMode, applyEdgeChanges, applyNodeChanges,
  useReactFlow, type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type OnNodeDrag, type OnSelectionChangeParams,
} from "@xyflow/react";
import { clsx } from "clsx";
import {
  Clapperboard, FileText, Lasso, ListTree, Maximize, PanelLeftOpen, PanelsTopLeft, Plus, Redo2, Rows3, Search, Trash2, Undo2, X,
} from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ImportWizard } from "../../../components/board/ImportWizard";
import { Button, IconButton, Kbd, Menu, Modal, PageSkeleton, Tooltip } from "../../../components/ui";
import { tr, useT } from "../../../lib/i18n";
import { useCharacters, useEpisode, useLocations } from "../../../lib/queries";
import type { Character, Episode, ExportRow, Location } from "../../../lib/types";
import { useProps, type Prop } from "../../../lib/v3";
import { useProjectCtx } from "../context";
import { LoadError } from "../production/LoadError";
import { ratioOf } from "../production/shotMeta";
import ShotDrawer from "../ShotDrawer";
import { linkFromOf } from "../studio/continuity";
import { outlineGroups, outlineOrder } from "../studio/Outline";
import { CanvasActionsCtx, PlacesCtx, sceneKey, useActions, useCanvasActionsImpl } from "./actions";
import { store, useCanvasInfo, useMedia, type SceneX } from "./data";
import { SceneInspector, ShotInspector } from "./Inspector";
import { Library } from "./Library";
import {
  LAYOUT, boxAtY, collapsedKey, layoutGroups, makeBody, orderAfterDrag, parseViewport, searchShots, shotSeconds, shotSlot, slotAt,
  viewKey, whereIs, type CanvasInfo,
} from "./model";
import { EDGE_TYPES, NODE_TYPES, type FilmNodeData, type LinkEdgeData, type SceneNodeData, type ShotNodeData } from "./nodes";
import { PriceButton } from "./parts";
import { PhoneList } from "./PhoneList";
import { useCanvasUI } from "./store";

type Sel = { kind: "shot"; id: number } | { kind: "scene"; id: number } | null;
const NONE: never[] = [];
const LIB_KEY = "tatvam:canvas-library";

/** The Shots step's canvas (its default view). */
export default function CanvasPage() {
  return <ShotsCanvas />;
}

/**
 * The film as a canvas: each scene a row you can fold and drag up or down, its shots left → right with their five steps,
 * the cast, places and props in a library to drag onto them, links between shots, an inspector on the right and the
 * film at the end. Every paid button shows its price first. `embedded`: inside the Studio's dock (no inspector there;
 * a picked shot goes to the Studio's Shot panel).
 */
export function ShotsCanvas({ embedded = false, onSelectShot }: { embedded?: boolean; onSelectShot?: (id: number | null) => void }) {
  const t = useT();
  const { project, eid, lang, canEdit } = useProjectCtx();
  const { data: episode, isLoading, isError, refetch } = useEpisode(eid, lang);
  const { data: cast } = useCharacters(project.id);
  const { data: places } = useLocations(project.id);
  const { data: props } = useProps(project.id);
  const { data: info } = useCanvasInfo(eid, lang);
  const phone = useMedia("(max-width: 639px)");
  const [sel, setSel] = useState<Sel>(null);
  const [drawer, setDrawer] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const board = useRef<BoardApi | null>(null);
  // a shot or scene just added, selected once its node exists (the board may not even be on screen yet)
  const pending = useRef<string | null>(null);

  const ui = useMemo(() => ({
    selectWhenReady: (nodeId: string) => {
      pending.current = nodeId;
      if (board.current) return;
      if (nodeId.startsWith("shot-")) setSel({ kind: "shot", id: Number(nodeId.slice(5)) });
      else if (nodeId !== "scene-none") setSel({ kind: "scene", id: Number(nodeId.slice(6)) });
    },
    openShot: (id: number) => (embedded && onSelectShot ? onSelectShot(id) : setDrawer(id)),
  }), [embedded, onSelectShot]);
  const actions = useCanvasActionsImpl({
    eid, pid: project.id, lang, canEdit, episode, cast: cast ?? NONE, locations: places ?? NONE, props: props ?? NONE, ui,
  });
  useEffect(() => () => useCanvasUI.getState().reset(), []);

  if (isLoading) return <div className="h-full overflow-hidden"><PageSkeleton cards={4} /></div>;
  if (isError || !episode) return <div className="p-6"><LoadError what={t("the shots")} onRetry={() => void refetch()} /></div>;

  const hasAny = (episode.scenes?.length ?? 0) > 0 || (episode.shots ?? []).some((s) => s.include);
  const shot = sel?.kind === "shot" ? (episode.shots ?? []).find((s) => s.id === sel.id) : undefined;
  const scene = sel?.kind === "scene" ? (episode.scenes ?? []).find((s) => s.id === sel.id) as SceneX | undefined : undefined;
  const closeSel = () => { setSel(null); board.current?.select(null); };
  const inspector = embedded ? null : shot ? (
    <ShotInspector key={`shot-${shot.id}`} shot={shot} episode={episode} cast={cast ?? NONE} places={places ?? NONE} lang={lang}
      info={info?.shots[String(shot.id)]} onClose={closeSel} />
  ) : scene ? (
    <SceneInspector key={`scene-${scene.id}`} scene={scene} places={places ?? NONE}
      shotIds={(episode.shots ?? []).filter((s) => s.include && s.scene_id === scene.id).map((s) => s.id)} onClose={closeSel} />
  ) : null;

  return (
    <CanvasActionsCtx.Provider value={actions}>
      <PlacesCtx.Provider value={places ?? NONE}>
        <div className="shots-canvas hud-bg @container relative h-full">
          {!hasAny ? (
            <EmptyCanvas canEdit={canEdit} onImport={() => setImporting(true)} onAddScene={() => void actions.addScene()} />
          ) : phone ? (
            <>
              <PhoneList episode={episode} cast={cast ?? NONE} places={places ?? NONE} info={info}
                onOpen={(id) => setSel({ kind: "shot", id })} onOpenScene={(id) => setSel({ kind: "scene", id })} />
              {/* a sheet over everything (the page area is transformed, so a fixed child wouldn't reach the screen's edges) */}
              {inspector && createPortal(
                <>
                  <div aria-hidden className="fixed inset-0 z-[60] bg-black/50" onClick={closeSel} />
                  <div role="dialog" aria-modal="true" aria-label={shot ? t("Shot {code}", { code: shot.code }) : t("Scene")}
                    className="fixed inset-x-0 bottom-0 z-[61] flex max-h-[88dvh] flex-col overflow-hidden rounded-t-2xl border-t border-line bg-panel shadow-modal">
                    <span aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line" />
                    {inspector}
                  </div>
                </>,
                document.body,
              )}
            </>
          ) : (
            <ReactFlowProvider>
              <CanvasBoard key={eid} ref={board} pending={pending} episode={episode} cast={cast ?? NONE} places={places ?? NONE} props={props ?? NONE} info={info}
                wide={ratioOf(project.aspect).w / ratioOf(project.aspect).h >= 1.2} embedded={embedded} inspector={inspector}
                onSelection={(s) => {
                  setSel((prev) => (prev?.kind === s?.kind && prev?.id === s?.id ? prev : s));
                  if (embedded && onSelectShot) onSelectShot(s?.kind === "shot" ? s.id : null);
                }}
                onImport={() => setImporting(true)} />
            </ReactFlowProvider>
          )}
          {drawer != null && (
            <>
              <div aria-hidden className="absolute inset-0 z-40 bg-black/45" onClick={() => setDrawer(null)} />
              <div className="absolute inset-y-0 right-0 z-50 w-[min(100%,560px)] border-l border-line shadow-modal">
                <ShotDrawerPanel shotId={drawer} episode={episode} onClose={() => setDrawer(null)} onGo={setDrawer} />
              </div>
            </>
          )}
        </div>
        <ImportWizard open={importing} onClose={() => setImporting(false)} eid={eid} projectId={project.id}
          hasShots={(episode.shots ?? []).some((s) => s.include)} onDone={() => actions.refresh()} />
      </PlacesCtx.Provider>
    </CanvasActionsCtx.Provider>
  );
}

/** The full shot (takes, prompt, effects, comments) over the canvas. */
function ShotDrawerPanel({ shotId, episode, onClose, onGo }: { shotId: number; episode: Episode; onClose: () => void; onGo: (id: number) => void }) {
  const order = outlineOrder(episode);
  const i = order.indexOf(shotId);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector("[aria-modal=true]")) onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <ShotDrawer key={shotId} shotId={shotId} embedded onClose={onClose}
      position={{ index: Math.max(0, i), total: order.length, hasPrev: i > 0, hasNext: i >= 0 && i < order.length - 1 }}
      onPrev={() => i > 0 && onGo(order[i - 1])} onNext={() => i >= 0 && i < order.length - 1 && onGo(order[i + 1])} />
  );
}

function EmptyCanvas({ canEdit, onImport, onAddScene }: { canEdit: boolean; onImport: () => void; onAddScene: () => void }) {
  const t = useT();
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-md space-y-3">
        <span className="hud relative mx-auto grid size-14 place-items-center rounded-2xl border border-accent/30 bg-accent/10 text-accent-ink"><Clapperboard className="size-7" /></span>
        <p className="text-lg font-semibold tracking-tight">{t("Your film starts here")}</p>
        <p className="text-sm text-mute">{t("Bring in your script and it becomes scenes and shots, or start with an empty scene and add shots by hand.")}</p>
        {canEdit ? (
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Button variant="primary" size="lg" icon={<FileText className="size-4" />} onClick={onImport}>{t("Import your script")}</Button>
            <Button variant="outline" size="lg" icon={<Plus className="size-4" />} onClick={onAddScene}>{t("Add a scene")}</Button>
          </div>
        ) : <p className="text-xs text-dim">{t("Nothing here yet.")}</p>}
      </div>
    </div>
  );
}

// ── the board ────────────────────────────────────────────────────────────────

interface BoardApi {
  select: (nodeId: string | null) => void;
}

interface BoardProps {
  episode: Episode; cast: Character[]; places: Location[]; props: Prop[]; info?: CanvasInfo; wide: boolean; embedded: boolean;
  inspector: React.ReactNode; onSelection: (s: Sel) => void; onImport: () => void;
  /** A node to select as soon as it exists. */
  pending: React.MutableRefObject<string | null>;
}

/** Keeps node objects whose content didn't change (so React Flow and the memoised nodes skip them); `force` re-applies every position. */
function mergeNodes(prev: Node[], next: Node[], force = false): Node[] {
  const old = new Map(prev.map((n) => [n.id, n]));
  let same = prev.length === next.length;
  const out = next.map((n, i) => {
    const o = old.get(n.id);
    if (!o) { same = false; return n; }
    const pos = o.dragging && !force ? o.position : n.position;
    if (o.data === n.data && o.position.x === pos.x && o.position.y === pos.y && o.hidden === n.hidden && o.parentId === n.parentId
      && o.width === n.width && o.height === n.height && o.draggable === n.draggable) {
      if (prev[i] !== o) same = false;
      return o;
    }
    same = false;
    return { ...n, position: pos, selected: o.selected, measured: o.measured, dragging: o.dragging };
  });
  return same ? prev : out;
}

function mergeEdges(prev: Edge[], next: Edge[]): Edge[] {
  const old = new Map(prev.map((e) => [e.id, e]));
  return next.map((e) => {
    const o = old.get(e.id);
    if (!o) return e;
    const a = o.data as LinkEdgeData | undefined;
    const b = e.data as LinkEdgeData | undefined;
    return a && b && a.mode === b.mode && a.sourceCode === b.sourceCode && a.targetCode === b.targetCode && o.deletable === e.deletable ? o : { ...e, selected: o.selected };
  });
}

/** Re-uses a memo'd value while its inputs are the same objects. */
function useKeyedMemo<T>() {
  const cache = useRef(new Map<string, { deps: unknown[]; value: T }>());
  return useCallback((key: string, deps: unknown[], make: () => T): T => {
    const hit = cache.current.get(key);
    if (hit && hit.deps.length === deps.length && hit.deps.every((d, i) => Object.is(d, deps[i]))) return hit.value;
    const value = make();
    cache.current.set(key, { deps, value });
    return value;
  }, []);
}

const CanvasBoard = forwardRef<BoardApi, BoardProps>(function CanvasBoard(
  { episode, cast, places, props, info, wide, embedded, inspector, onSelection, onImport, pending }, ref,
) {
  const t = useT();
  const a = useActions();
  const rf = useReactFlow();
  const nav = useNavigate();
  const { eid } = a;
  const bigScreen = useMedia("(min-width: 1441px)");
  const [libOpen, setLibOpen] = useState(() => {
    const v = store.get(LIB_KEY);
    return v ? v === "1" : !embedded && window.innerWidth >= 1024;
  });
  const showLib = (on: boolean) => { setLibOpen(on); store.set(LIB_KEY, on ? "1" : "0"); };
  const [lasso, setLasso] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<number[] | null>(null);
  const highlight = useCanvasUI((s) => s.highlight);
  const dragKind = useCanvasUI((s) => s.drag?.kind ?? null);
  const pointerIn = useRef(!embedded);

  // ── the graph, from the film ──
  const groups = useMemo(() => outlineGroups(episode), [episode]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(store.get(collapsedKey(eid)) || "[]")); } catch { return new Set(); }
  });
  const toggle = useCallback((key: string) => setCollapsed((prev) => {
    const n = new Set(prev);
    if (n.has(key)) n.delete(key); else n.add(key);
    store.set(collapsedKey(eid), JSON.stringify([...n]));
    return n;
  }), [eid]);
  const boxes = useMemo(() => layoutGroups(groups.map((g) => {
    const key = sceneKey(g.scene?.id);
    return { key, count: g.shots.length, collapsed: collapsed.has(key) };
  })), [groups, collapsed]);
  const castById = useMemo(() => new Map(cast.map((c) => [c.id, c])), [cast]);
  const placeById = useMemo(() => new Map(places.map((l) => [l.id, l])), [places]);
  const memoShot = useKeyedMemo<ShotNodeData>();
  const memoScene = useKeyedMemo<SceneNodeData>();
  const memoFilm = useKeyedMemo<FilmNodeData>();

  const built = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const byId = new Map((episode.shots ?? []).map((s) => [s.id, s]));
    const shown = new Set(groups.flatMap((g) => g.shots.map((s) => s.id)));
    const scenes = episode.scenes ?? [];
    groups.forEach((g, gi) => {
      const box = boxes[gi];
      const key = box.key;
      const sc = g.scene as SceneX | null;
      const folded = collapsed.has(key);
      const ids = g.shots.map((s) => s.id);
      const idsKey = ids.join(",");
      const secs = g.shots.reduce((n, s) => n + shotSeconds(s.duration_s, s.extend_to), 0);
      const place = sc?.location_id ? placeById.get(sc.location_id) : undefined;
      const music = sc ? info?.scene_music[String(sc.id)] : undefined;
      const index = sc ? scenes.indexOf(g.scene!) + 1 : 0;
      const data = memoScene(key, [sc, idsKey, secs, place, folded, music, box.w, box.h, index, toggle], () => ({
        scene: sc, index, shotIds: ids, secs, place, collapsed: folded, music, w: box.w, h: box.h, onToggle: toggle,
      }));
      nodes.push({ id: key, type: "scene", position: { x: box.x, y: box.y }, data, width: box.w, height: box.h, zIndex: 0,
        draggable: a.canEdit && !!sc, dragHandle: ".scene-handle", deletable: false, selectable: !!sc });
      g.shots.forEach((s, i) => {
        const lf = linkFromOf(s, byId);
        const linkFrom = lf && shown.has(lf.id) ? lf : null;
        const sInfo = info?.shots[String(s.id)];
        const sdata = memoShot(String(s.id), [s, sInfo, castById, linkFrom?.id, linkFrom?.mode, linkFrom?.code, wide], () => ({
          shot: s, info: sInfo, linkFrom, wide,
          people: s.characters.map((c) => castById.get(c)).filter((c): c is Character => !!c),
        }));
        nodes.push({ id: `shot-${s.id}`, type: "shot", parentId: key, position: shotSlot(i), data: sdata, hidden: folded,
          width: LAYOUT.shotW, height: LAYOUT.shotH, draggable: a.canEdit, deletable: false });
        if (linkFrom) {
          edges.push({ id: `link-${linkFrom.id}-${s.id}`, type: "link", source: `shot-${linkFrom.id}`, sourceHandle: "out", target: `shot-${s.id}`,
            targetHandle: "in", className: "canvas-link", deletable: a.canEdit, markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-accent)" },
            data: { sourceShotId: linkFrom.id, targetShotId: s.id, sourceCode: linkFrom.code, targetCode: s.code, mode: linkFrom.mode } satisfies LinkEdgeData });
        }
      });
    });
    const last = boxes.at(-1);
    const shots = groups.flatMap((g) => g.shots);
    const finals = (episode.exports ?? []).filter((x) => x.kind !== "animatic");
    const latest: ExportRow | null = finals[0] ?? null;
    const ready: ExportRow | null = finals.find((x) => x.status === "ready" && x.url) ?? null;
    const secs = shots.reduce((n, s) => n + shotSeconds(s.duration_s, s.extend_to), 0);
    const withVideo = shots.filter((s) => s.video).length;
    const scenesN = groups.filter((g) => g.scene).length;
    const film = memoFilm("film", [secs, scenesN, shots.length, withVideo, latest, ready], () => ({
      secs, scenes: scenesN, shots: shots.length, withVideo, latest, ready,
    }));
    nodes.push({ id: "film", type: "film", position: { x: 0, y: last ? last.y + last.h + LAYOUT.gapY : 0 }, data: film,
      draggable: false, selectable: false, deletable: false });
    return { nodes, edges };
  }, [episode, groups, boxes, collapsed, castById, placeById, info, wide, toggle, a.canEdit, memoShot, memoScene, memoFilm]);

  const [nodes, setNodes] = useState<Node[]>(built.nodes);
  const [edges, setEdges] = useState<Edge[]>(built.edges);
  useEffect(() => { setNodes((prev) => mergeNodes(prev, built.nodes)); }, [built.nodes]);
  useEffect(() => { setEdges((prev) => mergeEdges(prev, built.edges)); }, [built.edges]);
  const snapBack = useCallback(() => setNodes((prev) => mergeNodes(prev, built.nodes, true)), [built.nodes]);
  const onNodesChange = useCallback((c: NodeChange[]) => setNodes((ns) => applyNodeChanges(c, ns)), []);
  const onEdgesChange = useCallback((c: EdgeChange[]) => setEdges((es) => applyEdgeChanges(c, es)), []);

  // ── selection ──
  const select = useCallback((nodeId: string | null) => {
    setNodes((ns) => ns.map((n) => {
      const on = n.id === nodeId;
      return !!n.selected === on ? n : { ...n, selected: on };
    }));
  }, []);
  const focusNode = useCallback((nodeId: string, zoom?: number) => {
    const n = rf.getInternalNode(nodeId);
    if (!n) return;
    const p = n.internals.positionAbsolute;
    const w = n.measured.width ?? n.width ?? LAYOUT.shotW;
    const h = n.measured.height ?? n.height ?? LAYOUT.shotH;
    void rf.setCenter(p.x + w / 2, p.y + h / 2, { zoom: zoom ?? Math.max(rf.getZoom(), 0.85), duration: 320 });
  }, [rf]);
  useImperativeHandle(ref, () => ({ select }), [select]);
  useEffect(() => {
    const id = pending.current;
    if (!id || !nodes.some((n) => n.id === id)) return;
    pending.current = null;
    // after React Flow's first selection report (an empty one on a fresh board)
    window.setTimeout(() => { select(id); focusNode(id); }, 60);
  }, [nodes, select, focusNode, pending]);

  // React Flow calls this again whenever the callback changes: it must stay the same function
  const onSelectionRef = useRef(onSelection);
  onSelectionRef.current = onSelection;
  const onSelectionChange = useCallback(({ nodes: picked }: OnSelectionChangeParams) => {
    const ids = picked.map((n) => n.id);
    setSelected((prev) => (prev.join() === ids.join() ? prev : ids));
    const shots = ids.filter((id) => id.startsWith("shot-"));
    const scenes = ids.filter((id) => id.startsWith("scene-") && id !== "scene-none");
    if (shots.length === 1 && !scenes.length) onSelectionRef.current({ kind: "shot", id: Number(shots[0].slice(5)) });
    else if (scenes.length === 1 && !shots.length) onSelectionRef.current({ kind: "scene", id: Number(scenes[0].slice(6)) });
    else onSelectionRef.current(null);
  }, []);

  // ── drag a shot to another slot or scene; drag a scene up or down ──
  const onNodeDragStop: OnNodeDrag = useCallback((_, node, dragged) => {
    if (!a.canEdit) return;
    if (dragged.length > 1) { snapBack(); toast.info(tr("Move one shot at a time")); return; }
    if (node.type === "shot") {
      const shotId = Number(node.id.slice(5));
      const abs = rf.getInternalNode(node.id)?.internals.positionAbsolute ?? node.position;
      const bi = boxAtY(boxes, abs.y + LAYOUT.shotH / 2);
      if (bi < 0) { snapBack(); return; }
      const box = boxes[bi];
      const gids = groups.map((g) => ({ key: sceneKey(g.scene?.id), ids: g.shots.map((s) => s.id) }));
      const others = gids[bi].ids.filter((id) => id !== shotId);
      const slot = collapsed.has(box.key) ? others.length : slotAt(abs.x - box.x, others.length);
      const from = whereIs(gids, shotId);
      if (!from || (from.key === box.key && from.slot === slot)) { snapBack(); return; }
      snapBack();
      void a.moveShot(shotId, box.key, slot);
      return;
    }
    if (node.type === "scene") {
      const box = boxes.find((b) => b.key === node.id);
      if (!box) { snapBack(); return; }
      const order = orderAfterDrag(boxes, node.id, node.position.y + box.h / 2);
      snapBack();
      if (order.join() !== boxes.map((b) => b.key).join()) void a.reorderScenes(order.filter((k) => k !== "scene-none"));
    }
  }, [a, rf, boxes, groups, collapsed, snapBack]);

  const isValidConnection = useCallback((c: Connection | Edge) =>
    c.source.startsWith("shot-") && c.target.startsWith("shot-") && c.source !== c.target, []);
  const onConnect = useCallback((c: Connection) => {
    if (a.canEdit) void a.link(Number(c.target.slice(5)), Number(c.source.slice(5)), "last_frame");
  }, [a]);
  const onEdgesDelete = useCallback(async (gone: Edge[]) => {
    for (const e of gone) {
      const d = e.data as LinkEdgeData | undefined;
      if (d) await a.link(d.targetShotId, null);
    }
  }, [a]);

  // ── search ──
  const searchItems = useMemo(() => groups.flatMap((g) => g.shots).map((s) => ({
    id: s.id, code: s.code,
    text: [s.action, ...Object.values(s.dialogue ?? {}).flat().map((l) => l.line), ...Object.values(s.narration ?? {})].join(" "),
  })), [groups]);
  const matches = useMemo(() => searchShots(searchItems, query), [searchItems, query]);
  const current = useCanvasUI((s) => s.current);
  const goTo = useCallback((shotId: number) => {
    const g = groups.find((x) => x.shots.some((s) => s.id === shotId));
    const key = sceneKey(g?.scene?.id);
    if (collapsed.has(key)) toggle(key);
    useCanvasUI.getState().setMatches(matches, shotId);
    window.setTimeout(() => focusNode(`shot-${shotId}`, Math.max(rf.getZoom(), 0.9)), collapsed.has(key) ? 80 : 0);
  }, [groups, collapsed, toggle, matches, focusNode, rf]);
  useEffect(() => {
    if (!searchOpen) { useCanvasUI.getState().setMatches([], null); return; }
    useCanvasUI.getState().setMatches(matches, matches[0] ?? null);
    if (matches[0] != null) goTo(matches[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, searchOpen]);
  const nextMatch = (dir: 1 | -1) => {
    if (!matches.length) return;
    const i = current != null ? matches.indexOf(current) : -1;
    goTo(matches[(i + dir + matches.length) % matches.length]);
  };

  // ── keys: undo / redo, find, escape ──
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!pointerIn.current && embedded) return;
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (document.querySelector("[aria-modal=true]")) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "f") { e.preventDefault(); setSearchOpen(true); return; }
      if (typing) return;
      if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); void a.undo(); }
      else if (mod && ((k === "z" && e.shiftKey) || k === "y")) { e.preventDefault(); void a.redo(); }
      else if (k === "escape") {
        if (useCanvasUI.getState().highlight != null) useCanvasUI.getState().setHighlight(null);
        else if (searchOpen) setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [a, embedded, searchOpen]);

  // ── camera ──
  const saved = useMemo(() => parseViewport(store.get(viewKey(eid))), [eid]);
  const fit = () => void rf.fitView({ padding: 0.12, duration: 320 });
  const tidy = () => { snapBack(); window.setTimeout(fit, 30); toast.message(tr("Scenes in rows, shots left to right")); };
  const zoomToScene = (key: string) => {
    if (collapsed.has(key)) toggle(key);
    window.setTimeout(() => {
      const b = layoutGroups(groups.map((g) => {
        const k = sceneKey(g.scene?.id);
        return { key: k, count: g.shots.length, collapsed: k === key ? false : collapsed.has(k) };
      })).find((x) => x.key === key);
      if (b) void rf.fitBounds({ x: b.x, y: b.y, width: b.w, height: b.h }, { padding: 0.08, duration: 350 });
    }, 40);
  };

  const undoSize = useSyncExternalStore(a.undoStack.subscribe, () => a.undoStack.size);
  const redoSize = useSyncExternalStore(a.undoStack.subscribe, () => a.undoStack.redoSize);
  const lastLabel = useSyncExternalStore(a.undoStack.subscribe, () => a.undoStack.peek()?.label ?? "");
  const pickedShots = selected.filter((id) => id.startsWith("shot-")).map((id) => Number(id.slice(5)));
  const highlightShots = useMemo(() => (highlight == null ? [] : groups.flatMap((g) => g.shots).filter((s) => s.characters.includes(highlight))), [groups, highlight]);
  const highlightName = highlight == null ? "" : cast.find((c) => c.id === highlight)?.name ?? "";
  const overlay = !bigScreen;
  const sceneMenu = groups.map((g, i) => ({ key: sceneKey(g.scene?.id), label: g.scene ? `SC${String(i + 1).padStart(2, "0")} · ${g.scene.title}` : t("Shots without a scene") }));

  return (
    // a picked face and a library drag are attributes here, styled in CSS: the 100+ shot nodes don't re-render for them
    <div className="cv-board flex h-full min-h-0" data-hl={highlight ?? undefined} data-drag={dragKind ?? undefined}
      onPointerEnter={() => { pointerIn.current = true; }} onPointerLeave={() => { pointerIn.current = !embedded; }}>
      {highlight != null && (
        <style>{`.cv-board[data-hl="${highlight}"] .cv-shot:not([data-cast~="${highlight}"]){opacity:.3}`
          + `.cv-board[data-hl="${highlight}"] .cv-shot[data-cast~="${highlight}"]{border-color:var(--color-ok);box-shadow:0 0 20px -6px var(--color-ok)}`}</style>
      )}
      {libOpen && (
        <Library episode={episode} cast={cast} places={places} props={props} music={info?.scene_music ?? {}} pid={a.pid} onClose={() => showLib(false)} />
      )}
      <div className="relative min-w-0 flex-1">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onSelectionChange={onSelectionChange}
          onNodeDragStop={onNodeDragStop} onConnect={onConnect} onEdgesDelete={(e) => void onEdgesDelete(e)} isValidConnection={isValidConnection}
          nodesConnectable={a.canEdit} edgesReconnectable={false} onlyRenderVisibleElements elevateNodesOnSelect={false}
          selectionOnDrag={lasso} panOnDrag={lasso ? [1, 2] : true} selectionMode={SelectionMode.Partial}
          deleteKeyCode={a.canEdit ? ["Delete", "Backspace"] : null}
          defaultViewport={saved ?? undefined} fitView={!saved} fitViewOptions={{ padding: 0.12, maxZoom: 1 }} minZoom={0.1} maxZoom={1.8}
          onMoveEnd={(_, vp) => store.set(viewKey(eid), JSON.stringify(vp))}
          colorMode={document.documentElement.dataset.theme === "light" ? "light" : "dark"} proOptions={{ hideAttribution: true }}
          style={{ background: "transparent" }}>
          <Background gap={22} size={1.3} />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap pannable zoomable position="bottom-right" className="!hidden @2xl:!block" style={{ width: 168, height: 112 }}
            nodeColor={(n) => n.type === "scene" ? "color-mix(in srgb, var(--color-accent) 10%, transparent)" : n.type === "film" ? "var(--color-accent-2)"
              : (n.data as ShotNodeData)?.shot?.video ? "var(--color-accent)" : (n.data as ShotNodeData)?.shot?.keyframe ? "var(--color-info)" : "var(--color-hover)"} />
          <Panel position="top-left" className="!m-2">
            <div className="hud relative flex flex-wrap items-center gap-0.5 rounded-xl border border-line bg-panel/90 p-1 shadow-card backdrop-blur">
              {!libOpen && <IconButton title={t("Show the library: cast, places, props, music")} onClick={() => showLib(true)}><PanelLeftOpen className="size-4" /></IconButton>}
              <Menu placement="bottom-start" width={260} trigger={(p) => (
                <Tooltip content={t("Go to a scene")}>
                  <button type="button" {...p} aria-label={t("Go to a scene")} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-mute hover:bg-hover hover:text-ink">
                    <ListTree className="size-4" /><span className="hidden @3xl:inline">{t("Scenes")}</span>
                  </button>
                </Tooltip>
              )} items={sceneMenu.map((s) => ({ label: s.label, onClick: () => zoomToScene(s.key) }))} />
              <IconButton title={t("Find a shot by code or words")} shortcut="Ctrl F" active={searchOpen} onClick={() => setSearchOpen((o) => !o)}><Search className="size-4" /></IconButton>
              <span aria-hidden className="mx-0.5 h-5 w-px bg-line" />
              <IconButton title={t("Tidy: scenes in rows, shots left to right")} onClick={tidy}><Rows3 className="size-4" /></IconButton>
              <IconButton title={t("Fit the whole film")} onClick={fit}><Maximize className="size-4" /></IconButton>
              <IconButton title={t("Select by dragging a box (or hold Shift)")} active={lasso} onClick={() => setLasso((v) => !v)}><Lasso className="size-4" /></IconButton>
              {a.canEdit && (
                <>
                  <span aria-hidden className="mx-0.5 h-5 w-px bg-line" />
                  <IconButton title={undoSize ? t("Undo: {what}", { what: lastLabel }) : t("Nothing to undo")} shortcut="Ctrl Z" disabled={!undoSize} onClick={() => void a.undo()}><Undo2 className="size-4" /></IconButton>
                  <IconButton title={t("Redo")} shortcut="Ctrl Y" disabled={!redoSize} onClick={() => void a.redo()}><Redo2 className="size-4" /></IconButton>
                  <span aria-hidden className="mx-0.5 h-5 w-px bg-line" />
                  <Tooltip content={t("Add a scene at the end")}>
                    <button type="button" onClick={() => void a.addScene()} className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-mute hover:bg-hover hover:text-ink">
                      <Plus className="size-4" /><span className="hidden @3xl:inline">{t("Scene")}</span>
                    </button>
                  </Tooltip>
                  <IconButton title={t("Import a script")} onClick={onImport}><FileText className="size-4" /></IconButton>
                </>
              )}
              {!embedded && (
                <IconButton title={t("Advanced layout: panels you can arrange, float or pop out")} onClick={() => nav(`/p/${a.pid}/studio`)}><PanelsTopLeft className="size-4" /></IconButton>
              )}
              <Tooltip content={t("Drag a face from the library onto a shot (or a scene's title for all its shots) · a place onto a scene · a shot's right edge onto another shot to link them · a shot to move it · a scene's grip to reorder · Ctrl+Z undoes")}>
                <span className="mono grid size-8 cursor-help place-items-center rounded-lg text-xs font-semibold text-dim">?</span>
              </Tooltip>
            </div>
            {searchOpen && (
              <div className="mt-1.5 flex items-center gap-1 rounded-xl border border-line bg-panel/95 p-1 shadow-card backdrop-blur">
                <Search className="ml-1.5 size-3.5 text-dim" />
                <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Code or words")} aria-label={t("Find a shot")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); nextMatch(e.shiftKey ? -1 : 1); }
                    if (e.key === "Escape") { e.preventDefault(); setSearchOpen(false); }
                  }}
                  className="h-8 w-44 bg-transparent px-1 text-xs outline-none placeholder:text-dim" />
                <span className="mono min-w-12 text-right text-2xs tabular-nums text-dim">
                  {query ? (matches.length ? `${(current != null ? matches.indexOf(current) : 0) + 1}/${matches.length}` : t("none")) : ""}
                </span>
                <IconButton title={t("Close")} className="size-7" onClick={() => setSearchOpen(false)}><X className="size-3.5" /></IconButton>
              </div>
            )}
          </Panel>
          <Panel position="bottom-center" className="!mb-3">
            {pickedShots.length > 1 ? (
              <Bar>
                <span className="mono text-xs font-semibold tabular-nums">{t("{n} shots", { n: pickedShots.length })}</span>
                {a.canEdit && (
                  <>
                    <PriceButton eid={eid} body={{ action: "videos", shot_ids: pickedShots }} label={t("Make {n} shots", { n: pickedShots.length })}
                      icon={<Clapperboard className="size-3.5" />} onRun={() => a.makeVideos(pickedShots, t("{n} shots", { n: pickedShots.length }))}
                      title={t("Make the videos of these shots (again), with any missing picture first; you see the price first")} />
                    <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDelete(pickedShots)}>{t("Delete")}</Button>
                  </>
                )}
                <IconButton title={t("Clear the selection")} className="size-7" onClick={() => select(null)}><X className="size-3.5" /></IconButton>
              </Bar>
            ) : highlight != null ? (
              <Bar>
                <span className="text-xs"><span className="font-semibold">{highlightName}</span> · {highlightShots.length === 1 ? t("in 1 shot") : t("in {n} shots", { n: highlightShots.length })}</span>
                {a.canEdit && highlightShots.length > 0 && (() => {
                  const ids = highlightShots.map((s) => s.id);
                  const missing = highlightShots.some((s) => !s.video);
                  return (
                    <PriceButton eid={eid} body={missing ? makeBody(ids) : { action: "videos", shot_ids: ids }}
                      label={missing ? t("Make these {n} shots", { n: ids.length }) : t("Redo these {n} shots", { n: ids.length })}
                      icon={<Clapperboard className="size-3.5" />}
                      onRun={() => (missing ? a.make(ids, t("{name}'s shots", { name: highlightName })) : a.makeVideos(ids, t("{name}'s shots", { name: highlightName })))} />
                  );
                })()}
                <Button size="sm" variant="ghost" onClick={() => useCanvasUI.getState().setHighlight(null)}>{t("Show all")}<Kbd>Esc</Kbd></Button>
              </Bar>
            ) : null}
          </Panel>
        </ReactFlow>
        {overlay && inspector && (
          <div className="absolute inset-y-0 right-0 z-20 w-[320px] max-w-full border-l border-line bg-panel shadow-modal">{inspector}</div>
        )}
      </div>
      {!overlay && inspector && <aside className="w-[320px] shrink-0 border-l border-line bg-panel">{inspector}</aside>}
      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} size="sm"
        title={t("Remove {n} shots from the film?", { n: confirmDelete?.length ?? 0 })}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirmDelete(null)}>{t("Cancel")}</Button>
          <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => {
            const ids = confirmDelete ?? [];
            setConfirmDelete(null);
            select(null);
            void a.deleteShots(ids);
          }}>{t("Remove")}</Button>
        </>}>
        <p className="text-sm text-mute">{t("Shots that already have pictures or videos keep them: they just leave the cut. Empty shots are deleted.")}</p>
      </Modal>
    </div>
  );
});

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div className={clsx("hud relative flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-panel/95 px-3 py-2 shadow-pop backdrop-blur")}>
      {children}
    </div>
  );
}
