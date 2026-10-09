import "@xyflow/react/dist/style.css";
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MiniMap, NodeToolbar, Panel, Position, ReactFlow, ReactFlowProvider,
  getBezierPath, useEdgesState, useNodesState,
  type Connection, type Edge, type EdgeProps, type Node, type NodeProps, type OnNodeDrag,
} from "@xyflow/react";
import { clsx } from "clsx";
import {
  ArrowRightToLine, ChevronDown, CircleCheck, Clapperboard, Film, ImageIcon, Link2, Loader2, MapPin, MessageSquareWarning, Plus, Sparkles,
  StepForward, TriangleAlert, Unlink, Video,
} from "lucide-react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { toast } from "sonner";
import { useGenerate } from "../../../components/Generate";
import { Avatar, Button, Input, Menu, Popover, Segmented, Toggle, Tooltip } from "../../../components/ui";
import "../../../styles/production.css";
import { api } from "../../../lib/api";
import { tr, useT } from "../../../lib/i18n";
import { useLocations } from "../../../lib/queries";
import type { Character, Location, Scene, Shot, SubmitResult } from "../../../lib/types";
import { LockMark } from "../../../components/shell/PresenceBar";
import { useLockHolder } from "../../../lib/collab";
import { useProjectCtx } from "../context";
import { dialogueIssues, linkFromOf, qcState, staleTakes, type LinkFrom, type LinkMode } from "./continuity";
import { outlineGroups, outlineOrder } from "./Outline";
import { useStudio } from "./state";

// ── layout ───────────────────────────────────────────────────────────────────
const LANE_H = 236;
const SCENE_X = 300;
const SHOT_X = 590;
const SHOT_W = 220;
const SHOT_GAP = 36;
const SIDE_W = 200;
const DURATIONS = [4, 6, 8] as const;

type SceneData = { scene: Scene | null; index: number; count: number; secs: number; location?: Location };
type ShotData = { shot: Shot; people: Character[]; selected: boolean; lang: string; linkFrom: LinkFrom | null };
type CharData = { c: Character; lit: boolean };
type LocData = { l: Location };
/** A continuity link: the target shot continues from the source (keyframe from its last frame, or video extending its clip). */
type LinkEdgeData = { kind: "link"; sourceShotId: number; targetShotId: number; sourceCode: string; targetCode: string; mode: LinkMode };

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "draft", cls: "bg-black/65 text-white/80" },
  keyframe_ready: { label: "keyframe", cls: "bg-black/65 text-info" },
  video_ready: { label: "video", cls: "bg-black/65 text-accent" },
  approved: { label: "approved", cls: "bg-black/65 text-ok" },
};

// ── nodes ────────────────────────────────────────────────────────────────────
const SceneNode = memo(function SceneNode({ data }: NodeProps<Node<SceneData>>) {
  const t = useT();
  const s = useStudio();
  const { scene, index, count, secs, location } = data;
  return (
    <div className="hud relative w-[230px] rounded-xl border border-accent/35 bg-panel p-3 shadow-card">
      <span aria-hidden className="edge-light pointer-events-none absolute inset-x-3 top-0 h-px" />
      <Handle type="target" position={Position.Left} id="loc" className="!size-3 !border-2 !border-panel !bg-info" title={t("Connect a location")} />
      <div className="flex items-center gap-2">
        <span className="mono rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-2xs font-semibold tracking-wide text-accent-ink">{scene ? `SC${String(index).padStart(2, "0")}` : "—"}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">{scene?.title || t("Unsorted shots")}</span>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-2xs text-mute"><MapPin className="size-3 shrink-0 text-info" />{location?.name || <span className="text-dim">{t("no location — connect one")}</span>}</p>
      <p className="mono mt-1.5 text-2xs uppercase tracking-wider tabular-nums text-dim">{count} {t("shots")} · {secs}s</p>
      {s.canEdit && (
        <button type="button" onClick={() => s.addShot(scene?.id ?? null)}
          className="nodrag mt-2.5 inline-flex items-center gap-1 rounded-md border border-dashed border-accent/45 px-2 py-0.5 text-2xs font-medium text-accent-ink transition-colors hover:bg-accent/10">
          <Plus className="size-3" />{t("Add shot")}
        </button>
      )}
      <Handle type="source" position={Position.Right} id="out" isConnectable={false} className="!size-2 !bg-accent" />
    </div>
  );
});

