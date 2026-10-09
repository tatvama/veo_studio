import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { clsx } from "clsx";
import { Blend, Ellipsis, Plus, Snowflake, X } from "lucide-react";
import { useRef, useState, type CSSProperties, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { Tooltip } from "../../../../components/ui";
import { useT } from "../../../../lib/i18n";
import type { MenuAnchor } from "./ContextMenu";
import { FPS, MAX_HOLD, clipEnd, round2, type Clip, type TrimDraft, type TrimMode } from "./shared";

const KIND_TAG: Record<string, string> = { lipsync: "Lip-sync", voicelock: "Voice lock", still: "Still" };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** The keys that open a context menu from the keyboard (same as native: Shift+F10 and the Menu key). */
export const isMenuKey = (e: RKeyboardEvent | KeyboardEvent) => e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);

/** Drag helper: calls onMove with the horizontal distance in px, then onEnd. */
function dragX(e: RPointerEvent, onMove: (dx: number) => void, onEnd: (dx: number) => void, cursor = "ew-resize") {
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
  document.body.style.cursor = cursor;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** Holds changed by a trim: the clip's own freeze (trimming its end) or the previous clip's (trimming its start). */
export interface HoldPatch { self?: number; prev?: number }

/**
 * A shot on the main track at its real place in the cut: it starts over the previous shot by its transition. Its edges
 * trim it (in "ripple" mode the rest of the cut slides up to close the gap; in "hold" mode the trimmed time becomes a
 * freeze of the last frame so nothing else moves); its body drags to reorder. Right-click, the "…" button or
 * Shift+F10 open its actions.
 */
export function MainClip({ clip, pps, selected, canEdit, trimMode, hasPrev, holdBefore, menuOpen, onClick, onDoubleClick, onTrim, onTrimEnd, onMenu }: {
  clip: Clip; pps: number; selected: boolean; canEdit: boolean; trimMode: TrimMode; hasPrev: boolean; holdBefore: number; menuOpen: boolean;
  onClick: () => void; onDoubleClick: () => void;
  onTrim: (trimIn: number, trimOut: number, holds?: HoldPatch) => void; onTrimEnd: (trimIn: number, trimOut: number, holds?: HoldPatch) => void;
  onMenu: (anchor: MenuAnchor, returnFocus: HTMLElement) => void;
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
  const { onKeyDown: dndKey, ...dndListeners } = (listeners ?? {}) as Record<string, (e: any) => void>;

  const handle = (side: "in" | "out") => (e: RPointerEvent) => {
    const ti0 = clip.trimIn, to0 = clip.trimOut, h0 = clip.hold, hp0 = holdBefore;
    const room = (dx: number) => {
      const src = (dx / pps) * clip.speed;  // seconds of source under the drag
      if (side === "in") {
        const ti = Math.max(0, Math.min(ti0 + src, clip.raw - to0 - 0.5));
        return [round2(ti), to0] as const;
      }
      const to = Math.max(0, Math.min(to0 - src, clip.raw - ti0 - 0.5));
      return [ti0, round2(to)] as const;
    };
    // "hold": the time taken off the clip becomes a freeze, so the clips after it stay put
    const holdsFor = (ti: number, to: number): HoldPatch | undefined => {
      if (trimMode !== "hold") return undefined;
      const dDur = ((clip.raw - ti - to) - (clip.raw - ti0 - to0)) / clip.speed;  // timeline seconds gained (+) or lost (−)
      if (side === "out") return { self: round2(clamp(h0 - dDur, 0, MAX_HOLD)) };
      return hasPrev ? { prev: round2(clamp(hp0 - dDur, 0, MAX_HOLD)) } : undefined;
    };
    dragX(e, (dx) => {
      const [ti, to] = room(dx);
      const hp = holdsFor(ti, to);
      onTrim(ti, to, hp);
      const hold = hp?.self ?? hp?.prev;
      setLive(t("in {a}s · out {b}s · {d}s", { a: ti.toFixed(2), b: to.toFixed(2), d: ((clip.raw - ti - to) / clip.speed).toFixed(2) })
        + (hold !== undefined ? ` · ${t("freeze {n}s", { n: hold.toFixed(2) })}` : ""));
    }, (dx) => {
      setLive(null);
      const [ti, to] = room(dx);
      if (ti !== ti0 || to !== to0) onTrimEnd(ti, to, holdsFor(ti, to));
    });
  };

  const tip = `${clip.shot.code} · ${t(kindTag ?? "Video")} · ${clip.duration.toFixed(1)}s${clip.trimIn || clip.trimOut ? ` · ${t("trimmed")}` : ""}${clip.speed !== 1 ? ` · ${clip.speed}×` : ""}${clip.shot.fx?.reverse ? ` · ${t("reversed")}` : ""}`;
  return (
    <Tooltip content={tip} side="top" delay={500} disabled={!!live || menuOpen}>
      <div ref={setNodeRef} {...attributes} {...dndListeners} role="button" aria-label={`${clip.shot.code}, ${clip.duration.toFixed(1)}s`} aria-pressed={selected}
        aria-haspopup="menu" aria-expanded={menuOpen}
        onClick={onClick} onDoubleClick={onDoubleClick} style={style}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); onMenu({ x: e.clientX, y: e.clientY }, e.currentTarget); }}
        onKeyDown={(e) => {
          if (isMenuKey(e)) { e.preventDefault(); e.stopPropagation(); onClick(); onMenu(e.currentTarget, e.currentTarget); return; }
          dndKey?.(e);
        }}
        className={clsx("tl-clip group cursor-pointer overflow-hidden rounded-md border bg-raised outline-none transition-[box-shadow,border-color,opacity] duration-150",
          "focus-visible:ring-2 focus-visible:ring-accent/70",
          selected || menuOpen ? "is-sel z-[3] border-accent" : "z-[1] border-white/10 hover:z-[2] hover:border-dim",
          clip.kind === "still" && "opacity-70", isDragging && "z-20 opacity-90 shadow-lift")}>
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/50" />
        <span className="mono absolute left-2 top-0.5 rounded-[3px] bg-black/70 px-1 text-2xs font-semibold leading-4 tracking-wide text-white">{code}</span>
        {fxOn && w > 76 && <span className={clsx("mono absolute top-0.5 rounded-[3px] bg-accent px-1 text-2xs font-bold leading-4 text-[var(--on-accent)]", w > 40 ? "right-7" : "right-2")}>fx</span>}
        {w > 70 && <span className="mono absolute bottom-0.5 right-2 text-2xs font-medium tabular-nums leading-4 text-white/90">{clip.duration.toFixed(1)}s</span>}
        {kindTag && w > 90 && <span className="mono absolute bottom-0.5 left-2 rounded-[3px] bg-black/70 px-1 text-2xs font-medium leading-4 text-white/90">{t(kindTag)}</span>}
        {live && <span className="mono absolute left-1/2 top-1/2 z-[5] -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded border border-accent/40 bg-black/85 px-1.5 py-0.5 text-2xs text-white">{live}</span>}
        {w > 40 && (
          <Tooltip content={t("Clip actions")} side="top">
            <button type="button" aria-label={t("Clip actions")} aria-haspopup="menu" aria-expanded={menuOpen} tabIndex={-1}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onClick(); onMenu(e.currentTarget, e.currentTarget.parentElement as HTMLElement); }}
              className={clsx("absolute right-1 top-0.5 z-[5] grid size-5 place-items-center rounded bg-black/65 text-white transition-opacity",
                "before:absolute before:-inset-1.5 before:content-[''] hover:bg-accent hover:text-[var(--on-accent)] focus-visible:opacity-100 group-hover:opacity-100",
                menuOpen || selected ? "opacity-100" : "opacity-0")}>
              <Ellipsis className="size-3.5" />
            </button>
          </Tooltip>
        )}
        {trimmable && (
          <>
            <span onPointerDown={handle("in")} title={trimMode === "hold" ? t("Drag to trim the start (the clip before freezes)") : t("Drag to trim the start")} aria-hidden
              className={clsx("absolute inset-y-0 left-0 z-[4] w-2 cursor-ew-resize border-l-2 transition-colors",
                clip.trimIn ? "border-warn bg-warn/30" : "border-transparent group-hover:border-white/80 group-hover:bg-white/15")} />
            <span onPointerDown={handle("out")} title={trimMode === "hold" ? t("Drag to trim the end (the last frame freezes)") : t("Drag to trim the end")} aria-hidden
              className={clsx("absolute inset-y-0 right-0 z-[4] w-2 cursor-ew-resize border-r-2 transition-colors",
                clip.trimOut ? "border-warn bg-warn/30" : "border-transparent group-hover:border-white/80 group-hover:bg-white/15")} />
          </>
        )}
      </div>
    </Tooltip>
  );
}

