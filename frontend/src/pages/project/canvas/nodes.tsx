import {
  BaseEdge, EdgeLabelRenderer, Handle, Position, getBezierPath, useConnection,
  type Edge, type EdgeProps, type Node as FlowNode, type NodeProps,
} from "@xyflow/react";
import { clsx } from "clsx";
import {
  ArrowRightToLine, ChevronDown, CircleCheck, Clapperboard, Download, Equal, Film, GripVertical, Image as ImageIcon, Link2, MapPin, Moon,
  Music, Plus, RotateCcw, Sun, Sunrise, Sunset, TriangleAlert, Unlink,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Menu, Tooltip } from "../../../components/ui";
import { LockMark } from "../../../components/shell/PresenceBar";
import { useLockHolder } from "../../../lib/collab";
import { secs as fmtSecs } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import type { Character, ExportRow, Location, Shot } from "../../../lib/types";
import { qcState } from "../studio/continuity";
import { sceneKey, useActions, usePlaces } from "./actions";
import type { SceneX } from "./data";
import {
  LAYOUT, LINK_HINT, LINK_LABEL, LINK_MODES, STEP_LABEL, lengthLabel, makeBody, nextLinkMode, shotDots, shotFlags, shotSlot,
  type LinkMode, type SceneMusic, type ShotInfo,
} from "./model";
import { Faces, PlayChip, PriceButton, StepDots } from "./parts";
import { readDrag, useCanvasUI } from "./store";

// ── shot ─────────────────────────────────────────────────────────────────────

export type ShotNodeData = {
  shot: Shot; people: Character[]; info: ShotInfo | undefined; linkFrom: { id: number; code: string; mode: LinkMode } | null;
  /** the project's frame is landscape (thumbnails fill the box) */
  wide: boolean;
};
export type ShotFlowNode = FlowNode<ShotNodeData, "shot">;

/** Drop handling for a library drag: `accept` says whether this payload kind lands here. */
function useDropZone(accept: (kind: string) => boolean, onDrop: (e: DragEvent) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        const kind = useCanvasUI.getState().drag?.kind;
        if (!kind || !accept(kind)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        if (!over) setOver(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        const kind = useCanvasUI.getState().drag?.kind;
        if (!kind || !accept(kind)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        onDrop(e);
        useCanvasUI.getState().setDrag(null);
      },
    },
  };
}