/** One compact status mark on a shot node: an icon (never colour alone) with its meaning in a tooltip and for screen readers. */
function Mark({ tip, className, children }: { tip: string; className?: string; children: ReactNode }) {
  return (
    <Tooltip content={tip}>
      <span role="img" aria-label={tip} className={clsx("grid size-4 shrink-0 place-items-center", className)}>{children}</span>
    </Tooltip>
  );
}

const FILLED = { fill: "currentColor", fillOpacity: 0.28 } as const;

/** Keyframe / video present, QC outcome, stale takes, dialogue that won't fit the clip, and the continuity link. */
function ShotBadges({ shot, lang, linkFrom }: { shot: Shot; lang: string; linkFrom: LinkFrom | null }) {
  const t = useT();
  const qc = qcState(shot);
  const stale = staleTakes(shot);
  const dlg = dialogueIssues(shot, lang);
  const dlgText = dlg ? [
    dlg.words > dlg.cap && t("{words} words in a {s}s clip; about {cap} fit. Split the shot or shorten the line.", { words: dlg.words, s: shot.duration_s, cap: dlg.cap }),
    dlg.speakers > 1 && t("Two speakers in one clip: one speaker per shot keeps voices and lips reliable."),
  ].filter(Boolean).join(" ") : "";
  return (
    <div className="flex items-center gap-1">
      <Mark tip={shot.keyframe ? t("Keyframe ready") : t("No keyframe yet")} className={shot.keyframe ? "text-info" : "text-dim/50"}>
        <ImageIcon className="size-3.5" {...(shot.keyframe ? FILLED : {})} />
      </Mark>
      <Mark tip={shot.video ? t("Video ready") : t("No video yet")} className={shot.video ? "text-accent-ink" : "text-dim/50"}>
        <Film className="size-3.5" {...(shot.video ? FILLED : {})} />
      </Mark>
      {qc && (qc.passed
        ? <Mark tip={t("QC passed")} className="text-ok"><CircleCheck className="size-3.5" /></Mark>
        : <Mark tip={qc.flags.length ? t("QC failed: {what}", { what: qc.flags.map((f) => t(f)).join(", ") }) : t("QC failed")} className="text-bad"><TriangleAlert className="size-3.5" /></Mark>)}
      {stale.length > 0 && (
        <Mark tip={t("Stale — made before an edit: {what}", { what: stale.map((x) => (x.reason ? `${t(x.kind)}: ${x.reason}` : t(x.kind))).join(" · ") })} className="text-warn">
          <span className="block size-2 rounded-full bg-warn ring-2 ring-warn/30" />
        </Mark>
      )}
      {dlg && <Mark tip={dlgText} className="text-warn"><MessageSquareWarning className="size-3.5" /></Mark>}
      {linkFrom && (
        <Mark tip={linkFrom.mode === "extend" ? t("Extends {code}'s clip", { code: linkFrom.code }) : t("Starts from {code}'s last frame", { code: linkFrom.code })}
          className="ml-auto text-accent-ink">
          {linkFrom.mode === "extend" ? <ArrowRightToLine className="size-3.5" /> : <Link2 className="size-3.5" />}
        </Mark>
      )}
    </div>
  );
}

/** Hover-toolbar button of a shot node. */
function Tool({ title, onClick, children }: { title: string; onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void; children: ReactNode }) {
  return (
    <Tooltip content={title}>
      <button type="button" aria-label={title} onClick={onClick}
        className="grid size-7 place-items-center rounded-md text-mute transition-colors hover:bg-hover hover:text-ink">{children}</button>
    </Tooltip>
  );
}

