import "@xyflow/react/dist/style.css";
import {
  Background, Controls, Handle, MiniMap, Panel, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState,
  type Connection, type Edge, type Node, type NodeProps, type OnNodeDrag,
} from "@xyflow/react";
import { clsx } from "clsx";
import { Clapperboard, Film, ImageIcon, Loader2, MapPin, Plus, Sparkles, Video } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useGenerate } from "../../../components/Generate";
import { Avatar, Toggle, Tooltip } from "../../../components/ui";
import { api } from "../../../lib/api";
import { tr, useT } from "../../../lib/i18n";
import { useLocations } from "../../../lib/queries";
import type { Character, Location, Scene, Shot, SubmitResult } from "../../../lib/types";
import { LockMark } from "../../../components/shell/PresenceBar";
import { useLockHolder } from "../../../lib/collab";
import { useProjectCtx } from "../context";
import { outlineGroups, outlineOrder } from "./Outline";
import { useStudio } from "./state";

// ── layout ───────────────────────────────────────────────────────────────────
const LANE_H = 236;
const SCENE_X = 300;
const SHOT_X = 590;
const SHOT_W = 220;
const SHOT_GAP = 36;
const SIDE_W = 200;

type SceneData = { scene: Scene | null; index: number; count: number; secs: number; location?: Location };
type ShotData = { shot: Shot; people: Character[]; selected: boolean };
type CharData = { c: Character; lit: boolean };
type LocData = { l: Location };

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "draft", cls: "bg-dim/15 text-mute" },
  keyframe_ready: { label: "keyframe", cls: "bg-info/15 text-info" },
  video_ready: { label: "video", cls: "bg-accent/15 text-accent-ink" },
  approved: { label: "approved", cls: "bg-ok/15 text-ok" },
};

// ── nodes ────────────────────────────────────────────────────────────────────
const SceneNode = memo(function SceneNode({ data }: NodeProps<Node<SceneData>>) {
  const t = useT();
  const s = useStudio();
  const { scene, index, count, secs, location } = data;
  return (
    <div className="w-[230px] rounded-2xl border-2 border-accent/40 bg-panel p-3 shadow-card">
      <Handle type="target" position={Position.Left} id="loc" className="!size-3 !border-2 !border-panel !bg-info" title={t("Connect a location")} />
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-2xs font-bold text-accent-ink">{scene ? `SC${String(index).padStart(2, "0")}` : "—"}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{scene?.title || t("Unsorted shots")}</span>
      </div>
      <p className="mt-1.5 flex items-center gap-1 text-2xs text-mute"><MapPin className="size-3" />{location?.name || <span className="text-dim">{t("no location — connect one")}</span>}</p>
      <p className="mt-0.5 text-2xs tabular-nums text-dim">{count} {t("shots")} · {secs}s</p>
      {s.canEdit && (
        <button type="button" onClick={() => s.addShot(scene?.id ?? null)}
          className="nodrag mt-2 inline-flex items-center gap-1 rounded-md border border-dashed border-accent/50 px-2 py-0.5 text-2xs font-medium text-accent-ink hover:bg-accent/10">
          <Plus className="size-3" />{t("Add shot")}
        </button>
      )}
      <Handle type="source" position={Position.Right} id="out" isConnectable={false} className="!size-2 !bg-accent" />
    </div>
  );
});