export const ShotNode = memo(function ShotNode({ id, data, selected }: NodeProps<ShotFlowNode>) {
  const t = useT();
  const a = useActions();
  const { shot, people, info, linkFrom, wide } = data;
  const dots = useMemo(() => shotDots(shot, info), [shot, info]);
  const flags = useMemo(() => shotFlags(dots), [dots]);
  const qc = qcState(shot);
  // these re-render the node only when its own answer changes; a picked face (dim / lit) and a library drag (drop
  // targets) are CSS on the board (data-hl, data-drag), so they never re-render the nodes at all
  const hit = useCanvasUI((s) => s.matches.has(shot.id));
  const focused = useCanvasUI((s) => s.current === shot.id);
  const linking = useConnection((c) => c.inProgress && c.fromNode?.id !== id);
  const lock = useLockHolder(`shot:${shot.id}`, `board:${shot.episode_id}`);
  const editable = a.canEdit && !lock;
  const drop = useDropZone((k) => editable && (k === "character" || k === "prop"), (e) => {
    const p = readDrag(e);
    if (p?.kind === "character") void a.addCharacter([shot.id], p.id);
    else if (p?.kind === "prop") void a.addProp(shot.id, p.id);
  });

  // hover plays the clip (after a short pause, so sweeping the pointer across the canvas loads nothing)
  const [play, setPlay] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const clip = shot.lipsync?.url || shot.video?.url || "";
  const poster = shot.video?.thumb_url || shot.keyframe?.thumb_url || "";
  const failed = flags.failed[0];
  const running = flags.running || shot.generating;

  return (
    <div {...drop.props} style={{ width: LAYOUT.shotW, height: LAYOUT.shotH }} data-cast={shot.characters.join(" ")} data-drop={editable ? "" : undefined}
      onMouseEnter={() => { if (clip) timer.current = window.setTimeout(() => setPlay(true), 350); }}
      onMouseLeave={() => { window.clearTimeout(timer.current); setPlay(false); }}
      className={clsx("cv-shot hud relative flex flex-col rounded-xl border bg-panel shadow-card transition-[opacity,box-shadow,border-color] duration-150",
        selected ? "border-accent shadow-[0_0_0_1px_var(--color-accent),0_0_26px_-6px_var(--color-accent)]"
          : focused ? "border-accent/80 shadow-[0_0_0_2px_var(--color-accent)]"
          : hit ? "border-accent/50" : "border-line")}>
      <Handle type="target" position={Position.Left} id="in" isConnectableStart={false} className="canvas-handle canvas-handle-in"
        title={t("Drag another shot's right edge here: this shot then continues from it")} />
      {/* while a link is being drawn, the whole shot is a target */}
      <Handle type="target" position={Position.Left} id="drop" isConnectableStart={false} className={clsx("canvas-handle-drop", linking && "is-on")}>
        {linking && <span className="mono pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-2xs font-semibold uppercase tracking-wider text-accent-ink">{t("Link here")}</span>}
      </Handle>
      <div className="p-1.5 pb-0">
        <div className={clsx("scr relative h-[118px]", !poster && "scr-empty", selected && "is-lit", running && "gen-ring")}>
          {play && clip ? (
            <video src={clip} poster={poster || undefined} autoPlay muted loop playsInline className={clsx("size-full", wide ? "object-cover" : "object-contain")} />
          ) : poster ? (
            <img src={poster} alt="" loading="lazy" draggable={false} className={clsx("size-full", wide ? "object-cover" : "object-contain")} />
          ) : (
            <div className="grid size-full place-items-center text-white/35"><ImageIcon className="size-6" /></div>
          )}
          <span className="mono absolute left-2 top-2 z-[5] rounded bg-black/65 px-1 text-2xs font-semibold text-white">{shot.code}</span>
          <span className="absolute right-2 top-2 z-[5] flex items-center gap-1">
            {running && <span className="grid h-5 place-items-center rounded bg-black/65 px-1"><span className="eq" aria-label={t("Being made now")}><i /><i /><i /><i /></span></span>}
            {shot.status === "approved" && <Flag tone="ok" label={t("Approved")} />}
            {flags.stale.length > 0 && <Flag tone="warn" label={t("Out of date")} title={flags.stale.map((d) => `${t(STEP_LABEL[d.step])}${d.staleReason ? `: ${d.staleReason}` : ""}`).join(" · ")} />}
            {qc && (qc.passed
              ? <Tooltip content={t("Quality check passed")}><span role="img" aria-label={t("Quality check passed")} className="grid size-5 place-items-center rounded bg-black/65 text-ok"><CircleCheck className="size-3.5" /></span></Tooltip>
              : <Tooltip content={qc.flags.length ? t("Quality check failed: {what}", { what: qc.flags.map((f) => t(f)).join(", ") }) : t("Quality check failed")}>
                  <span role="img" aria-label={t("Quality check failed")} className="grid size-5 place-items-center rounded bg-black/65 text-bad"><TriangleAlert className="size-3.5" /></span>
                </Tooltip>)}
          </span>
          {lock && <LockMark name={lock.name} className="absolute bottom-2 left-2 z-[5]" />}
          {failed && !running && (
            <div className="nodrag absolute inset-x-1 bottom-1 z-[6] flex items-start gap-1.5 rounded-md border border-bad/50 bg-black/85 p-1.5 text-white">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-bad" />
              <p className="line-clamp-2 min-w-0 flex-1 text-2xs leading-tight" title={failed.error}>
                <span className="font-semibold">{t("{step} failed", { step: t(STEP_LABEL[failed.step]) })}:</span> {failed.error}
              </p>
              {editable && (
                <button type="button" onClick={(e) => { e.stopPropagation(); void a.runStep(shot.id, failed.step); }}
                  className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-white/25 px-1.5 text-2xs font-medium hover:bg-white/10">
                  <RotateCcw className="size-3" />{t("Retry")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 px-2 pt-1.5">
        <span className="mono text-2xs tabular-nums text-mute">{lengthLabel(shot.duration_s, shot.extend_to)}</span>
        {linkFrom && (
          <Tooltip content={t(LINK_HINT[linkFrom.mode], { target: shot.code, source: linkFrom.code })}>
            <span className="mono inline-flex items-center gap-0.5 text-2xs text-accent-ink"><ModeIcon mode={linkFrom.mode} className="size-3" />{linkFrom.code.split("-").at(-1)}</span>
          </Tooltip>
        )}
        <span className="min-w-0 flex-1 truncate text-2xs text-dim" title={shot.action}>{shot.action || t("No words yet")}</span>
        <Faces people={people} max={3} size={20} />
      </div>
      <StepDots dots={dots} canEdit={editable} onRun={(step) => void a.runStep(shot.id, step)} className="px-2 pb-2 pt-1.5" />
      <div aria-hidden className={clsx("cv-drop pointer-events-none absolute inset-0 z-10 place-items-center rounded-xl border-2 border-dashed transition-colors",
        drop.over ? "border-ok bg-ok/15" : "border-ok/50 bg-ok/5")}>
        {drop.over && <span className="rounded-md bg-panel px-2 py-1 text-xs font-semibold text-ok shadow-pop">{t("Add {name}", { name: useCanvasUI.getState().drag?.name ?? "" })}</span>}
      </div>
      <Handle type="source" position={Position.Right} id="out" isConnectable={editable} className="canvas-handle canvas-handle-out"
        title={t("Drag to another shot to link them: that shot continues from this one")} />
    </div>
  );
});

function Flag({ tone, label, title }: { tone: "ok" | "warn" | "bad"; label: string; title?: string }) {
  const cls = { ok: "text-ok", warn: "text-warn", bad: "text-bad" }[tone];
  const el = <span className={clsx("mono rounded bg-black/70 px-1 py-px text-2xs font-semibold uppercase tracking-wide", cls)}>{label}</span>;
  return title ? <Tooltip content={title}>{el}</Tooltip> : el;
}

export function ModeIcon({ mode, className }: { mode: LinkMode; className?: string }) {
  if (mode === "extend") return <ArrowRightToLine className={className} />;
  if (mode === "end_frame") return <Equal className={className} />;
  return <Link2 className={className} />;
}

// ── scene row ────────────────────────────────────────────────────────────────

export type SceneNodeData = {
  scene: SceneX | null; index: number; shotIds: number[]; secs: number; place?: Location; collapsed: boolean;
  music?: SceneMusic; w: number; h: number; onToggle: (key: string) => void;
};
export type SceneFlowNode = FlowNode<SceneNodeData, "scene">;

function TimeIcon({ tod, className }: { tod: string; className?: string }) {
  const s = tod.toLowerCase();
  if (/night|midnight|late/.test(s)) return <Moon className={className} />;
  if (/dawn|morning|sunrise/.test(s)) return <Sunrise className={className} />;
  if (/dusk|evening|sunset|golden/.test(s)) return <Sunset className={className} />;
  return <Sun className={className} />;
}

function Chip({ icon, children, tone = "neutral", title }: { icon?: ReactNode; children: ReactNode; tone?: "neutral" | "info" | "warn"; title?: string }) {
  return (
    <span title={title} className={clsx("inline-flex h-6 max-w-[11rem] items-center gap-1 rounded-md border px-1.5 text-2xs",
      tone === "info" ? "border-info/30 bg-info/10 text-info" : tone === "warn" ? "border-dashed border-warn/40 text-warn" : "border-line bg-raised/60 text-mute")}>
      {icon}<span className="truncate">{children}</span>
    </span>
  );
}

export const SceneNode = memo(function SceneNode({ data, selected }: NodeProps<SceneFlowNode>) {
  const t = useT();
  const a = useActions();
  const places = usePlaces();
  const { scene, index, shotIds, secs, place, collapsed, music, w, h, onToggle } = data;
  const key = sceneKey(scene?.id);
  const title = scene?.title || t("Shots without a scene");
  const dragKind = useCanvasUI((s) => s.drag?.kind ?? null);
  const dragName = useCanvasUI((s) => s.drag?.name ?? "");
  // a place lands anywhere on the row; a face on the header (it goes into every shot of the scene)
  const placeDrop = useDropZone((k) => a.canEdit && !!scene && k === "place", (e) => {
    const p = readDrag(e);
    if (p?.kind === "place" && scene) void a.setScenePlace(scene.id, p.id);
  });
  const castDrop = useDropZone((k) => a.canEdit && k === "character" && shotIds.length > 0, (e) => {
    const p = readDrag(e);
    if (p?.kind === "character") void a.addCharacter(shotIds, p.id);
  });
  const placeOn = a.canEdit && !!scene && dragKind === "place";
  const castOn = a.canEdit && dragKind === "character" && shotIds.length > 0;
  const code = scene ? `SC${String(index).padStart(2, "0")}` : "—";
  const addAt = shotSlot(shotIds.length);
  return (
    <div {...placeDrop.props} style={{ width: w, height: h }}
      className={clsx("relative rounded-2xl border transition-[border-color,box-shadow,background-color] duration-150",
        selected ? "border-accent/70 bg-accent/[0.04] shadow-[0_0_0_1px_var(--color-accent)]" : "border-line bg-panel/40",
        placeOn && (placeDrop.over ? "border-info bg-info/10" : "border-dashed border-info/60"))}>
      <span aria-hidden className="edge-light pointer-events-none absolute inset-x-6 top-0 h-px opacity-60" />
      <header {...castDrop.props} className={clsx("relative px-2.5 pt-2", castOn && "rounded-t-2xl")} style={{ height: LAYOUT.headerH }}>
        <div className="flex h-8 items-center gap-1.5">
          {a.canEdit && scene && (
            <Tooltip content={t("Drag up or down to move the scene")}>
              <span className="scene-handle grid size-7 shrink-0 cursor-grab place-items-center rounded-md text-dim hover:bg-hover hover:text-ink active:cursor-grabbing" aria-label={t("Move the scene")}>
                <GripVertical className="size-4" />
              </span>
            </Tooltip>
          )}
          <button type="button" onClick={(e) => { e.stopPropagation(); onToggle(key); }} aria-expanded={!collapsed}
            aria-label={collapsed ? t("Open the scene") : t("Fold the scene")}
            className="nodrag grid size-7 shrink-0 place-items-center rounded-md text-dim hover:bg-hover hover:text-ink">
            <ChevronDown className={clsx("size-4 transition-transform", collapsed && "-rotate-90")} />
          </button>
          <span className="mono shrink-0 rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-2xs font-semibold tracking-wide text-accent-ink">{code}</span>
          <span className="min-w-0 truncate text-sm font-semibold tracking-tight">{title}</span>
          <span className="mono shrink-0 text-2xs tabular-nums text-dim">{shotIds.length} · {fmtSecs(secs)}</span>
          <span className="flex-1" />
          {music ? <PlayChip url={music.url} label={<><Music className="size-3" />{t("Music")}</>} />
            : scene && a.canEdit && shotIds.length > 0 && (
              <Tooltip content={t("A piece of music for each scene that has none (you see the price first)")}>
                <button type="button" onClick={(e) => { e.stopPropagation(); void a.addMusic(); }}
                  className="nodrag inline-flex h-7 items-center gap-1 rounded-lg border border-dashed border-line px-2 text-2xs text-mute hover:border-ai/50 hover:text-ai">
                  <Music className="size-3" />{t("Add music")}
                </button>
              </Tooltip>
            )}
          {a.canEdit && shotIds.length > 0 && (
            <PriceButton eid={a.eid} lazy={!selected} variant="secondary" body={makeBody(shotIds)} label={t("Make scene")} doneLabel={t("Scene made")}
              icon={<Clapperboard className="size-3.5" />} onRun={() => a.make(shotIds, t("Make {scene}", { scene: title }))}
              title={t("Make everything still missing in this scene: pictures, videos, voices and sound (you see the price first)")} />
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 overflow-hidden pl-1">
          {scene && (a.canEdit ? (
            <Menu placement="bottom-start" width={220} trigger={(p) => (
              <button type="button" {...p} onClick={(e) => { e.stopPropagation(); p.onClick(); }} className="nodrag">
                {place ? <Chip tone="info" icon={<MapPin className="size-3 shrink-0" />} title={t("Change the place")}>{place.name}</Chip>
                  : <Chip tone="warn" icon={<MapPin className="size-3 shrink-0" />}>{t("Add a place")}</Chip>}
              </button>
            )} items={[
              ...places.map((l) => ({ label: l.name, icon: <MapPin className="size-3.5" />, active: l.id === place?.id,
                onClick: () => void a.setScenePlace(scene.id, l.id) })),
              ...(place ? [{ label: t("No place"), separator: true, onClick: () => void a.setScenePlace(scene.id, null) }] : []),
              ...(!places.length ? [{ label: t("No places yet: add them in Characters & places"), disabled: true }] : []),
            ]} />
          ) : place && <Chip tone="info" icon={<MapPin className="size-3 shrink-0" />}>{place.name}</Chip>)}
          {scene?.time_of_day && <Chip icon={<TimeIcon tod={scene.time_of_day} className="size-3 shrink-0" />}>{scene.time_of_day}</Chip>}
          {scene?.emotion && <Chip title={t("Mood")}>{scene.emotion}</Chip>}
          {collapsed && shotIds.length > 0 && <span className="text-2xs text-dim">{t("{n} shots folded away", { n: shotIds.length })}</span>}
        </div>
        {castOn && (
          <div className={clsx("pointer-events-none absolute inset-1 z-10 grid place-items-center rounded-xl border-2 border-dashed",
            castDrop.over ? "border-ok bg-ok/15" : "border-ok/50 bg-panel/80")}>
            <span className="text-xs font-semibold text-ok">{t("Drop to add {name} to all {n} shots", { name: dragName, n: shotIds.length })}</span>
          </div>
        )}
      </header>
      {!collapsed && a.canEdit && (
        <button type="button" onClick={(e) => { e.stopPropagation(); void a.addShot(scene?.id ?? null); }}
          className="nodrag absolute grid place-items-center rounded-xl border border-dashed border-line text-mute transition-colors hover:border-accent/50 hover:bg-accent/5 hover:text-accent-ink"
          style={{ left: addAt.x, top: addAt.y, width: LAYOUT.shotW, height: LAYOUT.shotH }}>
          <span className="flex flex-col items-center gap-1.5 text-xs font-medium"><Plus className="size-5" />{shotIds.length ? t("Add a shot") : t("Add the first shot")}</span>
        </button>
      )}
      {placeOn && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 grid place-items-center">
          <span className={clsx("rounded-md bg-panel px-2 py-1 text-xs font-semibold shadow-pop", placeDrop.over ? "text-info" : "text-mute")}>
            {t("Drop to set the place: {name}", { name: dragName })}
          </span>
        </div>
      )}
    </div>
  );
});

// ── the film ─────────────────────────────────────────────────────────────────

export type FilmNodeData = {
  secs: number; scenes: number; shots: number; withVideo: number;
  /** the newest render, and the newest that finished (to download) */
  latest: ExportRow | null; ready: ExportRow | null;
};
export type FilmFlowNode = FlowNode<FilmNodeData, "film">;

export const FilmNode = memo(function FilmNode({ data }: NodeProps<FilmFlowNode>) {
  const t = useT();
  const a = useActions();
  const { secs, scenes, shots, withVideo, latest, ready } = data;
  const rendering = latest && (latest.status === "queued" || latest.status === "running");
  return (
    <div className="hud relative w-[320px] rounded-2xl border border-accent/40 bg-panel p-3.5 shadow-lift">
      <span aria-hidden className="edge-light pointer-events-none absolute inset-x-4 top-0 h-px" />
      <div className="flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-lg border border-accent/30 bg-accent/10 text-accent-ink"><Film className="size-4" /></span>
        <div className="min-w-0">
          <p className="eyebrow">{t("The film")}</p>
          <p className="mono text-lg font-semibold tabular-nums leading-tight">{fmtSecs(secs)}</p>
        </div>
      </div>
      <p className="mono mt-2 text-2xs uppercase tracking-wider tabular-nums text-dim">
        {t("{n} scenes", { n: scenes })} · {t("{n} shots", { n: shots })} · {t("{n} with video", { n: withVideo })}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {a.canEdit && (
          <PriceButton eid={a.eid} body={{ action: "export" }} label={rendering ? t("Rendering…") : t("Render")} disabled={!!rendering || !withVideo}
            icon={<Film className="size-3.5" />} onRun={a.render} title={withVideo ? t("Put the film together: clips, voices, sound, music and captions (you see the price first)") : t("Make some videos first")} />
        )}
        {ready && (
          <a href={ready.url} download className="nodrag inline-flex h-7 items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 text-xs font-medium hover:bg-hover">
            <Download className="size-3.5" />{t("Download")}{ready.version ? <span className="mono text-2xs text-dim">v{ready.version}</span> : null}
          </a>
        )}
      </div>
    </div>
  );
});

// ── links between shots ──────────────────────────────────────────────────────

export type LinkEdgeData = { sourceShotId: number; targetShotId: number; sourceCode: string; targetCode: string; mode: LinkMode };
export type LinkFlowEdge = Edge<LinkEdgeData, "link">;

/** A continuity link with its kind in plain words ("Continue", "Exact match", "Extend"): click the label to change it. */
export function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps<LinkFlowEdge>) {
  const t = useT();
  const a = useActions();
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  if (!data) return <BaseEdge id={id} path={path} />;
  const other = nextLinkMode(data.mode);
  const vars = { source: data.sourceCode, target: data.targetCode };
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={18}
        style={{ stroke: "var(--color-accent)", strokeWidth: selected ? 3 : 2 }} />
      <EdgeLabelRenderer>
        {/* below the line, clear of the link handles of the two shots */}
        <div className="nodrag nopan group absolute" style={{ transform: `translate(-50%, 0) translate(${lx}px, ${ly + 18}px)`, pointerEvents: "all" }}>
          <div className={clsx("flex items-center rounded-lg border bg-panel shadow-card", selected ? "border-accent shadow-[0_0_14px_-4px_var(--color-accent)]" : "border-accent/40")}>
            <Tooltip content={a.canEdit ? t("{what} · click: {next}", { what: t(LINK_HINT[data.mode], vars), next: t(LINK_LABEL[other]) }) : t(LINK_HINT[data.mode], vars)}>
              <button type="button" disabled={!a.canEdit} onClick={() => void a.setLinkMode(data.targetShotId, other)}
                className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-lg px-1.5 text-2xs font-semibold text-accent-ink transition-colors hover:bg-accent/10 disabled:cursor-default">
                <ModeIcon mode={data.mode} className="size-3.5" />{t(LINK_LABEL[data.mode])}
              </button>
            </Tooltip>
            {a.canEdit && (
              <Menu placement="bottom-start" width={220} trigger={(p) => (
                <button type="button" {...p} aria-label={t("Link options")}
                  className={clsx("h-7 w-6 place-items-center rounded-lg text-dim hover:bg-hover hover:text-ink group-hover:grid group-focus-within:grid", selected || p["aria-expanded"] ? "grid" : "hidden")}>
                  <ChevronDown className="size-3" />
                </button>
              )} items={[
                ...LINK_MODES.map((m) => ({ label: t(LINK_LABEL[m]), icon: <ModeIcon mode={m} className="size-3.5" />, active: m === data.mode,
                  onClick: () => { if (m !== data.mode) void a.setLinkMode(data.targetShotId, m); } })),
                { label: t("Remove the link"), icon: <Unlink className="size-3.5" />, danger: true, separator: true, onClick: () => void a.link(data.targetShotId, null) },
              ]} />
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const NODE_TYPES = { shot: ShotNode, scene: SceneNode, film: FilmNode };
export const EDGE_TYPES = { link: LinkEdge };