/** "Next shot": the shot after this one, same cast / outfits / place / props, continuing from its last frame or extending its clip. */
function NextShotPopover({ shot, anchor, open, onClose }: { shot: Shot; anchor: RefObject<HTMLButtonElement | null>; open: boolean; onClose: () => void }) {
  const t = useT();
  const s = useStudio();
  const [action, setAction] = useState("");
  const [mode, setMode] = useState<LinkMode>("last_frame");
  const [dur, setDur] = useState<4 | 6 | 8>(DURATIONS.find((d) => d === shot.duration_s) ?? 8);
  const [gen, setGen] = useState(false);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const id = await s.addNextShot(shot.id, { action: action.trim(), mode, duration_s: dur, generate: gen });
      if (id != null) { setAction(""); onClose(); }
    } finally { setBusy(false); }
  };
  return (
    // `nokey`: React Flow leaves the keyboard alone inside (no node moves / deletes while typing)
    <Popover open={open} onClose={onClose} anchor={anchor} placement="bottom-start" width={284} className="nokey p-3">
      <div className="space-y-2.5">
        <p className="flex items-center gap-1.5 text-xs font-semibold"><StepForward className="size-3.5 text-accent-ink" />{t("Next shot after {code}", { code: shot.code })}</p>
        <Input value={action} onChange={(e) => setAction(e.target.value)} placeholder={t("The action continues")} aria-label={t("What happens next")}
          autoFocus className="h-8 text-xs" onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented size="sm" aria-label={t("How it continues")} value={mode} onChange={setMode} options={[
            { value: "last_frame", label: t("last frame"), title: t("Its keyframe starts from {code}'s last frame", { code: shot.code }) },
            { value: "extend", label: t("extend"), title: t("Its video is generated as an extension of {code}'s clip", { code: shot.code }) },
          ]} />
          <Segmented size="sm" aria-label={t("Length")} value={dur} onChange={setDur} options={DURATIONS.map((d) => ({ value: d, label: `${d}s` }))} />
        </div>
        <Toggle checked={gen} onChange={setGen} label={<span className="text-xs">{t("Generate keyframe + video now")}</span>} />
        <p className="text-2xs leading-snug text-dim">
          {t("Same cast, outfits, place and props as {code}.", { code: shot.code })}{gen && ` ${t("Queues a keyframe and a video job (paid; over-budget runs wait for approval).")}`}
        </p>
        <Button variant="primary" size="sm" block loading={busy} icon={<Plus className="size-3.5" />} onClick={() => void add()}>{t("Add next shot")}</Button>
      </div>
    </Popover>
  );
}