const ShotNode = memo(function ShotNode({ data }: NodeProps<Node<ShotData>>) {
  const t = useT();
  const s = useStudio();
  const { submit } = useGenerate();
  const [busy, setBusy] = useState<string | null>(null);
  const { shot, people, selected } = data;
  const thumb = shot.video?.thumb_url || shot.keyframe?.thumb_url || "";
  const st = STATUS[shot.status] ?? STATUS.draft;
  const lock = useLockHolder(`shot:${shot.id}`, `board:${shot.episode_id}`);
  const run = async (path: "keyframe" | "video", what: string) => {
    setBusy(path);
    try {
      await submit(() => api.post<SubmitResult>(`/api/shots/${shot.id}/${path}`, {}), `${what} ${shot.code}`);
      s.refresh();
    } finally { setBusy(null); }
  };
  return (
    <div className={clsx("rounded-2xl border bg-panel shadow-card transition-shadow", selected ? "border-accent ring-2 ring-accent/30" : "border-line")} style={{ width: SHOT_W }}>
      <Handle type="target" position={Position.Left} id="in" isConnectable={false} className="!size-2 !bg-accent" />
      <Handle type="target" position={Position.Top} id="cast" className="!size-3 !border-2 !border-panel !bg-ok" title={t("Connect a character")} />
      <div className="relative h-[104px] overflow-hidden rounded-t-2xl bg-raised">
        {thumb ? <img src={thumb} alt="" className="size-full object-cover" draggable={false} /> : (
          <div className="grid size-full place-items-center text-dim"><ImageIcon className="size-6" /></div>
        )}
        <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1 font-mono text-2xs font-semibold text-white">{shot.code}</span>
        <span className={clsx("absolute right-1.5 top-1.5 rounded px-1 text-2xs font-medium backdrop-blur", st.cls)}>{t(st.label)}</span>
        {shot.video && <Film className="absolute bottom-1.5 right-1.5 size-3.5 text-white drop-shadow" />}
        {shot.generating && <span className="absolute inset-0 grid place-items-center bg-black/35"><Loader2 className="size-5 animate-spin text-white" /></span>}
        {lock && <LockMark name={lock.name} className="absolute bottom-1.5 left-1.5" />}
      </div>
      <div className="space-y-1.5 p-2">
        <p className="line-clamp-2 min-h-[2rem] text-xs leading-4">{shot.action || <span className="text-dim">{t("No prompt yet")}</span>}</p>
        <div className="flex items-center gap-1">
          {people.length ? (
            <span className="flex -space-x-1.5">{people.slice(0, 4).map((c) => <Avatar key={c.id} name={c.name} src={c.avatar_url} size={20} className="ring-2 ring-panel" />)}</span>
          ) : <span className="text-2xs text-dim">{t("nobody")}</span>}
          <span className="ml-auto text-2xs tabular-nums text-dim">{Math.max(shot.extend_to || 0, shot.duration_s)}s</span>
        </div>
        {s.canEdit && !lock && (
          <div className="nodrag flex gap-1">
            <button type="button" disabled={!!busy || shot.generating} onClick={() => void run("keyframe", tr("Keyframe"))}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-line py-1 text-2xs font-medium hover:bg-hover disabled:opacity-50">
              {busy === "keyframe" ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}{t("Keyframe")}
            </button>
            <button type="button" disabled={!!busy || shot.generating} onClick={() => void run("video", tr("Video"))}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-line py-1 text-2xs font-medium hover:bg-hover disabled:opacity-50">
              {busy === "video" ? <Loader2 className="size-3 animate-spin" /> : <Video className="size-3" />}{t("Video")}
            </button>
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} id="out" isConnectable={false} className="!size-2 !bg-accent" />
    </div>
  );
});

const CharacterNode = memo(function CharacterNode({ data }: NodeProps<Node<CharData>>) {
  const t = useT();
  const { c, lit } = data;
  return (
    <div className={clsx("flex items-center gap-2 rounded-xl border bg-panel px-2 py-1.5 shadow-card", lit ? "border-ok" : "border-line")} style={{ width: SIDE_W }}>
      <Avatar name={c.name} src={c.avatar_url} size={34} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold">{c.name}</p>
        <p className={clsx("truncate text-2xs", c.avatar_url ? "text-dim" : "text-warn")}>{c.avatar_url ? (c.role || t("character")) : t("no photo yet")}</p>
      </div>
      <Handle type="source" position={Position.Right} id="cast" className="!size-3 !border-2 !border-panel !bg-ok" title={t("Drag to a shot to put them in it")} />
    </div>
  );
});

const LocationNode = memo(function LocationNode({ data }: NodeProps<Node<LocData>>) {
  const { l } = data;
  return (
    <div className="flex items-center gap-2 rounded-xl border border-line bg-panel px-2 py-1.5 shadow-card" style={{ width: SIDE_W }}>
      <span className="grid size-[34px] shrink-0 place-items-center overflow-hidden rounded-lg bg-raised">
        {l.thumb_url ? <img src={l.thumb_url} alt="" className="size-full object-cover" draggable={false} /> : <MapPin className="size-4 text-info" />}
      </span>
      <p className="min-w-0 flex-1 truncate text-xs font-semibold">{l.name}</p>
      <Handle type="source" position={Position.Right} id="loc" className="!size-3 !border-2 !border-panel !bg-info" />
    </div>
  );
});

const NODE_TYPES = { scene: SceneNode, shot: ShotNode, character: CharacterNode, location: LocationNode };

// ── the map ──────────────────────────────────────────────────────────────────
const posKey = (pid: number) => `veo:filmmap-pos:${pid}`;
const readPos = (pid: number): Record<string, { x: number; y: number }> => {
  try { return JSON.parse(localStorage.getItem(posKey(pid)) || "{}"); } catch { return {}; }
};

function FilmGraph() {
  const t = useT();
  const s = useStudio();
  const { project } = useProjectCtx();
  const { data: locations } = useLocations(project.id);
  const [allLinks, setAllLinks] = useState(false);
  const [hoverChar, setHoverChar] = useState<number | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const ep = s.episode;

  const groups = useMemo(() => (ep ? outlineGroups(ep) : []), [ep]);
  const castById = useMemo(() => new Map(s.cast.map((c) => [c.id, c])), [s.cast]);
  const locById = useMemo(() => new Map((locations ?? []).map((l) => [l.id, l])), [locations]);
  const selShot = s.selected != null ? ep?.shots?.find((x) => x.id === s.selected) : undefined;

  // rebuild the graph from the film (positions of characters/locations you moved are kept)
  useEffect(() => {
    if (!ep) return;
    const saved = readPos(project.id);
    const ns: Node[] = [];
    const es: Edge[] = [];
    const scenes = ep.scenes ?? [];
    groups.forEach((g, lane) => {
      const y = lane * LANE_H;
      const sid = `scene-${g.scene?.id ?? "none"}`;
      ns.push({
        id: sid, type: "scene", position: { x: SCENE_X, y: y + 30 }, draggable: false,
        data: { scene: g.scene, index: g.scene ? scenes.indexOf(g.scene) + 1 : 0, count: g.shots.length,
          secs: g.shots.reduce((a, x) => a + Math.max(x.extend_to || 0, x.duration_s), 0),
          location: g.scene?.location_id ? locById.get(g.scene.location_id) : undefined } satisfies SceneData,
      });
      if (g.scene?.location_id && locById.has(g.scene.location_id)) {
        es.push({ id: `loc-${g.scene.location_id}-${sid}`, source: `loc-${g.scene.location_id}`, sourceHandle: "loc", target: sid, targetHandle: "loc",
          style: { stroke: "var(--color-info)", strokeWidth: 1.5 }, data: { kind: "location", sceneId: g.scene.id } });
      }
      let prev = sid;
      g.shots.forEach((shot, i) => {
        const id = `shot-${shot.id}`;
        ns.push({
          id, type: "shot", position: { x: SHOT_X + i * (SHOT_W + SHOT_GAP), y },
          data: { shot, selected: s.selected === shot.id,
            people: (shot.characters ?? []).map((c) => castById.get(c)).filter((c): c is Character => !!c) } satisfies ShotData,
        });
        es.push({ id: `seq-${prev}-${id}`, source: prev, sourceHandle: "out", target: id, targetHandle: "in", deletable: false, selectable: false,
          style: { stroke: "var(--color-accent)", strokeWidth: 2, opacity: 0.55 }, data: { kind: "sequence" } });
        prev = id;
        for (const cid of shot.characters ?? []) {
          if (!castById.has(cid)) continue;
          const show = allLinks || s.selected === shot.id || hoverChar === cid;
          es.push({ id: `cast-${cid}-${shot.id}`, source: `char-${cid}`, sourceHandle: "cast", target: id, targetHandle: "cast",
            hidden: !show, animated: hoverChar === cid, style: { stroke: "var(--color-ok)", strokeWidth: 1.5 },
            data: { kind: "cast", characterId: cid, shotId: shot.id } });
        }
      });
    });
    s.cast.forEach((c, i) => {
      const id = `char-${c.id}`;
      ns.push({ id, type: "character", position: saved[id] ?? { x: 0, y: i * 62 },
        data: { c, lit: hoverChar === c.id || !!selShot?.characters.includes(c.id) } satisfies CharData });
    });
    const top = s.cast.length * 62 + 40;
    (locations ?? []).forEach((l, i) => {
      const id = `loc-${l.id}`;
      ns.push({ id, type: "location", position: saved[id] ?? { x: 0, y: top + i * 62 }, data: { l } satisfies LocData });
    });
    setNodes(ns);
    setEdges(es);
  }, [ep, groups, s.cast, castById, locations, locById, s.selected, allLinks, hoverChar, selShot, project.id, setNodes, setEdges]);

  const isValidConnection = useCallback((c: Connection | Edge) =>
    (c.source.startsWith("char-") && c.target.startsWith("shot-") && c.targetHandle === "cast")
    || (c.source.startsWith("loc-") && c.target.startsWith("scene-") && c.target !== "scene-none"), []);

  const onConnect = useCallback(async (c: Connection) => {
    if (!s.canEdit) return;
    if (c.source.startsWith("char-") && c.target.startsWith("shot-")) {
      await s.setCast(Number(c.target.slice(5)), Number(c.source.slice(5)), true);
    } else if (c.source.startsWith("loc-") && c.target.startsWith("scene-")) {
      const sceneId = Number(c.target.slice(6));
      const locId = Number(c.source.slice(4));
      const scene = ep?.scenes?.find((x) => x.id === sceneId);
      try {
        await api.patch(`/api/scenes/${sceneId}`, { location_id: locId });
        // the shots of the scene follow it (unless one was set to its own place)
        await Promise.all((ep?.shots ?? []).filter((x) => x.scene_id === sceneId && (!x.location_id || x.location_id === scene?.location_id))
          .map((x) => api.patch(`/api/shots/${x.id}`, { location_id: locId })));
        toast.success(tr("{scene} now takes place at {place}", { scene: scene?.title ?? "", place: locById.get(locId)?.name ?? "" }));
      } catch { /* api toasts */ }
      s.refresh();
    }
  }, [s, ep, locById]);

  const onEdgesDelete = useCallback(async (gone: Edge[]) => {
    if (!s.canEdit) return;
    for (const e of gone) {
      const d = e.data as { kind?: string; characterId?: number; shotId?: number; sceneId?: number } | undefined;
      if (d?.kind === "cast" && d.shotId && d.characterId) await s.setCast(d.shotId, d.characterId, false);
      if (d?.kind === "location" && d.sceneId) {
        try { await api.patch(`/api/scenes/${d.sceneId}`, { location_id: null }); } catch { /* api toasts */ }
        s.refresh();
      }
    }
  }, [s]);

  // drag a shot into another row / position = move it there; characters and places just stay where you put them
  const onNodeDragStop: OnNodeDrag = useCallback((_, node) => {
    if (node.id.startsWith("shot-") && ep && s.canEdit) {
      const lane = Math.max(0, Math.min(groups.length - 1, Math.round(node.position.y / LANE_H)));
      const g = groups[lane];
      const shotId = Number(node.id.slice(5));
      const others = g.shots.filter((x) => x.id !== shotId);
      const idx = Math.max(0, Math.min(others.length, Math.round((node.position.x - SHOT_X) / (SHOT_W + SHOT_GAP))));
      const before = outlineOrder(ep).filter((id) => id !== shotId);
      const anchor = others[idx]?.id ?? others.at(-1)?.id;
      const at = anchor == null ? before.length : before.indexOf(anchor) + (others[idx] ? 0 : 1);
      void s.moveShot(shotId, g.scene?.id ?? null, at);
      return;
    }
    if (node.id.startsWith("char-") || node.id.startsWith("loc-")) {
      const all = readPos(project.id);
      all[node.id] = node.position;
      try { localStorage.setItem(posKey(project.id), JSON.stringify(all)); } catch { /* storage blocked */ }
    }
  }, [ep, groups, s, project.id]);

  if (!ep) return null;
  const dark = document.documentElement.dataset.theme !== "light";
  return (
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      onConnect={(c) => void onConnect(c)} onEdgesDelete={(e) => void onEdgesDelete(e)} isValidConnection={isValidConnection}
      onNodeDragStop={onNodeDragStop} nodesConnectable={s.canEdit} edgesReconnectable={false}
      onNodeClick={(_, n) => { if (n.id.startsWith("shot-")) s.select(Number(n.id.slice(5))); }}
      onNodeMouseEnter={(_, n) => { if (n.id.startsWith("char-")) setHoverChar(Number(n.id.slice(5))); }}
      onNodeMouseLeave={(_, n) => { if (n.id.startsWith("char-")) setHoverChar(null); }}
      colorMode={dark ? "dark" : "light"} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }} minZoom={0.15} maxZoom={1.6}
      deleteKeyCode={s.canEdit ? ["Delete", "Backspace"] : null} proOptions={{ hideAttribution: true }}
      style={{ background: "var(--color-bg)" }}>
      <Background gap={24} size={1.2} color="var(--color-line)" />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeStrokeWidth={2} className="!hidden @3xl:!block" style={{ background: "var(--color-panel)" }}
        nodeColor={(n) => (n.type === "scene" ? "var(--color-accent)" : n.type === "character" ? "var(--color-ok)" : n.type === "location" ? "var(--color-info)" : "var(--color-raised)")} />
      <Panel position="top-left">
        <div className="flex items-center gap-2 rounded-xl border border-line bg-panel/90 px-2 py-1 text-2xs text-mute shadow-card backdrop-blur">
          <Clapperboard className="size-3.5 shrink-0 text-accent-ink" />
          <span className="hidden @md:inline">{t("Each row is a scene, its shots in order")}</span>
          {s.canEdit && (
            <Tooltip content={t("Drag a character's green dot to a shot to put them in it · a location's blue dot to a scene · drag a shot to another row to move it · select a link and press Delete to remove it")}>
              <span className="grid size-5 cursor-help place-items-center rounded-full border border-line font-semibold">?</span>
            </Tooltip>
          )}
          <Toggle checked={allLinks} onChange={setAllLinks} label={<span className="text-2xs">{t("All cast links")}</span>} />
        </div>
      </Panel>
    </ReactFlow>
  );
}

/** The film as connected nodes: scenes → shots, with characters and locations wired in. Edits change the real film. */
export default function FilmMap() {
  const t = useT();
  const s = useStudio();
  if (!s.episode) return null;
  if (!(s.episode.shots ?? []).some((x) => x.include)) {
    return <div className="grid h-full place-items-center p-6 text-sm text-mute">{t("No shots yet — write them in the Shot list, then they appear here.")}</div>;
  }
  return <div className="@container h-full"><ReactFlowProvider><FilmGraph /></ReactFlowProvider></div>;
}