/** Both trims a roll edit changes: the end of the left clip and the start of the right one, by the same timeline time. */
export function rollTrims(left: Clip, right: Clip, dSec: number): { l: TrimDraft; r: TrimDraft; d: number } {
  // + = the join moves right (left clip longer, right clip shorter); each side can only give back what it trimmed
  const toL = clamp(left.trimOut - dSec * left.speed, 0, left.raw - left.trimIn - 0.5);
  let d = (left.trimOut - toL) / left.speed;
  const tiR = clamp(right.trimIn + d * right.speed, 0, right.raw - right.trimOut - 0.5);
  d = (tiR - right.trimIn) / right.speed;
  return { l: { id: left.shot.id, trim_in: left.trimIn, trim_out: round2(left.trimOut - d * left.speed) },
    r: { id: right.shot.id, trim_in: round2(tiR), trim_out: right.trimOut }, d };
}

/** The join between two clips: drag it to roll the cut (the left clip gets longer as the right one gets shorter, or
 *  the other way round — the rest of the cut stays where it is). Arrow keys roll by one frame. */
export function RollHandle({ left, right, pps, onRoll, onRollEnd }: {
  left: Clip; right: Clip; pps: number; onRoll: (l: TrimDraft, r: TrimDraft) => void; onRollEnd: (l: TrimDraft, r: TrimDraft) => void;
}) {
  const t = useT();
  const [live, setLive] = useState<string | null>(null);
  const x = right.start * pps;
  const label = (d: number) => t("roll {d}s", { d: `${d > 0 ? "+" : ""}${d.toFixed(2)}` });
  const tip = `${left.shot.code} | ${right.shot.code} — ${t("drag to roll the cut: one side gets longer, the other shorter")}`;
  return (
    <Tooltip content={tip} side="top" delay={400} disabled={!!live}>
      <div role="slider" tabIndex={0} aria-label={t("Roll the cut between {a} and {b}", { a: left.shot.code, b: right.shot.code })}
        aria-valuenow={Math.round(left.trimOut * FPS)} aria-valuetext={`${left.shot.code} out ${left.trimOut.toFixed(2)}s · ${right.shot.code} in ${right.trimIn.toFixed(2)}s`}
        style={{ position: "absolute", left: x - 5, width: 10, top: 2, bottom: 2 }}
        className="group/roll z-[7] cursor-col-resize rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          dragX(e, (dx) => { const r = rollTrims(left, right, dx / pps); onRoll(r.l, r.r); setLive(label(r.d)); },
            (dx) => { setLive(null); const r = rollTrims(left, right, dx / pps); if (Math.abs(r.d) > 1e-4) onRollEnd(r.l, r.r); }, "col-resize");
        }}
        onKeyDown={(e) => {
          const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
          if (!dir) return;
          e.preventDefault();
          e.stopPropagation();
          const r = rollTrims(left, right, (dir * (e.shiftKey ? FPS : 1)) / FPS);
          if (Math.abs(r.d) > 1e-4) onRollEnd(r.l, r.r);
        }}>
        <span aria-hidden className={clsx("absolute inset-y-1 left-1/2 w-1 -translate-x-1/2 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)] transition-opacity",
          live ? "opacity-100" : "opacity-0 group-hover/track:opacity-70 group-hover/roll:!opacity-100 group-focus-visible/roll:opacity-100")} />
        {live && <span className="mono absolute left-1/2 top-1/2 z-[8] -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded border border-accent/40 bg-black/85 px-1.5 py-0.5 text-2xs text-white">{live}</span>}
      </div>
    </Tooltip>
  );
}