const ShotNode = memo(function ShotNode({ data }: NodeProps<Node<ShotData>>) {
  const t = useT();
  const s = useStudio();
  const { submit } = useGenerate();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const leaveTimer = useRef<number | undefined>(undefined);
  const { shot, people, selected, lang, linkFrom } = data;
  const thumb = shot.video?.thumb_url || shot.keyframe?.thumb_url || "";
  const st = STATUS[shot.status] ?? STATUS.draft;
  const lock = useLockHolder(`shot:${shot.id}`, `board:${shot.episode_id}`);
  const editable = s.canEdit && !lock;
  const run = async (path: "keyframe" | "video", what: string) => {
    setBusy(path);
    try {
      await submit(() => api.post<SubmitResult>(`/api/shots/${shot.id}/${path}`, {}), `${what} ${shot.code}`);
      s.refresh();
    } finally { setBusy(null); }
  };
  // the hover toolbar floats above the node: a short grace period lets the pointer cross the gap
  const enter = () => { window.clearTimeout(leaveTimer.current); setHover(true); };
  const leave = () => { window.clearTimeout(leaveTimer.current); leaveTimer.current = window.setTimeout(() => setHover(false), 180); };
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  const openNext = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (open && anchor.current === e.currentTarget) { setOpen(false); return; }
    anchor.current = e.currentTarget;
    setOpen(true);
  };
  const close = useCallback(() => setOpen(false), []);
  const otherMode: LinkMode = linkFrom?.mode === "extend" ? "last_frame" : "extend";
  return (
    <>
      {editable && (
        <NodeToolbar isVisible={hover || selected || open} position={Position.Top} align="end" offset={6} onMouseEnter={enter} onMouseLeave={leave}
          className="flex items-center gap-0.5 rounded-lg border border-line bg-panel p-0.5 shadow-pop">
          <Tool title={t("Add the next shot")} onClick={openNext}><StepForward className="size-3.5" /></Tool>
          {linkFrom && (
            <>
              <Tool title={linkFrom.mode === "extend" ? t("Start from {code}'s last frame instead", { code: linkFrom.code }) : t("Extend {code}'s clip instead", { code: linkFrom.code })}
                onClick={() => void s.setLinkMode(shot.id, otherMode)}>
                {linkFrom.mode === "extend" ? <Link2 className="size-3.5" /> : <ArrowRightToLine className="size-3.5" />}
              </Tool>
              <Tool title={t("Unlink from {code}", { code: linkFrom.code })} onClick={() => void s.linkShot(shot.id, null)}><Unlink className="size-3.5" /></Tool>
            </>
          )}
        </NodeToolbar>
      )}
      <div onMouseEnter={enter} onMouseLeave={leave} style={{ width: SHOT_W }}
        className={clsx("hud relative rounded-xl border bg-panel shadow-card transition-shadow",
          selected ? "border-accent shadow-[0_0_0_1px_var(--color-accent),0_0_26px_-6px_var(--color-accent)]" : "border-line")}>
        <Handle type="target" position={Position.Left} id="in" className="!size-2.5 !border-2 !border-panel !bg-accent"
          title={t("Drop another shot's right-hand dot here: this shot then continues from it")} />
        <Handle type="target" position={Position.Top} id="cast" className="!size-3 !border-2 !border-panel !bg-ok" title={t("Connect a character")} />
        <div className="p-1.5 pb-0">
          <div className={clsx("scr h-[98px]", !thumb && "scr-empty", selected && "is-lit")}>
            {thumb ? <img src={thumb} alt="" className="size-full object-cover" draggable={false} /> : (
              <div className="grid size-full place-items-center text-white/40"><ImageIcon className="size-6" /></div>
            )}
            <span className="mono absolute left-2.5 top-2.5 z-[5] rounded bg-black/65 px-1 text-2xs font-semibold text-white">{shot.code}</span>
            <span className={clsx("mono absolute right-2.5 top-2.5 z-[5] rounded px-1 text-2xs font-medium uppercase tracking-wider backdrop-blur", st.cls)}>{t(st.label)}</span>
            {shot.generating && <span className="absolute inset-0 z-[6] grid place-items-center bg-black/55"><span className="eq" aria-hidden><i /><i /><i /><i /></span></span>}
            {lock && <LockMark name={lock.name} className="absolute bottom-2.5 left-2.5 z-[5]" />}
          </div>
        </div>
        <div className="space-y-1.5 p-2">
          <ShotBadges shot={shot} lang={lang} linkFrom={linkFrom} />
          <p className="line-clamp-2 min-h-[2rem] text-xs leading-4">{shot.action || <span className="text-dim">{t("No prompt yet")}</span>}</p>
          <div className="flex items-center gap-1">
            {people.length ? (
              <span className="flex -space-x-1.5">{people.slice(0, 4).map((c) => <Avatar key={c.id} name={c.name} src={c.avatar_url} size={20} className="ring-2 ring-panel" />)}</span>
            ) : <span className="text-2xs text-dim">{t("nobody")}</span>}
            <span className="mono ml-auto text-2xs tabular-nums text-dim">{Math.max(shot.extend_to || 0, shot.duration_s)}s</span>
          </div>
          {editable && (
            <div className="nodrag flex gap-1">
              <button type="button" disabled={!!busy || shot.generating} onClick={() => void run("keyframe", tr("Keyframe"))}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-line py-1 text-2xs font-medium transition-colors hover:border-dim/50 hover:bg-hover disabled:opacity-50">
                {busy === "keyframe" ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}{t("Keyframe")}
              </button>
              <button type="button" disabled={!!busy || shot.generating} onClick={() => void run("video", tr("Video"))}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-line py-1 text-2xs font-medium transition-colors hover:border-dim/50 hover:bg-hover disabled:opacity-50">
                {busy === "video" ? <Loader2 className="size-3 animate-spin" /> : <Video className="size-3" />}{t("Video")}
              </button>
              <Tooltip content={t("Add the next shot: same cast, place and outfits, continuing from this one")}>
                <button type="button" onClick={openNext} aria-label={t("Add the next shot")} aria-expanded={open}
                  className={clsx("inline-flex w-8 shrink-0 items-center justify-center rounded-md border border-line text-accent-ink transition-colors hover:bg-accent/10", open && "bg-accent/10")}>
                  <StepForward className="size-3.5" />
                </button>
              </Tooltip>
            </div>
          )}
        </div>
        <Handle type="source" position={Position.Right} id="out" className="!size-3 !border-2 !border-panel !bg-accent"
          title={t("Drag to another shot: it will continue from this one")} />
      </div>
      {editable && <NextShotPopover shot={shot} anchor={anchor} open={open} onClose={close} />}
    </>
  );
});

