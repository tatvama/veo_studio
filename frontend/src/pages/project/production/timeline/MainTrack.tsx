import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { clsx } from "clsx";
import { Blend, Plus } from "lucide-react";
import { useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { Tooltip } from "../../../../components/ui";
import { useT } from "../../../../lib/i18n";
import type { Clip } from "./shared";

const KIND_TAG: Record<string, string> = { lipsync: "Lip-sync", voicelock: "Voice lock", still: "Still" };

/** Drag helper: calls onMove with the horizontal distance in px, then onEnd. */
function dragX(e: RPointerEvent, onMove: (dx: number) => void, onEnd: (dx: number) => void) {
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX;
  let dx = 0;
  const move = (ev: PointerEvent) => { dx = ev.clientX - x0; onMove(dx); };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.style.cursor = "";
    onEnd(dx);
  };
  document.body.style.cursor = "ew-resize";
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/**
 * A shot on the main track at its real place in the cut: it starts over the previous shot by its transition. Its edges
 * trim it (the rest of the cut slides up to close the gap); its body drags to reorder.
 */
export function MainClip({ clip, pps, selected, canEdit, onClick, onDoubleClick, onTrim, onTrimEnd }: {
  clip: Clip; pps: number; selected: boolean; canEdit: boolean; onClick: () => void; onDoubleClick: () => void;
  onTrim: (trimIn: number, trimOut: number) => void; onTrimEnd: (trimIn: number, trimOut: number) => void;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: clip.shot.id, disabled: !canEdit });
  const [live, setLive] = useState<string | null>(null);
  const thumb = clip.shot.lipsync?.thumb_url || clip.shot.video?.thumb_url || clip.still;
  const w = clip.duration * pps;
  const code = clip.shot.code.split("-").pop();
  const kindTag = KIND_TAG[clip.kind];
  const trimmable = canEdit && clip.kind !== "still";
  const fxOn = Object.keys(clip.shot.fx ?? {}).some((k) => k !== "transition");
  const style: CSSProperties = {
    position: "absolute", left: clip.start * pps, top: 4, bottom: 4, width: w, transform: CSS.Translate.toString(transform), transition,
    backgroundImage: thumb ? `url(${thumb})` : undefined, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x", backgroundPosition: "left center",
  };

  const handle = (side: "in" | "out") => (e: RPointerEvent) => {
    const ti0 = clip.trimIn, to0 = clip.trimOut;
    const room = (dx: number) => {
      const src = (dx / pps) * clip.speed;  // seconds of source under the drag
      if (side === "in") {
        const ti = Math.max(0, Math.min(ti0 + src, clip.raw - to0 - 0.5));
        return [Math.round(ti * 100) / 100, to0] as const;
      }
      const to = Math.max(0, Math.min(to0 - src, clip.raw - ti0 - 0.5));
      return [ti0, Math.round(to * 100) / 100] as const;
    };
    dragX(e, (dx) => {
      const [ti, to] = room(dx);
      onTrim(ti, to);
      setLive(t("in {a}s · out {b}s · {d}s", { a: ti.toFixed(2), b: to.toFixed(2), d: ((clip.raw - ti - to) / clip.speed).toFixed(2) }));
    }, (dx) => {
      setLive(null);
      const [ti, to] = room(dx);
      if (ti !== ti0 || to !== to0) onTrimEnd(ti, to);
    });
  };

  return (
    <Tooltip content={`${clip.shot.code} · ${t(kindTag ?? "Video")} · ${clip.duration.toFixed(1)}s${clip.trimIn || clip.trimOut ? ` · ${t("trimmed")}` : ""}${clip.speed !== 1 ? ` · ${clip.speed}×` : ""}`} side="top" delay={500} disabled={!!live}>
      <div ref={setNodeRef} {...attributes} {...listeners} role="button" aria-label={`${clip.shot.code}, ${clip.duration.toFixed(1)}s`} aria-pressed={selected}
        onClick={onClick} onDoubleClick={onDoubleClick} style={style}
        className={clsx("group cursor-pointer overflow-hidden rounded-md border bg-raised outline-none transition-[box-shadow,border-color,opacity] duration-150",
          "focus-visible:ring-2 focus-visible:ring-accent/70",
          selected ? "z-[3] border-accent ring-2 ring-accent/50" : "z-[1] border-black/50 hover:z-[2] hover:border-dim",
          clip.kind === "still" && "opacity-70", isDragging && "z-20 opacity-90 shadow-lift")}>
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/55 via-transparent to-black/45" />
        <span className="absolute left-2 top-0.5 rounded bg-black/65 px-1 font-mono text-2xs font-semibold leading-4 text-white">{code}</span>
        {fxOn && w > 50 && <span className="absolute right-2 top-0.5 rounded bg-accent/85 px-1 text-2xs font-bold leading-4 text-black">fx</span>}
        {w > 70 && <span className="absolute bottom-0.5 right-2 font-mono text-2xs font-medium tabular-nums leading-4 text-white/90">{clip.duration.toFixed(1)}s</span>}
        {kindTag && w > 90 && <span className="absolute bottom-0.5 left-2 rounded bg-black/65 px-1 text-2xs font-medium leading-4 text-white/90">{t(kindTag)}</span>}
        {live && <span className="absolute left-1/2 top-1/2 z-[5] -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 font-mono text-2xs text-white">{live}</span>}
        {trimmable && (
          <>
            <span onPointerDown={handle("in")} title={t("Drag to trim the start")} aria-hidden
              className={clsx("absolute inset-y-0 left-0 z-[4] w-2 cursor-ew-resize border-l-2 transition-colors",
                clip.trimIn ? "border-warn bg-warn/30" : "border-transparent group-hover:border-white/80 group-hover:bg-white/15")} />
            <span onPointerDown={handle("out")} title={t("Drag to trim the end")} aria-hidden
              className={clsx("absolute inset-y-0 right-0 z-[4] w-2 cursor-ew-resize border-r-2 transition-colors",
                clip.trimOut ? "border-warn bg-warn/30" : "border-transparent group-hover:border-white/80 group-hover:bg-white/15")} />
          </>
        )}
      </div>
    </Tooltip>
  );
}