/** The freeze after a clip ("hold" trim mode): the last frame stays on screen. Preview only until the exporter keeps it. */
export function HoldBlock({ clip, pps, canEdit, selected, onClick, onClear }: {
  clip: Clip; pps: number; canEdit: boolean; selected: boolean; onClick: () => void; onClear: () => void;
}) {
  const t = useT();
  const w = Math.max(clip.hold * pps, 6);
  return (
    <Tooltip content={t("Last frame of {code} held for {n}s — preview only: the export closes this gap for now.", { code: clip.shot.code, n: clip.hold.toFixed(2) })} side="top" delay={300}>
      <div role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
        aria-label={t("Freeze after {code}, {n}s (preview only)", { code: clip.shot.code, n: clip.hold.toFixed(2) })}
        style={{ position: "absolute", left: clipEnd(clip) * pps, width: w, top: 4, bottom: 4,
          backgroundImage: "repeating-linear-gradient(135deg, color-mix(in srgb, var(--color-warn) 38%, transparent) 0 5px, color-mix(in srgb, var(--color-warn) 12%, transparent) 5px 10px)" }}
        className={clsx("group/hold z-[2] flex items-center gap-1 overflow-hidden rounded-md border border-dashed border-warn/70 px-1 text-warn outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
          selected && "ring-2 ring-accent/50")}>
        {w > 22 && <Snowflake className="size-3 shrink-0" />}
        {w > 72 && <span className="mono truncate text-2xs font-semibold">{t("Freeze {n}s", { n: clip.hold.toFixed(1) })}</span>}
        {canEdit && w > 40 && (
          <button type="button" aria-label={t("Remove the freeze")} title={t("Remove the freeze")}
            onClick={(e) => { e.stopPropagation(); onClear(); }} onPointerDown={(e) => e.stopPropagation()}
            className="ml-auto grid size-4 shrink-0 place-items-center rounded bg-black/40 text-white opacity-0 before:absolute before:-inset-1 before:content-[''] hover:bg-bad focus-visible:opacity-100 group-hover/hold:opacity-100">
            <X className="size-3" />
          </button>
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
          background: "repeating-linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 55%, transparent) 0 6px, color-mix(in srgb, var(--color-accent) 28%, transparent) 6px 12px)" }}
        className="z-[5] flex items-center justify-center overflow-hidden rounded-md border-2 border-accent text-[var(--on-accent)] shadow-[0_0_14px_-3px_var(--color-accent)]">
        {w > 22 && <Blend className="size-3.5 shrink-0" />}
        {w > 70 && <span className="mono ml-1 truncate text-2xs font-bold uppercase tracking-wider">{tr.type}</span>}
        {canEdit && (
          <span aria-hidden title={t("Drag to change the transition length")}
            onPointerDown={(e) => { start.current = tr.duration; dragX(e, (dx) => onResize(set(dx)), (dx) => onResizeEnd(set(dx))); }}
            className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-accent/60 hover:bg-accent" />
        )}
      </div>
    </Tooltip>
  );
}

/** At a plain cut: a small "+" that adds a crossfade (sits at the top of the join; the roll handle is below it). */
export function CutButton({ clip, pps, onAdd }: { clip: Clip; pps: number; onAdd: () => void }) {
  const t = useT();
  return (
    <Tooltip content={t("Add a transition here")} side="top">
      <button type="button" onClick={onAdd} aria-label={t("Add a transition here")}
        style={{ position: "absolute", left: clip.start * pps - 9, top: 3 }}
        className="z-[8] grid size-[18px] place-items-center rounded-md border border-dim/60 bg-panel text-mute opacity-0 shadow transition-opacity hover:border-accent hover:bg-accent hover:text-[var(--on-accent)] group-hover/track:opacity-100 focus:opacity-100">
        <Plus className="size-3" strokeWidth={3} />
      </button>
    </Tooltip>
  );
}