const CharacterNode = memo(function CharacterNode({ data }: NodeProps<Node<CharData>>) {
  const t = useT();
  const { c, lit } = data;
  return (
    <div className={clsx("flex items-center gap-2 rounded-xl border border-l-[3px] bg-panel px-2 py-1.5 shadow-card transition-shadow",
      lit ? "border-ok shadow-[0_0_18px_-6px_var(--color-ok)]" : "border-line border-l-ok/60")} style={{ width: SIDE_W }}>
      <Avatar name={c.name} src={c.avatar_url} size={34} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold">{c.name}</p>
        <p className={clsx("mono truncate text-2xs uppercase tracking-wider", c.avatar_url ? "text-dim" : "text-warn")}>{c.avatar_url ? (c.role || t("character")) : t("no photo yet")}</p>
      </div>
      <Handle type="source" position={Position.Right} id="cast" className="!size-3 !border-2 !border-panel !bg-ok" title={t("Drag to a shot to put them in it")} />
    </div>
  );
});

const LocationNode = memo(function LocationNode({ data }: NodeProps<Node<LocData>>) {
  const { l } = data;
  return (
    <div className="flex items-center gap-2 rounded-xl border border-l-[3px] border-line border-l-info/60 bg-panel px-2 py-1.5 shadow-card" style={{ width: SIDE_W }}>
      <span className="grid size-[34px] shrink-0 place-items-center overflow-hidden rounded-lg bg-raised">
        {l.thumb_url ? <img src={l.thumb_url} alt="" className="size-full object-cover" draggable={false} /> : <MapPin className="size-4 text-info" />}
      </span>
      <p className="min-w-0 flex-1 truncate text-xs font-semibold">{l.name}</p>
      <Handle type="source" position={Position.Right} id="loc" className="!size-3 !border-2 !border-panel !bg-info" />
    </div>
  );
});

const NODE_TYPES = { scene: SceneNode, shot: ShotNode, character: CharacterNode, location: LocationNode };