/** The overlap of two shots: drag its right edge to make the transition longer or shorter. */
export function TransitionBlock({ clip, pps, canEdit, onResize, onResizeEnd, onClick }: {
  clip: Clip; pps: number; canEdit: boolean; onResize: (d: number) => void; onResizeEnd: (d: number) => void; onClick: () => void;
}) {
  const t = useT();
  const tr = clip.shot.fx?.transition;
  const start = useRef(0);
  if (!tr || clip.overlap <= 0) return null;
  const w = Math.max(clip.overlap * pps, 6);
  const set = (dx: number) => Math.max(0.1, Math.min(2.5, Math.round((start.current + dx / pps) * 20) / 20));
  return (
    <Tooltip content={`${tr.type} · ${clip.overlap.toFixed(2)}s — ${t("the two shots overlap here")}`} side="top" delay={300}>
      <div role="button" tabIndex={0} onClick={onClick} aria-label={t("Transition {name}", { name: tr.type })}
        style={{ position: "absolute", left: clip.start * pps, width: w, top: 2, bottom: 2,
          background: "repeating-linear-gradient(135deg, rgb(249 115 22 / 0.55) 0 6px, rgb(249 115 22 / 0.28) 6px 12px)" }}
        className="z-[5] flex items-center justify-center overflow-hidden rounded-md border-2 border-accent text-black shadow-lift">
        {w > 22 && <Blend className="size-3.5 shrink-0" />}
        {w > 70 && <span className="ml-1 truncate text-2xs font-bold">{tr.type}</span>}
        {canEdit && (
          <span aria-hidden title={t("Drag to change the transition length")}
            onPointerDown={(e) => { start.current = tr.duration; dragX(e, (dx) => onResize(set(dx)), (dx) => onResizeEnd(set(dx))); }}
            className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-accent/60 hover:bg-accent" />
        )}
      </div>
    </Tooltip>
  );
}

/** At a plain cut: a small "+" that adds a crossfade. */
export function CutButton({ clip, pps, onAdd }: { clip: Clip; pps: number; onAdd: () => void }) {
  const t = useT();
  return (
    <Tooltip content={t("Add a transition here")} side="top">
      <button type="button" onClick={onAdd} aria-label={t("Add a transition here")}
        style={{ position: "absolute", left: clip.start * pps - 9, top: "50%" }}
        className="z-[6] grid size-[18px] -translate-y-1/2 place-items-center rounded-full border border-white/70 bg-panel text-mute opacity-0 shadow transition-opacity hover:bg-accent hover:text-black group-hover/track:opacity-100 focus:opacity-100">
        <Plus className="size-3" strokeWidth={3} />
      </button>
    </Tooltip>
  );
}
