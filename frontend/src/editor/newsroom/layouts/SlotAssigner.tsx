/**
 * Which picture goes in which box of a screen layout (docs/EDITOR.md §16.6), for the selected layout graphic: its boxes
 * as a small diagram (drop a clip from the bin on a box), and per box the clip in it — one already under the layout
 * or a media item from the bin — with its framing (fill or whole picture, zoom, aim) and "Take out". Every change is
 * one undo step; dragging a number is one step too. The Fill in panel embeds it.
 */
import { clsx } from "clsx";
import { Crosshair, LayoutGrid, X } from "lucide-react";
import { useMemo, useState } from "react";
import { clipEnd } from "../../model/ops";
import type { TimelineClip } from "../../model/types";
import { currentDrag, isEditorDrag } from "../../dnd";
import { useProject, useSequence } from "../../store";
import { ScrubNumber } from "../../ui";
import type { GfxRatio } from "../types";
import { boxName, frameInBox, mediaInBox, putInBox, takeOutOfBox } from "./actions";
import { boxesOfClip, clipInBox, clipsUnder, layoutOf } from "./commands";

const seqRatio = (w: number, h: number): GfxRatio => { const a = w / h; return a > 1.3 ? "16:9" : a < 0.7 ? "9:16" : a < 0.9 ? "4:5" : "1:1"; };
const ASPECT: Record<GfxRatio, number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5 };