// ── edges ────────────────────────────────────────────────────────────────────
/** Continuity link: an animated accent-to-indigo edge with a mono label that shows the mode; click it to switch, or open the menu to switch / remove. */
function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps<Edge<LinkEdgeData, "link">>) {
  const t = useT();
  const s = useStudio();
  const gid = useId().replace(/:/g, "");
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  if (!data) return <BaseEdge id={id} path={path} />;
  const extend = data.mode === "extend";
  const other: LinkMode = extend ? "last_frame" : "extend";
  const vars = { source: data.sourceCode, target: data.targetCode };
  return (
    <>
      <defs>
        <linearGradient id={`lg-${gid}`} gradientUnits="userSpaceOnUse" x1={sourceX} y1={sourceY} x2={targetX} y2={targetY === sourceY ? targetY + 0.01 : targetY}>
          <stop offset="0" style={{ stopColor: "var(--color-accent)" }} />
          <stop offset="1" style={{ stopColor: "var(--color-accent-2)" }} />
        </linearGradient>
      </defs>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={16} style={{ stroke: `url(#lg-${gid})`, strokeWidth: selected ? 3 : 2 }} />
      <EdgeLabelRenderer>
        <div className="nodrag nopan absolute" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: "all" }}>
          <div className={clsx("flex items-center rounded-lg border bg-panel shadow-card transition-colors", selected ? "border-accent shadow-[0_0_14px_-4px_var(--color-accent)]" : "border-accent/40")}>
            <Tooltip content={s.canEdit
              ? (extend ? t("{target}'s video extends {source}'s clip — click to start from its last frame instead", vars)
                : t("{target} starts from {source}'s last frame — click to extend the clip instead", vars))
              : (extend ? t("{target}'s video extends {source}'s clip", vars) : t("{target} starts from {source}'s last frame", vars))}>
              <button type="button" disabled={!s.canEdit} onClick={() => void s.setLinkMode(data.targetShotId, other)}
                className="mono inline-flex items-center gap-1 rounded-lg py-0.5 pl-1.5 pr-1.5 text-2xs font-medium uppercase tracking-wider text-accent-ink transition-colors hover:bg-accent/10 disabled:cursor-default disabled:hover:bg-transparent">
                {extend ? <ArrowRightToLine className="size-3" /> : <Link2 className="size-3" />}
                {extend ? <>{t("extend")}<span aria-hidden>▸</span></> : t("last frame")}
              </button>
            </Tooltip>
            {s.canEdit && (
              <Menu placement="bottom-start" width={232} trigger={(p) => (
                <button type="button" {...p} aria-label={t("Link options")} className="grid size-5 place-items-center rounded-lg text-dim transition-colors hover:bg-hover hover:text-ink">
                  <ChevronDown className="size-3" />
                </button>
              )} items={[
                { label: t("Start from {code}'s last frame", { code: data.sourceCode }), icon: <Link2 className="size-3.5" />, active: !extend,
                  onClick: () => { if (extend) void s.setLinkMode(data.targetShotId, "last_frame"); } },
                { label: t("Extend {code}'s clip", { code: data.sourceCode }), icon: <ArrowRightToLine className="size-3.5" />, active: extend,
                  onClick: () => { if (!extend) void s.setLinkMode(data.targetShotId, "extend"); } },
                { label: t("Remove link"), icon: <Unlink className="size-3.5" />, danger: true, separator: true, onClick: () => void s.linkShot(data.targetShotId, null) },
              ]} />
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const EDGE_TYPES = { link: LinkEdge };

// ── the map ──────────────────────────────────────────────────────────────────
const posKey = (pid: number) => `veo:filmmap-pos:${pid}`;
const readPos = (pid: number): Record<string, { x: number; y: number }> => {
  try { return JSON.parse(localStorage.getItem(posKey(pid)) || "{}"); } catch { return {}; }
};

function FilmGraph() {
  const t = useT();
  const s = useStudio();
  const { project, lang } = useProjectCtx();
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
    const shotsById = new Map((ep.shots ?? []).map((x) => [x.id, x]));
    const order = outlineOrder(ep);
    const shown = new Set(order);
    // explicit continuity links (source → the shot that continues it)
    const links: { src: Shot; tgt: Shot; mode: LinkMode }[] = [];
    for (const shot of ep.shots ?? []) {
      if (!shown.has(shot.id)) continue;
      const from = linkFromOf(shot, shotsById);
      if (from && shown.has(from.id)) links.push({ src: shotsById.get(from.id)!, tgt: shot, mode: from.mode });
    }
    const linked = new Set(links.map((l) => `${l.src.id}>${l.tgt.id}`));
    groups.forEach((g, lane) => {
      const y = lane * LANE_H;
      const sid = `scene-${g.scene?.id ?? "none"}`;
      ns.push({
        id: sid, type: "scene", position: { x: SCENE_X, y: y + 30 }, draggable: false, deletable: false,
        data: { scene: g.scene, index: g.scene ? scenes.indexOf(g.scene) + 1 : 0, count: g.shots.length,
          secs: g.shots.reduce((a, x) => a + Math.max(x.extend_to || 0, x.duration_s), 0),
          location: g.scene?.location_id ? locById.get(g.scene.location_id) : undefined } satisfies SceneData,
      });
      if (g.scene?.location_id && locById.has(g.scene.location_id)) {
        es.push({ id: `loc-${g.scene.location_id}-${sid}`, source: `loc-${g.scene.location_id}`, sourceHandle: "loc", target: sid, targetHandle: "loc",
          style: { stroke: "var(--color-info)", strokeWidth: 1.5 }, data: { kind: "location", sceneId: g.scene.id } });
      }
      let prev = sid;
      let prevShot: Shot | null = null;
      g.shots.forEach((shot, i) => {
        const id = `shot-${shot.id}`;
        const linkFrom = linkFromOf(shot, shotsById);
        ns.push({
          id, type: "shot", position: { x: SHOT_X + i * (SHOT_W + SHOT_GAP), y }, deletable: false,
          data: { shot, selected: s.selected === shot.id, lang, linkFrom: linkFrom && shown.has(linkFrom.id) ? linkFrom : null,
            people: (shot.characters ?? []).map((c) => castById.get(c)).filter((c): c is Character => !!c) } satisfies ShotData,
        });
        // "continue from the previous shot" without an explicit link: a dotted edge from the shot before it in the film
        const before = order[order.indexOf(shot.id) - 1];
        const dotted = shot.continuity_from_prev && !linkFrom && before != null;
        if (dotted) {
          es.push({ id: `prev-${shot.id}`, source: `shot-${before}`, sourceHandle: "out", target: id, targetHandle: "in", deletable: false, selectable: false,
            className: "filmmap-prev", label: t("continues"), labelStyle: { fontSize: 11, fill: "var(--color-dim)", fontFamily: "var(--font-mono)", letterSpacing: "0.06em" }, labelBgStyle: { fill: "var(--color-panel)" },
            labelBgPadding: [5, 3], labelBgBorderRadius: 6, style: { stroke: "var(--color-accent-2)", strokeWidth: 1.5, opacity: 0.8 }, data: { kind: "prev" } });
        }
        // the plain sequence edge stays unless a link (or the dotted edge) already draws that pair
        const covered = prevShot != null && (linked.has(`${prevShot.id}>${shot.id}`) || (dotted && before === prevShot.id));
        if (!covered) {
          es.push({ id: `seq-${prev}-${id}`, source: prev, sourceHandle: "out", target: id, targetHandle: "in", deletable: false, selectable: false,
            style: { stroke: "var(--color-accent)", strokeWidth: 2, opacity: 0.55 }, data: { kind: "sequence" } });
        }
        prev = id;
        prevShot = shot;
        for (const cid of shot.characters ?? []) {
          if (!castById.has(cid)) continue;
          const show = allLinks || s.selected === shot.id || hoverChar === cid;
          es.push({ id: `cast-${cid}-${shot.id}`, source: `char-${cid}`, sourceHandle: "cast", target: id, targetHandle: "cast",
            hidden: !show, animated: hoverChar === cid, style: { stroke: "var(--color-ok)", strokeWidth: 1.5 },
            data: { kind: "cast", characterId: cid, shotId: shot.id } });
        }
      });
    });
    for (const { src, tgt, mode } of links) {
      es.push({ id: `link-${src.id}-${tgt.id}`, type: "link", source: `shot-${src.id}`, sourceHandle: "out", target: `shot-${tgt.id}`, targetHandle: "in",
        animated: true, className: "filmmap-link", zIndex: 2, selectable: true, deletable: s.canEdit,
        data: { kind: "link", sourceShotId: src.id, targetShotId: tgt.id, sourceCode: src.code, targetCode: tgt.code, mode } satisfies LinkEdgeData });
    }
    s.cast.forEach((c, i) => {
      const id = `char-${c.id}`;
      ns.push({ id, type: "character", position: saved[id] ?? { x: 0, y: i * 62 }, deletable: false,
        data: { c, lit: hoverChar === c.id || !!selShot?.characters.includes(c.id) } satisfies CharData });
    });
    const top = s.cast.length * 62 + 40;
    (locations ?? []).forEach((l, i) => {
      const id = `loc-${l.id}`;
      ns.push({ id, type: "location", position: saved[id] ?? { x: 0, y: top + i * 62 }, deletable: false, data: { l } satisfies LocData });
    });
    setNodes(ns);
    setEdges(es);
  }, [ep, groups, s.cast, castById, locations, locById, s.selected, s.canEdit, allLinks, hoverChar, selShot, project.id, lang, t, setNodes, setEdges]);

  const isValidConnection = useCallback((c: Connection | Edge) =>
    (c.source.startsWith("char-") && c.target.startsWith("shot-") && c.targetHandle === "cast")
    || (c.source.startsWith("loc-") && c.target.startsWith("scene-") && c.target !== "scene-none")
    || (c.source.startsWith("shot-") && c.target.startsWith("shot-") && c.source !== c.target && c.sourceHandle === "out" && c.targetHandle === "in"), []);

  const onConnect = useCallback(async (c: Connection) => {
    if (!s.canEdit) return;
    if (c.source.startsWith("char-") && c.target.startsWith("shot-")) {
      await s.setCast(Number(c.target.slice(5)), Number(c.source.slice(5)), true);
    } else if (c.source.startsWith("shot-") && c.target.startsWith("shot-")) {
      // the target shot continues from the source: its keyframe starts from the source's last frame
      await s.linkShot(Number(c.target.slice(5)), Number(c.source.slice(5)), "last_frame");
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
      const d = e.data as { kind?: string; characterId?: number; shotId?: number; sceneId?: number; targetShotId?: number } | undefined;
      if (d?.kind === "cast" && d.shotId && d.characterId) await s.setCast(d.shotId, d.characterId, false);
      if (d?.kind === "link" && d.targetShotId) await s.linkShot(d.targetShotId, null);
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
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      onConnect={(c) => void onConnect(c)} onEdgesDelete={(e) => void onEdgesDelete(e)} isValidConnection={isValidConnection}
      onNodeDragStop={onNodeDragStop} nodesConnectable={s.canEdit} edgesReconnectable={false}
      onNodeClick={(_, n) => { if (n.id.startsWith("shot-")) s.select(Number(n.id.slice(5))); }}
      onNodeMouseEnter={(_, n) => { if (n.id.startsWith("char-")) setHoverChar(Number(n.id.slice(5))); }}
      onNodeMouseLeave={(_, n) => { if (n.id.startsWith("char-")) setHoverChar(null); }}
      colorMode={dark ? "dark" : "light"} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }} minZoom={0.15} maxZoom={1.6}
      deleteKeyCode={s.canEdit ? ["Delete", "Backspace"] : null} proOptions={{ hideAttribution: true }}
      style={{ background: "var(--color-bg)" }}>
      <Background gap={22} size={1.3} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeStrokeWidth={2} className="!hidden @3xl:!block"
        nodeColor={(n) => (n.type === "scene" ? "var(--color-accent)" : n.type === "character" ? "var(--color-ok)" : n.type === "location" ? "var(--color-info)" : "var(--color-hover)")} />
      <Panel position="top-left">
        <div className="hud relative flex items-center gap-2 rounded-xl border border-line bg-panel/90 px-2.5 py-1.5 text-2xs text-mute shadow-card backdrop-blur">
          <Clapperboard className="size-3.5 shrink-0 text-accent-ink" />
          <span className="eyebrow !text-ink">{t("Film map")}</span>
          <span className="hidden @md:inline">{t("Each row is a scene, its shots in order")}</span>
          {s.canEdit && (
            <Tooltip content={t("Drag a character's green dot to a shot to put them in it · a location's blue dot to a scene · a shot's right-hand dot to another shot so it continues from that one (click the link's label to switch between last frame and extend) · drag a shot to another row to move it · select a link and press Delete to remove it")}>
              <span className="mono grid size-5 cursor-help place-items-center rounded-md border border-line font-semibold">?</span>
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
    return <div className="scr-empty grid h-full place-items-center p-6 text-sm text-mute"><p className="max-w-xs text-center">{t("No shots yet — write them in the Shot list, then they appear here.")}</p></div>;
  }
  return <div className="filmmap @container h-full"><ReactFlowProvider><FilmGraph /></ReactFlowProvider></div>;
}