export function SlotAssigner({ clipId }: { clipId: string }) {
  const p = useProject();
  const s = useSequence();
  const lo = layoutOf(p, s, clipId);
  const both = p.newsroom?.ratio === "both";
  const own = seqRatio(s.width, s.height);
  const [view, setView] = useState<GfxRatio>(own);
  const ratio = both ? view : own;
  const [sel, setSel] = useState(0);
  const [over, setOver] = useState<number | null>(null);
  const boxes = useMemo(() => (lo ? boxesOfClip(p, s, clipId, ratio) : []), [p, s, clipId, ratio, lo]);
  const under = useMemo(() => (lo ? clipsUnder(p, s, clipId) : []), [p, s, clipId, lo]);
  if (!lo) return <p className="px-3 py-2 text-2xs text-dim">This graphic has no video boxes.</p>;
  const inBox = (i: number) => clipInBox(p, s, clipId, i);
  const trackName = (c: TimelineClip) => s.tracks.find((t) => t.id === c.trackId)?.name ?? "";
  const media = p.media.filter((m) => (m.kind === "video" || m.kind === "image") && !m.missing);
  const thumbOf = (c: TimelineClip | null) => (c?.source.type === "media" ? p.media.find((m) => m.id === (c.source as { mediaId: string }).mediaId)?.thumb : undefined);
  const drop = (e: React.DragEvent, index: number) => {
    const d = currentDrag(e);
    setOver(null);
    if (d?.kind !== "media" || !d.items[0]) return;
    e.preventDefault();
    setSel(index);
    mediaInBox(s.id, d.items[0].mediaId, clipId, index);
  };
  const pick = (index: number, v: string) => {
    if (!v) { const c = inBox(index); if (c) takeOutOfBox(s.id, [c.id]); return; }
    if (v.startsWith("clip:")) putInBox(s.id, clipId, [v.slice(5)], index);
    else if (v.startsWith("media:")) mediaInBox(s.id, v.slice(6), clipId, index);
  };
  const cur = boxes.find((b) => b.index === sel) ?? boxes[0];
  const curClip = cur ? inBox(cur.index) : null;
  const slot = curClip?.slot;
  return (
    <div className="space-y-2 py-1">
      <div className="flex items-center gap-2 px-3">
        <LayoutGrid className="size-3.5 text-dim" />
        <span className="flex-1 text-2xs font-semibold uppercase tracking-wide text-dim">Boxes</span>
        {both && (
          <div className="ed-seg">
            {(["16:9", "9:16"] as GfxRatio[]).map((r) => <button key={r} type="button" aria-pressed={view === r} onClick={() => setView(r)}>{r}</button>)}
          </div>
        )}
      </div>
      {/* the layout as a small diagram: click a box to pick it, drop a clip from the bin on it */}
      <div className="flex justify-center px-3">
        <div className="relative w-full overflow-hidden rounded-md border border-line bg-raised"
          style={{ aspectRatio: String(ASPECT[ratio]), maxWidth: ratio === "9:16" ? 150 : 320 }}>
          {boxes.map((b) => {
            const c = inBox(b.index);
            const th = thumbOf(c);
            const on = cur?.index === b.index;
            return (
              <button key={b.index} type="button" title={`Box ${b.index + 1}: ${c ? c.name : "empty"}`}
                className={clsx("absolute grid place-items-center overflow-hidden rounded-[3px] border text-[10px] font-semibold transition-colors",
                  on ? "border-accent text-ink" : "border-line text-mute hover:border-mute",
                  over === b.index && "ring-2 ring-accent")}
                style={{ left: `${b.frac[0] * 100}%`, top: `${b.frac[1] * 100}%`, width: `${b.frac[2] * 100}%`, height: `${b.frac[3] * 100}%`,
                  background: th ? `center / cover no-repeat url("${th}")` : c ? "color-mix(in srgb, var(--color-accent) 22%, var(--color-panel))" : "color-mix(in srgb, var(--color-panel) 80%, transparent)" }}
                onClick={() => setSel(b.index)}
                onDragOver={(e) => { if (isEditorDrag(e) && currentDrag(e)?.kind === "media") { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (over !== b.index) setOver(b.index); } }}
                onDragLeave={() => setOver((o) => (o === b.index ? null : o))}
                onDrop={(e) => drop(e, b.index)}>
                <span className={clsx("rounded px-1", th ? "bg-black/60 text-white" : "")}>{b.index + 1}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="space-y-0.5">
        {boxes.map((b) => {
          const c = inBox(b.index);
          const on = cur?.index === b.index;
          return (
            <div key={b.index} className={clsx("flex min-h-7 items-center gap-2 px-3", on && "bg-hover/60")} onClick={() => setSel(b.index)}>
              <span className={clsx("grid size-5 shrink-0 place-items-center rounded text-[10px] font-semibold", c ? "bg-accent/20 text-accent-ink" : "border border-line text-dim")}>{b.index + 1}</span>
              <span className="w-24 shrink-0 truncate text-2xs text-mute" title={boxName(p, s, clipId, b.index, b.label)}>{boxName(p, s, clipId, b.index, b.label)}</span>
              <select className="ed-field min-w-0 flex-1" value={c ? `clip:${c.id}` : ""} onChange={(e) => pick(b.index, e.target.value)} onClick={(e) => e.stopPropagation()}>
                <option value="">Empty</option>
                {under.length > 0 && (
                  <optgroup label="On the timeline">
                    {under.map((x) => <option key={x.id} value={`clip:${x.id}`}>{x.name} · {trackName(x)}{x.slot && x.slot.index !== b.index ? ` (box ${x.slot.index + 1})` : ""}</option>)}
                  </optgroup>
                )}
                {media.length > 0 && (
                  <optgroup label="From the bin">
                    {media.map((m) => <option key={m.id} value={`media:${m.id}`}>{m.name}</option>)}
                  </optgroup>
                )}
              </select>
            </div>
          );
        })}
      </div>
      {cur && curClip && slot && (
        <div className="mx-3 space-y-1 rounded-md border border-line p-2">
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-2xs text-mute">Fit</span>
            <div className="ed-seg">
              <button type="button" aria-pressed={(slot.fit ?? "cover") === "cover"} onClick={() => frameInBox(s.id, curClip.id, { fit: "cover" }, "fit")}>Fill the box</button>
              <button type="button" aria-pressed={slot.fit === "contain"} onClick={() => frameInBox(s.id, curClip.id, { fit: "contain" }, "fit")}>Whole picture</button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-2xs text-mute">Zoom</span>
            <ScrubNumber value={Math.round((slot.zoom ?? 1) * 100)} min={100} max={400} step={1} unit="%" onChange={(v) => frameInBox(s.id, curClip.id, { zoom: v / 100 }, "zoom")} />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-2xs text-mute">Aim</span>
            <span className="text-2xs text-dim">across</span>
            <ScrubNumber value={Math.round((slot.offset?.[0] ?? 0) * 100)} min={-50} max={50} step={1} unit="%" onChange={(v) => frameInBox(s.id, curClip.id, { offset: [v / 100, slot.offset?.[1] ?? 0] }, "ox")} />
            <span className="text-2xs text-dim">down</span>
            <ScrubNumber value={Math.round((slot.offset?.[1] ?? 0) * 100)} min={-50} max={50} step={1} unit="%" onChange={(v) => frameInBox(s.id, curClip.id, { offset: [slot.offset?.[0] ?? 0, v / 100] }, "oy")} />
            <button type="button" className="ed-ibtn ml-auto" title="Centre and fill" onClick={() => frameInBox(s.id, curClip.id, { zoom: 1, offset: [0, 0] }, "reset")}><Crosshair className="size-3.5" /></button>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <span className="min-w-0 flex-1 truncate text-2xs text-dim">{curClip.name} · {trackName(curClip)}{clipEnd(curClip) < clipEnd(lo.clip) || curClip.start > lo.clip.start ? " · covers part of the layout" : ""}</span>
            <button type="button" className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-2xs text-mute hover:bg-hover hover:text-ink" onClick={() => takeOutOfBox(s.id, [curClip.id])}>
              <X className="size-3" /> Take out
            </button>
          </div>
        </div>
      )}
      {cur && !curClip && (
        <p className="px-3 text-2xs text-dim">Pick a clip for box {cur.index + 1}, or drag one from the bin onto the box above.</p>
      )}
    </div>
  );
}

export default SlotAssigner;
